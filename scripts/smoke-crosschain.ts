/* eslint-disable no-console */
/**
 * End-to-end cross-chain smoke test.
 *
 * Runs against the live testnets we just deployed: mints SNR on one chain,
 * burns it via TokenMessenger.depositForBurn, recovers the MessageSent
 * envelope, signs the attestation digest with the validator key, and submits
 * MessageTransmitter.receiveMessage on the destination chain. Verifies the
 * recipient balance increased on the destination.
 *
 * Usage:
 *   SOURCE=testnet DEST=sepolia npx hardhat run scripts/smoke-crosschain.ts --network testnet
 *   AMOUNT=500 SOURCE=sepolia DEST=baseSepolia npx hardhat run scripts/smoke-crosschain.ts --network sepolia
 *
 * The `--network` argument is meaningless to this script (we drive both chains
 * via direct JsonRpcProvider). Hardhat just needs *some* network to bind ethers.
 */
import "dotenv/config";

import { ethers, Wallet, JsonRpcProvider, Contract } from "ethers";

import { loadTemplate } from "./lib/params";
import { readDeployment } from "./lib/persistence";
import {
  banner,
  header,
  step,
  ok,
  fail,
  info,
  action,
  rocket,
  cyan,
  yellow,
  green,
  magenta,
  EMOJI,
} from "./lib/cli";

const SOURCE = (process.env.SOURCE ?? "testnet").toLowerCase();
const DEST = (process.env.DEST ?? "sepolia").toLowerCase();
const AMOUNT = BigInt(process.env.AMOUNT ?? "100");

const RPCS: Record<string, string> = {
  testnet: process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545/",
  sepolia: process.env.ETHEREUM_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  baseSepolia: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
  mainnet: process.env.BSC_MAINNET_RPC_URL ?? "https://bsc-dataseed.binance.org/",
  ethereum: process.env.ETHEREUM_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  base: process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org",
};

const ATTESTATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "StableNairaCCTPAttestation(bytes32 envelopeHash,uint256 chainId,address transmitter)"
  )
);

function attestationDigest(envelope: string, chainId: bigint, transmitter: string): string {
  const envelopeHash = ethers.keccak256(envelope);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "uint256", "address"],
    [ATTESTATION_TYPEHASH, envelopeHash, chainId, transmitter]
  );
  return ethers.keccak256(encoded);
}

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function mint(address,uint256) returns (bool)",
];

const BRIDGE_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64)",
  "function localToken() view returns (address)",
  "function remoteRouter(uint32) view returns (bytes32)",
];

const TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function localDomain() view returns (uint32)",
  "function isNonceUsed(uint32, uint64) view returns (bool)",
  "event MessageSent(bytes message)",
];

async function main() {
  const template = loadTemplate();
  const sourceSpec = template.networks[SOURCE];
  const destSpec = template.networks[DEST];
  if (!sourceSpec || !destSpec) {
    fail(`Unknown SOURCE=${SOURCE} or DEST=${DEST}`);
    process.exitCode = 1;
    return;
  }

  const sourceRec = readDeployment(SOURCE);
  const destRec = readDeployment(DEST);
  if (!sourceRec || !destRec) {
    fail(`Missing deployment record for ${SOURCE} or ${DEST} — run PHASE=deploy first.`);
    process.exitCode = 1;
    return;
  }

  banner("STABLENAIRA / CROSS-CHAIN SMOKE TEST", `${sourceSpec.label} → ${destSpec.label}  amount=${AMOUNT}`);

  const pk = process.env.PRIVATE_KEY!;
  if (!pk) {
    fail("PRIVATE_KEY not set");
    process.exitCode = 1;
    return;
  }

  const sourceProvider = new JsonRpcProvider(RPCS[SOURCE]);
  const destProvider = new JsonRpcProvider(RPCS[DEST]);
  const sourceSigner = new Wallet(pk, sourceProvider);
  const destSigner = new Wallet(pk, destProvider);

  const tokenSrc = new Contract(sourceRec.contracts.stableNaira!, TOKEN_ABI, sourceSigner);
  const tokenDst = new Contract(destRec.contracts.stableNaira!, TOKEN_ABI, destProvider);
  const bridgeSrc = new Contract(sourceRec.contracts.tokenMessenger!, BRIDGE_ABI, sourceSigner);
  const tmSrc = new Contract(sourceRec.contracts.messageTransmitter!, TRANSMITTER_ABI, sourceProvider);
  const tmDst = new Contract(destRec.contracts.messageTransmitter!, TRANSMITTER_ABI, destSigner);

  // Sanity: route must be committed (non-zero) on source.
  const route = (await bridgeSrc.remoteRouter(destSpec.domainId)) as string;
  if (route === "0x" + "00".repeat(32)) {
    fail(
      `Source bridge has no committed remote router for domain ${destSpec.domainId} — run commit-wires first.`
    );
    process.exitCode = 1;
    return;
  }
  ok(`Remote router on source (domain ${destSpec.domainId})`, route);

  // 1. Mint AMOUNT to the deployer on source so we have something to burn.
  header(`${EMOJI.fire} Step 1: mint ${AMOUNT} SNR on ${sourceSpec.label}`);
  const balBefore = (await tokenSrc.balanceOf(sourceSigner.address)) as bigint;
  info(`pre-mint balance`, `${balBefore.toString()} SNR`);
  let tx = await tokenSrc.mint(sourceSigner.address, AMOUNT);
  let receipt = await tx.wait();
  ok(`minted`, `tx=${receipt.hash}`);
  const balAfterMint = (await tokenSrc.balanceOf(sourceSigner.address)) as bigint;
  info(`post-mint balance`, `${balAfterMint.toString()} SNR`);

  // 2. depositForBurn.
  header(`${EMOJI.warp} Step 2: depositForBurn → ${destSpec.label}`);
  const recipient = ethers.zeroPadValue(ethers.getAddress(sourceSigner.address), 32);
  action(`depositForBurn`, `amount=${AMOUNT} dest=${destSpec.domainId} recipient=${recipient}`);
  tx = await bridgeSrc.depositForBurn(AMOUNT, destSpec.domainId, recipient, sourceRec.contracts.stableNaira!);
  receipt = await tx.wait();
  const burnTxHash = receipt.hash;
  ok(`burned`, `tx=${burnTxHash}`);

  // Recover envelope from MessageSent.
  const iface = new ethers.Interface(TRANSMITTER_ABI);
  let envelope = "";
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "MessageSent") {
        envelope = parsed.args.message as string;
        break;
      }
    } catch {
      // not the right event
    }
  }
  if (!envelope) {
    fail(`Did not find MessageSent in tx receipt — bridge may not be using transmitter ${sourceRec.contracts.messageTransmitter}`);
    process.exitCode = 1;
    return;
  }
  info(`envelope captured`, `${envelope.length / 2 - 1} bytes`);

  // 3. Sign attestation.
  header(`${EMOJI.shield} Step 3: validator signs attestation digest for ${destSpec.label} transmitter`);
  const destChainId = (await destProvider.getNetwork()).chainId;
  const digest = attestationDigest(envelope, destChainId, destRec.contracts.messageTransmitter!);
  info(`digest`, digest);
  const validator = new Wallet(pk); // 1-of-1 testnet validator == deployer
  const sig = validator.signingKey.sign(digest);
  const attestation = sig.serialized;
  ok(`signed`, `validator=${validator.address}  sig=${attestation.slice(0, 12)}…${attestation.slice(-8)}`);

  // 4. receiveMessage on destination.
  header(`${EMOJI.beacon} Step 4: receiveMessage on ${destSpec.label}`);
  const balDestBefore = (await tokenDst.balanceOf(sourceSigner.address)) as bigint;
  info(`pre-receive balance on dest`, `${balDestBefore.toString()} SNR`);
  tx = await tmDst.receiveMessage(envelope, attestation);
  receipt = await tx.wait();
  const mintTxHash = receipt.hash;
  ok(`received`, `tx=${mintTxHash}`);

  const balDestAfter = (await tokenDst.balanceOf(sourceSigner.address)) as bigint;
  info(`post-receive balance on dest`, `${balDestAfter.toString()} SNR`);

  if (balDestAfter - balDestBefore !== AMOUNT) {
    fail(`Mint amount mismatch: expected +${AMOUNT}, got +${balDestAfter - balDestBefore}`);
    process.exitCode = 1;
    return;
  }

  rocket(
    `Round-trip success.`,
    `Burned ${AMOUNT} on ${sourceSpec.label}, minted ${AMOUNT} on ${destSpec.label}.`
  );
  console.log("");
  console.log(magenta("┌──────────────────────────────────────────────────────────────────────────────┐"));
  console.log(magenta("│  ") + green("✓") + cyan(` ${sourceSpec.label}`) + ` ${EMOJI.warp} ` + cyan(`${destSpec.label}`) + `   amount=${AMOUNT} SNR`);
  console.log(magenta("│  ") + yellow(`source burn tx`) + `   ${sourceSpec.explorerUrl}/tx/${burnTxHash}`);
  console.log(magenta("│  ") + yellow(`dest   mint tx`) + `   ${destSpec.explorerUrl}/tx/${mintTxHash}`);
  console.log(magenta("└──────────────────────────────────────────────────────────────────────────────┘"));
}

main().catch((e) => {
  fail("FATAL", e?.message ?? String(e));
  console.error(e);
  process.exitCode = 1;
});
