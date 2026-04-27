const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
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

function requireAddress(value, label) {
  if (!value || typeof value !== "string" || !hre.ethers.isAddress(value)) {
    throw new Error(`Invalid or missing address for ${label}: ${String(value)}`);
  }
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
    throw new Error("Use a configured network (e.g. baseSepolia, sepolia, testnet).");
  }

  const cfg = readConfig();
  const confirmations = Number(getCliArg("--confirmations") ?? cfg.confirmations ?? 1);
  const timelockRaw = getCliArg("--timelock") || process.env.SET_TIMELOCK || "60";
  const timelock = Number(timelockRaw);
  if (!Number.isInteger(timelock) || timelock < 0) {
    throw new Error(`--timelock must be a non-negative integer, got: ${String(timelockRaw)}`);
  }

  const outputPath = resolveOutputPath(cfg);
  const output = loadJson(outputPath);
  const proxy = requireAddress(output?.cctp?.registry?.proxy, "cctp.registry.proxy");

  const [signer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  console.log(`Network: ${hre.network.name} (chainId=${net.chainId})`);
  console.log(`Signer: ${signer.address}`);
  console.log(`ValidatorRegistry proxy: ${proxy}`);

  const registry = await hre.ethers.getContractAt("ValidatorRegistry", proxy, signer);
  await waitTx(`setTimelock(${timelock})`, registry.setTimelock(timelock), confirmations);

  const [minTimelock, currentTimelock] = await Promise.all([registry.minTimelock(), registry.timelock()]);
  console.log(`minTimelock: ${minTimelock.toString()}`);
  console.log(`timelock: ${currentTimelock.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
