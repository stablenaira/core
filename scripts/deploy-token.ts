import "dotenv/config";
import fs from "fs";
import path from "path";
import hre, { ethers } from "hardhat";

export function buildProxyVerificationArgs(
  implementationAddress: string,
  initData: string,
) {
  return [implementationAddress, initData];
}

const envFile = path.join(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  // dotenv/config already loads .env from the current working directory.
}

async function verifyOnExplorer(
  address: string,
  constructorArgs: unknown[] = [],
  contractName?: string,
) {
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    console.log(`Skipping verification on local network ${hre.network.name}`);
    return;
  }

  const explorerApiKey =
    process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY;
  if (!explorerApiKey) {
    console.log("No explorer API key found; skipping verification.");
    return;
  }

  console.log(`Verifying contract at ${address} on ${hre.network.name}...`);
  await hre.run("verify:verify", {
    address,
    constructorArguments: constructorArgs,
    ...(contractName ? { contract: contractName } : {}),
  });
}

/**
 * Tell the explorer the address is a proxy and which implementation it points
 * at. `hardhat verify` only submits source; it never sets the proxy flag.
 * Best-effort — a failure here costs the proxy tabs, not the deployment.
 */
async function registerProxyOnExplorer(
  proxyAddress: string,
  implementationAddress: string,
) {
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") return;

  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY;
  if (!apiKey) {
    console.log("No explorer API key found; skipping proxy registration.");
    return;
  }

  const chainId = Number(
    (await hre.ethers.provider.getNetwork()).chainId,
  );
  const endpoint = `https://api.etherscan.io/v2/api?chainid=${chainId}`;

  try {
    const submit = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        module: "contract",
        action: "verifyproxycontract",
        address: proxyAddress,
        expectedimplementation: implementationAddress,
        apikey: apiKey,
      }),
    });
    const submitted: any = await submit.json();
    if (submitted.status !== "1") {
      console.warn(`Proxy registration not accepted: ${submitted.result}`);
      return;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const check = await fetch(
        `${endpoint}&module=contract&action=checkproxyverification` +
          `&guid=${submitted.result}&apikey=${apiKey}`,
      );
      const status: any = await check.json();
      if (status.status === "1") {
        console.log(`Proxy registered on explorer: ${status.result}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.warn("Proxy registration did not confirm in time.");
  } catch (error) {
    console.warn("Proxy registration failed:", error);
  }
}

async function main() {
  if (
    hre.network.name !== "hardhat" &&
    hre.network.name !== "localhost" &&
    !process.env.PRIVATE_KEY
  ) {
    throw new Error(
      `PRIVATE_KEY is required for network "${hre.network.name}". Set it in your environment before running this script.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const tokenName = process.env.TOKEN_NAME || "StableNaira";
  const tokenSymbol = process.env.TOKEN_SYMBOL || "SNR";
  const initialAdmin = process.env.INITIAL_ADMIN || deployerAddress;
  const commitSha = process.env.COMMIT_SHA || "unknown";
  const deterministic =
    process.env.DETERMINISTIC === "1" || process.env.DETERMINISTIC === "true";
  const saltInput =
    process.env.DETERMINISTIC_SALT ||
    ethers.id(`${tokenName}:${tokenSymbol}:${initialAdmin}`);
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

  const deployerFactory = await ethers.getContractFactory(
    "StableNairaUUPSDeployer",
  );
  const deployerContract = await deployerFactory.deploy();
  await deployerContract.waitForDeployment();

  const deploymentTx = deterministic
    ? await deployerContract.deployDeterministic(
        salt,
        tokenName,
        tokenSymbol,
        initialAdmin,
      )
    : await deployerContract.deploy(tokenName, tokenSymbol, initialAdmin);

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
    throw new Error(
      "Could not find the Deployed event for the proxy deployment",
    );
  }

  const token = await ethers.getContractAt("StableNaira", proxyAddress);
  // Must byte-match the ERC1967Proxy `_data` constructor argument the factory
  // actually passed, which is `abi.encodeCall(StableNaira.initialize, ...)` —
  // i.e. the 4-byte `initialize` selector followed by the encoded arguments.
  // A bare abi.encode of the arguments omits the selector, and explorer proxy
  // verification then fails on a constructor-arguments mismatch.
  const initData = token.interface.encodeFunctionData("initialize", [
    tokenName,
    tokenSymbol,
    initialAdmin,
  ]);
  const [nameOnChain, symbolOnChain] = await Promise.all([
    token.name(),
    token.symbol(),
  ]);
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
  const outputPath = path.join(
    outputDir,
    `stable-naira-${hre.network.name}.json`,
  );
  fs.writeFileSync(outputPath, JSON.stringify(deploymentResult, null, 2));

  // Each target is verified in its own try/catch. A single shared block let a
  // failure on the implementation skip the proxy entirely — and `hardhat
  // verify` also calls Sourcify, which can fail (503 during its v1 brownout)
  // *after* the explorer already succeeded. That threw, and the proxy was
  // never submitted.
  try {
    await verifyOnExplorer(
      implementationAddress,
      [],
      "contracts/StableNaira.sol:StableNaira",
    );
  } catch (error) {
    console.warn("Implementation verification failed:", error);
  }

  try {
    await verifyOnExplorer(
      proxyAddress,
      buildProxyVerificationArgs(implementationAddress, initData),
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
  } catch (error) {
    console.warn("Proxy verification failed:", error);
  }

  // Source-verifying the proxy is not enough: the explorer also has to be told
  // it *is* a proxy, or the Read/Write-as-Proxy tabs never appear and callers
  // see the bare ERC1967Proxy ABI instead of the token's.
  await registerProxyOnExplorer(proxyAddress, implementationAddress);

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
