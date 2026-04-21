require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ignition-ethers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */

const PRIVATE_KEY = process.env.PRIVATE_KEY || "privatKey";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;

/** Override with your own RPC if the default is flaky (fixes Ignition gas-estimate / call mismatch). */
const BSC_TESTNET_RPC =
  process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/";

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
      url: "https://bsc-dataseed.binance.org/",
      chainId: 56,
      accounts: [PRIVATE_KEY],
    },
  },
  // String api key enables Etherscan API v2 (chainid sent on every request). Object keys force v1 and break
  // polling when apiURL embeds query params (search string gets replaced). Use a BscScan or Etherscan.io key.
  etherscan: {
    apiKey: BSCSCAN_API_KEY || "",
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
