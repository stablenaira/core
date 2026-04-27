const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const DEPLOYMENTS_DIR = path.resolve(__dirname, "../ignition/deployments");

const CHAIN_TO_DOMAIN = {
  1: 0, // Ethereum mainnet
  11155111: 0, // Ethereum Sepolia
  42161: 3, // Arbitrum mainnet
  421614: 3, // Arbitrum Sepolia
  8453: 6, // Base mainnet
  84532: 6, // Base Sepolia
  137: 7, // Polygon mainnet
  80002: 7, // Polygon Amoy
  56: 17, // BSC mainnet
  97: 17, // BSC testnet
};

const NETWORK_RPC_BY_NAME = {
  testnet: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/",
  mainnet: process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org/",
  ethereum: process.env.ETHEREUM_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
  sepolia: process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  holesky: process.env.ETHEREUM_HOLESKY_RPC_URL || "https://ethereum-holesky-rpc.publicnode.com",
  base: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
  baseSepolia: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  arbitrum: process.env.ARBITRUM_MAINNET_RPC_URL || "https://arb1.arbitrum.io/rpc",
  arbitrumSepolia: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
  polygon: process.env.POLYGON_MAINNET_RPC_URL || "https://polygon-rpc.com",
  polygonAmoy: process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
  polygonMumbai: process.env.POLYGON_MUMBAI_RPC_URL || "https://rpc-mumbai.maticvigil.com",
};

const BRIDGE_ROUTER_ABI = [
  "function setRemoteRouter(uint32 domain, bytes32 router) external",
  "function remoteRouter(uint32 domain) external view returns (bytes32)",
];

function parseArgs() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const checkOnly = argv.includes("--check");
  const includeHubToSpokes = argv.includes("--hub-to-spokes");
  const networkArgIndex = argv.indexOf("--network");
  const onlyNetwork =
    networkArgIndex >= 0 && argv[networkArgIndex + 1] ? argv[networkArgIndex + 1] : undefined;
  return { dryRun, checkOnly, includeHubToSpokes, onlyNetwork };
}

function toBytes32Address(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

function loadDeployments() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    throw new Error(`Deployments folder not found: ${DEPLOYMENTS_DIR}`);
  }

  const networks = fs
    .readdirSync(DEPLOYMENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const records = [];
  for (const networkName of networks) {
    const filePath = path.join(DEPLOYMENTS_DIR, networkName, "stable-naira-stack-addresses.json");
    if (!fs.existsSync(filePath)) continue;

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const chainId = Number(raw.chainId);
    const router = raw?.cctp?.router?.proxy;
    const domainId = CHAIN_TO_DOMAIN[chainId];

    if (!router || !ethers.isAddress(router)) {
      throw new Error(`Invalid router address in ${filePath}`);
    }
    if (domainId === undefined) {
      throw new Error(`Unsupported chainId ${chainId} in ${filePath}`);
    }

    records.push({
      networkName,
      chainId,
      domainId,
      router: ethers.getAddress(router),
      filePath,
    });
  }

  if (records.length < 2) {
    throw new Error("Need at least two deployments to wire remote routers.");
  }

  return records;
}

function pickBscHub(deployments) {
  const bsc = deployments.filter((d) => d.chainId === 97 || d.chainId === 56);
  if (bsc.length === 0) {
    throw new Error("No BSC deployment found (expected chainId 97 or 56).");
  }
  if (bsc.length > 1) {
    throw new Error(
      `Multiple BSC deployments found (${bsc.map((d) => d.networkName).join(", ")}). Keep only one active hub or filter with --network.`,
    );
  }
  return bsc[0];
}

function buildTasks(deployments, hub, includeHubToSpokes, onlyNetwork) {
  const tasks = [];
  const spokeDeployments = deployments.filter((d) => d.networkName !== hub.networkName);

  for (const spoke of spokeDeployments) {
    tasks.push({
      from: spoke,
      targetDomain: hub.domainId,
      targetRouter: hub.router,
      reason: `${spoke.networkName} -> BSC hub`,
    });
  }

  if (includeHubToSpokes) {
    for (const spoke of spokeDeployments) {
      tasks.push({
        from: hub,
        targetDomain: spoke.domainId,
        targetRouter: spoke.router,
        reason: `BSC hub -> ${spoke.networkName}`,
      });
    }
  }

  if (!onlyNetwork) return tasks;
  return tasks.filter((task) => task.from.networkName === onlyNetwork);
}

async function setRemoteRouter(task, dryRun) {
  const rpc = NETWORK_RPC_BY_NAME[task.from.networkName];
  if (!rpc) {
    throw new Error(`No RPC configured for network "${task.from.networkName}"`);
  }
  const provider = new ethers.JsonRpcProvider(rpc);
  const readContract = new ethers.Contract(task.from.router, BRIDGE_ROUTER_ABI, provider);
  const desiredRouterBytes32 = toBytes32Address(task.targetRouter);
  const currentRouterBytes32 = await readContract.remoteRouter(task.targetDomain);
  const currentAddress = bytes32ToAddress(currentRouterBytes32);
  const desiredAddress = ethers.getAddress(task.targetRouter);

  if (dryRun) {
    console.log(
      `[dry-run] ${task.reason}: setRemoteRouter(${task.targetDomain}, ${desiredRouterBytes32}) on ${task.from.router}`,
    );
    console.log(
      `[dry-run] ${task.reason}: current=${currentAddress} desired=${desiredAddress} match=${currentAddress === desiredAddress}`,
    );
    return;
  }

  if (currentAddress === desiredAddress) {
    console.log(`[ok] ${task.reason}: already configured (${currentAddress})`);
    return;
  }

  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY is required in environment.");
  }
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const writeContract = new ethers.Contract(task.from.router, BRIDGE_ROUTER_ABI, wallet);

  const tx = await writeContract.setRemoteRouter(task.targetDomain, desiredRouterBytes32);
  console.log(`[sent] ${task.reason}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  const updatedRouterBytes32 = await readContract.remoteRouter(task.targetDomain);
  const updatedAddress = bytes32ToAddress(updatedRouterBytes32);
  console.log(`[ok] ${task.reason}: block ${receipt.blockNumber}, updated=${updatedAddress}`);
}

function bytes32ToAddress(value) {
  if (!value || value === ethers.ZeroHash) return ethers.ZeroAddress;
  return ethers.getAddress(ethers.dataSlice(value, 12));
}

async function checkRemoteRouter(task) {
  const rpc = NETWORK_RPC_BY_NAME[task.from.networkName];
  if (!rpc) {
    throw new Error(`No RPC configured for network "${task.from.networkName}"`);
  }
  const provider = new ethers.JsonRpcProvider(rpc);
  const contract = new ethers.Contract(task.from.router, BRIDGE_ROUTER_ABI, provider);
  const expected = ethers.getAddress(task.targetRouter);
  const configured = bytes32ToAddress(await contract.remoteRouter(task.targetDomain));
  const match = configured === expected;
  const tag = match ? "ok" : "mismatch";
  console.log(
    `[${tag}] ${task.reason}: from=${task.from.networkName} router=${task.from.router} domain=${task.targetDomain} configured=${configured} expected=${expected}`,
  );
  return match;
}

async function main() {
  const { dryRun, checkOnly, includeHubToSpokes, onlyNetwork } = parseArgs();
  const deployments = loadDeployments();
  const hub = pickBscHub(deployments);
  const tasks = buildTasks(deployments, hub, includeHubToSpokes, onlyNetwork);

  if (tasks.length === 0) {
    throw new Error("No tasks generated. Check --network value.");
  }

  console.log(`BSC hub: ${hub.networkName} (chainId=${hub.chainId}, domain=${hub.domainId})`);
  console.log(`Tasks: ${tasks.length} ${dryRun ? "(dry-run)" : ""} ${checkOnly ? "(check-only)" : ""}`);

  if (checkOnly) {
    let mismatches = 0;
    for (const task of tasks) {
      const ok = await checkRemoteRouter(task);
      if (!ok) mismatches += 1;
    }
    if (mismatches > 0) {
      throw new Error(`Remote router check failed: ${mismatches}/${tasks.length} mismatch(es).`);
    }
    console.log("[ok] All remote router mappings are correctly configured.");
    return;
  }

  for (const task of tasks) {
    await setRemoteRouter(task, dryRun);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
