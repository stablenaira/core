/* eslint-disable no-console */
/**
 * Queue Solana (domain 101) and TON (domain 1000001) as remote routers on
 * every EVM chain's TokenMessenger. Starts the 1-hour timelock; commit must
 * happen via PHASE=commit-all after the ETA.
 *
 * Identities used:
 *   Solana (101)   = token_messenger config PDA   = 0x761a…ec9ee
 *   TON   (1000001)= token_messenger StdAddress    = 0xbf29…fca5d
 */
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, Interface } from "ethers";
import fs from "fs";
import path from "path";

const SOLANA_DOMAIN = 101;
const SOLANA_ROUTER_B32 = "0x761aa100ac1ff3806092f100b3f267d01b3b099ec8ff8c3522f9d31b187ec9ee";

const TON_DOMAIN = 1_000_001;
const TON_ROUTER_B32 = "0xbf29fc2a8301b02adb4cd3231ed553ee40eeb794adbb6df7f3bafd20099fca5d";

const TM_ABI = [
  "function remoteRouter(uint32) view returns (bytes32)",
  "function queueSetRemoteRouter(uint32 domain, bytes32 router) returns (uint256)",
  "event RemoteRouterChangeQueued(uint256 indexed actionId, uint32 indexed domain, bytes32 router)",
  "event ActionQueued(uint256 indexed actionId, bytes32 indexed actionHash, uint64 eta)",
];

const CHAINS = [
  { net: "mainnet",    label: "BSC",         rpc: process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org/" },
  { net: "ethereum",   label: "Ethereum",    rpc: process.env.ETHEREUM_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com" },
  { net: "base",       label: "Base",        rpc: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org" },
  { net: "assetchain", label: "AssetChain",  rpc: process.env.ASSETCHAIN_MAINNET_RPC_URL || "https://mainnet-rpc.assetchain.org" },
  { net: "polygon",    label: "Polygon",     rpc: process.env.POLYGON_MAINNET_RPC_URL },
  { net: "avalanche",  label: "Avalanche",   rpc: process.env.AVALANCHE_MAINNET_RPC_URL },
  { net: "arbitrum",   label: "Arbitrum",    rpc: process.env.ARBITRUM_MAINNET_RPC_URL },
  { net: "optimism",   label: "Optimism",    rpc: process.env.OPTIMISM_MAINNET_RPC_URL },
];

const ROOT = path.resolve(__dirname, "..");

function loadAddr(net: string): any {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "ignition", "deployments", net, "addresses.json"), "utf-8"));
}

function saveAddr(net: string, rec: any) {
  const f = path.join(ROOT, "ignition", "deployments", net, "addresses.json");
  fs.writeFileSync(f, JSON.stringify(rec, null, 2) + "\n", "utf-8");
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk || pk === "privatKey") throw new Error("PRIVATE_KEY not set");

  for (const c of CHAINS) {
    const rec = loadAddr(c.net);
    const provider = new JsonRpcProvider(c.rpc);
    const wallet = new Wallet(pk, provider);
    const tm = new Contract(rec.contracts.tokenMessenger, TM_ABI, wallet);
    const iface = new Interface(TM_ABI);

    console.log(`\n== ${c.label} (${c.net}) ==`);

    const peers = [
      { name: "Solana", domain: SOLANA_DOMAIN, router: SOLANA_ROUTER_B32 },
      { name: "TON",    domain: TON_DOMAIN,    router: TON_ROUTER_B32 },
    ];

    const newRoutes: any[] = [];
    for (const p of peers) {
      // Skip if already committed on chain
      const existing = (await tm.remoteRouter(p.domain)).toLowerCase();
      if (existing === p.router.toLowerCase()) {
        console.log(`  ${p.name} (domain ${p.domain}) already wired — skip`);
        continue;
      }
      // Skip if already queued in our manifest
      const alreadyQueued = (rec.remoteRouters ?? []).find(
        (r: any) => r.domainId === p.domain && r.status === "queued"
      );
      if (alreadyQueued) {
        console.log(`  ${p.name} (domain ${p.domain}) already queued: actionId=${alreadyQueued.actionId} — skip`);
        continue;
      }

      console.log(`  queueing ${p.name} -> domain=${p.domain} router=${p.router.slice(0, 12)}…`);
      const nonce = await provider.getTransactionCount(wallet.address, "latest");
      const txResp = await (tm as any).queueSetRemoteRouter(p.domain, p.router, { nonce });
      console.log(`    tx ${txResp.hash}`);
      const receipt = await txResp.wait();
      let actionId = "?";
      let eta = 0;
      for (const log of receipt!.logs ?? []) {
        try {
          const parsed = iface.parseLog(log as any);
          if (parsed?.name === "RemoteRouterChangeQueued") {
            actionId = (parsed.args.actionId as bigint).toString();
          } else if (parsed?.name === "ActionQueued") {
            eta = Number(parsed.args.eta);
          }
        } catch {}
      }
      console.log(`    queued actionId=${actionId}  eta=${new Date(eta * 1000).toISOString()}`);
      newRoutes.push({
        domainId: p.domain,
        router: p.router,
        actionId,
        status: "queued",
        queuedAt: new Date().toISOString(),
        eta,
        label: p.name,
      });
    }

    if (newRoutes.length > 0) {
      const fresh = loadAddr(c.net);
      fresh.remoteRouters = [
        ...(fresh.remoteRouters ?? []).filter((r: any) => !newRoutes.some((n) => n.domainId === r.domainId)),
        ...newRoutes,
      ];
      saveAddr(c.net, fresh);
      console.log(`  persisted ${newRoutes.length} new route(s)`);
    }
  }

  console.log(`\n== queue-non-evm-peers complete ==`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
