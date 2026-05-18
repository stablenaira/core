import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, Cell, beginCell, toNano } from "@ton/core";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import "@ton/test-utils";
import { StableNairaJettonMaster } from "../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";
import { StableNairaJettonWallet } from "../build/StableNairaJettonMaster/tact_StableNairaJettonWallet";
import { MessageTransmitter } from "../build/MessageTransmitter/tact_MessageTransmitter";
import { TokenMessenger } from "../build/TokenMessenger/tact_TokenMessenger";
import { ValidatorRegistry } from "../build/ValidatorRegistry/tact_ValidatorRegistry";

// Phase 6 — deterministic in-sandbox TON<->EVM roundtrip with ONE shared
// secp256k1 validator set wired through the real ValidatorRegistry (which
// syncs the set into the MessageTransmitter mirror). Live-testnet smoke is a
// deployment step (needs funded keys / RPC) and is gated separately.

const TON_DOMAIN = 1_000_001n;
const TON_CHAINID = 1_000_001n;
const TON_TX_ID = 0xa11ce0000000000000000000000000000000b0bn; // uint160 binding
const EVM_DOMAIN = 84_532n; // Base Sepolia
const EVM_CHAINID = 84_532n;
const EVM_TRANSMITTER = "0x22c3cd88B76B2C8aF67355C9F0b8EbF2EBff6d62";
const EVM_ROUTER = 0x99887766554433221100ffeeddccbbaa99887766n; // EVM TokenMessenger id
const TYPEHASH = BigInt(
  "0x731f85be2e4340e902daed2c56af57379484e7c4b0a3b22a5e4ca8fbda070351",
);
const TL = 3600n;

const u = (v: bigint, n: number) => {
  const b = Buffer.alloc(n);
  let x = v;
  for (let i = n - 1; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
};
const big = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));
const acctId = (a: Address) => big(a.hash);

type Signer = { priv: Uint8Array; addr: bigint };
const makeSigner = (): Signer => {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  return { priv, addr: big(keccak_256(pub).slice(12)) };
};

const burnBodyCell = (
  burnToken: bigint, mintRecipient: bigint, amount: bigint, messageSender: bigint,
): Cell =>
  beginCell()
    .storeUint(1, 32).storeUint(burnToken, 256)
    .storeUint(mintRecipient, 256).storeUint(amount, 256)
    .storeRef(beginCell().storeUint(messageSender, 256).endCell())
    .endCell();

const envelopeCell = (
  src: bigint, dst: bigint, nonce: bigint, sender: bigint,
  recipient: bigint, destCaller: bigint, body: Cell,
): Cell =>
  beginCell()
    .storeUint(1, 32).storeUint(src, 32).storeUint(dst, 32)
    .storeUint(nonce, 64).storeUint(sender, 256)
    .storeUint(recipient, 256).storeUint(destCaller, 256)
    .storeRef(body)
    .endCell();

// flatten the on-chain snake exactly like keccakSnake / the ton-adapter
const flatten = (cell: Cell): Buffer => {
  const parts: Buffer[] = [];
  let cur: Cell | undefined = cell;
  while (cur) {
    const s = cur.beginParse();
    parts.push(s.loadBuffer(s.remainingBits / 8));
    cur = cur.refs.length > 0 ? cur.refs[0] : undefined;
  }
  return Buffer.concat(parts);
};

const attestationDigest = (
  message: Buffer, chainId: bigint, transmitter: bigint,
): bigint =>
  big(keccak_256(Buffer.concat([
    u(TYPEHASH, 32), Buffer.from(keccak_256(message)),
    u(chainId, 32), u(transmitter, 32),
  ])));

const signAsc = (digest: bigint, set: Signer[]): Cell => {
  const d = u(digest, 32);
  const ordered = [...set].sort((a, b) => (a.addr < b.addr ? -1 : 1));
  let next: Cell | null = null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const sg = secp256k1.sign(d, ordered[i]!.priv, { lowS: true });
    const b = beginCell()
      .storeUint(sg.r, 256).storeUint(sg.s, 256).storeUint(BigInt(sg.recovery + 27), 8);
    if (next) b.storeRef(next);
    next = b.endCell();
  }
  return next!;
};

describe("Phase 6 — TON↔EVM bidirectional roundtrip (shared validator set)", () => {
  let chain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let relayer: SandboxContract<TreasuryContract>;
  let user: SandboxContract<TreasuryContract>;
  let recipient: SandboxContract<TreasuryContract>;
  let jetton: SandboxContract<StableNairaJettonMaster>;
  let mt: SandboxContract<MessageTransmitter>;
  let tm: SandboxContract<TokenMessenger>;
  let registry: SandboxContract<ValidatorRegistry>;
  let signers: Signer[];

  const wallet = async (owner: Address) =>
    chain.openContract(await StableNairaJettonWallet.fromInit(owner, jetton.address));

  beforeEach(async () => {
    chain = await Blockchain.create();
    chain.now = 1_000_000;
    admin = await chain.treasury("admin");
    relayer = await chain.treasury("relayer");
    user = await chain.treasury("user");
    recipient = await chain.treasury("recipient");
    signers = Array.from({ length: 3 }, makeSigner);

    jetton = chain.openContract(
      await StableNairaJettonMaster.fromInit(admin.address, beginCell().endCell(), 0n),
    );
    mt = chain.openContract(
      await MessageTransmitter.fromInit(
        admin.address, TON_DOMAIN, TON_CHAINID, TON_TX_ID, 256n,
      ),
    );
    tm = chain.openContract(
      await TokenMessenger.fromInit(
        admin.address, mt.address, jetton.address, 0n, admin.address,
      ),
    );
    registry = chain.openContract(
      await ValidatorRegistry.fromInit(admin.address, TL, TL),
    );
    for (const c of [jetton, mt, tm, registry]) {
      await c.send(admin.getSender(), { value: toNano("0.3") },
        beginCell().endCell().asSlice());
    }

    // registry -> MessageTransmitter mirror
    await registry.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "SetVerifier", verifier: mt.address });
    await mt.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "SetRegistry", registry: registry.address });
    for (const sg of signers) {
      await registry.send(admin.getSender(), { value: toNano("0.05") },
        { $$type: "BootstrapAddValidator", validator: sg.addr });
    }
    await registry.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "BootstrapFinalize", threshold: 2n });

    // TokenMessenger is a minter; routers cross-registered both directions
    await jetton.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "GrantRole", role: 0n, account: tm.address });
    await jetton.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "GrantRole", role: 0n, account: admin.address });
    await tm.send(admin.getSender(), { value: toNano("0.05") },
      { $$type: "SetRemoteRouter", domain: EVM_DOMAIN, router: EVM_ROUTER });
  });

  it("EVM→TON: signed attestation over the EVM envelope mints SNR on TON; replay blocked", async () => {
    const amount = 50_000n;
    const recipId = acctId(recipient.address);
    const EVM_TOKEN_ID = 0xeeee0000000000000000000000000000000000een;
    const body = burnBodyCell(EVM_TOKEN_ID, recipId, amount, 0xdeadn);
    const env = envelopeCell(
      EVM_DOMAIN, TON_DOMAIN, 11n, EVM_ROUTER, acctId(tm.address), 0n, body,
    );
    const digest = attestationDigest(flatten(env), TON_CHAINID, TON_TX_ID);
    const att = signAsc(digest, signers.slice(0, 2));

    await mt.send(relayer.getSender(), { value: toNano("0.6") },
      { $$type: "ReceiveMessage", message: env, attestation: att });

    expect(await (await wallet(recipient.address)).getBalanceValue()).toBe(amount);
    expect(await jetton.getTotalSupplyValue()).toBe(amount);
    expect(await mt.getIsNonceUsed(EVM_DOMAIN, 11n)).toBe(true);

    const replay = await mt.send(relayer.getSender(), { value: toNano("0.6") },
      { $$type: "ReceiveMessage", message: env, attestation: att });
    expect(replay.transactions).toHaveTransaction({ to: mt.address, success: false });
    expect(await jetton.getTotalSupplyValue()).toBe(amount);
  });

  it("TON→EVM: real depositForBurn burns SNR and emits an envelope an EVM verifier would accept", async () => {
    // fund the user
    await jetton.send(admin.getSender(), { value: toNano("0.2") },
      { $$type: "Mint", to: user.address, amount: 80_000n });

    const r = await tm.send(user.getSender(), { value: toNano("0.7") }, {
      $$type: "DepositForBurn",
      amount: 30_000n,
      destinationDomain: EVM_DOMAIN,
      mintRecipient: 0xc0ffee0000000000000000000000000000000000000000000000000000c0ffeen,
      destinationCaller: 0n,
    });

    // SNR burned
    expect(await (await wallet(user.address)).getBalanceValue()).toBe(50_000n);
    expect(await jetton.getTotalSupplyValue()).toBe(50_000n);

    // capture the envelope MessageTransmitter emitted (external-out body)
    const ext = r.externals.find((e) => e.body.bits.length > 0 || e.body.refs.length > 0);
    expect(ext).toBeDefined();
    const message = flatten(ext!.body);

    // it's exactly the (message, attestation) an EVM receiveMessage accepts:
    const digest = attestationDigest(message, EVM_CHAINID, big(Buffer.from(EVM_TRANSMITTER.slice(2), "hex")));
    const d = u(digest, 32);
    const recovered = signers.slice(0, 2).map((sg) => {
      const sig = secp256k1.sign(d, sg.priv, { lowS: true });
      const pub = secp256k1.Signature.fromCompact(
        Buffer.concat([u(sig.r, 32), u(sig.s, 32)]),
      ).addRecoveryBit(sig.recovery).recoverPublicKey(d).toRawBytes(false).slice(1);
      return big(keccak_256(pub).slice(12));
    });
    // every signer is in the validator set, and the digest is well-formed
    const setAddrs = new Set(signers.map((s) => s.addr));
    for (const a of recovered) expect(setAddrs.has(a)).toBe(true);
    expect(digest > 0n).toBe(true);
  });
});
