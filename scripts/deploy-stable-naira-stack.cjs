/**
 * Ordered deployment orchestrator for the full StableNaira stack.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-stable-naira-stack.cjs --network testnet --deploy-config ./ignition/parameters/deploy-stable-naira-stack.template.json
 *
 * Config shape:
 * {
 *   "deployStableNaira": true,
 *   "stableNairaAddress": "0x...", // optional when deployStableNaira=false
 *   "token": { "name": "StableNaira", "symbol": "SNR" },
 *   "cctp": {
 *     "admin": "0x...", // optional, defaults to deployer
 *     "governor": "0x...", // optional, defaults to deployer
 *     "pauser": "0x...", // optional, defaults to deployer
 *     "localDomain": 0,
 *     "timelock": 3600,
 *     "threshold": "0",
 *     "g2Cofactor": "0x...",
 *     "hashToCurveDst": "0x..."
 *   },
 *   "wire": {
 *     "remoteRouters": [{ "domainId": 1, "router": "0x..." }],
 *     "globalCap": { "windowSec": 3600, "cap": "1000000000000000000000000" },
 *     "domainCaps": [{ "domainId": 1, "windowSec": 3600, "cap": "500000000000000000000000" }]
 *   },
 *   "priceOracle": {
 *     "deploy": true,
 *     "address": "0x...", // optional when deploy=false
 *     "decimals": 8,
 *     "reporters": ["0x..."],
 *     "quorum": 1
 *   },
 *   "roles": {
 *     "stableNaira": { "minters": [], "pausers": [], "freezers": [], "seizers": [] },
 *     "messageTransmitter": { "governors": [], "pausers": [], "admins": [] },
 *     "bridgeRouter": { "governors": [], "pausers": [], "admins": [] },
 *     "validatorRegistry": { "governors": [], "admins": [] }
 *   },
 *   "confirmations": 1,
 *   "outputFile": "ignition/deployments/<network>/stable-naira-stack-addresses.json"
 * }
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

/** Must match `BLS_DST` in cctp-network/packages/crypto/src/bls.ts. */
const DEFAULT_DST =
  "0x" +
  Buffer.from("STABLENAIRA_CCTP_BLS12381G2_XMD:SHA-256_SSWU_RO_v1", "utf8").toString("hex");
const EXPECTED_LOCAL_DOMAIN_BY_CHAIN_ID = {
  97: 17, // BSC testnet
  56: 17, // BSC mainnet
  11155111: 0, // Ethereum Sepolia
  1: 0, // Ethereum mainnet
  84532: 6, // Base Sepolia
  8453: 6, // Base mainnet
  421614: 3, // Arbitrum Sepolia
  42161: 3, // Arbitrum mainnet
  80002: 7, // Polygon Amoy
  137: 7, // Polygon mainnet
};

function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function readConfig() {
  const configPath = getCliArg("--deploy-config") || process.env.DEPLOY_CONFIG;
  if (!configPath) {
    throw new Error("Missing config path. Pass --deploy-config <path> or set DEPLOY_CONFIG.");
  }
  const fullPath = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function resolveOutputPath(outputFile, networkName) {
  const defaultRelative = `ignition/deployments/${networkName}/stable-naira-stack-addresses.json`;
  if (!outputFile) {
    return path.resolve(process.cwd(), defaultRelative);
  }

  const normalized = String(outputFile).replace(/\\/g, "/");
  const withTemplateNetwork = normalized
    .replaceAll("<network>", networkName)
    .replaceAll("{network}", networkName);

  // Keep deployment outputs grouped by active network, even when an old
  // config accidentally hardcodes "testnet" or another network folder.
  const forcedNetworkFolder = withTemplateNetwork.replace(
    /(^|\/)ignition\/deployments\/[^/]+\/stable-naira-stack-addresses\.json$/,
    `$1ignition/deployments/${networkName}/stable-naira-stack-addresses.json`,
  );

  return path.resolve(process.cwd(), forcedNetworkFolder);
}

function requireAddress(value, label) {
  if (!value || !hre.ethers.isAddress(value)) {
    throw new Error(`Invalid or missing address for ${label}: ${String(value)}`);
  }
  return hre.ethers.getAddress(value);
}

function normalizeAddressList(values = []) {
  if (!Array.isArray(values)) {
    throw new Error("Role address lists must be arrays.");
  }
  return values.map((v) => requireAddress(v, "role account"));
}

function parseOracleDecimals(value) {
  const raw = value ?? 8;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`priceOracle.decimals must be an integer 0-255, got ${String(raw)}`);
  }
  return n;
}

function parseOracleQuorum(value) {
  const raw = value ?? 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`priceOracle.quorum must be a positive integer, got ${String(raw)}`);
  }
  return n;
}

function validateLocalDomainForNetwork(localDomain, chainId) {
  const expected = EXPECTED_LOCAL_DOMAIN_BY_CHAIN_ID[chainId];
  if (expected === undefined) return;
  if (localDomain !== expected) {
    throw new Error(
      `cctp.localDomain mismatch for chainId ${chainId}: expected ${expected}, got ${localDomain}. ` +
        "Use Circle domain IDs (ETHEREUM=0, ARBITRUM=3, BASE=6, POLYGON_POS=7, BNB_SMART_CHAIN=17).",
    );
  }
}

function resolveLocalDomain(localDomainFromConfig, chainId) {
  const expected = EXPECTED_LOCAL_DOMAIN_BY_CHAIN_ID[chainId];
  const hasExplicitConfig = localDomainFromConfig !== undefined && localDomainFromConfig !== null;

  if (hasExplicitConfig) {
    const explicit = Number(localDomainFromConfig);
    validateLocalDomainForNetwork(explicit, chainId);
    return explicit;
  }

  if (expected !== undefined) {
    return expected;
  }

  throw new Error(
    `Unable to infer cctp.localDomain for chainId ${chainId}. ` +
      "Set cctp.localDomain in your deploy config for this network.",
  );
}

function toBytes32Router(router) {
  if (typeof router !== "string" || !router.startsWith("0x")) {
    throw new Error(`Invalid router value: ${String(router)}`);
  }
  if (router.length === 66) return router;
  if (router.length === 42) return hre.ethers.zeroPadValue(router, 32);
  throw new Error(`Router must be 20-byte or 32-byte hex: ${router}`);
}

function normalizeHexBytes(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} is required and must be a hex string.`);
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("0x")) {
    throw new Error(`${label} must start with 0x.`);
  }
  let hex = trimmed.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${label} must contain only hex characters.`);
  }
  // Ethers bytes ABI encoding requires an even nibble count.
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return `0x${hex}`;
}

function formatEth(wei) {
  return hre.ethers.formatEther(wei);
}

async function assertSignerCanAffordTx(label, signer, estimateGasFn) {
  const [balance, estimatedGas, feeData] = await Promise.all([
    signer.provider.getBalance(signer.address),
    estimateGasFn(),
    signer.provider.getFeeData(),
  ]);

  const gasPrice = feeData.gasPrice;
  if (!gasPrice) {
    console.warn(`Skipping affordability check for "${label}" (gasPrice unavailable).`);
    return;
  }

  // Add a safety margin so transient fee bumps do not still underfund the tx.
  const estimatedCost = estimatedGas * gasPrice;
  const bufferedCost = (estimatedCost * 120n) / 100n;
  if (balance >= bufferedCost) return;

  const shortfall = bufferedCost - balance;
  throw new Error(
    [
      `Insufficient deployer balance for "${label}".`,
      `Balance: ${formatEth(balance)} ETH (${balance} wei)`,
      `Estimated gas: ${estimatedGas.toString()} @ ${gasPrice.toString()} wei`,
      `Buffered tx cost (120%): ${formatEth(bufferedCost)} ETH (${bufferedCost} wei)`,
      `Shortfall: ${formatEth(shortfall)} ETH (${shortfall} wei)`,
      "Top up the deployer wallet or switch to a funded signer/network.",
    ].join("\n"),
  );
}

async function waitTx(label, txPromise, confirmations) {
  const tx = await txPromise;
  console.log(`${label} submitted: ${tx.hash}`);
  const receipt = await tx.wait(confirmations);
  console.log(`${label} confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function deployUUPSProxy(label, contractName, initArgs, confirmations) {
  const ImplFactory = await hre.ethers.getContractFactory(contractName);
  const impl = await ImplFactory.deploy();
  await impl.waitForDeployment();
  const implementation = await impl.getAddress();
  console.log(`${label} implementation: ${implementation}`);

  const initData = ImplFactory.interface.encodeFunctionData("initialize", initArgs);
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(implementation, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log(`${label} proxy: ${proxyAddress}`);

  if (confirmations > 0) {
    const deploymentTx = proxy.deploymentTransaction();
    if (deploymentTx) {
      await waitTx(`${label} deployment`, Promise.resolve(deploymentTx), confirmations);
    }
  }

  return { implementation, proxy: proxyAddress };
}

function parseDeployedFromReceipt(contract, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === "Deployed") {
        if ("kind" in parsed.args) {
          return {
            kind: parsed.args.kind,
            implementation: parsed.args.implementation,
            proxy: parsed.args.proxy,
          };
        }
        return {
          implementation: parsed.args.implementation,
          proxy: parsed.args.proxy,
        };
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  throw new Error("Deployed event not found in transaction receipt.");
}

async function grantRoleIfMissing(contract, role, account, label, confirmations) {
  const has = await contract.hasRole(role, account);
  if (has) {
    console.log(`${label} already granted to ${account}`);
    return;
  }
  await waitTx(`${label} -> ${account}`, contract.grantRole(role, account), confirmations);
}

async function main() {
  const cfg = readConfig();
  const confirmations = Number(cfg.confirmations ?? 1);

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  console.log(`Network: ${hre.network.name} (chainId=${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const cctpCfg = cfg.cctp || {};
  const admin = requireAddress(cctpCfg.admin || deployer.address, "cctp.admin");
  const governor = requireAddress(cctpCfg.governor || deployer.address, "cctp.governor");
  const pauser = requireAddress(cctpCfg.pauser || deployer.address, "cctp.pauser");
  const priceOracleCfg = cfg.priceOracle || {};

  let stableNairaAddress = cfg.stableNairaAddress;
  let stableNairaFactoryAddress;
  let stableNairaImplAddress;

  if (cfg.deployStableNaira !== false) {
    const tokenCfg = cfg.token || {};
    const tokenName = tokenCfg.name || "StableNaira";
    const tokenSymbol = tokenCfg.symbol || "SNR";

    const TokenFactory = await hre.ethers.getContractFactory("StableNairaUUPSDeployer");
    await assertSignerCanAffordTx("Deploy StableNairaUUPSDeployer", deployer, async () => {
      const deployTx = await TokenFactory.getDeployTransaction();
      return deployer.provider.estimateGas({
        from: deployer.address,
        ...deployTx,
      });
    });
    const tokenFactory = await TokenFactory.deploy();
    await tokenFactory.waitForDeployment();
    stableNairaFactoryAddress = await tokenFactory.getAddress();
    console.log(`StableNairaUUPSDeployer: ${stableNairaFactoryAddress}`);

    await assertSignerCanAffordTx(
      "Deploy StableNaira proxy",
      deployer,
      () => tokenFactory.deploy.estimateGas(tokenName, tokenSymbol, admin),
    );

    const deployReceipt = await waitTx(
      "Deploy StableNaira proxy",
      tokenFactory.deploy(tokenName, tokenSymbol, admin),
      confirmations,
    );
    const deployed = parseDeployedFromReceipt(tokenFactory, deployReceipt);
    stableNairaImplAddress = deployed.implementation;
    stableNairaAddress = deployed.proxy;
    console.log(`StableNaira implementation: ${stableNairaImplAddress}`);
    console.log(`StableNaira proxy: ${stableNairaAddress}`);
  } else {
    stableNairaAddress = requireAddress(stableNairaAddress, "stableNairaAddress");
    console.log(`Using existing StableNaira proxy: ${stableNairaAddress}`);
  }

  // Deploy CCTP contracts directly to avoid deploying the oversized
  // StableNairaCCTPDeployer helper on networks enforcing EIP-170.
  const cctpFactoryAddress = null;

  const g2Cofactor = normalizeHexBytes(cctpCfg.g2Cofactor, "cctp.g2Cofactor");
  const hashToCurveDst = normalizeHexBytes(cctpCfg.hashToCurveDst || DEFAULT_DST, "cctp.hashToCurveDst");

  const verifierDeployment = await deployUUPSProxy(
    "BLS12381Verifier",
    "BLS12381Verifier",
    [admin, g2Cofactor, hashToCurveDst],
    confirmations,
  );

  const timelock = BigInt(cctpCfg.timelock ?? 3600);
  const threshold = BigInt(cctpCfg.threshold ?? 0);
  if (threshold === 0n) {
    console.warn(
      "WARNING: cctp.threshold=0 disables attestation enforcement. " +
        "Use a non-zero threshold in production deployments.",
    );
  }
  const registryDeployment = await deployUUPSProxy(
    "ValidatorRegistry",
    "ValidatorRegistry",
    [admin, governor, timelock, threshold],
    confirmations,
  );

  const localDomain = resolveLocalDomain(cctpCfg.localDomain, Number(network.chainId));
  console.log(`Resolved CCTP localDomain: ${localDomain}`);
  const transmitterDeployment = await deployUUPSProxy(
    "MessageTransmitter",
    "MessageTransmitter",
    [admin, governor, pauser, localDomain, registryDeployment.proxy, verifierDeployment.proxy],
    confirmations,
  );

  const routerDeployment = await deployUUPSProxy(
    "BridgeRouter",
    "BridgeRouter",
    [admin, governor, pauser, stableNairaAddress, transmitterDeployment.proxy],
    confirmations,
  );

  let priceOracleAddress = priceOracleCfg.address || null;
  let priceOracleConfig = null;
  if (priceOracleCfg.deploy !== false) {
    const oracleDecimals = parseOracleDecimals(priceOracleCfg.decimals);
    const oracleReporters = normalizeAddressList(priceOracleCfg.reporters || []);
    const oracleQuorum = parseOracleQuorum(priceOracleCfg.quorum);
    if (oracleReporters.length < oracleQuorum) {
      throw new Error(
        `priceOracle.reporters length (${oracleReporters.length}) must be >= priceOracle.quorum (${oracleQuorum})`,
      );
    }
    const OracleFactory = await hre.ethers.getContractFactory("StableNairaPriceOracle");
    const oracle = await OracleFactory.deploy(oracleDecimals, oracleReporters, oracleQuorum);
    await oracle.waitForDeployment();
    priceOracleAddress = await oracle.getAddress();
    priceOracleConfig = {
      decimals: oracleDecimals,
      reporters: oracleReporters,
      quorum: oracleQuorum,
    };
    console.log(`StableNairaPriceOracle: ${priceOracleAddress}`);
  } else if (priceOracleAddress) {
    priceOracleAddress = requireAddress(priceOracleAddress, "priceOracle.address");
    console.log(`Using existing StableNairaPriceOracle: ${priceOracleAddress}`);
  }

  const stableNaira = await hre.ethers.getContractAt("StableNaira", stableNairaAddress);
  const messageTransmitter = await hre.ethers.getContractAt(
    "MessageTransmitter",
    transmitterDeployment.proxy,
  );
  const bridgeRouter = await hre.ethers.getContractAt("BridgeRouter", routerDeployment.proxy);
  const validatorRegistry = await hre.ethers.getContractAt(
    "ValidatorRegistry",
    registryDeployment.proxy,
  );

  await waitTx(
    "Set bridge router as transmitter handler",
    messageTransmitter.setHandler(routerDeployment.proxy),
    confirmations,
  );
  await waitTx(
    "Grant StableNaira minter role to bridge router",
    stableNaira.addMinter(routerDeployment.proxy),
    confirmations,
  );

  const wireCfg = cfg.wire || {};
  const remoteRouters = Array.isArray(wireCfg.remoteRouters) ? wireCfg.remoteRouters : [];
  for (let idx = 0; idx < remoteRouters.length; idx += 1) {
    const entry = remoteRouters[idx];
    const routerBytes32 = toBytes32Router(entry.router);
    await waitTx(
      `Set remote router domain=${entry.domainId}`,
      bridgeRouter.setRemoteRouter(entry.domainId, routerBytes32),
      confirmations,
    );
  }

  if (wireCfg.globalCap?.windowSec !== undefined && wireCfg.globalCap?.cap !== undefined) {
    await waitTx(
      "Set global mint cap",
      bridgeRouter.setGlobalMintCap(wireCfg.globalCap.windowSec, BigInt(wireCfg.globalCap.cap)),
      confirmations,
    );
  }

  const domainCaps = Array.isArray(wireCfg.domainCaps) ? wireCfg.domainCaps : [];
  for (let idx = 0; idx < domainCaps.length; idx += 1) {
    const entry = domainCaps[idx];
    await waitTx(
      `Set domain mint cap domain=${entry.domainId}`,
      bridgeRouter.setDomainMintCap(entry.domainId, entry.windowSec, BigInt(entry.cap)),
      confirmations,
    );
  }

  const rolesCfg = cfg.roles || {};
  const stableRoles = rolesCfg.stableNaira || {};
  for (const addr of normalizeAddressList(stableRoles.minters || [])) {
    await waitTx(`StableNaira addMinter`, stableNaira.addMinter(addr), confirmations);
  }
  for (const addr of normalizeAddressList(stableRoles.pausers || [])) {
    await waitTx(`StableNaira addPauser`, stableNaira.addPauser(addr), confirmations);
  }
  for (const addr of normalizeAddressList(stableRoles.freezers || [])) {
    await waitTx(`StableNaira addFreezer`, stableNaira.addFreezer(addr), confirmations);
  }
  for (const addr of normalizeAddressList(stableRoles.seizers || [])) {
    await waitTx(`StableNaira addSeizer`, stableNaira.addSeizer(addr), confirmations);
  }

  const transmitterGovRole = await messageTransmitter.GOVERNOR_ROLE();
  const transmitterPauseRole = await messageTransmitter.PAUSER_ROLE();
  const transmitterAdminRole = await messageTransmitter.DEFAULT_ADMIN_ROLE();
  const transmitterRoles = rolesCfg.messageTransmitter || {};
  for (const addr of normalizeAddressList(transmitterRoles.governors || [])) {
    await grantRoleIfMissing(
      messageTransmitter,
      transmitterGovRole,
      addr,
      "MessageTransmitter GOVERNOR_ROLE",
      confirmations,
    );
  }
  for (const addr of normalizeAddressList(transmitterRoles.pausers || [])) {
    await grantRoleIfMissing(
      messageTransmitter,
      transmitterPauseRole,
      addr,
      "MessageTransmitter PAUSER_ROLE",
      confirmations,
    );
  }
  for (const addr of normalizeAddressList(transmitterRoles.admins || [])) {
    await grantRoleIfMissing(
      messageTransmitter,
      transmitterAdminRole,
      addr,
      "MessageTransmitter DEFAULT_ADMIN_ROLE",
      confirmations,
    );
  }

  const routerGovRole = await bridgeRouter.GOVERNOR_ROLE();
  const routerPauseRole = await bridgeRouter.PAUSER_ROLE();
  const routerAdminRole = await bridgeRouter.DEFAULT_ADMIN_ROLE();
  const routerRoles = rolesCfg.bridgeRouter || {};
  for (const addr of normalizeAddressList(routerRoles.governors || [])) {
    await grantRoleIfMissing(bridgeRouter, routerGovRole, addr, "BridgeRouter GOVERNOR_ROLE", confirmations);
  }
  for (const addr of normalizeAddressList(routerRoles.pausers || [])) {
    await grantRoleIfMissing(bridgeRouter, routerPauseRole, addr, "BridgeRouter PAUSER_ROLE", confirmations);
  }
  for (const addr of normalizeAddressList(routerRoles.admins || [])) {
    await grantRoleIfMissing(
      bridgeRouter,
      routerAdminRole,
      addr,
      "BridgeRouter DEFAULT_ADMIN_ROLE",
      confirmations,
    );
  }

  const registryGovRole = await validatorRegistry.GOVERNOR_ROLE();
  const registryAdminRole = await validatorRegistry.DEFAULT_ADMIN_ROLE();
  const registryRoles = rolesCfg.validatorRegistry || {};
  for (const addr of normalizeAddressList(registryRoles.governors || [])) {
    await grantRoleIfMissing(
      validatorRegistry,
      registryGovRole,
      addr,
      "ValidatorRegistry GOVERNOR_ROLE",
      confirmations,
    );
  }
  for (const addr of normalizeAddressList(registryRoles.admins || [])) {
    await grantRoleIfMissing(
      validatorRegistry,
      registryAdminRole,
      addr,
      "ValidatorRegistry DEFAULT_ADMIN_ROLE",
      confirmations,
    );
  }

  const result = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    stableNaira: {
      factory: stableNairaFactoryAddress || null,
      implementation: stableNairaImplAddress || null,
      proxy: stableNairaAddress,
    },
    cctp: {
      factory: cctpFactoryAddress,
      verifier: verifierDeployment,
      registry: registryDeployment,
      transmitter: transmitterDeployment,
      router: routerDeployment,
    },
    priceOracle: {
      address: priceOracleAddress,
      config: priceOracleConfig,
    },
  };

  const outputPath = resolveOutputPath(cfg.outputFile, hre.network.name);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nDeployment output saved: ${outputPath}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
