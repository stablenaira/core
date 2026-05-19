// Phase 0 de-risking spike.
//
// The entire cross-chain design rests on two TVM capabilities being available
// and behaving identically to their EVM counterparts:
//
//   1. keccak256  — EVM attestation digests are keccak256, not sha256. TON must
//                    reconstruct the exact EVM byte layout and keccak it.
//   2. secp256k1 ecrecover — validators keep their ECDSA secp256k1 keys; TON
//                    must recover the signer so one signature verifies on both
//                    chains.
//
// This contract exposes both as getters so the Jest/Sandbox test can assert
// them against @noble vectors. If the asm mnemonics or stack effects are wrong,
// the build or the test fails loudly — which is the point of the spike.

struct PubKey {
    // Uncompressed secp256k1 point as TVM ECRECOVER returns it:
    //   h  = 1-byte prefix (0x04 for uncompressed)
    //   x1 = 32-byte X coordinate
    //   x2 = 32-byte Y coordinate
    // Ethereum address = keccak256(x1 || x2)[12:32]
    h: Int;
    x1: Int;
    x2: Int;
}

// HASHEXT_KECCAK256 hashes the concatenated data bits of N stack slices.
// Tact has already pushed `s`; we push the count 1 and invoke the opcode.
asm fun keccak256OfSlice(s: Slice): Int { 1 PUSHINT HASHEXT_KECCAK256 }

// ECRECOVER stack: hash v r s -> (h x1 x2 -1) on success, (0) on failure.
// The spike only feeds valid signatures, so we drop the success flag and let
// the remaining three values map onto PubKey (x2 = top of stack = last field).
asm fun ecrecoverRaw(hash: Int, v: Int, r: Int, s: Int): PubKey { ECRECOVER DROP }

contract SpikeCrypto {
    init() {}

    receive() {}

    get fun keccakHash(data: Slice): Int {
        return keccak256OfSlice(data);
    }

    get fun recover(hash: Int, v: Int, r: Int, s: Int): PubKey {
        return ecrecoverRaw(hash, v, r, s);
    }
}
