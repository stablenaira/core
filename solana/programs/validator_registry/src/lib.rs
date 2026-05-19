//! StableNaira CCTP — Phase 2: ValidatorRegistry + multisig verifier (Solana).
//!
//! Byte-for-byte parity with the EVM `ValidatorRegistry.sol` +
//! `MultisigVerifier.sol` (+ OpenZeppelin `ECDSA`):
//!
//! - validator set + `threshold`, invariant `1 <= t <= n` and `2t > n`.
//! - attestation = `threshold` × 65-byte `(r ‖ s ‖ v)` signatures.
//! - per signature: `v ∈ {27,28}`; EIP-2 low-s (`1 <= s <= n/2`); recover
//!   the EVM address (`keccak256(pubkey)[12..32]`), reject zero.
//! - signers must be **strictly ascending** by address (O(t) dup detection).
//! - every recovered signer must be in the validator set.
//!
//! secp256k1 recovery proven byte-identical to EVM `ecrecover` in Phase 0.
//! `secp256k1_recover` does NOT enforce low-s, so the explicit `s <= n/2`
//! check below is what makes accept/reject match OZ `ECDSA.tryRecover`.

use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv as keccak256;
use solana_secp256k1_recover::secp256k1_recover;

declare_id!("845CkeSs9ZsXGEgqw53zZ1hrWthj7iHFKUVsemsYWL4C");

/// OZ EIP-2 ceiling: floor(secp256k1n / 2), big-endian.
/// 57896044618658097711785492504343953926418782139537452191302581570759080747168
const SECP256K1_HALF_N: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
];

const MAX_VALIDATORS: usize = 32;
const REGISTRY_SEED: &[u8] = b"registry";
const PENDING_SEED: &[u8] = b"pending";
const SIG_LEN: usize = 65;
/// Default queue→commit delay (seconds). Mirrors the EVM ValidatorRegistry
/// 1-hour default; owner-raisable via `set_timelock`.
const DEFAULT_TIMELOCK: i64 = 3600;
const MIN_TIMELOCK: i64 = 1;
const KIND_ADD: u8 = 0;
const KIND_REMOVE: u8 = 1;
const KIND_REPLACE: u8 = 2;
const KIND_SET_THRESHOLD: u8 = 3;
type EvmAddr = [u8; 20];

#[program]
pub mod validator_registry {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        validators: Vec<EvmAddr>,
        threshold: u8,
    ) -> Result<()> {
        let mut set = validators;
        require!(!set.iter().any(|a| a == &[0u8; 20]), VrErr::ZeroValidator);
        set.sort_unstable();
        let before = set.len();
        set.dedup();
        require!(set.len() == before, VrErr::DuplicateValidator);
        require!(set.len() <= MAX_VALIDATORS, VrErr::TooManyValidators);
        validate_threshold(threshold as usize, set.len())?;

        let r = &mut ctx.accounts.registry;
        r.owner = ctx.accounts.owner.key();
        r.threshold = threshold;
        r.validators = set;
        r.timelock = DEFAULT_TIMELOCK;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Owner raises/lowers the queue→commit delay (floor `MIN_TIMELOCK`).
    pub fn set_timelock(ctx: Context<SetTimelock>, new_timelock: i64) -> Result<()> {
        require!(new_timelock >= MIN_TIMELOCK, VrErr::TimelockTooLow);
        ctx.accounts.registry.timelock = new_timelock;
        Ok(())
    }

    /// Phase 7 — timelocked validator-set rotation (mirrors EVM
    /// `ValidatorRegistry` queue/commit/cancel). Owner queues exactly one
    /// pending change; cheap precondition checks happen here, the threshold
    /// invariant is enforced at commit on the post-state (as on EVM).
    pub fn queue_change(
        ctx: Context<QueueChange>,
        kind: u8,
        target: EvmAddr,
        replacement: EvmAddr,
        new_threshold: u8,
    ) -> Result<()> {
        let r = &ctx.accounts.registry;
        match kind {
            KIND_ADD => {
                require!(target != [0u8; 20], VrErr::ZeroValidator);
                require!(r.validators.binary_search(&target).is_err(), VrErr::DuplicateValidator);
                require!(r.validators.len() < MAX_VALIDATORS, VrErr::TooManyValidators);
            }
            KIND_REMOVE => {
                require!(r.validators.binary_search(&target).is_ok(), VrErr::ValidatorNotFound);
            }
            KIND_REPLACE => {
                require!(replacement != [0u8; 20], VrErr::ZeroValidator);
                require!(r.validators.binary_search(&target).is_ok(), VrErr::ValidatorNotFound);
                require!(
                    r.validators.binary_search(&replacement).is_err(),
                    VrErr::DuplicateValidator
                );
            }
            KIND_SET_THRESHOLD => {}
            _ => return err!(VrErr::BadKind),
        }
        let p = &mut ctx.accounts.pending;
        p.kind = kind;
        p.target = target;
        p.replacement = replacement;
        p.new_threshold = new_threshold;
        p.eta = Clock::get()?.unix_timestamp + r.timelock;
        p.bump = ctx.bumps.pending;
        Ok(())
    }

    /// Permissionless once `eta` has elapsed (anyone can commit, exactly like
    /// EVM `commitValidatorChange`). Rent refunds to the owner.
    pub fn commit_change(ctx: Context<CommitChange>) -> Result<()> {
        let p = &ctx.accounts.pending;
        require!(
            Clock::get()?.unix_timestamp >= p.eta,
            VrErr::TimelockNotElapsed
        );
        let (kind, target, replacement, new_threshold) =
            (p.kind, p.target, p.replacement, p.new_threshold);
        let r = &mut ctx.accounts.registry;
        match kind {
            KIND_ADD => match r.validators.binary_search(&target) {
                Ok(_) => return err!(VrErr::DuplicateValidator),
                Err(pos) => {
                    require!(r.validators.len() < MAX_VALIDATORS, VrErr::TooManyValidators);
                    r.validators.insert(pos, target);
                }
            },
            KIND_REMOVE => {
                let pos = r
                    .validators
                    .binary_search(&target)
                    .map_err(|_| error!(VrErr::ValidatorNotFound))?;
                r.validators.remove(pos);
                // EVM re-validates the threshold against the new count.
                validate_threshold(r.threshold as usize, r.validators.len())?;
            }
            KIND_REPLACE => {
                let pos = r
                    .validators
                    .binary_search(&target)
                    .map_err(|_| error!(VrErr::ValidatorNotFound))?;
                require!(
                    r.validators.binary_search(&replacement).is_err(),
                    VrErr::DuplicateValidator
                );
                r.validators.remove(pos);
                let ins = r.validators.binary_search(&replacement).unwrap_err();
                r.validators.insert(ins, replacement);
            }
            KIND_SET_THRESHOLD => {
                validate_threshold(new_threshold as usize, r.validators.len())?;
                r.threshold = new_threshold;
            }
            _ => return err!(VrErr::BadKind),
        }
        Ok(())
    }

    /// Owner cancels the pending change (rent refunds to the owner).
    pub fn cancel_change(_ctx: Context<CancelChange>) -> Result<()> {
        Ok(())
    }

    /// EVM `MultisigVerifier.verify`. Errors on any invalid attestation;
    /// `Ok(())` iff a strictly-ascending `threshold`-quorum of validators
    /// signed `digest`.
    pub fn verify(ctx: Context<Verify>, digest: [u8; 32], attestation: Vec<u8>) -> Result<()> {
        let r = &ctx.accounts.registry;
        let t = r.threshold as usize;
        require!(t >= 1, VrErr::ThresholdUnset);
        require!(attestation.len() == t * SIG_LEN, VrErr::BadAttestationLength);

        let mut prev: EvmAddr = [0u8; 20];
        for i in 0..t {
            let o = i * SIG_LEN;
            let r_bytes: [u8; 32] = attestation[o..o + 32].try_into().unwrap();
            let s_bytes: [u8; 32] = attestation[o + 32..o + 64].try_into().unwrap();
            let v = attestation[o + 64];

            let signer = recover_signer(&digest, v, &r_bytes, &s_bytes)?;
            require!(signer > prev, VrErr::SignersNotAscending);
            require!(r.is_validator(&signer), VrErr::SignerNotValidator);
            prev = signer;
        }
        Ok(())
    }
}

/* ------------------------------- crypto --------------------------------- */

fn recover_signer(digest: &[u8; 32], v: u8, r: &[u8; 32], s: &[u8; 32]) -> Result<EvmAddr> {
    // OZ ECDSA: v must be 27/28; EIP-2 low-s: 1 <= s <= n/2.
    require!(v == 27 || v == 28, VrErr::RecoveryFailed);
    require!(*s != [0u8; 32] && *s <= SECP256K1_HALF_N, VrErr::BadS);

    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(r);
    sig[32..].copy_from_slice(s);
    let pk = secp256k1_recover(digest, v - 27, &sig)
        .map_err(|_| error!(VrErr::RecoveryFailed))?;
    let h = keccak256(&[&pk.0]);
    let mut addr: EvmAddr = [0u8; 20];
    addr.copy_from_slice(&h.to_bytes()[12..32]);
    require!(addr != [0u8; 20], VrErr::RecoveryFailed);
    Ok(addr)
}

fn validate_threshold(t: usize, n: usize) -> Result<()> {
    // EVM: t != 0 && t <= n && 2t > n.
    require!(t != 0 && t <= n && 2 * t > n, VrErr::InvalidThreshold);
    Ok(())
}

/* ------------------------------- state ---------------------------------- */

#[account]
pub struct Registry {
    pub owner: Pubkey,
    pub threshold: u8,
    pub validators: Vec<EvmAddr>, // kept sorted ascending
    pub timelock: i64,            // queue→commit delay (seconds)
    pub bump: u8,
}
impl Registry {
    pub const SIZE: usize = 8 + 32 + 1 + (4 + 20 * MAX_VALIDATORS) + 8 + 1;
    fn is_validator(&self, a: &EvmAddr) -> bool {
        self.validators.binary_search(a).is_ok()
    }
}

/// Exactly one in-flight queued rotation (single-slot keeps the audit
/// surface minimal — re-queue after commit/cancel for the next change).
#[account]
pub struct Pending {
    pub kind: u8,
    pub target: EvmAddr,
    pub replacement: EvmAddr,
    pub new_threshold: u8,
    pub eta: i64,
    pub bump: u8,
}
impl Pending {
    pub const SIZE: usize = 8 + 1 + 20 + 20 + 1 + 8 + 1;
}

/* ------------------------------ contexts -------------------------------- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = Registry::SIZE,
        seeds = [REGISTRY_SEED],
        bump
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTimelock<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump, has_one = owner)]
    pub registry: Account<'info, Registry>,
}

#[derive(Accounts)]
pub struct QueueChange<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump, has_one = owner)]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = payer,
        space = Pending::SIZE,
        seeds = [PENDING_SEED],
        bump
    )]
    pub pending: Account<'info, Pending>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitChange<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        close = owner_refund,
        seeds = [PENDING_SEED],
        bump = pending.bump
    )]
    pub pending: Account<'info, Pending>,
    /// CHECK: rent refund target, pinned to the registry owner.
    #[account(mut, address = registry.owner)]
    pub owner_refund: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelChange<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump, has_one = owner)]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        close = owner,
        seeds = [PENDING_SEED],
        bump = pending.bump
    )]
    pub pending: Account<'info, Pending>,
}

#[derive(Accounts)]
pub struct Verify<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
}

/* ------------------------------- errors --------------------------------- */

#[error_code]
pub enum VrErr {
    #[msg("zero address validator")]
    ZeroValidator,
    #[msg("duplicate validator")]
    DuplicateValidator,
    #[msg("validator not found")]
    ValidatorNotFound,
    #[msg("too many validators")]
    TooManyValidators,
    #[msg("invalid threshold (need 1<=t<=n and 2t>n)")]
    InvalidThreshold,
    #[msg("threshold unset")]
    ThresholdUnset,
    #[msg("bad attestation length")]
    BadAttestationLength,
    #[msg("signature recovery failed")]
    RecoveryFailed,
    #[msg("malleable s (EIP-2 low-s violated)")]
    BadS,
    #[msg("signers not strictly ascending")]
    SignersNotAscending,
    #[msg("signer not in validator set")]
    SignerNotValidator,
    #[msg("timelock below floor")]
    TimelockTooLow,
    #[msg("timelock not elapsed")]
    TimelockNotElapsed,
    #[msg("unknown change kind")]
    BadKind,
}
