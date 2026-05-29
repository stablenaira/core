// Wire TON token_messenger to all 9 peer domains.
// TON already has 4 EVM peers (BSC, Ethereum, Base, AssetChain) committed via
// deploy-mainnet.ts. This script adds the remaining 5: Polygon, Avalanche,
// Arbitrum, Optimism, Solana — each via SetRemoteRouter (opcode 0x544d0103).
//
// Re-running is safe: SetRemoteRouter is unconditional on the contract (it
// just overwrites the map entry).

import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });
import { beginCell, internal, SendMode, toNano, Address } from "@ton/core";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { getHttpEndpoint } from "@orbs-network/ton-access";

const OP_SET_REMOTE_ROUTER = 0x544d0103;

const CORE_ROOT = path.resolve(__dirname, "..", "..");

function loadAddr(net: string): any {
  return JSON.parse(fs.readFileSync(path.join(CORE_ROOT, "ignition", "deployments", net, "addresses.json"), "utf-8"));
}

function bytes32EvmToBigInt(addr: string): bigint {
  // EVM tokenMessenger (20 bytes hex) left-padded to 32 bytes, returned as bigint.
  const clean = addr.toLowerCase().replace(/^0x/, "");
  return BigInt("0x" + clean.padStart(64, "0"));
}

async function waitSeqno(wallet: any, prev: number, label: string, timeoutMs = 90_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const s = await wallet.getSeqno();
      if (s > prev) return s;
    } catch {}
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function getSeqnoSafe(wallet: any, label: string): Promise<number> {
  for (let i = 0; i < 6; i++) {
    try { return await wallet.getSeqno(); } catch { await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  throw new Error(`unable to read seqno (${label})`);
}

async function main() {
  const mnemonic = (process.env.TON_DEPLOYER_MNEMONIC ?? "").trim();
  if (!mnemonic) throw new Error("TON_DEPLOYER_MNEMONIC not set");
  const keys = await mnemonicToPrivateKey(mnemonic.split(/\s+/));

  const endpoint = process.env.TON_MAINNET_RPC?.trim() || (await getHttpEndpoint({ network: "mainnet" }));
  const apiKey = process.env.TONCENTER_API_KEY?.trim() || undefined;
  console.log(`rpc:      ${endpoint}`);
  const client = new TonClient({ endpoint, apiKey });

  const wContract = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey });
  const wallet = client.open(wContract);
  const deployer = wallet.address;
  console.log(`deployer: ${deployer.toString({ bounceable: false, urlSafe: true })}`);
  const bal = await client.getBalance(deployer);
  console.log(`balance:  ${(Number(bal) / 1e9).toFixed(4)} TON\n`);

  const tonRec = loadAddr("tonMainnet");
  const tmAddr = Address.parse(tonRec.contracts.tokenMessenger);
  console.log(`tokenMessenger: ${tmAddr.toString({ bounceable: true, urlSafe: true })}\n`);

  // Existing routes already committed (will skip)
  const existing = new Set<number>((tonRec.remoteRouters ?? []).map((r: any) => Number(r.domain)));
  console.log(`existing routes: ${[...existing].join(", ") || "(none)"}\n`);

  // Solana router = token_messenger config PDA = 0x761a…ec9ee
  const SOLANA_ROUTER = BigInt("0x761aa100ac1ff3806092f100b3f267d01b3b099ec8ff8c3522f9d31b187ec9ee");

  const peers = [
    { domain: 137,     router: bytes32EvmToBigInt(loadAddr("polygon").contracts.tokenMessenger),    label: "Polygon"   },
    { domain: 43114,   router: bytes32EvmToBigInt(loadAddr("avalanche").contracts.tokenMessenger),  label: "Avalanche" },
    { domain: 42161,   router: bytes32EvmToBigInt(loadAddr("arbitrum").contracts.tokenMessenger),   label: "Arbitrum"  },
    { domain: 10,      router: bytes32EvmToBigInt(loadAddr("optimism").contracts.tokenMessenger),   label: "Optimism"  },
    { domain: 101,     router: SOLANA_ROUTER,                                                       label: "Solana"    },
  ];

  const added: any[] = [];
  for (const p of peers) {
    if (existing.has(p.domain)) {
      console.log(`  ${p.label.padEnd(11)} domain=${String(p.domain).padEnd(8)} already in manifest — skip`);
      continue;
    }
    const seqno = await getSeqnoSafe(wallet, `${p.label} seqno`);
    const body = beginCell()
      .storeUint(OP_SET_REMOTE_ROUTER, 32)
      .storeUint(p.domain, 32)
      .storeUint(p.router, 256)
      .endCell();
    console.log(`  ${p.label.padEnd(11)} domain=${String(p.domain).padEnd(8)} router=0x${p.router.toString(16).padStart(64, "0").slice(0, 12)}…  → tm.SetRemoteRouter`);
    await wallet.sendTransfer({
      seqno,
      secretKey: keys.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({ to: tmAddr, value: toNano("0.05"), bounce: true, body }),
      ],
    });
    const next = await waitSeqno(wallet, seqno, p.label);
    console.log(`    confirmed (seqno ${seqno} -> ${next})`);
    added.push({
      domain: p.domain,
      router: "0x" + p.router.toString(16).padStart(64, "0"),
      label: p.label,
    });
  }

  // Persist
  const addrFile = path.join(CORE_ROOT, "ignition", "deployments", "tonMainnet", "addresses.json");
  const rec = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
  const existingRoutes = rec.remoteRouters ?? [];
  rec.remoteRouters = [
    ...existingRoutes.filter((r: any) => !added.some((a) => a.domain === r.domain)),
    ...added,
  ].sort((a, b) => a.domain - b.domain);
  fs.writeFileSync(addrFile, JSON.stringify(rec, null, 2) + "\n");
  console.log(`\n✓ persisted ${added.length} new routes to tonMainnet/addresses.json`);
  const balAfter = await client.getBalance(deployer);
  console.log(`Final balance: ${(Number(balAfter) / 1e9).toFixed(4)} TON  (spent ${(Number(bal - balAfter) / 1e9).toFixed(4)} TON)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
