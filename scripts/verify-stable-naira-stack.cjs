/**
 * Verifies the full StableNaira stack contracts.
 *
 * Usage:
 *   npx hardhat run scripts/verify-stable-naira-stack.cjs --network testnet --deploy-config ./ignition/parameters/deploy-stable-naira-stack.template.json
 *
 * Address sources:
 *  1) DEPLOY_OUTPUT env var, or
 *  2) config.outputFile from --deploy-config JSON, or
 *  3) ignition/deployments/<network>/stable-naira-stack-addresses.json
 */
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

function maybeAddress(value) {
  if (!value || typeof value !== "string") return null;
  if (!hre.ethers.isAddress(value)) return null;
  return hre.ethers.getAddress(value);
}

function toBytes(value, label) {
  if (!value || typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`${label} must be hex string`);
  }
  if (value.length % 2 !== 0) {
    throw new Error(
      `${label} must have even hex length (got ${value.length - 2} nibbles)`,
    );
  }
  if (!hre.ethers.isHexString(value)) {
    throw new Error(`${label} must be valid hex string`);
  }
  return value;
}

function normalizeAddressList(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => hre.ethers.getAddress(v));
}

const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";

async function readImplementationFromProxy(proxyAddress) {
  if (!proxyAddress) return null;
  const raw = await hre.ethers.provider.getStorage(proxyAddress, ERC1967_IMPLEMENTATION_SLOT);
  if (!raw || raw === "0x" || BigInt(raw) === 0n) return null;
  const impl = `0x${raw.slice(-40)}`;
  if (!hre.ethers.isAddress(impl)) return null;
  return hre.ethers.getAddress(impl);
}

async function verifyOrSkip(label, opts) {
  const { address, constructorArguments = [], contract } = opts;
  if (!address) {
    console.log(`Skip (missing address): ${label}`);
    return;
  }
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
      ...(contract ? { contract } : {}),
    });
    console.log(`Verified: ${label} (${address})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const normalizedMsg = msg.toLowerCase();
    if (
      msg.includes("Already Verified") ||
      msg.includes("already been verified") ||
      msg.includes("Contract source code already verified")
    ) {
      console.log(`Skip (already verified): ${label} (${address})`);
      return;
    }
    if (
      normalizedMsg.includes("sourcify") &&
      normalizedMsg.includes("status code: 409") &&
      normalizedMsg.includes("already partially verified")
    ) {
      console.log(
        `Skip (Sourcify already partially verified): ${label} (${address})`,
      );
      return;
    }
    throw e;
  }
}

async function main() {
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    throw new Error("Use a public network, e.g. --network testnet or --network mainnet.");
  }

  const cfg = readConfig();
  const outputPath = resolveOutputPath(cfg);
  const output = loadJson(outputPath);
  const cctpCfg = cfg.cctp || {};
  const tokenCfg = cfg.token || {};
  const oracleCfg = cfg.priceOracle || {};

  const deployer = maybeAddress(output.deployer);
  const admin = maybeAddress(cctpCfg.admin) || deployer;
  const governor = maybeAddress(cctpCfg.governor) || deployer;
  const pauser = maybeAddress(cctpCfg.pauser) || deployer;

  const stableProxy = maybeAddress(output?.stableNaira?.proxy);
  const stableImpl =
    maybeAddress(output?.stableNaira?.implementation) ||
    (await readImplementationFromProxy(stableProxy));
  const stableFactory = maybeAddress(output?.stableNaira?.factory);
  const cctpFactory =
    maybeAddress(output?.cctp?.factory) ||
    maybeAddress(output?.cctp?.deployer) ||
    maybeAddress(cctpCfg.factory) ||
    maybeAddress(cctpCfg.deployer);
  const verifierProxy = maybeAddress(output?.cctp?.verifier?.proxy);
  const verifierImpl = maybeAddress(output?.cctp?.verifier?.implementation);
  const registryProxy = maybeAddress(output?.cctp?.registry?.proxy);
  const registryImpl = maybeAddress(output?.cctp?.registry?.implementation);
  const transmitterProxy = maybeAddress(output?.cctp?.transmitter?.proxy);
  const transmitterImpl = maybeAddress(output?.cctp?.transmitter?.implementation);
  const routerProxy = maybeAddress(output?.cctp?.router?.proxy);
  const routerImpl = maybeAddress(output?.cctp?.router?.implementation);
  const oracleAddress = maybeAddress(output?.priceOracle?.address);

  const tokenName = tokenCfg.name || "StableNaira";
  const tokenSymbol = tokenCfg.symbol || "SNR";
  const localDomain = Number(cctpCfg.localDomain ?? 0);
  const timelock = BigInt(cctpCfg.timelock ?? 3600);
  const threshold = BigInt(cctpCfg.threshold ?? 0);
  const g2Cofactor = toBytes(cctpCfg.g2Cofactor, "cctp.g2Cofactor");
  const hashToCurveDst = toBytes(
    cctpCfg.hashToCurveDst ||
      "0x" +
        Buffer.from("STABLENAIRA_CCTP_BLS12381G2_XMD:SHA-256_SSWU_RO_v1", "utf8").toString("hex"),
    "cctp.hashToCurveDst",
  );

  const stableIface = (await hre.ethers.getContractFactory("StableNaira")).interface;
  const verifierIface = (await hre.ethers.getContractFactory("BLS12381Verifier")).interface;
  const registryIface = (await hre.ethers.getContractFactory("ValidatorRegistry")).interface;
  const transmitterIface = (await hre.ethers.getContractFactory("MessageTransmitter")).interface;
  const routerIface = (await hre.ethers.getContractFactory("BridgeRouter")).interface;

  console.log(`Verifying with deployment output: ${outputPath}`);

  if (stableFactory) {
    await verifyOrSkip("StableNairaUUPSDeployer", { address: stableFactory });
  } else {
    console.log("Info: StableNairaUUPSDeployer not provided in deployment output; skipping.");
  }
  await verifyOrSkip("StableNaira implementation", {
    address: stableImpl,
    contract: "contracts/StableNaira.sol:StableNaira",
  });
  if (stableProxy && stableImpl) {
    await verifyOrSkip("StableNaira proxy", {
      address: stableProxy,
      contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      constructorArguments: [
        stableImpl,
        stableIface.encodeFunctionData("initialize", [tokenName, tokenSymbol, admin]),
      ],
    });
  } else {
    console.log("Skip StableNaira proxy verification (missing proxy or implementation).");
  }

  if (cctpFactory) {
    await verifyOrSkip("StableNairaCCTPDeployer", {
      address: cctpFactory,
      contract: "contracts/cctp/deployers/StableNairaCCTPDeployer.sol:StableNairaCCTPDeployer",
    });
  } else {
    console.log(
      "Info: StableNairaCCTPDeployer address missing; set cctp.factory or cctp.deployer in deploy config to verify it.",
    );
  }

  await verifyOrSkip("BLS12381Verifier implementation", {
    address: verifierImpl,
    contract: "contracts/cctp/verifiers/BLS12381Verifier.sol:BLS12381Verifier",
  });
  if (verifierProxy && verifierImpl) {
    await verifyOrSkip("BLS12381Verifier proxy", {
      address: verifierProxy,
      contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      constructorArguments: [
        verifierImpl,
        verifierIface.encodeFunctionData("initialize", [admin, g2Cofactor, hashToCurveDst]),
      ],
    });
  } else {
    console.log("Skip BLS12381Verifier proxy verification (missing proxy or implementation).");
  }

  await verifyOrSkip("ValidatorRegistry implementation", {
    address: registryImpl,
    contract: "contracts/cctp/ValidatorRegistry.sol:ValidatorRegistry",
  });
  if (registryProxy && registryImpl) {
    await verifyOrSkip("ValidatorRegistry proxy", {
      address: registryProxy,
      contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      constructorArguments: [
        registryImpl,
        registryIface.encodeFunctionData("initialize", [admin, governor, timelock, threshold]),
      ],
    });
  } else {
    console.log("Skip ValidatorRegistry proxy verification (missing proxy or implementation).");
  }

  await verifyOrSkip("MessageTransmitter implementation", {
    address: transmitterImpl,
    contract: "contracts/cctp/MessageTransmitter.sol:MessageTransmitter",
  });
  if (transmitterProxy && transmitterImpl && registryProxy && verifierProxy) {
    await verifyOrSkip("MessageTransmitter proxy", {
      address: transmitterProxy,
      contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      constructorArguments: [
        transmitterImpl,
        transmitterIface.encodeFunctionData("initialize", [
          admin,
          governor,
          pauser,
          localDomain,
          registryProxy,
          verifierProxy,
        ]),
      ],
    });
  } else {
    console.log("Skip MessageTransmitter proxy verification (missing required addresses).");
  }

  await verifyOrSkip("BridgeRouter implementation", {
    address: routerImpl,
    contract: "contracts/cctp/BridgeRouter.sol:BridgeRouter",
  });
  if (routerProxy && routerImpl && stableProxy && transmitterProxy) {
    await verifyOrSkip("BridgeRouter proxy", {
      address: routerProxy,
      contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      constructorArguments: [
        routerImpl,
        routerIface.encodeFunctionData("initialize", [
          admin,
          governor,
          pauser,
          stableProxy,
          transmitterProxy,
        ]),
      ],
    });
  } else {
    console.log("Skip BridgeRouter proxy verification (missing required addresses).");
  }

  const oracleDecimals = Number(oracleCfg.decimals ?? output?.priceOracle?.config?.decimals ?? 8);
  const oracleReportersRaw = Array.isArray(oracleCfg.reporters)
    ? oracleCfg.reporters
    : output?.priceOracle?.config?.reporters || [];
  const oracleReporters = normalizeAddressList(oracleReportersRaw);
  const oracleQuorum = Number(oracleCfg.quorum ?? output?.priceOracle?.config?.quorum ?? 1);
  await verifyOrSkip("StableNairaPriceOracle", {
    address: oracleAddress,
    contract: "contracts/StableNairaPriceOracle.sol:StableNairaPriceOracle",
    constructorArguments: [oracleDecimals, oracleReporters, oracleQuorum],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
