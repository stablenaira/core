import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { beginCell, toNano } from "@ton/core";
import "@ton/test-utils";
import { ValidatorRegistry } from "../build/ValidatorRegistry/tact_ValidatorRegistry";
import { MultisigVerifier } from "../build/MultisigVerifier/tact_MultisigVerifier";

const TL = 3600n; // timelock seconds
const V1 = 0x1111111111111111111111111111111111111111n;
const V2 = 0x2222222222222222222222222222222222222222n;
const V3 = 0x3333333333333333333333333333333333333333n;
const V4 = 0x4444444444444444444444444444444444444444n;

describe("Phase 2 — ValidatorRegistry timelock + verifier sync", () => {
  let chain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let registry: SandboxContract<ValidatorRegistry>;
  let verifier: SandboxContract<MultisigVerifier>;

  beforeEach(async () => {
    chain = await Blockchain.create();
    chain.now = 1_000_000;
    owner = await chain.treasury("owner");
    stranger = await chain.treasury("stranger");

    registry = chain.openContract(
      await ValidatorRegistry.fromInit(owner.address, TL, TL),
    );
    verifier = chain.openContract(
      await MultisigVerifier.fromInit(registry.address),
    );
    await registry.send(owner.getSender(), { value: toNano("0.1") },
      beginCell().endCell().asSlice());
    await verifier.send(owner.getSender(), { value: toNano("0.1") },
      beginCell().endCell().asSlice());
    await registry.send(owner.getSender(), { value: toNano("0.05") }, {
      $$type: "SetVerifier",
      verifier: verifier.address,
    });
  });

  const bootstrap = async (vs: bigint[], threshold: bigint) => {
    for (const v of vs) {
      await registry.send(owner.getSender(), { value: toNano("0.1") }, {
        $$type: "BootstrapAddValidator",
        validator: v,
      });
    }
    return registry.send(owner.getSender(), { value: toNano("0.1") }, {
      $$type: "BootstrapFinalize",
      threshold,
    });
  };

  it("bootstrap enforces the threshold invariant and syncs the verifier", async () => {
    const bad = await bootstrap([V1, V2, V3], 1n); // 2*1 > 3 is false
    expect(bad.transactions).toHaveTransaction({ to: registry.address, success: false });
    expect(await registry.getIsFinalized()).toBe(false);

    await bootstrap([V1, V2, V3], 2n);
    expect(await registry.getIsFinalized()).toBe(true);
    expect(await registry.getThresholdValue()).toBe(2n);
    expect(await registry.getValidatorCountValue()).toBe(3n);
    // verifier mirror updated via Sync messages
    expect(await verifier.getIsValidator(V1)).toBe(true);
    expect(await verifier.getThresholdValue()).toBe(2n);
  });

  it("queued add is timelocked: commit before eta fails, after eta succeeds (permissionless) and syncs verifier", async () => {
    await bootstrap([V1, V2, V3], 2n);
    await registry.send(owner.getSender(), { value: toNano("0.1") }, {
      $$type: "QueueAddValidator",
      validator: V4,
    });

    const early = await registry.send(stranger.getSender(), { value: toNano("0.1") }, {
      $$type: "CommitChange",
      actionId: 0n,
    });
    expect(early.transactions).toHaveTransaction({ to: registry.address, success: false });
    expect(await registry.getIsValidator(V4)).toBe(false);

    chain.now! += Number(TL) + 1;
    await registry.send(stranger.getSender(), { value: toNano("0.1") }, {
      $$type: "CommitChange",
      actionId: 0n,
    });
    expect(await registry.getIsValidator(V4)).toBe(true);
    expect(await registry.getValidatorCountValue()).toBe(4n);
    expect(await verifier.getIsValidator(V4)).toBe(true);
  });

  it("removal that would break the threshold invariant is rejected at commit", async () => {
    await bootstrap([V1, V2], 2n); // n=2 t=2 (2<=2, 4>2 ok)
    await registry.send(owner.getSender(), { value: toNano("0.1") }, {
      $$type: "QueueRemoveValidator",
      validator: V1,
    });
    chain.now! += Number(TL) + 1;
    const r = await registry.send(stranger.getSender(), { value: toNano("0.1") }, {
      $$type: "CommitChange",
      actionId: 0n,
    });
    // n would become 1, validate(t=2,n=1) -> revert
    expect(r.transactions).toHaveTransaction({ to: registry.address, success: false });
    expect(await registry.getValidatorCountValue()).toBe(2n);
    expect(await registry.getIsValidator(V1)).toBe(true);
  });

  it("setThreshold via queue/commit updates registry and verifier", async () => {
    await bootstrap([V1, V2, V3], 2n);
    await registry.send(owner.getSender(), { value: toNano("0.1") }, {
      $$type: "QueueSetThreshold",
      newThreshold: 3n,
    });
    chain.now! += Number(TL) + 1;
    await registry.send(stranger.getSender(), { value: toNano("0.1") }, {
      $$type: "CommitChange",
      actionId: 0n,
    });
    expect(await registry.getThresholdValue()).toBe(3n);
    expect(await verifier.getThresholdValue()).toBe(3n);
  });

  it("owner can cancel a queued change before commit", async () => {
    await bootstrap([V1, V2, V3], 2n);
    await registry.send(owner.getSender(), { value: toNano("0.1") }, {
      $$type: "QueueAddValidator",
      validator: V4,
    });
    await registry.send(owner.getSender(), { value: toNano("0.1") }, {
      $$type: "CancelChange",
      actionId: 0n,
    });
    chain.now! += Number(TL) + 1;
    const r = await registry.send(stranger.getSender(), { value: toNano("0.1") }, {
      $$type: "CommitChange",
      actionId: 0n,
    });
    expect(r.transactions).toHaveTransaction({ to: registry.address, success: false });
    expect(await registry.getIsValidator(V4)).toBe(false);
  });

  it("only owner can queue", async () => {
    await bootstrap([V1, V2, V3], 2n);
    const r = await registry.send(stranger.getSender(), { value: toNano("0.1") }, {
      $$type: "QueueAddValidator",
      validator: V4,
    });
    expect(r.transactions).toHaveTransaction({ to: registry.address, success: false });
  });
});
