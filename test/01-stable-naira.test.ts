import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { deployStableNaira } from "./helpers/fixtures";

const ZERO = "0x0000000000000000000000000000000000000000";

describe("StableNaira", () => {
  async function fixture() {
    const [admin, alice, bob, charlie, mallory] = await ethers.getSigners();
    const { stableNaira, factory, implementation, proxy } = await deployStableNaira(admin.address);
    return { stableNaira, factory, implementation, proxy, admin, alice, bob, charlie, mallory };
  }

  describe("initialization", () => {
    it("sets metadata, decimals, and version", async () => {
      const { stableNaira } = await loadFixture(fixture);
      expect(await stableNaira.name()).to.equal("StableNaira");
      expect(await stableNaira.symbol()).to.equal("SNR");
      expect(await stableNaira.decimals()).to.equal(2);
      expect(await stableNaira.VERSION()).to.equal("1.0");
    });

    it("grants admin all default roles and sets owner()", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const DEFAULT_ADMIN_ROLE = await stableNaira.DEFAULT_ADMIN_ROLE();
      expect(await stableNaira.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await stableNaira.minters(admin.address)).to.equal(true);
      expect(await stableNaira.pausers(admin.address)).to.equal(true);
      expect(await stableNaira.freezers(admin.address)).to.equal(true);
      expect(await stableNaira.seizers(admin.address)).to.equal(true);
      expect(await stableNaira.owner()).to.equal(admin.address);
    });

    it("starts unpaused with zero supply and uncapped mint", async () => {
      const { stableNaira } = await loadFixture(fixture);
      expect(await stableNaira.paused()).to.equal(false);
      expect(await stableNaira.totalSupply()).to.equal(0n);
      expect(await stableNaira.mintCap()).to.equal(0n);
    });

    it("re-initialize on the proxy reverts (locked)", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      await expect(
        stableNaira.initialize("X", "X", admin.address)
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
        stableNaira.connect(alice).addMinter(bob.address)
      ).to.be.revertedWithCustomError(stableNaira, "AccessControlUnauthorizedAccount");
    });

    it("addMinter rejects zero address", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      await expect(stableNaira.connect(admin).addMinter(ZERO)).to.be.revertedWithCustomError(
        stableNaira,
        "ZeroAddress"
      );
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
  });

  describe("mint", () => {
    it("minter can mint to non-zero address", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await expect(stableNaira.connect(admin).mint(alice.address, 1000n))
        .to.emit(stableNaira, "Transfer")
        .withArgs(ZERO, alice.address, 1000n);
      expect(await stableNaira.balanceOf(alice.address)).to.equal(1000n);
    });

    it("mint to zero address reverts", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(admin).mint(ZERO, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "ZeroAddress");
    });

    it("non-minter cannot mint", async () => {
      const { stableNaira, alice } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(alice).mint(alice.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "AccessControlUnauthorizedAccount");
    });

    it("mint while paused reverts", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).pause();
      await expect(
        stableNaira.connect(admin).mint(alice.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "EnforcedPause");
    });

    it("mintCap=0 means uncapped; nonzero cap is enforced", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      // Uncapped: very large mint succeeds.
      await stableNaira.connect(admin).mint(alice.address, 10n ** 20n);

      await stableNaira.connect(admin).setMintCap(10n ** 20n + 1n); // cap just above current supply
      await stableNaira.connect(admin).mint(alice.address, 1n); // exactly at cap, ok
      await expect(
        stableNaira.connect(admin).mint(alice.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "MintCapExceeded");
    });
  });

  describe("burn / burnFrom / redeemRequest", () => {
    it("self-burn decreases sender balance", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).mint(alice.address, 100n);
      await expect(stableNaira.connect(alice).burn(40n))
        .to.emit(stableNaira, "Transfer")
        .withArgs(alice.address, ZERO, 40n);
      expect(await stableNaira.balanceOf(alice.address)).to.equal(60n);
    });

    it("burnFrom requires MINTER_ROLE and bypasses allowance (HIGH-03 acknowledged)", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await stableNaira.connect(admin).mint(alice.address, 100n);
      // No allowance set; admin (minter) burns directly. This is by design.
      await stableNaira.connect(admin).burnFrom(alice.address, 30n);
      expect(await stableNaira.balanceOf(alice.address)).to.equal(70n);
      await expect(
        stableNaira.connect(bob).burnFrom(alice.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "AccessControlUnauthorizedAccount");
    });

    it("redeemRequest burns and emits offChainReference", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).mint(alice.address, 100n);
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
        stableNaira.connect(alice).unpause()
      ).to.be.revertedWithCustomError(stableNaira, "AccessControlUnauthorizedAccount");
      await stableNaira.connect(admin).unpause();
      expect(await stableNaira.paused()).to.equal(false);
    });

    it("paused blocks transfer", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await stableNaira.connect(admin).mint(alice.address, 10n);
      await stableNaira.connect(admin).pause();
      await expect(
        stableNaira.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "EnforcedPause");
    });

    it("non-pauser non-admin cannot pause", async () => {
      const { stableNaira, alice } = await loadFixture(fixture);
      await expect(stableNaira.connect(alice).pause()).to.be.revertedWithCustomError(
        stableNaira,
        "NotAuthorizedCompliance"
      );
    });
  });

  describe("freeze", () => {
    it("frozen sender / receiver can't transfer", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await stableNaira.connect(admin).mint(alice.address, 100n);
      await stableNaira.connect(admin).freezeAddress(alice.address);

      await expect(
        stableNaira.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "ERC20InvalidSender");

      // Receiver-side block.
      await stableNaira.connect(admin).unfreezeAddress(alice.address);
      await stableNaira.connect(admin).freezeAddress(bob.address);
      await expect(
        stableNaira.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "ERC20InvalidReceiver");
    });

    it("double-freeze and double-unfreeze revert", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await stableNaira.connect(admin).freezeAddress(alice.address);
      await expect(
        stableNaira.connect(admin).freezeAddress(alice.address)
      ).to.be.revertedWithCustomError(stableNaira, "AlreadyFrozen");

      await stableNaira.connect(admin).unfreezeAddress(alice.address);
      await expect(
        stableNaira.connect(admin).unfreezeAddress(alice.address)
      ).to.be.revertedWithCustomError(stableNaira, "NotFrozen");
    });
  });

  describe("seize (compliance bypass — LOW-07)", () => {
    it("seizes funds from a frozen account during pause", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await stableNaira.connect(admin).mint(alice.address, 100n);
      await stableNaira.connect(admin).freezeAddress(alice.address);
      await stableNaira.connect(admin).pause();

      await expect(stableNaira.connect(admin).seizeFunds(alice.address, bob.address, 40n))
        .to.emit(stableNaira, "FundsSeized")
        .withArgs(alice.address, bob.address, 40n);

      expect(await stableNaira.balanceOf(alice.address)).to.equal(60n);
      expect(await stableNaira.balanceOf(bob.address)).to.equal(40n);
    });

    it("seize > balance reverts", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
      await stableNaira.connect(admin).mint(alice.address, 10n);
      await expect(
        stableNaira.connect(admin).seizeFunds(alice.address, bob.address, 11n)
      ).to.be.revertedWithCustomError(stableNaira, "InsufficientBalance");
    });

    it("seize zero address reverts", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      await expect(
        stableNaira.connect(admin).seizeFunds(ZERO, alice.address, 1n)
      ).to.be.revertedWithCustomError(stableNaira, "ZeroAddress");
    });
  });

  describe("permit (EIP-2612)", () => {
    it("sets allowance via signed permit", async () => {
      const { stableNaira, admin, alice, bob } = await loadFixture(fixture);
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

      await stableNaira.connect(bob).permit(alice.address, bob.address, value, deadline, v, r, s);
      expect(await stableNaira.allowance(alice.address, bob.address)).to.equal(value);
      expect(await stableNaira.nonces(alice.address)).to.equal(nonce + 1n);

      // Hush unused-var warning on admin.
      void admin;
    });
  });

  describe("upgrade (queue/commit timelock)", () => {
    it("direct upgradeToAndCall reverts (UpgradeNotAuthorized)", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();
      await expect(
        stableNaira.connect(admin).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(stableNaira, "UpgradeNotAuthorized");
    });

    it("queue + wait + commit succeeds; storage preserved", async () => {
      const { stableNaira, admin, alice } = await loadFixture(fixture);
      // Set some state we can re-read after upgrade.
      await stableNaira.connect(admin).mint(alice.address, 99n);

      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();
      const newAddr = await newImpl.getAddress();

      const tx = await stableNaira.connect(admin).queueUpgrade(newAddr, "0x");
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) => l.fragment?.name === "UpgradeQueued") as any;
      const actionId = evt.args.actionId as bigint;

      // Cannot commit before timelock.
      await expect(
        stableNaira.commitUpgrade(actionId, newAddr, "0x")
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotReady");

      await time.increase(3600 + 1);

      // Wrong arg => mismatch.
      await expect(
        stableNaira.commitUpgrade(actionId, alice.address, "0x")
      ).to.be.revertedWithCustomError(stableNaira, "ActionMismatch");

      await stableNaira.commitUpgrade(actionId, newAddr, "0x");

      // State preserved after upgrade.
      expect(await stableNaira.balanceOf(alice.address)).to.equal(99n);

      // Commit twice rejected (action already consumed).
      await expect(
        stableNaira.commitUpgrade(actionId, newAddr, "0x")
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotFound");
    });

    it("non-admin cannot queue", async () => {
      const { stableNaira, alice } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      await expect(
        stableNaira.connect(alice).queueUpgrade(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(stableNaira, "AccessControlUnauthorizedAccount");
    });

    it("admin can cancel queued upgrade", async () => {
      const { stableNaira, admin } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("StableNaira");
      const newImpl = await Impl.deploy();
      const newAddr = await newImpl.getAddress();
      const tx = await stableNaira.connect(admin).queueUpgrade(newAddr, "0x");
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) => l.fragment?.name === "UpgradeQueued") as any;
      const actionId = evt.args.actionId as bigint;

      await stableNaira.connect(admin).cancelUpgrade(actionId);
      await time.increase(3600 + 1);
      await expect(
        stableNaira.commitUpgrade(actionId, newAddr, "0x")
      ).to.be.revertedWithCustomError(stableNaira, "ActionNotFound");
    });
  });
});
