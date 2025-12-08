require("dotenv/config");

const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("StableNairaPriceOracle", (m) => {
  const decimals = 8;
  const quorum = 1;
  const reporters = process.env.REPORTERS?.split(",") || [];

  const oracle = m.contract("StableNairaPriceOracle", [
    decimals,
    reporters,
    quorum,
  ]);

  return { oracle };
});
