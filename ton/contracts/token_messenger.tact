// TokenMessenger — Tact port of core/contracts/cctp/TokenMessenger.sol
//
// EVM parity:
//   - depositForBurn: paused/amount/mintRecipient/burnToken/router guards,
//     burnFrom(sender, amount), _chargeFee, BurnMessage.format, sendMessage
//   - handleReceiveMessage: only-transmitter, remote-router + sender match,
//     body version, mint(recipient, amount)
//   - fee path dormant at feeBps = 0 (conservation holds)
//
// TON divergence (documented): EVM does burnFrom then sendMessage in ONE
// synchronous tx. TON is async, so burn→message atomicity uses a callback:
// depositForBurn records an intent and asks the Jetton to BridgeBurn; only
// after the master's BridgeBurnAck (burn confirmed, supply reduced) does the
// TokenMessenger emit the CCTP message. A bounce on BridgeBurn clears the
// intent and no message is emitted (no inflation). Mint on the receive side
// is dispatched to the Jetton master (TokenMessenger holds minter role).

message(0x534e5220) BridgeBurn { opId: Int as uint64; amount: Int as coins; from: Address }
message(0x534e5223) BridgeBurnAck { opId: Int as uint64; amount: Int as coins }
message(0x534e5201) Mint { to: Address; amount: Int as coins }

message(0x4d540110) SendMessage {
    destinationDomain: Int as uint32;
    recipient: Int as uint256;
    destinationCaller: Int as uint256;
    body: Cell;
}
message(0x4d540120) HandleReceiveMessage {
    sourceDomain: Int as uint32;
    nonce: Int as uint64;
    sender: Int as uint256;
    body: Cell;
}

message(0x544d0100) TmSetPaused { paused: Bool }
message(0x544d0101) SetMessageTransmitter { messageTransmitter: Address }
message(0x544d0102) SetLocalToken { localToken: Address }
message(0x544d0103) SetRemoteRouter { domain: Int as uint32; router: Int as uint256 }
message(0x544d0104) SetFeeConfig { feeBps: Int as uint16; feeRecipient: Address }
message(0x544d0110) DepositForBurn {
    amount: Int as coins;
    destinationDomain: Int as uint32;
    mintRecipient: Int as uint256;
    destinationCaller: Int as uint256; // 0 = anyone
}

struct Intent {
    depositor: Address;
    destinationDomain: Int as uint32;
    destRouter: Int as uint256;
    mintRecipient: Int as uint256;
    destinationCaller: Int as uint256;
    exists: Bool;
}

const BODY_VERSION: Int = 1;
const BPS_DENOMINATOR: Int = 10000;

contract TokenMessenger {
    owner: Address;
    messageTransmitter: Address;
    localToken: Address;          // StableNaira Jetton master
    feeBps: Int as uint16;        // 0 = dormant (v1 testnet)
    feeRecipient: Address;
    paused: Bool;
    nextOpId: Int as uint64;
    remoteRouters: map<Int, Int>; // domain -> router account id (uint256)
    intents: map<Int, Intent>;

    init(owner: Address, messageTransmitter: Address, localToken: Address, feeBps: Int, feeRecipient: Address) {
        self.owner = owner;
        self.messageTransmitter = messageTransmitter;
        self.localToken = localToken;
        self.feeBps = feeBps;
        self.feeRecipient = feeRecipient;
        self.paused = false;
        self.nextOpId = 0;
    }

    fun onlyOwner() { require(sender() == self.owner, "not owner") }
    fun acctId(a: Address): Int { return parseStdAddress(a.asSlice()).address }

    receive(msg: TmSetPaused) { self.onlyOwner(); self.paused = msg.paused }
    receive(msg: SetMessageTransmitter) { self.onlyOwner(); self.messageTransmitter = msg.messageTransmitter }
    receive(msg: SetLocalToken) { self.onlyOwner(); self.localToken = msg.localToken }
    receive(msg: SetRemoteRouter) {
        self.onlyOwner();
        self.remoteRouters.set(msg.domain, msg.router);
    }
    receive(msg: SetFeeConfig) {
        self.onlyOwner();
        self.feeBps = msg.feeBps;
        self.feeRecipient = msg.feeRecipient;
    }

    // ---- depositForBurn (burn-then-message via callback) ----
    receive(msg: DepositForBurn) {
        require(!self.paused, "paused");
        require(msg.amount > 0, "amount=0");
        require(msg.mintRecipient != 0, "zero mintRecipient");
        let destRouter: Int = self.remoteRouters.get(msg.destinationDomain)!!;
        require(destRouter != 0, "router unregistered");

        let opId: Int = self.nextOpId;
        self.nextOpId = opId + 1;
        self.intents.set(opId, Intent{
            depositor: sender(),
            destinationDomain: msg.destinationDomain,
            destRouter: destRouter,
            mintRecipient: msg.mintRecipient,
            destinationCaller: msg.destinationCaller,
            exists: true,
        });

        send(SendParameters{
            to: self.localToken,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: BridgeBurn{ from: sender(), amount: msg.amount, opId: opId }.toCell(),
        });
    }

    // BridgeBurn failed (frozen / insufficient / not minter) -> drop intent,
    // no CCTP message emitted (no inflation).
    bounced(msg: bounced<BridgeBurn>) {
        self.intents.set(msg.opId, null);
    }

    fun chargeFee(amount: Int): Int {
        if (self.feeBps == 0) { return amount }
        let fee: Int = (amount * self.feeBps) / BPS_DENOMINATOR;
        if (fee == 0) { return amount }
        send(SendParameters{
            to: self.localToken, value: 0, mode: SendRemainingValue, bounce: true,
            body: Mint{ to: self.feeRecipient, amount: fee }.toCell(),
        });
        return amount - fee;
    }

    // burn confirmed by the Jetton master -> emit the CCTP message
    receive(msg: BridgeBurnAck) {
        require(sender() == self.localToken, "not localToken");
        let it: Intent = self.intents.get(msg.opId)!!;
        require(it.exists, "no intent");
        self.intents.set(msg.opId, null);

        let amountAfterFee: Int = self.chargeFee(msg.amount);
        let body: Cell = beginCell()
            .storeUint(BODY_VERSION, 32)
            .storeUint(self.acctId(self.localToken), 256)   // burnToken
            .storeUint(it.mintRecipient, 256)
            .storeUint(amountAfterFee, 256)
            .storeRef(beginCell()
                .storeUint(self.acctId(it.depositor), 256)   // messageSender
                .endCell())
            .endCell();

        send(SendParameters{
            to: self.messageTransmitter,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: SendMessage{
                destinationDomain: it.destinationDomain,
                recipient: it.destRouter,
                destinationCaller: it.destinationCaller,
                body: body,
            }.toCell(),
        });
    }

    // ---- handleReceiveMessage (mint side) ----
    receive(msg: HandleReceiveMessage) {
        require(!self.paused, "paused");
        require(sender() == self.messageTransmitter, "only transmitter");
        let expected: Int = self.remoteRouters.get(msg.sourceDomain)!!;
        require(expected != 0, "router unregistered");
        require(msg.sender == expected, "bad remote sender");

        let s: Slice = msg.body.beginParse();
        let bodyVersion: Int = s.loadUint(32);
        let burnToken: Int = s.loadUint(256);
        let mintRecipient: Int = s.loadUint(256);
        let amount: Int = s.loadUint(256);
        require(bodyVersion == BODY_VERSION, "bad body version");

        send(SendParameters{
            to: self.localToken,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: Mint{ to: newAddress(0, mintRecipient), amount: amount }.toCell(),
        });
    }

    receive(_: Slice) {}

    get fun remoteRouter(domain: Int): Int {
        let r: Int? = self.remoteRouters.get(domain);
        if (r == null) { return 0 }
        return r!!;
    }
    get fun isPausedValue(): Bool { return self.paused }
    get fun feeBpsValue(): Int { return self.feeBps }
    get fun nextOpIdValue(): Int { return self.nextOpId }
    get fun hasIntent(opId: Int): Bool {
        let i: Intent? = self.intents.get(opId);
        if (i == null) { return false }
        return (i!!).exists;
    }
    get fun bodyVersionValue(): Int { return BODY_VERSION }
    get fun messageTransmitterAddr(): Address { return self.messageTransmitter }
    get fun localTokenAddr(): Address { return self.localToken }
}
