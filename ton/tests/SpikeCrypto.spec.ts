import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { beginCell, toNano } from "@ton/core";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import "@ton/test-utils";
import { SpikeCrypto } from "../build/SpikeCrypto/tact_SpikeCrypto";

// Phase 0 gate: prove the two TVM opcodes the cross-chain design depends on
// behave byte-identically to their EVM counterparts. If either assertion
// fails, the secp256k1-on-both-chains attestation model is not viable as-is.

const toBuf32 = (x: bigint): Uint8Array => {
  const b = Buffer.alloc(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
};

const ethAddress = (uncompressedPub: Uint8Array): string => {
  // uncompressedPub = 0x04 || X(32) || Y(32); address = keccak256(X||Y)[12:]
  const h = keccak_256(uncompressedPub.slice(1));
  return Buffer.from(h.slice(12)).toString("hex");
};

describe("Phase 0 spike — TVM keccak256 + secp256k1 ecrecover", () => {
  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let spike: SandboxContract<SpikeCrypto>;

  beforeAll(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury("deployer");
    spike = blockchain.openContract(await SpikeCrypto.fromInit());
    const r = await spike.send(deployer.getSender(), { value: toNano("0.1") }, null);
    expect(r.transactions).toHaveTransaction({
      to: spike.address,
      deploy: true,
      success: true,
    });
  });

  it("HASHEXT_KECCAK256 == EVM keccak256(bytes)", async () => {
    const msg = Buffer.from("stablenaira-ton-cctp-phase0", "utf8"); // < 127 bytes
    const expected = BigInt(
      "0x" + Buffer.from(keccak_256(msg)).toString("hex"),
    );
    const slice = beginCell().storeBuffer(msg).endCell().beginParse();
    const got = await spike.getKeccakHash(slice);
    expect(got).toEqual(expected);
  });

  it("ECRECOVER recovers the EVM signer address from a secp256k1 signature", async () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, false); // 65B uncompressed
    const expectedAddr = ethAddress(pub);

    // 32-byte digest, exactly as the EVM verifier would compute it
    const digest = keccak_256(Buffer.from("attestation-payload", "utf8"));
    const digestBig = BigInt("0x" + Buffer.from(digest).toString("hex"));

    const sig = secp256k1.sign(digest, priv);
    const recovered = await spike.getRecover(
      digestBig,
      BigInt(sig.recovery), // 0 / 1 yParity
      sig.r,
      sig.s,
    );

    const x = toBuf32(recovered.x1);
    const y = toBuf32(recovered.x2);
    const reconstructed = Buffer.from(
      keccak_256(Buffer.concat([x, y])).slice(12),
    ).toString("hex");

    expect(reconstructed).toEqual(expectedAddr);
  });
});
