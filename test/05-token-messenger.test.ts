import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployStableNaira,
  deployTokenMessenger,
  deployMessageTransmitter,
  deployValidatorRegistry,
} from "./helpers/fixtures";

const ZERO = "0x0000000000000000000000000000000000000000";
const BYTES32_ZERO = "0x" + "00".repeat(32);

const ENVELOPE_VERSION = 1;
const BODY_VERSION = 1;
const LOCAL_DOMAIN = 100;
const REMOTE_DOMAIN = 200;

function addrToBytes32(addr: string): string {
  return ethers.zeroPadValue(ethers.getAddress(addr), 32);
}

function packEnvelope(
  version: number,
  sourceDomain: number,
  destinationDomain: number,
  nonce: bigint,
  sender: string,
  recipient: string,
  destinationCaller: string,
  body: string
): string {
  return ethers.solidityPacked(
    ["uint32", "uint32", "uint32", "uint64", "bytes32", "bytes32", "bytes32", "bytes"],
    [version, sourceDomain, destinationDomain, nonce, sender, recipient, destinationCaller, body]
  );
}

function packBurnBody(
  version: number,
  burnToken: string,
  mintRecipient: string,
  amount: bigint,
  messageSender: string
): string {
  return ethers.solidityPacked(
    ["uint32", "bytes32", "bytes32", "uint256", "bytes32"],
    [version, burnToken, mintRecipient, amount, messageSender]
  );
}

describe("TokenMessenger", () => {
  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    // Token.
    const { stableNaira } = await deployStableNaira(owner.address);

    // Verifier (mock, always passes).
    const MockVerifier = await ethers.getContractFactory("MockSignatureVerifier");
    const verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();

    // Transmitter.
    const { messageTransmitter } = await deployMessageTransmitter(
      LOCAL_DOMAIN,
      await verifier.getAddress(),
      4096n,
      owner.address
    );

    // Bridge.
    const { tokenMessenger } = await deployTokenMessenger(
      await messageTransmitter.getAddress(),
      await stableNaira.getAddress(),
      owner.address
    );

    // Grant MINTER_ROLE to bridge so it can mint+burn.
    await stableNaira.connect(owner).addMinter(await tokenMessenger.getAddress());

    return { stableNaira, verifier, messageTransmitter, tokenMessenger, owner, alice, bob };
  }

  // Stub remote router used for register/lookup tests.
  const REMOTE_ROUTER = addrToBytes32("0x000000000000000000000000000000000000beef");

  describe("initialization", () => {
    it("sets transmitter, token, defaults", async () => {
      const { tokenMessenger, messageTransmitter, stableNaira, owner } = await loadFixture(fixture);
      expect(await tokenMessenger.messageTransmitter()).to.equal(await messageTransmitter.getAddress());
      expect(await tokenMessenger.localToken()).to.equal(await stableNaira.getAddress());
      expect(await tokenMessenger.owner()).to.equal(owner.address);
      expect(await tokenMessenger.feeBps()).to.equal(0n);
      expect(await tokenMessenger.feeRecipient()).to.equal(ZERO);
      expect(await tokenMessenger.bodyVersion()).to.equal(BODY_VERSION);
      expect(await tokenMessenger.remoteRouter(REMOTE_DOMAIN)).to.equal(BYTES32_ZERO);
    });
  });

  async function registerRemoteRouter(tokenMessenger: any, owner: any, domain: number, router: string) {
    const tx = await tokenMessenger.connect(owner).queueSetRemoteRouter(domain, router);
    const receipt = await tx.wait();
    const evt = receipt.logs.find((l: any) => l.fragment?.name === "RemoteRouterChangeQueued") as any;
    const actionId = evt.args.actionId as bigint;
    await time.increase(3600 + 1);
    await tokenMessenger.commitSetRemoteRouter(actionId, domain, router);
    return actionId;
  }

  describe("remoteRouter timelock (queue + commit)", () => {
    it("queues and commits new remote router", async () => {
      const { tokenMessenger, owner } = await loadFixture(fixture);
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);
      expect(await tokenMessenger.remoteRouter(REMOTE_DOMAIN)).to.equal(REMOTE_ROUTER);
    });

    it("non-owner cannot queue", async () => {
      const { tokenMessenger, alice } = await loadFixture(fixture);
      await expect(
        tokenMessenger.connect(alice).queueSetRemoteRouter(REMOTE_DOMAIN, REMOTE_ROUTER)
      ).to.be.revertedWithCustomError(tokenMessenger, "OwnableUnauthorizedAccount");
    });
  });

  describe("depositForBurn", () => {
    it("burns from sender, emits, dispatches via transmitter", async () => {
      const { tokenMessenger, messageTransmitter, stableNaira, owner, alice } = await loadFixture(
        fixture
      );
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);
      await stableNaira.connect(owner).mint(alice.address, 1000n);

      const recipient = addrToBytes32(alice.address);
      const burnTokenAddr = await stableNaira.getAddress();
      // Sender must hold MINTER_ROLE OR — wait: burnFrom is gated by MINTER_ROLE.
      // Re-reading TokenMessenger: it calls IStableNaira(localToken).burnFrom(msg.sender, amount).
      // The TokenMessenger contract is the caller of burnFrom -> bridge has MINTER_ROLE -> OK.
      // The user (alice) does NOT need MINTER_ROLE. The bridge does.

      await expect(
        tokenMessenger.connect(alice).depositForBurn(500n, REMOTE_DOMAIN, recipient, burnTokenAddr)
      )
        .to.emit(tokenMessenger, "DepositForBurn")
        .and.to.emit(messageTransmitter, "MessageSent");

      expect(await stableNaira.balanceOf(alice.address)).to.equal(500n);
      expect(await stableNaira.totalSupply()).to.equal(500n);
    });

    it("rejects zero amount / zero recipient / wrong token / unregistered remote", async () => {
      const { tokenMessenger, stableNaira, owner, alice } = await loadFixture(fixture);
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);
      await stableNaira.connect(owner).mint(alice.address, 1000n);
      const burnTokenAddr = await stableNaira.getAddress();
      const recipient = addrToBytes32(alice.address);

      await expect(
        tokenMessenger.connect(alice).depositForBurn(0n, REMOTE_DOMAIN, recipient, burnTokenAddr)
      ).to.be.revertedWithCustomError(tokenMessenger, "ZeroAmount");
      await expect(
        tokenMessenger.connect(alice).depositForBurn(1n, REMOTE_DOMAIN, BYTES32_ZERO, burnTokenAddr)
      ).to.be.revertedWithCustomError(tokenMessenger, "ZeroMintRecipient");
      await expect(
        tokenMessenger.connect(alice).depositForBurn(1n, REMOTE_DOMAIN, recipient, alice.address)
      ).to.be.revertedWithCustomError(tokenMessenger, "InvalidBurnToken");
      await expect(
        tokenMessenger.connect(alice).depositForBurn(1n, 999, recipient, burnTokenAddr)
      ).to.be.revertedWithCustomError(tokenMessenger, "UnregisteredRemoteRouter");
    });

    it("paused blocks depositForBurn", async () => {
      const { tokenMessenger, stableNaira, owner, alice } = await loadFixture(fixture);
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);
      await stableNaira.connect(owner).mint(alice.address, 100n);
      await tokenMessenger.connect(owner).pause();
      await expect(
        tokenMessenger
          .connect(alice)
          .depositForBurn(50n, REMOTE_DOMAIN, addrToBytes32(alice.address), await stableNaira.getAddress())
      ).to.be.revertedWithCustomError(tokenMessenger, "EnforcedPause");
    });

    it("depositForBurnWithCaller pins destinationCaller", async () => {
      const { tokenMessenger, stableNaira, messageTransmitter, owner, alice, bob } = await loadFixture(
        fixture
      );
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);
      await stableNaira.connect(owner).mint(alice.address, 100n);
      const recipient = addrToBytes32(alice.address);
      const destCaller = addrToBytes32(bob.address);

      await expect(
        tokenMessenger
          .connect(alice)
          .depositForBurnWithCaller(50n, REMOTE_DOMAIN, recipient, await stableNaira.getAddress(), destCaller)
      )
        .to.emit(tokenMessenger, "DepositForBurn")
        .and.to.emit(messageTransmitter, "MessageSent");
    });
  });

  describe("handleReceiveMessage", () => {
    it("only callable by transmitter", async () => {
      const { tokenMessenger, alice } = await loadFixture(fixture);
      await expect(
        tokenMessenger.connect(alice).handleReceiveMessage(REMOTE_DOMAIN, REMOTE_ROUTER, "0x")
      ).to.be.revertedWithCustomError(tokenMessenger, "OnlyMessageTransmitter");
    });

    it("mints to recipient when called via transmitter w/ valid burn body", async () => {
      const { tokenMessenger, stableNaira, messageTransmitter, owner, alice } = await loadFixture(
        fixture
      );
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);

      // Build a burn body the bridge will accept.
      const burnTokenBytes32 = addrToBytes32(await stableNaira.getAddress());
      const recipient = addrToBytes32(alice.address);
      const messageSender = addrToBytes32(owner.address);
      const body = packBurnBody(BODY_VERSION, burnTokenBytes32, recipient, 12345n, messageSender);

      // Build envelope: source=REMOTE_DOMAIN, dest=LOCAL_DOMAIN, sender = REMOTE_ROUTER (registered as peer).
      const envelope = packEnvelope(
        ENVELOPE_VERSION,
        REMOTE_DOMAIN,
        LOCAL_DOMAIN,
        7n,
        REMOTE_ROUTER, // sender bytes32
        addrToBytes32(await tokenMessenger.getAddress()), // recipient = the bridge
        BYTES32_ZERO,
        body
      );

      await messageTransmitter.receiveMessage(envelope, "0x");
      expect(await stableNaira.balanceOf(alice.address)).to.equal(12345n);
    });

    it("rejects when sender doesn't match registered remote router", async () => {
      const { tokenMessenger, stableNaira, messageTransmitter, owner, alice } = await loadFixture(
        fixture
      );
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);
      const burnTokenBytes32 = addrToBytes32(await stableNaira.getAddress());
      const recipient = addrToBytes32(alice.address);
      const messageSender = addrToBytes32(owner.address);
      const body = packBurnBody(BODY_VERSION, burnTokenBytes32, recipient, 1n, messageSender);
      const wrongSender = addrToBytes32("0x000000000000000000000000000000000000dead");
      const envelope = packEnvelope(
        ENVELOPE_VERSION,
        REMOTE_DOMAIN,
        LOCAL_DOMAIN,
        1n,
        wrongSender,
        addrToBytes32(await tokenMessenger.getAddress()),
        BYTES32_ZERO,
        body
      );
      await expect(messageTransmitter.receiveMessage(envelope, "0x")).to.be.revertedWithCustomError(
        tokenMessenger,
        "InvalidRemoteSender"
      );
    });

    it("rejects unregistered source domain", async () => {
      const { tokenMessenger, stableNaira, messageTransmitter, owner, alice } = await loadFixture(
        fixture
      );
      // No remote router registered for domain 999.
      const burnTokenBytes32 = addrToBytes32(await stableNaira.getAddress());
      const recipient = addrToBytes32(alice.address);
      const messageSender = addrToBytes32(owner.address);
      const body = packBurnBody(BODY_VERSION, burnTokenBytes32, recipient, 1n, messageSender);
      const envelope = packEnvelope(
        ENVELOPE_VERSION,
        999,
        LOCAL_DOMAIN,
        1n,
        REMOTE_ROUTER,
        addrToBytes32(await tokenMessenger.getAddress()),
        BYTES32_ZERO,
        body
      );
      await expect(messageTransmitter.receiveMessage(envelope, "0x")).to.be.revertedWithCustomError(
        tokenMessenger,
        "UnregisteredRemoteRouter"
      );
    });

    it("rejects wrong body version", async () => {
      const { tokenMessenger, stableNaira, messageTransmitter, owner, alice } = await loadFixture(
        fixture
      );
      await registerRemoteRouter(tokenMessenger, owner, REMOTE_DOMAIN, REMOTE_ROUTER);
      const burnTokenBytes32 = addrToBytes32(await stableNaira.getAddress());
      const recipient = addrToBytes32(alice.address);
      const messageSender = addrToBytes32(owner.address);
      const body = packBurnBody(99, burnTokenBytes32, recipient, 1n, messageSender);
      const envelope = packEnvelope(
        ENVELOPE_VERSION,
        REMOTE_DOMAIN,
        LOCAL_DOMAIN,
        1n,
        REMOTE_ROUTER,
        addrToBytes32(await tokenMessenger.getAddress()),
        BYTES32_ZERO,
        body
      );
      await expect(messageTransmitter.receiveMessage(envelope, "0x")).to.be.revertedWithCustomError(
        tokenMessenger,
        "UnsupportedBodyVersion"
      );
    });
  });

  describe("fee config (queue + commit)", () => {
    it("queues + commits feeBps and recipient", async () => {
      const { tokenMessenger, owner, alice } = await loadFixture(fixture);
      const tx = await tokenMessenger.connect(owner).queueSetFeeConfig(50n, alice.address);
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) => l.fragment?.name === "FeeConfigChangeQueued") as any;
      const actionId = evt.args.actionId as bigint;
      await time.increase(3600 + 1);
      await tokenMessenger.commitSetFeeConfig(actionId, 50n, alice.address);
      expect(await tokenMessenger.feeBps()).to.equal(50n);
      expect(await tokenMessenger.feeRecipient()).to.equal(alice.address);
    });

    it("rejects feeBps > MAX_FEE_BPS or non-zero bps with zero recipient", async () => {
      const { tokenMessenger, owner } = await loadFixture(fixture);
      await expect(
        tokenMessenger.connect(owner).queueSetFeeConfig(101n, owner.address)
      ).to.be.revertedWithCustomError(tokenMessenger, "FeeBpsTooHigh");
      await expect(
        tokenMessenger.connect(owner).queueSetFeeConfig(50n, ZERO)
      ).to.be.revertedWithCustomError(tokenMessenger, "InvalidFeeRecipient");
    });
  });

  describe("upgrade", () => {
    it("queue + commit performs UUPS upgrade", async () => {
      const { tokenMessenger, owner } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("TokenMessenger");
      const newImpl = await Impl.deploy();
      const newAddr = await newImpl.getAddress();
      const tx = await tokenMessenger.connect(owner).queueUpgrade(newAddr, "0x");
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) => l.fragment?.name === "UpgradeQueued") as any;
      const actionId = evt.args.actionId as bigint;
      await time.increase(3600 + 1);
      await tokenMessenger.commitUpgrade(actionId, newAddr, "0x");
    });
  });
});
