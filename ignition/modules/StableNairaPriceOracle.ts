import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploy the signed-quorum NGN/USD price oracle. Standalone (non-upgradeable),
 * deployed once per ecosystem on BSC and read by every other component.
 *
 * Parameters:
 *   - oracleDecimals  uint8     price decimals (default 8)
 *   - oracleReporters address[] off-chain signer set (length >= quorum)
 *   - oracleQuorum    uint256   minimum signatures per round (>= 1)
 */
export default buildModule("StableNairaPriceOracle", (m) => {
  const decimals = m.getParameter<bigint>("oracleDecimals", 8n);
  const reporters = m.getParameter<string[]>("oracleReporters");
  const quorum = m.getParameter<bigint>("oracleQuorum");

  const oracle = m.contract("StableNairaPriceOracle", [decimals, reporters, quorum]);

  return { oracle };
});
