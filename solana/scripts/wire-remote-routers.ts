// Wire Solana token_messenger to all 9 peer domains:
//   1 EVM peers (8): BSC(56), Ethereum(1), Base(8453), AssetChain(42420),
//                    Polygon(137), Avalanche(43114), Arbitrum(42161), Optimism(10)
//   1 non-EVM peer:  TON(1000001)
//
// Reads addresses from core/ignition/deployments/<network>/addresses.json so
// router identities stay in sync with the canonical address book.
//
// Idempotent: a domain already wired (existing remote_router PDA matches the
// expected router bytes) is skipped.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CORE_ROOT  = path.resolve(__dirname, "..", "..");

const TOKEN_MESSENGER_PROGRAM_ID = new PublicKey("AcKeZENGFRMxm3rtQg3chAiwf24d992Ljj574i937jjv");
// Anchor IDL discriminator for set_remote_router: sha256("global:set_remote_router")[0..8]
const DISCRIM_SET_REMOTE_ROUTER = Buffer.from([251, 228, 209, 197, 212, 180, 147, 178]);

const CONFIG_SEED = Buffer.from("tm_config");
const ROUTER_SEED = Buffer.from("remote_router");

const DRY = process.argv.includes("--dry");

// ---- read solana CLI config ------------------------------------------------
function readSolanaConfig(): { rpc: string; keypair: string } {
  const cli = path.join(os.homedir(), ".config/solana/cli/config.yml");
  const raw = fs.readFileSync(cli, "utf8");
  const rpc = raw.match(/^json_rpc_url:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const keypair = raw.match(/^keypair_path:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (!rpc || !keypair) throw new Error("Could not parse ~/.config/solana/cli/config.yml");
  return { rpc, keypair: keypair.replace(/^~/, os.homedir()) };
}

const { rpc, keypair: keypairPath } = readSolanaConfig();
if (!/mainnet/i.test(rpc)) {
  console.error(`SAFETY: configured RPC does not look like mainnet (${rpc}).`);
  process.exit(1);
}
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
const connection = new Connection(rpc, "confirmed");

// ---- read addresses --------------------------------------------------------
function loadAddr(network: string): any {
  return JSON.parse(fs.readFileSync(path.join(CORE_ROOT, "ignition", "deployments", network, "addresses.json"), "utf-8"));
}

function bytes32FromEvmAddr(addr: string): Buffer {
  // EVM tokenMessenger -> 32-byte left-padded
  const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
  return Buffer.from(clean.padStart(64, "0"), "hex");
}

// TON tokenMessenger -> hash component of TON StdAddress
function bytes32FromTon(): Buffer {
  // EQC_KfwqgwGwKttM0yMe1VPuQO63lK27bffzuv0gCZ_KXYJB -> 0xbf29fc2a8301b02adb4cd3231ed553ee40eeb794adbb6df7f3bafd20099fca5d
  return Buffer.from("bf29fc2a8301b02adb4cd3231ed553ee40eeb794adbb6df7f3bafd20099fca5d", "hex");
}

interface Peer {
  label: string;
  domain: number;
  router: Buffer;
}

function buildPeers(): Peer[] {
  return [
    { label: "BSC",        domain: 56,      router: bytes32FromEvmAddr(loadAddr("mainnet").contracts.tokenMessenger) },
    { label: "Ethereum",   domain: 1,       router: bytes32FromEvmAddr(loadAddr("ethereum").contracts.tokenMessenger) },
    { label: "Base",       domain: 8453,    router: bytes32FromEvmAddr(loadAddr("base").contracts.tokenMessenger) },
    { label: "AssetChain", domain: 42420,   router: bytes32FromEvmAddr(loadAddr("assetchain").contracts.tokenMessenger) },
    { label: "Polygon",    domain: 137,     router: bytes32FromEvmAddr(loadAddr("polygon").contracts.tokenMessenger) },
    { label: "Avalanche",  domain: 43114,   router: bytes32FromEvmAddr(loadAddr("avalanche").contracts.tokenMessenger) },
    { label: "Arbitrum",   domain: 42161,   router: bytes32FromEvmAddr(loadAddr("arbitrum").contracts.tokenMessenger) },
    { label: "Optimism",   domain: 10,      router: bytes32FromEvmAddr(loadAddr("optimism").contracts.tokenMessenger) },
    { label: "TON",        domain: 1000001, router: bytes32FromTon() },
  ];
}

function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], TOKEN_MESSENGER_PROGRAM_ID)[0];
}

function routerPda(domain: number): PublicKey {
  const d = Buffer.alloc(4);
  d.writeUInt32LE(domain, 0);
  return PublicKey.findProgramAddressSync([ROUTER_SEED, d], TOKEN_MESSENGER_PROGRAM_ID)[0];
}

async function existingRouter(pda: PublicKey): Promise<Buffer | null> {
  const acct = await connection.getAccountInfo(pda);
  if (!acct) return null;
  // Account layout:
  //   8 bytes discriminator
  //   4 bytes domain (u32 LE)
  //  32 bytes router
  //   1 byte bump
  if (acct.data.length < 45) return null;
  return acct.data.subarray(12, 12 + 32);
}

function makeIx(domain: number, router: Buffer): TransactionInstruction {
  const cfg = configPda();
  const rr = routerPda(domain);
  const data = Buffer.concat([
    DISCRIM_SET_REMOTE_ROUTER,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(domain, 0); return b; })(),
    router,
  ]);
  return new TransactionInstruction({
    programId: TOKEN_MESSENGER_PROGRAM_ID,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true,  isWritable: false }, // owner
      { pubkey: deployer.publicKey, isSigner: true,  isWritable: true  }, // payer
      { pubkey: cfg,                isSigner: false, isWritable: false }, // config
      { pubkey: rr,                 isSigner: false, isWritable: true  }, // remote_router
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function main() {
  console.log(`RPC      : ${rpc}`);
  console.log(`Deployer : ${deployer.publicKey.toBase58()}`);
  const bal = await connection.getBalance(deployer.publicKey);
  console.log(`Balance  : ${(bal / 1e9).toFixed(6)} SOL`);
  console.log(`Program  : ${TOKEN_MESSENGER_PROGRAM_ID.toBase58()}`);
  console.log(`Config   : ${configPda().toBase58()}\n`);

  const peers = buildPeers();
  const wired: any[] = [];

  for (const p of peers) {
    const rr = routerPda(p.domain);
    const ex = await existingRouter(rr);
    const expectedHex = "0x" + p.router.toString("hex");
    if (ex && Buffer.compare(ex, p.router) === 0) {
      console.log(`  ${p.label.padEnd(11)} domain=${String(p.domain).padEnd(8)} pda=${rr.toBase58()} ✓ already wired`);
      wired.push({ label: p.label, domain: p.domain, router: expectedHex, status: "wired", pda: rr.toBase58() });
      continue;
    }
    const action = ex ? "update" : "init";
    console.log(`  ${p.label.padEnd(11)} domain=${String(p.domain).padEnd(8)} pda=${rr.toBase58()}  ${action} -> ${expectedHex.slice(0, 14)}…`);
    if (DRY) continue;
    const ix = makeIx(p.domain, p.router);
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = deployer.publicKey;
    tx.sign(deployer);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`    tx ${sig}`);
    wired.push({ label: p.label, domain: p.domain, router: expectedHex, status: "wired", pda: rr.toBase58(), txSignature: sig });
  }

  // Persist into addresses.json
  if (!DRY) {
    const addrFile = path.join(CORE_ROOT, "ignition", "deployments", "solanaMainnet", "addresses.json");
    const rec = JSON.parse(fs.readFileSync(addrFile, "utf-8"));
    rec.remoteRouters = wired;
    fs.writeFileSync(addrFile, JSON.stringify(rec, null, 2) + "\n");
    console.log(`\n✓ persisted ${wired.length} routes to solanaMainnet/addresses.json`);
  }

  const balAfter = await connection.getBalance(deployer.publicKey);
  console.log(`\nFinal balance: ${(balAfter / 1e9).toFixed(6)} SOL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
