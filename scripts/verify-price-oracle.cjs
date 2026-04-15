/**
 * Verifies StableNairaPriceOracle on BscScan (hardhat-verify).
 * Constructor args must match deployment: ORACLE_DECIMALS, REPORTERS, ORACLE_QUORUM in .env.
 *
 * Address resolution (first match wins):
 *   PRICE_ORACLE_ADDRESS or STABLE_NAIRA_PRICE_ORACLE_ADDRESS
 *   ignition/deployments/<DEPLOYMENT_ID>/deployed_addresses.json → StableNairaPriceOracle#StableNairaPriceOracle
 *
 * Usage:
 *   npx hardhat run scripts/verify-price-oracle.cjs --network testnet
 *   DEPLOYMENT_ID=mainnet npx hardhat run scripts/verify-price-oracle.cjs --network mainnet
 *   PRICE_ORACLE_ADDRESS=0x... npx hardhat run scripts/verify-price-oracle.cjs --network testnet
 */

const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");

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
          `StableNairaPriceOracle verify: invalid address in REPORTERS at index ${i}: "${addr}"`
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
      "StableNairaPriceOracle verify: ORACLE_DECIMALS must be an integer 0–255 (uint8)."
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
      "StableNairaPriceOracle verify: ORACLE_QUORUM must be a positive integer."
    );
  }
  return n;
}

function getConstructorArguments() {
  const decimals = parseDecimals();
  const reporters = parseReporters(process.env.REPORTERS);
  const quorum = parseQuorum();
  if (reporters.length < quorum) {
    throw new Error(
      `StableNairaPriceOracle verify: need at least ${quorum} reporter address(es) in REPORTERS (comma-separated), got ${reporters.length}.`
    );
  }
  return [decimals, reporters, quorum];
}

function loadOracleAddress(repoRoot, deploymentId) {
  const fromEnv =
    process.env.PRICE_ORACLE_ADDRESS || process.env.STABLE_NAIRA_PRICE_ORACLE_ADDRESS;
  if (fromEnv && String(fromEnv).trim()) {
    return getAddress(String(fromEnv).trim());
  }

  const deployedPath = path.join(
    repoRoot,
    "ignition",
    "deployments",
    deploymentId,
    "deployed_addresses.json"
  );
  if (!fs.existsSync(deployedPath)) {
    throw new Error(
      `Missing ${deployedPath}. Set PRICE_ORACLE_ADDRESS or deploy first (DEPLOYMENT_ID=${deploymentId}).`
    );
  }
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const key = "StableNairaPriceOracle#StableNairaPriceOracle";
  const addr = deployed[key];
  if (!addr) {
    throw new Error(
      `No ${key} in ${deployedPath}. Set PRICE_ORACLE_ADDRESS or check deployment id.`
    );
  }
  return getAddress(addr);
}

async function verifyOrSkip(hre, label, opts) {
  const { address, constructorArguments = [], contract } = opts;
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
      ...(contract ? { contract } : {}),
    });
    console.log(`Verified: ${label} (${address})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("Already Verified") ||
      msg.includes("already been verified") ||
      msg.includes("Contract source code already verified")
    ) {
      console.log(`Skip (already verified): ${label} (${address})`);
      return;
    }
    throw e;
  }
}

async function main() {
  const hre = require("hardhat");
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    throw new Error(
      "Use a public network, e.g. --network testnet or --network mainnet."
    );
  }
  const deploymentId = process.env.DEPLOYMENT_ID || hre.network.name;
  const repoRoot = path.join(__dirname, "..");
  const address = loadOracleAddress(repoRoot, deploymentId);
  const constructorArguments = getConstructorArguments();

  console.log(`Deployment id: ${deploymentId}`);
  console.log(`Network: ${hre.network.name}`);
  console.log(`StableNairaPriceOracle: ${address}`);
  console.log(`Constructor args: decimals=${constructorArguments[0]}, reporters=${constructorArguments[1].length}, quorum=${constructorArguments[2]}`);

  await verifyOrSkip(hre, "StableNairaPriceOracle", {
    address,
    constructorArguments,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
