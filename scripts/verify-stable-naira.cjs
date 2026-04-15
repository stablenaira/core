/**
 * Verifies StableNaira Ignition deployment on BscScan (via hardhat-verify):
 * 1. StableNairaUUPSDeployer (no constructor args)
 * 2. StableNaira implementation (OZ upgradeable empty constructor)
 * 3. ERC1967Proxy (implementation + initializer calldata)
 *
 * Requires BSCSCAN_API_KEY in .env and a successful compile.
 *
 * Usage:
 *   npx hardhat run scripts/verify-stable-naira.cjs --network testnet
 *   DEPLOYMENT_ID=mainnet npx hardhat run scripts/verify-stable-naira.cjs --network mainnet
 */

const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const PROXY_FQN =
  "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

function loadIgnitionContext(repoRoot, deploymentId) {
  const deployDir = path.join(repoRoot, "ignition", "deployments", deploymentId);
  const deployedPath = path.join(deployDir, "deployed_addresses.json");
  const journalPath = path.join(deployDir, "journal.jsonl");

  if (!fs.existsSync(deployedPath)) {
    throw new Error(`Missing ${deployedPath}. Deploy first or set DEPLOYMENT_ID.`);
  }
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Missing ${journalPath}.`);
  }

  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const factoryEntry = Object.entries(deployed).find(([k]) =>
    k.includes("StableNairaUUPSDeployer"),
  );
  const factory = factoryEntry ? factoryEntry[1] : Object.values(deployed)[0];

  let implementation;
  let proxy;
  let name_;
  let symbol_;
  let initialAdmin;

  for (const line of fs.readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);

    if (
      o.type === "CALL_EXECUTION_STATE_INITIALIZE" &&
      o.futureId === "StableNaira#StableNairaUUPSDeployer.deploy" &&
      Array.isArray(o.args)
    ) {
      [name_, symbol_, initialAdmin] = o.args;
    }

    if (o.type === "READ_EVENT_ARGUMENT_EXECUTION_STATE_INITIALIZE" && o.result) {
      if (o.nameOrIndex === "implementation") implementation = o.result;
      if (o.nameOrIndex === "proxy") proxy = o.result;
    }
  }

  if (!factory || !implementation || !proxy || !name_ || !symbol_ || !initialAdmin) {
    throw new Error(
      "Could not parse Ignition journal (factory / implementation / proxy / initialize args). " +
        "Check deployment id and that StableNaira module completed.",
    );
  }

  const initIface = new Interface([
    "function initialize(string name_, string symbol_, address initialAdmin)",
  ]);
  const initializerCalldata = initIface.encodeFunctionData("initialize", [
    name_,
    symbol_,
    initialAdmin,
  ]);

  return { factory, implementation, proxy, initializerCalldata };
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
      "Use a public network, e.g. --network testnet or --network mainnet (Ignition deployment folder must match DEPLOYMENT_ID or network name).",
    );
  }
  const deploymentId = process.env.DEPLOYMENT_ID || hre.network.name;
  const repoRoot = path.join(__dirname, "..");
  const ctx = loadIgnitionContext(repoRoot, deploymentId);

  console.log(`Deployment id: ${deploymentId}`);
  console.log(`Network: ${hre.network.name}`);
  console.log(`Factory:         ${ctx.factory}`);
  console.log(`Implementation:  ${ctx.implementation}`);
  console.log(`Proxy (token):   ${ctx.proxy}`);

  await verifyOrSkip(hre, "StableNairaUUPSDeployer", {
    address: ctx.factory,
    constructorArguments: [],
  });

  await verifyOrSkip(hre, "StableNaira (implementation)", {
    address: ctx.implementation,
    constructorArguments: [],
  });

  await verifyOrSkip(hre, "ERC1967Proxy", {
    address: ctx.proxy,
    contract: PROXY_FQN,
    constructorArguments: [ctx.implementation, ctx.initializerCalldata],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
