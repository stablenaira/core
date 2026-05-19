import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { beginCell, toNano } from "@ton/core";
import "@ton/test-utils";
import { StableNairaJettonMaster } from "../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";
import { StableNairaJettonWallet } from "../build/StableNairaJettonMaster/tact_StableNairaJettonWallet";
import { ValidatorRegistry } from "../build/ValidatorRegistry/tact_ValidatorRegistry";
import { TokenMessenger } from "../build/TokenMessenger/tact_TokenMessenger";

const TL = 3600n;
const EMPTY = beginCell().endCell();
const EMPTY_SLICE = beginCell().endCell().asSlice();
const hashOf = (c: { hash(): Buffer }) => BigInt(`0x${c.hash().toString("hex")}`);

describe("Phase 7 rollout — set_code upgrade across the stack", () => {
  let chain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;

  beforeEach(async () => {
    chain = await Blockchain.create();
    chain.now = 1_000_000;
    owner = await chain.treasury("owner");
    stranger = await chain.treasury("stranger");
  });

  it("Jetton master self-upgrade is owner+timelock+hash gated", async () => {
    const jetton = chain.openContract(
      await StableNairaJettonMaster.fromInit(owner.address, EMPTY, 0n),
    );
    await jetton.send(owner.getSender(), { value: toNano("0.3") }, EMPTY_SLICE);
    const code = (await StableNairaJettonMaster.fromInit(owner.address, EMPTY, 0n)).init!.code;
    const codeHash = hashOf(code);

    const bad = await jetton.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash });
    expect(bad.transactions).toHaveTransaction({ to: jetton.address, success: false });

    await jetton.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash });
    const early = await jetton.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code });
    expect(early.transactions).toHaveTransaction({ to: jetton.address, success: false });

    chain.now! += Number(TL) + 1;
    await jetton.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code });
    expect(await jetton.getUpgradePendingHash()).toBe(0n);
    expect(await jetton.getTotalSupplyValue()).toBe(0n); // still operational
  });

  it("master-governed wallet-code upgrade: timelocked bless, blessed-only push, master-authenticated swap, balance preserved", async () => {
    const jetton = chain.openContract(
      await StableNairaJettonMaster.fromInit(owner.address, EMPTY, 0n),
    );
    await jetton.send(owner.getSender(), { value: toNano("0.3") }, EMPTY_SLICE);
    const minter = await chain.treasury("minter");
    await jetton.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "GrantRole", role: 0n, account: minter.address });
    await jetton.send(minter.getSender(), { value: toNano("0.2") },
      { $$type: "Mint", to: stranger.address, amount: 70_000n });
    const w = chain.openContract(
      await StableNairaJettonWallet.fromInit(stranger.address, jetton.address),
    );
    const walletCode = w.init!.code;
    const wHash = hashOf(walletCode);

    // non-admin cannot queue the wallet upgrade
    const bad = await jetton.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "QueueWalletUpgrade", codeHash: wHash });
    expect(bad.transactions).toHaveTransaction({ to: jetton.address, success: false });

    await jetton.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueWalletUpgrade", codeHash: wHash });
    const early = await jetton.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "CommitWalletUpgrade", code: walletCode });
    expect(early.transactions).toHaveTransaction({ to: jetton.address, success: false });

    chain.now! += Number(TL) + 1;
    await jetton.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "CommitWalletUpgrade", code: walletCode });
    expect(await jetton.getBlessedWalletHash()).toBe(wHash);

    // push with non-blessed code is rejected
    const wrong = await jetton.send(owner.getSender(), { value: toNano("0.1") }, {
      $$type: "PushWalletUpgrade",
      wallet: w.address,
      code: beginCell().storeUint(0xdead, 32).endCell(),
    });
    expect(wrong.transactions).toHaveTransaction({ to: jetton.address, success: false });

    // non-admin cannot push
    const notAdmin = await jetton.send(stranger.getSender(), { value: toNano("0.1") },
      { $$type: "PushWalletUpgrade", wallet: w.address, code: walletCode });
    expect(notAdmin.transactions).toHaveTransaction({ to: jetton.address, success: false });

    // a stranger cannot directly swap a wallet's code (master-only)
    const direct = await w.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "UpgradeWalletCode", code: walletCode });
    expect(direct.transactions).toHaveTransaction({ to: w.address, success: false });

    // admin pushes the blessed code → wallet set_code (no-op self), balance kept
    await jetton.send(owner.getSender(), { value: toNano("0.15") },
      { $$type: "PushWalletUpgrade", wallet: w.address, code: walletCode });
    expect(await w.getBalanceValue()).toBe(70_000n);
  });

  it("ValidatorRegistry self-upgrade is owner+timelock gated", async () => {
    const reg = chain.openContract(
      await ValidatorRegistry.fromInit(owner.address, TL, TL),
    );
    await reg.send(owner.getSender(), { value: toNano("0.2") }, EMPTY_SLICE);
    const code = (await ValidatorRegistry.fromInit(owner.address, TL, TL)).init!.code;

    const bad = await reg.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash: hashOf(code) });
    expect(bad.transactions).toHaveTransaction({ to: reg.address, success: false });

    await reg.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash: hashOf(code) });
    const early = await reg.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code });
    expect(early.transactions).toHaveTransaction({ to: reg.address, success: false });

    chain.now! += Number(TL) + 1;
    await reg.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code });
    expect(await reg.getUpgradePendingHash()).toBe(0n);
    expect((await reg.getOwnerAddress()).toString()).toBe(owner.address.toString());
  });

  it("TokenMessenger self-upgrade is owner+timelock gated", async () => {
    const tm = chain.openContract(
      await TokenMessenger.fromInit(owner.address, owner.address, owner.address, 0n, owner.address),
    );
    await tm.send(owner.getSender(), { value: toNano("0.2") }, EMPTY_SLICE);
    const code = (await TokenMessenger.fromInit(
      owner.address, owner.address, owner.address, 0n, owner.address,
    )).init!.code;

    await tm.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash: hashOf(code) });
    const early = await tm.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code });
    expect(early.transactions).toHaveTransaction({ to: tm.address, success: false });

    chain.now! += Number(TL) + 1;
    await tm.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code });
    expect(await tm.getUpgradePendingHash()).toBe(0n);
    expect(await tm.getBodyVersionValue()).toBe(1n); // still operational
  });
});
