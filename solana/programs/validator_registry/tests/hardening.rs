//! Phase 7 gate — timelocked validator-set rotation (audit-prep hardening).
//!
//! Mirrors EVM `ValidatorRegistry` queue/commit/cancel: owner queues exactly
//! one pending change, commit is blocked until `eta`, commit is then
//! permissionless, cancel is owner-only, and the threshold invariant is
//! enforced on the post-state at commit. The Solana analogue of TON Phase 7's
//! real timelock code (Solana program-code upgrades are loader/Squads, not
//! in-program — documented separately in the audit-prep package).

use anchor_lang::InstructionData;
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message as TxMsg;
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/validator_registry.so");
const DEFAULT_TIMELOCK: i64 = 3600;

fn pid() -> Pubkey {
    Pubkey::new_from_array(validator_registry::ID.to_bytes())
}
fn registry() -> Pubkey {
    Pubkey::find_program_address(&[b"registry"], &pid()).0
}
fn pending() -> Pubkey {
    Pubkey::find_program_address(&[b"pending"], &pid()).0
}

struct H {
    svm: LiteSVM,
    payer: Keypair,
    owner: Keypair,
}
impl H {
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        // Fresh blockhash per tx so byte-identical txs (e.g. re-queue after
        // cancel) aren't deduped as "AlreadyProcessed".
        self.svm.expire_blockhash();
        let m = TxMsg::new(&[ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(signers, m, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
    }
    fn warp(&mut self, secs: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp += secs;
        self.svm.set_sysvar::<Clock>(&c);
    }
    /// Number of validators currently in the registry account.
    fn validator_count(&self) -> u32 {
        let a = self.svm.get_account(&registry()).expect("registry");
        // 8 disc + 32 owner + 1 threshold, then Vec<[u8;20]> len (u32 LE).
        u32::from_le_bytes(a.data[41..45].try_into().unwrap())
    }
    fn has_validator(&self, v: &[u8; 20]) -> bool {
        let a = self.svm.get_account(&registry()).expect("registry");
        let n = self.validator_count() as usize;
        (0..n).any(|i| &a.data[45 + i * 20..45 + i * 20 + 20] == v)
    }
}

fn queue_ix(owner: &Pubkey, payer: &Pubkey, kind: u8, target: [u8; 20], new_threshold: u8) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(registry(), false),
            AccountMeta::new(pending(), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: validator_registry::instruction::QueueChange {
            kind,
            target,
            replacement: [0u8; 20],
            new_threshold,
        }
        .data(),
    }
}
fn commit_ix(owner_refund: &Pubkey) -> Instruction {
    Instruction {
        program_id: pid(),
        accounts: vec![
            AccountMeta::new(registry(), false),
            AccountMeta::new(pending(), false),
            AccountMeta::new(*owner_refund, false),
        ],
        data: validator_registry::instruction::CommitChange {}.data(),
    }
}

fn setup() -> H {
    let mut svm = LiteSVM::new();
    svm.add_program(pid(), &std::fs::read(SO).expect("build validator_registry"))
        .unwrap();
    let payer = Keypair::new();
    let owner = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    let mut h = H { svm, payer, owner };
    let mut vals: Vec<[u8; 20]> = (1u8..=5).map(|i| [i; 20]).collect();
    vals.sort();
    let p = h.payer.insecure_clone();
    let o = h.owner.insecure_clone();
    h.send(
        Instruction {
            program_id: pid(),
            accounts: vec![
                AccountMeta::new(o.pubkey(), true),
                AccountMeta::new(registry(), false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: validator_registry::instruction::Initialize { validators: vals, threshold: 3 }
                .data(),
        },
        &[&p, &o],
    )
    .expect("init 3-of-5");
    h
}

#[test]
fn timelocked_rotation_hardening() {
    let mut h = setup();
    let p = h.payer.insecure_clone();
    let o = h.owner.insecure_clone();
    let new_val = [9u8; 20];
    assert_eq!(h.validator_count(), 5);

    // queue add (owner) — ok; a second queue while one is pending fails.
    h.send(queue_ix(&o.pubkey(), &p.pubkey(), 0, new_val, 0), &[&p, &o])
        .expect("owner queues add");
    assert!(
        h.send(queue_ix(&o.pubkey(), &p.pubkey(), 0, [8u8; 20], 0), &[&p, &o]).is_err(),
        "only one pending change at a time"
    );

    // commit before eta — blocked.
    assert!(
        h.send(commit_ix(&o.pubkey()), &[&p]).is_err(),
        "commit must be blocked until eta"
    );
    assert_eq!(h.validator_count(), 5, "no change while timelocked");

    // owner cancels — pending cleared, can queue again.
    h.send(
        Instruction {
            program_id: pid(),
            accounts: vec![
                AccountMeta::new(o.pubkey(), true),
                AccountMeta::new_readonly(registry(), false),
                AccountMeta::new(pending(), false),
            ],
            data: validator_registry::instruction::CancelChange {}.data(),
        },
        &[&p, &o],
    )
    .expect("owner cancels");

    // re-queue, warp past eta, then ANYONE can commit.
    h.send(queue_ix(&o.pubkey(), &p.pubkey(), 0, new_val, 0), &[&p, &o])
        .expect("re-queue add");
    h.warp(DEFAULT_TIMELOCK + 10);
    // Permissionless: the fee payer is `p`, NOT the owner — no owner sig.
    h.send(commit_ix(&o.pubkey()), &[&p])
        .expect("permissionless commit after eta");
    assert_eq!(h.validator_count(), 6, "validator added");
    assert!(h.has_validator(&new_val), "the new validator is registered");

    // set_timelock floor.
    let set_tl = |v: i64| Instruction {
        program_id: pid(),
        accounts: vec![
            AccountMeta::new_readonly(o.pubkey(), true),
            AccountMeta::new(registry(), false),
        ],
        data: validator_registry::instruction::SetTimelock { new_timelock: v }.data(),
    };
    assert!(h.send(set_tl(0), &[&p, &o]).is_err(), "timelock floor enforced");
    h.send(set_tl(1), &[&p, &o]).expect("owner lowers timelock to floor");

    // threshold invariant enforced on the post-state at commit:
    // set_threshold(1) on a 6-set ⇒ 2*1 > 6 is false ⇒ commit reverts.
    h.send(queue_ix(&o.pubkey(), &p.pubkey(), 3, [0u8; 20], 1), &[&p, &o])
        .expect("queue set_threshold(1)");
    h.warp(5);
    assert!(
        h.send(commit_ix(&o.pubkey()), &[&p]).is_err(),
        "commit must enforce the threshold invariant on the post-state"
    );
}
