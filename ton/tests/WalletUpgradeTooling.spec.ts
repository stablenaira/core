import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, Cell, beginCell, toNano } from "@ton/core";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import "@ton/test-utils";
import { StableNairaJettonMaster } from "../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";
import { StableNairaJettonWallet } from "../build/StableNairaJettonMaster/tact_StableNairaJettonWallet";
import { ProgressStore } from "../scripts/wallet-upgrade/progress";
import {
  bless,
  runPush,
  supplyInvariantHolds,
  RolloutError,
  type UpgradeNetwork,
} from "../scripts/wallet-upgrade/orchestrator";
import {
  queueWalletUpgradeBody,
  commitWalletUpgradeBody,
  pushWalletUpgradeBody,
} from "../scripts/wallet-upgrade/messages";

const EMPTY = beginCell().endCell();
const EMPTY_SLICE = beginCell().endCell().asSlice();

describe("Phase 7 tooling — ton-wallet-upgrade orchestrator", () => {
  let chain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<TreasuryContract>;
  let jetton: SandboxContract<StableNairaJettonMaster>;
  let owners: Address[];
  let walletAddrs: Address[];
  let walletCode: Cell;

  const net = (): UpgradeNetwork => ({
    blessedHash: async () => await jetton.getBlessedWalletHash(),
    queueWalletUpgrade: async (codeHash) => {
      await jetton.send(admin.getSender(), { value: toNano("0.05") },
        { $$type: "QueueWalletUpgrade", codeHash });
    },
    commitWalletUpgrade: async (code) => {
      await jetton.send(admin.getSender(), { value: toNano("0.05") },
        { $$type: "CommitWalletUpgrade", code });
    },
    pushWalletUpgrade: async (wallet, code) => {
      await jetton.send(admin.getSender(), { value: toNano("0.15") },
        { $$type: "PushWalletUpgrade", wallet, code });
    },
    walletBalance: async (wallet) =>
      await chain.openContract(StableNairaJettonWallet.fromAddress(wallet))
        .getBalanceValue(),
    totalSupply: async () => await jetton.getTotalSupplyValue(),
    advanceTimelock: async () => { chain.now! += 3601; },
  });

  beforeEach(async () => {
    chain = await Blockchain.create();
    chain.now = 1_000_000;
    admin = await chain.treasury("admin");
    minter = await chain.treasury("minter");
    jetton = chain.openContract(
      await StableNairaJettonMaster.fromInit(admin.address, EMPTY, 0n),
    );
    await jetton.send(admin.getSender(), { value: toNano("0.3") }, EMPTY_SLICE);
    await jetton.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "GrantRole", role: 0n, account: minter.address });

    owners = [];
    walletAddrs = [];
    for (const name of ["u1", "u2", "u3"]) {
      const t = await chain.treasury(name);
      owners.push(t.address);
      await jetton.send(minter.getSender(), { value: toNano("0.2") },
        { $$type: "Mint", to: t.address, amount: 10_000n });
      const w = await StableNairaJettonWallet.fromInit(t.address, jetton.address);
      walletAddrs.push(w.address);
      walletCode = w.init!.code; // identical code cell across wallets
    }
  });

  it("bless → batched push: all wallets upgraded, balances + supply preserved, idempotent + resumable", async () => {
    const n = net();
    const supply0 = await n.totalSupply();
    const store = new ProgressStore();
    store.seed(walletAddrs.map((a) => a.toString()));

    await bless(n, walletCode);
    expect(await n.blessedHash()).toBe(
      BigInt(`0x${walletCode.hash().toString("hex")}`),
    );

    const rep = await runPush(n, store, walletCode, {
      batchSize: 2,
      toAddress: (s) => Address.parse(s),
    });
    expect(rep.pushed).toBe(3);
    expect(rep.upgraded).toBe(3);
    expect(rep.pending).toBe(0);
    for (const a of walletAddrs) {
      expect(
        await chain.openContract(StableNairaJettonWallet.fromAddress(a)).getBalanceValue(),
      ).toBe(10_000n);
    }
    expect(await supplyInvariantHolds(n, supply0)).toBe(true);

    // idempotent: re-run pushes nothing
    const again = await runPush(n, store, walletCode, {
      batchSize: 2,
      toAddress: (s) => Address.parse(s),
    });
    expect(again.pushed).toBe(0);
    expect(again.upgraded).toBe(3);
  });

  it("resumes from a partial progress store (only pending wallets pushed)", async () => {
    const n = net();
    await bless(n, walletCode);
    const store = new ProgressStore();
    store.seed(walletAddrs.map((a) => a.toString()));
    store.markUpgraded(walletAddrs[0]!.toString()); // pretend one already done

    const rep = await runPush(n, store, walletCode, {
      batchSize: 50,
      toAddress: (s) => Address.parse(s),
    });
    expect(rep.pushed).toBe(2);
    expect(rep.upgraded).toBe(3);
  });

  it("refuses to push unblessed code; bless fails on hash mismatch", async () => {
    const n = net();
    const store = new ProgressStore();
    store.seed(walletAddrs.map((a) => a.toString()));

    // never blessed → runPush must refuse
    await expect(
      runPush(n, store, walletCode, { batchSize: 2, toAddress: (s) => Address.parse(s) }),
    ).rejects.toBeInstanceOf(RolloutError);

    // orchestrator guard: if commit silently fails (master never blesses the
    // hash), bless() must throw rather than proceed to push.
    const brokenCommit: UpgradeNetwork = { ...n, commitWalletUpgrade: async () => {} };
    await expect(bless(brokenCommit, walletCode)).rejects.toBeInstanceOf(RolloutError);
    expect(await n.blessedHash()).toBe(0n);
  });

  it("progress store persists to disk and reloads", () => {
    const path = join(tmpdir(), `wu-${Date.now()}.json`);
    try {
      const s1 = new ProgressStore(path);
      s1.seed(["a", "b", "c"]);
      s1.markUpgraded("b");
      const s2 = new ProgressStore(path);
      expect(s2.stats()).toEqual({ total: 3, upgraded: 1, pending: 2 });
      expect(s2.pending().sort()).toEqual(["a", "c"]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("production message builders carry the contract opcodes", () => {
    expect(queueWalletUpgradeBody(123n).beginParse().loadUint(32)).toBe(0x55504710);
    expect(commitWalletUpgradeBody(walletCode).beginParse().loadUint(32)).toBe(0x55504711);
    expect(
      pushWalletUpgradeBody(walletAddrs[0]!, walletCode).beginParse().loadUint(32),
    ).toBe(0x55504713);
  });
});
