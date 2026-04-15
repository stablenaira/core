require("dotenv/config");

const { getAddress } = require("ethers");
const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Parse comma-separated reporter addresses (trims whitespace, validates checksum).
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseReporters(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [];
  }
  return String(raw)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((addr, i) => {
      try {
        return getAddress(addr);
      } catch {
        throw new Error(
          `StableNairaPriceOracle deploy: invalid address in REPORTERS at index ${i}: "${addr}"`
        );
      }
    });
}

function parseDecimals() {
  const raw = process.env.ORACLE_DECIMALS;
  if (raw === undefined || raw === "") return 8;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 255) {
    throw new Error(
      "StableNairaPriceOracle deploy: ORACLE_DECIMALS must be an integer 0–255 (uint8)."
    );
  }
  return n;
}

function parseQuorum() {
  const raw = process.env.ORACLE_QUORUM;
  if (raw === undefined || raw === "") return 1;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new Error(
      "StableNairaPriceOracle deploy: ORACLE_QUORUM must be a positive integer."
    );
  }
  return n;
}

module.exports = buildModule("StableNairaPriceOracle", (m) => {
  const decimals = parseDecimals();
  const reporters = parseReporters(process.env.REPORTERS);
  const quorum = parseQuorum();

  if (reporters.length < quorum) {
    throw new Error(
      `StableNairaPriceOracle deploy: need at least ${quorum} reporter address(es) in REPORTERS (comma-separated), got ${reporters.length}. The contract requires initialReporters.length >= quorum.`
    );
  }

  const oracle = m.contract("StableNairaPriceOracle", [
    decimals,
    reporters,
    quorum,
  ]);

  return { oracle };
});
