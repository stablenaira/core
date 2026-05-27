//! StableNaira CCTP — Phase 4: TokenMessenger (Solana).
//!
//! Burn-and-mint app, parity with EVM `TokenMessenger.sol` + `BurnMessage.sol`:
//!
//! - `deposit_for_burn`: guards (amount/mintRecipient/burnToken/router),
//!   `burn_from` the holder via the `stable_naira` controller (the
//!   TokenMessenger config PDA holds MINTER — EVM `burnFrom`, no allowance,
//!   HIGH-03), charge fee (dormant at `fee_bps == 0`), build the 132-byte
//!   `BurnMessage`, dispatch via `message_transmitter::send_message`.
//! - `handle_receive_message`: CPI `message_transmitter::receive_message`
//!   (attestation verify + replay mark), then remote-router/sender + body
//!   checks, then `mint_to` the recipient via `stable_naira`.
//!
//! DOCUMENTED SOLANA DIVERGENCE: EVM has the transmitter call the handler
//! (`IMessageHandler`). To avoid a program dependency cycle
//! (`message_transmitter` ↔ `token_messenger`), the receive flow is inverted:
//! the relayer calls `token_messenger`, which CPIs `message_transmitter`.
//! The security invariant is preserved — **a mint can only occur after a
//! successful `message_transmitter::receive_message` CPI** (which performs
//! the validator-quorum verify AND the replay mark) in the same instruction.
//! Analogous to (and cleaner than) the documented TON async divergence.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::spl_token::instruction as sp_ix;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use message_transmitter::cpi::accounts::ReceiveMessage as MtReceive;
use message_transmitter::cpi::accounts::SendMessage as MtSend;
use message_transmitter::program::MessageTransmitter;
use message_transmitter::MtConfig;
use stable_naira_v2::cpi::accounts::MintToCtx as SnV2MintToCtx;
use stable_naira_v2::program::StableNairaV2;
use stable_naira_v2::Config as SnV2Config;

declare_id!("AcKeZENGFRMxm3rtQg3chAiwf24d992Ljj574i937jjv");

const BODY_VERSION: u32 = 1;
const BURN_BODY_LEN: usize = 132;
const HEADER_LEN: usize = 116;
const MAX_FEE_BPS: u16 = 100;
const BPS_DENOMINATOR: u64 = 10_000;
const CONFIG_SEED: &[u8] = b"tm_config";
const ROUTER_SEED: &[u8] = b"remote_router";

#[program]
pub mod token_messenger {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        fee_recipient: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, TmErr::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.owner = ctx.accounts.owner.key();
        c.message_transmitter = ctx.accounts.message_transmitter_program.key();
        // Field is named `stable_naira` for historical reasons; in v2 it
        // points at the `stable_naira_v2` controller program ID. The bytes
        // are the same shape (a `Pubkey`).
        c.stable_naira = ctx.accounts.stable_naira_program.key();
        c.local_mint = ctx.accounts.mint.key();
        c.fee_bps = fee_bps;
        c.fee_recipient = fee_recipient;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// **Migration instruction.** One-shot used immediately after upgrading
    /// this program from v1 (Token-2022 + `stable_naira`) to v2 (classic SPL
    /// + `stable_naira_v2`). Repoints `TmConfig.stable_naira` at the new
    /// controller program ID and `TmConfig.local_mint` at the new classic
    /// SPL mint, atomically. Owner-only. After this call:
    ///   - all subsequent `handle_receive_message` calls mint via the new
    ///     controller into the new mint
    ///   - the old Token-2022 mint is never touched by the bridge again
    ///   - the old `stable_naira` controller program receives no further CPIs
    /// Idempotent — calling twice with the same values is a no-op.
    pub fn set_controller(
        ctx: Context<AdminOnly>,
        new_stable_naira_program: Pubkey,
        new_local_mint: Pubkey,
    ) -> Result<()> {
        require_keys_neq!(new_stable_naira_program, Pubkey::default(), TmErr::ZeroAddress);
        require_keys_neq!(new_local_mint, Pubkey::default(), TmErr::ZeroAddress);
        let c = &mut ctx.accounts.config;
        let old_controller = c.stable_naira;
        let old_mint = c.local_mint;
        c.stable_naira = new_stable_naira_program;
        c.local_mint = new_local_mint;
        emit!(ControllerMigrated {
            old_controller,
            new_controller: new_stable_naira_program,
            old_mint,
            new_mint: new_local_mint,
        });
        Ok(())
    }

    pub fn set_remote_router(
        ctx: Context<SetRemoteRouter>,
        domain: u32,
        router: [u8; 32],
    ) -> Result<()> {
        ctx.accounts.remote_router.domain = domain;
        ctx.accounts.remote_router.router = router;
        ctx.accounts.remote_router.bump = ctx.bumps.remote_router;
        Ok(())
    }

    pub fn set_fee_config(
        ctx: Context<AdminOnly>,
        fee_bps: u16,
        fee_recipient: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, TmErr::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.fee_bps = fee_bps;
        c.fee_recipient = fee_recipient;
        Ok(())
    }

    /// EVM `depositForBurn`. Synchronous on Solana (no async intent/callback
    /// as on TON): burn the holder, then dispatch the CCTP message.
    pub fn deposit_for_burn(
        ctx: Context<Deposit>,
        amount: u64,
        destination_domain: u32,
        mint_recipient: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, TmErr::ZeroAmount);
        require!(mint_recipient != [0u8; 32], TmErr::ZeroMintRecipient);
        let rr = &ctx.accounts.remote_router;
        require!(
            rr.domain == destination_domain && rr.router != [0u8; 32],
            TmErr::UnregisteredRemoteRouter
        );

        let cfg = &ctx.accounts.config;
        let bump = cfg.bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];

        // Burn directly from the depositor's token account via classic SPL
        // `Burn`. The depositor is a signer on this outer instruction, so
        // their signature propagates through the CPI to satisfy SPL's
        // authority check. **No `approve` / allowance step needed** — the
        // depositor's signature on `deposit_for_burn` IS the authorization,
        // just like USDC's depositForBurn pattern.
        //
        // (v1 used `stable_naira::cpi::burn_from` which relied on the
        // PermanentDelegate Token-2022 extension. v2 drops PermanentDelegate
        // so the bridge can't burn arbitrary holder balances — but it
        // doesn't need to, because depositForBurn is always called by the
        // holder themselves.)
        let tp = ctx.accounts.token_program.key();
        let burn_ix = sp_ix::burn(
            &tp,
            &ctx.accounts.depositor_token_account.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.depositor.key(),
            &[],
            amount,
        )
        .map_err(|_| error!(TmErr::TokenIx))?;
        invoke(
            &burn_ix,
            &[
                ctx.accounts.depositor_token_account.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;

        // Fee path is dormant at fee_bps == 0 (v1). Conservation holds.
        let amount_after_fee = charge_fee(cfg.fee_bps, amount)?;

        let burn_token = ctx.accounts.mint.key().to_bytes();
        let message_sender = ctx.accounts.depositor.key().to_bytes();
        let body = format_burn_message(
            BODY_VERSION,
            &burn_token,
            &mint_recipient,
            amount_after_fee,
            &message_sender,
        );

        message_transmitter::cpi::send_message(
            CpiContext::new_with_signer(
                ctx.accounts.message_transmitter_program.key(),
                MtSend {
                    sender: ctx.accounts.config.to_account_info(),
                    config: ctx.accounts.mt_config.to_account_info(),
                },
                signer,
            ),
            destination_domain,
            rr.router,
            [0u8; 32],
            body,
        )?;

        emit!(DepositForBurn {
            burn_token,
            amount,
            depositor: ctx.accounts.depositor.key(),
            mint_recipient,
            destination_domain,
        });
        Ok(())
    }

    /// EVM `handleReceiveMessage`. The mint is gated behind a successful
    /// `message_transmitter::receive_message` CPI (verify + replay mark);
    /// without it, no mint path exists.
    pub fn handle_receive_message(
        ctx: Context<HandleReceive>,
        source_domain: u32,
        nonce: u64,
        message: Vec<u8>,
        attestation: Vec<u8>,
    ) -> Result<()> {
        // 1. Transmitter verify (validator quorum) + replay mark. Any failure
        //    here reverts the whole tx, so the mint below cannot happen.
        message_transmitter::cpi::receive_message(
            CpiContext::new(
                ctx.accounts.message_transmitter_program.key(),
                MtReceive {
                    caller: ctx.accounts.relayer.to_account_info(),
                    payer: ctx.accounts.relayer.to_account_info(),
                    config: ctx.accounts.mt_config.to_account_info(),
                    used_nonce: ctx.accounts.used_nonce.to_account_info(),
                    registry: ctx.accounts.registry.to_account_info(),
                    registry_program: ctx.accounts.registry_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            source_domain,
            nonce,
            message.clone(),
            attestation,
        )?;

        // 2. The bytes are now validator-attested and replay-safe. Decode the
        //    envelope sender + the BurnMessage body.
        require!(message.len() >= HEADER_LEN + BURN_BODY_LEN, TmErr::BadBody);
        let env_sender: [u8; 32] = message[20..52].try_into().unwrap();
        let body = &message[HEADER_LEN..];
        require!(body.len() == BURN_BODY_LEN, TmErr::BadBody);

        // 3. Remote-router / sender authentication (EVM parity).
        let rr = &ctx.accounts.remote_router;
        require!(
            rr.domain == source_domain && rr.router != [0u8; 32],
            TmErr::UnregisteredRemoteRouter
        );
        require!(env_sender == rr.router, TmErr::InvalidRemoteSender);

        // 4. BurnMessage decode + version. The recipient token account the
        //    relayer passed MUST equal the body's mintRecipient (EVM parity:
        //    `mint(v.mintRecipient, v.amount)`) — the relayer cannot redirect.
        let version = u32::from_be_bytes(body[0..4].try_into().unwrap());
        require!(version == BODY_VERSION, TmErr::UnsupportedBodyVersion);
        let mint_recipient: [u8; 32] = body[36..68].try_into().unwrap();
        require!(
            ctx.accounts.recipient_token_account.key().to_bytes() == mint_recipient,
            TmErr::RecipientMismatch
        );
        let amount_be: [u8; 32] = body[68..100].try_into().unwrap();
        // amount is uint256 on the wire; StableNaira fits in u64.
        require!(amount_be[..24] == [0u8; 24], TmErr::AmountOverflow);
        let amount = u64::from_be_bytes(amount_be[24..32].try_into().unwrap());

        // 5. Mint to the recipient via the new `stable_naira_v2` controller.
        //    The TokenMessenger config PDA holds the MINTER role on v2 (the
        //    grant PDA at `["role", ROLE_MINTER, tm_config_pda]` proves it),
        //    so the CPI is authorized.
        //
        //    Note the account-name change vs v1: `authority` → `minter`,
        //    `role_pda` → `grant`, `to` → `destination`. Same shape, USDC
        //    posture: classic SPL mint, no PermanentDelegate plumbing.
        let bump = ctx.accounts.config.bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        stable_naira_v2::cpi::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.stable_naira_program.key(),
                SnV2MintToCtx {
                    minter: ctx.accounts.config.to_account_info(),
                    config: ctx.accounts.sn_config.to_account_info(),
                    grant: ctx.accounts.sn_minter_role.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    destination: ctx.accounts.recipient_token_account.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        emit!(MintAndWithdraw {
            recipient: ctx.accounts.recipient_token_account.key(),
            amount,
        });
        Ok(())
    }

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = false;
        Ok(())
    }
}

/* ------------------------------- helpers -------------------------------- */

fn charge_fee(fee_bps: u16, amount: u64) -> Result<u64> {
    if fee_bps == 0 {
        return Ok(amount);
    }
    let fee = (amount as u128 * fee_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    Ok(amount.checked_sub(fee).ok_or(TmErr::AmountOverflow)?)
}

fn format_burn_message(
    version: u32,
    burn_token: &[u8; 32],
    mint_recipient: &[u8; 32],
    amount: u64,
    message_sender: &[u8; 32],
) -> Vec<u8> {
    let mut o = Vec::with_capacity(BURN_BODY_LEN);
    o.extend_from_slice(&version.to_be_bytes());
    o.extend_from_slice(burn_token);
    o.extend_from_slice(mint_recipient);
    let mut amt = [0u8; 32];
    amt[24..32].copy_from_slice(&amount.to_be_bytes());
    o.extend_from_slice(&amt);
    o.extend_from_slice(message_sender);
    o
}

/* ------------------------------- state ---------------------------------- */

#[account]
pub struct TmConfig {
    pub owner: Pubkey,
    pub message_transmitter: Pubkey,
    pub stable_naira: Pubkey,
    pub local_mint: Pubkey,
    pub fee_bps: u16,
    pub fee_recipient: Pubkey,
    pub paused: bool,
    pub bump: u8,
}
impl TmConfig {
    pub const SIZE: usize = 8 + 32 * 4 + 2 + 32 + 1 + 1;
}

#[account]
pub struct RemoteRouter {
    pub domain: u32,
    pub router: [u8; 32],
    pub bump: u8,
}

/* ------------------------------ contexts -------------------------------- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = TmConfig::SIZE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, TmConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: stored as the message_transmitter program id.
    pub message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: stored as the stable_naira program id.
    pub stable_naira_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(domain: u32)]
pub struct SetRemoteRouter<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = owner)]
    pub config: Account<'info, TmConfig>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + 4 + 32 + 1,
        seeds = [ROUTER_SEED, &domain.to_le_bytes()],
        bump
    )]
    pub remote_router: Account<'info, RemoteRouter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = owner)]
    pub config: Account<'info, TmConfig>,
}

#[derive(Accounts)]
#[instruction(amount: u64, destination_domain: u32)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = !config.paused @ TmErr::Paused)]
    pub config: Account<'info, TmConfig>,
    #[account(
        seeds = [ROUTER_SEED, &destination_domain.to_le_bytes()],
        bump = remote_router.bump
    )]
    pub remote_router: Account<'info, RemoteRouter>,

    // stable_naira burn_from
    #[account(address = config.stable_naira)]
    pub stable_naira_program: Program<'info, StableNairaV2>,
    /// CHECK: stable_naira MINTER role PDA for the TokenMessenger config PDA;
    /// validated inside stable_naira.
    pub sn_minter_role: UncheckedAccount<'info>,
    pub sn_config: Account<'info, SnV2Config>,
    #[account(mut, address = config.local_mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub depositor_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,

    // message_transmitter send_message
    #[account(address = config.message_transmitter)]
    pub message_transmitter_program: Program<'info, MessageTransmitter>,
    #[account(mut)]
    pub mt_config: Account<'info, MtConfig>,
}

#[derive(Accounts)]
#[instruction(source_domain: u32, nonce: u64)]
pub struct HandleReceive<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = !config.paused @ TmErr::Paused)]
    pub config: Account<'info, TmConfig>,
    #[account(
        seeds = [ROUTER_SEED, &source_domain.to_le_bytes()],
        bump = remote_router.bump
    )]
    pub remote_router: Account<'info, RemoteRouter>,

    // message_transmitter receive_message (verify + replay)
    #[account(address = config.message_transmitter)]
    pub message_transmitter_program: Program<'info, MessageTransmitter>,
    #[account(mut)]
    pub mt_config: Account<'info, MtConfig>,
    /// CHECK: UsedNonce PDA, created by message_transmitter via the CPI.
    #[account(mut)]
    pub used_nonce: UncheckedAccount<'info>,
    /// CHECK: validator_registry Registry PDA, validated by the nested CPI.
    #[account(mut)]
    pub registry: UncheckedAccount<'info>,
    /// CHECK: validator_registry program; checked by message_transmitter.
    pub registry_program: UncheckedAccount<'info>,

    // stable_naira mint_to
    #[account(address = config.stable_naira)]
    pub stable_naira_program: Program<'info, StableNairaV2>,
    /// CHECK: stable_naira MINTER role PDA for the TokenMessenger config PDA.
    pub sn_minter_role: UncheckedAccount<'info>,
    pub sn_config: Account<'info, SnV2Config>,
    #[account(mut, address = config.local_mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

/* ------------------------------- events --------------------------------- */

#[event]
pub struct DepositForBurn {
    pub burn_token: [u8; 32],
    pub amount: u64,
    pub depositor: Pubkey,
    pub mint_recipient: [u8; 32],
    pub destination_domain: u32,
}

#[event]
pub struct MintAndWithdraw {
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ControllerMigrated {
    pub old_controller: Pubkey,
    pub new_controller: Pubkey,
    pub old_mint: Pubkey,
    pub new_mint: Pubkey,
}

/* ------------------------------- errors --------------------------------- */

#[error_code]
pub enum TmErr {
    #[msg("paused")]
    Paused,
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("zero mint recipient")]
    ZeroMintRecipient,
    #[msg("unregistered remote router")]
    UnregisteredRemoteRouter,
    #[msg("invalid remote sender")]
    InvalidRemoteSender,
    #[msg("bad burn message body")]
    BadBody,
    #[msg("unsupported body version")]
    UnsupportedBodyVersion,
    #[msg("amount exceeds u64")]
    AmountOverflow,
    #[msg("fee bps too high")]
    FeeTooHigh,
    #[msg("recipient token account != BurnMessage mintRecipient")]
    RecipientMismatch,
    #[msg("zero address")]
    ZeroAddress,
    #[msg("SPL token instruction construction failed")]
    TokenIx,
}
