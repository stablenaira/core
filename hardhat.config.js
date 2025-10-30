require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ignition-ethers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */

const PRIVATE_KEY = process.env.PRIVATE_KEY || "privatKey";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 31337,
    },
    testnet: {
      url: "https://bsc-testnet.publicnode.com",
      chainId: 97,
      accounts: [PRIVATE_KEY], // add the account that will deploy the contract (private key)
    },
    mainnet: {
      url: "https://bsc-dataseed.binance.org/",
      chainId: 56,
      accounts: [PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: {
      mainnet: BSCSCAN_API_KEY,
      testnet: BSCSCAN_API_KEY,
    },
    customChains: [
      {
        network: "mainnet",
        chainId: 56,
        urls: {
          apiURL: `https://api.etherscan.io/v2/api?chainid=56&apikey=${BSCSCAN_API_KEY}`,
          browserURL: "https://bscscan.com",
        },
      },
      {
        network: "testnet",
        chainId: 97,
        urls: {
          apiURL: `https://api.etherscan.io/v2/api?chainid=97&apikey=${BSCSCAN_API_KEY}`,
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
