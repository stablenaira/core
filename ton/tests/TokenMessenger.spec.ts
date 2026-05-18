import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, Cell, beginCell, toNano } from "@ton/core";
import "@ton/test-utils";
import { StableNairaJettonMaster } from "../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";
import { StableNairaJettonWallet } from "../build/StableNairaJettonMaster/tact_StableNairaJettonWallet";
import { TokenMessenger } from "../build/TokenMessenger/tact_TokenMessenger";

const EMPTY = beginCell().endCell();
const EMPTY_SLICE = beginCell().endCell().asSlice();
const ROLE_MINTER = 0n;
const ROLE_FREEZER = 2n;
const SRC_DOMAIN = 99n;
const REMOTE_ROUTER = 0xaabbccddeeff00112233445566778899aabbccddn;

const acctId = (a: Address) => BigInt("0x" + a.hash.toString("hex"));

const burnBody = (
  burnToken: bigint, mintRecipient: bigint, amount: bigint, messageSender: bigint,
): Cell =>
  beginCell()
    .storeUint(1, 32).storeUint(burnToken, 256)
    .storeUint(mintRecipient, 256).storeUint(amount, 256)
    .storeRef(beginCell().storeUint(messageSender, 256).endCell())
    .endCell();

describe("Phase 4 — TokenMessenger burn→message + mint parity", () => {
  let chain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<TreasuryContract>;
  let user: SandboxContract<TreasuryContract>;
  let recipient: SandboxContract<TreasuryContract>;
  let transmitter: SandboxContract<TreasuryContract>; // stub
  let jetton: SandboxContract<StableNairaJettonMaster>;
  let tm: SandboxContract<TokenMessenger>;

  const wallet = async (owner: Address) =>
    chain.openContract(await StableNairaJettonWallet.fromInit(owner, jetton.address));

  const mintTo = (to: Address, amount: bigint) =>
    jetton.send(minter.getSender(), { value: toNano("0.2") },
      { $$type: "Mint", to, amount });

  beforeEach(async () => {
    chain = await Blockchain.create();
    admin = await chain.treasury("admin");
    minter = await chain.treasury("minter");
    user = await chain.treasury("user");
    recipient = await chain.treasury("recipient");
    transmitter = await chain.treasury("transmitter");

    jetton = chain.openContract(
      await StableNairaJettonMaster.fromInit(admin.address, EMPTY, 0n),
    );
    await jetton.send(admin.getSender(), { value: toNano("0.5") }, EMPTY_SLICE);

    tm = chain.openContract(
      await TokenMessenger.fromInit(
        admin.address, transmitter.address, jetton.address, 0n, admin.address,
      ),
    );
    await tm.send(admin.getSender(), { value: toNano("0.3") }, EMPTY_SLICE);

    for (const acct of [tm.address, minter.address]) {
      await jetton.send(admin.getSender(), { value: toNano("0.05") },
        { $$type: "GrantRole", role: ROLE_MINTER, account: acct });
    }
    await mintTo(user.address, 100000n);
    await tm.send(admin.getSender(), { value: toNano("0.05") }, {
      $$type: "SetRemoteRouter", domain: SRC_DOMAIN, router: REMOTE_ROUTER,
    });
  });

  const deposit = (over: Partial<{ amount: bigint; dom: bigint; recip: bigint; caller: bigint }> = {}) =>
    tm.send(user.getSender(), { value: toNano("0.6") }, {
      $$type: "DepositForBurn",
      amount: over.amount ?? 40000n,
      destinationDomain: over.dom ?? SRC_DOMAIN,
      mintRecipient: over.recip ?? 0xdeadbeefn,
      destinationCaller: over.caller ?? 0n,
    });

  it("depositForBurn burns the holder, reduces supply, emits one CCTP message, clears the intent", async () => {
    const r = await deposit({ amount: 40000n });
    const uw = await wallet(user.address);
    expect(await uw.getBalanceValue()).toBe(60000n);
    expect(await jetton.getTotalSupplyValue()).toBe(60000n);
    expect(await tm.getHasIntent(0n)).toBe(false);
    expect(await tm.getNextOpIdValue()).toBe(1n);

    // exactly one SendMessage reached the transmitter; decode it (fee dormant)
    const toTx = r.transactions.find(
      (t) => t.inMessage?.info.type === "internal" &&
        (t.inMessage.info.dest as Address).equals(transmitter.address),
    );
    expect(toTx).toBeDefined();
    const s = toTx!.inMessage!.body.beginParse();
    expect(s.loadUint(32)).toBe(0x4d540110); // SendMessage op
    expect(s.loadUint(32)).toBe(Number(SRC_DOMAIN)); // destinationDomain
    expect(BigInt(s.loadUintBig(256))).toBe(REMOTE_ROUTER); // recipient = router
    s.loadUintBig(256); // destinationCaller
    const body = s.loadRef().beginParse();
    expect(body.loadUint(32)).toBe(1); // BODY_VERSION
    expect(BigInt(body.loadUintBig(256))).toBe(acctId(jetton.address)); // burnToken
    expect(BigInt(body.loadUintBig(256))).toBe(0xdeadbeefn); // mintRecipient
    expect(body.loadUintBig(256)).toBe(40000n); // amount (fee dormant -> unchanged)
    expect(BigInt(body.loadRef().beginParse().loadUintBig(256))).toBe(
      acctId(user.address),
    ); // messageSender
  });

  it("rejects paused / zero amount / zero recipient / unregistered router", async () => {
    await tm.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "TmSetPaused", paused: true });
    expect((await deposit()).transactions).toHaveTransaction({ to: tm.address, success: false });
    await tm.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "TmSetPaused", paused: false });

    expect((await deposit({ amount: 0n })).transactions)
      .toHaveTransaction({ to: tm.address, success: false });
    expect((await deposit({ recip: 0n })).transactions)
      .toHaveTransaction({ to: tm.address, success: false });
    expect((await deposit({ dom: 12345n })).transactions)
      .toHaveTransaction({ to: tm.address, success: false });
    expect(await jetton.getTotalSupplyValue()).toBe(100000n); // nothing burned
  });

  it("BridgeBurn bounce (TokenMessenger lacks minter) clears the intent and emits no message", async () => {
    await jetton.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "RevokeRole", role: ROLE_MINTER, account: tm.address });
    const r = await deposit({ amount: 10000n });
    expect(await tm.getHasIntent(0n)).toBe(false); // rolled back by bounced()
    expect(await jetton.getTotalSupplyValue()).toBe(100000n); // no burn
    expect(r.transactions).not.toHaveTransaction({
      from: tm.address, to: transmitter.address,
    });
  });

  it("frozen depositor: no burn, no CCTP message (safety preserved)", async () => {
    await jetton.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "GrantRole", role: ROLE_FREEZER, account: admin.address });
    await jetton.send(admin.getSender(), { value: toNano("0.1") },
      { $$type: "FreezeAccount", account: user.address });
    const r = await deposit({ amount: 10000n });
    expect(await jetton.getTotalSupplyValue()).toBe(100000n);
    expect(await (await wallet(user.address)).getBalanceValue()).toBe(100000n);
    expect(r.transactions).not.toHaveTransaction({
      from: tm.address, to: transmitter.address,
    });
  });

  it("handleReceiveMessage: only transmitter, router+sender+version checks, then mint", async () => {
    const recipId = acctId(recipient.address);
    const good = {
      $$type: "HandleReceiveMessage" as const,
      sourceDomain: SRC_DOMAIN,
      nonce: 5n,
      sender: REMOTE_ROUTER,
      body: burnBody(acctId(jetton.address), recipId, 25000n, 0x1234n),
    };

    // not the transmitter -> reject
    const bad = await tm.send(user.getSender(), { value: toNano("0.3") }, good);
    expect(bad.transactions).toHaveTransaction({ to: tm.address, success: false });

    // wrong remote sender -> reject
    const wrongSender = await tm.send(transmitter.getSender(), { value: toNano("0.3") },
      { ...good, sender: 0x9999n });
    expect(wrongSender.transactions).toHaveTransaction({ to: tm.address, success: false });

    // bad body version -> reject
    const badVer = await tm.send(transmitter.getSender(), { value: toNano("0.3") }, {
      ...good,
      body: beginCell().storeUint(2, 32).storeUint(0, 256).storeUint(recipId, 256)
        .storeUint(25000n, 256).storeRef(beginCell().storeUint(0, 256).endCell()).endCell(),
    });
    expect(badVer.transactions).toHaveTransaction({ to: tm.address, success: false });

    // happy path -> mint to recipient
    await tm.send(transmitter.getSender(), { value: toNano("0.4") }, good);
    expect(await (await wallet(recipient.address)).getBalanceValue()).toBe(25000n);
    expect(await jetton.getTotalSupplyValue()).toBe(125000n);
  });
});
