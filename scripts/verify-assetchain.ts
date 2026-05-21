// Verify Asset Chain mainnet contracts against the Blockscout v2 API.
//
// Why this exists: `hardhat-verify` v2 routes everything through Etherscan's
// global v2 chainlist + Sourcify, and Asset Chain (chainId 42420) is on
// neither. Blockscout at scan.assetchain.org has its own v2 API though, and
// it accepts a Solidity Standard JSON Input directly. This script reads each
// contract's standard input out of Hardhat's `artifacts/build-info/*.json`
// and POSTs it to that API, polling for verification completion.
//
// Usage:
//   bun scripts/verify-assetchain.ts                  # verify all impls + factory
//   bun scripts/verify-assetchain.ts MultisigVerifier # one target by contractName/label
//
// Requirements:
//   - Hardhat artifacts present (`npx hardhat compile` first if missing)
//   - ignition/deployments/assetchain/addresses.json with the deployed addresses

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, "..");
const BLOCKSCOUT = "https://scan.assetchain.org/api/v2";

type Target = {
  label: string;            // human-friendly tag printed in logs
  address: `0x${string}`;   // on-chain address
  sourceName: string;       // path under contracts/ as Hardhat sees it
  contractName: string;     // Solidity contract name inside that file
  // When verifying a proxy we still need *some* artifact to point at for the
  // dbg.json lookup (so we can fish out the matching build-info), even though
  // the contract_name we submit to Blockscout is the ERC1967Proxy library one.
  // `artifactSource`/`artifactName` default to sourceName/contractName.
  artifactSource?: string;
  artifactName?: string;
};

const ADDR_FILE = path.join(ROOT, "ignition/deployments/assetchain/addresses.json");
if (!fs.existsSync(ADDR_FILE)) {
  console.error(`addresses.json not found at ${ADDR_FILE}`);
  process.exit(1);
}
const ADDR = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));

// Impl + factory + non-upgradeable contracts use their own source. The four
// ERC1967 proxies share OpenZeppelin's ERC1967Proxy contract name but we still
// pin the build-info via one of our own artifacts (any will do — they all
// resolve to the same build-info file Hardhat produced).
const ERC1967_NAME   = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";
const PROXY_ARTIFACT = { source: "contracts/StableNairaUUPSDeployer.sol", name: "StableNairaUUPSDeployer" };

const TARGETS: Target[] = [
  { label: "StableNairaUUPSDeployer",
    address: ADDR.contracts.stableNairaDeployer,
    sourceName: "contracts/StableNairaUUPSDeployer.sol",
    contractName: "StableNairaUUPSDeployer" },
  { label: "StableNaira (impl)",
    address: ADDR.contracts.stableNairaImpl,
    sourceName: "contracts/StableNaira.sol",
    contractName: "StableNaira" },
  { label: "ValidatorRegistry (impl)",
    address: ADDR.contracts.validatorRegistryImpl,
    sourceName: "contracts/cctp/ValidatorRegistry.sol",
    contractName: "ValidatorRegistry" },
  { label: "MessageTransmitter (impl)",
    address: ADDR.contracts.messageTransmitterImpl,
    sourceName: "contracts/cctp/MessageTransmitter.sol",
    contractName: "MessageTransmitter" },
  { label: "TokenMessenger (impl)",
    address: ADDR.contracts.tokenMessengerImpl,
    sourceName: "contracts/cctp/TokenMessenger.sol",
    contractName: "TokenMessenger" },
  { label: "MultisigVerifier",
    address: ADDR.contracts.verifier,
    sourceName: "contracts/cctp/verifiers/MultisigVerifier.sol",
    contractName: "MultisigVerifier" },
  // ERC1967 proxies — constructor args (impl, initData) are auto-detected by
  // Blockscout from on-chain creation analysis.
  { label: "StableNaira (proxy)",
    address: ADDR.contracts.stableNaira,
    sourceName: ERC1967_NAME.split(":")[0]!,
    contractName: ERC1967_NAME.split(":")[1]!,
    artifactSource: PROXY_ARTIFACT.source,
    artifactName:   PROXY_ARTIFACT.name },
  { label: "ValidatorRegistry (proxy)",
    address: ADDR.contracts.validatorRegistry,
    sourceName: ERC1967_NAME.split(":")[0]!,
    contractName: ERC1967_NAME.split(":")[1]!,
    artifactSource: PROXY_ARTIFACT.source,
    artifactName:   PROXY_ARTIFACT.name },
  { label: "MessageTransmitter (proxy)",
    address: ADDR.contracts.messageTransmitter,
    sourceName: ERC1967_NAME.split(":")[0]!,
    contractName: ERC1967_NAME.split(":")[1]!,
    artifactSource: PROXY_ARTIFACT.source,
    artifactName:   PROXY_ARTIFACT.name },
  { label: "TokenMessenger (proxy)",
    address: ADDR.contracts.tokenMessenger,
    sourceName: ERC1967_NAME.split(":")[0]!,
    contractName: ERC1967_NAME.split(":")[1]!,
    artifactSource: PROXY_ARTIFACT.source,
    artifactName:   PROXY_ARTIFACT.name },
];

async function probeVerified(addr: string): Promise<{ verified: boolean; partial: boolean; name?: string }> {
  const r = await fetch(`${BLOCKSCOUT}/smart-contracts/${addr}`);
  if (r.status === 404) return { verified: false, partial: false };
  const j: any = await r.json().catch(() => ({}));
  return {
    verified: !!j.is_verified,
    partial:  !!j.is_partially_verified,
    name:     j.name,
  };
}

function loadStandardInput(t: Target): { input: any; solcLongVersion: string } {
  // For proxy targets we point at a local artifact (any will do) so we can
  // resolve the shared build-info; the contract_name submitted to Blockscout
  // is still the ERC1967Proxy fully-qualified name.
  const artSource = t.artifactSource ?? t.sourceName;
  const artName   = t.artifactName   ?? t.contractName;
  const dbgPath = path.join(ROOT, "artifacts", artSource, `${artName}.dbg.json`);
  if (!fs.existsSync(dbgPath)) {
    throw new Error(`No build artifact for ${t.label} at ${dbgPath}.\n` +
      `Run \`npx hardhat compile\` from ${ROOT} and retry.`);
  }
  const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
  const buildInfoPath = path.resolve(path.dirname(dbgPath), dbg.buildInfo);
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  return { input: buildInfo.input, solcLongVersion: buildInfo.solcLongVersion };
}

async function pollUntilVerified(addr: string, label: string, maxSeconds = 600): Promise<boolean> {
  const pollMs = 5000;
  const tries = Math.ceil(maxSeconds * 1000 / pollMs);
  for (let i = 1; i <= tries; i++) {
    await new Promise(r => setTimeout(r, pollMs));
    const s = await probeVerified(addr);
    if (s.verified || s.partial) {
      const kind = s.verified ? "verified" : "partially verified";
      console.log(`           ✓ ${kind} after ${i * pollMs / 1000}s`);
      return true;
    }
  }
  console.log(`           ⚠ still pending after ${maxSeconds}s — check Blockscout UI`);
  return false;
}

async function verifyOne(t: Target): Promise<boolean> {
  const cur = await probeVerified(t.address);
  if (cur.verified || cur.partial) {
    console.log(`[skip ] ${t.label.padEnd(28)} ${t.address}  already ${cur.verified ? "verified" : "partially verified"}${cur.name ? ` as ${cur.name}` : ""}`);
    return true;
  }

  const { input, solcLongVersion } = loadStandardInput(t);
  const optEnabled = !!input.settings?.optimizer?.enabled;
  const optRuns    = Number(input.settings?.optimizer?.runs ?? 200);
  const evmVersion = input.settings?.evmVersion;

  // Blockscout's multipart parser is finicky about how the file part is framed.
  // Bun.file() reads from a real file path and produces a stream-backed FormData
  // entry that Blockscout's verifier accepts; in-memory Blob+FormData submissions
  // are silently dropped with a "JSON files not found" response for some
  // contracts. So we materialise the standard input on disk first.
  const tmpFile = path.join(
    process.env.TMPDIR || "/tmp",
    `assetchain-verify-${t.contractName}-${Date.now()}.json`,
  );
  fs.writeFileSync(tmpFile, JSON.stringify(input));

  const fd = new FormData();
  fd.set("compiler_version", `v${solcLongVersion}`);
  fd.set("license_type", "mit");
  // For OZ ERC1967 the canonical FQN includes the npm path prefix; for our
  // own contracts it's `contracts/...sol:Name`.
  const contractFqn = t.sourceName.startsWith("@") || t.sourceName.startsWith("contracts/")
    ? `${t.sourceName}:${t.contractName}`
    : `${t.sourceName}:${t.contractName}`;
  fd.set("contract_name", contractFqn);
  fd.set("is_optimization_enabled", String(optEnabled));
  fd.set("optimization_runs", String(optRuns));
  if (evmVersion) fd.set("evm_version", evmVersion);
  fd.set("autodetect_constructor_args", "true");
  // @ts-expect-error Bun extends FormData with file-stream support
  fd.set("files[0]", Bun.file(tmpFile));

  console.log(`[submit] ${t.label.padEnd(28)} ${t.address}  v${solcLongVersion}  evm=${evmVersion ?? "default"}  opt=${optEnabled}/${optRuns}`);
  const r = await fetch(`${BLOCKSCOUT}/smart-contracts/${t.address}/verification/via/standard-input`, {
    method: "POST",
    body: fd as any,
  });
  const text = await r.text();
  fs.unlinkSync(tmpFile);
  if (!r.ok) {
    console.log(`           ✗ HTTP ${r.status}: ${text.slice(0, 400)}`);
    return false;
  }
  let body: any; try { body = JSON.parse(text); } catch { body = null; }
  if (body?.message) console.log(`           → ${body.message}`);
  return await pollUntilVerified(t.address, t.label);
}

const filter = process.argv[2];
const list = filter
  ? TARGETS.filter(t => t.label === filter || t.contractName === filter)
  : TARGETS;
if (filter && list.length === 0) {
  console.error(`No target matches "${filter}". Known labels:`);
  for (const t of TARGETS) console.error(`  ${t.label}  (or ${t.contractName})`);
  process.exit(1);
}

let ok = 0, fail = 0;
for (const t of list) {
  if (await verifyOne(t)) ok++; else fail++;
}
console.log(`\nSummary: ${ok} verified, ${fail} failed/pending  (network=assetchain mainnet)`);
process.exit(fail === 0 ? 0 : 1);
