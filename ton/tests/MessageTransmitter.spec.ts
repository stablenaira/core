import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, Cell, beginCell, toNano } from "@ton/core";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import "@ton/test-utils";
import { MessageTransmitter } from "../build/MessageTransmitter/tact_MessageTransmitter";
import { MockMessageHandler } from "../build/MockMessageHandler/tact_MockMessageHandler";

const LOCAL_DOMAIN = 1_000_001n; // TON CCTP domain
const CHAIN_ID = 1_000_001n;
const TRANSMITTER_ID = 0xabcdef0123456789abcdef0123456789abcdef01n; // uint160
const TYPEHASH = BigInt(
  "0x731f85be2e4340e902daed2c56af57379484e7c4b0a3b22a5e4ca8fbda070351",
);

const u = (v: bigint, bytes: number) => {
  const b = Buffer.alloc(bytes);
  let x = v;
  for (let i = bytes - 1; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
};
const big = (buf: Uint8Array) => BigInt("0x" + Buffer.from(buf).toString("hex"));

// snake of raw bytes: <=127 bytes data per cell, ref to next
const bytesToSnake = (buf: Buffer): Cell => {
  const CH = 127;
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += CH) parts.push(buf.subarray(i, i + CH));
  if (parts.length === 0) parts.push(Buffer.alloc(0));
  let next: Cell | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const b = beginCell().storeBuffer(parts[i]);
    if (next) b.storeRef(next);
    next = b.endCell();
  }
  return next!;
};

type Env = {
  version: bigint; src: bigint; dst: bigint; nonce: bigint;
  sender: bigint; recipient: bigint; destCaller: bigint; body: Buffer;
};

const packEnvelope = (e: Env): Buffer =>
  Buffer.concat([
    u(e.version, 4), u(e.src, 4), u(e.dst, 4), u(e.nonce, 8),
    u(e.sender, 32), u(e.recipient, 32), u(e.destCaller, 32), e.body,
  ]);

const envelopeCell = (e: Env): Cell =>
  beginCell()
    .storeUint(e.version, 32).storeUint(e.src, 32).storeUint(e.dst, 32)
    .storeUint(e.nonce, 64).storeUint(e.sender, 256)
    .storeUint(e.recipient, 256).storeUint(e.destCaller, 256)
    .storeRef(bytesToSnake(e.body))
    .endCell();

// EVM-faithful reference digest
const refAttestationDigest = (e: Env): bigint => {
  const envelopeHash = keccak_256(packEnvelope(e));
  const preimage = Buffer.concat([
    u(TYPEHASH, 32), Buffer.from(envelopeHash),
    u(CHAIN_ID, 32), u(TRANSMITTER_ID, 32),
  ]);
  return big(keccak_256(preimage));
};

const buildAttestation = (sigs: { r: bigint; s: bigint; v: bigint }[]): Cell => {
  let next: Cell | null = null;
  for (let i = sigs.length - 1; i >= 0; i--) {
    const b = beginCell()
      .storeUint(sigs[i].r, 256).storeUint(sigs[i].s, 256).storeUint(sigs[i].v, 8);
    if (next) b.storeRef(next);
    next = b.endCell();
  }
  return next ?? beginCell().endCell();
};

describe("Phase 3 — MessageTransmitter digest parity + send/receive", () => {
  let chain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let registry: SandboxContract<TreasuryContract>;
  let relayer: SandboxContract<TreasuryContract>;
  let tx: SandboxContract<MessageTransmitter>;
  let handler: SandboxContract<MockMessageHandler>;
  let signers: { priv: Uint8Array; addr: bigint }[];

  const makeSigner = () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, false).slice(1);
    return { priv, addr: big(keccak_256(pub).slice(12)) };
  };

  const seed = async (set: typeof signers, threshold: number) => {
    for (const sg of set) {
      await tx.send(registry.getSender(), { value: toNano("0.05") },
        { $$type: "SyncAddValidator", validator: sg.addr });
    }
    await tx.send(registry.getSender(), { value: toNano("0.05") },
      { $$type: "SyncSetThreshold", newThreshold: BigInt(threshold) });
  };

  const attestFor = (digest: bigint, set: typeof signers): Cell => {
    const d = u(digest, 32);
    const ordered = [...set].sort((a, b) => (a.addr < b.addr ? -1 : 1));
    return buildAttestation(ordered.map((sg) => {
      const s = secp256k1.sign(d, sg.priv, { lowS: true });
      return { r: s.r, s: s.s, v: BigInt(s.recovery + 27) };
    }));
  };

  beforeEach(async () => {
    chain = await Blockchain.create();
    owner = await chain.treasury("owner");
    registry = await chain.treasury("registry");
    relayer = await chain.treasury("relayer");
    tx = chain.openContract(
      await MessageTransmitter.fromInit(
        owner.address, LOCAL_DOMAIN, CHAIN_ID, TRANSMITTER_ID, 256n,
      ),
    );
    handler = chain.openContract(await MockMessageHandler.fromInit());
    await tx.send(owner.getSender(), { value: toNano("0.1") },
      beginCell().endCell().asSlice());
    await handler.send(owner.getSender(), { value: toNano("0.1") },
      beginCell().endCell().asSlice());
    await tx.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "SetRegistry", registry: registry.address });
    signers = Array.from({ length: 4 }, makeSigner);
  });

  const handlerRecipient = () => big(handler.address.hash);

  const envFor = (over: Partial<Env> = {}): Env => ({
    version: 1n, src: 99n, dst: LOCAL_DOMAIN, nonce: 7n,
    sender: 0x1234n, recipient: handlerRecipient(), destCaller: 0n,
    body: Buffer.from("redeem-ref-001", "utf8"),
    ...over,
  });

  it("attestationDigest is byte-identical to the EVM abi.encode reference (small + 132B body)", async () => {
    for (const body of [Buffer.from("x", "utf8"), Buffer.alloc(132, 0xab)]) {
      const e = envFor({ body });
      const cell = envelopeCell(e);
      expect(await tx.getEnvelopeHashOf(cell)).toBe(big(keccak_256(packEnvelope(e))));
      expect(await tx.getAttestationDigestOf(cell)).toBe(refAttestationDigest(e));
    }
  });

  it("sendMessage increments nonce and rejects local-dest / oversize / paused", async () => {
    await tx.send(relayer.getSender(), { value: toNano("0.1") }, {
      $$type: "SendMessage", destinationDomain: 99n, recipient: 0xdeadn,
      destinationCaller: 0n, body: beginCell().storeBuffer(Buffer.from("hi")).endCell(),
    });
    expect(await tx.getNextNonceValue()).toBe(1n);

    const local = await tx.send(relayer.getSender(), { value: toNano("0.1") }, {
      $$type: "SendMessage", destinationDomain: LOCAL_DOMAIN, recipient: 0xdeadn,
      destinationCaller: 0n, body: beginCell().endCell(),
    });
    expect(local.transactions).toHaveTransaction({ to: tx.address, success: false });

    const big2 = await tx.send(relayer.getSender(), { value: toNano("0.1") }, {
      $$type: "SendMessage", destinationDomain: 99n, recipient: 0xdeadn,
      destinationCaller: 0n, body: bytesToSnake(Buffer.alloc(300, 1)),
    });
    expect(big2.transactions).toHaveTransaction({ to: tx.address, success: false });

    await tx.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "MtSetPaused", paused: true });
    const paused = await tx.send(relayer.getSender(), { value: toNano("0.1") }, {
      $$type: "SendMessage", destinationDomain: 99n, recipient: 0xdeadn,
      destinationCaller: 0n, body: beginCell().endCell(),
    });
    expect(paused.transactions).toHaveTransaction({ to: tx.address, success: false });
    expect(await tx.getNextNonceValue()).toBe(1n);
  });

  it("receiveMessage verifies a quorum, dispatches to the handler, and blocks replay", async () => {
    await seed(signers, 2);
    const e = envFor();
    const cell = envelopeCell(e);
    const att = attestFor(refAttestationDigest(e), signers.slice(0, 2));

    await tx.send(relayer.getSender(), { value: toNano("0.3") },
      { $$type: "ReceiveMessage", message: cell, attestation: att });
    expect(await handler.getReceivedCountValue()).toBe(1n);
    expect(await handler.getLastNonceValue()).toBe(7n);
    expect(await tx.getIsNonceUsed(e.src, e.nonce)).toBe(true);

    const replay = await tx.send(relayer.getSender(), { value: toNano("0.3") },
      { $$type: "ReceiveMessage", message: cell, attestation: att });
    expect(replay.transactions).toHaveTransaction({ to: tx.address, success: false });
    expect(await handler.getReceivedCountValue()).toBe(1n);
  });

  it("rejects a bad attestation, wrong version, and wrong destination domain", async () => {
    await seed(signers, 2);
    const e = envFor();
    const cell = envelopeCell(e);

    const outsider = [makeSigner(), makeSigner()];
    const badAtt = attestFor(refAttestationDigest(e), outsider);
    const r1 = await tx.send(relayer.getSender(), { value: toNano("0.3") },
      { $$type: "ReceiveMessage", message: cell, attestation: badAtt });
    expect(r1.transactions).toHaveTransaction({ to: tx.address, success: false });
    expect(await tx.getIsNonceUsed(e.src, e.nonce)).toBe(false);

    const eV = envFor({ version: 2n });
    const r2 = await tx.send(relayer.getSender(), { value: toNano("0.3") }, {
      $$type: "ReceiveMessage", message: envelopeCell(eV),
      attestation: attestFor(refAttestationDigest(eV), signers.slice(0, 2)),
    });
    expect(r2.transactions).toHaveTransaction({ to: tx.address, success: false });

    const eD = envFor({ dst: 12345n });
    const r3 = await tx.send(relayer.getSender(), { value: toNano("0.3") }, {
      $$type: "ReceiveMessage", message: envelopeCell(eD),
      attestation: attestFor(refAttestationDigest(eD), signers.slice(0, 2)),
    });
    expect(r3.transactions).toHaveTransaction({ to: tx.address, success: false });
  });

  it("handler failure bounces and rolls back the used-nonce mark (retry succeeds)", async () => {
    await seed(signers, 2);
    const e = envFor({ nonce: 42n });
    const cell = envelopeCell(e);
    const att = attestFor(refAttestationDigest(e), signers.slice(0, 2));

    await handler.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "SetFail", fail: true });
    await tx.send(relayer.getSender(), { value: toNano("0.3") },
      { $$type: "ReceiveMessage", message: cell, attestation: att });
    expect(await handler.getReceivedCountValue()).toBe(0n);
    expect(await tx.getIsNonceUsed(e.src, e.nonce)).toBe(false); // rolled back

    await handler.send(owner.getSender(), { value: toNano("0.05") },
      { $$type: "SetFail", fail: false });
    await tx.send(relayer.getSender(), { value: toNano("0.3") },
      { $$type: "ReceiveMessage", message: cell, attestation: att });
    expect(await handler.getReceivedCountValue()).toBe(1n);
    expect(await tx.getIsNonceUsed(e.src, e.nonce)).toBe(true);
  });
});
