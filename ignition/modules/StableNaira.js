const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("StableNaira", (m) => {
  const event = m.contract("StableNaira", ["StableNaira", "SNR"]);

  return { event };
});
