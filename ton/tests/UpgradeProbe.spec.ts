import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { beginCell, toNano } from "@ton/core";
import "@ton/test-utils";
import { UpgradeProbeV1 } from "../build/UpgradeProbeV1/tact_UpgradeProbeV1";
import { UpgradeProbeV2 } from "../build/UpgradeProbeV1/tact_UpgradeProbeV2";

// Phase 7 — timelocked set_code upgrade (EVM UUPS + timelock parity).

const TL = 3600n;

describe("Phase 7 — timelocked set_code upgrade", () => {
  let chain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let probe: SandboxContract<UpgradeProbeV1>;
  let v2Code: import("@ton/core").Cell;

  beforeEach(async () => {
    chain = await Blockchain.create();
    chain.now = 1_000_000;
    owner = await chain.treasury("owner");
    stranger = await chain.treasury("stranger");
    probe = chain.openContract(await UpgradeProbeV1.fromInit(owner.address));
    await probe.send(owner.getSender(), { value: toNano("0.2") },
      beginCell().endCell().asSlice());
    v2Code = (await UpgradeProbeV2.fromInit(owner.address)).init!.code;
  });

  it("owner queue → wait → permissionless commit swaps the code (v1→v2), storage preserved", async () => {
    expect(await probe.getVersionTag()).toBe(1n);

    await probe.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash: BigInt(`0x${v2Code.hash().toString("hex")}`) });
    expect(await probe.getPendingCodeHash()).toBe(
      BigInt(`0x${v2Code.hash().toString("hex")}`),
    );

    // early commit rejected by timelock
    const early = await probe.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code: v2Code });
    expect(early.transactions).toHaveTransaction({ to: probe.address, success: false });
    expect(await probe.getVersionTag()).toBe(1n);

    chain.now! += Number(TL) + 1;
    // permissionless: a non-owner can commit after eta
    await probe.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code: v2Code });

    const upgraded = chain.openContract(
      UpgradeProbeV2.fromAddress(probe.address),
    );
    expect(await upgraded.getVersionTag()).toBe(2n); // code swapped
    expect(await upgraded.getPendingCodeHash()).toBe(0n); // storage preserved + cleared
    expect((await upgraded.getOwnerAddr()).toString()).toBe(owner.address.toString());
  });

  it("non-owner cannot queue; owner can cancel; wrong code is rejected", async () => {
    const notOwner = await probe.send(stranger.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash: 123n });
    expect(notOwner.transactions).toHaveTransaction({ to: probe.address, success: false });

    await probe.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash: BigInt(`0x${v2Code.hash().toString("hex")}`) });
    await probe.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "CancelUpgrade" });
    expect(await probe.getPendingCodeHash()).toBe(0n);

    // re-queue, then commit with mismatched code
    await probe.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "QueueUpgrade", codeHash: BigInt(`0x${v2Code.hash().toString("hex")}`) });
    chain.now! += Number(TL) + 1;
    const wrong = await probe.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "CommitUpgrade", code: beginCell().storeUint(0xdead, 32).endCell() });
    expect(wrong.transactions).toHaveTransaction({ to: probe.address, success: false });
    expect(await probe.getVersionTag()).toBe(1n);
  });
});
