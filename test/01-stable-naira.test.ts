import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
  setBalance,
} from "@nomicfoundation/hardhat-network-helpers";

import {
  deployStableNaira,
  registerBridge,
  treasuryMint,
  BRIDGE_CAPACITY,
  BRIDGE_PERIOD,
} from "./helpers/fixtures";

const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_HOUR = 3600n;

/** Pulls `actionId` out of the named event on a queue transaction. */
async function queuedId(tx: any, eventName: string): Promise<bigint> {
  const receipt = await tx.wait();
  const ev = receipt!.logs.find(
    (l: any) => l.fragment?.name === eventName,
  ) as any;
  return ev.args.actionId as bigint;
}

describe("StableNaira", () => {
  async function fixture() {
    const [admin, alice, bob, charlie, mallory] = await ethers.getSigners();
    const { stableNaira, factory, implementation, proxy } =
      await deployStableNaira(admin.address);

    // A contract address to stand in for a bridge (BRIDGE_ROLE rejects EOAs).
    const Probe = await ethers.getContractFactory("StableNairaUUPSDeployer");
    const bridge = await Probe.deploy();
    await bridge.waitForDeployment();

    return {
      stableNaira,
      factory,
      implementation,
      proxy,
      bridge: await bridge.getAddress(),
      admin,
      alice,
      bob,
      charlie,
      mallory,
    };
  }

  describe("initialization", () => {
    it("sets metadata, decimals, and version", async () => {
      const { stableNaira } = await loadFixture(fixture);
      expect(await stableNaira.name()).to.equal("StableNaira");
      expect(await stableNaira.symbol()).to.equal("SNR");
      expect(await stableNaira.decimals()).to.equal(2);
      expect(await stableNaira.VERSION()).to.equal("2.0");
    });

    it("grants admin the default roles and sets owner()", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const DEFAULT_ADMIN_ROLE = await stableNaira.DEFAULT_ADMIN_ROLE();
      expect(
        await stableNaira.hasRole(DEFAULT_ADMIN_ROLE, admin.address),
      ).to.equal(true);
      expect(await stableNaira.minters(admin.address)).to.equal(true);
      expect(await stableNaira.pausers(admin.address)).to.equal(true);
      expect(await stableNaira.freezers(admin.address)).to.equal(true);
      expect(await stableNaira.seizers(admin.address)).to.equal(true);
      expect(await stableNaira.owner()).to.equal(admin.address);
    });

    it("does NOT grant BRIDGE_ROLE to the admin", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      // BRIDGE_ROLE carries a synchronous mint path; an EOA must never hold it.
      expect(await stableNaira.bridges(admin.address)).to.equal(false);
      await expect(
        stableNaira.connect(admin).mint(admin.address, 1n),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("starts unpaused with zero supply, uncapped mint, 1-hour timelock", async () => {
      const { stableNaira } = await loadFixture(fixture);
      expect(await stableNaira.paused()).to.equal(false);
      expect(await stableNaira.totalSupply()).to.equal(0n);
      expect(await stableNaira.mintCap()).to.equal(0n);
      expect(await stableNaira.timelock()).to.equal(ONE_HOUR);
      expect(await stableNaira.minTimelock()).to.equal(ONE_HOUR);
      expect(await stableNaira.MIN_FLOOR_TIMELOCK()).to.equal(ONE_HOUR);
    });

    it("re-initialize on the proxy reverts (locked)", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      await expect(
        stableNaira.initialize("X", "X", admin.address),
      ).to.be.revertedWithCustomError(stableNaira, "InvalidInitialization");
    });
  });

  describe("role management", () => {
    it("admin can add and remove minter", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).addMinter(alice.address);
      expect(await stableNaira.minters(alice.address)).to.equal(true);
      await stableNaira.connect(admin).removeMinter(alice.address);
      expect(await stableNaira.minters(alice.address)).to.equal(false);
    });

    it("non-admin cannot add minter", async () => {
      const { stableNaira, alice, bob } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(alice).addMinter(bob.address),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("rejects the zero address at the _grantRole level", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(admin).addMinter(ZERO),
      ).to.be.revertedWithCustomError(stableNaira, "ZeroAddress");
      // ...and via inherited grantRole, which used to bypass the wrapper check.
      const MINTER_ROLE = await stableNaira.MINTER_ROLE();
      await expect(
        stableNaira.connect(admin).grantRole(MINTER_ROLE, ZERO),
      ).to.be.revertedWithCustomError(stableNaira, "ZeroAddress");
    });

    it("admin can manage pauser/freezer/seizer roles symmetrically", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).addPauser(alice.address);
      await stableNaira.connect(admin).addFreezer(alice.address);
      await stableNaira.connect(admin).addSeizer(alice.address);
      expect(await stableNaira.pausers(alice.address)).to.equal(true);
      expect(await stableNaira.freezers(alice.address)).to.equal(true);
      expect(await stableNaira.seizers(alice.address)).to.equal(true);

      await stableNaira.connect(admin).removePauser(alice.address);
      await stableNaira.connect(admin).removeFreezer(alice.address);
      await stableNaira.connect(admin).removeSeizer(alice.address);
      expect(await stableNaira.pausers(alice.address)).to.equal(false);
    });

    it("the last admin cannot renounce or be revoked (anti-brick)", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      const DA = await stableNaira.DEFAULT_ADMIN_ROLE();

      await expect(
        stableNaira.connect(admin).renounceRole(DA, admin.address),
      ).to.be.revertedWithCustomError(stableNaira, "LastAdminProtected");
      await expect(
        stableNaira.connect(admin).revokeRole(DA, admin.address),
      ).to.be.revertedWithCustomError(stableNaira, "LastAdminProtected");

      // With a second admin in place, handover is allowed.
      await stableNaira.connect(admin).grantRole(DA, alice.address);
      await stableNaira.connect(admin).renounceRole(DA, admin.address);
      expect(await stableNaira.getRoleMemberCount(DA)).to.equal(1n);
      expect(await stableNaira.owner()).to.equal(alice.address);
    });

    it("owner() returns zero rather than reverting when not exactly one admin", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      const DA = await stableNaira.DEFAULT_ADMIN_ROLE();
      await stableNaira.connect(admin).grantRole(DA, alice.address);
      expect(await stableNaira.owner()).to.equal(ZERO);
    });
  });

  describe("timelock administration", () => {
    it("queues a timelock change and commits it after the delay", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).setTimelock(86400),
        "ActionQueued",
      );

      expect(await stableNaira.timelock()).to.equal(ONE_HOUR);
      await expect(
        stableNaira.connect(admin).commitSetTimelock(id, 86400n),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotReady");

      await time.increase(Number(ONE_HOUR) + 1);
      await expect(stableNaira.connect(admin).commitSetTimelock(id, 86400n))
        .to.emit(stableNaira, "TimelockUpdated")
        .withArgs(ONE_HOUR, 86400n);
      expect(await stableNaira.timelock()).to.equal(86400n);
    });

    it("rejects a timelock below the 1-hour floor", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).setMinTimelock(60),
        "ActionQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);
      await expect(
        stableNaira.connect(admin).commitSetMinTimelock(id, 60n),
      ).to.be.revertedWithCustomError(stableNaira, "TimelockBelowFloor");
    });

    it("a queued action expires after the grace period", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).queueMint(alice.address, 100n),
        "MintQueued",
      );

      const grace = await stableNaira.ACTION_GRACE_PERIOD();
      await time.increase(Number(ONE_HOUR) + Number(grace) + 2);

      await expect(
        stableNaira.connect(admin).commitMint(id, alice.address, 100n),
      ).to.be.revertedWithCustomError(stableNaira, "ActionExpired");
    });

    it("non-admin cannot commit a ready action (no cancel front-running)", async () => {
      const { stableNaira, admin, mallory } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).setTimelock(86400),
        "ActionQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);

      await expect(
        stableNaira.connect(mallory).commitSetTimelock(id, 86400n),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );

      // The admin retains the ability to cancel right up to execution.
      await stableNaira.connect(admin).cancelAction(id);
      await expect(
        stableNaira.connect(admin).commitSetTimelock(id, 86400n),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotFound");
    });
  });

  describe("treasury mint (timelocked)", () => {
    it("queue + commit mint after timelock succeeds", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).queueMint(alice.address, 500n),
        "MintQueued",
      );

      await expect(
        stableNaira.connect(admin).commitMint(id, alice.address, 500n),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotReady");

      await time.increase(Number(ONE_HOUR) + 1);
      await expect(
        stableNaira.connect(admin).commitMint(id, alice.address, 500n),
      )
        .to.emit(stableNaira, "MintCommitted")
        .withArgs(id, alice.address, 500n);
      expect(await stableNaira.balanceOf(alice.address)).to.equal(500n);

      await expect(
        stableNaira.connect(admin).commitMint(id, alice.address, 500n),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotFound");
    });

    it("queueMint to zero address reverts", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(admin).queueMint(ZERO, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "ZeroAddress");
    });

    it("non-minter cannot queue a mint", async () => {
      const { stableNaira, alice } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(alice).queueMint(alice.address, 1n),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("non-admin cannot commit a mint", async () => {
      const { stableNaira, admin, alice, mallory } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).queueMint(alice.address, 1n),
        "MintQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);
      await expect(
        stableNaira.connect(mallory).commitMint(id, alice.address, 1n),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("queueMint while paused reverts", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).pause();
      await expect(
        stableNaira.connect(admin).queueMint(alice.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "EnforcedPause");
    });

    it("admin can cancel a queued mint", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).queueMint(alice.address, 100n),
        "MintQueued",
      );
      await stableNaira.connect(admin).cancelAction(id);
      await time.increase(Number(ONE_HOUR) + 1);
      await expect(
        stableNaira.connect(admin).commitMint(id, alice.address, 100n),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotFound");
    });
  });

  describe("bridge mint (synchronous, rate-limited)", () => {
    it("a registered bridge mints in one transaction", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      await registerBridge(stableNaira, admin, bridge);
      expect(await stableNaira.bridges(bridge)).to.equal(true);

      const asBridge = await ethers.getImpersonatedSigner(bridge);
      await setBalance(bridge, ethers.parseEther("1"));

      await expect(stableNaira.connect(asBridge).mint(alice.address, 1000n))
        .to.emit(stableNaira, "Transfer")
        .withArgs(ZERO, alice.address, 1000n);
      expect(await stableNaira.balanceOf(alice.address)).to.equal(1000n);
    });

    it("registering a bridge is timelocked and rejects EOAs", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      await expect(
        stableNaira
          .connect(admin)
          .queueAddBridge(alice.address, BRIDGE_CAPACITY, BRIDGE_PERIOD),
      ).to.be.revertedWithCustomError(stableNaira, "BridgeMustBeContract");

      const id = await queuedId(
        await stableNaira
          .connect(admin)
          .queueAddBridge(bridge, BRIDGE_CAPACITY, BRIDGE_PERIOD),
        "BridgeChangeQueued",
      );
      await expect(
        stableNaira
          .connect(admin)
          .commitAddBridge(id, bridge, BRIDGE_CAPACITY, BRIDGE_PERIOD),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotReady");
    });

    it("enforces the rate limit and refills linearly", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      // Slow refill: one second is worth <1 token, so the exhausted state is
      // observable in the very next transaction.
      const capacity = 1000n;
      const period = 100_000n;
      await registerBridge(stableNaira, admin, bridge, capacity, period);

      const asBridge = await ethers.getImpersonatedSigner(bridge);
      await setBalance(bridge, ethers.parseEther("1"));

      await stableNaira.connect(asBridge).mint(alice.address, 1000n);
      expect(await stableNaira.bridgeMintAvailable(bridge)).to.equal(0n);

      await expect(stableNaira.connect(asBridge).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(stableNaira, "BridgeRateLimitExceeded");

      // Half a period elapses -> roughly half the capacity is back.
      await time.increase(50_000);
      const avail = await stableNaira.bridgeMintAvailable(bridge);
      expect(avail).to.be.greaterThan(400n);
      expect(avail).to.be.lessThanOrEqual(600n);

      // A full period refills to capacity and no further.
      await time.increase(200_000);
      expect(await stableNaira.bridgeMintAvailable(bridge)).to.equal(capacity);
    });

    it("removeBridge instantly revokes mint authority", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      await registerBridge(stableNaira, admin, bridge);
      const asBridge = await ethers.getImpersonatedSigner(bridge);
      await setBalance(bridge, ethers.parseEther("1"));

      await stableNaira.connect(admin).removeBridge(bridge);
      expect(await stableNaira.bridges(bridge)).to.equal(false);
      expect(await stableNaira.bridgeMintAvailable(bridge)).to.equal(0n);
      await expect(
        stableNaira.connect(asBridge).mint(alice.address, 1n),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("a pauser can kill a compromised bridge without the admin", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      await registerBridge(stableNaira, admin, bridge);
      await stableNaira.connect(admin).addPauser(alice.address);
      await expect(stableNaira.connect(alice).removeBridge(bridge))
        .to.emit(stableNaira, "BridgeRemoved")
        .withArgs(bridge);
    });

    it("bridge mint respects pause and the mint cap", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      await registerBridge(stableNaira, admin, bridge);
      const asBridge = await ethers.getImpersonatedSigner(bridge);
      await setBalance(bridge, ethers.parseEther("1"));

      await stableNaira.connect(admin).pause();
      await expect(
        stableNaira.connect(asBridge).mint(alice.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "EnforcedPause");
      await stableNaira.connect(admin).unpause();

      const id = await queuedId(
        await stableNaira.connect(admin).queueSetMintCap(100n),
        "MintCapChangeQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);
      await stableNaira.connect(admin).commitSetMintCap(id, 100n);

      await stableNaira.connect(asBridge).mint(alice.address, 100n);
      await expect(
        stableNaira.connect(asBridge).mint(alice.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "MintCapExceeded");
    });
  });

  describe("mint cap", () => {
    it("setting the cap is timelocked", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const id = await queuedId(
        await stableNaira.connect(admin).queueSetMintCap(5000n),
        "MintCapChangeQueued",
      );
      expect(await stableNaira.mintCap()).to.equal(0n);
      await expect(
        stableNaira.connect(admin).commitSetMintCap(id, 5000n),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotReady");

      await time.increase(Number(ONE_HOUR) + 1);
      await expect(stableNaira.connect(admin).commitSetMintCap(id, 5000n))
        .to.emit(stableNaira, "MintCapUpdated")
        .withArgs(0n, 5000n);
      expect(await stableNaira.mintCap()).to.equal(5000n);
    });

    it("mintCap=0 means uncapped; a nonzero cap is enforced on treasury mints", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 10n ** 20n);

      const id = await queuedId(
        await stableNaira.connect(admin).queueSetMintCap(10n ** 20n + 1n),
        "MintCapChangeQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);
      await stableNaira.connect(admin).commitSetMintCap(id, 10n ** 20n + 1n);

      await treasuryMint(stableNaira, admin, alice.address, 1n); // exactly at cap
      const overId = await queuedId(
        await stableNaira.connect(admin).queueMint(alice.address, 1n),
        "MintQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);
      await expect(
        stableNaira.connect(admin).commitMint(overId, alice.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "MintCapExceeded");
    });
  });

  describe("burn / burnFrom / redeemRequest", () => {
    it("self-burn decreases sender balance", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 100n);
      await expect(stableNaira.connect(alice).burn(40n))
        .to.emit(stableNaira, "Transfer")
        .withArgs(alice.address, ZERO, 40n);
      expect(await stableNaira.balanceOf(alice.address)).to.equal(60n);
    });

    it("burnFrom needs BRIDGE_ROLE and no allowance (single-tx deposit)", async () => {
      const { stableNaira, admin, alice, bob, bridge } =
        await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 100n);
      await registerBridge(stableNaira, admin, bridge);
      const asBridge = await ethers.getImpersonatedSigner(bridge);
      await setBalance(bridge, ethers.parseEther("1"));

      // No approve step: depositForBurn must stay one user transaction.
      expect(await stableNaira.allowance(alice.address, bridge)).to.equal(0n);
      await expect(stableNaira.connect(asBridge).burnFrom(alice.address, 30n))
        .to.emit(stableNaira, "BridgeBurned")
        .withArgs(bridge, alice.address, 30n);
      expect(await stableNaira.balanceOf(alice.address)).to.equal(70n);

      // Neither the admin nor a random account may burn other people's funds.
      await expect(
        stableNaira.connect(admin).burnFrom(alice.address, 1n),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
      await expect(
        stableNaira.connect(bob).burnFrom(alice.address, 1n),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("the burn rate limit bounds a compromised bridge", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      const capacity = 1000n;
      const period = 100_000n;
      await treasuryMint(stableNaira, admin, alice.address, 5000n);
      await registerBridge(stableNaira, admin, bridge, capacity, period);
      const asBridge = await ethers.getImpersonatedSigner(bridge);
      await setBalance(bridge, ethers.parseEther("1"));

      await stableNaira.connect(asBridge).burnFrom(alice.address, 1000n);
      expect(await stableNaira.bridgeBurnAvailable(bridge)).to.equal(0n);

      // Alice still holds 4000, but the bridge cannot reach it this period.
      expect(await stableNaira.balanceOf(alice.address)).to.equal(4000n);
      await expect(
        stableNaira.connect(asBridge).burnFrom(alice.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "BridgeRateLimitExceeded");

      await time.increase(200_000);
      expect(await stableNaira.bridgeBurnAvailable(bridge)).to.equal(capacity);
    });

    it("mint and burn buckets refill independently", async () => {
      const { stableNaira, admin, alice, bridge } = await loadFixture(fixture);
      const capacity = 1000n;
      const period = 100_000n;
      await treasuryMint(stableNaira, admin, alice.address, 5000n);
      await registerBridge(stableNaira, admin, bridge, capacity, period);
      const asBridge = await ethers.getImpersonatedSigner(bridge);
      await setBalance(bridge, ethers.parseEther("1"));

      // Exhausting the burn bucket must not throttle inbound minting.
      await stableNaira.connect(asBridge).burnFrom(alice.address, 1000n);
      expect(await stableNaira.bridgeBurnAvailable(bridge)).to.equal(0n);
      expect(await stableNaira.bridgeMintAvailable(bridge)).to.equal(capacity);
      await stableNaira.connect(asBridge).mint(alice.address, 1000n);
      expect(await stableNaira.bridgeMintAvailable(bridge)).to.equal(0n);
    });

    it("redeemRequest burns and emits offChainReference", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 100n);
      await expect(stableNaira.connect(alice).redeemRequest(40n, "ref-1"))
        .to.emit(stableNaira, "RedeemRequested")
        .withArgs(alice.address, 40n, "ref-1");
      expect(await stableNaira.balanceOf(alice.address)).to.equal(60n);
    });
  });

  describe("pause", () => {
    it("pauser can pause; non-pauser/admin cannot", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).addPauser(alice.address);
      await stableNaira.connect(alice).pause();
      expect(await stableNaira.paused()).to.equal(true);
    });

    it("only admin (not pauser) can unpause", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).addPauser(alice.address);
      await stableNaira.connect(alice).pause();
      await expect(
        stableNaira.connect(alice).unpause(),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
      await stableNaira.connect(admin).unpause();
      expect(await stableNaira.paused()).to.equal(false);
    });

    it("paused blocks transfer", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 10n);
      await stableNaira.connect(admin).pause();
      await expect(
        stableNaira.connect(alice).transfer(bob.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "EnforcedPause");
    });

    it("non-pauser non-admin cannot pause", async () => {
      const { stableNaira, alice } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(alice).pause(),
      ).to.be.revertedWithCustomError(stableNaira, "NotAuthorizedCompliance");
    });
  });

  describe("freeze", () => {
    it("frozen sender / receiver can't transfer", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 100n);
      await stableNaira.connect(admin).freezeAddress(alice.address);

      await expect(
        stableNaira.connect(alice).transfer(bob.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "ERC20InvalidSender");

      await stableNaira.connect(admin).unfreezeAddress(alice.address);
      await stableNaira.connect(admin).freezeAddress(bob.address);
      await expect(
        stableNaira.connect(alice).transfer(bob.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "ERC20InvalidReceiver");
    });

    it("double-freeze and double-unfreeze revert", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).freezeAddress(alice.address);
      await expect(
        stableNaira.connect(admin).freezeAddress(alice.address),
      ).to.be.revertedWithCustomError(stableNaira, "AlreadyFrozen");

      await stableNaira.connect(admin).unfreezeAddress(alice.address);
      await expect(
        stableNaira.connect(admin).unfreezeAddress(alice.address),
      ).to.be.revertedWithCustomError(stableNaira, "NotFrozen");
    });
  });

  describe("seize (compliance bypass)", () => {
    it("seizes funds from a frozen account during pause", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 100n);
      await stableNaira.connect(admin).freezeAddress(alice.address);
      await stableNaira.connect(admin).pause();

      await expect(
        stableNaira.connect(admin).seizeFunds(alice.address, bob.address, 40n),
      )
        .to.emit(stableNaira, "FundsSeized")
        .withArgs(alice.address, bob.address, 40n);

      expect(await stableNaira.balanceOf(alice.address)).to.equal(60n);
      expect(await stableNaira.balanceOf(bob.address)).to.equal(40n);
    });

    it("refuses to seize into a frozen account (funds would be locked)", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 100n);
      await stableNaira.connect(admin).freezeAddress(bob.address);
      await expect(
        stableNaira.connect(admin).seizeFunds(alice.address, bob.address, 10n),
      ).to.be.revertedWithCustomError(stableNaira, "FrozenRecipient");
    });

    it("seize > balance reverts", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 10n);
      await expect(
        stableNaira.connect(admin).seizeFunds(alice.address, bob.address, 11n),
      ).to.be.revertedWithCustomError(stableNaira, "InsufficientBalance");
    });

    it("seize zero address reverts", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(admin).seizeFunds(ZERO, alice.address, 1n),
      ).to.be.revertedWithCustomError(stableNaira, "ZeroAddress");
    });
  });

  describe("permit (EIP-2612)", () => {
    it("sets allowance via signed permit", async () => {
      const { stableNaira, alice, bob } = await loadFixture(fixture);
      const value = 1234n;
      const deadline = (await time.latest()) + 3600;
      const nonce = await stableNaira.nonces(alice.address);

      const domain = {
        name: "StableNaira",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await stableNaira.getAddress(),
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const message = {
        owner: alice.address,
        spender: bob.address,
        value,
        nonce,
        deadline,
      };
      const sig = await alice.signTypedData(domain, types, message);
      const { v, r, s } = ethers.Signature.from(sig);

      await stableNaira
        .connect(bob)
        .permit(alice.address, bob.address, value, deadline, v, r, s);
      expect(await stableNaira.allowance(alice.address, bob.address)).to.equal(
        value,
      );
      expect(await stableNaira.nonces(alice.address)).to.equal(nonce + 1n);
    });
  });

  describe("upgrade (queue/commit timelock)", () => {
    it("direct upgradeToAndCall reverts (UpgradeNotAuthorized)", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();
      await expect(
        stableNaira
          .connect(admin)
          .upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(stableNaira, "UpgradeNotAuthorized");
    });

    it("queue + wait + commit succeeds; storage preserved", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await treasuryMint(stableNaira, admin, alice.address, 99n);

      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();
      const newAddr = await newImpl.getAddress();

      const id = await queuedId(
        await stableNaira.connect(admin).queueUpgrade(newAddr, "0x"),
        "UpgradeQueued",
      );

      await expect(
        stableNaira.connect(admin).commitUpgrade(id, newAddr, "0x"),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotReady");

      await time.increase(Number(ONE_HOUR) + 1);

      await expect(
        stableNaira.connect(admin).commitUpgrade(id, alice.address, "0x"),
      ).to.be.revertedWithCustomError(stableNaira, "ActionMismatch");

      await stableNaira.connect(admin).commitUpgrade(id, newAddr, "0x");
      expect(await stableNaira.balanceOf(alice.address)).to.equal(99n);

      await expect(
        stableNaira.connect(admin).commitUpgrade(id, newAddr, "0x"),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotFound");
    });

    it("non-admin can neither queue nor commit an upgrade", async () => {
      const { stableNaira, admin, mallory } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      const newAddr = await newImpl.getAddress();

      await expect(
        stableNaira.connect(mallory).queueUpgrade(newAddr, "0x"),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );

      const id = await queuedId(
        await stableNaira.connect(admin).queueUpgrade(newAddr, "0x"),
        "UpgradeQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);
      await expect(
        stableNaira.connect(mallory).commitUpgrade(id, newAddr, "0x"),
      ).to.be.revertedWithCustomError(
        stableNaira,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("the upgrade authorization flag does not persist after commit", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("StableNaira");
      const implA = await Impl.deploy();
      await implA.waitForDeployment();
      const addrA = await implA.getAddress();

      const id = await queuedId(
        await stableNaira.connect(admin).queueUpgrade(addrA, "0x"),
        "UpgradeQueued",
      );
      await time.increase(Number(ONE_HOUR) + 1);
      await stableNaira.connect(admin).commitUpgrade(id, addrA, "0x");

      // A second, un-queued upgrade to the same impl must not be possible.
      await expect(
        stableNaira.connect(admin).upgradeToAndCall(addrA, "0x"),
      ).to.be.revertedWithCustomError(stableNaira, "UpgradeNotAuthorized");
    });

    it("admin can cancel a queued upgrade", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      const newAddr = await newImpl.getAddress();
      const id = await queuedId(
        await stableNaira.connect(admin).queueUpgrade(newAddr, "0x"),
        "UpgradeQueued",
      );

      await stableNaira.connect(admin).cancelAction(id);
      await time.increase(Number(ONE_HOUR) + 1);
      await expect(
        stableNaira.connect(admin).commitUpgrade(id, newAddr, "0x"),
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotFound");
    });
  });
});
