//! Phase 3 gate — MessageTransmitter: digest parity vs EVM + replay + pause.
//!
//! LiteSVM, both real SBF programs (`validator_registry` + `message_transmitter`).
//! `receive_message` CPIs the Phase-2 verifier, so a valid attestation is
//! accepted ONLY if the program's on-chain `attestationDigest` byte-matches
//! the independent EVM-formula digest computed here with `tiny-keccak`
//! (`keccak256(abi.encode(TYPEHASH, keccak256(envelope), chainId, transmitter))`).
//! That equality IS the digest-parity proof. Plus: replay rejection and pause.

use anchor_lang::InstructionData;
use libsecp256k1::{sign, Message as SecpMsg, PublicKey, SecretKey};
use litesvm::LiteSVM;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message as TxMsg;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
const MT_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/message_transmitter.so");
const VR_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/validator_registry.so");

const LOCAL_DOMAIN: u32 = 101; // Solana
const SOURCE_DOMAIN: u32 = 1; // Ethereum (the message's origin)
const CHAIN_ID: [u8; 32] = {
    let mut c = [0u8; 32];
    c[31] = 42; // arbitrary fixed per-deployment binding
    c
};
const TRANSMITTER: [u8; 20] = [0xAB; 20];

fn mt_id() -> Pubkey {
    Pubkey::new_from_array(message_transmitter::ID.to_bytes())
}
fn vr_id() -> Pubkey {
    Pubkey::new_from_array(validator_registry::ID.to_bytes())
}
fn pda(seeds: &[&[u8]], pid: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, pid).0
}
fn keccak(data: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut k = Keccak::v256();
    k.update(data);
    let mut o = [0u8; 32];
    k.finalize(&mut o);
    o
}

/// Independent EVM-formula attestation digest (the parity reference).
fn evm_attestation_digest(message: &[u8]) -> [u8; 32] {
    let typehash = keccak(
        b"StableNairaCCTPAttestation(bytes32 envelopeHash,uint256 chainId,address transmitter)",
    );
    let env_hash = keccak(message);
    let mut t32 = [0u8; 32];
    t32[12..].copy_from_slice(&TRANSMITTER);
    let mut pre = Vec::with_capacity(128);
    pre.extend_from_slice(&typehash);
    pre.extend_from_slice(&env_hash);
    pre.extend_from_slice(&CHAIN_ID);
    pre.extend_from_slice(&t32);
    keccak(&pre)
}

#[allow(clippy::too_many_arguments)]
fn envelope(
    version: u32,
    src: u32,
    dst: u32,
    nonce: u64,
    sender: &[u8; 32],
    recipient: &[u8; 32],
    dcaller: &[u8; 32],
    body: &[u8],
) -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(&version.to_be_bytes());
    o.extend_from_slice(&src.to_be_bytes());
    o.extend_from_slice(&dst.to_be_bytes());
    o.extend_from_slice(&nonce.to_be_bytes());
    o.extend_from_slice(sender);
    o.extend_from_slice(recipient);
    o.extend_from_slice(dcaller);
    o.extend_from_slice(body);
    o
}

struct Val {
    sk: SecretKey,
    addr: [u8; 20],
}
impl Val {
    fn new() -> Self {
        let sk = SecretKey::parse(&[7u8; 32]).unwrap();
        let pk = PublicKey::from_secret_key(&sk).serialize();
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&keccak(&pk[1..65])[12..]);
        Self { sk, addr }
    }
    /// 1-of-1 attestation over `digest`, low-s, EVM-canonical.
    fn attest(&self, digest: &[u8; 32]) -> Vec<u8> {
        let (mut sig, mut rec) = sign(&SecpMsg::parse(digest), &self.sk);
        if sig.s.is_high() {
            sig.s = -sig.s;
            rec = libsecp256k1::RecoveryId::parse(rec.serialize() ^ 1).unwrap();
        }
        let mut out = sig.serialize().to_vec(); // 64
        out.push(27 + rec.serialize());
        out
    }
}

struct H {
    svm: LiteSVM,
    payer: Keypair,
    owner: Keypair,
}
impl H {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(vr_id(), &std::fs::read(VR_SO).expect("build validator_registry"))
            .unwrap();
        svm.add_program(mt_id(), &std::fs::read(MT_SO).expect("build message_transmitter"))
            .unwrap();
        let payer = Keypair::new();
        let owner = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
        Self { svm, payer, owner }
    }
    fn payer(&self) -> Keypair {
        self.payer.insecure_clone()
    }
    fn owner(&self) -> Keypair {
        self.owner.insecure_clone()
    }
    fn send(&mut self, ixs: &[Instruction], s: &[&Keypair]) -> Result<(), String> {
        let m = TxMsg::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(s, m, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }
}

#[test]
fn transmitter_digest_replay_pause_parity() {
    let mut h = H::new();
    let val = Val::new();
    let vr_registry = pda(&[b"registry"], &vr_id());
    let mt_config = pda(&[b"mt_config"], &mt_id());

    // ---- init validator_registry: 1-of-1 (the test's EVM key) ----
    h.send(
        &[Instruction {
            program_id: vr_id(),
            accounts: vec![
                AccountMeta::new(h.owner.pubkey(), true),
                AccountMeta::new(vr_registry, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: validator_registry::instruction::Initialize {
                validators: vec![val.addr],
                threshold: 1,
            }
            .data(),
        }],
        &[&h.payer(), &h.owner()],
    )
    .expect("vr init");

    // ---- init message_transmitter ----
    h.send(
        &[Instruction {
            program_id: mt_id(),
            accounts: vec![
                AccountMeta::new(h.owner.pubkey(), true),
                AccountMeta::new(mt_config, false),
                AccountMeta::new_readonly(vr_id(), false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: message_transmitter::instruction::Initialize {
                local_domain: LOCAL_DOMAIN,
                chain_id: CHAIN_ID,
                transmitter: TRANSMITTER,
                max_body_size: 256,
            }
            .data(),
        }],
        &[&h.payer(), &h.owner()],
    )
    .expect("mt init");

    // ---- send_message: happy path + guards ----
    let sender_kp = Keypair::new();
    let send_ok = Instruction {
        program_id: mt_id(),
        accounts: vec![
            AccountMeta::new_readonly(sender_kp.pubkey(), true),
            AccountMeta::new(mt_config, false),
        ],
        data: message_transmitter::instruction::SendMessage {
            destination_domain: SOURCE_DOMAIN, // any domain != local
            recipient: [1u8; 32],
            destination_caller: [0u8; 32],
            message_body: vec![9u8; 40],
        }
        .data(),
    };
    h.send(&[send_ok.clone()], &[&h.payer(), &sender_kp]).expect("send_message");

    // dest == local must be rejected
    let send_local = Instruction {
        program_id: mt_id(),
        accounts: vec![
            AccountMeta::new_readonly(sender_kp.pubkey(), true),
            AccountMeta::new(mt_config, false),
        ],
        data: message_transmitter::instruction::SendMessage {
            destination_domain: LOCAL_DOMAIN,
            recipient: [1u8; 32],
            destination_caller: [0u8; 32],
            message_body: vec![],
        }
        .data(),
    };
    assert!(
        h.send(&[send_local], &[&h.payer(), &sender_kp]).is_err(),
        "destination == localDomain must be rejected"
    );

    // ---- digest parity: a message destined for Solana, attested over the
    //      independent EVM-formula digest, must be accepted by receive_message ----
    let nonce = 7u64;
    let body = vec![0xAAu8, 0xBB, 0xCC, 0xDD];
    let msg = envelope(1, SOURCE_DOMAIN, LOCAL_DOMAIN, nonce, &[2u8; 32], &[3u8; 32], &[0u8; 32], &body);
    let digest = evm_attestation_digest(&msg);
    let att = val.attest(&digest);

    let caller = Keypair::new();
    let mk_recv = |n: u64, message: Vec<u8>, attestation: Vec<u8>, payer_pk: Pubkey| Instruction {
        program_id: mt_id(),
        accounts: vec![
            AccountMeta::new_readonly(caller.pubkey(), true),
            AccountMeta::new(payer_pk, true),
            AccountMeta::new_readonly(mt_config, false),
            AccountMeta::new(
                pda(&[b"used_nonce", &SOURCE_DOMAIN.to_le_bytes(), &n.to_le_bytes()], &mt_id()),
                false,
            ),
            AccountMeta::new(vr_registry, false),
            AccountMeta::new_readonly(vr_id(), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: message_transmitter::instruction::ReceiveMessage {
            source_domain: SOURCE_DOMAIN,
            nonce: n,
            message,
            attestation,
        }
        .data(),
    };
    let ppk = h.payer.pubkey();

    h.send(&[mk_recv(nonce, msg.clone(), att.clone(), ppk)], &[&h.payer(), &caller])
        .expect("valid attestation over the EVM-formula digest must be accepted");

    // ---- replay: same (source_domain, nonce) rejected ----
    assert!(
        h.send(&[mk_recv(nonce, msg.clone(), att.clone(), ppk)], &[&h.payer(), &caller])
            .is_err(),
        "replay of the same (sourceDomain,nonce) must be rejected"
    );

    // ---- digest sensitivity: tamper one body byte → digest changes →
    //      verifier rejects (proves the on-chain digest tracks the message) ----
    let mut tampered = msg.clone();
    *tampered.last_mut().unwrap() ^= 0xFF;
    assert!(
        h.send(&[mk_recv(8, tampered, att.clone(), ppk)], &[&h.payer(), &caller])
            .is_err(),
        "tampered message must fail attestation (digest mismatch)"
    );

    // ---- a fresh nonce with a correct attestation still works ----
    let n2 = 8u64;
    let msg2 = envelope(1, SOURCE_DOMAIN, LOCAL_DOMAIN, n2, &[2u8; 32], &[3u8; 32], &[0u8; 32], &body);
    let att2 = val.attest(&evm_attestation_digest(&msg2));
    h.send(&[mk_recv(n2, msg2.clone(), att2.clone(), ppk)], &[&h.payer(), &caller])
        .expect("fresh nonce with valid attestation must be accepted");

    // ---- pause: blocks send + receive; unpause restores ----
    let owner_pk = h.owner.pubkey();
    let admin_ix = move |data: Vec<u8>| Instruction {
        program_id: mt_id(),
        accounts: vec![
            AccountMeta::new_readonly(owner_pk, true),
            AccountMeta::new(mt_config, false),
        ],
        data,
    };
    h.send(&[admin_ix(message_transmitter::instruction::Pause {}.data())], &[&h.payer(), &h.owner()])
        .expect("pause");
    assert!(
        h.send(&[send_ok.clone()], &[&h.payer(), &sender_kp]).is_err(),
        "send must be blocked while paused"
    );
    let n3 = 9u64;
    let msg3 = envelope(1, SOURCE_DOMAIN, LOCAL_DOMAIN, n3, &[2u8; 32], &[3u8; 32], &[0u8; 32], &body);
    let att3 = val.attest(&evm_attestation_digest(&msg3));
    assert!(
        h.send(&[mk_recv(n3, msg3.clone(), att3.clone(), ppk)], &[&h.payer(), &caller]).is_err(),
        "receive must be blocked while paused"
    );
    h.send(
        &[admin_ix(message_transmitter::instruction::Unpause {}.data())],
        &[&h.payer(), &h.owner()],
    )
    .expect("unpause");
    let n4 = 10u64;
    let msg4 = envelope(1, SOURCE_DOMAIN, LOCAL_DOMAIN, n4, &[2u8; 32], &[3u8; 32], &[0u8; 32], &body);
    let att4 = val.attest(&evm_attestation_digest(&msg4));
    h.send(&[mk_recv(n4, msg4, att4, ppk)], &[&h.payer(), &caller])
        .expect("receive works again after unpause");
}
