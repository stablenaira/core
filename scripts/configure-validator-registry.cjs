const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readConfig() {
  const configPath = getCliArg("--deploy-config") || process.env.DEPLOY_CONFIG;
  if (!configPath) {
    throw new Error("Missing deploy config path. Use --deploy-config or DEPLOY_CONFIG.");
  }
  return loadJson(path.resolve(process.cwd(), configPath));
}

function resolveOutputPath(cfg) {
  const networkName = hre.network.name;
  const raw = cfg.outputFile || `ignition/deployments/${networkName}/stable-naira-stack-addresses.json`;
  return path.resolve(
    process.cwd(),
    String(raw).replaceAll("<network>", networkName).replaceAll("{network}", networkName),
  );
}

function resolveQueueStatePath(cfg) {
  const networkName = hre.network.name;
  const chainId = hre.network.config?.chainId;
  const chainSuffix = Number.isInteger(chainId) ? `-${chainId}` : "";
  const explicit = cfg?.validatorBootstrap?.queueStateFile;
  if (explicit) {
    const withNetwork = String(explicit).replaceAll("<network>", networkName).replaceAll("{network}", networkName);
    if (withNetwork.includes("<chainId>") || withNetwork.includes("{chainId}")) {
      return path.resolve(
        process.cwd(),
        withNetwork
          .replaceAll("<chainId>", String(chainId ?? "unknown"))
          .replaceAll("{chainId}", String(chainId ?? "unknown")),
      );
    }
    const parsed = path.parse(withNetwork);
    return path.resolve(
      process.cwd(),
      path.join(parsed.dir, `${parsed.name}${chainSuffix}${parsed.ext || ".json"}`),
    );
  }
  return path.resolve(
    process.cwd(),
    `ignition/deployments/${networkName}/validator-registry-queue${chainSuffix}.json`,
  );
}

function normalizeHexBytes(value, label) {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`${label} must be a 0x-prefixed hex string`);
  }
  if (!hre.ethers.isHexString(value)) {
    throw new Error(`${label} must be valid hex`);
  }
  return value.toLowerCase();
}

function normalizeAddress(value, label) {
  if (!value || !hre.ethers.isAddress(value)) {
    throw new Error(`${label} must be a valid address`);
  }
  return hre.ethers.getAddress(value);
}

function normalizeBlsG1PublicKey(value, label) {
  const publicKey = normalizeHexBytes(value, label);
  const byteLen = (publicKey.length - 2) / 2;

  if (byteLen === 128) {
    return publicKey;
  }

  // Accept and normalize 68-byte-per-coordinate padded format (136 bytes total)
  // into the required 64-byte-per-coordinate format (128 bytes total).
  if (byteLen === 136) {
    const hex = publicKey.slice(2);
    const x = hex.slice(0, 136); // 68 bytes
    const y = hex.slice(136); // 68 bytes
    const xPad = x.slice(0, 8); // 4 bytes
    const yPad = y.slice(0, 8); // 4 bytes

    if (xPad === "00000000" && yPad === "00000000") {
      return `0x${x.slice(8)}${y.slice(8)}`;
    }

    throw new Error(
      `${label} is 136 bytes but does not look like 68+68 padded coordinates; expected 128 bytes or zero-padded 136 bytes`,
    );
  }

  throw new Error(`${label} must be exactly 128 bytes (got ${byteLen})`);
}

function normalizeValidators(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("validatorBootstrap.validators must be a non-empty array");
  }
  return values.map((entry, idx) => {
    const publicKey = normalizeBlsG1PublicKey(entry.publicKey, `validators[${idx}].publicKey`);
    const weight = BigInt(entry.weight ?? 0);
    if (weight <= 0n) {
      throw new Error(`validators[${idx}].weight must be > 0`);
    }
    const identityAddress = normalizeAddress(entry.identityAddress, `validators[${idx}].identityAddress`);
    return { publicKey, weight, identityAddress };
  });
}

async function waitTx(label, txPromise, confirmations) {
  const tx = await txPromise;
  console.log(`${label} submitted: ${tx.hash}`);
  const receipt = await tx.wait(confirmations);
  console.log(`${label} confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function queueChanges(registry, cfg, queueStatePath, confirmations) {
  const bootstrap = cfg.validatorBootstrap || {};
  const validators = normalizeValidators(bootstrap.validators || []);
  const threshold = BigInt(bootstrap.threshold ?? 0);
  if (threshold === 0n) {
    console.warn(
      "WARNING: validatorBootstrap.threshold=0 disables attestation enforcement. " +
        "Use a non-zero threshold in production deployments.",
    );
  }

  const queued = [];
  let totalWeight = 0n;
  for (const entry of validators) {
    totalWeight += entry.weight;
    const isActive = await registry.isActive(entry.publicKey);
    if (isActive) {
      console.log(`Skip queueAdd (already active): ${entry.publicKey.slice(0, 18)}...`);
      continue;
    }
    const changeId = await registry.queueAdd.staticCall(entry.publicKey, entry.weight, entry.identityAddress);
    await waitTx(
      `queueAdd changeId=${changeId}`,
      registry.queueAdd(entry.publicKey, entry.weight, entry.identityAddress),
      confirmations,
    );
    queued.push({ kind: "add", changeId: Number(changeId) });
  }

  if (threshold > totalWeight) {
    throw new Error(`validatorBootstrap.threshold (${threshold}) exceeds total configured weight (${totalWeight})`);
  }

  const currentThreshold = await registry.threshold();
  if (currentThreshold !== threshold) {
    const thresholdChangeId = await registry.queueSetThreshold.staticCall(threshold);
    await waitTx(
      `queueSetThreshold changeId=${thresholdChangeId}`,
      registry.queueSetThreshold(threshold),
      confirmations,
    );
    queued.push({ kind: "threshold", changeId: Number(thresholdChangeId) });
  } else {
    console.log(`Skip queueSetThreshold (already ${currentThreshold})`);
  }

  let existingChanges = [];
  if (fs.existsSync(queueStatePath)) {
    try {
      const existing = loadJson(queueStatePath);
      existingChanges = Array.isArray(existing?.changes) ? existing.changes : [];
    } catch (_err) {
      // Ignore malformed prior queue state and replace with fresh state.
      existingChanges = [];
    }
  }

  const mergedById = new Map();
  for (const change of existingChanges) {
    const id = Number(change?.changeId);
    if (Number.isInteger(id)) mergedById.set(id, change);
  }
  for (const change of queued) {
    mergedById.set(Number(change.changeId), change);
  }

  const state = {
    network: hre.network.name,
    chainId: hre.network.config?.chainId ?? null,
    queuedAt: new Date().toISOString(),
    registry: await registry.getAddress(),
    changes: [...mergedById.values()].sort((a, b) => Number(a.changeId) - Number(b.changeId)),
  };
  saveJson(queueStatePath, state);
  console.log(`Queue state saved: ${queueStatePath}`);
}

function parseChangeIdsFromCli() {
  const raw = getCliArg("--change-ids");
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0);
}

async function commitChanges(registry, queueStatePath, confirmations) {
  let queueState = { changes: [] };
  let changeIds = parseChangeIdsFromCli();
  if (fs.existsSync(queueStatePath)) {
    queueState = loadJson(queueStatePath);
  }
  if (changeIds.length === 0) {
    changeIds = (queueState.changes || []).map((c) => Number(c.changeId)).filter(Number.isInteger);
  }
  if (changeIds.length === 0) {
    throw new Error("No change IDs to commit. Use --change-ids or queue first.");
  }
  const skipped = [];
  const committed = [];
  for (const changeId of changeIds) {
    try {
      await registry.commit.staticCall(changeId);
    } catch (_err) {
      skipped.push(changeId);
      console.log(`Skip commit changeId=${changeId} (not ready or already applied)`);
      continue;
    }
    await waitTx(`commit changeId=${changeId}`, registry.commit(changeId), confirmations);
    committed.push(changeId);
  }
  const committedSet = new Set(committed);
  const remainingChanges = (queueState.changes || []).filter((c) => !committedSet.has(Number(c?.changeId)));
  saveJson(queueStatePath, {
    ...queueState,
    lastCommitAttemptAt: new Date().toISOString(),
    changes: remainingChanges,
  });
  if (committed.length > 0) {
    console.log(`Committed and removed from queue state: ${committed.join(", ")}`);
  }
  if (skipped.length > 0) {
    console.log(
      `Pending changeIds not committed yet (timelock likely not elapsed): ${skipped.join(", ")}. Re-run this script later to commit.`,
    );
  }
}

async function main() {
  const cfg = readConfig();
  const confirmations = Number(cfg.confirmations ?? 1);
  const outputPath = resolveOutputPath(cfg);
  const output = loadJson(outputPath);
  const registryAddress = output?.cctp?.registry?.proxy;
  if (!registryAddress || !hre.ethers.isAddress(registryAddress)) {
    throw new Error(`ValidatorRegistry proxy not found in deployment output: ${outputPath}`);
  }

  const registry = await hre.ethers.getContractAt("ValidatorRegistry", registryAddress);
  const queueStatePath = resolveQueueStatePath(cfg);
  await queueChanges(registry, cfg, queueStatePath, confirmations);
  await commitChanges(registry, queueStatePath, confirmations);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
