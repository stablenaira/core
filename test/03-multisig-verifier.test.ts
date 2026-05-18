import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Wallet } from "ethers";

import { deployMultisigVerifier, deployValidatorRegistry } from "./helpers/fixtures";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Sign `digest` (32 bytes) with `signer` and return concatenated r||s||v (65 bytes hex). */
async function signDigest(signer: any, digest: string): Promise<string> {
  const sig = await signer.signMessage(ethers.getBytes(digest));
  // signMessage prefixes; for raw digest signing, use ECDSA-recovery against the prefixed digest.
  // We don't want EIP-191 prefix here; verifier uses the raw digest. So sign raw.
  return sig;
}

/**
 * Sign a raw digest (no EIP-191 prefix) — what MultisigVerifier expects.
 * Hardhat signers expose `signingKey().sign(digest)` for this.
 */
async function signRaw(signer: any, digest: string): Promise<string> {
  // ethers v6 Wallet has `signingKey`; HardhatEthersSigner wraps it.
  // Use signTypedData? No — verifier just hashes raw bytes32. We need signer.signingKey().sign(digest).
  const wallet = signer; // HardhatEthersSigner doesn't expose signingKey directly
  // Use low-level: build a Wallet from the private key. For hardhat signers,
  // private keys are exposed via the test config.
  // Simpler: create wallets up front.
  throw new Error("use Wallet helper instead");
}

/**
 * Build attestation = concatenated 65-byte sigs (r||s||v) sorted ascending by signer address.
 */
function buildAttestation(signatures: { signer: string; sig: string }[]): string {
  const sorted = [...signatures].sort((a, b) =>
    a.signer.toLowerCase().localeCompare(b.signer.toLowerCase())
  );
  return "0x" + sorted.map((s) => s.sig.slice(2)).join("");
}

describe("MultisigVerifier", () => {
  // Use raw Wallet instances so we can sign digests without EIP-191 prefix.
  const w1 = new ethers.Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // hh #1
  const w2 = new ethers.Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // hh #2
  const w3 = new ethers.Wallet("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // hh #3
  const wOutsider = new ethers.Wallet(
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
  ); // hh #4

  async function fixture() {
    const [owner] = await ethers.getSigners();
    // Validators = w1, w2, w3 with threshold 2.
    const { validatorRegistry } = await deployValidatorRegistry(
      [w1.address, w2.address, w3.address],
      2n,
      owner.address
    );
    const { verifier } = await deployMultisigVerifier(await validatorRegistry.getAddress());
    return { verifier, validatorRegistry, owner };
  }

  function digestOf(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
  }

  function rawSign(wallet: Wallet, digest: string): string {
    // ethers v6: use signingKey.sign(digest) for raw signing (no EIP-191 prefix).
    const sig = wallet.signingKey.sign(digest);
    // sig.serialized = r||s||v (65 bytes hex)
    return sig.serialized;
  }

  it("rejects zero registry at construction", async () => {
    const Verifier = await ethers.getContractFactory("MultisigVerifier");
    await expect(Verifier.deploy(ZERO)).to.be.revertedWithCustomError(Verifier, "ZeroRegistry");
  });

  it("verifies threshold sigs sorted ascending", async () => {
    const { verifier } = await loadFixture(fixture);
    const digest = digestOf("hello world");
    const s1 = rawSign(w1, digest);
    const s2 = rawSign(w2, digest);
    const att = buildAttestation([
      { signer: w1.address, sig: s1 },
      { signer: w2.address, sig: s2 },
    ]);
    await expect(verifier.verify(digest, att)).to.not.be.reverted;
  });

  it("rejects wrong-length attestation", async () => {
    const { verifier } = await loadFixture(fixture);
    const digest = digestOf("hello");
    const s1 = rawSign(w1, digest);
    const att = "0x" + s1.slice(2); // only 1 sig, threshold = 2
    await expect(verifier.verify(digest, att)).to.be.revertedWithCustomError(
      verifier,
      "InvalidAttestationLength"
    );
  });

  it("rejects unsorted (descending) signers", async () => {
    const { verifier } = await loadFixture(fixture);
    const digest = digestOf("ord");
    const s1 = rawSign(w1, digest);
    const s2 = rawSign(w2, digest);
    // Determine which address is larger to manually mis-sort.
    const a1 = BigInt(w1.address);
    const a2 = BigInt(w2.address);
    const [bigSig, smallSig] = a1 > a2 ? [s1, s2] : [s2, s1];
    const att = "0x" + bigSig.slice(2) + smallSig.slice(2);
    await expect(verifier.verify(digest, att)).to.be.revertedWithCustomError(
      verifier,
      "SignersNotStrictlyAscending"
    );
  });

  it("rejects duplicate signer (same sig twice)", async () => {
    const { verifier } = await loadFixture(fixture);
    const digest = digestOf("dup");
    const s1 = rawSign(w1, digest);
    const att = "0x" + s1.slice(2) + s1.slice(2);
    await expect(verifier.verify(digest, att)).to.be.revertedWithCustomError(
      verifier,
      "SignersNotStrictlyAscending"
    );
  });

  it("rejects signer outside validator set", async () => {
    const { verifier } = await loadFixture(fixture);
    const digest = digestOf("outsider");
    const s1 = rawSign(w1, digest);
    const sX = rawSign(wOutsider, digest);
    const att = buildAttestation([
      { signer: w1.address, sig: s1 },
      { signer: wOutsider.address, sig: sX },
    ]);
    await expect(verifier.verify(digest, att)).to.be.revertedWithCustomError(
      verifier,
      "SignerNotValidator"
    );
  });

  it("rejects malformed sig (sig signed for different digest)", async () => {
    // A sig recovers to *some* address; if that address isn't a validator, we
    // get SignerNotValidator. Build a sig over a different digest from a valid
    // signer to demonstrate cross-digest rejection.
    const { verifier } = await loadFixture(fixture);
    const digest = digestOf("expected");
    const wrongDigest = digestOf("different");
    const s1 = rawSign(w1, digest);
    const sWrong = rawSign(w2, wrongDigest);
    const att = buildAttestation([
      { signer: w1.address, sig: s1 },
      { signer: w2.address, sig: sWrong },
    ]);
    // Verifier recovers from `digest` not `wrongDigest`, so sWrong recovers to a
    // non-validator (or one not in expected order). Either error is acceptable.
    await expect(verifier.verify(digest, att)).to.be.reverted;
  });
});
