// StableNaira (SNR) — TON mainnet deploy.
//
// Sends, sequentially, from the v5R1 deployer wallet (env: TON_DEPLOYER_MNEMONIC):
//   1) deploy StableNairaJettonMaster (admin = deployer, on-chain TEP-64 content, mintCap = 0)
//   2) deploy MessageTransmitter (owner = deployer, localDomain, chainId, transmitterId, maxBodySize)
//   3) deploy TokenMessenger (owner = deployer, messageTransmitter, localToken = jetton master, feeBps = 0, feeRecipient = deployer)
//   4) deploy ValidatorRegistry (owner = deployer, timelock, minTimelock)
//   5) wire: registry.SetVerifier(mt) → mt.SetRegistry(registry) → bootstrap validators → finalize threshold
//   6) wire: jetton.GrantRole(MINTER, tm) → tm.SetRemoteRouter(...) for each EVM mainnet pair
// Writes the resulting artifact to ignition/deployments/tonMainnet/addresses.json.
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
// The repo's .env lives at core/.env (one level up from core/ton/).
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });
import {
  Address,
  beginCell,
  Cell,
  Dictionary,
  internal,
  SendMode,
  toNano,
} from "@ton/core";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey, sha256_sync } from "@ton/crypto";
import { getHttpEndpoint } from "@orbs-network/ton-access";

import { StableNairaJettonMaster } from "../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";
import { MessageTransmitter } from "../build/MessageTransmitter/tact_MessageTransmitter";
import { TokenMessenger } from "../build/TokenMessenger/tact_TokenMessenger";
import { ValidatorRegistry } from "../build/ValidatorRegistry/tact_ValidatorRegistry";

// ---------- config ----------
// Default to Orbs ton-access (no API key needed, decentralised RPC pool).
// Override with TON_MAINNET_RPC if a private endpoint is preferred.

const LOCAL_DOMAIN = 1_000_001n;     // canonical non-EVM domain id for TON
const CHAIN_ID     = 504n;           // digest binding (clean small id)
const TRANSMITTER  = 504n;           // digest binding (clean small id)
const MAX_BODY     = 4096n;          // matches EVM mainnet
const TIMELOCK_S   = 3600n;          // 1h, matches EVM mainnet
const FEE_BPS      = 0n;             // dormant fee path
const MINT_CAP     = 0n;             // 0 = unlimited
const THRESHOLD    = 1n;             // matches EVM mainnet validator set
const VALIDATOR    = 0x2503Cba0edfEe3F790D14bA141b92B11816EC987n; // EVM mainnet signer

const REMOTE_ROUTERS: { domain: bigint; router: bigint; label: string }[] = [
  { domain: 56n,    router: 0xbE1Ed9d08141d4c8331Ba30ECb64fF42F1512F31n, label: "BSC"        },
  { domain: 1n,     router: 0xAfE9BBCe49428EC10F833190cFdc19eB72A1B59Fn, label: "Ethereum"   },
  { domain: 8453n,  router: 0xAfE9BBCe49428EC10F833190cFdc19eB72A1B59Fn, label: "Base"       },
  { domain: 42420n, router: 0x534ffE8ac515BC5aB681D86973748D85041bFE8Dn, label: "AssetChain" },
];

const ROLE_MINTER = 0n;

// Tact message opcodes (must match contract definitions)
const OP_SET_VERIFIER          = 0x56520100;
const OP_BOOTSTRAP_ADD         = 0x56520101;
const OP_BOOTSTRAP_FINALIZE    = 0x56520102;
const OP_MT_SET_REGISTRY       = 0x4d540100;
const OP_GRANT_ROLE            = 0x534e5207;
const OP_SET_REMOTE_ROUTER     = 0x544d0103;

// ---------- helpers ----------
function buildOnchainMetadata(meta: Record<string, string>): Cell {
  const d = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  for (const [k, v] of Object.entries(meta)) {
    const keyHash = BigInt("0x" + sha256_sync(k).toString("hex"));
    const value = beginCell().storeUint(0, 8).storeStringTail(v).endCell();
    d.set(keyHash, value);
  }
  return beginCell().storeUint(0, 8).storeDict(d).endCell();
}

function pad32hex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function evmAddr(n: bigint): string {
  return "0x" + n.toString(16).padStart(40, "0");
}

async function waitSeqno(
  wallet: ReturnType<TonClient["open"]>,
  prev: number,
  label: string,
  timeoutMs = 90_000,
): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const s = await (wallet as any).getSeqno();
      if (s > prev) return s;
    } catch { /* transient RPC errors are fine */ }
  }
  throw new Error(`timeout waiting for confirmation after ${label}`);
}

async function waitDeployed(client: TonClient, addr: Address, label: string, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const s = await client.getContractState(addr);
      if (s.state === "active") return;
    } catch { /* transient */ }
  }
  throw new Error(`timeout waiting for ${label} to become active`);
}

async function isActive(client: TonClient, addr: Address): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    try {
      const s = await client.getContractState(addr);
      return s.state === "active";
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

function isTransient(e: any): boolean {
  const status = e?.response?.status ?? e?.status;
  if (status && [429, 500, 502, 503, 504].includes(status)) return true;
  const code = e?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNABORTED";
}

// ---------- main ----------
async function main() {
  const mnemonicRaw = (process.env.TON_DEPLOYER_MNEMONIC ?? "").trim();
  if (!mnemonicRaw) throw new Error("TON_DEPLOYER_MNEMONIC not set");
  const keys = await mnemonicToPrivateKey(mnemonicRaw.split(/\s+/));

  const endpoint = process.env.TON_MAINNET_RPC?.trim()
    || (await getHttpEndpoint({ network: "mainnet" }));
  const apiKey = process.env.TONCENTER_API_KEY?.trim() || undefined;
  console.log(`rpc:      ${endpoint}`);
  const client = new TonClient({ endpoint, apiKey });

  const w = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey });
  const wallet = client.open(w);
  const deployer = wallet.address;
  console.log(`deployer: ${deployer.toString({ bounceable: false, urlSafe: true })}`);

  const dryRun = process.env.DRY_RUN === "1";
  const balance = await client.getBalance(deployer);
  console.log(`balance:  ${(Number(balance) / 1e9).toFixed(4)} TON`);
  // 4 deploys (~0.3 each) + ~10 wiring msgs (~0.05 each) + cushion → ~2 TON
  if (!dryRun && balance < toNano("2")) throw new Error("deployer balance < 2 TON");

  // ---- TEP-64 on-chain content ----
  const content = buildOnchainMetadata({
    name: "StableNaira",
    description:
      "Naira-pegged stablecoin (StableNaira / SNR) issued by SMC DAO. " +
      "Bridged cross-chain via the StableNaira CCTP protocol — BSC, Ethereum, Base, Asset Chain, Solana, and TON.",
    symbol: "SNR",
    decimals: "2",
    image: "https://raw.githubusercontent.com/stablenaira/branding/main/snr-logo-512.png",
  });

  // ---- Compute StateInit for every contract (predict mainnet addresses) ----
  const jetton   = await StableNairaJettonMaster.fromInit(deployer, content, MINT_CAP);
  const mt       = await MessageTransmitter.fromInit(deployer, LOCAL_DOMAIN, CHAIN_ID, TRANSMITTER, MAX_BODY);
  const tm       = await TokenMessenger.fromInit(deployer, mt.address, jetton.address, FEE_BPS, deployer);
  const registry = await ValidatorRegistry.fromInit(deployer, TIMELOCK_S, TIMELOCK_S);

  const fmt = (a: Address) => a.toString({ bounceable: true, urlSafe: true });
  console.log(`predicted:`);
  console.log(`  jetton             ${fmt(jetton.address)}`);
  console.log(`  messageTransmitter ${fmt(mt.address)}`);
  console.log(`  tokenMessenger     ${fmt(tm.address)}`);
  console.log(`  validatorRegistry  ${fmt(registry.address)}`);
  if (dryRun) { console.log(`DRY_RUN=1 — stopping before sending any tx`); return; }

  // ---- helper to send one internal msg from the v5R1 wallet ----
  const sendOne = async (label: string, msg: any) => {
    // capture starting seqno (tolerant of transient RPC errors)
    const getSeqnoSafe = async (): Promise<number> => {
      for (let i = 0; i < 6; i++) {
        try { return await wallet.getSeqno(); }
        catch { await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
      }
      throw new Error(`unable to read seqno (${label})`);
    };
    const seqno = await getSeqnoSafe();
    let lastErr: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await wallet.sendTransfer({
          seqno,
          secretKey: keys.secretKey,
          sendMode: SendMode.PAY_GAS_SEPARATELY,
          messages: [msg],
        });
        process.stdout.write(`sent  ${label} (seqno ${seqno})`);
        const next = await waitSeqno(wallet, seqno, label);
        process.stdout.write(` → confirmed (seqno ${next})\n`);
        return;
      } catch (e: any) {
        lastErr = e;
        if (!isTransient(e)) throw e;
        const cur = await getSeqnoSafe().catch(() => seqno);
        if (cur > seqno) {
          // The send actually landed despite the error response — move on.
          console.log(`sent  ${label} (seqno ${seqno}) → confirmed (seqno ${cur}, recovered from transient)`);
          return;
        }
        const backoff = 5000 * (attempt + 1);
        console.log(`transient ${e?.response?.status ?? e?.code ?? "err"} on ${label}; retrying in ${backoff}ms (attempt ${attempt + 1}/5)`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw lastErr ?? new Error(`failed to send ${label}`);
  };

  // ---- Step 1: deploy the four contracts ----
  const deploys = [
    { c: jetton,   label: "StableNairaJettonMaster" },
    { c: mt,       label: "MessageTransmitter"      },
    { c: tm,       label: "TokenMessenger"          },
    { c: registry, label: "ValidatorRegistry"       },
  ];
  for (const { c, label } of deploys) {
    if (await isActive(client, c.address)) {
      console.log(`skip   ${label} (already active at ${fmt(c.address)})`);
      continue;
    }
    await sendOne(`deploy  ${label}`, internal({
      to: c.address,
      value: toNano("0.3"),
      bounce: false,
      init: c.init,
      body: beginCell().endCell(),
    }));
  }
  for (const { c, label } of deploys) {
    await waitDeployed(client, c.address, label);
    console.log(`active  ${label}`);
  }

  // ---- Step 2: registry ↔ MT wiring + bootstrap ----
  await sendOne(`wire    registry.SetVerifier(mt)`, internal({
    to: registry.address,
    value: toNano("0.05"),
    bounce: true,
    body: beginCell().storeUint(OP_SET_VERIFIER, 32).storeAddress(mt.address).endCell(),
  }));
  await sendOne(`wire    mt.SetRegistry(registry)`, internal({
    to: mt.address,
    value: toNano("0.05"),
    bounce: true,
    body: beginCell().storeUint(OP_MT_SET_REGISTRY, 32).storeAddress(registry.address).endCell(),
  }));
  await sendOne(`boot    registry.BootstrapAddValidator(${evmAddr(VALIDATOR)})`, internal({
    to: registry.address,
    value: toNano("0.05"),
    bounce: true,
    body: beginCell().storeUint(OP_BOOTSTRAP_ADD, 32).storeUint(VALIDATOR, 256).endCell(),
  }));
  await sendOne(`boot    registry.BootstrapFinalize(threshold=${THRESHOLD})`, internal({
    to: registry.address,
    value: toNano("0.05"),
    bounce: true,
    body: beginCell().storeUint(OP_BOOTSTRAP_FINALIZE, 32).storeUint(THRESHOLD, 32).endCell(),
  }));

  // ---- Step 3: grant MINTER to TokenMessenger + register remote routers ----
  await sendOne(`role    jetton.GrantRole(MINTER, tm)`, internal({
    to: jetton.address,
    value: toNano("0.05"),
    bounce: true,
    body: beginCell()
      .storeUint(OP_GRANT_ROLE, 32)
      .storeUint(ROLE_MINTER, 8)
      .storeAddress(tm.address)
      .endCell(),
  }));
  for (const r of REMOTE_ROUTERS) {
    await sendOne(`route   tm.SetRemoteRouter(${r.label}, domain=${r.domain})`, internal({
      to: tm.address,
      value: toNano("0.05"),
      bounce: true,
      body: beginCell()
        .storeUint(OP_SET_REMOTE_ROUTER, 32)
        .storeUint(r.domain, 32)
        .storeUint(r.router, 256)
        .endCell(),
    }));
  }

  // ---- Step 4: artifact ----
  const out = {
    network: "tonMainnet",
    workchain: 0,
    domainId: Number(LOCAL_DOMAIN),
    chainId: Number(CHAIN_ID),
    transmitterId: Number(TRANSMITTER),
    explorerUrl: "https://tonviewer.com",
    deployer: deployer.toString({ bounceable: false, urlSafe: true }),
    deployedAt: new Date().toISOString(),
    contracts: {
      stableNairaJettonMaster: fmt(jetton.address),
      validatorRegistry:       fmt(registry.address),
      messageTransmitter:      fmt(mt.address),
      tokenMessenger:          fmt(tm.address),
    },
    configuration: {
      tokenName: "StableNaira",
      tokenSymbol: "SNR",
      decimals: 2,
      mintCap: Number(MINT_CAP),
      timelockSeconds: Number(TIMELOCK_S),
      validators: [evmAddr(VALIDATOR)],
      threshold: Number(THRESHOLD),
      feeBps: Number(FEE_BPS),
      maxMessageBodySize: Number(MAX_BODY),
      minterRoleGranted: true,
    },
    remoteRouters: REMOTE_ROUTERS.map(r => ({
      domain: Number(r.domain),
      router: pad32hex(r.router),
      label: r.label,
    })),
  };

  const outDir = path.resolve(__dirname, "..", "..", "ignition", "deployments", "tonMainnet");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote   ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
