// MessageTransmitter — Tact port of core/contracts/cctp/MessageTransmitter.sol
//
// EVM parity:
//   - sendMessage: whenNotPaused, dst != localDomain, body <= maxBodySize,
//     nonce = nextNonce++, emit packed 116-byte envelope + body
//   - receiveMessage: verify domain-separated attestation FIRST, decode,
//     version/destinationDomain/destinationCaller checks, replay mark BEFORE
//     handler, dispatch to recipient handler; on handler failure roll back
//   - attestationDigest = keccak256(abi.encode(
//        TYPEHASH, keccak256(envelope), chainId, transmitter))
//
// TON divergences (documented):
//   - async: verification is embedded here over a registry-synced validator
//     mirror (EVM STATICCALLs a separate verifier). The standalone
//     MultisigVerifier (Phase 2) remains the algorithm reference / getter.
//   - `chainId` and `transmitter` are configured per-deployment ids (TON has
//     no EVM chainId/address); the digest *algorithm* is byte-identical so
//     attesters compute the same value. transmitter = configured uint160 id.
//   - handler dispatch is an async bounceable message; a bounce rolls back
//     the used-nonce mark (mirrors EVM revert-rollback).
//   - keccak over a >127-byte message uses a cell ref-chain (snake), max 4
//     chunks (508 B) — covers 116-byte envelope + 132-byte BurnMessage.

struct PubKey { h: Int; x1: Int; x2: Int }

asm fun ecrecoverRaw(hash: Int, v: Int, r: Int, s: Int): PubKey { ECRECOVER DROP }
asm fun tvmSetCode(code: Cell) { SETCODE }
asm fun kc1(a: Slice): Int { 1 PUSHINT HASHEXT_KECCAK256 }
asm fun kc2(a: Slice, b: Slice): Int { 2 PUSHINT HASHEXT_KECCAK256 }
asm fun kc3(a: Slice, b: Slice, c: Slice): Int { 3 PUSHINT HASHEXT_KECCAK256 }
asm fun kc4(a: Slice, b: Slice, c: Slice, d: Slice): Int { 4 PUSHINT HASHEXT_KECCAK256 }

const SECP256K1_N: Int = 115792089237316195423570985008687907852837564279074904382605163141518161494337;
const SECP256K1_HALF_N: Int = 57896044618658097711785492504343953926418782139537452191302581570759080747168;
const ADDR_MASK: Int = 1461501637330902918203684832716283019655932542975;
// keccak256("StableNairaCCTPAttestation(bytes32 envelopeHash,uint256 chainId,address transmitter)")
const ATTESTATION_TYPEHASH: Int = 52071672905609786405512957009521980421282899230143005476001486625159120356177;
const ENVELOPE_VERSION: Int = 1;
const MIN_MAX_BODY_SIZE: Int = 132;
const UPGRADE_TIMELOCK: Int = 3600; // 1h, EVM UUPS-timelock parity

message(0x564c5201) SyncAddValidator { validator: Int as uint256 }
message(0x564c5202) SyncRemoveValidator { validator: Int as uint256 }
message(0x564c5203) SyncSetThreshold { newThreshold: Int as uint32 }

message(0x55504700) QueueUpgrade { codeHash: Int as uint256 }
message(0x55504701) CommitUpgrade { code: Cell }
message(0x55504702) CancelUpgrade {}

message(0x4d540100) SetRegistry { registry: Address }
message(0x4d540101) MtSetPaused { paused: Bool }
message(0x4d540102) MtSetMaxBodySize { newMax: Int as uint32 }
message(0x4d540110) SendMessage {
    destinationDomain: Int as uint32;
    recipient: Int as uint256;
    destinationCaller: Int as uint256; // 0 = anyone
    body: Cell;
}
message(0x4d540111) ReceiveMessage {
    message: Cell;       // packed envelope snake
    attestation: Cell;   // 1-sig-per-cell ref-chain
}
// transmitter -> recipient handler
message(0x4d540120) HandleReceiveMessage {
    sourceDomain: Int as uint32;
    nonce: Int as uint64;
    sender: Int as uint256;
    body: Cell;
}

contract MessageTransmitter {
    owner: Address;
    registry: Address;
    localDomain: Int as uint32;
    chainId: Int as uint256;       // deployment binding (TON: domain id)
    transmitterId: Int as uint256; // deployment binding (uint160 id)
    nextNonce: Int as uint64;
    maxBodySize: Int as uint32;
    paused: Bool;
    threshold: Int as uint32;
    validators: map<Int, Bool>;
    usedNonces: map<Int, Bool>;    // key = (sourceDomain << 64) | nonce
    upgradeCodeHash: Int as uint256;
    upgradeEta: Int as uint32;

    init(owner: Address, localDomain: Int, chainId: Int, transmitterId: Int, maxBodySize: Int) {
        require(localDomain != 0, "zero localDomain");
        require(maxBodySize >= MIN_MAX_BODY_SIZE, "maxBody too small");
        self.owner = owner;
        self.registry = owner;
        self.localDomain = localDomain;
        self.chainId = chainId;
        self.transmitterId = transmitterId;
        self.nextNonce = 0;
        self.maxBodySize = maxBodySize;
        self.paused = false;
        self.threshold = 0;
        self.upgradeCodeHash = 0;
        self.upgradeEta = 0;
    }

    fun onlyOwner() { require(sender() == self.owner, "not owner") }

    // ---- registry-synced validator mirror ----
    receive(msg: SetRegistry) {
        self.onlyOwner();
        self.registry = msg.registry;
    }
    receive(msg: SyncAddValidator) {
        require(sender() == self.registry, "not registry");
        self.validators.set(msg.validator, true);
    }
    receive(msg: SyncRemoveValidator) {
        require(sender() == self.registry, "not registry");
        self.validators.set(msg.validator, false);
    }
    receive(msg: SyncSetThreshold) {
        require(sender() == self.registry, "not registry");
        self.threshold = msg.newThreshold;
    }

    // ---- timelocked set_code upgrade (EVM UUPS + timelock parity) ----
    receive(msg: QueueUpgrade) {
        self.onlyOwner();
        require(msg.codeHash != 0, "zero codeHash");
        self.upgradeCodeHash = msg.codeHash;
        self.upgradeEta = now() + UPGRADE_TIMELOCK;
    }
    receive(msg: CancelUpgrade) {
        self.onlyOwner();
        self.upgradeCodeHash = 0;
        self.upgradeEta = 0;
    }
    receive(msg: CommitUpgrade) {
        require(self.upgradeCodeHash != 0, "no upgrade");
        require(now() >= self.upgradeEta, "timelock");
        require(msg.code.hash() == self.upgradeCodeHash, "code mismatch");
        self.upgradeCodeHash = 0;
        self.upgradeEta = 0;
        tvmSetCode(msg.code);
    }

    receive(msg: MtSetPaused) { self.onlyOwner(); self.paused = msg.paused }
    receive(msg: MtSetMaxBodySize) {
        self.onlyOwner();
        require(msg.newMax >= MIN_MAX_BODY_SIZE, "maxBody too small");
        self.maxBodySize = msg.newMax;
    }

    // ---- crypto helpers (parity with MultisigVerifier) ----
    fun keccakSnake(root: Cell): Int {
        let s0: Slice = root.beginParse();
        if (s0.refs() == 0) { return kc1(s0) }
        let s1: Slice = s0.loadRef().beginParse();
        if (s1.refs() == 0) { return kc2(s0, s1) }
        let s2: Slice = s1.loadRef().beginParse();
        if (s2.refs() == 0) { return kc3(s0, s1, s2) }
        let s3: Slice = s2.loadRef().beginParse();
        return kc4(s0, s1, s2, s3);
    }

    fun attestationDigest(message: Cell): Int {
        let envelopeHash: Int = self.keccakSnake(message);
        let a: Slice = beginCell()
            .storeUint(ATTESTATION_TYPEHASH, 256)
            .storeUint(envelopeHash, 256)
            .endCell().beginParse();
        let b: Slice = beginCell()
            .storeUint(self.chainId, 256)
            .storeUint(self.transmitterId, 256)
            .endCell().beginParse();
        return kc2(a, b);
    }

    fun recoverSigner(digest: Int, v: Int, r: Int, s: Int): Int {
        require(v == 27 || v == 28, "bad v");
        require(r >= 1 && r < SECP256K1_N, "bad r");
        require(s >= 1 && s <= SECP256K1_HALF_N, "bad s (EIP-2)");
        let pk: PubKey = ecrecoverRaw(digest, v - 27, r, s);
        let body: Slice = beginCell()
            .storeUint(pk.x1, 256).storeUint(pk.x2, 256)
            .endCell().beginParse();
        let signer: Int = kc1(body) & ADDR_MASK;
        require(signer != 0, "recovery failed");
        return signer;
    }

    fun verifyAttestation(digest: Int, attestation: Cell) {
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
            if (i < t) { cur = cur.loadRef().beginParse() }
        }
    }

    fun nonceKey(sourceDomain: Int, nonce: Int): Int {
        return (sourceDomain << 64) | nonce;
    }

    // total body bytes across the snake (bounded, mirrors EVM body.length)
    fun bodyLen(root: Cell): Int {
        let s0: Slice = root.beginParse();
        let n: Int = s0.bits() / 8;
        if (s0.refs() == 0) { return n }
        let s1: Slice = s0.loadRef().beginParse();
        n = n + s1.bits() / 8;
        if (s1.refs() == 0) { return n }
        let s2: Slice = s1.loadRef().beginParse();
        n = n + s2.bits() / 8;
        if (s2.refs() == 0) { return n }
        let s3: Slice = s2.loadRef().beginParse();
        return n + s3.bits() / 8;
    }

    // ---- send ----
    receive(msg: SendMessage) {
        require(!self.paused, "paused");
        require(msg.destinationDomain != self.localDomain, "local dest");
        require(self.bodyLen(msg.body) <= self.maxBodySize, "body too large");

        let nonce: Int = self.nextNonce;
        self.nextNonce = nonce + 1;

        let senderId: Int = parseStdAddress(sender().asSlice()).address;
        let envelope: Cell = beginCell()
            .storeUint(ENVELOPE_VERSION, 32)
            .storeUint(self.localDomain, 32)
            .storeUint(msg.destinationDomain, 32)
            .storeUint(nonce, 64)
            .storeUint(senderId, 256)
            .storeUint(msg.recipient, 256)
            .storeUint(msg.destinationCaller, 256)
            .storeRef(msg.body)
            .endCell();
        emit(envelope);
    }

    // ---- receive ----
    receive(msg: ReceiveMessage) {
        require(!self.paused, "paused");

        // 1. verify domain-separated attestation FIRST
        let digest: Int = self.attestationDigest(msg.message);
        self.verifyAttestation(digest, msg.attestation);

        // 2. decode envelope
        let s: Slice = msg.message.beginParse();
        let version: Int = s.loadUint(32);
        let sourceDomain: Int = s.loadUint(32);
        let destinationDomain: Int = s.loadUint(32);
        let nonce: Int = s.loadUint(64);
        let envSender: Int = s.loadUint(256);
        let recipient: Int = s.loadUint(256);
        let destinationCaller: Int = s.loadUint(256);
        let body: Cell = s.loadRef();

        // 3. envelope sanity
        require(version == ENVELOPE_VERSION, "bad version");
        require(destinationDomain == self.localDomain, "bad dest domain");
        let callerId: Int = parseStdAddress(sender().asSlice()).address;
        require(destinationCaller == 0 || destinationCaller == callerId, "unauthorized caller");

        // 4. replay — mark BEFORE handoff
        let key: Int = self.nonceKey(sourceDomain, nonce);
        require(self.usedNonces.get(key) != true, "nonce used");
        self.usedNonces.set(key, true);

        // 5. dispatch to recipient handler (bounceable; bounce => rollback)
        send(SendParameters{
            to: newAddress(0, recipient),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: HandleReceiveMessage{
                sourceDomain: sourceDomain,
                nonce: nonce,
                sender: envSender,
                body: body,
            }.toCell(),
        });
    }

    // handler failed -> roll back replay mark so the message can be retried
    bounced(msg: bounced<HandleReceiveMessage>) {
        let key: Int = self.nonceKey(msg.sourceDomain, msg.nonce);
        self.usedNonces.set(key, false);
    }

    receive(_: Slice) {}

    // ---- getters ----
    get fun attestationDigestOf(message: Cell): Int { return self.attestationDigest(message) }
    get fun envelopeHashOf(message: Cell): Int { return self.keccakSnake(message) }
    get fun nextNonceValue(): Int { return self.nextNonce }
    get fun isNonceUsed(sourceDomain: Int, nonce: Int): Bool {
        return self.usedNonces.get(self.nonceKey(sourceDomain, nonce)) == true;
    }
    get fun isPausedValue(): Bool { return self.paused }
    get fun localDomainValue(): Int { return self.localDomain }
    get fun thresholdValue(): Int { return self.threshold }
    get fun isValidator(a: Int): Bool { return self.validators.get(a) == true }
    get fun versionValue(): Int { return ENVELOPE_VERSION }
    get fun upgradePendingHash(): Int { return self.upgradeCodeHash }
    get fun upgradeEtaValue(): Int { return self.upgradeEta }
}
