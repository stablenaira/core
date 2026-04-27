const { expect } = require("chai");
const { ethers } = require("hardhat");
const { sha256 } = require("@noble/hashes/sha256");

/**
 * Parity test for BLS12381Verifier.expandMessageXmd against a self-contained
 * JavaScript reference implementation of RFC 9380 §5.3.1.
 *
 * Rationale: hashToG2 itself requires the EIP-2537 precompiles, which are not
 * available in a default Hardhat network. expand_message_xmd only uses SHA-256
 * (precompile 0x02, always available), so we can assert on-chain bit-for-bit
 * equality without a forked environment. A bug in `hashToField` downstream
 * would manifest here first because it depends entirely on this output.
 */

function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function i2osp(value, length) {
  const out = new Uint8Array(length);
  let v = BigInt(value);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("i2osp overflow");
  return out;
}

function xorArrays(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function expandMessageXmdRef(msg, dst, lenInBytes) {
  const bInBytes = 32;
  const sInBytes = 64;
  const ell = Math.ceil(lenInBytes / bInBytes);
  if (ell > 255) throw new Error("ell too large");
  if (dst.length > 255) throw new Error("dst too long");

  const dstPrime = concatBytes(dst, i2osp(dst.length, 1));
  const zPad = new Uint8Array(sInBytes);
  const lIbStr = i2osp(lenInBytes, 2);

  const msgPrime = concatBytes(zPad, msg, lIbStr, i2osp(0, 1), dstPrime);

  const b0 = sha256(msgPrime);
  const b = [b0];

  const b1 = sha256(concatBytes(b0, i2osp(1, 1), dstPrime));
  b.push(b1);

  for (let i = 2; i <= ell; i++) {
    const xored = xorArrays(b0, b[i - 1]);
    const bi = sha256(concatBytes(xored, i2osp(i, 1), dstPrime));
    b.push(bi);
  }

  const uniform = new Uint8Array(lenInBytes);
  let written = 0;
  for (let i = 1; i <= ell && written < lenInBytes; i++) {
    for (let j = 0; j < bInBytes && written < lenInBytes; j++) {
      uniform[written++] = b[i][j];
    }
  }
  return uniform;
}

describe("BLS12381Verifier.expandMessageXmd parity", function () {
  let verifier;

  before(async function () {
    const [admin] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("StableNairaCCTPDeployer");
    const deployer = await Factory.deploy();
    await deployer.waitForDeployment();

    const dst = ethers.hexlify(
      ethers.toUtf8Bytes("STABLENAIRA_CCTP_BLS12381G2_XMD:SHA-256_SSWU_RO_v1"),
    );
    const dummyCofactor = "0x01";
    const tx = await deployer.deployVerifier(admin.address, dummyCofactor, dst);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return deployer.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "Deployed");
    verifier = await ethers.getContractAt("BLS12381Verifier", ev.args.proxy);
  });

  const DST = new TextEncoder().encode("STABLENAIRA_CCTP_BLS12381G2_XMD:SHA-256_SSWU_RO_v1");

  const cases = [
    { name: "empty message, 32 bytes out", msg: new Uint8Array(0), len: 32 },
    { name: "32-byte digest, 256 bytes out (hash_to_field fan-out)", msg: sha256(new TextEncoder().encode("stablenaira")), len: 256 },
    { name: "short message, 64 bytes out", msg: new TextEncoder().encode("abc"), len: 64 },
    { name: "medium message, 128 bytes out", msg: new TextEncoder().encode("a".repeat(128)), len: 128 },
  ];

  for (const c of cases) {
    it(`matches reference for ${c.name}`, async function () {
      const expected = expandMessageXmdRef(c.msg, DST, c.len);
      const actualHex = await verifier.expandMessageXmd(
        ethers.hexlify(c.msg),
        c.len,
      );
      const expectedHex = ethers.hexlify(expected);
      expect(actualHex).to.equal(expectedHex);
    });
  }
});
