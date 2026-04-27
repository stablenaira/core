const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * End-to-end parity test.
 *
 * Deploys the full `MessageTransmitter` proxy (behind `StableNairaCCTPDeployer`),
 * calls `sendMessage(...)`, captures the `MessageSent` event, then:
 *   1. Decodes the emitted `message` bytes back to a structured message using
 *      the on-chain harness's `decode()` (proves round-trip).
 *   2. Recomputes the digest off-chain and compares to `CCTPMessage.digest()`
 *      for the same encoded payload (proves cross-impl hash parity).
 *   3. Confirms sender/recipient/nonce in the event match the decoded body.
 *
 * This closes the loop between the Solidity sender, the wire format used by
 * the off-chain observer, and the hash the attester actually signs.
 */

const HASH_PREFIX = ethers.toUtf8Bytes("StableNairaCCTP:v1");

function offChainEncode(m) {
  return ethers.solidityPacked(
    ["uint32", "uint32", "uint32", "uint64", "bytes32", "bytes32", "uint32", "bytes"],
    [
      m.version,
      m.sourceDomain,
      m.destinationDomain,
      m.nonce,
      m.sender,
      m.recipient,
      ethers.dataLength(m.body),
      m.body,
    ],
  );
}

function offChainDigest(m) {
  return ethers.keccak256(ethers.concat([HASH_PREFIX, offChainEncode(m)]));
}

function padAddressToBytes32(addr) {
  return ethers.zeroPadValue(addr, 32);
}

describe("MessageTransmitter → off-chain decode parity", function () {
  const LOCAL_DOMAIN = 0;
  const DEST_DOMAIN = 1;
  const BODY = "0xdeadbeefcafef00d";

  let deployer;
  let admin;
  let governor;
  let pauser;
  let sender;
  let transmitter;
  let harness;

  before(async function () {
    [admin, governor, pauser, sender] = await ethers.getSigners();

    // Deploy a BLS verifier (only used for receiveMessage; irrelevant here).
    const Factory = await ethers.getContractFactory("StableNairaCCTPDeployer");
    deployer = await Factory.deploy();
    await deployer.waitForDeployment();

    // Any non-empty bytes work for this parity test; hashToG2 isn't exercised
    // here. Real deployments inject the RFC 9380 cofactor via Ignition params.
    const dummyCofactor = "0x01";
    const dummyDst = ethers.hexlify(
      ethers.toUtf8Bytes("STABLENAIRA_CCTP_BLS12381G2_XMD:SHA-256_SSWU_RO_v1"),
    );
    const verifierTx = await deployer.deployVerifier(admin.address, dummyCofactor, dummyDst);
    const verifierReceipt = await verifierTx.wait();
    const verifierEv = verifierReceipt.logs
      .map((l) => {
        try {
          return deployer.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "Deployed");
    const verifierAddr = verifierEv.args.proxy;

    // Registry with threshold=0 so the pipeline would accept an empty bitmap
    // if we ever called receiveMessage here (not done in this test).
    const registryTx = await deployer.deployValidatorRegistry(
      admin.address,
      governor.address,
      3600,
      0,
    );
    const registryReceipt = await registryTx.wait();
    const registryEv = registryReceipt.logs
      .map((l) => {
        try {
          return deployer.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "Deployed" && p.args.kind === ethers.id("ValidatorRegistry"));
    const registryAddr = registryEv.args.proxy;

    const transmitterTx = await deployer.deployMessageTransmitter(
      admin.address,
      governor.address,
      pauser.address,
      LOCAL_DOMAIN,
      registryAddr,
      verifierAddr,
    );
    const transmitterReceipt = await transmitterTx.wait();
    const transmitterEv = transmitterReceipt.logs
      .map((l) => {
        try {
          return deployer.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "Deployed" && p.args.kind === ethers.id("MessageTransmitter"));
    const transmitterAddr = transmitterEv.args.proxy;

    transmitter = await ethers.getContractAt("MessageTransmitter", transmitterAddr);

    const Harness = await ethers.getContractFactory("CCTPMessageHarness");
    harness = await Harness.deploy();
    await harness.waitForDeployment();
  });

  it("sendMessage emits bytes that round-trip and produce a matching digest off-chain", async function () {
    const recipient = padAddressToBytes32("0x2222222222222222222222222222222222222222");
    const tx = await transmitter
      .connect(sender)
      .sendMessage(DEST_DOMAIN, recipient, BODY);
    const receipt = await tx.wait();

    const sentLog = receipt.logs
      .map((l) => {
        try {
          return transmitter.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "MessageSent");

    expect(sentLog, "MessageSent must be emitted").to.not.be.undefined;
    const { sourceDomain, destinationDomain, nonce, sender: evSender, recipient: evRecipient, message } = sentLog.args;

    expect(Number(sourceDomain)).to.equal(LOCAL_DOMAIN);
    expect(Number(destinationDomain)).to.equal(DEST_DOMAIN);
    expect(Number(nonce)).to.equal(0);
    expect(evSender).to.equal(padAddressToBytes32(sender.address));
    expect(evRecipient).to.equal(recipient);

    // Re-decode the emitted bytes via the on-chain harness.
    const decoded = await harness.decode(message);
    expect(Number(decoded.version)).to.equal(1);
    expect(Number(decoded.sourceDomain)).to.equal(LOCAL_DOMAIN);
    expect(Number(decoded.destinationDomain)).to.equal(DEST_DOMAIN);
    expect(decoded.nonce).to.equal(0n);
    expect(decoded.sender).to.equal(padAddressToBytes32(sender.address));
    expect(decoded.recipient).to.equal(recipient);
    expect(decoded.body).to.equal(BODY);

    // The attester will sign `digest`. It must be identical whether computed
    // on-chain or by the off-chain pipeline from the same emitted `message`.
    const onChainDigest = await harness.digest(message);
    const offChain = offChainDigest({
      version: Number(decoded.version),
      sourceDomain: Number(decoded.sourceDomain),
      destinationDomain: Number(decoded.destinationDomain),
      nonce: decoded.nonce,
      sender: decoded.sender,
      recipient: decoded.recipient,
      body: decoded.body,
    });
    expect(onChainDigest).to.equal(offChain);
  });

  it("allocates monotonically increasing nonces", async function () {
    const recipient = padAddressToBytes32("0x3333333333333333333333333333333333333333");
    const before = await transmitter.nextNonce();
    await (await transmitter.connect(sender).sendMessage(DEST_DOMAIN, recipient, "0x01")).wait();
    await (await transmitter.connect(sender).sendMessage(DEST_DOMAIN, recipient, "0x02")).wait();
    const after = await transmitter.nextNonce();
    expect(after - before).to.equal(2n);
  });

  it("rejects sendMessage to localDomain", async function () {
    const recipient = padAddressToBytes32("0x4444444444444444444444444444444444444444");
    await expect(
      transmitter.connect(sender).sendMessage(LOCAL_DOMAIN, recipient, "0x"),
    ).to.be.revertedWithCustomError(transmitter, "InvalidDestinationDomain");
  });
});
