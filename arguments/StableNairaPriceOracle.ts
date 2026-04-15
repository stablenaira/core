import "dotenv/config";
import { getAddress } from "ethers";

function parseReporters(raw: string | undefined): string[] {
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
          `StableNairaPriceOracle verify: invalid address in REPORTERS at index ${i}: "${addr}"`
        );
      }
    });
}

function parseDecimals(): number {
  const raw = process.env.ORACLE_DECIMALS;
  if (raw === undefined || raw === "") return 8;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 255) {
    throw new Error(
      "StableNairaPriceOracle verify: ORACLE_DECIMALS must be an integer 0–255 (uint8)."
    );
  }
  return n;
}

function parseQuorum(): number {
  const raw = process.env.ORACLE_QUORUM;
  if (raw === undefined || raw === "") return 1;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new Error(
      "StableNairaPriceOracle verify: ORACLE_QUORUM must be a positive integer."
    );
  }
  return n;
}

const decimals = parseDecimals();
const reporters = parseReporters(process.env.REPORTERS);
const quorum = parseQuorum();

if (reporters.length < quorum) {
  throw new Error(
    `StableNairaPriceOracle verify: need at least ${quorum} reporter address(es) in REPORTERS (comma-separated), got ${reporters.length}.`
  );
}

export default [decimals, reporters, quorum];
