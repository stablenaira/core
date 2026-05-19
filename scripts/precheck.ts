/* eslint-disable no-console */
/**
 * Pre-flight balance check across every testnet (or mainnet) target.
 * Reads the deployer wallet from .env (`WALLET_ADDRESS`), falls back to
 * the public address derived from `PRIVATE_KEY`, and reports balance on
 * every chain referenced in the deployment template.
 *
 * Usage (no hardhat needed — pure node script):
 *   npx tsx scripts/precheck.ts             # all testnets
 *   GROUP=mainnet npx tsx scripts/precheck.ts
 *
 * Or via hardhat:
 *   npx hardhat run scripts/precheck.ts --network hardhat
 */
import "dotenv/config";

import { ethers } from "ethers";
import { loadTemplate } from "./lib/params";
import { banner, ok, fail, warn, info, cyan, gray, green, red, yellow } from "./lib/cli";

interface RpcConfig {
  url: string;
  symbol: string;
}

const RPCS: Record<string, RpcConfig> = {
  testnet: {
    url: process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545/",
    symbol: "tBNB",
  },
  sepolia: {
    url: process.env.ETHEREUM_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    symbol: "ETH",
  },
  baseSepolia: {
    url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    symbol: "ETH",
  },
  mainnet: {
    url: process.env.BSC_MAINNET_RPC_URL ?? "https://bsc-dataseed.binance.org/",
    symbol: "BNB",
  },
  ethereum: {
    url: process.env.ETHEREUM_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
    symbol: "ETH",
  },
  base: {
    url: process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org",
    symbol: "ETH",
  },
  assetchain: {
    url: process.env.ASSETCHAIN_MAINNET_RPC_URL ?? "https://mainnet-rpc.assetchain.org",
    symbol: "RWA",
  },
  assetchainTestnet: {
    url: process.env.ASSETCHAIN_TESTNET_RPC_URL ?? "https://enugu-rpc.assetchain.org",
    symbol: "RWA",
  },
  polygon: {
    url: process.env.POLYGON_MAINNET_RPC_URL ?? "https://polygon-rpc.com",
    symbol: "POL",
  },
  polygonAmoy: {
    url: process.env.POLYGON_AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
    symbol: "POL",
  },
  avalanche: {
    url: process.env.AVALANCHE_MAINNET_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc",
    symbol: "AVAX",
  },
  avalancheFuji: {
    url: process.env.AVALANCHE_FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
    symbol: "AVAX",
  },
  arbitrum: {
    url: process.env.ARBITRUM_MAINNET_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    symbol: "ETH",
  },
  arbitrumSepolia: {
    url: process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc",
    symbol: "ETH",
  },
  optimism: {
    url: process.env.OPTIMISM_MAINNET_RPC_URL ?? "https://mainnet.optimism.io",
    symbol: "ETH",
  },
  optimismSepolia: {
    url: process.env.OPTIMISM_SEPOLIA_RPC_URL ?? "https://sepolia.optimism.io",
    symbol: "ETH",
  },
};

const FAUCETS: Record<string, string[]> = {
  testnet: ["https://www.bnbchain.org/en/testnet-faucet", "https://testnet.bnbchain.org/faucet-smart"],
  sepolia: ["https://sepoliafaucet.com/", "https://www.alchemy.com/faucets/ethereum-sepolia"],
  baseSepolia: ["https://www.alchemy.com/faucets/base-sepolia", "https://docs.base.org/network-information#base-testnet-sepolia"],
  assetchainTestnet: ["https://faucet.assetchain.org"],
  polygonAmoy: ["https://faucet.polygon.technology/"],
  avalancheFuji: ["https://faucet.avax.network/", "https://core.app/tools/testnet-faucet/"],
  arbitrumSepolia: ["https://www.alchemy.com/faucets/arbitrum-sepolia", "https://faucet.quicknode.com/arbitrum/sepolia"],
  optimismSepolia: ["https://console.optimism.io/faucet", "https://www.alchemy.com/faucets/optimism-sepolia"],
};

function deployerAddress(): string {
  if (process.env.WALLET_ADDRESS) return ethers.getAddress(process.env.WALLET_ADDRESS);
  const pk = process.env.PRIVATE_KEY ?? "";
  if (!pk || pk === "privatKey") {
    throw new Error("Neither WALLET_ADDRESS nor PRIVATE_KEY is set in .env");
  }
  return new ethers.Wallet(pk).address;
}

async function main() {
  const group = (process.env.GROUP ?? "testnet").toLowerCase();
  const template = loadTemplate();
  const networks = template.deploymentGroups[group];
  if (!networks) {
    fail(`Unknown deployment group "${group}" — expected one of ${Object.keys(template.deploymentGroups).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  banner("PRE-FLIGHT BALANCE CHECK", `group=${group}  deployer-from=.env`);

  const addr = deployerAddress();
  info(`Deployer`, addr);

  let allFunded = true;

  for (const net of networks) {
    const cfg = RPCS[net];
    if (!cfg) {
      warn(`No RPC configured for "${net}"; skipping`);
      continue;
    }

    try {
      const provider = new ethers.JsonRpcProvider(cfg.url);
      const balance = await provider.getBalance(addr);
      const block = await provider.getBlockNumber();
      const human = ethers.formatEther(balance);
      const spec = template.networks[net];
      const label = spec?.label ?? net;
      const isFunded = balance > 0n;

      if (isFunded) {
        ok(`${label}`, `${human} ${cfg.symbol}  block=${block}`);
      } else {
        allFunded = false;
        fail(
          `${label}`,
          `0 ${cfg.symbol}   block=${block}   ${gray("→ fund via " + (FAUCETS[net]?.[0] ?? "exchange"))}`
        );
      }
    } catch (err: any) {
      allFunded = false;
      fail(`${net} unreachable`, err?.message?.split("\n")[0] ?? String(err));
    }
  }

  console.log("");
  if (allFunded) {
    ok(`All targets funded — clear to deploy.`);
  } else {
    warn(
      `Some targets are unfunded. Fund the deployer (${addr}) before running the ceremony.`
    );
    if (group === "testnet") {
      console.log("");
      console.log(cyan("  Suggested faucets:"));
      for (const [net, urls] of Object.entries(FAUCETS)) {
        console.log("    " + yellow(net.padEnd(15)) + urls.join("  |  "));
      }
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  fail("FATAL", e?.message ?? String(e));
  process.exitCode = 1;
});
