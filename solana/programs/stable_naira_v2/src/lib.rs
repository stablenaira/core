//! StableNaira on Solana — v2 (classic SPL Token).
//!
//! USDC-style architecture. Replaces the Token-2022 + PermanentDelegate
//! `stable_naira` controller. The new mint is plain classic SPL Token, so it
//! lists permissionlessly on every Solana DEX (Raydium CPMM/CLMM, Orca,
//! Meteora, Jupiter routes) — see [[13 Todos & Roadmap/Solana SPL Migration]].
//!
//! Compliance posture vs the Token-2022 predecessor:
//!
//! | EVM `StableNaira.sol`     | v2 on Solana (this program)           | Same as v1? |
//! | ------------------------- | ------------------------------------- | ----------- |
//! | `mint` (mintCap, role)    | `mint_to` — cap + MINTER role        | ✅ preserved |
//! | `burn` (self)             | direct SPL `Burn` instruction         | ✅ (no controller needed) |
//! | `burnFrom` (MINTER role)  | SPL `BurnChecked` via allowance       | ⚠️ requires `approve` first (USDC posture) |
//! | `freezeAddress` (FREEZER) | `freeze` — CPI to SPL FreezeAccount   | ✅ preserved |
//! | `unfreezeAddress`         | `thaw` — CPI to SPL ThawAccount       | ✅ preserved |
//! | `pause`/`unpause`         | **dropped** — use targeted freeze in incidents (USDC posture) | ❌ |
//! | `seizeFunds`              | **dropped** — court orders via legal process (USDC posture)   | ❌ |
//!
//! The two dropped capabilities are the irreducible cost of switching to
//! classic SPL. Both are preserved on the EVM contracts; the team has
//! accepted Solana-side divergence (matching USDC's posture on Solana).
//!
//! Role model mirrors EVM's AccessControlEnumerable: each (role, account)
//! grant is its own PDA at `["role", role_id, account]`. An implicit
//! `admin` lives in `Config.admin` and can grant/revoke any role. The
//! admin is meant to be a Squads multisig in production.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::metadata::{mpl_token_metadata, Metadata};
use anchor_spl::token::spl_token;
use anchor_spl::token::spl_token::instruction as tix;
use anchor_spl::token::{Mint, Token, TokenAccount};
use mpl_token_metadata::instructions::{CreateV1Cpi, CreateV1CpiAccounts, CreateV1InstructionArgs};
use mpl_token_metadata::types::TokenStandard;

/// SPL Instructions sysvar address — required by Metaplex `CreateV1` for
/// reentrancy / introspection. Hard-coded because anchor-lang's path for
/// the sysvar moves between versions and would otherwise drift.
const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

// Mainnet program ID, deployed 2026-05-27 from `CSwhhH…`.
// Keypair file: `target/deploy/stable_naira_v2-keypair.json` (gitignored).
declare_id!("3LvP2DLRMJbgbzhaa7rGVqDM7Y9wJgHsvsEkWXCzMUHy");

pub const ROLE_MINTER: u8 = 0;
pub const ROLE_FREEZER: u8 = 1;

const DECIMALS: u8 = 2;
const CONFIG_SEED: &[u8] = b"config";
const ROLE_SEED: &[u8] = b"role";

#[program]
pub mod stable_naira_v2 {
    use super::*;

    /// One-shot init. Creates the classic SPL mint with controller-PDA as
    /// both `mintAuthority` and `freezeAuthority`. Records the canonical
    /// mint address in Config.
    ///
    /// Decimals are pinned at 2 (matches every other chain's SNR — see
    /// `06 Token Economics & Reserves/Decimals and Units` in the wiki).
    pub fn initialize(ctx: Context<Initialize>, mint_cap: u64) -> Result<()> {
        let cfg_key = ctx.accounts.config.key();
        let tp = ctx.accounts.token_program.key();
        let mint_ai = ctx.accounts.mint.to_account_info();

        // Classic SPL mint = 82 bytes (no extensions). Pinned constant.
        let space: usize = spl_token::state::Mint::LEN;
        let lamports = Rent::get()?.minimum_balance(space);

        invoke(
            &system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &mint_ai.key(),
                lamports,
                space as u64,
                &tp,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                mint_ai.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // InitializeMint2: skips the rent sysvar (modern Solana). Sets both
        // mint authority and freeze authority to the controller PDA so the
        // controller has full mint + freeze powers — exactly how USDC's
        // master minter relationship works, just one program down.
        let ix = tix::initialize_mint2(
            &tp,
            &mint_ai.key(),
            &cfg_key,         // mint authority
            Some(&cfg_key),   // freeze authority
            DECIMALS,
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke(
            &ix,
            &[mint_ai.clone(), ctx.accounts.token_program.to_account_info()],
        )?;

        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.mint = mint_ai.key();
        c.mint_cap = mint_cap;
        c.total_minted = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    // ─── Admin operations ────────────────────────────────────────────────

    /// Transfer admin authority to a new pubkey. Intended for Squads
    /// multisig handover. After this call, only the new admin can call
    /// admin-only instructions.
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        require_keys_neq!(new_admin, Pubkey::default(), SnErr::ZeroAddress);
        let old_admin = ctx.accounts.admin.key();
        ctx.accounts.config.admin = new_admin;
        emit!(AdminTransferred { old_admin, new_admin });
        Ok(())
    }

    /// Adjust supply cap. `cap = 0` means uncapped (matches EVM `mintCap`).
    pub fn set_mint_cap(ctx: Context<AdminOnly>, cap: u64) -> Result<()> {
        require!(
            cap == 0 || cap >= ctx.accounts.config.total_minted,
            SnErr::MintCapBelowSupply
        );
        ctx.accounts.config.mint_cap = cap;
        emit!(MintCapSet { cap });
        Ok(())
    }

    /// Grant a role (MINTER | FREEZER) to an account. Admin-only.
    /// Creates `["role", role_id, who]` PDA — its existence == the grant.
    pub fn grant_role(ctx: Context<GrantRole>, role: u8) -> Result<()> {
        require!(role <= ROLE_FREEZER, SnErr::UnknownRole);
        let grant = &mut ctx.accounts.grant;
        grant.role = role;
        grant.who = ctx.accounts.who.key();
        grant.bump = ctx.bumps.grant;
        emit!(RoleGranted { role, who: ctx.accounts.who.key() });
        Ok(())
    }

    /// Revoke a role. Admin-only. Closes the grant PDA, returns rent.
    pub fn revoke_role(_ctx: Context<RevokeRole>, role: u8) -> Result<()> {
        // `close = admin` handles rent return; we just need to fire the event.
        emit!(RoleRevoked { role });
        Ok(())
    }

    // ─── Mint operations (MINTER role) ──────────────────────────────────

    /// Mint SNR to a destination token account. Requires:
    ///   - signer holds MINTER role grant (proven by grant PDA presence)
    ///   - destination is a valid SPL token account for our mint
    ///   - total_minted + amount <= mint_cap (when cap != 0)
    pub fn mint_to(ctx: Context<MintToCtx>, amount: u64) -> Result<()> {
        require!(amount > 0, SnErr::ZeroAmount);

        // Grab everything we need from `config` *before* taking a mutable
        // borrow — the SPL instruction builder + `invoke_signed` both need
        // the config's key/account_info immutably while we update total_minted.
        let cfg_key = ctx.accounts.config.key();
        let cfg_bump = ctx.accounts.config.bump;
        let cfg_ai = ctx.accounts.config.to_account_info();
        let cap = ctx.accounts.config.mint_cap;
        let prev_total = ctx.accounts.config.total_minted;
        let new_total = prev_total.checked_add(amount).ok_or(SnErr::Overflow)?;
        if cap != 0 {
            require!(new_total <= cap, SnErr::MintCapExceeded);
        }

        let tp = ctx.accounts.token_program.key();
        let ix = tix::mint_to(
            &tp,
            &ctx.accounts.mint.key(),
            &ctx.accounts.destination.key(),
            &cfg_key,
            &[],
            amount,
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke_signed(
            &ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                cfg_ai,
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[CONFIG_SEED, &[cfg_bump]]],
        )?;

        // Now we can take the mutable borrow safely (CPI is done).
        ctx.accounts.config.total_minted = new_total;
        emit!(Minted {
            to: ctx.accounts.destination.key(),
            amount,
            total_minted: new_total,
        });
        Ok(())
    }

    // ─── Freeze operations (FREEZER role) ──────────────────────────────

    /// Freeze a token account. Requires FREEZER role.
    /// Once frozen, the account cannot send OR receive SNR until thawed.
    pub fn freeze(ctx: Context<FreezeCtx>) -> Result<()> {
        let tp = ctx.accounts.token_program.key();
        let cfg = &ctx.accounts.config;
        let ix = tix::freeze_account(
            &tp,
            &ctx.accounts.target.key(),
            &ctx.accounts.mint.key(),
            &cfg.key(),
            &[],
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke_signed(
            &ix,
            &[
                ctx.accounts.target.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                cfg.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[CONFIG_SEED, &[cfg.bump]]],
        )?;
        emit!(AccountFrozen { account: ctx.accounts.target.key() });
        Ok(())
    }

    /// Create a Metaplex Token Metadata account for the SPL mint so wallets
    /// and explorers display "StableNaira / SNR / logo" instead of "Unknown
    /// Token". Uses Metaplex `CreateV1` with `TokenStandard::Fungible`. The
    /// mint authority (this controller's `config` PDA) signs via
    /// `invoke_signed`. `update_authority` is the same PDA so future edits
    /// can be made via the controller (or whatever admin holds the program
    /// upgrade authority, ultimately the Squads multisig).
    ///
    /// Admin-only. **NOT idempotent** at the Metaplex layer — re-calling on
    /// an existing metadata account will revert. Use a dedicated
    /// `update_metadata` instruction for changes (out of scope for v2.0).
    pub fn create_metadata(
        ctx: Context<CreateTokenMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let args = CreateV1InstructionArgs {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            primary_sale_happened: false,
            is_mutable: true,
            token_standard: TokenStandard::Fungible,
            collection: None,
            uses: None,
            collection_details: None,
            rule_set: None,
            decimals: Some(DECIMALS),
            print_supply: None,
        };

        let metadata_program_ai = ctx.accounts.metadata_program.to_account_info();
        let mint_ai = ctx.accounts.mint.to_account_info();
        let config_ai = ctx.accounts.config.to_account_info();
        let payer_ai = ctx.accounts.payer.to_account_info();
        let metadata_ai = ctx.accounts.metadata.to_account_info();
        let system_ai = ctx.accounts.system_program.to_account_info();
        let sysvar_ix_ai = ctx.accounts.sysvar_instructions.to_account_info();
        let token_program_ai = ctx.accounts.token_program.to_account_info();

        let cpi = CreateV1Cpi::new(
            &metadata_program_ai,
            CreateV1CpiAccounts {
                metadata: &metadata_ai,
                master_edition: None,
                mint: (&mint_ai, false /* not a signer; mint already exists */),
                authority: &config_ai,
                payer: &payer_ai,
                // update_authority signs via invoke_signed using config PDA seeds
                update_authority: (&config_ai, true),
                system_program: &system_ai,
                sysvar_instructions: &sysvar_ix_ai,
                spl_token_program: Some(&token_program_ai),
            },
            args,
        );
        let bump = ctx.accounts.config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        cpi.invoke_signed(signer_seeds)?;
        Ok(())
    }

    /// Thaw (unfreeze) a token account. Requires FREEZER role.
    pub fn thaw(ctx: Context<FreezeCtx>) -> Result<()> {
        let tp = ctx.accounts.token_program.key();
        let cfg = &ctx.accounts.config;
        let ix = tix::thaw_account(
            &tp,
            &ctx.accounts.target.key(),
            &ctx.accounts.mint.key(),
            &cfg.key(),
            &[],
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke_signed(
            &ix,
            &[
                ctx.accounts.target.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                cfg.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[CONFIG_SEED, &[cfg.bump]]],
        )?;
        emit!(AccountThawed { account: ctx.accounts.target.key() });
        Ok(())
    }
}

// ─── State ────────────────────────────────────────────────────────────

#[account]
pub struct Config {
    /// Admin pubkey. Holds grant_role/revoke_role/set_mint_cap/transfer_admin.
    /// Production: Squads multisig (3-of-5 minimum per Mainnet Hard Gates).
    pub admin: Pubkey,
    /// The classic SPL mint this controller owns. Set at `initialize` and
    /// never changed (changing it would orphan all grants + balances).
    pub mint: Pubkey,
    /// Supply cap. `0` == uncapped (matches EVM convention).
    pub mint_cap: u64,
    /// Running supply counter. Cap check uses this.
    pub total_minted: u64,
    pub bump: u8,
}
impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

/// Marker account proving (role, account) is granted. Existence == grant.
/// Closed on revoke (rent returned to admin).
#[account]
pub struct RoleGrant {
    pub role: u8,
    pub who: Pubkey,
    pub bump: u8,
}
impl RoleGrant {
    pub const LEN: usize = 8 + 1 + 32 + 1;
}

// ─── Account contexts ────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The admin to install. Sane default = the deployer; should be
    /// `transfer_admin`'d to a Squads multisig before mainnet supply is
    /// minted.
    /// CHECK: stored verbatim; admin acts via signer in subsequent calls.
    pub admin: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = Config::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: mint is created by this instruction via CPI to spl_token;
    /// must be a fresh Keypair-signed account (size 0, owner system).
    #[account(mut, signer)]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(role: u8)]
pub struct GrantRole<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: arbitrary pubkey to grant the role to.
    pub who: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = RoleGrant::LEN,
        seeds = [ROLE_SEED, &[role], who.key().as_ref()],
        bump
    )]
    pub grant: Account<'info, RoleGrant>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(role: u8)]
pub struct RevokeRole<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: pubkey whose grant is being revoked.
    pub who: UncheckedAccount<'info>,
    #[account(
        mut,
        close = admin,
        seeds = [ROLE_SEED, &[role], who.key().as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, RoleGrant>,
}

#[derive(Accounts)]
pub struct MintToCtx<'info> {
    pub minter: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// Proves `minter` holds MINTER role. PDA existence is the grant.
    #[account(
        seeds = [ROLE_SEED, &[ROLE_MINTER], minter.key().as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, RoleGrant>,
    #[account(mut, address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FreezeCtx<'info> {
    pub freezer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [ROLE_SEED, &[ROLE_FREEZER], freezer.key().as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, RoleGrant>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub target: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateTokenMetadata<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: validated to be the canonical Metaplex metadata PDA via seeds below.
    #[account(
        mut,
        seeds = [
            b"metadata",
            metadata_program.key().as_ref(),
            mint.key().as_ref(),
        ],
        bump,
        seeds::program = metadata_program.key(),
    )]
    pub metadata: UncheckedAccount<'info>,
    #[account(mut, address = config.mint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub metadata_program: Program<'info, Metadata>,
    /// CHECK: must be the Instructions sysvar (required by Metaplex CreateV1).
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub sysvar_instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ─── Events ──────────────────────────────────────────────────────────

#[event]
pub struct AdminTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct MintCapSet {
    pub cap: u64,
}

#[event]
pub struct RoleGranted {
    pub role: u8,
    pub who: Pubkey,
}

#[event]
pub struct RoleRevoked {
    pub role: u8,
}

#[event]
pub struct Minted {
    pub to: Pubkey,
    pub amount: u64,
    pub total_minted: u64,
}

#[event]
pub struct AccountFrozen {
    pub account: Pubkey,
}

#[event]
pub struct AccountThawed {
    pub account: Pubkey,
}

// ─── Errors ──────────────────────────────────────────────────────────

#[error_code]
pub enum SnErr {
    #[msg("Zero address provided")]
    ZeroAddress,
    #[msg("Zero amount provided")]
    ZeroAmount,
    #[msg("Mint cap below current supply")]
    MintCapBelowSupply,
    #[msg("Mint cap would be exceeded")]
    MintCapExceeded,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unknown role id")]
    UnknownRole,
    #[msg("SPL token instruction construction failed")]
    TokenIx,
}
