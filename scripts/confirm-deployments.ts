/* eslint-disable no-console */
/**
 * Confirm every recorded contract address on every chain has real bytecode.
 * Reads ignition/deployments/<chain>/addresses.json, queries each chain's
 * canonical public RPC, and reports any address that returns empty code.
 *
 * Solana: queries Solana JSON-RPC for program account ownership.
 * TON: queries tonapi.io for contract status.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { JsonRpcProvider } from "ethers";

interface EvmChain {
  network: string;
  label: string;
  rpc: string;
  chainId: number;
}

const EVM: EvmChain[] = [
  { network: "mainnet",    label: "BSC Mainnet",          rpc: process.env.BSC_MAINNET_RPC_URL ?? "https://bsc-dataseed.binance.org/",                    chainId: 56 },
  { network: "ethereum",   label: "Ethereum Mainnet",     rpc: process.env.ETHEREUM_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",             chainId: 1 },
  { network: "base",       label: "Base Mainnet",         rpc: process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org",                            chainId: 8453 },
  { network: "assetchain", label: "Asset Chain Mainnet",  rpc: process.env.ASSETCHAIN_MAINNET_RPC_URL ?? "https://mainnet-rpc.assetchain.org",            chainId: 42420 },
  { network: "polygon",    label: "Polygon PoS Mainnet",  rpc: process.env.POLYGON_MAINNET_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com",           chainId: 137 },
  { network: "avalanche",  label: "Avalanche C-Chain",    rpc: process.env.AVALANCHE_MAINNET_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc",          chainId: 43114 },
  { network: "arbitrum",   label: "Arbitrum One",         rpc: process.env.ARBITRUM_MAINNET_RPC_URL ?? "https://arb1.arbitrum.io/rpc",                    chainId: 42161 },
  { network: "optimism",   label: "Optimism Mainnet",     rpc: process.env.OPTIMISM_MAINNET_RPC_URL ?? "https://mainnet.optimism.io",                     chainId: 10 },
];

const root = path.resolve(__dirname, "..");

function read(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, "ignition", "deployments", file, "addresses.json"), "utf-8"));
}

async function confirmEvm(c: EvmChain): Promise<{ ok: boolean; missing: string[]; rec: any }> {
  const rec = read(c.network);
  const provider = new JsonRpcProvider(c.rpc);
  const missing: string[] = [];
  for (const [name, addr] of Object.entries(rec.contracts)) {
    if (!addr) continue;
    const code = await provider.getCode(addr as string);
    if (code === "0x") missing.push(`${name}: ${addr}`);
  }
  return { ok: missing.length === 0, missing, rec };
}

async function confirmSolana(): Promise<{ ok: boolean; missing: string[]; rec: any }> {
  const rec = read("solanaMainnet");
  const url = process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const missing: string[] = [];
  for (const [name, info] of Object.entries(rec.programs as Record<string, any>)) {
    const programId = info.programId;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [programId, { encoding: "base64" }] }),
    });
    const json: any = await res.json();
    if (!json?.result?.value || json.result.value.executable !== true) {
      missing.push(`${name}: ${programId} (not executable/missing)`);
    }
  }
  return { ok: missing.length === 0, missing, rec };
}

async function confirmTon(): Promise<{ ok: boolean; missing: string[]; rec: any }> {
  const rec = read("tonMainnet");
  const missing: string[] = [];
  for (const [name, addr] of Object.entries(rec.contracts as Record<string, string>)) {
    // Use TON Center v2 — public RPC for mainnet
    const res = await fetch(`https://toncenter.com/api/v2/getAddressState?address=${addr}`);
    const json: any = await res.json();
    if (!json?.ok || json?.result !== "active") {
      missing.push(`${name}: ${addr} (state=${json?.result ?? "unknown"})`);
    }
  }
  return { ok: missing.length === 0, missing, rec };
}

async function main() {
  console.log("== Verifying all 10 mainnet deployments on-chain ==\n");

  console.log("-- EVM chains --");
  const evmResults: Array<{ chain: EvmChain; result: any }> = [];
  for (const c of EVM) {
    process.stdout.write(`  ${c.label.padEnd(28)} ... `);
    try {
      const result = await confirmEvm(c);
      console.log(result.ok
        ? `✅  ${Object.keys(result.rec.contracts).length} contracts live`
        : `❌  ${result.missing.length} missing: ${result.missing.join(", ")}`);
      evmResults.push({ chain: c, result });
    } catch (e: any) {
      console.log(`❌  RPC failed: ${e.shortMessage ?? e.message}`);
    }
  }

  console.log("\n-- Solana mainnet --");
  process.stdout.write(`  Solana programs              ... `);
  try {
    const result = await confirmSolana();
    console.log(result.ok
      ? `✅  ${Object.keys(result.rec.programs).length} programs executable`
      : `❌  ${result.missing.length} missing: ${result.missing.join(", ")}`);
  } catch (e: any) {
    console.log(`❌  RPC failed: ${e.shortMessage ?? e.message}`);
  }

  console.log("\n-- TON mainnet --");
  process.stdout.write(`  TON contracts                ... `);
  try {
    const result = await confirmTon();
    console.log(result.ok
      ? `✅  ${Object.keys(result.rec.contracts).length} contracts active`
      : `❌  ${result.missing.length} missing: ${result.missing.join(", ")}`);
  } catch (e: any) {
    console.log(`❌  RPC failed: ${e.shortMessage ?? e.message}`);
  }

  console.log("\n== Done ==");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
