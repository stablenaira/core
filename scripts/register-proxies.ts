/* eslint-disable no-console */
/**
 * Mark each ERC1967 proxy as a proxy on the block explorer (Etherscan v2 API).
 * This is what makes the "Read as Proxy" / "Write as Proxy" tabs and (for the
 * StableNaira token) the Token Tracker page light up on BscScan / BaseScan,
 * which — unlike Etherscan — do not auto-detect ERC1967 proxies.
 */
import "dotenv/config";

import hre from "hardhat";

import { readDeployment } from "./lib/persistence";

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

function apiKey(): string {
  const k = process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY;
  if (!k) throw new Error("ETHERSCAN_API_KEY or BSCSCAN_API_KEY must be set");
  return k;
}

async function submitProxy(chainId: number, proxy: string, impl: string): Promise<string> {
  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("apikey", apiKey());
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "verifyproxycontract");
  const body = new URLSearchParams({
    address: proxy,
    expectedimplementation: impl,
  });
  const res = await fetch(url, { method: "POST", body });
  const json: any = await res.json();
  if (json.status !== "1") {
    if (/already verified|same/i.test(String(json.result))) return "ALREADY";
    throw new Error(`submit failed: ${JSON.stringify(json)}`);
  }
  return json.result as string;
}

async function pollStatus(chainId: number, guid: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const url = new URL(ETHERSCAN_V2);
    url.searchParams.set("chainid", String(chainId));
    url.searchParams.set("apikey", apiKey());
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "checkproxyverification");
    url.searchParams.set("guid", guid);
    const res = await fetch(url);
    const json: any = await res.json();
    const result = String(json.result ?? "");
    if (json.status === "1") return result;
    if (/pending/i.test(result)) {
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    return result;
  }
  return "timeout";
}

async function main() {
  const networkName = hre.network.name;
  const rec = readDeployment(networkName);
  if (!rec) throw new Error(`No deployment for ${networkName}`);
  const chainId = rec.chainId;
  const c = rec.contracts;

  const targets: { label: string; proxy: string; impl: string }[] = [
    { label: "StableNaira", proxy: c.stableNaira!, impl: c.stableNairaImpl! },
    { label: "ValidatorRegistry", proxy: c.validatorRegistry!, impl: c.validatorRegistryImpl! },
    { label: "MessageTransmitter", proxy: c.messageTransmitter!, impl: c.messageTransmitterImpl! },
    { label: "TokenMessenger", proxy: c.tokenMessenger!, impl: c.tokenMessengerImpl! },
  ].filter((t) => t.proxy && t.impl);

  console.log(`== Registering ERC1967 proxies on ${rec.label} (chainId=${chainId}) ==`);
  for (const t of targets) {
    process.stdout.write(`→ ${t.label} ${t.proxy} → impl ${t.impl}: `);
    try {
      const guid = await submitProxy(chainId, t.proxy, t.impl);
      if (guid === "ALREADY") {
        console.log("already registered");
        continue;
      }
      const status = await pollStatus(chainId, guid);
      console.log(status);
    } catch (e: any) {
      console.log(`ERR ${e?.message ?? e}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
