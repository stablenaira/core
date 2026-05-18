//! Phase 6 gate — deterministic Solana↔EVM bidirectional roundtrip.
//!
//! In-SVM only (LiteSVM), the full real 4-program stack, ONE shared
//! secp256k1 validator key used for BOTH directions. Live-testnet smoke is a
//! deployment step (funded keys / RPC) gated separately as Phase 6L.
//!
//! Direction A — EVM→Solana: an envelope as the EVM TokenMessenger would
//!   emit, attested over the Solana-bound digest by the shared key, is
//!   accepted by the real Solana stack and mints SNR; replay is blocked.
//! Direction B — Solana→EVM: a real `deposit_for_burn` burns SNR and emits
//!   an envelope; attested over the EVM-bound digest by the SAME key, the
//!   recovered signer is the registered validator — i.e. an EVM
//!   `MultisigVerifier` with the shared set would accept it (rule proven
//!   byte-identical in Phases 2/3).

use anchor_lang::InstructionData;
use base64::{engine::general_purpose::STANDARD, Engine};
use libsecp256k1::{recover, sign, Message as SecpMsg, PublicKey, RecoveryId, SecretKey, Signature};
use litesvm::LiteSVM;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message as TxMsg;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROG: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");

const SOLANA_DOMAIN: u32 = 101;
const EVM_DOMAIN: u32 = 84_532; // Base Sepolia

// Solana mt deployment binding (destination side for EVM→Solana).
const SOL_CHAIN_ID: [u8; 32] = {
    let mut c = [0u8; 32];
    c[31] = 42;
    c
};
const SOL_TRANSMITTER: [u8; 20] = [0xAB; 20];
// EVM deployment binding (destination side for Solana→EVM).
const EVM_CHAIN_ID: [u8; 32] = {
    let mut c = [0u8; 32];
    c[30] = 0x4A;
    c[31] = 0x34; // 0x4A34 = 18996 (arbitrary fixed EVM chainId stand-in)
    c
};
const EVM_TRANSMITTER: [u8; 20] = [0xEE; 20];
const PEER_ROUTER: [u8; 32] = [0x5A; 32]; // peer TokenMessenger, cross-registered both ways

fn id(p: &str) -> Pubkey {
    match p {
        "vr" => Pubkey::new_from_array(validator_registry::ID.to_bytes()),
        "mt" => Pubkey::new_from_array(message_transmitter::ID.to_bytes()),
        "sn" => Pubkey::new_from_array(stable_naira::ID.to_bytes()),
        _ => Pubkey::new_from_array(token_messenger::ID.to_bytes()),
    }
}
fn pda(seeds: &[&[u8]], p: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, p).0
}
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROG).0
}
fn keccak(d: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut k = Keccak::v256();
    k.update(d);
    let mut o = [0u8; 32];
    k.finalize(&mut o);
    o
}
/// EVM-formula attestation digest, destination-bound.
fn digest(message: &[u8], chain_id: &[u8; 32], transmitter: &[u8; 20]) -> [u8; 32] {
    let th = keccak(b"StableNairaCCTPAttestation(bytes32 envelopeHash,uint256 chainId,address transmitter)");
    let eh = keccak(message);
    let mut t32 = [0u8; 32];
    t32[12..].copy_from_slice(transmitter);
    let mut pre = Vec::new();
    pre.extend_from_slice(&th);
    pre.extend_from_slice(&eh);
    pre.extend_from_slice(chain_id);
    pre.extend_from_slice(&t32);
    keccak(&pre)
}

/// The single shared secp256k1 validator (one key for EVM, TON and Solana).
struct Shared {
    sk: SecretKey,
    addr: [u8; 20],
}
impl Shared {
    fn new() -> Self {
        let sk = SecretKey::parse(&[7u8; 32]).unwrap();
        let pk = PublicKey::from_secret_key(&sk).serialize();
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&keccak(&pk[1..65])[12..]);
        Self { sk, addr }
    }
    fn attest(&self, d: &[u8; 32]) -> Vec<u8> {
        let (mut s, mut r) = sign(&SecpMsg::parse(d), &self.sk);
        if s.s.is_high() {
            s.s = -s.s;
            r = RecoveryId::parse(r.serialize() ^ 1).unwrap();
        }
        let mut o = s.serialize().to_vec();
        o.push(27 + r.serialize());
        o
    }
}

/// Recover the EVM signer address from a packed 65-byte `r‖s‖v` over `d`.
fn recover_addr(d: &[u8; 32], sig65: &[u8]) -> [u8; 20] {
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&sig65[..64]);
    let s = Signature::parse_standard(&rs).unwrap();
    let rid = RecoveryId::parse(sig65[64] - 27).unwrap();
    let pk = recover(&SecpMsg::parse(d), &s, &rid).unwrap().serialize();
    let mut a = [0u8; 20];
    a.copy_from_slice(&keccak(&pk[1..65])[12..]);
    a
}

#[allow(clippy::too_many_arguments)]
fn envelope(src: u32, dst: u32, nonce: u64, sender: &[u8; 32], body: &[u8]) -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(&1u32.to_be_bytes());
    o.extend_from_slice(&src.to_be_bytes());
    o.extend_from_slice(&dst.to_be_bytes());
    o.extend_from_slice(&nonce.to_be_bytes());
    o.extend_from_slice(sender);
    o.extend_from_slice(&[0u8; 32]); // recipient (unused by Solana flow)
    o.extend_from_slice(&[0u8; 32]); // destinationCaller
    o.extend_from_slice(body);
    o
}
fn burn_body(burn_token: &[u8; 32], mint_recipient: &[u8; 32], amount: u64) -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(&1u32.to_be_bytes());
    o.extend_from_slice(burn_token);
    o.extend_from_slice(mint_recipient);
    let mut a = [0u8; 32];
    a[24..].copy_from_slice(&amount.to_be_bytes());
    o.extend_from_slice(&a);
    o.extend_from_slice(&[9u8; 32]);
    o
}

struct H {
    svm: LiteSVM,
    payer: Keypair,
    admin: Keypair,
    mint: Pubkey,
}
impl H {
    fn send(&mut self, ixs: &[Instruction], s: &[&Keypair]) -> Result<Vec<String>, String> {
        let m = TxMsg::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(s, m, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|meta| meta.logs)
            .map_err(|e| format!("{:?}", e.err))
    }
    fn bal(&self, ta: &Pubkey) -> u64 {
        let a = self.svm.get_account(ta).expect("ta");
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }
    fn supply(&self) -> u64 {
        let a = self.svm.get_account(&self.mint).expect("mint");
        u64::from_le_bytes(a.data[36..44].try_into().unwrap())
    }
}

/// Extract the `MessageSent { message }` envelope bytes from Anchor
/// "Program data:" logs (8-byte event disc + Borsh `Vec<u8>`).
fn emitted_envelope(logs: &[String], src: u32, dst: u32) -> Vec<u8> {
    for l in logs {
        let Some(b64) = l.strip_prefix("Program data: ") else { continue };
        let Ok(raw) = STANDARD.decode(b64.trim()) else { continue };
        if raw.len() < 12 {
            continue;
        }
        let len = u32::from_le_bytes(raw[8..12].try_into().unwrap()) as usize;
        if raw.len() != 12 + len || len < 116 {
            continue;
        }
        let msg = &raw[12..];
        if msg[0..4] == 1u32.to_be_bytes()
            && msg[4..8] == src.to_be_bytes()
            && msg[8..12] == dst.to_be_bytes()
        {
            return msg.to_vec();
        }
    }
    panic!("MessageSent envelope not found in logs");
}

fn setup() -> (H, Shared, Pubkey, Pubkey) {
    let mut svm = LiteSVM::new();
    for (p, f) in [
        ("vr", "validator_registry"),
        ("mt", "message_transmitter"),
        ("sn", "stable_naira"),
        ("tm", "token_messenger"),
    ] {
        let path = format!("{DIR}{f}.so");
        svm.add_program(id(p), &std::fs::read(&path).unwrap_or_else(|_| panic!("build {path}")))
            .unwrap();
    }
    let payer = Keypair::new();
    let admin = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let mut h = H { svm, payer, admin, mint };
    let shared = Shared::new();

    let vr_reg = pda(&[b"registry"], &id("vr"));
    let mt_cfg = pda(&[b"mt_config"], &id("mt"));
    let sn_cfg = pda(&[b"config"], &id("sn"));
    let tm_cfg = pda(&[b"tm_config"], &id("tm"));
    let p = h.payer.insecure_clone();
    let a = h.admin.insecure_clone();

    h.send(
        &[Instruction {
            program_id: id("vr"),
            accounts: vec![
                AccountMeta::new(a.pubkey(), true),
                AccountMeta::new(vr_reg, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: validator_registry::instruction::Initialize {
                validators: vec![shared.addr],
                threshold: 1,
            }
            .data(),
        }],
        &[&p, &a],
    )
    .expect("vr init");
    h.send(
        &[Instruction {
            program_id: id("mt"),
            accounts: vec![
                AccountMeta::new(a.pubkey(), true),
                AccountMeta::new(mt_cfg, false),
                AccountMeta::new_readonly(id("vr"), false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: message_transmitter::instruction::Initialize {
                local_domain: SOLANA_DOMAIN,
                chain_id: SOL_CHAIN_ID,
                transmitter: SOL_TRANSMITTER,
                max_body_size: 256,
            }
            .data(),
        }],
        &[&p, &a],
    )
    .expect("mt init");
    h.send(
        &[Instruction {
            program_id: id("sn"),
            accounts: vec![
                AccountMeta::new(p.pubkey(), true),
                AccountMeta::new_readonly(a.pubkey(), false),
                AccountMeta::new(sn_cfg, false),
                AccountMeta::new(mint, true),
                AccountMeta::new_readonly(TOKEN_2022, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira::instruction::Initialize { mint_cap: 0 }.data(),
        }],
        &[&p, &mint_kp],
    )
    .expect("sn init");
    h.send(
        &[Instruction {
            program_id: id("tm"),
            accounts: vec![
                AccountMeta::new(a.pubkey(), true),
                AccountMeta::new(tm_cfg, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(id("mt"), false),
                AccountMeta::new_readonly(id("sn"), false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: token_messenger::instruction::Initialize {
                fee_bps: 0,
                fee_recipient: a.pubkey(),
            }
            .data(),
        }],
        &[&p, &a],
    )
    .expect("tm init");
    let sn_minter_role = pda(&[b"role", &[0u8], tm_cfg.as_ref()], &id("sn"));
    h.send(
        &[Instruction {
            program_id: id("sn"),
            accounts: vec![
                AccountMeta::new_readonly(a.pubkey(), true),
                AccountMeta::new_readonly(sn_cfg, false),
                AccountMeta::new(p.pubkey(), true),
                AccountMeta::new(sn_minter_role, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira::instruction::GrantRole { role: 0, account: tm_cfg }.data(),
        }],
        &[&p, &a],
    )
    .expect("grant MINTER");
    // cross-register the peer router for EVM_DOMAIN (used both directions).
    let rr = pda(&[b"remote_router", &EVM_DOMAIN.to_le_bytes()], &id("tm"));
    h.send(
        &[Instruction {
            program_id: id("tm"),
            accounts: vec![
                AccountMeta::new_readonly(a.pubkey(), true),
                AccountMeta::new(p.pubkey(), true),
                AccountMeta::new_readonly(tm_cfg, false),
                AccountMeta::new(rr, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: token_messenger::instruction::SetRemoteRouter {
                domain: EVM_DOMAIN,
                router: PEER_ROUTER,
            }
            .data(),
        }],
        &[&p, &a],
    )
    .expect("set_remote_router EVM");

    (h, shared, sn_cfg, tm_cfg)
}

#[test]
fn solana_evm_bidirectional_roundtrip() {
    let (mut h, shared, sn_cfg, tm_cfg) = setup();
    let mint = h.mint;
    let p = h.payer.insecure_clone();
    let sn_minter_role = pda(&[b"role", &[0u8], tm_cfg.as_ref()], &id("sn"));
    let rr = pda(&[b"remote_router", &EVM_DOMAIN.to_le_bytes()], &id("tm"));
    let mt_cfg = pda(&[b"mt_config"], &id("mt"));
    let vr_reg = pda(&[b"registry"], &id("vr"));

    let mk_ata = |h: &mut H, owner: &Pubkey| -> Pubkey {
        let at = ata(owner, &mint);
        h.send(
            &[Instruction {
                program_id: ATA_PROG,
                accounts: vec![
                    AccountMeta::new(p.pubkey(), true),
                    AccountMeta::new(at, false),
                    AccountMeta::new_readonly(*owner, false),
                    AccountMeta::new_readonly(mint, false),
                    AccountMeta::new_readonly(SYSTEM, false),
                    AccountMeta::new_readonly(TOKEN_2022, false),
                ],
                data: vec![0],
            }],
            &[&p],
        )
        .expect("ata");
        at
    };

    // ---- Direction A — EVM→Solana ----
    let recipient = Keypair::new();
    let rec_ata = mk_ata(&mut h, &recipient.pubkey());
    let body_a = burn_body(&mint.to_bytes(), &rec_ata.to_bytes(), 70_000);
    let env_a = envelope(EVM_DOMAIN, SOLANA_DOMAIN, 11, &PEER_ROUTER, &body_a);
    let att_a = shared.attest(&digest(&env_a, &SOL_CHAIN_ID, &SOL_TRANSMITTER));

    let hr = |nonce: u64, msg: Vec<u8>, att: Vec<u8>| Instruction {
        program_id: id("tm"),
        accounts: vec![
            AccountMeta::new(p.pubkey(), true),
            AccountMeta::new_readonly(tm_cfg, false),
            AccountMeta::new_readonly(rr, false),
            AccountMeta::new_readonly(id("mt"), false),
            AccountMeta::new(mt_cfg, false),
            AccountMeta::new(
                pda(&[b"used_nonce", &EVM_DOMAIN.to_le_bytes(), &nonce.to_le_bytes()], &id("mt")),
                false,
            ),
            AccountMeta::new(vr_reg, false),
            AccountMeta::new_readonly(id("vr"), false),
            AccountMeta::new_readonly(id("sn"), false),
            AccountMeta::new_readonly(sn_minter_role, false),
            AccountMeta::new_readonly(sn_cfg, false),
            AccountMeta::new(mint, false),
            AccountMeta::new(rec_ata, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: token_messenger::instruction::HandleReceiveMessage {
            source_domain: EVM_DOMAIN,
            nonce,
            message: msg,
            attestation: att,
        }
        .data(),
    };
    h.send(&[hr(11, env_a.clone(), att_a.clone())], &[&p])
        .expect("EVM→Solana: shared-key attestation mints SNR");
    assert_eq!(h.bal(&rec_ata), 70_000, "recipient minted on Solana");
    assert_eq!(h.supply(), 70_000);
    assert!(
        h.send(&[hr(11, env_a, att_a)], &[&p]).is_err(),
        "replay blocked (UsedNonce)"
    );
    assert_eq!(h.supply(), 70_000, "no extra mint on replay");

    // ---- Direction B — Solana→EVM ----
    let depositor = Keypair::new();
    h.svm.airdrop(&depositor.pubkey(), 1_000_000_000).unwrap();
    let dep_ata = mk_ata(&mut h, &depositor.pubkey());
    let admin = h.admin.insecure_clone();
    h.send(
        &[Instruction {
            program_id: id("sn"),
            accounts: vec![
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new_readonly(sn_cfg, false),
                AccountMeta::new_readonly(sn_cfg, false),
                AccountMeta::new(mint, false),
                AccountMeta::new(dep_ata, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
            ],
            data: stable_naira::instruction::MintTo { amount: 50_000 }.data(),
        }],
        &[&p, &admin],
    )
    .expect("fund depositor");
    let supply_before = h.supply();

    let evm_recip: [u8; 32] = {
        let mut r = [0u8; 32];
        r[12..].copy_from_slice(&[0xC0; 20]); // an EVM address as bytes32
        r
    };
    let dep_kp = depositor.insecure_clone();
    let logs = h
        .send(
            &[Instruction {
                program_id: id("tm"),
                accounts: vec![
                    AccountMeta::new_readonly(depositor.pubkey(), true),
                    AccountMeta::new_readonly(tm_cfg, false),
                    AccountMeta::new_readonly(rr, false),
                    AccountMeta::new_readonly(id("sn"), false),
                    AccountMeta::new_readonly(sn_minter_role, false),
                    AccountMeta::new_readonly(sn_cfg, false),
                    AccountMeta::new(mint, false),
                    AccountMeta::new(dep_ata, false),
                    AccountMeta::new_readonly(TOKEN_2022, false),
                    AccountMeta::new_readonly(id("mt"), false),
                    AccountMeta::new(mt_cfg, false),
                ],
                data: token_messenger::instruction::DepositForBurn {
                    amount: 30_000,
                    destination_domain: EVM_DOMAIN,
                    mint_recipient: evm_recip,
                }
                .data(),
            }],
            &[&p, &dep_kp],
        )
        .expect("Solana→EVM: deposit_for_burn");

    assert_eq!(h.bal(&dep_ata), 20_000, "depositor burned 30k");
    assert_eq!(h.supply(), supply_before - 30_000, "supply reduced by burn");

    // The exact envelope the Solana message_transmitter emitted.
    let env_b = emitted_envelope(&logs, SOLANA_DOMAIN, EVM_DOMAIN);
    assert_eq!(env_b.len(), 116 + 132);
    assert_eq!(&env_b[20..52], tm_cfg.as_ref(), "sender = tm config PDA");
    assert_eq!(&env_b[52..84], &PEER_ROUTER, "recipient = peer router");
    let b = &env_b[116..];
    assert_eq!(&b[4..36], &mint.to_bytes(), "burnToken = SNR mint");
    assert_eq!(&b[36..68], &evm_recip, "mintRecipient preserved");
    assert_eq!(
        u64::from_be_bytes(b[92..100].try_into().unwrap()),
        30_000,
        "amount preserved (fee dormant)"
    );

    // The SAME shared key attests over the EVM-bound digest; the recovered
    // signer is the registered validator ⇒ an EVM MultisigVerifier with the
    // shared set accepts it (rule proven byte-identical in Phases 2/3).
    let evm_digest = digest(&env_b, &EVM_CHAIN_ID, &EVM_TRANSMITTER);
    let evm_att = shared.attest(&evm_digest);
    assert_eq!(
        recover_addr(&evm_digest, &evm_att),
        shared.addr,
        "EVM-bound attestation recovers the shared validator"
    );

    // Key uniformity: the very same address is the one registered on Solana.
    let reg = h.svm.get_account(&vr_reg).expect("registry");
    // Registry: 8 disc + 32 owner + 1 threshold + 4 vec-len + 20*addr...
    let first_validator = &reg.data[45..65];
    assert_eq!(first_validator, shared.addr, "one shared key across chains");
}
