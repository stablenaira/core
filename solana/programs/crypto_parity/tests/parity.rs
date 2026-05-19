//! Phase 0 gate — the crypto-parity proof.
//!
//! Loads the real `crypto_parity` SBF program into LiteSVM (an in-process
//! Solana VM) and proves, on-VM:
//!
//!   1. `keccak256` is byte-identical to EVM `keccak256` — checked against
//!      hardcoded EVM-canonical constants AND an independent `tiny-keccak`
//!      reference over random input.
//!   2. secp256k1 ECDSA recovery + the Ethereum address rule
//!      (`keccak256(pubkey)[12..32]`) is byte-identical to EVM `ecrecover` —
//!      checked against an independent `libsecp256k1` recoverable signature.
//!
//! Gate passes iff every assertion below holds. Mirrors the rigor of the
//! TON Phase 0 spike (TVM opcodes vs @noble vectors).

use anchor_lang::InstructionData;
use crypto_parity::instruction::{EthEcrecover, KeccakDigest};
use litesvm::LiteSVM;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

const PROGRAM_ID: &str = "6VHLvJDTt5vCmPgPfa2PgW4TXsWFgbUSAbiesfYFa2h6";
const SO_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/crypto_parity.so"
);

fn keccak256(data: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

struct Harness {
    svm: LiteSVM,
    payer: Keypair,
    program: Pubkey,
}

impl Harness {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program = Pubkey::from_str(PROGRAM_ID).unwrap();
        let elf = std::fs::read(SO_PATH).unwrap_or_else(|_| {
            panic!("missing {SO_PATH} — run `anchor build` before the gate")
        });
        svm.add_program(program, &elf)
            .expect("failed to load crypto_parity.so into LiteSVM");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        Self { svm, payer, program }
    }

    /// Invoke an instruction (no accounts) and return its raw return data.
    fn call(&mut self, data: Vec<u8>) -> Vec<u8> {
        let ix = Instruction { program_id: self.program, accounts: vec![], data };
        let msg = Message::new(&[ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        let meta = self
            .svm
            .send_transaction(tx)
            .expect("transaction failed in-SVM");
        meta.return_data.data
    }
}

#[test]
fn keccak256_is_byte_identical_to_evm() {
    let mut h = Harness::new();

    // EVM-canonical literals (Solidity `keccak256` of these exact inputs).
    let empty = h.call(KeccakDigest { data: vec![] }.data());
    assert_eq!(
        hex::encode(&empty),
        "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        "keccak256(\"\") must equal the EVM constant"
    );

    let abc = h.call(KeccakDigest { data: b"abc".to_vec() }.data());
    assert_eq!(
        hex::encode(&abc),
        "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
        "keccak256(\"abc\") must equal the EVM constant"
    );

    // Independent reference over a non-trivial buffer (CCTP-message sized).
    let buf: Vec<u8> = (0u16..248).map(|i| (i % 251) as u8).collect();
    let on_vm = h.call(KeccakDigest { data: buf.clone() }.data());
    assert_eq!(
        on_vm,
        keccak256(&buf),
        "on-VM keccak256 must equal the independent reference"
    );
}

#[test]
fn ecrecover_is_byte_identical_to_evm() {
    use libsecp256k1::{sign, Message as SecpMsg, PublicKey, SecretKey};

    let mut h = Harness::new();

    // Deterministic secp256k1 key (the "validator" key in the bridge model).
    let sk = SecretKey::parse(&[
        0x4c, 0x0b, 0x3a, 0x11, 0x9d, 0x7e, 0x55, 0x21, 0x8a, 0x66, 0x33, 0x90, 0xf2, 0x14,
        0xab, 0xcd, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98,
        0x76, 0x54, 0x32, 0x10,
    ])
    .unwrap();
    let pk = PublicKey::from_secret_key(&sk);
    // 65-byte 0x04-prefixed; Ethereum hashes the trailing 64 bytes.
    let pk_ser = pk.serialize();
    let expected_addr = &keccak256(&pk_ser[1..65])[12..32];

    // Sign a 32-byte digest, EVM-style (recoverable ECDSA).
    let digest = keccak256(b"StableNaira CCTP attestation digest, Phase 0 parity");
    let (sig, rec) = sign(&SecpMsg::parse(&digest), &sk);
    let sig64 = sig.serialize(); // r ‖ s, 64 bytes
    let recovery_id = rec.serialize(); // 0 or 1 for an Ethereum-style digest
    assert!(recovery_id < 2, "recovery id must be EVM-compatible (v = 27/28)");

    let out = h.call(
        EthEcrecover {
            digest,
            recovery_id,
            signature: sig64,
        }
        .data(),
    );

    assert_eq!(out.len(), 20, "ecrecover must return a 20-byte address");
    assert_eq!(
        out, expected_addr,
        "on-VM secp256k1_recover + address rule must equal the EVM ecrecover address"
    );
}
