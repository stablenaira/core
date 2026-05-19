import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, beginCell, toNano } from "@ton/core";
import "@ton/test-utils";
import { StableNairaJettonMaster } from "../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";
import { StableNairaJettonWallet } from "../build/StableNairaJettonMaster/tact_StableNairaJettonWallet";

const ROLE_MINTER = 0n;
const ROLE_PAUSER = 1n;
const ROLE_FREEZER = 2n;
const ROLE_SEIZER = 3n;
const EMPTY = beginCell().endCell();
const EMPTY_SLICE = beginCell().endCell().asSlice();

describe("Phase 1 — StableNaira Jetton parity", () => {
  let chain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;
  let master: SandboxContract<StableNairaJettonMaster>;

  const wallet = async (owner: Address) =>
    chain.openContract(await StableNairaJettonWallet.fromInit(owner, master.address));

  const mint = (to: Address, amount: bigint) =>
    master.send(minter.getSender(), { value: toNano("0.2") }, {
      $$type: "Mint",
      to,
      amount,
    });

  beforeEach(async () => {
    chain = await Blockchain.create();
    admin = await chain.treasury("admin");
    minter = await chain.treasury("minter");
    alice = await chain.treasury("alice");
    bob = await chain.treasury("bob");

    master = chain.openContract(
      await StableNairaJettonMaster.fromInit(admin.address, EMPTY, 0n),
    );
    await master.send(admin.getSender(), { value: toNano("0.5") }, EMPTY_SLICE);
    await master.send(admin.getSender(), { value: toNano("0.05") }, {
      $$type: "GrantRole",
      role: ROLE_MINTER,
      account: minter.address,
    });
  });

  it("mint credits a deployed wallet and bumps totalSupply", async () => {
    await mint(alice.address, 100000n); // 1,000 NGN (decimals=2)
    const w = await wallet(alice.address);
    expect(await w.getBalanceValue()).toBe(100000n);
    expect(await master.getTotalSupplyValue()).toBe(100000n);
  });

  it("only MINTER_ROLE can mint", async () => {
    const r = await master.send(alice.getSender(), { value: toNano("0.2") }, {
      $$type: "Mint",
      to: alice.address,
      amount: 5n,
    });
    expect(r.transactions).toHaveTransaction({ to: master.address, success: false });
    expect(await master.getTotalSupplyValue()).toBe(0n);
  });

  it("p2p transfer moves balance between wallets", async () => {
    await mint(alice.address, 100000n);
    const a = await wallet(alice.address);
    await a.send(alice.getSender(), { value: toNano("0.2") }, {
      $$type: "JettonTransfer",
      queryId: 0n,
      amount: 40000n,
      destination: bob.address,
      responseDestination: alice.address,
      customPayload: null,
      forwardTonAmount: 0n,
      forwardPayload: EMPTY_SLICE,
    });
    expect(await a.getBalanceValue()).toBe(60000n);
    expect(await (await wallet(bob.address)).getBalanceValue()).toBe(40000n);
  });

  it("holder burn reduces balance and totalSupply", async () => {
    await mint(alice.address, 100000n);
    const a = await wallet(alice.address);
    await a.send(alice.getSender(), { value: toNano("0.2") }, {
      $$type: "JettonBurn",
      queryId: 0n,
      amount: 25000n,
      responseDestination: alice.address,
      customPayload: null,
    });
    expect(await a.getBalanceValue()).toBe(75000n);
    expect(await master.getTotalSupplyValue()).toBe(75000n);
  });

  it("freeze blocks the frozen account's outbound transfer; unfreeze restores", async () => {
    await mint(alice.address, 100000n);
    const a = await wallet(alice.address);

    await master.send(admin.getSender(), { value: toNano("0.1") }, {
      $$type: "FreezeAccount",
      account: alice.address,
    });
    expect(await a.getIsFrozen()).toBe(true);

    const blocked = await a.send(alice.getSender(), { value: toNano("0.2") }, {
      $$type: "JettonTransfer",
      queryId: 0n,
      amount: 1000n,
      destination: bob.address,
      responseDestination: alice.address,
      customPayload: null,
      forwardTonAmount: 0n,
      forwardPayload: EMPTY_SLICE,
    });
    expect(blocked.transactions).toHaveTransaction({ to: a.address, success: false });
    expect(await a.getBalanceValue()).toBe(100000n);

    await master.send(admin.getSender(), { value: toNano("0.1") }, {
      $$type: "UnfreezeAccount",
      account: alice.address,
    });
    expect(await a.getIsFrozen()).toBe(false);
    await a.send(alice.getSender(), { value: toNano("0.2") }, {
      $$type: "JettonTransfer",
      queryId: 0n,
      amount: 1000n,
      destination: bob.address,
      responseDestination: alice.address,
      customPayload: null,
      forwardTonAmount: 0n,
      forwardPayload: EMPTY_SLICE,
    });
    expect(await a.getBalanceValue()).toBe(99000n);
  });

  it("seize force-moves funds even when the source is frozen (bypasses freeze)", async () => {
    await mint(alice.address, 100000n);
    const a = await wallet(alice.address);
    const b = await wallet(bob.address);

    await master.send(admin.getSender(), { value: toNano("0.1") }, {
      $$type: "FreezeAccount",
      account: alice.address,
    });
    await master.send(admin.getSender(), { value: toNano("0.5") }, {
      $$type: "GrantRole",
      role: ROLE_SEIZER,
      account: admin.address,
    });
    await master.send(admin.getSender(), { value: toNano("0.3") }, {
      $$type: "Seize",
      from: alice.address,
      to: bob.address,
      amount: 30000n,
    });

    expect(await a.getBalanceValue()).toBe(70000n);
    expect(await b.getBalanceValue()).toBe(30000n);
  });

  it("pause blocks mint but p2p transfers stay live (documented EVM divergence)", async () => {
    await mint(alice.address, 100000n);
    await master.send(admin.getSender(), { value: toNano("0.05") }, {
      $$type: "SetPaused",
      paused: true,
    });
    expect(await master.getIsPaused()).toBe(true);

    const mintWhilePaused = await mint(bob.address, 1n);
    expect(mintWhilePaused.transactions).toHaveTransaction({
      to: master.address,
      success: false,
    });

    // p2p still works under pause — the decided divergence
    const a = await wallet(alice.address);
    await a.send(alice.getSender(), { value: toNano("0.2") }, {
      $$type: "JettonTransfer",
      queryId: 0n,
      amount: 5000n,
      destination: bob.address,
      responseDestination: alice.address,
      customPayload: null,
      forwardTonAmount: 0n,
      forwardPayload: EMPTY_SLICE,
    });
    expect(await a.getBalanceValue()).toBe(95000n);
    expect(await (await wallet(bob.address)).getBalanceValue()).toBe(5000n);
  });

  it("mintCap caps total supply", async () => {
    const capped = chain.openContract(
      await StableNairaJettonMaster.fromInit(admin.address, EMPTY, 50000n),
    );
    await capped.send(admin.getSender(), { value: toNano("0.5") }, EMPTY_SLICE);
    await capped.send(admin.getSender(), { value: toNano("0.05") }, {
      $$type: "GrantRole",
      role: ROLE_MINTER,
      account: minter.address,
    });
    await capped.send(minter.getSender(), { value: toNano("0.2") }, {
      $$type: "Mint",
      to: alice.address,
      amount: 50000n,
    });
    const over = await capped.send(minter.getSender(), { value: toNano("0.2") }, {
      $$type: "Mint",
      to: alice.address,
      amount: 1n,
    });
    expect(over.transactions).toHaveTransaction({ to: capped.address, success: false });
    expect(await capped.getTotalSupplyValue()).toBe(50000n);
  });
});
