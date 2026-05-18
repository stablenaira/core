import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { deployValidatorRegistry } from "./helpers/fixtures";

const ZERO = "0x0000000000000000000000000000000000000000";

enum ChangeKind {
  AddValidator = 0,
  RemoveValidator = 1,
  ReplaceValidator = 2,
  SetThreshold = 3,
}

describe("ValidatorRegistry", () => {
  async function fixture() {
    const [owner, v2, v3, v4, alice] = await ethers.getSigners();
    const { validatorRegistry, impl, proxy } = await deployValidatorRegistry(
      [owner.address, v2.address, v3.address],
      2n,
      owner.address
    );
    return { validatorRegistry, impl, proxy, owner, v2, v3, v4, alice };
  }

  async function singleFixture() {
    const [owner, alice] = await ethers.getSigners();
    const { validatorRegistry } = await deployValidatorRegistry([owner.address], 1n, owner.address);
    return { validatorRegistry, owner, alice };
  }

  async function lastQueuedActionId(receipt: any): Promise<bigint> {
    const evt = receipt.logs.find((l: any) => l.fragment?.name === "ActionQueued") as any;
    return evt.args.actionId as bigint;
  }

  describe("initialization", () => {
    it("seeds the validator set, threshold, owner, and timelock", async () => {
      const { validatorRegistry, owner, v2, v3 } = await loadFixture(fixture);
      expect(await validatorRegistry.threshold()).to.equal(2n);
      expect(await validatorRegistry.validatorCount()).to.equal(3n);
      expect(await validatorRegistry.isValidator(owner.address)).to.equal(true);
      expect(await validatorRegistry.isValidator(v2.address)).to.equal(true);
      expect(await validatorRegistry.isValidator(v3.address)).to.equal(true);
      expect(await validatorRegistry.owner()).to.equal(owner.address);
      expect(await validatorRegistry.timelock()).to.equal(3600n);
      expect(await validatorRegistry.minTimelock()).to.equal(3600n);
    });

    it("rejects invalid initial threshold", async () => {
      const [owner, v2, v3] = await ethers.getSigners();
      // threshold = 0 invalid
      await expect(
        deployValidatorRegistry([owner.address], 0n, owner.address)
      ).to.be.reverted;
      // threshold > count invalid (1 validator, threshold 2)
      await expect(
        deployValidatorRegistry([owner.address], 2n, owner.address)
      ).to.be.reverted;
      // 3 validators, threshold 1: 2*1 > 3 false → not majority
      await expect(
        deployValidatorRegistry([owner.address, v2.address, v3.address], 1n, owner.address)
      ).to.be.reverted;
    });
  });

  describe("queue / commit: add validator", () => {
    it("owner queues, anyone commits after eta", async () => {
      const { validatorRegistry, owner, v4 } = await loadFixture(fixture);
      const tx = await validatorRegistry.connect(owner).queueAddValidator(v4.address);
      const receipt = await tx.wait();
      const actionId = await lastQueuedActionId(receipt);

      // Before eta -> reverts.
      await expect(
        validatorRegistry.connect(owner).commitValidatorChange(actionId)
      ).to.be.revertedWithCustomError(validatorRegistry, "ActionNotReady");

      await time.increase(3600 + 1);
      await expect(validatorRegistry.commitValidatorChange(actionId))
        .to.emit(validatorRegistry, "ValidatorAdded")
        .withArgs(v4.address);

      expect(await validatorRegistry.isValidator(v4.address)).to.equal(true);
      expect(await validatorRegistry.validatorCount()).to.equal(4n);
    });

    it("non-owner cannot queue", async () => {
      const { validatorRegistry, alice, v4 } = await loadFixture(fixture);
      await expect(
        validatorRegistry.connect(alice).queueAddValidator(v4.address)
      ).to.be.revertedWithCustomError(validatorRegistry, "OwnableUnauthorizedAccount");
    });

    it("rejects zero address and existing validator", async () => {
      const { validatorRegistry, owner } = await loadFixture(fixture);
      await expect(
        validatorRegistry.connect(owner).queueAddValidator(ZERO)
      ).to.be.revertedWithCustomError(validatorRegistry, "ZeroAddressValidator");
      await expect(
        validatorRegistry.connect(owner).queueAddValidator(owner.address)
      ).to.be.revertedWithCustomError(validatorRegistry, "ValidatorAlreadyExists");
    });
  });

  describe("queue / commit: remove validator", () => {
    it("rejects committing a remove that breaks threshold invariant", async () => {
      // 3 validators, threshold = 2. Remove one -> 2 validators, threshold 2.
      // 2*2 > 2 -> true, valid. So this *should* succeed. Make it invalid by lowering count further.
      const { validatorRegistry, owner, v2, v3 } = await loadFixture(fixture);
      // First remove v2 (allowed, 2*2 > 2 valid).
      let tx = await validatorRegistry.connect(owner).queueRemoveValidator(v2.address);
      let actionId = await lastQueuedActionId(await tx.wait());
      await time.increase(3600 + 1);
      await validatorRegistry.commitValidatorChange(actionId);
      expect(await validatorRegistry.validatorCount()).to.equal(2n);

      // Now try to remove v3 -> would leave 1 validator, threshold 2 -> invalid.
      tx = await validatorRegistry.connect(owner).queueRemoveValidator(v3.address);
      actionId = await lastQueuedActionId(await tx.wait());
      await time.increase(3600 + 1);
      await expect(
        validatorRegistry.commitValidatorChange(actionId)
      ).to.be.revertedWithCustomError(validatorRegistry, "InvalidThreshold");
    });

    it("rejects queueing remove for non-validator", async () => {
      const { validatorRegistry, owner, alice } = await loadFixture(fixture);
      await expect(
        validatorRegistry.connect(owner).queueRemoveValidator(alice.address)
      ).to.be.revertedWithCustomError(validatorRegistry, "ValidatorNotFound");
    });
  });

  describe("queue / commit: replace validator", () => {
    it("swaps oldValidator for newValidator on commit", async () => {
      const { validatorRegistry, owner, v3, v4 } = await loadFixture(fixture);
      const tx = await validatorRegistry.connect(owner).queueReplaceValidator(v3.address, v4.address);
      const actionId = await lastQueuedActionId(await tx.wait());
      await time.increase(3600 + 1);
      await validatorRegistry.commitValidatorChange(actionId);
      expect(await validatorRegistry.isValidator(v3.address)).to.equal(false);
      expect(await validatorRegistry.isValidator(v4.address)).to.equal(true);
      expect(await validatorRegistry.validatorCount()).to.equal(3n);
    });

    it("rejects replace where new == existing or old missing", async () => {
      const { validatorRegistry, owner, v2, alice } = await loadFixture(fixture);
      // new already a validator
      await expect(
        validatorRegistry.connect(owner).queueReplaceValidator(v2.address, owner.address)
      ).to.be.revertedWithCustomError(validatorRegistry, "ValidatorAlreadyExists");
      // old not a validator
      await expect(
        validatorRegistry.connect(owner).queueReplaceValidator(alice.address, alice.address)
      ).to.be.revertedWithCustomError(validatorRegistry, "ValidatorNotFound");
    });
  });

  describe("queue / commit: set threshold", () => {
    it("commit validates threshold against current set size", async () => {
      const { validatorRegistry, owner } = await loadFixture(fixture);
      // 3 validators currently. Try to set threshold = 1 (not majority).
      const tx = await validatorRegistry.connect(owner).queueSetThreshold(1n);
      const actionId = await lastQueuedActionId(await tx.wait());
      await time.increase(3600 + 1);
      await expect(
        validatorRegistry.commitValidatorChange(actionId)
      ).to.be.revertedWithCustomError(validatorRegistry, "InvalidThreshold");

      // Threshold = 3 (full unanimity) with 3 validators -> valid (2*3 > 3).
      const tx2 = await validatorRegistry.connect(owner).queueSetThreshold(3n);
      const actionId2 = await lastQueuedActionId(await tx2.wait());
      await time.increase(3600 + 1);
      await validatorRegistry.commitValidatorChange(actionId2);
      expect(await validatorRegistry.threshold()).to.equal(3n);
    });
  });

  describe("cancel", () => {
    it("owner can cancel any queued action", async () => {
      const { validatorRegistry, owner, v4 } = await loadFixture(fixture);
      const tx = await validatorRegistry.connect(owner).queueAddValidator(v4.address);
      const actionId = await lastQueuedActionId(await tx.wait());
      await validatorRegistry.connect(owner).cancel(actionId);
      await time.increase(3600 + 1);
      await expect(
        validatorRegistry.commitValidatorChange(actionId)
      ).to.be.revertedWithCustomError(validatorRegistry, "ActionNotFound");
    });
  });

  describe("upgrade", () => {
    it("queue + commit succeeds via timelock", async () => {
      const { validatorRegistry, owner } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("ValidatorRegistry");
      const newImpl = await Impl.deploy();
      const newAddr = await newImpl.getAddress();

      const tx = await validatorRegistry.connect(owner).queueUpgrade(newAddr, "0x");
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) => l.fragment?.name === "UpgradeQueued") as any;
      const actionId = evt.args.actionId as bigint;

      await expect(
        validatorRegistry.commitUpgrade(actionId, newAddr, "0x")
      ).to.be.revertedWithCustomError(validatorRegistry, "ActionNotReady");
      await time.increase(3600 + 1);
      await validatorRegistry.commitUpgrade(actionId, newAddr, "0x");
    });

    it("direct upgradeToAndCall reverts", async () => {
      const { validatorRegistry, owner } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("ValidatorRegistry");
      const newImpl = await Impl.deploy();
      await expect(
        validatorRegistry.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(validatorRegistry, "UpgradeNotAuthorized");
    });
  });

  describe("timelock setters", () => {
    it("min/timelock cannot drop below 1h floor", async () => {
      const { validatorRegistry, owner } = await loadFixture(fixture);
      await expect(
        validatorRegistry.connect(owner).setMinTimelock(60n)
      ).to.be.revertedWithCustomError(validatorRegistry, "TimelockBelowFloor");
      await expect(
        validatorRegistry.connect(owner).setTimelock(60n)
      ).to.be.revertedWithCustomError(validatorRegistry, "TimelockBelowMin");
    });

    it("setMinTimelock raises timelock if below new floor", async () => {
      const { validatorRegistry, owner } = await loadFixture(fixture);
      await validatorRegistry.connect(owner).setMinTimelock(7200n);
      expect(await validatorRegistry.minTimelock()).to.equal(7200n);
      expect(await validatorRegistry.timelock()).to.equal(7200n);
    });
  });

  describe("singleton fixture (1-of-1)", () => {
    it("init with single validator and threshold 1 holds invariant 2*1 > 1", async () => {
      const { validatorRegistry, owner } = await loadFixture(singleFixture);
      expect(await validatorRegistry.threshold()).to.equal(1n);
      expect(await validatorRegistry.validatorCount()).to.equal(1n);
      expect(await validatorRegistry.isValidator(owner.address)).to.equal(true);
    });
  });
});
