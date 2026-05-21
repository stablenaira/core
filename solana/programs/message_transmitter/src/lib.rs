//! StableNaira CCTP — Phase 3: MessageTransmitter (Solana).
//!
//! Generic cross-chain envelope, parity with EVM `MessageTransmitter.sol` +
//! `Message.sol`:
//!
//! - envelope layout (big-endian, 116-byte header + body) is frozen and
//!   byte-identical to EVM `Message`.
//! - `attestationDigest = keccak256(abi.encode(TYPEHASH,
//!   keccak256(envelope), chainId, transmitter))` — `chainId`/`transmitter`
//!   are per-deployment config (Solana has no native EVM chainId/address,
//!   same as TON); the digest *algorithm* is byte-identical so the shared
//!   off-chain attester signs the same value.
//! - `send_message`: whenNotPaused, dst != localDomain, body <= max,
//!   nonce = next_nonce++, emit the packed envelope.
//! - `receive_message`: verify attestation (CPI → `validator_registry`),
//!   version/destinationDomain/destinationCaller checks, replay mark BEFORE
//!   any handler (a per-`(sourceDomain,nonce)` `UsedNonce` PDA whose `init`
//!   fails on replay — mirrors the EVM `usedNonces` revert/rollback).
//!
//! The recipient-handler dispatch (`IMessageHandler`) is Phase 4
//! (`token_messenger`); Phase 3 emits `MessageReceived` after the replay mark.

use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv as keccak256;
use validator_registry::cpi::accounts::Verify as VrVerify;
use validator_registry::program::ValidatorRegistry;
use validator_registry::Registry;

declare_id!("6DV1hTBVf6Ks9mguQiVY82B5uGPQS2nHddzgL3GhFaWe");

const ENVELOPE_VERSION: u32 = 1;
const MIN_MAX_BODY_SIZE: u64 = 132;
const HEADER_LEN: usize = 116;
const CONFIG_SEED: &[u8] = b"mt_config";
const NONCE_SEED: &[u8] = b"used_nonce";
const TYPEHASH_STR: &[u8] =
    b"StableNairaCCTPAttestation(bytes32 envelopeHash,uint256 chainId,address transmitter)";

#[program]
pub mod message_transmitter {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        local_domain: u32,
        chain_id: [u8; 32],
        transmitter: [u8; 20],
        max_body_size: u64,
    ) -> Result<()> {
        require!(local_domain != 0, MtErr::ZeroLocalDomain);
        require!(max_body_size >= MIN_MAX_BODY_SIZE, MtErr::MaxBodyTooSmall);
        let c = &mut ctx.accounts.config;
        c.owner = ctx.accounts.owner.key();
        c.local_domain = local_domain;
        c.chain_id = chain_id;
        c.transmitter = transmitter;
        c.max_body_size = max_body_size;
        c.next_nonce = 0;
        c.paused = false;
        c.registry_program = ctx.accounts.registry_program.key();
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// EVM `sendMessage` / `sendMessageWithCaller`.
    pub fn send_message(
        ctx: Context<SendMessage>,
        destination_domain: u32,
        recipient: [u8; 32],
        destination_caller: [u8; 32],
        message_body: Vec<u8>,
    ) -> Result<u64> {
        let c = &mut ctx.accounts.config;
        require!(!c.paused, MtErr::Paused);
        require!(
            destination_domain != c.local_domain,
            MtErr::LocalDestinationNotAllowed
        );
        require!(
            message_body.len() as u64 <= c.max_body_size,
            MtErr::MessageBodyTooLarge
        );

        let nonce = c.next_nonce;
        c.next_nonce = c.next_nonce.checked_add(1).ok_or(MtErr::Overflow)?;

        let sender = ctx.accounts.sender.key().to_bytes();
        let encoded = format_envelope(
            ENVELOPE_VERSION,
            c.local_domain,
            destination_domain,
            nonce,
            &sender,
            &recipient,
            &destination_caller,
            &message_body,
        );
        emit!(MessageSent { message: encoded });
        Ok(nonce)
    }

    /// EVM `receiveMessage`. `source_domain`/`nonce` are passed explicitly so
    /// the `UsedNonce` replay PDA can be seeded by Anchor; both are checked
    /// against the decoded envelope so they cannot diverge from `message`.
    pub fn receive_message(
        ctx: Context<ReceiveMessage>,
        source_domain: u32,
        nonce: u64,
        message: Vec<u8>,
        attestation: Vec<u8>,
    ) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, MtErr::Paused);
        require!(message.len() >= HEADER_LEN, MtErr::MessageTooShort);

        // 1. Verify attestation FIRST (cheapest reject), over the
        //    domain-separated digest, via the Phase 2 verifier program.
        let digest = attestation_digest(&message, &c.chain_id, &c.transmitter);
        validator_registry::cpi::verify(
            CpiContext::new(
                ctx.accounts.registry_program.key(),
                VrVerify {
                    registry: ctx.accounts.registry.to_account_info(),
                },
            ),
            digest,
            attestation,
        )?;

        // 2. Decode + envelope sanity.
        let e = decode_envelope(&message);
        require!(e.version == ENVELOPE_VERSION, MtErr::InvalidVersion);
        require!(
            e.destination_domain == c.local_domain,
            MtErr::InvalidDestinationDomain
        );
        require!(
            e.source_domain == source_domain && e.nonce == nonce,
            MtErr::NonceArgMismatch
        );
        let caller32 = ctx.accounts.caller.key().to_bytes();
        require!(
            e.destination_caller == [0u8; 32] || e.destination_caller == caller32,
            MtErr::UnauthorizedCaller
        );

        // 3. Replay protection: the `used_nonce` PDA was `init`ed during
        //    account resolution (before this body). A replayed
        //    (sourceDomain, nonce) re-runs `init` on an existing account →
        //    the tx fails, exactly like the EVM `usedNonces` revert.
        ctx.accounts.used_nonce.used = true;

        // 4. Handler dispatch is Phase 4 (token_messenger).
        emit!(MessageReceived {
            source_domain: e.source_domain,
            nonce: e.nonce,
            sender: e.sender,
            body: message[HEADER_LEN..].to_vec(),
        });
        Ok(())
    }

    pub fn set_max_message_body_size(ctx: Context<AdminOnly>, new_max: u64) -> Result<()> {
        require!(new_max >= MIN_MAX_BODY_SIZE, MtErr::MaxBodyTooSmall);
        ctx.accounts.config.max_body_size = new_max;
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

/* ---------------------------- envelope codec ---------------------------- */

struct Envelope {
    version: u32,
    source_domain: u32,
    destination_domain: u32,
    nonce: u64,
    sender: [u8; 32],
    #[allow(dead_code)]
    recipient: [u8; 32],
    destination_caller: [u8; 32],
}

#[allow(clippy::too_many_arguments)]
fn format_envelope(
    version: u32,
    source_domain: u32,
    destination_domain: u32,
    nonce: u64,
    sender: &[u8; 32],
    recipient: &[u8; 32],
    destination_caller: &[u8; 32],
    body: &[u8],
) -> Vec<u8> {
    let mut o = Vec::with_capacity(HEADER_LEN + body.len());
    o.extend_from_slice(&version.to_be_bytes());
    o.extend_from_slice(&source_domain.to_be_bytes());
    o.extend_from_slice(&destination_domain.to_be_bytes());
    o.extend_from_slice(&nonce.to_be_bytes());
    o.extend_from_slice(sender);
    o.extend_from_slice(recipient);
    o.extend_from_slice(destination_caller);
    o.extend_from_slice(body);
    o
}

fn decode_envelope(m: &[u8]) -> Envelope {
    Envelope {
        version: u32::from_be_bytes(m[0..4].try_into().unwrap()),
        source_domain: u32::from_be_bytes(m[4..8].try_into().unwrap()),
        destination_domain: u32::from_be_bytes(m[8..12].try_into().unwrap()),
        nonce: u64::from_be_bytes(m[12..20].try_into().unwrap()),
        sender: m[20..52].try_into().unwrap(),
        recipient: m[52..84].try_into().unwrap(),
        destination_caller: m[84..116].try_into().unwrap(),
    }
}

/// `keccak256(abi.encode(TYPEHASH, keccak256(message), chainId, transmitter))`.
/// All four words are 32 bytes (static abi.encode): typehash, envelope hash,
/// chainId (uint256, big-endian), transmitter (address → 12 zero ‖ 20 bytes).
fn attestation_digest(message: &[u8], chain_id: &[u8; 32], transmitter: &[u8; 20]) -> [u8; 32] {
    let typehash = keccak256(&[TYPEHASH_STR]).to_bytes();
    let envelope_hash = keccak256(&[message]).to_bytes();
    let mut transmitter32 = [0u8; 32];
    transmitter32[12..32].copy_from_slice(transmitter);
    keccak256(&[&typehash, &envelope_hash, chain_id, &transmitter32]).to_bytes()
}

/* ------------------------------- state ---------------------------------- */

#[account]
pub struct MtConfig {
    pub owner: Pubkey,
    pub local_domain: u32,
    pub chain_id: [u8; 32],
    pub transmitter: [u8; 20],
    pub max_body_size: u64,
    pub next_nonce: u64,
    pub paused: bool,
    pub registry_program: Pubkey,
    pub bump: u8,
}
impl MtConfig {
    pub const SIZE: usize = 8 + 32 + 4 + 32 + 20 + 8 + 8 + 1 + 32 + 1;
}

#[account]
pub struct UsedNonce {
    pub used: bool,
}

/* ------------------------------ contexts -------------------------------- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = MtConfig::SIZE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, MtConfig>,
    /// CHECK: stored as the verifier program id for receive-time CPI.
    pub registry_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendMessage<'info> {
    pub sender: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MtConfig>,
}

#[derive(Accounts)]
#[instruction(source_domain: u32, nonce: u64)]
pub struct ReceiveMessage<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MtConfig>,
    #[account(
        init,
        payer = payer,
        space = 8 + 1,
        seeds = [NONCE_SEED, &source_domain.to_le_bytes(), &nonce.to_le_bytes()],
        bump
    )]
    pub used_nonce: Account<'info, UsedNonce>,
    #[account(mut, seeds = [b"registry"], bump = registry.bump, seeds::program = registry_program.key())]
    pub registry: Account<'info, Registry>,
    #[account(address = config.registry_program)]
    pub registry_program: Program<'info, ValidatorRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = owner)]
    pub config: Account<'info, MtConfig>,
}

/* ------------------------------- events --------------------------------- */

#[event]
pub struct MessageSent {
    pub message: Vec<u8>,
}

#[event]
pub struct MessageReceived {
    pub source_domain: u32,
    pub nonce: u64,
    pub sender: [u8; 32],
    pub body: Vec<u8>,
}

/* ------------------------------- errors --------------------------------- */

#[error_code]
pub enum MtErr {
    #[msg("zero local domain")]
    ZeroLocalDomain,
    #[msg("max body size below floor")]
    MaxBodyTooSmall,
    #[msg("paused")]
    Paused,
    #[msg("local destination not allowed")]
    LocalDestinationNotAllowed,
    #[msg("message body too large")]
    MessageBodyTooLarge,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("message shorter than header")]
    MessageTooShort,
    #[msg("invalid envelope version")]
    InvalidVersion,
    #[msg("invalid destination domain")]
    InvalidDestinationDomain,
    #[msg("source_domain/nonce args do not match the envelope")]
    NonceArgMismatch,
    #[msg("unauthorized destination caller")]
    UnauthorizedCaller,
}
