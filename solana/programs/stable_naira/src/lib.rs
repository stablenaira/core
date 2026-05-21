//! StableNaira on Solana — Phase 1.
//!
//! A controller program fronting a **Token-2022** mint. The controller PDA
//! (`["config"]`) is the mint authority, freeze authority, pause authority,
//! and permanent delegate. This reproduces the EVM `StableNaira.sol`
//! behaviour set:
//!
//! | EVM                         | Solana realization |
//! | --------------------------- | ------------------ |
//! | MINTER/PAUSER/FREEZER/SEIZER + single admin | `Config.admin` + per-grant `["role", id, who]` PDAs |
//! | `mint` (mintCap, whenNotPaused) | `mint_to` — cap check + Token-2022 Pausable blocks when paused |
//! | `burn` (self, whenNotPaused) | `burn` — holder-signed; Pausable enforced |
//! | `burnFrom` (MINTER, no allowance) | `burn_from` — permanent-delegate burn, no allowance |
//! | `redeemRequest` | `redeem_request` — self-burn + event |
//! | `freezeAddress`/`unfreezeAddress` | `freeze`/`thaw` token account |
//! | `pause`/`unpause` | Token-2022 Pausable `pause`/`resume` |
//! | `seizeFunds` (bypasses pause AND freeze) | `seize` — atomic unpause→thaw→clawback→refreeze→repause |
//!
//! Decimals = 2 (EVM `DECIMALS`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use spl_token_2022_interface::extension::pausable::instruction as pausable_ix;
use spl_token_2022_interface::extension::pausable::PausableConfig;
use spl_token_2022_interface::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_token_2022_interface::instruction as tix;
use spl_token_2022_interface::state::{AccountState, Mint as MintState};

declare_id!("7EXTBay4r4Ft3k5poXnhxMCQXe5s5yv2kfxMiA7babYD");

pub const ROLE_MINTER: u8 = 0;
pub const ROLE_PAUSER: u8 = 1;
pub const ROLE_FREEZER: u8 = 2;
pub const ROLE_SEIZER: u8 = 3;

const DECIMALS: u8 = 2;
const CONFIG_SEED: &[u8] = b"config";
const ROLE_SEED: &[u8] = b"role";

#[program]
pub mod stable_naira {
    use super::*;

    /// EVM `initialize` — creates the Token-2022 mint with PermanentDelegate +
    /// Pausable extensions and freeze authority, all bound to the config PDA.
    pub fn initialize(ctx: Context<Initialize>, mint_cap: u64) -> Result<()> {
        let cfg_key = ctx.accounts.config.key();
        let tp = ctx.accounts.token_program.key();
        let mint_ai = ctx.accounts.mint.to_account_info();

        let space = ExtensionType::try_calculate_account_len::<MintState>(&[
            ExtensionType::PermanentDelegate,
            ExtensionType::Pausable,
        ])
        .map_err(|_| error!(SnErr::ExtensionLen))?;
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

        // Extensions MUST be initialized before InitializeMint.
        invoke(
            &tix::initialize_permanent_delegate(&tp, &mint_ai.key(), &cfg_key)
                .map_err(|_| error!(SnErr::TokenIx))?,
            &[mint_ai.clone(), ctx.accounts.token_program.to_account_info()],
        )?;
        invoke(
            &pausable_ix::initialize(&tp, &mint_ai.key(), &cfg_key)
                .map_err(|_| error!(SnErr::TokenIx))?,
            &[mint_ai.clone(), ctx.accounts.token_program.to_account_info()],
        )?;
        invoke(
            &tix::initialize_mint2(&tp, &mint_ai.key(), &cfg_key, Some(&cfg_key), DECIMALS)
                .map_err(|_| error!(SnErr::TokenIx))?,
            &[mint_ai.clone(), ctx.accounts.token_program.to_account_info()],
        )?;

        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.mint = mint_ai.key();
        c.mint_cap = mint_cap;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_mint_cap(ctx: Context<AdminOnly>, new_cap: u64) -> Result<()> {
        ctx.accounts.config.mint_cap = new_cap;
        Ok(())
    }

    /// Admin grants a role by creating its marker PDA. `role`/`account` are
    /// consumed by the `#[instruction(..)]` PDA seeds, not the body.
    pub fn grant_role(ctx: Context<GrantRole>, role: u8, account: Pubkey) -> Result<()> {
        let _ = (role, account);
        ctx.accounts.role_account.bump = ctx.bumps.role_account;
        Ok(())
    }

    /// Admin revokes a role by closing its marker PDA (rent → admin).
    pub fn revoke_role(_ctx: Context<RevokeRole>, role: u8, account: Pubkey) -> Result<()> {
        let _ = (role, account);
        Ok(())
    }

    /// EVM `mint(to, amount)` — MINTER/admin, mintCap, blocked when paused.
    pub fn mint_to(ctx: Context<MintTo>, amount: u64) -> Result<()> {
        require!(amount > 0, SnErr::ZeroAmount);
        assert_role_or_admin(
            &ctx.accounts.config,
            ctx.accounts.authority.key(),
            &ctx.accounts.role_pda,
            ROLE_MINTER,
        )?;
        let cap = ctx.accounts.config.mint_cap;
        if cap != 0 {
            let supply = ctx.accounts.mint.supply;
            require!(
                supply.checked_add(amount).ok_or(SnErr::Overflow)? <= cap,
                SnErr::MintCapExceeded
            );
        }
        let tp = ctx.accounts.token_program.key();
        let ix = tix::mint_to(
            &tp,
            &ctx.accounts.mint.key(),
            &ctx.accounts.to.key(),
            &ctx.accounts.config.key(),
            &[],
            amount,
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke_signed(
            &ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.to.to_account_info(),
                ctx.accounts.config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]],
        )?;
        Ok(())
    }

    /// EVM `burn(amount)` — holder self-burn, blocked when paused.
    pub fn burn(ctx: Context<SelfBurn>, amount: u64) -> Result<()> {
        require!(amount > 0, SnErr::ZeroAmount);
        let tp = ctx.accounts.token_program.key();
        let ix = tix::burn(
            &tp,
            &ctx.accounts.from.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.owner.key(),
            &[],
            amount,
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke(
            &ix,
            &[
                ctx.accounts.from.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// EVM `burnFrom(account, amount)` — MINTER/admin, NO allowance
    /// (permanent-delegate burn). The bridge relies on this (HIGH-03).
    pub fn burn_from(ctx: Context<ForceBurn>, amount: u64) -> Result<()> {
        require!(amount > 0, SnErr::ZeroAmount);
        assert_role_or_admin(
            &ctx.accounts.config,
            ctx.accounts.authority.key(),
            &ctx.accounts.role_pda,
            ROLE_MINTER,
        )?;
        force_burn(
            &ctx.accounts.token_program,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.account.to_account_info(),
            &ctx.accounts.config,
            amount,
        )
    }

    /// EVM `redeemRequest` — self-burn + event.
    pub fn redeem_request(
        ctx: Context<SelfBurn>,
        amount: u64,
        reference: String,
    ) -> Result<()> {
        require!(amount > 0, SnErr::ZeroAmount);
        let tp = ctx.accounts.token_program.key();
        let ix = tix::burn(
            &tp,
            &ctx.accounts.from.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.owner.key(),
            &[],
            amount,
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke(
            &ix,
            &[
                ctx.accounts.from.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;
        emit!(RedeemRequested {
            account: ctx.accounts.owner.key(),
            amount,
            reference,
        });
        Ok(())
    }

    /// EVM `freezeAddress` — FREEZER/admin.
    pub fn freeze(ctx: Context<FreezeThaw>) -> Result<()> {
        assert_role_or_admin(
            &ctx.accounts.config,
            ctx.accounts.authority.key(),
            &ctx.accounts.role_pda,
            ROLE_FREEZER,
        )?;
        freeze_ta(
            &ctx.accounts.token_program,
            &ctx.accounts.target.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.config,
        )?;
        emit!(AccountFrozen { token_account: ctx.accounts.target.key() });
        Ok(())
    }

    /// EVM `unfreezeAddress` — FREEZER/admin.
    pub fn thaw(ctx: Context<FreezeThaw>) -> Result<()> {
        assert_role_or_admin(
            &ctx.accounts.config,
            ctx.accounts.authority.key(),
            &ctx.accounts.role_pda,
            ROLE_FREEZER,
        )?;
        thaw_ta(
            &ctx.accounts.token_program,
            &ctx.accounts.target.to_account_info(),
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.config,
        )?;
        emit!(AccountUnfrozen { token_account: ctx.accounts.target.key() });
        Ok(())
    }

    /// EVM `pause` — PAUSER/admin.
    pub fn pause(ctx: Context<PauseCtx>) -> Result<()> {
        assert_role_or_admin(
            &ctx.accounts.config,
            ctx.accounts.authority.key(),
            &ctx.accounts.role_pda,
            ROLE_PAUSER,
        )?;
        set_paused(
            &ctx.accounts.token_program,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.config,
            true,
        )
    }

    /// EVM `unpause` — admin only (DEFAULT_ADMIN_ROLE).
    pub fn unpause(ctx: Context<UnpauseCtx>) -> Result<()> {
        set_paused(
            &ctx.accounts.token_program,
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.config,
            false,
        )
    }

    /// EVM `seizeFunds(from, to, amount)` — SEIZER/admin. Force-moves funds
    /// even if `from`/`to` are frozen AND the mint is paused. Token-2022
    /// blocks clawback transfers under both, so we orchestrate atomically:
    /// unpause → thaw → permanent-delegate transfer → re-freeze → re-pause.
    /// Single instruction ⇒ externally identical to EVM `_forceTransfer`.
    pub fn seize(ctx: Context<Seize>, amount: u64) -> Result<()> {
        require!(amount > 0, SnErr::ZeroAmount);
        assert_role_or_admin(
            &ctx.accounts.config,
            ctx.accounts.authority.key(),
            &ctx.accounts.role_pda,
            ROLE_SEIZER,
        )?;

        let mint_ai = ctx.accounts.mint.to_account_info();
        let was_paused = {
            let data = mint_ai.try_borrow_data()?;
            let st = StateWithExtensions::<MintState>::unpack(&data)
                .map_err(|_| error!(SnErr::TokenIx))?;
            st.get_extension::<PausableConfig>()
                .map(|p| bool::from(p.paused))
                .unwrap_or(false)
        };
        let from_frozen = ctx.accounts.from.state == AccountState::Frozen;
        let to_frozen = ctx.accounts.to.state == AccountState::Frozen;

        if was_paused {
            set_paused(&ctx.accounts.token_program, &mint_ai, &ctx.accounts.config, false)?;
        }
        if from_frozen {
            thaw_ta(&ctx.accounts.token_program, &ctx.accounts.from.to_account_info(), &mint_ai, &ctx.accounts.config)?;
        }
        if to_frozen {
            thaw_ta(&ctx.accounts.token_program, &ctx.accounts.to.to_account_info(), &mint_ai, &ctx.accounts.config)?;
        }

        let tp = ctx.accounts.token_program.key();
        let ix = tix::transfer_checked(
            &tp,
            &ctx.accounts.from.key(),
            &mint_ai.key(),
            &ctx.accounts.to.key(),
            &ctx.accounts.config.key(),
            &[],
            amount,
            DECIMALS,
        )
        .map_err(|_| error!(SnErr::TokenIx))?;
        invoke_signed(
            &ix,
            &[
                ctx.accounts.from.to_account_info(),
                mint_ai.clone(),
                ctx.accounts.to.to_account_info(),
                ctx.accounts.config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]],
        )?;

        if from_frozen {
            freeze_ta(&ctx.accounts.token_program, &ctx.accounts.from.to_account_info(), &mint_ai, &ctx.accounts.config)?;
        }
        if to_frozen {
            freeze_ta(&ctx.accounts.token_program, &ctx.accounts.to.to_account_info(), &mint_ai, &ctx.accounts.config)?;
        }
        if was_paused {
            set_paused(&ctx.accounts.token_program, &mint_ai, &ctx.accounts.config, true)?;
        }

        emit!(FundsSeized {
            from: ctx.accounts.from.key(),
            to: ctx.accounts.to.key(),
            amount,
        });
        Ok(())
    }
}

/* ------------------------------- helpers -------------------------------- */

fn assert_role_or_admin(
    config: &Account<Config>,
    who: Pubkey,
    role_pda: &UncheckedAccount,
    role_id: u8,
) -> Result<()> {
    if who == config.admin {
        return Ok(());
    }
    let (expected, _b) = Pubkey::find_program_address(
        &[ROLE_SEED, &[role_id], who.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(role_pda.key(), expected, SnErr::Unauthorized);
    require!(role_pda.owner == &crate::ID, SnErr::Unauthorized);
    require!(!role_pda.data_is_empty(), SnErr::Unauthorized);
    Ok(())
}

fn force_burn<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    config: &Account<'info, Config>,
    amount: u64,
) -> Result<()> {
    let tp = token_program.key();
    let ix = tix::burn(&tp, &account.key(), &mint.key(), &config.key(), &[], amount)
        .map_err(|_| error!(SnErr::TokenIx))?;
    invoke_signed(
        &ix,
        &[
            account.clone(),
            mint.clone(),
            config.to_account_info(),
            token_program.to_account_info(),
        ],
        &[&[CONFIG_SEED, &[config.bump]]],
    )?;
    Ok(())
}

fn freeze_ta<'info>(
    token_program: &Interface<'info, TokenInterface>,
    target: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    config: &Account<'info, Config>,
) -> Result<()> {
    let tp = token_program.key();
    let ix = tix::freeze_account(&tp, &target.key(), &mint.key(), &config.key(), &[])
        .map_err(|_| error!(SnErr::TokenIx))?;
    invoke_signed(
        &ix,
        &[target.clone(), mint.clone(), config.to_account_info(), token_program.to_account_info()],
        &[&[CONFIG_SEED, &[config.bump]]],
    )?;
    Ok(())
}

fn thaw_ta<'info>(
    token_program: &Interface<'info, TokenInterface>,
    target: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    config: &Account<'info, Config>,
) -> Result<()> {
    let tp = token_program.key();
    let ix = tix::thaw_account(&tp, &target.key(), &mint.key(), &config.key(), &[])
        .map_err(|_| error!(SnErr::TokenIx))?;
    invoke_signed(
        &ix,
        &[target.clone(), mint.clone(), config.to_account_info(), token_program.to_account_info()],
        &[&[CONFIG_SEED, &[config.bump]]],
    )?;
    Ok(())
}

fn set_paused<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &AccountInfo<'info>,
    config: &Account<'info, Config>,
    paused: bool,
) -> Result<()> {
    let tp = token_program.key();
    let ix = if paused {
        pausable_ix::pause(&tp, &mint.key(), &config.key(), &[])
    } else {
        pausable_ix::resume(&tp, &mint.key(), &config.key(), &[])
    }
    .map_err(|_| error!(SnErr::TokenIx))?;
    invoke_signed(
        &ix,
        &[mint.clone(), config.to_account_info(), token_program.to_account_info()],
        &[&[CONFIG_SEED, &[config.bump]]],
    )?;
    Ok(())
}

/* ------------------------------- state ---------------------------------- */

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub mint_cap: u64, // 0 = unlimited
    pub bump: u8,
}
impl Config {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1;
}

#[account]
pub struct RoleAccount {
    pub bump: u8,
}

/* ------------------------------ contexts -------------------------------- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: recorded as the single admin (EVM DEFAULT_ADMIN_ROLE holder).
    pub admin: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = Config::SIZE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub mint: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(role: u8, account: Pubkey)]
pub struct GrantRole<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + 1,
        seeds = [ROLE_SEED, &[role], account.as_ref()],
        bump
    )]
    pub role_account: Account<'info, RoleAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(role: u8, account: Pubkey)]
pub struct RevokeRole<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = admin,
        seeds = [ROLE_SEED, &[role], account.as_ref()],
        bump = role_account.bump
    )]
    pub role_account: Account<'info, RoleAccount>,
}

#[derive(Accounts)]
pub struct MintTo<'info> {
    pub authority: Signer<'info>,
    /// CHECK: validated in `assert_role_or_admin` (PDA or admin).
    pub role_pda: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SelfBurn<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ForceBurn<'info> {
    pub authority: Signer<'info>,
    /// CHECK: validated in `assert_role_or_admin`.
    pub role_pda: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FreezeThaw<'info> {
    pub authority: Signer<'info>,
    /// CHECK: validated in `assert_role_or_admin`.
    pub role_pda: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub target: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct PauseCtx<'info> {
    pub authority: Signer<'info>,
    /// CHECK: validated in `assert_role_or_admin`.
    pub role_pda: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UnpauseCtx<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Seize<'info> {
    pub authority: Signer<'info>,
    /// CHECK: validated in `assert_role_or_admin`.
    pub role_pda: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/* ------------------------------- events --------------------------------- */

#[event]
pub struct RedeemRequested {
    pub account: Pubkey,
    pub amount: u64,
    pub reference: String,
}
#[event]
pub struct AccountFrozen {
    pub token_account: Pubkey,
}
#[event]
pub struct AccountUnfrozen {
    pub token_account: Pubkey,
}
#[event]
pub struct FundsSeized {
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

/* ------------------------------- errors --------------------------------- */

#[error_code]
pub enum SnErr {
    #[msg("not authorized for this role")]
    Unauthorized,
    #[msg("mint cap exceeded")]
    MintCapExceeded,
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("token-2022 instruction build failed")]
    TokenIx,
    #[msg("could not size mint extensions")]
    ExtensionLen,
}
