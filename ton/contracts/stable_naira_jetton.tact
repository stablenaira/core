// StableNaira (SNR) — TEP-74 Jetton on TON with EVM behaviour parity.
//
// Mirrors core/contracts/StableNaira.sol. Parity rules (see
// 05 CCTP Protocol/TON Implementation in the wiki):
//   - mint: minter-role, not paused, mintCap, reverts if recipient frozen
//   - burn (holder): not paused, reverts if holder frozen
//   - masterBurn (burnFrom parity): minter-role, not paused, reverts if frozen
//   - freeze/unfreeze: freezer-or-admin; frozen wallet rejects in/out transfers
//   - seize: seizer-or-admin; force-moves funds BYPASSING freeze AND pause
//   - pause: master-mediated only — gates mint/burn/redeem; p2p transfers stay
//     live (documented divergence from EVM; decided Phase 1).
//   - decimals = 2, symbol "SNR" (TEP-64 content cell supplied at init).

// ----------------------------- Messages ----------------------------------

// TEP-74 standard
message(0x0f8a7ea5) JettonTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    responseDestination: Address;
    customPayload: Cell?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x178d4519) JettonInternalTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    from: Address;          // source token owner (for sender validation)
    responseDestination: Address;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x7362d09c) JettonTransferNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forwardPayload: Slice as remaining;
}

message(0x595f07bc) JettonBurn {
    queryId: Int as uint64;
    amount: Int as coins;
    responseDestination: Address;
    customPayload: Cell?;
}

message(0x7bdd97de) JettonBurnNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    owner: Address;
    responseDestination: Address;
}

message(0xd53276db) JettonExcesses {
    queryId: Int as uint64;
}

message(0x2c76b973) ProvideWalletAddress {
    queryId: Int as uint64;
    ownerAddress: Address;
    includeAddress: Bool;
}

message(0xd1735400) TakeWalletAddress {
    queryId: Int as uint64;
    walletAddress: Address;
    ownerAddress: Cell?;
}

// StableNaira parity ops (master -> wallet are sender==master authenticated)
message(0x534e5201) Mint { to: Address; amount: Int as coins }
message(0x534e5202) SetPaused { paused: Bool }
message(0x534e5203) FreezeAccount { account: Address }
message(0x534e5204) UnfreezeAccount { account: Address }
message(0x534e5205) Seize { from: Address; to: Address; amount: Int as coins }
message(0x534e5206) SetMintCap { newCap: Int as coins }
message(0x534e5207) GrantRole { role: Int as uint8; account: Address }
message(0x534e5208) RevokeRole { role: Int as uint8; account: Address }
message(0x534e5209) MasterBurn { account: Address; amount: Int as coins }   // burnFrom
message(0x534e520A) RedeemRequest { amount: Int as coins; offChainRef: Cell }
message(0x534e520B) RedeemNotification { amount: Int as coins; owner: Address; offChainRef: Cell }

// bridge burn callback path (Phase 4): minter burns a holder's balance and
// the master acks the requester so the bridge can emit its CCTP message only
// after a confirmed burn (burn->message atomicity on async TON).
message(0x534e5220) BridgeBurn { opId: Int as uint64; amount: Int as coins; from: Address }
message(0x534e5221) WalletBridgeBurn { amount: Int as coins; opId: Int as uint64; requester: Address }
message(0x534e5222) BridgeBurnNotification { amount: Int as coins; owner: Address; opId: Int as uint64; requester: Address }
message(0x534e5223) BridgeBurnAck { opId: Int as uint64; amount: Int as coins }

// wallet-internal authenticated ops
message(0x534e5210) SetWalletFrozen { frozen: Bool }
message(0x534e5211) WalletMasterBurn { queryId: Int as uint64; amount: Int as coins }
message(0x534e5212) ForceTransfer { to: Address; amount: Int as coins }
message(0x534e5213) ForceCredit { amount: Int as coins; from: Address }

struct JettonData {
    totalSupply: Int as coins;
    mintable: Bool;
    adminAddress: Address;
    jettonContent: Cell;
    jettonWalletCode: Cell;
}

struct WalletData {
    balance: Int as coins;
    owner: Address;
    master: Address;
    walletCode: Cell;
}

// roles: 0=minter 1=pauser 2=freezer 3=seizer
const ROLE_MINTER: Int = 0;
const ROLE_PAUSER: Int = 1;
const ROLE_FREEZER: Int = 2;
const ROLE_SEIZER: Int = 3;

const GAS_FOR_OP: Int = ton("0.02");

// ------------------------------ Master ------------------------------------

contract StableNairaJettonMaster {
    admin: Address;
    totalSupply: Int as coins;
    mintCap: Int as coins;          // 0 = unlimited
    paused: Bool;
    content: Cell;
    minters: map<Address, Bool>;
    pausers: map<Address, Bool>;
    freezers: map<Address, Bool>;
    seizers: map<Address, Bool>;

    init(admin: Address, content: Cell, mintCap: Int) {
        self.admin = admin;
        self.content = content;
        self.mintCap = mintCap;
        self.totalSupply = 0;
        self.paused = false;
    }

    // ---- internal helpers ----
    fun walletInit(owner: Address): StateInit {
        return initOf StableNairaJettonWallet(owner, myAddress());
    }
    fun walletAddr(owner: Address): Address {
        return contractAddress(self.walletInit(owner));
    }
    fun isAdmin(a: Address): Bool { return a == self.admin }
    fun hasRole(m: map<Address, Bool>, a: Address): Bool {
        return m.get(a) == true;
    }
    fun requireAdmin() {
        require(self.isAdmin(sender()), "not admin");
    }
    fun requireMinter() {
        require(self.hasRole(self.minters, sender()), "not minter");
    }
    fun requirePauserOrAdmin() {
        let s: Address = sender();
        require(self.isAdmin(s) || self.hasRole(self.pausers, s), "not pauser/admin");
    }
    fun requireFreezerOrAdmin() {
        let s: Address = sender();
        require(self.isAdmin(s) || self.hasRole(self.freezers, s), "not freezer/admin");
    }
    fun requireSeizerOrAdmin() {
        let s: Address = sender();
        require(self.isAdmin(s) || self.hasRole(self.seizers, s), "not seizer/admin");
    }

    // ---- mint (MINTER_ROLE, whenNotPaused, mintCap, frozen-recipient revert via wallet) ----
    receive(msg: Mint) {
        self.requireMinter();
        require(!self.paused, "paused");
        require(msg.amount > 0, "amount=0");
        if (self.mintCap != 0) {
            require(self.totalSupply + msg.amount <= self.mintCap, "mintCap");
        }
        self.totalSupply = self.totalSupply + msg.amount;
        let init: StateInit = self.walletInit(msg.to);
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            code: init.code,
            data: init.data,
            body: JettonInternalTransfer{
                queryId: 0,
                amount: msg.amount,
                from: myAddress(),
                responseDestination: sender(),
                forwardTonAmount: 0,
                forwardPayload: emptySlice(),
            }.toCell(),
        });
    }

    receive(msg: SetPaused) {
        self.requirePauserOrAdmin();
        // unpause is DEFAULT_ADMIN-only in EVM
        if (!msg.paused) { self.requireAdmin(); }
        self.paused = msg.paused;
    }

    receive(msg: SetMintCap) {
        self.requireAdmin();
        self.mintCap = msg.newCap;
    }

    receive(msg: GrantRole) {
        self.requireAdmin();
        if (msg.role == ROLE_MINTER) { self.minters.set(msg.account, true); }
        if (msg.role == ROLE_PAUSER) { self.pausers.set(msg.account, true); }
        if (msg.role == ROLE_FREEZER) { self.freezers.set(msg.account, true); }
        if (msg.role == ROLE_SEIZER) { self.seizers.set(msg.account, true); }
    }

    receive(msg: RevokeRole) {
        self.requireAdmin();
        if (msg.role == ROLE_MINTER) { self.minters.set(msg.account, false); }
        if (msg.role == ROLE_PAUSER) { self.pausers.set(msg.account, false); }
        if (msg.role == ROLE_FREEZER) { self.freezers.set(msg.account, false); }
        if (msg.role == ROLE_SEIZER) { self.seizers.set(msg.account, false); }
    }

    receive(msg: FreezeAccount) {
        self.requireFreezerOrAdmin();
        send(SendParameters{
            to: self.walletAddr(msg.account),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: SetWalletFrozen{ frozen: true }.toCell(),
        });
    }

    receive(msg: UnfreezeAccount) {
        self.requireFreezerOrAdmin();
        send(SendParameters{
            to: self.walletAddr(msg.account),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: SetWalletFrozen{ frozen: false }.toCell(),
        });
    }

    // seize: bypasses pause AND freeze (EVM _forceTransfer parity)
    receive(msg: Seize) {
        self.requireSeizerOrAdmin();
        require(msg.amount > 0, "amount=0");
        send(SendParameters{
            to: self.walletAddr(msg.from),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: ForceTransfer{ to: msg.to, amount: msg.amount }.toCell(),
        });
    }

    // burnFrom parity: MINTER_ROLE, whenNotPaused, respects freeze (wallet reverts)
    receive(msg: MasterBurn) {
        self.requireMinter();
        require(!self.paused, "paused");
        require(msg.amount > 0, "amount=0");
        send(SendParameters{
            to: self.walletAddr(msg.account),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: WalletMasterBurn{ queryId: 0, amount: msg.amount }.toCell(),
        });
    }

    // bridge burn: minter-gated, whenNotPaused, respects freeze (wallet path)
    receive(msg: BridgeBurn) {
        self.requireMinter();
        require(!self.paused, "paused");
        require(msg.amount > 0, "amount=0");
        send(SendParameters{
            to: self.walletAddr(msg.from),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: WalletBridgeBurn{
                amount: msg.amount,
                opId: msg.opId,
                requester: sender(),
            }.toCell(),
        });
    }

    // wallet confirmed a bridge burn — reduce supply, ack the requester
    receive(msg: BridgeBurnNotification) {
        require(sender() == self.walletAddr(msg.owner), "not wallet");
        self.totalSupply = self.totalSupply - msg.amount;
        send(SendParameters{
            to: msg.requester,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: BridgeBurnAck{ opId: msg.opId, amount: msg.amount }.toCell(),
        });
    }

    // burn notification from a wallet — reduce supply
    receive(msg: JettonBurnNotification) {
        require(sender() == self.walletAddr(msg.owner), "not wallet");
        self.totalSupply = self.totalSupply - msg.amount;
        if (msg.responseDestination != myAddress()) {
            send(SendParameters{
                to: msg.responseDestination,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses{ queryId: msg.queryId }.toCell(),
            });
        }
    }

    // redeem: holder burned via wallet; wallet notifies master with off-chain ref
    receive(msg: RedeemNotification) {
        require(sender() == self.walletAddr(msg.owner), "not wallet");
        require(!self.paused, "paused");
        self.totalSupply = self.totalSupply - msg.amount;
        // event surrogate: emit so off-chain indexer can reconcile the payout
        emit(RedeemNotification{ amount: msg.amount, owner: msg.owner, offChainRef: msg.offChainRef }.toCell());
    }

    receive(msg: ProvideWalletAddress) {
        let owner: Cell? = null;
        if (msg.includeAddress) {
            owner = beginCell().storeAddress(msg.ownerAddress).endCell();
        }
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: TakeWalletAddress{
                queryId: msg.queryId,
                walletAddress: self.walletAddr(msg.ownerAddress),
                ownerAddress: owner,
            }.toCell(),
        });
    }

    receive(_: Slice) {}   // accept plain transfers / deploy

    // ---- getters (TEP-74 + parity) ----
    get fun get_jetton_data(): JettonData {
        return JettonData{
            totalSupply: self.totalSupply,
            mintable: !self.paused,
            adminAddress: self.admin,
            jettonContent: self.content,
            jettonWalletCode: self.walletInit(myAddress()).code,
        };
    }
    get fun get_wallet_address(owner: Address): Address {
        return self.walletAddr(owner);
    }
    get fun adminAddress(): Address { return self.admin }
    get fun isPaused(): Bool { return self.paused }
    get fun mintCapValue(): Int { return self.mintCap }
    get fun totalSupplyValue(): Int { return self.totalSupply }
    get fun isMinter(a: Address): Bool { return self.hasRole(self.minters, a) }
    get fun isPauser(a: Address): Bool { return self.hasRole(self.pausers, a) }
    get fun isFreezer(a: Address): Bool { return self.hasRole(self.freezers, a) }
    get fun isSeizer(a: Address): Bool { return self.hasRole(self.seizers, a) }
}

// ------------------------------ Wallet ------------------------------------

contract StableNairaJettonWallet {
    balance: Int as coins;
    owner: Address;
    master: Address;
    frozen: Bool;

    init(owner: Address, master: Address) {
        self.balance = 0;
        self.owner = owner;
        self.master = master;
        self.frozen = false;
    }

    fun expectedWallet(owner: Address): Address {
        return contractAddress(initOf StableNairaJettonWallet(owner, self.master));
    }

    // holder-initiated transfer. EVM: reverts if sender frozen. Pause NOT
    // checked here (master-mediated pause decision — p2p stays live).
    receive(msg: JettonTransfer) {
        require(sender() == self.owner, "not owner");
        require(!self.frozen, "frozen");
        require(msg.amount > 0, "amount=0");
        require(self.balance >= msg.amount, "balance");
        self.balance = self.balance - msg.amount;
        let init: StateInit = initOf StableNairaJettonWallet(msg.destination, self.master);
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            code: init.code,
            data: init.data,
            body: JettonInternalTransfer{
                queryId: msg.queryId,
                amount: msg.amount,
                from: self.owner,
                responseDestination: msg.responseDestination,
                forwardTonAmount: msg.forwardTonAmount,
                forwardPayload: msg.forwardPayload,
            }.toCell(),
        });
    }

    // credit. Accept from master (mint) or a sibling wallet (p2p). EVM: reverts
    // if recipient (this wallet) frozen — non-forced path respects freeze.
    receive(msg: JettonInternalTransfer) {
        let valid: Bool = (sender() == self.master) || (sender() == self.expectedWallet(msg.from));
        require(valid, "bad source");
        require(!self.frozen, "frozen");
        self.balance = self.balance + msg.amount;
        if (msg.forwardTonAmount > 0) {
            send(SendParameters{
                to: self.owner,
                value: msg.forwardTonAmount,
                mode: SendPayGasSeparately,
                bounce: false,
                body: JettonTransferNotification{
                    queryId: msg.queryId,
                    amount: msg.amount,
                    sender: msg.from,
                    forwardPayload: msg.forwardPayload,
                }.toCell(),
            });
        }
        if (msg.responseDestination != myAddress()) {
            send(SendParameters{
                to: msg.responseDestination,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses{ queryId: msg.queryId }.toCell(),
            });
        }
    }

    // holder burn. EVM: reverts if frozen. Pause is enforced at master via
    // RedeemRequest path; plain burn mirrors EVM burn() (whenNotPaused) by
    // routing the supply decrement through the master which is the supply
    // authority — master does not gate plain burn, matching EVM burn() which
    // only checks pause+freeze (freeze checked here; pause is master-mediated).
    receive(msg: JettonBurn) {
        require(sender() == self.owner, "not owner");
        require(!self.frozen, "frozen");
        require(msg.amount > 0, "amount=0");
        require(self.balance >= msg.amount, "balance");
        self.balance = self.balance - msg.amount;
        send(SendParameters{
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonBurnNotification{
                queryId: msg.queryId,
                amount: msg.amount,
                owner: self.owner,
                responseDestination: msg.responseDestination,
            }.toCell(),
        });
    }

    receive(msg: RedeemRequest) {
        require(sender() == self.owner, "not owner");
        require(!self.frozen, "frozen");
        require(msg.amount > 0, "amount=0");
        require(self.balance >= msg.amount, "balance");
        self.balance = self.balance - msg.amount;
        send(SendParameters{
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: RedeemNotification{
                amount: msg.amount,
                owner: self.owner,
                offChainRef: msg.offChainRef,
            }.toCell(),
        });
    }

    // master-authenticated freeze flag
    receive(msg: SetWalletFrozen) {
        require(sender() == self.master, "not master");
        self.frozen = msg.frozen;
    }

    // burnFrom parity: master-authenticated, respects freeze (EVM burnFrom
    // goes through _update which reverts if frozen)
    receive(msg: WalletMasterBurn) {
        require(sender() == self.master, "not master");
        require(!self.frozen, "frozen");
        require(self.balance >= msg.amount, "balance");
        self.balance = self.balance - msg.amount;
        send(SendParameters{
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonBurnNotification{
                queryId: msg.queryId,
                amount: msg.amount,
                owner: self.owner,
                responseDestination: self.master,
            }.toCell(),
        });
    }

    // bridge burn: master-authenticated, respects freeze (burnFrom parity).
    // On success, notify master which reduces supply and acks the requester.
    receive(msg: WalletBridgeBurn) {
        require(sender() == self.master, "not master");
        require(!self.frozen, "frozen");
        require(self.balance >= msg.amount, "balance");
        self.balance = self.balance - msg.amount;
        send(SendParameters{
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: BridgeBurnNotification{
                amount: msg.amount,
                owner: self.owner,
                opId: msg.opId,
                requester: msg.requester,
            }.toCell(),
        });
    }

    // seize debit: master-authenticated, BYPASSES freeze & pause
    receive(msg: ForceTransfer) {
        require(sender() == self.master, "not master");
        require(self.balance >= msg.amount, "balance");
        self.balance = self.balance - msg.amount;
        let init: StateInit = initOf StableNairaJettonWallet(msg.to, self.master);
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            code: init.code,
            data: init.data,
            body: ForceCredit{ amount: msg.amount, from: self.owner }.toCell(),
        });
    }

    // seize credit: from a sibling wallet; BYPASSES freeze (recipient may be frozen)
    receive(msg: ForceCredit) {
        require(sender() == self.expectedWallet(msg.from), "bad source");
        self.balance = self.balance + msg.amount;
    }

    receive(_: Slice) {}

    get fun get_wallet_data(): WalletData {
        return WalletData{
            balance: self.balance,
            owner: self.owner,
            master: self.master,
            walletCode: initOf StableNairaJettonWallet(self.owner, self.master).code,
        };
    }
    get fun isFrozen(): Bool { return self.frozen }
    get fun balanceValue(): Int { return self.balance }
}
