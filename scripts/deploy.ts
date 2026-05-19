/* eslint-disable no-console */
import "dotenv/config";

import hre from "hardhat";
import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet, Contract, Interface } from "ethers";

import {
  banner,
  header,
  step,
  ok,
  warn,
  fail,
  info,
  action,
  rocket,
  cyan,
  magenta,
  green,
  yellow,
  gray,
  bold,
  dim,
  red,
  countdown,
  teleprint,
  EMOJI,
} from "./lib/cli";

import { loadTemplate, getNetworkSpec } from "./lib/params";
import {
  readDeployment,
  upsertDeployment,
  listDeployments,
  RemoteRouterEntry,
} from "./lib/persistence";

const PHASE = (process.env.PHASE ?? "deploy").toLowerCase();
const SKIP_WAIT = process.env.SKIP_WAIT === "1"; // for testing only
const GROUP = (process.env.GROUP ?? "testnet").toLowerCase();
const TIMELOCK_BUFFER_SEC = 60; // pad above contract floor when waiting

const RPCS: Record<string, string> = {
  testnet: process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545/",
  sepolia: process.env.ETHEREUM_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  baseSepolia: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
  mainnet: process.env.BSC_MAINNET_RPC_URL ?? "https://bsc-dataseed.binance.org/",
  ethereum: process.env.ETHEREUM_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  base: process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org",
  assetchain: process.env.ASSETCHAIN_MAINNET_RPC_URL ?? "https://mainnet-rpc.assetchain.org",
  assetchainTestnet: process.env.ASSETCHAIN_TESTNET_RPC_URL ?? "https://enugu-rpc.assetchain.org",
  polygon: process.env.POLYGON_MAINNET_RPC_URL ?? "https://polygon-rpc.com",
  polygonAmoy: process.env.POLYGON_AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
  avalanche: process.env.AVALANCHE_MAINNET_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc",
  avalancheFuji: process.env.AVALANCHE_FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
  arbitrum: process.env.ARBITRUM_MAINNET_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
  arbitrumSepolia: process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc",
  optimism: process.env.OPTIMISM_MAINNET_RPC_URL ?? "https://mainnet.optimism.io",
  optimismSepolia: process.env.OPTIMISM_SEPOLIA_RPC_URL ?? "https://sepolia.optimism.io",
};

function bytes32FromAddress(addr: string): string {
  return ethers.zeroPadValue(ethers.getAddress(addr), 32);
}

async function main() {
  const networkName = hre.network.name;
  const template = loadTemplate();

  // hardhat / unknown networks are allowed for `summary` only.
  let spec;
  try {
    spec = getNetworkSpec(template, networkName);
  } catch (e) {
    if (PHASE === "summary") {
      // OK — summary doesn't need a chain.
    } else {
      throw e;
    }
  }

  banner("STABLENAIRA DEPLOY CEREMONY", `phase=${PHASE}  net=${networkName}`);

  switch (PHASE) {
    case "deploy":
      await phaseDeploy(networkName, spec!, template);
      break;
    case "oracle":
      await phaseOracle(networkName, spec!, template);
      break;
    case "verify":
      await phaseVerify(networkName);
      break;
    case "queue-wires":
      await phaseQueueWires(networkName, spec!, template);
      break;
    case "queue-all":
    case "queue-all-wires":
      await phaseQueueAllWires(template);
      break;
    case "commit-wires":
      await phaseCommitWires(networkName, spec!);
      break;
    case "wait-and-commit":
      await phaseWaitAndCommit(networkName, spec!);
      break;
    case "commit-all":
    case "commit-all-wires":
    case "wait-and-commit-all":
      await phaseCommitAllWires(template);
      break;
    case "summary":
      await phaseSummary();
      break;
    case "smoke":
      await phaseSmoke(networkName, spec!);
      break;
    default:
      fail(`unknown PHASE "${PHASE}"`);
      process.exitCode = 1;
  }

  console.log("");
}

/* ============================ Phase: deploy ============================ */

async function phaseDeploy(networkName: string, spec: any, template: any) {
  const [signer] = await ethers.getSigners();
  const deployer = await signer.getAddress();
  const balance = await ethers.provider.getBalance(deployer);

  await teleprint(green(`> Initializing transmission to ${spec.label} (chainId=${spec.chainId})…`));
  info(`Deployer`, `${deployer}  (balance: ${ethers.formatEther(balance)} native)`);
  if (balance === 0n) fail(`Deployer has zero native balance — fund the wallet first`);

  const owner = template.common.owner;
  const admin = template.common.admin;

  // -------- nonce-safe deploy/send helpers --------
  // Mainnet RPCs sometimes return stale "pending" nonces, so hardhat-ethers'
  // signer can race itself between consecutive deploys. We refresh the nonce
  // from chain before every tx and retry once on `nonce too low`.
  const PROVIDER = ethers.provider;
  const txOverrides = async () => ({ nonce: await PROVIDER.getTransactionCount(deployer, "pending") });

  async function deployContract<T>(factory: any, args: any[], label: string): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const overrides = await txOverrides();
        const c = await factory.deploy(...args, overrides);
        await c.waitForDeployment();
        return c as T;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (attempt < 2 && /nonce too low|already known|replacement transaction underpriced/i.test(msg)) {
          attempt++;
          warn(`${label} retrying (${attempt}/2)`, msg.split("\n")[0]);
          await new Promise((r) => setTimeout(r, 2_500));
          continue;
        }
        throw e;
      }
    }
  }

  async function sendTx(callable: () => Promise<any>, label: string): Promise<any> {
    let attempt = 0;
    while (true) {
      try {
        const tx = await callable();
        return await tx.wait();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (attempt < 2 && /nonce too low|already known|replacement transaction underpriced/i.test(msg)) {
          attempt++;
          warn(`${label} retrying (${attempt}/2)`, msg.split("\n")[0]);
          await new Promise((r) => setTimeout(r, 2_500));
          continue;
        }
        throw e;
      }
    }
  }

  /* StableNaira (proxy + impl + factory) */
  header(`${EMOJI.rocket} StableNaira (UUPS proxy + impl + factory)`);
  const Factory = await ethers.getContractFactory("StableNairaUUPSDeployer");
  const factory = await deployContract<any>(Factory, [], "StableNairaUUPSDeployer");
  ok(`StableNairaUUPSDeployer deployed`, await factory.getAddress());

  const tokenReceipt = await sendTx(
    async () => factory.deploy(template.common.token.name, template.common.token.symbol, admin, await txOverrides()),
    "StableNaira factory.deploy()"
  );
  const ev = tokenReceipt!.logs.find((l: any) => l.fragment?.name === "Deployed") as any;
  const tokenProxy = ev.args.proxy as string;
  const tokenImpl = ev.args.implementation as string;
  ok(`StableNaira impl deployed`, tokenImpl);
  ok(`StableNaira proxy deployed (initialized atomically)`, tokenProxy);
  const stableNaira = await ethers.getContractAt("StableNaira", tokenProxy);

  /* ValidatorRegistry */
  header(`${EMOJI.shield} ValidatorRegistry (UUPS)`);
  const VR = await ethers.getContractFactory("ValidatorRegistry");
  const vrImpl = await deployContract<any>(VR, [], "ValidatorRegistry impl");
  ok(`ValidatorRegistry impl`, await vrImpl.getAddress());
  const vrInit = vrImpl.interface.encodeFunctionData("initialize", [
    template.common.validatorRegistry.validators,
    template.common.validatorRegistry.threshold,
    owner,
    template.common.validatorRegistry.initialTimelock,
    template.common.validatorRegistry.initialMinTimelock,
  ]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const vrProxy = await deployContract<any>(Proxy, [await vrImpl.getAddress(), vrInit], "ValidatorRegistry proxy");
  const validatorRegistry = await ethers.getContractAt("ValidatorRegistry", await vrProxy.getAddress());
  ok(`ValidatorRegistry proxy`, await validatorRegistry.getAddress());
  info(`Validators set`, `${template.common.validatorRegistry.validators.length} member(s), threshold=${template.common.validatorRegistry.threshold}`);

  /* MultisigVerifier */
  header(`${EMOJI.lock} MultisigVerifier`);
  const MV = await ethers.getContractFactory("MultisigVerifier");
  const verifier = await deployContract<any>(MV, [await validatorRegistry.getAddress()], "MultisigVerifier");
  ok(`MultisigVerifier deployed`, await verifier.getAddress());

  /* MessageTransmitter */
  header(`${EMOJI.satellite} MessageTransmitter (UUPS)  domainId=${spec.domainId}`);
  const MT = await ethers.getContractFactory("MessageTransmitter");
  const mtImpl = await deployContract<any>(MT, [], "MessageTransmitter impl");
  ok(`MessageTransmitter impl`, await mtImpl.getAddress());
  const mtInit = mtImpl.interface.encodeFunctionData("initialize", [
    spec.domainId,
    await verifier.getAddress(),
    template.common.messageTransmitter.maxMessageBodySize,
    owner,
    template.common.messageTransmitter.initialTimelock,
    template.common.messageTransmitter.initialMinTimelock,
  ]);
  const mtProxy = await deployContract<any>(Proxy, [await mtImpl.getAddress(), mtInit], "MessageTransmitter proxy");
  const messageTransmitter = await ethers.getContractAt("MessageTransmitter", await mtProxy.getAddress());
  ok(`MessageTransmitter proxy`, await messageTransmitter.getAddress());

  /* TokenMessenger */
  header(`${EMOJI.link} TokenMessenger (UUPS)  bridge for ${template.common.token.symbol}`);
  const TM = await ethers.getContractFactory("TokenMessenger");
  const tmImpl = await deployContract<any>(TM, [], "TokenMessenger impl");
  ok(`TokenMessenger impl`, await tmImpl.getAddress());
  const tmInit = tmImpl.interface.encodeFunctionData("initialize", [
    await messageTransmitter.getAddress(),
    await stableNaira.getAddress(),
    owner,
    template.common.tokenMessenger.initialTimelock,
    template.common.tokenMessenger.initialMinTimelock,
  ]);
  const tmProxy = await deployContract<any>(Proxy, [await tmImpl.getAddress(), tmInit], "TokenMessenger proxy");
  const tokenMessenger = await ethers.getContractAt("TokenMessenger", await tmProxy.getAddress());
  ok(`TokenMessenger proxy`, await tokenMessenger.getAddress());

  /* Grant MINTER_ROLE on token to bridge — required for burnFrom + mint */
  header(`${EMOJI.unlock} Granting MINTER_ROLE`);
  const stable = stableNaira as any;
  await sendTx(
    async () => stable.connect(signer).addMinter(await tokenMessenger.getAddress(), await txOverrides()),
    "addMinter"
  );
  ok(`MINTER_ROLE granted`, `bridge ${await tokenMessenger.getAddress()} is now allowed to mint+burnFrom on ${template.common.token.symbol}`);

  /* MintCap (optional) */
  if (template.common.token.mintCap && template.common.token.mintCap !== "0") {
    await sendTx(
      async () => stable.connect(signer).setMintCap(BigInt(template.common.token.mintCap), await txOverrides()),
      "setMintCap"
    );
    ok(`mintCap set`, template.common.token.mintCap);
  }

  /* Persist */
  upsertDeployment(networkName, {
    network: networkName,
    chainId: spec.chainId,
    domainId: spec.domainId,
    label: spec.label,
    explorerUrl: spec.explorerUrl,
    deployer,
    deployedAt: new Date().toISOString(),
    contracts: {
      stableNaira: tokenProxy,
      stableNairaImpl: tokenImpl,
      stableNairaDeployer: await factory.getAddress(),
      validatorRegistry: await validatorRegistry.getAddress(),
      validatorRegistryImpl: await vrImpl.getAddress(),
      verifier: await verifier.getAddress(),
      messageTransmitter: await messageTransmitter.getAddress(),
      messageTransmitterImpl: await mtImpl.getAddress(),
      tokenMessenger: await tokenMessenger.getAddress(),
      tokenMessengerImpl: await tmImpl.getAddress(),
    },
    configuration: {
      tokenName: template.common.token.name,
      tokenSymbol: template.common.token.symbol,
      validators: template.common.validatorRegistry.validators,
      threshold: template.common.validatorRegistry.threshold,
      feeBps: template.common.tokenMessenger.feeBps,
      maxMessageBodySize: template.common.messageTransmitter.maxMessageBodySize,
      minterRoleGranted: true,
    },
    remoteRouters: [],
  });
  ok(`Saved addresses`, `ignition/deployments/${networkName}/addresses.json`);

  rocket(`Deployment on ${spec.label} complete.`);
}

/* ============================ Phase: oracle ============================ */

async function phaseOracle(networkName: string, spec: any, template: any) {
  if (!spec.deployOracle) {
    warn(`${spec.label} is not flagged for oracle deploy in template — skipping.`);
    return;
  }
  header(`${EMOJI.oracle} StableNairaPriceOracle  on ${spec.label}`);
  const O = await ethers.getContractFactory("StableNairaPriceOracle");
  const oracle = await O.deploy(
    template.common.oracle.decimals,
    template.common.oracle.reporters,
    template.common.oracle.quorum
  );
  await oracle.waitForDeployment();
  ok(`StableNairaPriceOracle deployed`, await oracle.getAddress());

  upsertDeployment(networkName, {
    contracts: { priceOracle: await oracle.getAddress() },
    configuration: { oracle: { ...template.common.oracle } },
  });
  ok(`Oracle address persisted`);
}

/* ============================ Phase: verify ============================ */

async function phaseVerify(networkName: string) {
  const rec = readDeployment(networkName);
  if (!rec) {
    fail(`No deployment record for ${networkName} — run PHASE=deploy first.`);
    return;
  }

  const tasks: { name: string; address?: string; constructorArgs: any[] }[] = [
    { name: "StableNairaUUPSDeployer (factory)", address: rec.contracts.stableNairaDeployer, constructorArgs: [] },
    { name: "StableNaira (impl)", address: rec.contracts.stableNairaImpl, constructorArgs: [] },
    { name: "ValidatorRegistry (impl)", address: rec.contracts.validatorRegistryImpl, constructorArgs: [] },
    { name: "MessageTransmitter (impl)", address: rec.contracts.messageTransmitterImpl, constructorArgs: [] },
    { name: "TokenMessenger (impl)", address: rec.contracts.tokenMessengerImpl, constructorArgs: [] },
    { name: "MultisigVerifier", address: rec.contracts.verifier, constructorArgs: [rec.contracts.validatorRegistry] },
  ];

  if (rec.contracts.priceOracle && rec.configuration.oracle) {
    tasks.push({
      name: "StableNairaPriceOracle",
      address: rec.contracts.priceOracle,
      constructorArgs: [
        rec.configuration.oracle.decimals,
        rec.configuration.oracle.reporters,
        rec.configuration.oracle.quorum,
      ],
    });
  }

  header(`${EMOJI.scan} Verifying contracts on Etherscan-compatible explorer`);

  for (const t of tasks) {
    if (!t.address) continue;
    action(`verifying ${t.name}`, t.address);
    try {
      await hre.run("verify:verify", {
        address: t.address,
        constructorArguments: t.constructorArgs,
      });
      ok(`${t.name} verified`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (/already verified/i.test(msg)) {
        ok(`${t.name} already verified`);
      } else {
        warn(`${t.name} verify failed`, msg.split("\n")[0]);
      }
    }
  }

  // Proxies — verify with constructor args (impl, initData). We don't recover initData
  // exactly; rely on Sourcify or block-explorer auto-detection of proxy. Print a hint.
  warn(
    `Proxies (ERC1967) are typically auto-detected by block explorers as proxies; if not, mark them manually as proxies on the explorer.`,
    `Stack: ${rec.contracts.stableNaira} / ${rec.contracts.validatorRegistry} / ${rec.contracts.messageTransmitter} / ${rec.contracts.tokenMessenger}`
  );
}

/* ============================ Phase: queue-wires ============================ */

async function phaseQueueWires(networkName: string, spec: any, template: any) {
  const localRec = readDeployment(networkName);
  if (!localRec || !localRec.contracts.tokenMessenger) {
    fail(`No deployment for ${networkName}. Run PHASE=deploy first.`);
    return;
  }

  const [signer] = await ethers.getSigners();
  const tokenMessenger = await ethers.getContractAt(
    "TokenMessenger",
    localRec.contracts.tokenMessenger,
    signer
  );

  header(`${EMOJI.wave} Queueing remote routers on ${spec.label}`);

  const newRoutes: RemoteRouterEntry[] = [];

  for (const peerName of spec.peers) {
    const peerSpec = template.networks[peerName];
    const peerRec = readDeployment(peerName);
    if (!peerRec || !peerRec.contracts.tokenMessenger) {
      warn(`Peer ${peerName} not yet deployed — skipping.`);
      continue;
    }
    const peerBridge = peerRec.contracts.tokenMessenger;
    const peerBridgeBytes32 = bytes32FromAddress(peerBridge);

    // Skip if already configured.
    const existing = await tokenMessenger.remoteRouter(peerSpec.domainId);
    if (existing.toLowerCase() === peerBridgeBytes32.toLowerCase()) {
      ok(`${peerSpec.label} (${peerSpec.domainId}) already wired`);
      continue;
    }

    action(`queueSetRemoteRouter`, `domain=${peerSpec.domainId} → ${peerBridge}`);
    const tx = await tokenMessenger.queueSetRemoteRouter(peerSpec.domainId, peerBridgeBytes32);
    const receipt = await tx.wait();
    const evt = receipt!.logs.find((l: any) => l.fragment?.name === "RemoteRouterChangeQueued") as any;
    const actionId = evt.args.actionId.toString() as string;
    // Read eta from the mixin's ActionQueued event in the same tx — more reliable
    // than a follow-up state read against eventually-consistent public RPCs.
    const tlEvt = receipt!.logs.find((l: any) => l.fragment?.name === "ActionQueued") as any;
    const eta = tlEvt ? Number(tlEvt.args.eta) : 0;
    ok(`queued`, `actionId=${actionId}  eta=${new Date(eta * 1000).toISOString()}`);
    newRoutes.push({
      domainId: peerSpec.domainId,
      router: peerBridgeBytes32,
      actionId,
      status: "queued",
      queuedAt: new Date().toISOString(),
      eta,
    });
  }

  // Merge with any prior queued/committed entries: prior committed routes stay; queued get replaced.
  const prior = (localRec.remoteRouters ?? []).filter(
    (r) => !newRoutes.some((n) => n.domainId === r.domainId)
  );
  upsertDeployment(networkName, { remoteRouters: [...prior, ...newRoutes] });

  if (newRoutes.length > 0) {
    info(`Persisted ${newRoutes.length} queued route(s).`);
    info(
      `Earliest commit eta: ${new Date(Math.min(...newRoutes.map((r) => r.eta!)) * 1000).toISOString()}`
    );
  }
  rocket(`${spec.label}: queue phase complete.`);
}

/* ============================ Phase: commit-wires ============================ */

async function phaseCommitWires(networkName: string, spec: any) {
  const localRec = readDeployment(networkName);
  if (!localRec || !localRec.contracts.tokenMessenger) {
    fail(`No deployment for ${networkName}.`);
    return;
  }
  const [signer] = await ethers.getSigners();
  const tokenMessenger = await ethers.getContractAt(
    "TokenMessenger",
    localRec.contracts.tokenMessenger,
    signer
  );

  header(`${EMOJI.beacon} Committing remote routers on ${spec.label}`);

  const queued = (localRec.remoteRouters ?? []).filter((r) => r.status === "queued");
  if (queued.length === 0) {
    warn(`No queued routes to commit on ${spec.label}.`);
    return;
  }

  const updated: RemoteRouterEntry[] = [...localRec.remoteRouters];

  for (const r of queued) {
    action(`commitSetRemoteRouter`, `domain=${r.domainId} actionId=${r.actionId}`);
    try {
      const tx = await tokenMessenger.commitSetRemoteRouter(r.actionId!, r.domainId, r.router);
      await tx.wait();
      ok(`committed`, `${r.domainId} → ${r.router.slice(0, 10)}…`);
      const idx = updated.findIndex((x) => x.domainId === r.domainId && x.actionId === r.actionId);
      if (idx >= 0) {
        updated[idx] = { ...r, status: "committed", committedAt: new Date().toISOString() };
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (/ActionNotReady/.test(msg)) {
        warn(`timelock not yet elapsed`, `eta=${r.eta} now=${Math.floor(Date.now() / 1000)}`);
      } else {
        fail(`commit failed`, msg.split("\n")[0]);
      }
    }
  }

  upsertDeployment(networkName, { remoteRouters: updated });
  rocket(`${spec.label}: commit phase complete.`);
}

/* ============================ Multi-chain queue / commit ============================ */
/* These phases drive every chain in the deployment group from a single hardhat
 * process. They build their own JsonRpcProvider + Wallet per chain (the
 * --network arg passed to `hardhat run` is therefore irrelevant — pass any).
 */

const TOKEN_MESSENGER_ABI = [
  "function remoteRouter(uint32) view returns (bytes32)",
  "function queueSetRemoteRouter(uint32 domain, bytes32 router) returns (uint256)",
  "function commitSetRemoteRouter(uint256 actionId, uint32 domain, bytes32 router)",
  "function pendingAction(uint256) view returns (tuple(bytes32 actionHash, uint64 eta))",
  "event RemoteRouterChangeQueued(uint256 indexed actionId, uint32 indexed domain, bytes32 router)",
  "event ActionQueued(uint256 indexed actionId, bytes32 indexed actionHash, uint64 eta)",
];

function privateKey(): string {
  const pk = process.env.PRIVATE_KEY;
  if (!pk || pk === "privatKey") {
    throw new Error("PRIVATE_KEY not set in .env");
  }
  return pk;
}

/** Retry on stale-nonce errors with explicit nonce refresh. */
async function sendWithNonceRetry(
  signer: Wallet,
  provider: JsonRpcProvider,
  build: (overrides: { nonce: number }) => Promise<any>,
  label: string,
  attempts = 3
): Promise<any> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const nonce = await provider.getTransactionCount(signer.address, "pending");
      const tx = await build({ nonce });
      return await tx.wait();
    } catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e);
      if (
        i + 1 < attempts &&
        /nonce too low|nonce has already been used|already known|replacement transaction underpriced/i.test(msg)
      ) {
        warn(`${label} retry (${i + 1}/${attempts - 1})`, msg.split("\n")[0]);
        await new Promise((r) => setTimeout(r, 3_000));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

async function phaseQueueAllWires(template: any) {
  const networks: string[] = template.deploymentGroups[GROUP];
  if (!networks) {
    fail(`Unknown GROUP="${GROUP}"`);
    return;
  }

  const pk = privateKey();
  let queuedTotal = 0;

  for (const net of networks) {
    const spec = template.networks[net];
    const localRec = readDeployment(net);
    if (!localRec || !localRec.contracts.tokenMessenger) {
      warn(`${spec.label}: not deployed — run PHASE=deploy first; skipping.`);
      continue;
    }

    const provider = new JsonRpcProvider(RPCS[net]);
    const signer = new Wallet(pk, provider);
    const tokenMessenger = new Contract(localRec.contracts.tokenMessenger, TOKEN_MESSENGER_ABI, signer);

    header(`${EMOJI.wave} Queueing remote routers on ${spec.label}`);

    for (const peerName of spec.peers) {
      const peerSpec = template.networks[peerName];
      const peerRec = readDeployment(peerName);
      if (!peerRec || !peerRec.contracts.tokenMessenger) {
        warn(`peer ${peerName} not deployed — skipping route on ${spec.label}.`);
        continue;
      }
      const peerBridge = peerRec.contracts.tokenMessenger;
      const peerBridgeBytes32 = bytes32FromAddress(peerBridge);

      // Already-committed: skip.
      const existing = (await tokenMessenger.remoteRouter(peerSpec.domainId)) as string;
      if (existing.toLowerCase() === peerBridgeBytes32.toLowerCase()) {
        ok(`${spec.label} → ${peerSpec.label} (${peerSpec.domainId}) already wired`);
        continue;
      }

      // Already-queued in our local manifest with future eta: skip (avoid duplicates after a retry).
      const persistedQueued = (localRec.remoteRouters ?? []).find(
        (r) =>
          r.domainId === peerSpec.domainId &&
          r.status === "queued" &&
          (r.eta ?? 0) > Math.floor(Date.now() / 1000) - 300
      );
      if (persistedQueued) {
        ok(
          `${spec.label} → ${peerSpec.label} (${peerSpec.domainId}) already queued`,
          `actionId=${persistedQueued.actionId} eta=${new Date((persistedQueued.eta ?? 0) * 1000).toISOString()}`
        );
        continue;
      }

      action(`queueSetRemoteRouter`, `${spec.label} → domain=${peerSpec.domainId} (${peerBridge})`);
      const receipt = await sendWithNonceRetry(
        signer,
        provider,
        ({ nonce }) =>
          tokenMessenger.queueSetRemoteRouter(peerSpec.domainId, peerBridgeBytes32, { nonce }),
        `${spec.label} queueSetRemoteRouter(${peerSpec.domainId})`
      );

      const iface = new Interface(TOKEN_MESSENGER_ABI);
      let actionId = "?";
      let eta = 0;
      for (const log of receipt!.logs ?? []) {
        try {
          const parsed = iface.parseLog(log as any);
          if (parsed?.name === "RemoteRouterChangeQueued") {
            actionId = (parsed.args.actionId as bigint).toString();
          } else if (parsed?.name === "ActionQueued") {
            eta = Number(parsed.args.eta);
          }
        } catch {}
      }
      ok(`queued`, `actionId=${actionId}  eta=${new Date(eta * 1000).toISOString()}`);

      // Persist this single route IMMEDIATELY so a subsequent failure
      // doesn't lose bookkeeping (the on-chain queue is the source of truth,
      // but we need the actionId to commit later).
      const fresh = readDeployment(net) ?? localRec;
      const prior = (fresh.remoteRouters ?? []).filter((r) => r.domainId !== peerSpec.domainId);
      const merged = [
        ...prior,
        {
          domainId: peerSpec.domainId,
          router: peerBridgeBytes32,
          actionId,
          status: "queued" as const,
          queuedAt: new Date().toISOString(),
          eta,
        },
      ];
      upsertDeployment(net, { remoteRouters: merged });
      queuedTotal++;
    }

    rocket(`${spec.label}: queue phase complete.`);
  }

  console.log("");
  if (queuedTotal === 0) {
    info(`No new routes queued across the group — every chain is already wired or nothing to do.`);
    return;
  }

  // Compute global latest eta for the timelock countdown reminder.
  let globalLatestEta = 0;
  for (const net of networks) {
    const rec = readDeployment(net);
    for (const r of rec?.remoteRouters ?? []) {
      if (r.status === "queued" && r.eta && r.eta > globalLatestEta) globalLatestEta = r.eta;
    }
  }
  if (globalLatestEta > 0) {
    info(
      `Global latest eta across the group`,
      `${new Date(globalLatestEta * 1000).toISOString()}  (in ${Math.max(0, globalLatestEta - Math.floor(Date.now() / 1000))}s)`
    );
  }
  rocket(`${EMOJI.wave} Queue-all complete across ${networks.length} chain(s).`);
}

async function phaseCommitAllWires(template: any) {
  const networks: string[] = template.deploymentGroups[GROUP];
  if (!networks) {
    fail(`Unknown GROUP="${GROUP}"`);
    return;
  }

  const pk = privateKey();

  // Collect all queued routes across all chains, find the global latest eta.
  const pending: { net: string; spec: any; rec: any; provider: JsonRpcProvider; signer: Wallet; tm: Contract }[] = [];
  let globalLatestEta = 0;

  for (const net of networks) {
    const spec = template.networks[net];
    const rec = readDeployment(net);
    if (!rec || !rec.contracts.tokenMessenger) continue;
    const queued = (rec.remoteRouters ?? []).filter((r) => r.status === "queued");
    if (queued.length === 0) continue;
    for (const r of queued) if (r.eta && r.eta > globalLatestEta) globalLatestEta = r.eta;

    const provider = new JsonRpcProvider(RPCS[net]);
    const signer = new Wallet(pk, provider);
    const tm = new Contract(rec.contracts.tokenMessenger, TOKEN_MESSENGER_ABI, signer);
    pending.push({ net, spec, rec, provider, signer, tm });
  }

  if (pending.length === 0) {
    warn(`Nothing queued anywhere in the ${GROUP} group.`);
    return;
  }

  const remaining = globalLatestEta - Math.floor(Date.now() / 1000) + TIMELOCK_BUFFER_SEC;
  if (remaining > 0) {
    if (SKIP_WAIT) {
      warn(`SKIP_WAIT=1 set — committing now (will revert if timelock not elapsed)`);
    } else {
      await countdown(
        `Holding for timelock across all ${pending.length} chain(s) — latest eta gates the whole batch`,
        remaining
      );
    }
  } else {
    ok(`Timelock already elapsed across all chains.`);
  }

  // Commit each chain's queued routes.
  for (const p of pending) {
    header(`${EMOJI.beacon} Committing remote routers on ${p.spec.label}`);
    const queued = (p.rec.remoteRouters ?? []).filter((r: RemoteRouterEntry) => r.status === "queued");
    const updated: RemoteRouterEntry[] = [...p.rec.remoteRouters];
    for (const r of queued) {
      action(`commitSetRemoteRouter`, `domain=${r.domainId} actionId=${r.actionId}`);
      try {
        await sendWithNonceRetry(
          p.signer,
          p.provider,
          ({ nonce }) => p.tm.commitSetRemoteRouter(r.actionId!, r.domainId, r.router, { nonce }),
          `${p.spec.label} commitSetRemoteRouter(${r.domainId})`
        );
        ok(`committed`, `${r.domainId} → ${r.router.slice(0, 10)}…`);
        const idx = updated.findIndex((x) => x.domainId === r.domainId && x.actionId === r.actionId);
        if (idx >= 0) {
          updated[idx] = { ...r, status: "committed", committedAt: new Date().toISOString() };
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (/ActionNotReady/.test(msg)) {
          warn(`timelock not yet elapsed`, `eta=${r.eta} now=${Math.floor(Date.now() / 1000)}`);
        } else if (/ActionNotFound/.test(msg)) {
          warn(`already committed (or cancelled)`, `actionId=${r.actionId}`);
          const idx = updated.findIndex((x) => x.domainId === r.domainId && x.actionId === r.actionId);
          if (idx >= 0) {
            updated[idx] = { ...r, status: "committed", committedAt: new Date().toISOString() };
          }
        } else {
          fail(`commit failed`, msg.split("\n")[0]);
        }
      }
    }
    upsertDeployment(p.net, { remoteRouters: updated });
    rocket(`${p.spec.label}: commit phase complete.`);
  }

  console.log("");
  rocket(`${EMOJI.beacon} Commit-all complete across ${pending.length} chain(s).`);
}

/* ============================ Phase: wait-and-commit ============================ */

async function phaseWaitAndCommit(networkName: string, spec: any) {
  const rec = readDeployment(networkName);
  if (!rec) {
    fail(`No deployment for ${networkName}.`);
    return;
  }
  const queued = (rec.remoteRouters ?? []).filter((r) => r.status === "queued");
  if (queued.length === 0) {
    warn(`Nothing queued — nothing to commit on ${spec.label}.`);
    return;
  }
  // Wait for the LATEST eta — committing earlier risks ActionNotReady on
  // routes queued slightly later in the same phase.
  const latestEta = Math.max(...queued.map((r) => r.eta!));
  const remaining = latestEta - Math.floor(Date.now() / 1000) + TIMELOCK_BUFFER_SEC;

  if (remaining > 0) {
    if (SKIP_WAIT) {
      warn(`SKIP_WAIT=1 set — committing now (will revert if timelock not elapsed)`);
    } else {
      await countdown(`Holding for timelock on ${spec.label}`, remaining);
    }
  } else {
    ok(`Timelock already elapsed.`);
  }
  await phaseCommitWires(networkName, spec);
}

/* ============================ Phase: summary ============================ */

async function phaseSummary() {
  const all = listDeployments();
  if (all.length === 0) {
    warn(`No deployments found yet under ignition/deployments/.`);
    return;
  }

  header(`${EMOJI.star} STABLENAIRA — DEPLOYED ADDRESS BOOK`);

  for (const { network, record } of all) {
    console.log("");
    console.log(magenta("┌── ") + bold(cyan(record.label)) + magenta(` (${network}) ──`));
    console.log(magenta("│"));
    console.log(magenta("│  ") + gray(`chainId=${record.chainId}  domainId=${record.domainId}`));
    console.log(magenta("│  ") + gray(`deployer=${record.deployer}`));
    console.log(magenta("│  ") + gray(`deployedAt=${record.deployedAt}`));
    console.log(magenta("│"));
    const addressLine = (label: string, addr?: string) => {
      if (!addr) return;
      const link = `${record.explorerUrl}/address/${addr}`;
      console.log(magenta("│  ") + cyan(label.padEnd(28)) + green(addr) + gray(`  ↗ ${link}`));
    };
    addressLine("StableNaira (proxy)", record.contracts.stableNaira);
    addressLine("StableNaira (impl)", record.contracts.stableNairaImpl);
    addressLine("StableNaira deployer", record.contracts.stableNairaDeployer);
    addressLine("ValidatorRegistry (proxy)", record.contracts.validatorRegistry);
    addressLine("ValidatorRegistry (impl)", record.contracts.validatorRegistryImpl);
    addressLine("MultisigVerifier", record.contracts.verifier);
    addressLine("MessageTransmitter (proxy)", record.contracts.messageTransmitter);
    addressLine("MessageTransmitter (impl)", record.contracts.messageTransmitterImpl);
    addressLine("TokenMessenger (proxy)", record.contracts.tokenMessenger);
    addressLine("TokenMessenger (impl)", record.contracts.tokenMessengerImpl);
    addressLine("StableNairaPriceOracle", record.contracts.priceOracle);

    if (record.remoteRouters?.length) {
      console.log(magenta("│"));
      console.log(magenta("│  ") + bold(yellow("Remote routes:")));
      for (const r of record.remoteRouters) {
        const statusColor = r.status === "committed" ? green : yellow;
        console.log(
          magenta("│    ") +
            statusColor((r.status ?? "?").padEnd(10)) +
            cyan(`domain=${r.domainId}`) +
            gray(`  →  ${r.router}`)
        );
      }
    }
    console.log(magenta("└" + "─".repeat(78)));
  }
  console.log("");
}

/* ============================ Phase: smoke ============================ */

async function phaseSmoke(networkName: string, spec: any) {
  const rec = readDeployment(networkName);
  if (!rec) {
    fail(`No deployment for ${networkName}.`);
    return;
  }
  const [signer] = await ethers.getSigners();
  const stable = await ethers.getContractAt("StableNaira", rec.contracts.stableNaira!, signer);

  header(`${EMOJI.fire} Smoke test on ${spec.label}`);
  const before = await stable.balanceOf(signer.address);
  info(`balance before mint`, before.toString());
  const tx = await stable.mint(signer.address, 100n);
  await tx.wait();
  const after = await stable.balanceOf(signer.address);
  ok(`minted 100`, `balance ${before} → ${after}`);
}

/* ============================ run ============================ */

main().catch((e) => {
  fail("FATAL", e?.message ?? String(e));
  console.error(e);
  process.exitCode = 1;
});
