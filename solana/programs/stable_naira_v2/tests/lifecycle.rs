//! `stable_naira_v2` end-to-end gate — classic SPL controller behaviour.
//!
//! Runs the real `stable_naira_v2` SBF program in LiteSVM with the bundled
//! SPL Token (classic) + ATA programs. Covers:
//!
//! - `initialize` creates an SPL mint owned by the controller PDA, with both
//!   mint authority + freeze authority set to that PDA. Decimals = 2.
//! - `grant_role` / `revoke_role` admin gating; non-admin attempts fail.
//! - `mint_to` requires MINTER role grant; mint_cap is enforced.
//! - `freeze` / `thaw` require FREEZER role; a frozen account can't transfer.
//! - `transfer_admin` rotates admin authority cleanly.
//!
//! Run with: `anchor build && cargo test -p stable_naira_v2`

use anchor_lang::{AccountDeserialize, InstructionData};
use litesvm::LiteSVM;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROG: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");

const SO_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/stable_naira_v2.so"
);

const ROLE_MINTER: u8 = 0;
const ROLE_FREEZER: u8 = 1;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(stable_naira_v2::ID.to_bytes())
}

fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"config"], &program_id())
}

fn role_pda(role: u8, who: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"role", &[role], who.as_ref()], &program_id()).0
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN.as_ref(), mint.as_ref()],
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
    /// Boot a fresh LiteSVM with the program loaded and `initialize` already
    /// called (mint_cap = `cap`).
    fn new(cap: u64) -> Self {
        let mut svm = LiteSVM::new();
        let elf = std::fs::read(SO_PATH)
            .unwrap_or_else(|_| panic!("missing {SO_PATH} — run `cargo build-sbf` first"));
        svm.add_program(program_id(), &elf).unwrap();
        let payer = Keypair::new();
        let admin = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

        let mint_kp = Keypair::new();
        let mint = mint_kp.pubkey();
        let (config, _) = config_pda();

        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(admin.pubkey(), false),
                AccountMeta::new(config, false),
                AccountMeta::new(mint, true),
                AccountMeta::new_readonly(TOKEN, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira_v2::instruction::Initialize { mint_cap: cap }.data(),
        };
        let h = Self { svm, payer, admin, mint };
        let mut h = h;
        h.send(&[ix], &[&h.payer_kp(), &mint_kp]).expect("initialize");
        h
    }

    fn payer_kp(&self) -> Keypair {
        self.payer.insecure_clone()
    }

    fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(), litesvm::types::FailedTransactionMetadata> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &blockhash);
        let tx = Transaction::new(signers, msg, blockhash);
        self.svm.send_transaction(tx).map(|_| ())
    }

    fn grant_role(&mut self, role: u8, who: &Pubkey) {
        let grant = role_pda(role, who);
        let (config, _) = config_pda();
        let ix = Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new_readonly(config, false),
                AccountMeta::new_readonly(*who, false),
                AccountMeta::new(grant, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: stable_naira_v2::instruction::GrantRole { role }.data(),
        };
        let admin_kp = self.admin.insecure_clone();
        let payer_kp = self.payer_kp();
        self.send(&[ix], &[&payer_kp, &admin_kp])
            .unwrap_or_else(|e| panic!("grant_role role={role}: {e:?}"));
    }

    fn create_ata(&mut self, owner: &Pubkey) -> Pubkey {
        // SPL ATA program: instruction tag 0 = create
        let ata_addr = ata(owner, &self.mint);
        let ix = Instruction {
            program_id: ATA_PROG,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),  // funding
                AccountMeta::new(ata_addr, false),            // ATA
                AccountMeta::new_readonly(*owner, false),     // wallet
                AccountMeta::new_readonly(self.mint, false),  // mint
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(TOKEN, false),
            ],
            data: vec![0u8], // Create
        };
        let payer_kp = self.payer_kp();
        self.send(&[ix], &[&payer_kp])
            .unwrap_or_else(|e| panic!("create ATA: {e:?}"));
        ata_addr
    }
}

fn read_token_account(svm: &LiteSVM, addr: &Pubkey) -> (u64, bool) {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token::state::Account as TokenAccount;
    use anchor_spl::token::spl_token::state::AccountState;
    let data = svm.get_account(addr).expect("account").data;
    let acc = TokenAccount::unpack(&data).expect("decode token acct");
    (acc.amount, acc.state == AccountState::Frozen)
}

fn read_config(svm: &LiteSVM) -> stable_naira_v2::Config {
    let (config, _) = config_pda();
    let data = svm.get_account(&config).expect("config").data;
    stable_naira_v2::Config::try_deserialize(&mut data.as_slice()).expect("config deser")
}

// ───────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────

#[test]
fn initialize_creates_spl_mint_with_controller_authorities() {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token::state::Mint;

    let h = H::new(0);
    let (cfg_pda, _) = config_pda();

    // The mint must be owned by classic SPL Token program (not Token-2022).
    let mint_acc = h.svm.get_account(&h.mint).expect("mint account");
    assert_eq!(mint_acc.owner, TOKEN, "mint owner should be classic SPL");

    let mint_state = Mint::unpack(&mint_acc.data).expect("decode mint");
    assert_eq!(mint_state.decimals, 2, "SNR decimals must be 2");
    assert_eq!(
        mint_state.mint_authority.unwrap(),
        cfg_pda,
        "mint authority must be controller PDA",
    );
    assert_eq!(
        mint_state.freeze_authority.unwrap(),
        cfg_pda,
        "freeze authority must be controller PDA",
    );
    assert_eq!(mint_state.supply, 0, "fresh mint should be empty");

    // Config state sanity
    let cfg = read_config(&h.svm);
    assert_eq!(cfg.admin, h.admin.pubkey());
    assert_eq!(cfg.mint, h.mint);
    assert_eq!(cfg.mint_cap, 0);
    assert_eq!(cfg.total_minted, 0);
}

#[test]
fn mint_to_requires_minter_role() {
    let mut h = H::new(0);
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let user = Keypair::new();
    let user_ata = h.create_ata(&user.pubkey());

    // Try to mint without granting MINTER — should fail because the role
    // grant PDA doesn't exist (Anchor's `Account<RoleGrant>` deserializes
    // null and returns AccountNotInitialized).
    let (cfg, _) = config_pda();
    let grant = role_pda(ROLE_MINTER, &stranger.pubkey());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(stranger.pubkey(), true),
            AccountMeta::new(cfg, false),
            AccountMeta::new_readonly(grant, false),
            AccountMeta::new(h.mint, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: stable_naira_v2::instruction::MintTo { amount: 1_000 }.data(),
    };
    let payer_kp = h.payer_kp();
    let res = h.send(&[ix], &[&payer_kp, &stranger]);
    assert!(res.is_err(), "mint without MINTER role should fail");
}

#[test]
fn mint_to_succeeds_with_minter_role_and_updates_supply() {
    let mut h = H::new(0);
    let minter = Keypair::new();
    h.svm.airdrop(&minter.pubkey(), 1_000_000_000).unwrap();
    h.grant_role(ROLE_MINTER, &minter.pubkey());

    let user = Keypair::new();
    let user_ata = h.create_ata(&user.pubkey());

    let (cfg, _) = config_pda();
    let grant = role_pda(ROLE_MINTER, &minter.pubkey());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(minter.pubkey(), true),
            AccountMeta::new(cfg, false),
            AccountMeta::new_readonly(grant, false),
            AccountMeta::new(h.mint, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: stable_naira_v2::instruction::MintTo { amount: 10_000 }.data(),
    };
    let payer_kp = h.payer_kp();
    h.send(&[ix], &[&payer_kp, &minter]).expect("mint_to");

    let (bal, frozen) = read_token_account(&h.svm, &user_ata);
    assert_eq!(bal, 10_000, "user ATA should have 10,000 base units");
    assert!(!frozen);
    let cfg_state = read_config(&h.svm);
    assert_eq!(cfg_state.total_minted, 10_000);
}

#[test]
fn mint_cap_blocks_overage() {
    let mut h = H::new(5_000); // 50.00 SNR cap
    let minter = Keypair::new();
    h.svm.airdrop(&minter.pubkey(), 1_000_000_000).unwrap();
    h.grant_role(ROLE_MINTER, &minter.pubkey());

    let user = Keypair::new();
    let user_ata = h.create_ata(&user.pubkey());
    let (cfg, _) = config_pda();
    let grant = role_pda(ROLE_MINTER, &minter.pubkey());
    // Local copies so the closure doesn't borrow `h` immutably (which would
    // conflict with the mutable `h.send` calls below).
    let mint_addr = h.mint;
    let minter_pk = minter.pubkey();

    let mk_ix = move |amount: u64| Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(minter_pk, true),
            AccountMeta::new(cfg, false),
            AccountMeta::new_readonly(grant, false),
            AccountMeta::new(mint_addr, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: stable_naira_v2::instruction::MintTo { amount }.data(),
    };
    let payer_kp = h.payer_kp();

    // First mint of 4,000 — under cap, OK
    h.send(&[mk_ix(4_000)], &[&payer_kp, &minter])
        .expect("first mint");
    // Second mint of 2,000 — would push to 6,000 > 5,000 cap → reject
    let res = h.send(&[mk_ix(2_000)], &[&payer_kp, &minter]);
    assert!(res.is_err(), "mint exceeding cap should fail");
    // Boundary: 1,000 more brings us exactly to 5,000 — OK
    h.send(&[mk_ix(1_000)], &[&payer_kp, &minter])
        .expect("mint to cap boundary");
    let (bal, _) = read_token_account(&h.svm, &user_ata);
    assert_eq!(bal, 5_000);
}

#[test]
fn freeze_blocks_transfer_thaw_restores() {
    use anchor_spl::token::spl_token::instruction as tix;

    let mut h = H::new(0);
    let minter = Keypair::new();
    h.svm.airdrop(&minter.pubkey(), 1_000_000_000).unwrap();
    h.grant_role(ROLE_MINTER, &minter.pubkey());

    let freezer = Keypair::new();
    h.svm.airdrop(&freezer.pubkey(), 1_000_000_000).unwrap();
    h.grant_role(ROLE_FREEZER, &freezer.pubkey());

    let alice = Keypair::new();
    h.svm.airdrop(&alice.pubkey(), 1_000_000_000).unwrap();
    let alice_ata = h.create_ata(&alice.pubkey());
    let bob = Keypair::new();
    let bob_ata = h.create_ata(&bob.pubkey());

    // Mint 1,000 to Alice
    let (cfg, _) = config_pda();
    let mgrant = role_pda(ROLE_MINTER, &minter.pubkey());
    let mint_ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(minter.pubkey(), true),
            AccountMeta::new(cfg, false),
            AccountMeta::new_readonly(mgrant, false),
            AccountMeta::new(h.mint, false),
            AccountMeta::new(alice_ata, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: stable_naira_v2::instruction::MintTo { amount: 1_000 }.data(),
    };
    let payer_kp = h.payer_kp();
    h.send(&[mint_ix], &[&payer_kp, &minter]).expect("mint");

    // Alice transfers 200 to Bob — should succeed
    let xfer_ok = tix::transfer(&TOKEN, &alice_ata, &bob_ata, &alice.pubkey(), &[], 200).unwrap();
    h.send(&[xfer_ok.clone()], &[&payer_kp, &alice]).expect("transfer ok");
    assert_eq!(read_token_account(&h.svm, &alice_ata).0, 800);
    assert_eq!(read_token_account(&h.svm, &bob_ata).0, 200);

    // Freezer freezes Alice's ATA
    let fgrant = role_pda(ROLE_FREEZER, &freezer.pubkey());
    let freeze_ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(freezer.pubkey(), true),
            AccountMeta::new_readonly(cfg, false),
            AccountMeta::new_readonly(fgrant, false),
            AccountMeta::new_readonly(h.mint, false),
            AccountMeta::new(alice_ata, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: stable_naira_v2::instruction::Freeze {}.data(),
    };
    let freezer_kp = freezer.insecure_clone();
    h.send(&[freeze_ix], &[&payer_kp, &freezer_kp]).expect("freeze");

    // Alice's ATA should now be frozen; transfer fails
    let (_, frozen) = read_token_account(&h.svm, &alice_ata);
    assert!(frozen, "ATA should be frozen");
    let xfer_blocked =
        tix::transfer(&TOKEN, &alice_ata, &bob_ata, &alice.pubkey(), &[], 100).unwrap();
    let res = h.send(&[xfer_blocked], &[&payer_kp, &alice]);
    assert!(res.is_err(), "transfer from frozen ATA should fail");

    // Freezer thaws — transfer works again
    let thaw_ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(freezer.pubkey(), true),
            AccountMeta::new_readonly(cfg, false),
            AccountMeta::new_readonly(fgrant, false),
            AccountMeta::new_readonly(h.mint, false),
            AccountMeta::new(alice_ata, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: stable_naira_v2::instruction::Thaw {}.data(),
    };
    h.send(&[thaw_ix], &[&payer_kp, &freezer_kp]).expect("thaw");
    // Build a *distinct* transfer (different amount) so the tx signature is
    // unique vs the earlier successful one — LiteSVM dedupes identical txs.
    let xfer_after_thaw =
        tix::transfer(&TOKEN, &alice_ata, &bob_ata, &alice.pubkey(), &[], 50).unwrap();
    h.send(&[xfer_after_thaw], &[&payer_kp, &alice])
        .expect("transfer post-thaw");
    assert_eq!(read_token_account(&h.svm, &alice_ata).0, 750);
    assert_eq!(read_token_account(&h.svm, &bob_ata).0, 250);
}

#[test]
fn transfer_admin_rotates_authority() {
    let mut h = H::new(0);
    let new_admin = Keypair::new();

    let (cfg, _) = config_pda();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new(cfg, false),
        ],
        data: stable_naira_v2::instruction::TransferAdmin { new_admin: new_admin.pubkey() }
            .data(),
    };
    let payer_kp = h.payer_kp();
    let old_admin_kp = h.admin.insecure_clone();
    h.send(&[ix], &[&payer_kp, &old_admin_kp]).expect("transfer_admin");

    let cfg_state = read_config(&h.svm);
    assert_eq!(cfg_state.admin, new_admin.pubkey());

    // Old admin can no longer grant roles
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let grant = role_pda(ROLE_MINTER, &stranger.pubkey());
    let grant_ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(h.admin.pubkey(), true),
            AccountMeta::new_readonly(cfg, false),
            AccountMeta::new_readonly(stranger.pubkey(), false),
            AccountMeta::new(grant, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: stable_naira_v2::instruction::GrantRole { role: ROLE_MINTER }.data(),
    };
    let res = h.send(&[grant_ix], &[&payer_kp, &old_admin_kp]);
    assert!(res.is_err(), "old admin should be unauthorized after rotation");
}
