import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ignition-ethers";
import "@nomicfoundation/hardhat-verify";
import "dotenv/config";

import type { HardhatUserConfig } from "hardhat/config";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || BSCSCAN_API_KEY;
const PRIVATE_KEY_ACCOUNT =
  PRIVATE_KEY && /^(0x)?[a-fA-F0-9]{64}$/.test(PRIVATE_KEY)
    ? [PRIVATE_KEY]
    : [];

/** Override with your own RPC if the default is flaky (fixes Ignition gas-estimate / call mismatch). */
const BSC_TESTNET_RPC =
  process.env.BSC_TESTNET_RPC_URL ||
  "https://data-seed-prebsc-1-s1.binance.org:8545/";
const BSC_MAINNET_RPC =
  process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org/";
const ETHEREUM_MAINNET_RPC =
  process.env.ETHEREUM_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const ETHEREUM_SEPOLIA_RPC =
  process.env.ETHEREUM_SEPOLIA_RPC_URL ||
  "https://ethereum-sepolia-rpc.publicnode.com";
const ETHEREUM_HOLESKY_RPC =
  process.env.ETHEREUM_HOLESKY_RPC_URL ||
  "https://ethereum-holesky-rpc.publicnode.com";
const BASE_MAINNET_RPC =
  process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const BASE_SEPOLIA_RPC =
  process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const ARBITRUM_MAINNET_RPC =
  process.env.ARBITRUM_MAINNET_RPC_URL || "https://arb1.arbitrum.io/rpc";
const ARBITRUM_SEPOLIA_RPC =
  process.env.ARBITRUM_SEPOLIA_RPC_URL ||
  "https://sepolia-rollup.arbitrum.io/rpc";
const POLYGON_MAINNET_RPC =
  process.env.POLYGON_MAINNET_RPC_URL || "https://polygon-rpc.com";
const POLYGON_AMOY_RPC =
  process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
const POLYGON_MUMBAI_RPC =
  process.env.POLYGON_MUMBAI_RPC_URL || "https://rpc-mumbai.maticvigil.com";
// Asset Chain (Xend Finance RWA L1) — EVM-compatible, Blockscout explorer.
const ASSETCHAIN_MAINNET_RPC =
  process.env.ASSETCHAIN_MAINNET_RPC_URL ||
  "https://mainnet-rpc.assetchain.org";
const ASSETCHAIN_TESTNET_RPC =
  process.env.ASSETCHAIN_TESTNET_RPC_URL || "https://enugu-rpc.assetchain.org";
// Avalanche C-Chain — EVM-compatible, deterministic instant finality (no
// reorgs once accepted). Snowtrace verification via the Etherscan V2 API.
const AVALANCHE_MAINNET_RPC =
  process.env.AVALANCHE_MAINNET_RPC_URL ||
  "https://api.avax.network/ext/bc/C/rpc";
const AVALANCHE_FUJI_RPC =
  process.env.AVALANCHE_FUJI_RPC_URL ||
  "https://api.avax-test.network/ext/bc/C/rpc";
// Optimism (OP Stack L2) — EVM-compatible, L1-derived finality (same profile
// as Base, which is itself OP Stack). Optimistic Etherscan via Etherscan V2.
const OPTIMISM_MAINNET_RPC =
  process.env.OPTIMISM_MAINNET_RPC_URL || "https://mainnet.optimism.io";
const OPTIMISM_SEPOLIA_RPC =
  process.env.OPTIMISM_SEPOLIA_RPC_URL || "https://sepolia.optimism.io";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 31337,
      // The CCTP deployer bundles four implementation contracts (registry,
      // transmitter, router, verifier) and exceeds the 24.5 KB EIP-170
      // deploy-time limit locally. Override for tests only; production
      // deploys split the factory into per-contract deployers.
      allowUnlimitedContractSize: true,
    },
    localhost: {
      // For multi-phase script smoke tests against a `npx hardhat node`.
      url: process.env.LOCALHOST_URL || "http://127.0.0.1:8545",
      chainId: 31337,
    },
    testnet: {
      url: BSC_TESTNET_RPC,
      chainId: 97,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
      timeout: 120_000,
    },
    mainnet: {
      url: BSC_MAINNET_RPC,
      chainId: 56,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    ethereum: {
      url: ETHEREUM_MAINNET_RPC,
      chainId: 1,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    sepolia: {
      url: ETHEREUM_SEPOLIA_RPC,
      chainId: 11155111,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    holesky: {
      url: ETHEREUM_HOLESKY_RPC,
      chainId: 17000,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    base: {
      url: BASE_MAINNET_RPC,
      chainId: 8453,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    arbitrum: {
      url: ARBITRUM_MAINNET_RPC,
      chainId: 42161,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC,
      chainId: 421614,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    polygon: {
      url: POLYGON_MAINNET_RPC,
      chainId: 137,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    polygonAmoy: {
      url: POLYGON_AMOY_RPC,
      chainId: 80002,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    polygonMumbai: {
      url: POLYGON_MUMBAI_RPC,
      chainId: 80001,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    assetchain: {
      url: ASSETCHAIN_MAINNET_RPC,
      chainId: 42420,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
      timeout: 120_000,
    },
    assetchainTestnet: {
      url: ASSETCHAIN_TESTNET_RPC,
      chainId: 42421,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
      timeout: 120_000,
    },
    avalanche: {
      url: AVALANCHE_MAINNET_RPC,
      chainId: 43114,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    avalancheFuji: {
      url: AVALANCHE_FUJI_RPC,
      chainId: 43113,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
      timeout: 120_000,
    },
    optimism: {
      url: OPTIMISM_MAINNET_RPC,
      chainId: 10,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
    },
    optimismSepolia: {
      url: OPTIMISM_SEPOLIA_RPC,
      chainId: 11155420,
      ...(PRIVATE_KEY_ACCOUNT.length ? { accounts: PRIVATE_KEY_ACCOUNT } : {}),
      timeout: 120_000,
    },
  },
  // String api key enables Etherscan API v2 (chainid sent on every request). Object keys force v1 and break
  // polling when apiURL embeds query params (search string gets replaced). Use a BscScan or Etherscan.io key.
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "mainnet",
        chainId: 56,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://bscscan.com",
        },
      },
      {
        network: "testnet",
        chainId: 97,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://testnet.bscscan.com",
        },
      },
      {
        network: "ethereum",
        chainId: 1,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://etherscan.io",
        },
      },
      {
        network: "sepolia",
        chainId: 11155111,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia.etherscan.io",
        },
      },
      {
        network: "holesky",
        chainId: 17000,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://holesky.etherscan.io",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "arbitrum",
        chainId: 42161,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://arbiscan.io",
        },
      },
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia.arbiscan.io",
        },
      },
      {
        network: "polygon",
        chainId: 137,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://polygonscan.com",
        },
      },
      {
        network: "polygonAmoy",
        chainId: 80002,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://amoy.polygonscan.com",
        },
      },
      {
        network: "polygonMumbai",
        chainId: 80001,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://mumbai.polygonscan.com",
        },
      },
      // Asset Chain runs Blockscout (not Etherscan). Blockscout exposes an
      // Etherscan-compatible verification API at <explorer>/api and ignores the
      // API key. `hardhat verify` works against it; Sourcify (enabled below)
      // is the reliable fallback since Blockscout indexes Sourcify matches.
      {
        network: "assetchain",
        chainId: 42420,
        urls: {
          apiURL: "https://scan.assetchain.org/api",
          browserURL: "https://scan.assetchain.org",
        },
      },
      {
        network: "assetchainTestnet",
        chainId: 42421,
        urls: {
          apiURL: "https://scan-testnet.assetchain.org/api",
          browserURL: "https://scan-testnet.assetchain.org",
        },
      },
      // Snowtrace is Routescan-powered as of 2024. Etherscan V2 returns "Free API
      // access is not supported for this chain" on Avalanche; Routescan is free
      // and ignores the API key, so we route Avalanche verification there.
      {
        network: "avalanche",
        chainId: 43114,
        urls: {
          apiURL:
            "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan",
          browserURL: "https://snowtrace.io",
        },
      },
      {
        network: "avalancheFuji",
        chainId: 43113,
        urls: {
          apiURL:
            "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
      {
        network: "optimism",
        chainId: 10,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://optimistic.etherscan.io",
        },
      },
      {
        network: "optimismSepolia",
        chainId: 11155420,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia-optimism.etherscan.io",
        },
      },
    ],
  },
  sourcify: {
    enabled: true,
  },
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
};

export default config;
