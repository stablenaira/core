require("dotenv").config();
const PRIVATE_KEY = process.env.PRIVATE_KEY;

module.exports = {
  networks: {
    testnet: {
      provider: () =>
        new (require("@truffle/hdwallet-provider"))(
          PRIVATE_KEY,
          "https://bsc-testnet.publicnode.com"
        ),
      network_id: 97,
    },
  },
  plugins: ["truffle-plugin-verify"],
  api_keys: {
    bscscan: process.env.BSCSCAN_API_KEY,
  },
};
