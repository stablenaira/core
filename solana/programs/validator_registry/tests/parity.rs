//! Phase 2 gate — MultisigVerifier golden-vector parity vs EVM.
//!
//! Runs the real `validator_registry` SBF program in LiteSVM and asserts the
//! verifier accepts/rejects exactly as EVM `MultisigVerifier.sol` + OZ
//! `ECDSA`. Attestations are built the way the EVM relayer builds them:
//! `t` × 65-byte `(r ‖ s ‖ v)`, low-s, sorted ascending by recovered EVM
//! address. Mirrors the TON Phase 2 golden-vector suite case-for-case.

use anchor_lang::InstructionData;
use libsecp256k1::{sign, Message, PublicKey, SecretKey};
use litesvm::LiteSVM;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message as TxMessage;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
const SO_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/validator_registry.so"
);

// secp256k1 group order n, big-endian.
const SECP256K1_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
    0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
];

fn pid() -> Pubkey {
    Pubkey::new_from_array(validator_registry::ID.to_bytes())
}
fn registry_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"registry"], &pid()).0
}
fn keccak(data: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut k = Keccak::v256();
    k.update(data);
    let mut o = [0u8; 32];
    k.finalize(&mut o);
    o
}

/// A test validator: secp256k1 key + its EVM address.
struct Val {
    sk: SecretKey,
    addr: [u8; 20],
}
impl Val {
    fn new(seed: u8) -> Self {
        let mut b = [1u8; 32];
        b[31] = seed;
        let sk = SecretKey::parse(&b).unwrap();
        let pk = PublicKey::from_secret_key(&sk).serialize(); // 65: 0x04‖X‖Y
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&keccak(&pk[1..65])[12..32]);
        Self { sk, addr }
    }

    /// Low-s `(r‖s‖v)`, EVM-canonical.
    fn sign65(&self, digest: &[u8; 32]) -> [u8; 65] {
        let (mut sig, mut rec) = sign(&Message::parse(digest), &self.sk);
        if sig.s.is_high() {
            sig.s = -sig.s; // normalize to low-s
            rec = libsecp256k1::RecoveryId::parse(rec.serialize() ^ 1).unwrap();
        }
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig.serialize());
        out[64] = 27 + rec.serialize();
        out
    }
}

/// Big-endian 256-bit `n - s`.
fn neg_mod_n(s: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = SECP256K1_N[i] as i16 - s[i] as i16 - borrow;
        if d < 0 {
            out[i] = (d + 256) as u8;
            borrow = 1;
        } else {
            out[i] = d as u8;
            borrow = 0;
        }
    }
    out
}

struct H {
    svm: LiteSVM,
    payer: Keypair,
    owner: Keypair,
}
impl H {
    fn new(validators: &[[u8; 20]], threshold: u8) -> Self {
        let mut svm = LiteSVM::new();
        let elf = std::fs::read(SO_PATH)
            .unwrap_or_else(|_| panic!("missing {SO_PATH} — run `anchor build` first"));
        svm.add_program(pid(), &elf).unwrap();
        let payer = Keypair::new();
        let owner = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

        let ix = Instruction {
            program_id: pid(),
            accounts: vec![
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new(registry_pda(), false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: validator_registry::instruction::Initialize {
                validators: validators.to_vec(),
                threshold,
            }
            .data(),
        };
        let mut h = Self { svm, payer, owner };
        h.send(&[ix], &[&h.payer_kp(), &h.owner_kp()]).expect("initialize");
        h
    }
    fn payer_kp(&self) -> Keypair {
        self.payer.insecure_clone()
    }
    fn owner_kp(&self) -> Keypair {
        self.owner.insecure_clone()
    }
    fn send(&mut self, ixs: &[Instruction], s: &[&Keypair]) -> Result<(), String> {
        let msg = TxMessage::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(s, msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }
    fn verify(&mut self, digest: [u8; 32], attestation: Vec<u8>) -> Result<(), String> {
        let ix = Instruction {
            program_id: pid(),
            accounts: vec![AccountMeta::new_readonly(registry_pda(), false)],
            data: validator_registry::instruction::Verify { digest, attestation }.data(),
        };
        self.send(&[ix], &[&self.payer_kp()])
    }
}

/// Build an attestation for `signers` over `digest`, sorted ascending by addr.
fn attestation_for(signers: &[&Val], digest: &[u8; 32]) -> Vec<u8> {
    let mut sorted: Vec<&&Val> = signers.iter().collect();
    sorted.sort_by(|a, b| a.addr.cmp(&b.addr));
    let mut out = Vec::new();
    for v in sorted {
        out.extend_from_slice(&v.sign65(digest));
    }
    out
}

#[test]
fn multisig_verifier_golden_vector_parity() {
    // 3-of-5 validator set.
    let vals: Vec<Val> = (1u8..=5).map(Val::new).collect();
    let mut set: Vec<[u8; 20]> = vals.iter().map(|v| v.addr).collect();
    set.sort();
    let mut h = H::new(&set, 3);

    let digest = keccak(b"StableNaira CCTP attestation - Phase 2 golden vector");

    // 1) accepts a valid 3-of-5 quorum, sorted ascending.
    let quorum: Vec<&Val> = vals.iter().take(3).collect();
    h.verify(digest, attestation_for(&quorum, &digest))
        .expect("valid 3-of-5 quorum must be accepted");

    // 2) owner-gated mutation: a non-owner cannot queue a rotation.
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let pending = Pubkey::find_program_address(&[b"pending"], &pid()).0;
    let bad_queue = Instruction {
        program_id: pid(),
        accounts: vec![
            AccountMeta::new_readonly(stranger.pubkey(), true), // not the owner
            AccountMeta::new(stranger.pubkey(), true),          // payer
            AccountMeta::new_readonly(registry_pda(), false),
            AccountMeta::new(pending, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: validator_registry::instruction::QueueChange {
            kind: 0,
            target: [9u8; 20],
            replacement: [0u8; 20],
            new_threshold: 0,
        }
        .data(),
    };
    let st = stranger.insecure_clone();
    assert!(
        h.send(&[bad_queue], &[&h.payer_kp(), &st]).is_err(),
        "non-owner must not queue a validator-set change"
    );

    // 3) rejects not-strictly-ascending order, and duplicates.
    let mut asc = attestation_for(&quorum, &digest);
    let mut descending = Vec::new();
    descending.extend_from_slice(&asc[130..195]); // sig[2]
    descending.extend_from_slice(&asc[65..130]); // sig[1]
    descending.extend_from_slice(&asc[0..65]); // sig[0]
    assert!(
        h.verify(digest, descending).is_err(),
        "descending signer order must be rejected"
    );
    let mut dup = Vec::new();
    dup.extend_from_slice(&asc[0..65]);
    dup.extend_from_slice(&asc[0..65]);
    dup.extend_from_slice(&asc[65..130]);
    assert!(h.verify(digest, dup).is_err(), "duplicate signer must be rejected");

    // 4) rejects a signer not in the validator set.
    let outsider = Val::new(99);
    let mixed: Vec<&Val> = vec![&vals[0], &vals[1], &outsider];
    assert!(
        h.verify(digest, attestation_for(&mixed, &digest)).is_err(),
        "non-validator signer must be rejected"
    );

    // 5) rejects a malleable high-s signature (EIP-2). Take sig[0], flip to
    //    the high-s twin (s' = n - s, v ^= 1). Same signer, must be rejected.
    let v0 = &vals[0];
    let mut s65 = v0.sign65(&digest);
    let s_lo: [u8; 32] = s65[32..64].try_into().unwrap();
    let s_hi = neg_mod_n(&s_lo);
    s65[32..64].copy_from_slice(&s_hi);
    s65[64] ^= 1; // 27<->28
    // single-signer threshold registry to isolate the s-check
    let mut h1 = H::new(&{ let mut x = vec![v0.addr]; x.sort(); x }, 1);
    h1.verify(digest, s65[..].to_vec())
        .err()
        .expect("high-s (malleable) signature must be rejected (EIP-2)");
    // sanity: the low-s twin on the same single-signer registry is accepted.
    h1.verify(digest, v0.sign65(&digest).to_vec())
        .expect("low-s signature on the same key must be accepted");

    // 6) rejects wrong attestation length (2 sigs for a 3-of-5 threshold).
    let two: Vec<&Val> = vals.iter().take(2).collect();
    asc = attestation_for(&two, &digest);
    assert!(
        h.verify(digest, asc).is_err(),
        "attestation shorter than threshold*65 must be rejected"
    );
}
