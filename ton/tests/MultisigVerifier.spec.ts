import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Cell, beginCell, toNano } from "@ton/core";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import "@ton/test-utils";
import { MultisigVerifier } from "../build/MultisigVerifier/tact_MultisigVerifier";

// Golden-vector parity with core/contracts/cctp/verifiers/MultisigVerifier.sol:
// attestation = t × 65-byte (r‖s‖v) sigs, sorted ascending by EVM signer
// address, v∈{27,28}, EIP-2 low-s. Built exactly as the EVM relayer would.

type Signer = { priv: Uint8Array; addr: bigint };

const SECP_N = secp256k1.CURVE.n;

const makeSigner = (): Signer => {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false).slice(1); // X||Y
  const addr = BigInt(
    "0x" + Buffer.from(keccak_256(pub).slice(12)).toString("hex"),
  );
  return { priv, addr };
};

const sign = (digest: Uint8Array, priv: Uint8Array, lowS = true) => {
  let sig = secp256k1.sign(digest, priv, { lowS });
  let s = sig.s;
  let recovery = sig.recovery;
  if (!lowS && sig.s <= SECP_N / 2n) {
    // force the malleable high-s twin
    s = SECP_N - sig.s;
    recovery = recovery ^ 1;
  }
  return { r: sig.r, s, v: BigInt(recovery + 27) };
};

// one 520-bit sig per cell (1023-bit cell limit), ascending, ref-chained
const buildAttestation = (
  sigs: { r: bigint; s: bigint; v: bigint }[],
): Cell => {
  let next: Cell | null = null;
  for (let i = sigs.length - 1; i >= 0; i--) {
    const b = beginCell()
      .storeUint(sigs[i].r, 256)
      .storeUint(sigs[i].s, 256)
      .storeUint(sigs[i].v, 8);
    if (next) b.storeRef(next);
    next = b.endCell();
  }
  return next ?? beginCell().endCell();
};

describe("Phase 2 — MultisigVerifier golden-vector parity", () => {
  let chain: Blockchain;
  let registry: SandboxContract<TreasuryContract>;
  let verifier: SandboxContract<MultisigVerifier>;
  let signers: Signer[];
  const digest = keccak_256(Buffer.from("snr-cctp-message", "utf8"));
  const digestBig = BigInt("0x" + Buffer.from(digest).toString("hex"));

  const seed = async (set: Signer[], threshold: number) => {
    for (const sg of set) {
      await verifier.send(registry.getSender(), { value: toNano("0.05") }, {
        $$type: "SyncAddValidator",
        validator: sg.addr,
      });
    }
    await verifier.send(registry.getSender(), { value: toNano("0.05") }, {
      $$type: "SyncSetThreshold",
      newThreshold: BigInt(threshold),
    });
  };

  const attestationFor = (set: Signer[], lowS = true): Cell => {
    const ordered = [...set].sort((a, b) => (a.addr < b.addr ? -1 : 1));
    return buildAttestation(
      ordered.map((sg) => sign(digest, sg.priv, lowS)),
    );
  };

  beforeEach(async () => {
    chain = await Blockchain.create();
    registry = await chain.treasury("registry");
    verifier = chain.openContract(
      await MultisigVerifier.fromInit(registry.address),
    );
    await verifier.send(registry.getSender(), { value: toNano("0.1") },
      beginCell().endCell().asSlice());
    signers = Array.from({ length: 5 }, makeSigner);
  });

  it("accepts a valid quorum (3-of-5) sorted ascending", async () => {
    await seed(signers, 3);
    const quorum = [...signers].sort((a, b) => (a.addr < b.addr ? -1 : 1)).slice(0, 3);
    expect(await verifier.getVerify(digestBig, attestationFor(quorum))).toBe(0n);
  });

  it("only the registry can mutate the validator mirror", async () => {
    const stranger = await chain.treasury("stranger");
    const r = await verifier.send(stranger.getSender(), { value: toNano("0.05") }, {
      $$type: "SyncAddValidator",
      validator: signers[0].addr,
    });
    expect(r.transactions).toHaveTransaction({ to: verifier.address, success: false });
  });

  it("rejects signatures not strictly ascending (and duplicates)", async () => {
    await seed(signers, 2);
    const two = [...signers].sort((a, b) => (a.addr < b.addr ? -1 : 1)).slice(0, 2);
    const descending = buildAttestation(
      [two[1], two[0]].map((sg) => sign(digest, sg.priv)),
    );
    await expect(verifier.getVerify(digestBig, descending)).rejects.toThrow();

    const dup = buildAttestation([
      sign(digest, two[0].priv),
      sign(digest, two[0].priv),
    ]);
    await expect(verifier.getVerify(digestBig, dup)).rejects.toThrow();
  });

  it("rejects a signer that is not in the validator set", async () => {
    await seed(signers.slice(0, 3), 2);
    const outsider = makeSigner();
    const set = [signers[0], outsider].sort((a, b) => (a.addr < b.addr ? -1 : 1));
    await expect(verifier.getVerify(digestBig, attestationFor(set))).rejects.toThrow();
  });

  it("rejects a malleable high-s signature (EIP-2)", async () => {
    await seed(signers, 1);
    const one = [signers.sort((a, b) => (a.addr < b.addr ? -1 : 1))[0]];
    await expect(
      verifier.getVerify(digestBig, attestationFor(one, false)),
    ).rejects.toThrow();
  });

  it("rejects wrong attestation length / unset threshold", async () => {
    // threshold unset
    await expect(
      verifier.getVerify(digestBig, attestationFor(signers.slice(0, 1))),
    ).rejects.toThrow();
    // threshold 3 but only 2 sigs supplied
    await seed(signers, 3);
    const two = [...signers].sort((a, b) => (a.addr < b.addr ? -1 : 1)).slice(0, 2);
    await expect(verifier.getVerify(digestBig, attestationFor(two))).rejects.toThrow();
  });
});
