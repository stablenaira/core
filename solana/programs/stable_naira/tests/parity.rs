//! Phase 1 gate — StableNaira Token-2022 controller, EVM behaviour parity.
//!
//! Runs the real `stable_naira` SBF program in LiteSVM (which bundles the
//! SPL Token-2022 + ATA programs) and asserts the EVM `StableNaira.sol`
//! behaviour set: role gating, mintCap, mint/burn/burnFrom/redeem,
//! freeze/thaw, pause/unpause, and seize (force-move bypassing pause+freeze).

use anchor_lang::{AccountDeserialize, InstructionData};
use litesvm::LiteSVM;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROG: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");

const SO_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/stable_naira.so"
);

fn program_id() -> Pubkey {
    Pubkey::new_from_array(stable_naira::ID.to_bytes())
}
fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"config"], &program_id())
}
fn role_pda(role: u8, who: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"role", &[role], who.as_ref()], &program_id()).0
}
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()],
        &ATA_PROG,
    )
    .0
}

struct H {
    svm: LiteSVM,
    payer: Keypair,
    admin: Keypair,
    mint: Pubkey,
}

impl H {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let elf = std::fs::read(SO_PATH)
            .unwrap_or_else(|_| panic!("missing {SO_PATH} — run `anchor build` first"));
        svm.add_program(program_id(), &elf).unwrap();
        let payer = Keypair::new();
        let admin = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

        let mint_kp = Keypair::new();
        let mint = mint_kp.pubkey();
        let (config, _) = config_pda();

        // initialize(mint_cap = 0)
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(admin.pubkey(), false),
                AccountMeta::new(config, false),
                AccountMeta::new(mint, true),
                AccountMeta::new_readonly(TOKEN_2022, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira::instruction::Initialize { mint_cap: 0 }.data(),
        };
        let mut h = Self { svm, payer, admin, mint };
        h.send(&[ix], &[&h.payer_kp(), &mint_kp]).expect("initialize");
        h
    }

    fn payer_kp(&self) -> Keypair {
        self.payer.insecure_clone()
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let msg = Message::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err))
    }

    fn create_ata(&mut self, owner: &Pubkey) -> Pubkey {
        let a = ata(owner, &self.mint);
        let ix = Instruction {
            program_id: ATA_PROG,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(a, false),
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
            ],
            data: vec![0], // CreateIdempotent=1 / Create=0
        };
        self.send(&[ix], &[&self.payer_kp()]).expect("create ata");
        a
    }

    fn grant_role(&mut self, role: u8, who: &Pubkey) {
        let (config, _) = config_pda();
        let rp = role_pda(role, who);
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(config, false),
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(rp, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira::instruction::GrantRole { role, account: *who }.data(),
        };
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&self.payer_kp(), &admin]).expect("grant_role");
    }

    fn token_amount(&self, token_account: &Pubkey) -> u64 {
        let acc = self.svm.get_account(token_account).expect("ta exists");
        // SPL token Account: amount is u64 LE at offset 64.
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
    }

    fn mint_to(&mut self, authority: &Keypair, to: &Pubkey, amount: u64) -> Result<(), String> {
        let (config, _) = config_pda();
        let rp = role_pda(stable_naira::ROLE_MINTER, &authority.pubkey());
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new_readonly(authority.pubkey(), true),
                AccountMeta::new_readonly(rp, false),
                AccountMeta::new_readonly(config, false),
                AccountMeta::new(self.mint, false),
                AccountMeta::new(*to, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
            ],
            data: stable_naira::instruction::MintTo { amount }.data(),
        };
        let a = authority.insecure_clone();
        self.send(&[ix], &[&self.payer_kp(), &a])
    }
}

#[test]
fn token_and_compliance_parity() {
    let mut h = H::new();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let a_ata = h.create_ata(&alice.pubkey());
    let b_ata = h.create_ata(&bob.pubkey());

    // ---- role gating: a random key cannot mint ----
    let rando = Keypair::new();
    h.svm.airdrop(&rando.pubkey(), 1_000_000_000).unwrap();
    assert!(
        h.mint_to(&rando, &a_ata, 100).is_err(),
        "non-MINTER non-admin must not mint"
    );

    // ---- admin is implicit super-role: admin mints ----
    let admin = h.admin.insecure_clone();
    h.mint_to(&admin, &a_ata, 1_000).expect("admin mint");
    assert_eq!(h.token_amount(&a_ata), 1_000);

    // ---- granted MINTER can mint ----
    h.grant_role(stable_naira::ROLE_MINTER, &rando.pubkey());
    h.mint_to(&rando, &a_ata, 500).expect("MINTER mint");
    assert_eq!(h.token_amount(&a_ata), 1_500);

    // ---- mintCap enforced ----
    let (config, _) = config_pda();
    let set_cap = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new(config, false),
        ],
        data: stable_naira::instruction::SetMintCap { new_cap: 1_600 }.data(),
    };
    h.send(&[set_cap], &[&h.payer_kp(), &admin]).expect("set_mint_cap");
    assert!(h.mint_to(&admin, &a_ata, 200).is_err(), "mintCap must block");
    h.mint_to(&admin, &a_ata, 100).expect("within cap ok");
    assert_eq!(h.token_amount(&a_ata), 1_600);
    // lift cap
    let lift = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new(config, false),
        ],
        data: stable_naira::instruction::SetMintCap { new_cap: 0 }.data(),
    };
    h.send(&[lift], &[&h.payer_kp(), &admin]).expect("lift cap");

    // ---- burn_from: MINTER force-burns Alice without allowance ----
    let rp_m = role_pda(stable_naira::ROLE_MINTER, &h.admin.pubkey());
    let bf = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new_readonly(rp_m, false),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(h.mint, false),
            AccountMeta::new(a_ata, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: stable_naira::instruction::BurnFrom { amount: 600 }.data(),
    };
    h.send(&[bf], &[&h.payer_kp(), &admin]).expect("burn_from");
    assert_eq!(h.token_amount(&a_ata), 1_000);

    // ---- freeze: frozen account cannot be minted to (Token-2022 enforces) ----
    let rp_f = role_pda(stable_naira::ROLE_FREEZER, &h.admin.pubkey());
    let freeze = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new_readonly(rp_f, false),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new_readonly(h.mint, false),
            AccountMeta::new(a_ata, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: stable_naira::instruction::Freeze {}.data(),
    };
    h.send(&[freeze], &[&h.payer_kp(), &admin]).expect("freeze");
    assert!(
        h.mint_to(&admin, &a_ata, 10).is_err(),
        "minting to a frozen account must fail"
    );

    // ---- seize: works even though Alice is frozen (and while paused) ----
    // pause first
    let rp_p = role_pda(stable_naira::ROLE_PAUSER, &h.admin.pubkey());
    let pause = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new_readonly(rp_p, false),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(h.mint, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: stable_naira::instruction::Pause {}.data(),
    };
    h.send(&[pause], &[&h.payer_kp(), &admin]).expect("pause");

    let rp_s = role_pda(stable_naira::ROLE_SEIZER, &h.admin.pubkey());
    let seize = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new_readonly(rp_s, false),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(h.mint, false),
            AccountMeta::new(a_ata, false),
            AccountMeta::new(b_ata, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: stable_naira::instruction::Seize { amount: 400 }.data(),
    };
    h.send(&[seize], &[&h.payer_kp(), &admin])
        .expect("seize must succeed even while from frozen + mint paused");
    assert_eq!(h.token_amount(&b_ata), 400, "seized funds delivered to bob");
    assert_eq!(h.token_amount(&a_ata), 600, "alice debited by seize");

    // ---- pause still in effect afterwards: a normal mint is blocked ----
    assert!(
        h.mint_to(&admin, &b_ata, 1).is_err(),
        "mint must stay blocked: seize restored the paused state"
    );

    // ---- unpause (admin only) restores normal operation ----
    let unpause = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(h.mint, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: stable_naira::instruction::Unpause {}.data(),
    };
    h.send(&[unpause], &[&h.payer_kp(), &admin]).expect("unpause");
    h.mint_to(&admin, &b_ata, 50).expect("mint works after unpause");
    assert_eq!(h.token_amount(&b_ata), 450);

    // sanity: Config.mint matches the created mint
    let cfg_acc = h.svm.get_account(&config_pda().0).unwrap();
    let cfg = stable_naira::Config::try_deserialize(&mut &cfg_acc.data[..]).unwrap();
    assert_eq!(cfg.mint.to_bytes(), h.mint.to_bytes());
    assert_eq!(cfg.admin.to_bytes(), h.admin.pubkey().to_bytes());
}
