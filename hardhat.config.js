require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ignition-ethers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */

const PRIVATE_KEY = process.env.PRIVATE_KEY || "privatKey";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || BSCSCAN_API_KEY;

/** Override with your own RPC if the default is flaky (fixes Ignition gas-estimate / call mismatch). */
const BSC_TESTNET_RPC =
  process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/";
const BSC_MAINNET_RPC = process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org/";
const ETHEREUM_MAINNET_RPC =
  process.env.ETHEREUM_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const ETHEREUM_SEPOLIA_RPC =
  process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const ETHEREUM_HOLESKY_RPC =
  process.env.ETHEREUM_HOLESKY_RPC_URL || "https://ethereum-holesky-rpc.publicnode.com";
const BASE_MAINNET_RPC = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const ARBITRUM_MAINNET_RPC =
  process.env.ARBITRUM_MAINNET_RPC_URL || "https://arb1.arbitrum.io/rpc";
const ARBITRUM_SEPOLIA_RPC =
  process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
const POLYGON_MAINNET_RPC = process.env.POLYGON_MAINNET_RPC_URL || "https://polygon-rpc.com";
const POLYGON_AMOY_RPC = process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
const POLYGON_MUMBAI_RPC =
  process.env.POLYGON_MUMBAI_RPC_URL || "https://rpc-mumbai.maticvigil.com";

module.exports = {
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
    testnet: {
      url: BSC_TESTNET_RPC,
      chainId: 97,
      accounts: [PRIVATE_KEY],
      timeout: 120_000,
    },
    mainnet: {
      url: BSC_MAINNET_RPC,
      chainId: 56,
      accounts: [PRIVATE_KEY],
    },
    ethereum: {
      url: ETHEREUM_MAINNET_RPC,
      chainId: 1,
      accounts: [PRIVATE_KEY],
    },
    sepolia: {
      url: ETHEREUM_SEPOLIA_RPC,
      chainId: 11155111,
      accounts: [PRIVATE_KEY],
    },
    holesky: {
      url: ETHEREUM_HOLESKY_RPC,
      chainId: 17000,
      accounts: [PRIVATE_KEY],
    },
    base: {
      url: BASE_MAINNET_RPC,
      chainId: 8453,
      accounts: [PRIVATE_KEY],
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: [PRIVATE_KEY],
    },
    arbitrum: {
      url: ARBITRUM_MAINNET_RPC,
      chainId: 42161,
      accounts: [PRIVATE_KEY],
    },
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC,
      chainId: 421614,
      accounts: [PRIVATE_KEY],
    },
    polygon: {
      url: POLYGON_MAINNET_RPC,
      chainId: 137,
      accounts: [PRIVATE_KEY],
    },
    polygonAmoy: {
      url: POLYGON_AMOY_RPC,
      chainId: 80002,
      accounts: [PRIVATE_KEY],
    },
    polygonMumbai: {
      url: POLYGON_MUMBAI_RPC,
      chainId: 80001,
      accounts: [PRIVATE_KEY],
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
    ],
  },
  sourcify: {
    enabled: true,
  },
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
};
