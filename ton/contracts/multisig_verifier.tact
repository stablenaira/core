// MultisigVerifier — Tact port of core/contracts/cctp/verifiers/MultisigVerifier.sol
//
// EVM parity rules (verified by golden vectors vs OZ ECDSA semantics):
//   - attestation = `threshold` × 65-byte (r‖s‖v) signatures
//   - signers strictly ascending by recovered EVM address (O(t) dup detection)
//   - v ∈ {27,28}; EIP-2 low-s enforced (s ≤ secp256k1n/2); r,s in range
//   - every recovered signer must be in the validator set
//
// TON divergence (necessary, documented): EVM `verify` STATICCALLs the
// registry synchronously. TON is async, so this contract holds a **mirror**
// of the validator set + threshold, mutated ONLY by authenticated messages
// from its configured `registry`. Verification then runs locally — exactly
// what Phase 3's MessageTransmitter needs inside one receiveMessage tx.
//
// Failure = thrown exception (mirrors EVM revert). Success = verify() == 0.

struct PubKey { h: Int; x1: Int; x2: Int }

asm fun keccak256OfSlice(s: Slice): Int { 1 PUSHINT HASHEXT_KECCAK256 }
asm fun ecrecoverRaw(hash: Int, v: Int, r: Int, s: Int): PubKey { ECRECOVER DROP }

// secp256k1 group order N and OZ's EIP-2 low-s ceiling (N/2 floor).
const SECP256K1_N: Int = 115792089237316195423570985008687907852837564279074904382605163141518161494337;
const SECP256K1_HALF_N: Int = 57896044618658097711785492504343953926418782139537452191302581570759080747168;
const ADDR_MASK: Int = 1461501637330902918203684832716283019655932542975; // 2^160 - 1

message(0x564c5201) SyncAddValidator { validator: Int as uint256 }
message(0x564c5202) SyncRemoveValidator { validator: Int as uint256 }
message(0x564c5203) SyncSetThreshold { newThreshold: Int as uint32 }

contract MultisigVerifier {
    registry: Address;            // only source allowed to mutate the mirror
    threshold: Int as uint32;
    validators: map<Int, Bool>;   // EVM address (uint160) -> member

    init(registry: Address) {
        self.registry = registry;
        self.threshold = 0;
    }

    fun onlyRegistry() {
        require(sender() == self.registry, "not registry");
    }

    receive(msg: SyncAddValidator) {
        self.onlyRegistry();
        self.validators.set(msg.validator, true);
    }

    receive(msg: SyncRemoveValidator) {
        self.onlyRegistry();
        self.validators.set(msg.validator, false);
    }

    receive(msg: SyncSetThreshold) {
        self.onlyRegistry();
        self.threshold = msg.newThreshold;
    }

    receive(_: Slice) {}

    // Recover the 20-byte EVM signer address from one (v,r,s) over `digest`.
    fun recoverSigner(digest: Int, v: Int, r: Int, s: Int): Int {
        require(v == 27 || v == 28, "bad v");
        require(r >= 1 && r < SECP256K1_N, "bad r");
        require(s >= 1 && s <= SECP256K1_HALF_N, "bad s (EIP-2)");
        let pk: PubKey = ecrecoverRaw(digest, v - 27, r, s);
        let body: Slice = beginCell()
            .storeUint(pk.x1, 256)
            .storeUint(pk.x2, 256)
            .endCell()
            .beginParse();
        let signer: Int = keccak256OfSlice(body) & ADDR_MASK;
        require(signer != 0, "recovery failed");
        return signer;
    }

    // Attestation is a ref-chain of cells, one 520-bit (r256‖s256‖v8)
    // signature per cell (1023-bit cell limit forbids two per cell), in
    // strictly-ascending signer order. Returns 0 on success; throws on any
    // failure (EVM-revert parity).
    get fun verify(digest: Int, attestation: Cell): Int {
        let t: Int = self.threshold;
        require(t >= 1, "threshold unset");
        let cur: Slice = attestation.beginParse();
        let previous: Int = 0;
        let i: Int = 0;
        while (i < t) {
            let r: Int = cur.loadUint(256);
            let s: Int = cur.loadUint(256);
            let v: Int = cur.loadUint(8);
            let signer: Int = self.recoverSigner(digest, v, r, s);
            require(signer > previous, "not strictly ascending");
            require(self.validators.get(signer) == true, "signer not validator");
            previous = signer;
            i = i + 1;
            if (i < t) {
                cur = cur.loadRef().beginParse();
            }
        }
        return 0;
    }

    get fun thresholdValue(): Int { return self.threshold }
    get fun isValidator(a: Int): Bool { return self.validators.get(a) == true }
    get fun registryAddress(): Address { return self.registry }
}
