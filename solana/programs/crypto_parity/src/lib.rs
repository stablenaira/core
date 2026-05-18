use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use solana_keccak_hasher::hashv as keccak256;
use solana_secp256k1_recover::secp256k1_recover;

declare_id!("6VHLvJDTt5vCmPgPfa2PgW4TXsWFgbUSAbiesfYFa2h6");

// Phase 0 crypto-parity spike.
//
// Proves the Solana VM's keccak256 and secp256k1 ECDSA recovery are
// byte-identical to EVM's `keccak256` / `ecrecover` (incl. the Ethereum
// address-derivation rule). If they are, ONE secp256k1 validator signature
// verifies on both EVM and Solana with no re-keying — the shared-attestation
// model the whole CCTP bridge depends on. Mirrors the TON Phase 0 spike.

#[program]
pub mod crypto_parity {
    use super::*;

    /// keccak256(data) -> 32-byte digest, surfaced via return data so the
    /// in-SVM test can compare it against EVM-canonical vectors.
    pub fn keccak_digest(_ctx: Context<NoAccounts>, data: Vec<u8>) -> Result<()> {
        let h = keccak256(&[&data]);
        set_return_data(&h.to_bytes());
        Ok(())
    }

    /// EVM `ecrecover`: recover the secp256k1 pubkey from
    /// (digest, recovery_id, r‖s), then derive the 20-byte Ethereum address
    /// `keccak256(pubkey)[12..32]`. `recovery_id` is the EVM `v - 27` (0 or 1).
    pub fn eth_ecrecover(
        _ctx: Context<NoAccounts>,
        digest: [u8; 32],
        recovery_id: u8,
        signature: [u8; 64],
    ) -> Result<()> {
        let pubkey = secp256k1_recover(&digest, recovery_id, &signature)
            .map_err(|_| error!(ParityError::RecoverFailed))?;
        // `pubkey.0` is the 64-byte uncompressed key WITHOUT the 0x04 prefix —
        // exactly the preimage Ethereum hashes for address derivation.
        let h = keccak256(&[&pubkey.0]);
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&h.to_bytes()[12..32]);
        set_return_data(&addr);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct NoAccounts {}

#[error_code]
pub enum ParityError {
    #[msg("secp256k1 recovery failed")]
    RecoverFailed,
}
