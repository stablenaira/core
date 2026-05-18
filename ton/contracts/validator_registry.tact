// ValidatorRegistry — Tact port of core/contracts/cctp/ValidatorRegistry.sol
//
// EVM parity:
//   - m-of-n validator set, threshold invariant: t>=1, t<=n, 2t>n
//   - timelocked queue/commit for add/remove/replace/setThreshold
//   - owner queues & cancels; commit is permissionless after eta
//   - on commit, mutate set then push the change to the MultisigVerifier
//
// TON adaptations (documented): EVM `initialize()` seeds validators+threshold
// in one call; here the owner bootstraps via owner-only messages then
// `BootstrapFinalize` (one-time) validates the invariant and locks bootstrap.
// Thereafter only the timelocked path mutates state. Verifier sync replaces
// EVM's synchronous STATICCALL (TON is async).

message(0x564c5201) SyncAddValidator { validator: Int as uint256 }
message(0x564c5202) SyncRemoveValidator { validator: Int as uint256 }
message(0x564c5203) SyncSetThreshold { newThreshold: Int as uint32 }

// ChangeKind: 0=Add 1=Remove 2=Replace 3=SetThreshold
message(0x56520100) SetVerifier { verifier: Address }
message(0x56520101) BootstrapAddValidator { validator: Int as uint256 }
message(0x56520102) BootstrapFinalize { threshold: Int as uint32 }
message(0x56520111) QueueAddValidator { validator: Int as uint256 }
message(0x56520112) QueueRemoveValidator { validator: Int as uint256 }
message(0x56520113) QueueReplaceValidator { oldValidator: Int as uint256; newValidator: Int as uint256 }
message(0x56520114) QueueSetThreshold { newThreshold: Int as uint32 }
message(0x56520121) CommitChange { actionId: Int as uint64 }
message(0x56520131) CancelChange { actionId: Int as uint64 }
message(0x56520141) SetTimelock { newTimelock: Int as uint32 }
message(0x56520142) SetMinTimelock { newMin: Int as uint32 }

struct Change {
    kind: Int as uint8;
    target: Int as uint256;
    replacement: Int as uint256;
    newThreshold: Int as uint32;
    eta: Int as uint32;
    exists: Bool;
}

const DEFAULT_TIMELOCK: Int = 3600; // 1 hour, mirrors EVM default

contract ValidatorRegistry {
    owner: Address;
    verifier: Address;
    timelock: Int as uint32;
    minTimelock: Int as uint32;
    threshold: Int as uint32;
    validatorCount: Int as uint32;
    finalized: Bool;
    nextActionId: Int as uint64;
    validators: map<Int, Bool>;
    changes: map<Int, Change>;

    init(owner: Address, timelock: Int, minTimelock: Int) {
        self.owner = owner;
        self.verifier = owner; // rewired once via SetVerifier before finalize
        let tl: Int = timelock;
        if (tl == 0) { tl = DEFAULT_TIMELOCK }
        let mtl: Int = minTimelock;
        if (mtl == 0) { mtl = DEFAULT_TIMELOCK }
        self.timelock = tl;
        self.minTimelock = mtl;
        self.threshold = 0;
        self.validatorCount = 0;
        self.finalized = false;
        self.nextActionId = 0;
    }

    fun onlyOwner() { require(sender() == self.owner, "not owner") }
    fun isMember(v: Int): Bool { return self.validators.get(v) == true }

    fun validateThreshold(t: Int, n: Int) {
        require(t != 0 && t <= n && 2 * t > n, "invalid threshold");
    }

    fun syncAdd(v: Int) {
        send(SendParameters{
            to: self.verifier, value: 0, mode: SendRemainingValue, bounce: true,
            body: SyncAddValidator{ validator: v }.toCell(),
        });
    }
    fun syncRemove(v: Int) {
        send(SendParameters{
            to: self.verifier, value: 0, mode: SendRemainingValue, bounce: true,
            body: SyncRemoveValidator{ validator: v }.toCell(),
        });
    }
    fun syncThreshold(t: Int) {
        send(SendParameters{
            to: self.verifier, value: 0, mode: SendRemainingValue, bounce: true,
            body: SyncSetThreshold{ newThreshold: t }.toCell(),
        });
    }

    // one-time wiring: set the verifier before bootstrap is finalized
    receive(msg: SetVerifier) {
        self.onlyOwner();
        require(!self.finalized, "finalized");
        self.verifier = msg.verifier;
    }

    // ---- bootstrap (EVM initialize equivalent) ----
    receive(msg: BootstrapAddValidator) {
        self.onlyOwner();
        require(!self.finalized, "finalized");
        require(msg.validator != 0, "zero validator");
        require(!self.isMember(msg.validator), "exists");
        self.validators.set(msg.validator, true);
        self.validatorCount = self.validatorCount + 1;
        self.syncAdd(msg.validator);
    }

    receive(msg: BootstrapFinalize) {
        self.onlyOwner();
        require(!self.finalized, "finalized");
        self.validateThreshold(msg.threshold, self.validatorCount);
        self.threshold = msg.threshold;
        self.finalized = true;
        self.syncThreshold(msg.threshold);
    }

    // ---- queue (owner only) ----
    fun enqueue(c: Change): Int {
        let id: Int = self.nextActionId;
        self.nextActionId = id + 1;
        let cc: Change = c;
        cc.eta = now() + self.timelock;
        cc.exists = true;
        self.changes.set(id, cc);
        return id;
    }

    receive(msg: QueueAddValidator) {
        self.onlyOwner();
        require(self.finalized, "not finalized");
        require(msg.validator != 0, "zero validator");
        require(!self.isMember(msg.validator), "exists");
        self.enqueue(Change{ kind: 0, target: msg.validator, replacement: 0, newThreshold: 0, eta: 0, exists: false });
    }

    receive(msg: QueueRemoveValidator) {
        self.onlyOwner();
        require(self.finalized, "not finalized");
        require(self.isMember(msg.validator), "not found");
        self.enqueue(Change{ kind: 1, target: msg.validator, replacement: 0, newThreshold: 0, eta: 0, exists: false });
    }

    receive(msg: QueueReplaceValidator) {
        self.onlyOwner();
        require(self.finalized, "not finalized");
        require(msg.newValidator != 0, "zero validator");
        require(self.isMember(msg.oldValidator), "not found");
        require(!self.isMember(msg.newValidator), "exists");
        self.enqueue(Change{ kind: 2, target: msg.oldValidator, replacement: msg.newValidator, newThreshold: 0, eta: 0, exists: false });
    }

    receive(msg: QueueSetThreshold) {
        self.onlyOwner();
        require(self.finalized, "not finalized");
        self.enqueue(Change{ kind: 3, target: 0, replacement: 0, newThreshold: msg.newThreshold, eta: 0, exists: false });
    }

    // ---- commit (permissionless after eta) ----
    receive(msg: CommitChange) {
        let c: Change = self.changes.get(msg.actionId)!!;
        require(c.exists, "no action");
        require(now() >= c.eta, "timelock");
        self.changes.set(msg.actionId, null);

        if (c.kind == 0) {
            require(!self.isMember(c.target), "exists");
            self.validators.set(c.target, true);
            self.validatorCount = self.validatorCount + 1;
            self.syncAdd(c.target);
        } else if (c.kind == 1) {
            require(self.isMember(c.target), "not found");
            self.validators.set(c.target, false);
            self.validatorCount = self.validatorCount - 1;
            self.validateThreshold(self.threshold, self.validatorCount);
            self.syncRemove(c.target);
        } else if (c.kind == 2) {
            require(self.isMember(c.target), "not found");
            require(!self.isMember(c.replacement), "exists");
            self.validators.set(c.target, false);
            self.validators.set(c.replacement, true);
            self.syncRemove(c.target);
            self.syncAdd(c.replacement);
        } else {
            self.validateThreshold(c.newThreshold, self.validatorCount);
            self.threshold = c.newThreshold;
            self.syncThreshold(c.newThreshold);
        }
    }

    receive(msg: CancelChange) {
        self.onlyOwner();
        self.changes.set(msg.actionId, null);
    }

    receive(msg: SetTimelock) {
        self.onlyOwner();
        require(msg.newTimelock >= self.minTimelock, "below min");
        self.timelock = msg.newTimelock;
    }

    receive(msg: SetMinTimelock) {
        self.onlyOwner();
        self.minTimelock = msg.newMin;
        if (self.timelock < msg.newMin) { self.timelock = msg.newMin }
    }

    receive(_: Slice) {}

    get fun isValidator(a: Int): Bool { return self.isMember(a) }
    get fun validatorCountValue(): Int { return self.validatorCount }
    get fun thresholdValue(): Int { return self.threshold }
    get fun isFinalized(): Bool { return self.finalized }
    get fun timelockValue(): Int { return self.timelock }
    get fun pendingChange(actionId: Int): Change { return self.changes.get(actionId)!! }
    get fun ownerAddress(): Address { return self.owner }
}
