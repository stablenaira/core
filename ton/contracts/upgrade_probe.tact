// Phase 7 reference: timelocked `set_code` upgrade — the TON analogue of the
// EVM UUPS + TimelockedUpgradeable queue/commit gate.
//
// Parity intent:
//   - owner queues (binds the exact new code by its cell hash)
//   - permissionless commit after `eta` (owner cannot silently rush it)
//   - owner can cancel a queued upgrade
//   - timelock floor (1h, mirrors the EVM default)
//
// TON mechanism: TVM `SETCODE` swaps the code cell; the data cell (c4 storage)
// is preserved, so storage layout MUST be kept compatible across versions
// (same as EVM storage-gap discipline). V1/V2 below share an identical layout;
// V2 only changes `versionTag()` to prove the swap actually took effect.

asm fun tvmSetCode(code: Cell) { SETCODE }

message(0x55504700) QueueUpgrade { codeHash: Int as uint256 }
message(0x55504701) CommitUpgrade { code: Cell }
message(0x55504702) CancelUpgrade {}

const UPGRADE_TIMELOCK: Int = 3600; // 1 hour, mirrors EVM default floor

contract UpgradeProbeV1 {
    owner: Address;
    queuedCodeHash: Int as uint256;
    eta: Int as uint32;

    init(owner: Address) {
        self.owner = owner;
        self.queuedCodeHash = 0;
        self.eta = 0;
    }

    fun onlyOwner() { require(sender() == self.owner, "not owner") }

    receive(msg: QueueUpgrade) {
        self.onlyOwner();
        require(msg.codeHash != 0, "zero codeHash");
        self.queuedCodeHash = msg.codeHash;
        self.eta = now() + UPGRADE_TIMELOCK;
    }

    receive(msg: CancelUpgrade) {
        self.onlyOwner();
        self.queuedCodeHash = 0;
        self.eta = 0;
    }

    // permissionless after eta; caller must pass the exact queued code
    receive(msg: CommitUpgrade) {
        require(self.queuedCodeHash != 0, "no upgrade");
        require(now() >= self.eta, "timelock");
        require(msg.code.hash() == self.queuedCodeHash, "code mismatch");
        self.queuedCodeHash = 0;
        self.eta = 0;
        tvmSetCode(msg.code);
    }

    receive(_: Slice) {}

    get fun versionTag(): Int { return 1 }
    get fun pendingCodeHash(): Int { return self.queuedCodeHash }
    get fun upgradeEta(): Int { return self.eta }
    get fun ownerAddr(): Address { return self.owner }
}

// Identical storage layout; only versionTag() differs — proves SETCODE swapped
// the code while preserving c4 storage.
contract UpgradeProbeV2 {
    owner: Address;
    queuedCodeHash: Int as uint256;
    eta: Int as uint32;

    init(owner: Address) {
        self.owner = owner;
        self.queuedCodeHash = 0;
        self.eta = 0;
    }

    fun onlyOwner() { require(sender() == self.owner, "not owner") }

    receive(msg: QueueUpgrade) {
        self.onlyOwner();
        require(msg.codeHash != 0, "zero codeHash");
        self.queuedCodeHash = msg.codeHash;
        self.eta = now() + UPGRADE_TIMELOCK;
    }

    receive(msg: CancelUpgrade) {
        self.onlyOwner();
        self.queuedCodeHash = 0;
        self.eta = 0;
    }

    receive(msg: CommitUpgrade) {
        require(self.queuedCodeHash != 0, "no upgrade");
        require(now() >= self.eta, "timelock");
        require(msg.code.hash() == self.queuedCodeHash, "code mismatch");
        self.queuedCodeHash = 0;
        self.eta = 0;
        tvmSetCode(msg.code);
    }

    receive(_: Slice) {}

    get fun versionTag(): Int { return 2 }
    get fun pendingCodeHash(): Int { return self.queuedCodeHash }
    get fun upgradeEta(): Int { return self.eta }
    get fun ownerAddr(): Address { return self.owner }
}
