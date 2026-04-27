/**
 * Align on-chain BLS12381Verifier `dst` with off-chain `BLS_DST` in
 * cctp-network/packages/crypto/src/bls.ts (via setDst, DEFAULT_ADMIN_ROLE).
 *
 * Usage:
 *   npx hardhat run scripts/set-verifier-dst.cjs --network sepolia
 *   npx hardhat run scripts/set-verifier-dst.cjs --network sepolia --verifier 0x...
 *   npx hardhat run scripts/set-verifier-dst.cjs --network sepolia --dry-run
 *
 * Reads verifier proxy from ignition/deployments/<network>/stable-naira-stack-addresses.json
 * unless --verifier is set. Requires PRIVATE_KEY in env to be the verifier admin.
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const CANONICAL_DST_STRING = "STABLENAIRA_CCTP_BLS12381G2_XMD:SHA-256_SSWU_RO_v1";

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

function addressesPath() {
  const explicit = getCliArg("--addresses");
  if (explicit) return path.resolve(process.cwd(), explicit);
  const networkName = hre.network.name;
  return path.resolve(
    process.cwd(),
    `ignition/deployments/${networkName}/stable-naira-stack-addresses.json`,
  );
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const overrideVerifier = getCliArg("--verifier");

  const pk = process.env.PRIVATE_KEY;
  if (!dryRun && (!pk || pk === "privatKey")) {
    throw new Error("Set PRIVATE_KEY in .env to the verifier DEFAULT_ADMIN (deploy admin).");
  }

  const addrPath = addressesPath();
  const output = loadJson(addrPath);
  const verifierProxy = overrideVerifier || output?.cctp?.verifier?.proxy;
  if (!hre.ethers.isAddress(verifierProxy)) {
    throw new Error(
      `Missing verifier proxy in ${addrPath} (expected cctp.verifier.proxy). Use --verifier 0x...`,
    );
  }

  const targetDst = hre.ethers.toUtf8Bytes(CANONICAL_DST_STRING);
  const targetHex = hre.ethers.hexlify(targetDst);

  const signer = (await hre.ethers.getSigners())[0];
  console.log(`network=${hre.network.name} chainId=${hre.network.config.chainId}`);
  console.log(`signer=${await signer.getAddress()}`);
  console.log(`verifier=${verifierProxy}`);
  console.log(`addresses file=${addrPath}`);

  const v = await hre.ethers.getContractAt("BLS12381Verifier", verifierProxy, signer);
  const current = hre.ethers.getBytes(await v.dst());
  const currentHex = hre.ethers.hexlify(current);

  console.log(`current dst (${current.length} bytes)=${currentHex}`);
  console.log(`target dst (${targetDst.length} bytes)=${targetHex}`);

  if (bytesEqual(current, targetDst)) {
    console.log("dst already matches canonical string; nothing to do.");
    return;
  }

  if (dryRun) {
    console.log("[dry-run] would call setDst; re-run without --dry-run to send tx.");
    return;
  }

  const tx = await v.setDst(targetDst);
  console.log(`setDst tx=${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`mined in block ${receipt.blockNumber}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
