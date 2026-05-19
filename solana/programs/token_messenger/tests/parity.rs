//! Phase 4 gate — TokenMessenger: burn→message, only-transmitter→mint, fee.
//!
//! Full 4-program stack in LiteSVM (validator_registry + message_transmitter
//! + stable_naira + token_messenger), real nested CPIs. Asserts EVM
//! `TokenMessenger.sol` parity:
//!   - `deposit_for_burn` burns the holder + reduces supply; fee dormant at
//!     `fee_bps == 0` (amount conserved); guards.
//!   - `handle_receive_message` mints to the recipient ONLY after a
//!     successful transmitter verify+replay CPI — a replay or a tampered
//!     attestation produces no mint (the "only-transmitter→mint" invariant).

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
const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROG: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const D: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/");

const LOCAL_DOMAIN: u32 = 101;
const SRC_DOMAIN: u32 = 1;
const CHAIN_ID: [u8; 32] = {
    let mut c = [0u8; 32];
    c[31] = 42;
    c
};
const TRANSMITTER: [u8; 20] = [0xAB; 20];
const ROUTER: [u8; 32] = [0x5A; 32];

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
fn evm_digest(message: &[u8]) -> [u8; 32] {
    let th = keccak(b"StableNairaCCTPAttestation(bytes32 envelopeHash,uint256 chainId,address transmitter)");
    let eh = keccak(message);
    let mut t32 = [0u8; 32];
    t32[12..].copy_from_slice(&TRANSMITTER);
    let mut pre = Vec::new();
    pre.extend_from_slice(&th);
    pre.extend_from_slice(&eh);
    pre.extend_from_slice(&CHAIN_ID);
    pre.extend_from_slice(&t32);
    keccak(&pre)
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
    fn attest(&self, digest: &[u8; 32]) -> Vec<u8> {
        let (mut s, mut r) = sign(&SecpMsg::parse(digest), &self.sk);
        if s.s.is_high() {
            s.s = -s.s;
            r = libsecp256k1::RecoveryId::parse(r.serialize() ^ 1).unwrap();
        }
        let mut o = s.serialize().to_vec();
        o.push(27 + r.serialize());
        o
    }
}

#[allow(clippy::too_many_arguments)]
fn envelope(src: u32, dst: u32, nonce: u64, sender: &[u8; 32], body: &[u8]) -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(&1u32.to_be_bytes()); // version
    o.extend_from_slice(&src.to_be_bytes());
    o.extend_from_slice(&dst.to_be_bytes());
    o.extend_from_slice(&nonce.to_be_bytes());
    o.extend_from_slice(sender);
    o.extend_from_slice(&[0u8; 32]); // recipient (unused by the Solana flow)
    o.extend_from_slice(&[0u8; 32]); // destinationCaller = 0
    o.extend_from_slice(body);
    o
}
fn burn_body(burn_token: &[u8; 32], mint_recipient: &[u8; 32], amount: u64) -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(&1u32.to_be_bytes()); // BODY_VERSION
    o.extend_from_slice(burn_token);
    o.extend_from_slice(mint_recipient);
    let mut a = [0u8; 32];
    a[24..].copy_from_slice(&amount.to_be_bytes());
    o.extend_from_slice(&a);
    o.extend_from_slice(&[9u8; 32]); // messageSender (arbitrary)
    o
}

struct H {
    svm: LiteSVM,
    payer: Keypair,
    admin: Keypair, // sn admin + vr/mt/tm owner
    mint: Pubkey,
}
impl H {
    fn k(&self, kp: &Keypair) -> Keypair {
        kp.insecure_clone()
    }
    fn send(&mut self, ixs: &[Instruction], s: &[&Keypair]) -> Result<(), String> {
        let m = TxMsg::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(s, m, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
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

fn setup() -> (H, Pubkey, Pubkey) {
    let mut svm = LiteSVM::new();
    for p in ["vr", "mt", "sn", "tm"] {
        let f = format!(
            "{D}{}.so",
            match p {
                "vr" => "validator_registry",
                "mt" => "message_transmitter",
                "sn" => "stable_naira",
                _ => "token_messenger",
            }
        );
        svm.add_program(id(p), &std::fs::read(&f).unwrap_or_else(|_| panic!("build {f}")))
            .unwrap();
    }
    let payer = Keypair::new();
    let admin = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();

    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let mut h = H { svm, payer, admin, mint };

    let vr_reg = pda(&[b"registry"], &id("vr"));
    let mt_cfg = pda(&[b"mt_config"], &id("mt"));
    let sn_cfg = pda(&[b"config"], &id("sn"));
    let tm_cfg = pda(&[b"tm_config"], &id("tm"));
    let val = Val::new();

    // vr init (1-of-1)
    let payer = h.k(&h.payer);
    let admin = h.k(&h.admin);
    h.send(
        &[Instruction {
            program_id: id("vr"),
            accounts: vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new(vr_reg, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: validator_registry::instruction::Initialize {
                validators: vec![val.addr],
                threshold: 1,
            }
            .data(),
        }],
        &[&payer, &admin],
    )
    .expect("vr init");

    // mt init
    h.send(
        &[Instruction {
            program_id: id("mt"),
            accounts: vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new(mt_cfg, false),
                AccountMeta::new_readonly(id("vr"), false),
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
        &[&payer, &admin],
    )
    .expect("mt init");

    // sn init (creates the Token-2022 mint)
    h.send(
        &[Instruction {
            program_id: id("sn"),
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(admin.pubkey(), false),
                AccountMeta::new(sn_cfg, false),
                AccountMeta::new(mint, true),
                AccountMeta::new_readonly(TOKEN_2022, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira::instruction::Initialize { mint_cap: 0 }.data(),
        }],
        &[&payer, &mint_kp],
    )
    .expect("sn init");

    // tm init
    h.send(
        &[Instruction {
            program_id: id("tm"),
            accounts: vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new(tm_cfg, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(id("mt"), false),
                AccountMeta::new_readonly(id("sn"), false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: token_messenger::instruction::Initialize {
                fee_bps: 0,
                fee_recipient: admin.pubkey(),
            }
            .data(),
        }],
        &[&payer, &admin],
    )
    .expect("tm init");

    // grant tm_config the MINTER role on stable_naira
    let sn_minter_role = pda(&[b"role", &[0u8], tm_cfg.as_ref()], &id("sn"));
    h.send(
        &[Instruction {
            program_id: id("sn"),
            accounts: vec![
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new_readonly(sn_cfg, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(sn_minter_role, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira::instruction::GrantRole { role: 0, account: tm_cfg }.data(),
        }],
        &[&payer, &admin],
    )
    .expect("grant MINTER to tm");

    // tm set_remote_router for SRC_DOMAIN (used as both dest & source here)
    let rr = pda(&[b"remote_router", &SRC_DOMAIN.to_le_bytes()], &id("tm"));
    h.send(
        &[Instruction {
            program_id: id("tm"),
            accounts: vec![
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(tm_cfg, false),
                AccountMeta::new(rr, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: token_messenger::instruction::SetRemoteRouter {
                domain: SRC_DOMAIN,
                router: ROUTER,
            }
            .data(),
        }],
        &[&payer, &admin],
    )
    .expect("set_remote_router");

    let _ = val;
    (h, sn_cfg, tm_cfg)
}

#[test]
fn token_messenger_burn_mint_only_transmitter_parity() {
    let (mut h, sn_cfg, tm_cfg) = setup();
    let mint = h.mint;
    let val = Val::new();
    let payer = h.k(&h.payer);
    let admin = h.k(&h.admin);
    let sn_minter_role = pda(&[b"role", &[0u8], tm_cfg.as_ref()], &id("sn"));
    let rr = pda(&[b"remote_router", &SRC_DOMAIN.to_le_bytes()], &id("tm"));
    let mt_cfg = pda(&[b"mt_config"], &id("mt"));
    let vr_reg = pda(&[b"registry"], &id("vr"));

    // ---- fund a depositor via admin (super-role) mint_to ----
    let depositor = Keypair::new();
    h.svm.airdrop(&depositor.pubkey(), 1_000_000_000).unwrap();
    let dep_ata = ata(&depositor.pubkey(), &mint);
    // create depositor ATA
    h.send(
        &[Instruction {
            program_id: ATA_PROG,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(dep_ata, false),
                AccountMeta::new_readonly(depositor.pubkey(), false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
            ],
            data: vec![0],
        }],
        &[&payer],
    )
    .expect("dep ata");
    h.send(
        &[Instruction {
            program_id: id("sn"),
            accounts: vec![
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new_readonly(sn_cfg, false),
                AccountMeta::new_readonly(sn_cfg, false), // role_pda (unused: admin path)
                AccountMeta::new(mint, false),
                AccountMeta::new(dep_ata, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
            ],
            data: stable_naira::instruction::MintTo { amount: 100_000 }.data(),
        }],
        &[&payer, &admin],
    )
    .expect("fund depositor");
    assert_eq!(h.bal(&dep_ata), 100_000);
    assert_eq!(h.supply(), 100_000);

    // ---- deposit_for_burn: burns holder, reduces supply, fee dormant ----
    let dep_ix = |amount: u64, dom: u32, recip: [u8; 32]| Instruction {
        program_id: id("tm"),
        accounts: vec![
            AccountMeta::new_readonly(depositor.pubkey(), true),
            AccountMeta::new_readonly(tm_cfg, false),
            AccountMeta::new_readonly(
                pda(&[b"remote_router", &dom.to_le_bytes()], &id("tm")),
                false,
            ),
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
            amount,
            destination_domain: dom,
            mint_recipient: recip,
        }
        .data(),
    };
    let dep_kp = depositor.insecure_clone();
    h.send(&[dep_ix(40_000, SRC_DOMAIN, [0xDE; 32])], &[&payer, &dep_kp])
        .expect("deposit_for_burn");
    assert_eq!(h.bal(&dep_ata), 60_000, "holder burned");
    assert_eq!(h.supply(), 60_000, "supply reduced (fee dormant: full amount)");

    // guards
    assert!(
        h.send(&[dep_ix(0, SRC_DOMAIN, [0xDE; 32])], &[&payer, &dep_kp]).is_err(),
        "zero amount rejected"
    );
    assert!(
        h.send(&[dep_ix(1, SRC_DOMAIN, [0u8; 32])], &[&payer, &dep_kp]).is_err(),
        "zero mintRecipient rejected"
    );
    assert!(
        h.send(&[dep_ix(1, 999, [0xDE; 32])], &[&payer, &dep_kp]).is_err(),
        "unregistered remote router rejected"
    );

    // ---- handle_receive_message: mint ONLY via transmitter verify+replay ----
    let recipient = Keypair::new();
    let rec_ata = ata(&recipient.pubkey(), &mint);
    h.send(
        &[Instruction {
            program_id: ATA_PROG,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(rec_ata, false),
                AccountMeta::new_readonly(recipient.pubkey(), false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
            ],
            data: vec![0],
        }],
        &[&payer],
    )
    .expect("rec ata");

    let mk_msg = |nonce: u64, amount: u64| -> Vec<u8> {
        let body = burn_body(&mint.to_bytes(), &rec_ata.to_bytes(), amount);
        envelope(SRC_DOMAIN, LOCAL_DOMAIN, nonce, &ROUTER, &body)
    };
    let hr_ix = |nonce: u64, message: Vec<u8>, attestation: Vec<u8>| Instruction {
        program_id: id("tm"),
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true), // relayer
            AccountMeta::new_readonly(tm_cfg, false),
            AccountMeta::new_readonly(rr, false),
            AccountMeta::new_readonly(id("mt"), false),
            AccountMeta::new(mt_cfg, false),
            AccountMeta::new(
                pda(
                    &[b"used_nonce", &SRC_DOMAIN.to_le_bytes(), &nonce.to_le_bytes()],
                    &id("mt"),
                ),
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
            source_domain: SRC_DOMAIN,
            nonce,
            message,
            attestation,
        }
        .data(),
    };

    let m7 = mk_msg(7, 25_000);
    let a7 = val.attest(&evm_digest(&m7));
    h.send(&[hr_ix(7, m7.clone(), a7.clone())], &[&payer])
        .expect("handle_receive_message mints to recipient");
    assert_eq!(h.bal(&rec_ata), 25_000, "recipient minted");
    assert_eq!(h.supply(), 85_000, "supply increased by minted amount");

    // only-transmitter→mint invariant #1: replay yields NO mint
    assert!(
        h.send(&[hr_ix(7, m7, a7)], &[&payer]).is_err(),
        "replay (same source,nonce) must fail — transmitter UsedNonce"
    );
    assert_eq!(h.bal(&rec_ata), 25_000, "no extra mint on replay");

    // only-transmitter→mint invariant #2: tampered attestation yields NO mint
    let m8 = mk_msg(8, 30_000);
    let mut a8 = val.attest(&evm_digest(&m8));
    a8[0] ^= 0xFF; // corrupt r → verifier rejects
    assert!(
        h.send(&[hr_ix(8, m8, a8)], &[&payer]).is_err(),
        "tampered attestation must fail verify — no mint"
    );
    assert_eq!(h.bal(&rec_ata), 25_000, "no mint without valid attestation");
    assert_eq!(h.supply(), 85_000);

    // fresh nonce + valid attestation still works
    let m9 = mk_msg(9, 5_000);
    let a9 = val.attest(&evm_digest(&m9));
    h.send(&[hr_ix(9, m9, a9)], &[&payer]).expect("fresh valid receive");
    assert_eq!(h.bal(&rec_ata), 30_000);
    assert_eq!(h.supply(), 90_000);
}
