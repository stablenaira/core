/**
 * Upgrades ValidatorRegistry UUPS proxy to a new implementation.
 *
 * Usage examples:
 *   npx hardhat run scripts/upgrade-validator-registry.cjs --network baseSepolia
 *   npx hardhat run scripts/upgrade-validator-registry.cjs --network sepolia --proxy 0x...
 *   npx hardhat run scripts/upgrade-validator-registry.cjs --network baseSepolia --set-min-timelock 60
 *   npx hardhat run scripts/upgrade-validator-registry.cjs --network baseSepolia --set-min-timelock 60 --set-timelock 120
 *
 * Address sources (in order):
 *  1) --proxy CLI argument
 *  2) DEPLOY_OUTPUT env var JSON (cctp.registry.proxy)
 *  3) --deploy-config / DEPLOY_CONFIG config.outputFile
 *  4) ignition/deployments/<network>/stable-naira-stack-addresses.json
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function parseOptionalInt(flag) {
  const raw = getCliArg(flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative integer, got: ${String(raw)}`);
  }
  return n;
}

function parseOptionalIntEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${String(raw)}`);
  }
  return n;
}

function loadJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`File not found: ${jsonPath}`);
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

function readConfig() {
  const configPath = getCliArg("--deploy-config") || process.env.DEPLOY_CONFIG;
  if (!configPath) return {};
  return loadJson(path.resolve(process.cwd(), configPath));
}

function resolveOutputPath(cfg) {
  const networkName = hre.network.name;
  const normalizeNetworkPath = (value) =>
    value
      .replace(/<network>/g, networkName)
      .replace(/\$\{network\}/g, networkName)
      .replace(/\$NETWORK/g, networkName);

  const envPath = process.env.DEPLOY_OUTPUT;
  if (envPath) return path.resolve(process.cwd(), normalizeNetworkPath(envPath));
  if (cfg.outputFile) return path.resolve(process.cwd(), normalizeNetworkPath(cfg.outputFile));
  return path.resolve(
    process.cwd(),
    `ignition/deployments/${networkName}/stable-naira-stack-addresses.json`,
  );
}

function maybeAddress(value) {
  if (!value || typeof value !== "string") return null;
  if (!hre.ethers.isAddress(value)) return null;
  return hre.ethers.getAddress(value);
}

async function waitTx(label, txPromise, confirmations) {
  const tx = await txPromise;
  console.log(`${label} submitted: ${tx.hash}`);
  const receipt = await tx.wait(confirmations);
  console.log(`${label} confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function main() {
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    throw new Error("Use a configured network, e.g. --network sepolia or --network baseSepolia.");
  }

  const cfg = readConfig();
  const confirmations = Number(getCliArg("--confirmations") ?? cfg.confirmations ?? 1);
  const setMinTimelock =
    parseOptionalInt("--set-min-timelock") ?? parseOptionalIntEnv("SET_MIN_TIMELOCK");
  const setTimelock = parseOptionalInt("--set-timelock") ?? parseOptionalIntEnv("SET_TIMELOCK");
  const explicitProxy = maybeAddress(getCliArg("--proxy"));

  const outputPath = resolveOutputPath(cfg);
  let output = {};
  if (!explicitProxy && fs.existsSync(outputPath)) {
    output = loadJson(outputPath);
  }

  const proxyAddress = explicitProxy || maybeAddress(output?.cctp?.registry?.proxy);
  if (!proxyAddress) {
    throw new Error(
      "ValidatorRegistry proxy not found. Pass --proxy 0x... or provide deployment output with cctp.registry.proxy.",
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  console.log(`Network: ${hre.network.name} (chainId=${network.chainId})`);
  console.log(`Signer: ${deployer.address}`);
  console.log(`ValidatorRegistry proxy: ${proxyAddress}`);

  const Factory = await hre.ethers.getContractFactory("ValidatorRegistry");
  const implementation = await Factory.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log(`New implementation: ${implementationAddress}`);

  const registry = await hre.ethers.getContractAt("ValidatorRegistry", proxyAddress, deployer);
  await waitTx(
    "Upgrade ValidatorRegistry",
    registry.upgradeToAndCall(implementationAddress, "0x"),
    confirmations,
  );

  if (setMinTimelock !== undefined) {
    await waitTx(
      `Set minTimelock=${setMinTimelock}`,
      registry.setMinTimelock(setMinTimelock),
      confirmations,
    );
  }

  if (setTimelock !== undefined) {
    await waitTx(
      `Set timelock=${setTimelock}`,
      registry.setTimelock(setTimelock),
      confirmations,
    );
  }

  const [minTimelock, timelock, epoch, threshold, totalWeight] = await Promise.all([
    registry.minTimelock(),
    registry.timelock(),
    registry.currentEpoch(),
    registry.threshold(),
    registry.totalWeight(),
  ]);

  console.log("\nUpgrade complete:");
  console.log(`- proxy: ${proxyAddress}`);
  console.log(`- implementation: ${implementationAddress}`);
  console.log(`- minTimelock: ${minTimelock.toString()}`);
  console.log(`- timelock: ${timelock.toString()}`);
  console.log(`- currentEpoch: ${epoch.toString()}`);
  console.log(`- threshold: ${threshold.toString()}`);
  console.log(`- totalWeight: ${totalWeight.toString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
