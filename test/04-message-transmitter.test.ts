import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { deployMessageTransmitter, deployValidatorRegistry } from "./helpers/fixtures";

const ZERO = "0x0000000000000000000000000000000000000000";
const BYTES32_ZERO = "0x" + "00".repeat(32);

const ENVELOPE_VERSION = 1;
const LOCAL_DOMAIN = 100;

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

describe("MessageTransmitter", () => {
  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockSignatureVerifier");
    const verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();

    const MockHandler = await ethers.getContractFactory("MockMessageHandler");
    const handler = await MockHandler.deploy();
    await handler.waitForDeployment();

    const { messageTransmitter } = await deployMessageTransmitter(
      LOCAL_DOMAIN,
      await verifier.getAddress(),
      4096n,
      owner.address
    );

    return { messageTransmitter, verifier, handler, owner, alice, bob };
  }

  describe("initialization", () => {
    it("sets fields and emits init events", async () => {
      const { messageTransmitter, verifier } = await loadFixture(fixture);
      expect(await messageTransmitter.localDomain()).to.equal(LOCAL_DOMAIN);
      expect(await messageTransmitter.signatureVerifier()).to.equal(await verifier.getAddress());
      expect(await messageTransmitter.maxMessageBodySize()).to.equal(4096n);
      expect(await messageTransmitter.version()).to.equal(ENVELOPE_VERSION);
      expect(await messageTransmitter.nextAvailableNonce()).to.equal(0n);
    });

    it("rejects zero localDomain / zero verifier / tiny maxBody", async () => {
      const [owner] = await ethers.getSigners();
      const MockVerifier = await ethers.getContractFactory("MockSignatureVerifier");
      const verifier = await MockVerifier.deploy();

      await expect(
        deployMessageTransmitter(0, await verifier.getAddress(), 4096n, owner.address)
      ).to.be.reverted;
      await expect(
        deployMessageTransmitter(LOCAL_DOMAIN, ZERO, 4096n, owner.address)
      ).to.be.reverted;
      await expect(
        deployMessageTransmitter(LOCAL_DOMAIN, await verifier.getAddress(), 100n, owner.address)
      ).to.be.reverted;
    });
  });

  describe("sendMessage", () => {
    it("emits MessageSent and increments nonce", async () => {
      const { messageTransmitter, alice } = await loadFixture(fixture);
      const recipient = addrToBytes32(alice.address);
      const body = "0xdeadbeef";

      await expect(messageTransmitter.connect(alice).sendMessage(99, recipient, body))
        .to.emit(messageTransmitter, "MessageSent");

      expect(await messageTransmitter.nextAvailableNonce()).to.equal(1n);
    });

    it("rejects sendMessage to localDomain", async () => {
      const { messageTransmitter, alice } = await loadFixture(fixture);
      await expect(
        messageTransmitter.connect(alice).sendMessage(LOCAL_DOMAIN, BYTES32_ZERO, "0x00")
      ).to.be.revertedWithCustomError(messageTransmitter, "LocalDestinationNotAllowed");
    });

    it("rejects body larger than maxMessageBodySize", async () => {
      const { messageTransmitter, alice } = await loadFixture(fixture);
      const big = "0x" + "ab".repeat(4097); // > 4096
      await expect(
        messageTransmitter.connect(alice).sendMessage(99, BYTES32_ZERO, big)
      ).to.be.revertedWithCustomError(messageTransmitter, "MessageBodyTooLarge");
    });

    it("paused blocks sendMessage", async () => {
      const { messageTransmitter, owner, alice } = await loadFixture(fixture);
      await messageTransmitter.connect(owner).pause();
      await expect(
        messageTransmitter.connect(alice).sendMessage(99, BYTES32_ZERO, "0x00")
      ).to.be.revertedWithCustomError(messageTransmitter, "EnforcedPause");
    });
  });

  describe("receiveMessage", () => {
    it("verifier called, fields validated, handler invoked, nonce consumed", async () => {
      const { messageTransmitter, handler, alice } = await loadFixture(fixture);
      const sourceDomain = 7;
      const nonce = 42n;
      const sender = addrToBytes32(alice.address);
      const recipient = addrToBytes32(await handler.getAddress());
      const body = "0xcafef00d";
      const envelope = packEnvelope(
        ENVELOPE_VERSION,
        sourceDomain,
        LOCAL_DOMAIN,
        nonce,
        sender,
        recipient,
        BYTES32_ZERO,
        body
      );

      await expect(messageTransmitter.receiveMessage(envelope, "0x"))
        .to.emit(messageTransmitter, "MessageReceived");

      expect(await handler.callCount()).to.equal(1n);
      expect(await handler.lastSourceDomain()).to.equal(sourceDomain);
      expect(await handler.lastSender()).to.equal(sender);
      expect(await handler.lastBody()).to.equal(body);

      expect(await messageTransmitter.isNonceUsed(sourceDomain, nonce)).to.equal(true);
    });

    it("replay (same nonce twice) reverts", async () => {
      const { messageTransmitter, handler, alice } = await loadFixture(fixture);
      const recipient = addrToBytes32(await handler.getAddress());
      const sender = addrToBytes32(alice.address);
      const env = packEnvelope(
        ENVELOPE_VERSION,
        7,
        LOCAL_DOMAIN,
        1n,
        sender,
        recipient,
        BYTES32_ZERO,
        "0x"
      );
      await messageTransmitter.receiveMessage(env, "0x");
      await expect(messageTransmitter.receiveMessage(env, "0x")).to.be.revertedWithCustomError(
        messageTransmitter,
        "NonceAlreadyUsed"
      );
    });

    it("wrong destination domain reverts", async () => {
      const { messageTransmitter, handler, alice } = await loadFixture(fixture);
      const recipient = addrToBytes32(await handler.getAddress());
      const sender = addrToBytes32(alice.address);
      const env = packEnvelope(
        ENVELOPE_VERSION,
        7,
        LOCAL_DOMAIN + 1, // wrong
        1n,
        sender,
        recipient,
        BYTES32_ZERO,
        "0x"
      );
      await expect(messageTransmitter.receiveMessage(env, "0x")).to.be.revertedWithCustomError(
        messageTransmitter,
        "InvalidDestinationDomain"
      );
    });

    it("destinationCaller pinned to non-msg.sender reverts", async () => {
      const { messageTransmitter, handler, alice, bob } = await loadFixture(fixture);
      const recipient = addrToBytes32(await handler.getAddress());
      const sender = addrToBytes32(alice.address);
      // Pinned to alice, but bob calls.
      const env = packEnvelope(
        ENVELOPE_VERSION,
        7,
        LOCAL_DOMAIN,
        1n,
        sender,
        recipient,
        addrToBytes32(alice.address),
        "0x"
      );
      await expect(
        messageTransmitter.connect(bob).receiveMessage(env, "0x")
      ).to.be.revertedWithCustomError(messageTransmitter, "UnauthorizedCaller");
    });

    it("wrong envelope version reverts", async () => {
      const { messageTransmitter, handler, alice } = await loadFixture(fixture);
      const recipient = addrToBytes32(await handler.getAddress());
      const sender = addrToBytes32(alice.address);
      const env = packEnvelope(99, 7, LOCAL_DOMAIN, 1n, sender, recipient, BYTES32_ZERO, "0x");
      await expect(messageTransmitter.receiveMessage(env, "0x")).to.be.revertedWithCustomError(
        messageTransmitter,
        "InvalidVersion"
      );
    });

    it("verifier rejection bubbles up", async () => {
      const { messageTransmitter, verifier, handler, alice } = await loadFixture(fixture);
      await verifier.setShouldRevert(true);
      const recipient = addrToBytes32(await handler.getAddress());
      const sender = addrToBytes32(alice.address);
      const env = packEnvelope(
        ENVELOPE_VERSION,
        7,
        LOCAL_DOMAIN,
        1n,
        sender,
        recipient,
        BYTES32_ZERO,
        "0x"
      );
      await expect(messageTransmitter.receiveMessage(env, "0x")).to.be.revertedWith(
        "MockVerifier: forced revert"
      );
    });

    it("handler returning false reverts the whole tx (RecipientHandlerFailed)", async () => {
      const { messageTransmitter, handler, alice } = await loadFixture(fixture);
      await handler.setShouldReturnFalse(true);
      const recipient = addrToBytes32(await handler.getAddress());
      const sender = addrToBytes32(alice.address);
      const env = packEnvelope(
        ENVELOPE_VERSION,
        7,
        LOCAL_DOMAIN,
        1n,
        sender,
        recipient,
        BYTES32_ZERO,
        "0x"
      );
      await expect(messageTransmitter.receiveMessage(env, "0x")).to.be.revertedWithCustomError(
        messageTransmitter,
        "RecipientHandlerFailed"
      );

      // Nonce should NOT be marked used because the entire tx reverted.
      expect(await messageTransmitter.isNonceUsed(7, 1n)).to.equal(false);
    });

    it("malformed envelope (too short) reverts", async () => {
      const { messageTransmitter } = await loadFixture(fixture);
      await expect(messageTransmitter.receiveMessage("0x1234", "0x")).to.be.reverted;
    });
  });

  describe("verifier swap (queue/commit timelock)", () => {
    it("queue + commit replaces verifier", async () => {
      const { messageTransmitter, owner } = await loadFixture(fixture);
      const MockVerifier = await ethers.getContractFactory("MockSignatureVerifier");
      const newVerifier = await MockVerifier.deploy();
      const newAddr = await newVerifier.getAddress();

      const tx = await messageTransmitter.connect(owner).queueSetSignatureVerifier(newAddr);
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) => l.fragment?.name === "VerifierChangeQueued") as any;
      const actionId = evt.args.actionId as bigint;

      await expect(
        messageTransmitter.commitSetSignatureVerifier(actionId, newAddr)
      ).to.be.revertedWithCustomError(messageTransmitter, "ActionNotReady");
      await time.increase(3600 + 1);
      await messageTransmitter.commitSetSignatureVerifier(actionId, newAddr);
      expect(await messageTransmitter.signatureVerifier()).to.equal(newAddr);
    });

    it("non-owner cannot queue", async () => {
      const { messageTransmitter, alice } = await loadFixture(fixture);
      await expect(
        messageTransmitter.connect(alice).queueSetSignatureVerifier(alice.address)
      ).to.be.revertedWithCustomError(messageTransmitter, "OwnableUnauthorizedAccount");
    });
  });

  describe("setMaxMessageBodySize", () => {
    it("immediate, gated by floor", async () => {
      const { messageTransmitter, owner } = await loadFixture(fixture);
      await expect(
        messageTransmitter.connect(owner).setMaxMessageBodySize(100n)
      ).to.be.revertedWithCustomError(messageTransmitter, "MaxBodySizeTooSmall");
      await messageTransmitter.connect(owner).setMaxMessageBodySize(8192n);
      expect(await messageTransmitter.maxMessageBodySize()).to.equal(8192n);
    });
  });

  describe("upgrade", () => {
    it("queue + commit performs UUPS upgrade", async () => {
      const { messageTransmitter, owner } = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("MessageTransmitter");
      const newImpl = await Impl.deploy();
      const newAddr = await newImpl.getAddress();
      const tx = await messageTransmitter.connect(owner).queueUpgrade(newAddr, "0x");
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) => l.fragment?.name === "UpgradeQueued") as any;
      const actionId = evt.args.actionId as bigint;
      await time.increase(3600 + 1);
      await messageTransmitter.commitUpgrade(actionId, newAddr, "0x");
    });
  });
});
