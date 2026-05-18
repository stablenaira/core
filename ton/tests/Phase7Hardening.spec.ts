import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { beginCell, toNano } from "@ton/core";
import "@ton/test-utils";
import { MessageTransmitter } from "../build/MessageTransmitter/tact_MessageTransmitter";
import { StableNairaJettonMaster } from "../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";
import { TokenMessenger } from "../build/TokenMessenger/tact_TokenMessenger";

const TL = 3600n;
const EMPTY_SLICE = beginCell().endCell().asSlice();

describe("Phase 7 — hardening", () => {
  let chain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;

  beforeEach(async () => {
    chain = await Blockchain.create();
    chain.now = 1_000_000;
    owner = await chain.treasury("owner");
    stranger = await chain.treasury("stranger");
  });

  it("MessageTransmitter has the timelocked set_code upgrade wired (owner/timelock/hash gated)", async () => {
    const mt = chain.openContract(
      await MessageTransmitter.fromInit(owner.address, 1_000_001n, 1_000_001n, 0xabcn, 256n),
    );
    await mt.send(owner.getSender(), { value: toNano("0.2") }, EMPTY_SLICE);
    const selfCode = (await MessageTransmitter.fromInit(
      owner.address, 1_000_001n, 1_000_001n, 0xabcn, 256n,
    )).init!.code;
    const codeHash = BigInt(`0x${selfCode.hash().toString("hex")}`);

    // non-owner cannot queue
    const bad = await mt.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash });
    expect(bad.transactions).toHaveTransaction({ to: mt.address, success: false });

    await mt.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash });
    expect(await mt.getUpgradePendingHash()).toBe(codeHash);

    // early commit blocked by timelock
    const early = await mt.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code: selfCode });
    expect(early.transactions).toHaveTransaction({ to: mt.address, success: false });

    // cancel + re-queue + commit after eta (self-code = no-op swap)
    await mt.send(owner.getSender(), { value: toNano("0.05") }, { $$type: "CancelUpgrade" });
    expect(await mt.getUpgradePendingHash()).toBe(0n);
    await mt.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash });
    chain.now! += Number(TL) + 1;
    await mt.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code: selfCode });

    expect(await mt.getUpgradePendingHash()).toBe(0n);
    expect(await mt.getVersionValue()).toBe(1n); // still operational post-swap
    expect(await mt.getLocalDomainValue()).toBe(1_000_001n);
  });

  it("TokenMessenger CancelIntent reaps an intent leaked by a downstream burn failure", async () => {
    const admin = owner;
    const jetton = chain.openContract(
      await StableNairaJettonMaster.fromInit(admin.address, beginCell().endCell(), 0n),
    );
    await jetton.send(admin.getSender(), { value: toNano("0.3") }, EMPTY_SLICE);
    const tm = chain.openContract(
      await TokenMessenger.fromInit(
        admin.address, stranger.address, jetton.address, 0n, admin.address,
      ),
    );
    await tm.send(admin.getSender(), { value: toNano("0.3") }, EMPTY_SLICE);
    for (const acct of [tm.address, admin.address]) {
      await jetton.send(admin.getSender(), { value: toNano("0.05") },
        { $$type: "GrantRole", role: 0n, account: acct });
    }
    await jetton.send(admin.getSender(), { value: toNano("0.2") },
      { $$type: "Mint", to: stranger.address, amount: 50_000n });
    await tm.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "SetRemoteRouter", domain: 99n, router: 0x1234n });

    // freeze the depositor so the burn fails downstream (master→wallet),
    // leaving the intent leaked (documented Phase 4 limitation)
    await jetton.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "GrantRole", role: 2n, account: admin.address });
    await jetton.send(admin.getSender(), { value: toNano("0.1") },
      { $$type: "FreezeAccount", account: stranger.address });

    await tm.send(stranger.getSender(), { value: toNano("0.6") }, {
      $$type: "DepositForBurn",
      amount: 10_000n,
      destinationDomain: 99n,
      mintRecipient: 0xbeefn,
      destinationCaller: 0n,
    });
    expect(await tm.getHasIntent(0n)).toBe(true); // leaked
    expect(await jetton.getTotalSupplyValue()).toBe(50_000n); // nothing burned

    // non-owner cannot reap
    const bad = await tm.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CancelIntent", opId: 0n });
    expect(bad.transactions).toHaveTransaction({ to: tm.address, success: false });

    await tm.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "CancelIntent", opId: 0n });
    expect(await tm.getHasIntent(0n)).toBe(false); // reaped
  });
});
