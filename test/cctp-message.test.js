const { expect } = require("chai");
const { ethers } = require("hardhat");

const HASH_PREFIX = ethers.toUtf8Bytes("StableNairaCCTP:v1");

/**
 * Off-chain reference implementation of the CCTP message hash.
 * Must stay byte-for-byte identical to `CCTPMessage.sol` and to
 * `cctp-network/packages/protocol/src/hash.ts`.
 */
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
  const encoded = offChainEncode(m);
  return ethers.keccak256(ethers.concat([HASH_PREFIX, encoded]));
}

function padToBytes32(addr) {
  return ethers.zeroPadValue(addr, 32);
}

describe("CCTPMessage", function () {
  let harness;

  before(async function () {
    const Harness = await ethers.getContractFactory("CCTPMessageHarness");
    harness = await Harness.deploy();
    await harness.waitForDeployment();
  });

  function sampleMessage(overrides = {}) {
    return {
      version: 1,
      sourceDomain: 0,
      destinationDomain: 1,
      nonce: 42n,
      sender: padToBytes32("0x1111111111111111111111111111111111111111"),
      recipient: padToBytes32("0x2222222222222222222222222222222222222222"),
      body: "0xdeadbeef",
      ...overrides,
    };
  }

  it("encodes/decodes a well-formed message losslessly", async function () {
    const m = sampleMessage();
    const encoded = await harness.encode(m);
    const expectedLen = 88 + ethers.dataLength(m.body);
    expect(ethers.dataLength(encoded)).to.equal(expectedLen);

    const decoded = await harness.decode(encoded);
    expect(decoded.version).to.equal(m.version);
    expect(decoded.sourceDomain).to.equal(m.sourceDomain);
    expect(decoded.destinationDomain).to.equal(m.destinationDomain);
    expect(decoded.nonce).to.equal(m.nonce);
    expect(decoded.sender).to.equal(m.sender);
    expect(decoded.recipient).to.equal(m.recipient);
    expect(decoded.body).to.equal(m.body);
  });

  it("matches off-chain digest for empty body", async function () {
    const m = sampleMessage({ body: "0x" });
    const encoded = await harness.encode(m);
    const onChain = await harness.digest(encoded);
    expect(onChain).to.equal(offChainDigest(m));
  });

  it("matches off-chain digest for non-empty body", async function () {
    const m = sampleMessage({ body: "0x0102030405060708090a" });
    const onChain = await harness.hashOf(m);
    expect(onChain).to.equal(offChainDigest(m));
  });

  it("is sensitive to every header field", async function () {
    const base = sampleMessage();
    const baseDigest = await harness.hashOf(base);

    const mutations = [
      { version: 2 },
      { sourceDomain: 1 },
      { destinationDomain: 0 },
      { nonce: 43n },
      { sender: padToBytes32("0x3333333333333333333333333333333333333333") },
      { recipient: padToBytes32("0x4444444444444444444444444444444444444444") },
      { body: "0xdeadbeee" },
    ];

    for (const mut of mutations) {
      const variant = { ...base, ...mut };
      const variantDigest = await harness.hashOf(variant);
      const mutLabel = Object.keys(mut).join(",");
      expect(variantDigest, `mutation ${mutLabel} should change digest`).to.not.equal(baseDigest);
    }
  });

  it("rejects truncated messages", async function () {
    const m = sampleMessage();
    const encoded = await harness.encode(m);
    const truncated = ethers.dataSlice(encoded, 0, ethers.dataLength(encoded) - 1);
    await expect(harness.decode(truncated)).to.be.revertedWithCustomError(
      harness,
      "InvalidMessageLength",
    );
  });

  it("rejects messages with a wrong declared body length", async function () {
    const m = sampleMessage();
    const encoded = await harness.encode(m);
    // Flip the bodyLength byte (offset 84..88) to a larger value.
    const bytes = ethers.getBytes(encoded);
    bytes[87] = (bytes[87] + 1) & 0xff;
    const tampered = ethers.hexlify(bytes);
    await expect(harness.decode(tampered)).to.be.revertedWithCustomError(
      harness,
      "InvalidMessageLength",
    );
  });
});
