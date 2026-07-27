import "dotenv/config";
import fs from "fs";
import path from "path";
import hre, { ethers } from "hardhat";

const envFile = path.join(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  // dotenv/config already loads .env from the current working directory.
}

async function verifyOnExplorer(address: string, constructorArgs: unknown[] = []) {
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    console.log(`Skipping verification on local network ${hre.network.name}`);
    return;
  }

  const explorerApiKey = process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY;
  if (!explorerApiKey) {
    console.log("No explorer API key found; skipping verification.");
    return;
  }

  console.log(`Verifying contract at ${address} on ${hre.network.name}...`);
  await hre.run("verify:verify", {
    address,
    constructorArguments: constructorArgs,
  });
}

async function main() {
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost" && !process.env.PRIVATE_KEY) {
    throw new Error(`PRIVATE_KEY is required for network "${hre.network.name}". Set it in your environment before running this script.`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const tokenName = process.env.TOKEN_NAME || "StableNaira";
  const tokenSymbol = process.env.TOKEN_SYMBOL || "SNR";
  const initialAdmin = process.env.INITIAL_ADMIN || deployerAddress;
  const commitSha = process.env.COMMIT_SHA || "unknown";
  const deterministic = process.env.DETERMINISTIC === "1" || process.env.DETERMINISTIC === "true";
  const saltInput = process.env.DETERMINISTIC_SALT || ethers.id(`${tokenName}:${tokenSymbol}:${initialAdmin}`);
  const salt = ethers.zeroPadValue(saltInput, 32);

  console.log("Deploying upgradeable StableNaira token...");
  console.log(`Network: ${hre.network.name}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Token name: ${tokenName}`);
  console.log(`Token symbol: ${tokenSymbol}`);
  console.log(`Initial admin: ${initialAdmin}`);
  if (deterministic) {
    console.log(`Deterministic deployment enabled with salt: ${salt}`);
  }

  const factory = await ethers.getContractFactory("StableNairaUUPSDeployer");
  const deployment = deterministic
    ? await factory.deployDeterministic(salt, tokenName, tokenSymbol, initialAdmin)
    : await factory.deploy(tokenName, tokenSymbol, initialAdmin);
  await deployment.waitForDeployment();

  const deploymentTx = deployment.deploymentTransaction();
  if (!deploymentTx) {
    throw new Error("Deployment transaction was not created");
  }

  const receipt = await deploymentTx.wait();
  if (!receipt) {
    throw new Error("Deployment receipt was not available");
  }

  const iface = new ethers.Interface([
    "event Deployed(address indexed implementation, address indexed proxy)",
  ]);

  let implementationAddress: string | undefined;
  let proxyAddress: string | undefined;

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Deployed") {
        implementationAddress = parsed.args[0];
        proxyAddress = parsed.args[1];
        break;
      }
    } catch {
      // ignore logs that are not from the deployer event
    }
  }

  if (!implementationAddress || !proxyAddress) {
    throw new Error("Could not find the Deployed event for the proxy deployment");
  }

  const token = await ethers.getContractAt("StableNaira", proxyAddress);
  const [nameOnChain, symbolOnChain] = await Promise.all([token.name(), token.symbol()]);
  const adminRole = await token.DEFAULT_ADMIN_ROLE();
  const hasAdminRole = await token.hasRole(adminRole, initialAdmin);

  const deploymentResult = {
    network: hre.network.name,
    tokenName,
    tokenSymbol,
    initialAdmin,
    commitSha,
    implementation: implementationAddress,
    proxy: proxyAddress,
    deployer: deployerAddress,
    onChainName: nameOnChain,
    onChainSymbol: symbolOnChain,
    initialAdminRoleGranted: hasAdminRole,
  };

  const outputDir = path.join(process.cwd(), "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `stable-naira-${hre.network.name}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(deploymentResult, null, 2));

  try {
    await verifyOnExplorer(implementationAddress);
    await verifyOnExplorer(proxyAddress, []);
  } catch (error) {
    console.warn("Explorer verification failed:", error);
  }

  console.log("Deployment complete.");
  console.log(`Implementation: ${implementationAddress}`);
  console.log(`Proxy (token address): ${proxyAddress}`);
  console.log(`On-chain name: ${nameOnChain}`);
  console.log(`On-chain symbol: ${symbolOnChain}`);
  console.log(`Initial admin role granted: ${hasAdminRole}`);
  console.log(`Saved deployment details to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
