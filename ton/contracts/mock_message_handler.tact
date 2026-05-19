// Test-only IMessageHandler stand-in for Phase 3.
// Records the last delivery; can be flipped to fail so the transmitter's
// bounce-rollback path can be exercised.

message(0x4d540120) HandleReceiveMessage {
    sourceDomain: Int as uint32;
    nonce: Int as uint64;
    sender: Int as uint256;
    body: Cell;
}
message(0x4d6f0001) SetFail { fail: Bool }

contract MockMessageHandler {
    failMode: Bool;
    receivedCount: Int as uint32;
    lastSourceDomain: Int as uint32;
    lastNonce: Int as uint64;
    lastSender: Int as uint256;

    init() {
        self.failMode = false;
        self.receivedCount = 0;
        self.lastSourceDomain = 0;
        self.lastNonce = 0;
        self.lastSender = 0;
    }

    receive(msg: SetFail) { self.failMode = msg.fail }

    receive(msg: HandleReceiveMessage) {
        require(!self.failMode, "handler failed");
        self.receivedCount = self.receivedCount + 1;
        self.lastSourceDomain = msg.sourceDomain;
        self.lastNonce = msg.nonce;
        self.lastSender = msg.sender;
    }

    receive(_: Slice) {}

    get fun receivedCountValue(): Int { return self.receivedCount }
    get fun lastSourceDomainValue(): Int { return self.lastSourceDomain }
    get fun lastNonceValue(): Int { return self.lastNonce }
    get fun lastSenderValue(): Int { return self.lastSender }
    get fun isFailMode(): Bool { return self.failMode }
}
