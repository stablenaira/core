/* eslint-disable no-console */
/**
 * Pure-UI replay of the deploy ceremony. No RPC calls. No chain interaction.
 * Walks through every banner / step / countdown / summary the live ceremony
 * produces, using the real addresses persisted under
 * `core/ignition/deployments/<network>/addresses.json` so the output is
 * indistinguishable from the on-chain run.
 *
 * Usage (no hardhat needed — pure node):
 *   npx tsx scripts/demo.ts                                # full ceremony, default ~30s "timelock"
 *   COUNTDOWN_SEC=10  npx tsx scripts/demo.ts              # shorter countdown
 *   COUNTDOWN_SEC=3600 npx tsx scripts/demo.ts             # full hour, like the real run
 *   DEMO_PHASE=summary npx tsx scripts/demo.ts             # only the summary phase
 *   DEMO_PHASE=deploy,verify,summary npx tsx scripts/demo.ts
 *
 * Or via hardhat (any network — none of the calls actually leave the process):
 *   npx hardhat run scripts/demo.ts --network hardhat
 */
import "dotenv/config";

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
  countdown,
  teleprint,
  EMOJI,
} from "./lib/cli";
import { loadTemplate } from "./lib/params";
import { listDeployments } from "./lib/persistence";

const COUNTDOWN_SEC = Number(process.env.COUNTDOWN_SEC ?? 30);
const STEP_MS = Number(process.env.STEP_MS ?? 220);
const PHASES_RAW = (process.env.DEMO_PHASE ?? "preflight,deploy,oracle,verify,queue,commit,summary,smoke").split(",");
const PHASES = new Set(PHASES_RAW.map((p) => p.trim().toLowerCase()));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEPLOYER = "0x39e67B9238B874f74233692454E2D04E9fC68363";

async function main() {
  const template = loadTemplate();
  const records = listDeployments();
  const byNet = Object.fromEntries(records.map((r) => [r.network, r.record]));

  const networks = template.deploymentGroups.testnet;

  banner(
    "STABLENAIRA DEPLOY CEREMONY  ::  DEMO MODE",
    `pure UI replay — no RPC, no gas, no wait  (countdown=${COUNTDOWN_SEC}s)`
  );

  /* ---------------- 0. PRE-FLIGHT ---------------- */
  if (PHASES.has("preflight")) {
    await sleep(400);
    header(`${EMOJI.scan} PHASE 0 / PRE-FLIGHT`);
    info(`Deployer`, DEPLOYER);
    await sleep(STEP_MS);
    ok(`BSC Testnet`, `0.817818099227869304 tBNB  block=105538103`);
    await sleep(STEP_MS);
    ok(`Ethereum Sepolia`, `0.594133471247714511 ETH  block=10791031`);
    await sleep(STEP_MS);
    ok(`Base Sepolia`, `0.015391877897881178 ETH  block=41083019`);
    await sleep(STEP_MS);
    console.log("");
    ok(`All targets funded — clear to deploy.`);
  }

  /* ---------------- 1. DEPLOY ---------------- */
  if (PHASES.has("deploy")) {
    for (const net of networks) {
      const rec = byNet[net];
      if (!rec) {
        warn(`No saved record for ${net} — skipping demo of this network.`);
        continue;
      }
      const spec = template.networks[net];

      banner(`PHASE 1 / DEPLOY STACK  ::  ${spec.label}`, `chainId=${spec.chainId}  domainId=${spec.domainId}`);
      await teleprint(green(`> Initializing transmission to ${spec.label}…`), 6);
      info(`Deployer`, `${DEPLOYER}  (balance: 0.81 native)`);

      header(`${EMOJI.rocket} StableNaira (UUPS proxy + impl + factory)`);
      await sleep(STEP_MS);
      ok(`StableNairaUUPSDeployer deployed`, rec.contracts.stableNairaDeployer!);
      await sleep(STEP_MS);
      ok(`StableNaira impl deployed`, rec.contracts.stableNairaImpl!);
      await sleep(STEP_MS);
      ok(`StableNaira proxy deployed (initialized atomically)`, rec.contracts.stableNaira!);

      header(`${EMOJI.shield} ValidatorRegistry (UUPS)`);
      await sleep(STEP_MS);
      ok(`ValidatorRegistry impl`, rec.contracts.validatorRegistryImpl!);
      await sleep(STEP_MS);
      ok(`ValidatorRegistry proxy`, rec.contracts.validatorRegistry!);
      info(`Validators set`, `1 member(s), threshold=1`);

      header(`${EMOJI.lock} MultisigVerifier`);
      await sleep(STEP_MS);
      ok(`MultisigVerifier deployed`, rec.contracts.verifier!);

      header(`${EMOJI.satellite} MessageTransmitter (UUPS)  domainId=${spec.domainId}`);
      await sleep(STEP_MS);
      ok(`MessageTransmitter impl`, rec.contracts.messageTransmitterImpl!);
      await sleep(STEP_MS);
      ok(`MessageTransmitter proxy`, rec.contracts.messageTransmitter!);

      header(`${EMOJI.link} TokenMessenger (UUPS)  bridge for SNR`);
      await sleep(STEP_MS);
      ok(`TokenMessenger impl`, rec.contracts.tokenMessengerImpl!);
      await sleep(STEP_MS);
      ok(`TokenMessenger proxy`, rec.contracts.tokenMessenger!);

      header(`${EMOJI.unlock} Granting MINTER_ROLE`);
      await sleep(STEP_MS);
      ok(`MINTER_ROLE granted`, `bridge ${rec.contracts.tokenMessenger} now allowed to mint+burnFrom on SNR`);
      await sleep(STEP_MS);
      ok(`Saved addresses`, `ignition/deployments/${net}/addresses.json`);
      rocket(`Deployment on ${spec.label} complete.`);
      await sleep(400);
    }
  }

  /* ---------------- 2. ORACLE ---------------- */
  if (PHASES.has("oracle")) {
    const bsc = byNet["testnet"];
    const oracle = bsc?.contracts.priceOracle;
    banner(`PHASE 2 / ORACLE  ::  StableNairaPriceOracle`, "BSC-only");
    header(`${EMOJI.oracle} StableNairaPriceOracle  on BSC Testnet`);
    await sleep(STEP_MS);
    ok(`StableNairaPriceOracle deployed`, oracle ?? "0xde95D3f64dd70A4c4448d6D24a8D1158A28250f6");
    ok(`Oracle address persisted`);
    await sleep(400);
  }

  /* ---------------- 3. VERIFY ---------------- */
  if (PHASES.has("verify")) {
    for (const net of networks) {
      const rec = byNet[net];
      if (!rec) continue;
      const spec = template.networks[net];
      banner(`PHASE 3 / VERIFY  ::  ${spec.label}`, "Etherscan V2 + Sourcify");
      header(`${EMOJI.scan} Verifying contracts on Etherscan-compatible explorer`);
      const tasks = [
        ["StableNairaUUPSDeployer (factory)", rec.contracts.stableNairaDeployer!],
        ["StableNaira (impl)", rec.contracts.stableNairaImpl!],
        ["ValidatorRegistry (impl)", rec.contracts.validatorRegistryImpl!],
        ["MessageTransmitter (impl)", rec.contracts.messageTransmitterImpl!],
        ["TokenMessenger (impl)", rec.contracts.tokenMessengerImpl!],
        ["MultisigVerifier", rec.contracts.verifier!],
      ];
      if (rec.contracts.priceOracle) tasks.push(["StableNairaPriceOracle", rec.contracts.priceOracle]);
      for (const [name, addr] of tasks) {
        action(`verifying ${name}`, addr);
        await sleep(180);
        ok(`${name} verified`);
        await sleep(60);
      }
      warn(
        `Proxies (ERC1967) are typically auto-detected by block explorers as proxies; if not, mark them manually as proxies on the explorer.`,
        `Stack: ${rec.contracts.stableNaira} / ${rec.contracts.validatorRegistry} / ${rec.contracts.messageTransmitter} / ${rec.contracts.tokenMessenger}`
      );
      await sleep(400);
    }
  }

  /* ---------------- 4. QUEUE ---------------- */
  if (PHASES.has("queue")) {
    let actionId = 1;
    for (const net of networks) {
      const rec = byNet[net];
      if (!rec) continue;
      const spec = template.networks[net];
      banner(`PHASE 4 / QUEUE WIRES  ::  ${spec.label}`, "Cross-chain remote routers (1-hour timelock starts now)");
      header(`${EMOJI.wave} Queueing remote routers on ${spec.label}`);
      for (const peer of spec.peers) {
        const peerSpec = template.networks[peer];
        const peerRec = byNet[peer];
        if (!peerSpec || !peerRec || !peerRec.contracts.tokenMessenger) continue;
        const peerBridge = peerRec.contracts.tokenMessenger;
        action(`queueSetRemoteRouter`, `domain=${peerSpec.domainId} → ${peerBridge}`);
        await sleep(STEP_MS);
        const eta = Math.floor(Date.now() / 1000) + 3600;
        ok(`queued`, `actionId=${actionId++}  eta=${new Date(eta * 1000).toISOString()}`);
        await sleep(STEP_MS);
      }
      info(`Persisted 2 queued route(s).`);
      rocket(`${spec.label}: queue phase complete.`);
      await sleep(400);
    }
  }

  /* ---------------- 5. COMMIT (with countdown) ---------------- */
  if (PHASES.has("commit")) {
    banner(`PHASE 5 / COMMIT WIRES`, `Holding for the timelock (demo: ${COUNTDOWN_SEC}s — real ceremony: 1h)`);
    await countdown(`Holding for timelock on BSC Testnet`, COUNTDOWN_SEC);
    for (const net of networks) {
      const rec = byNet[net];
      if (!rec) continue;
      const spec = template.networks[net];
      header(`${EMOJI.beacon} Committing remote routers on ${spec.label}`);
      for (const peer of spec.peers) {
        const peerSpec = template.networks[peer];
        const peerRec = byNet[peer];
        if (!peerSpec || !peerRec || !peerRec.contracts.tokenMessenger) continue;
        const peerBridge = peerRec.contracts.tokenMessenger;
        action(`commitSetRemoteRouter`, `domain=${peerSpec.domainId}`);
        await sleep(STEP_MS);
        ok(`committed`, `${peerSpec.domainId} → ${peerBridge.slice(0, 10)}…`);
        await sleep(120);
      }
      rocket(`${spec.label}: commit phase complete.`);
      await sleep(300);
    }
  }

  /* ---------------- 6. SUMMARY ---------------- */
  if (PHASES.has("summary")) {
    banner(`PHASE 6 / SUMMARY`, "Pretty-print address book");
    header(`${EMOJI.star} STABLENAIRA — DEPLOYED ADDRESS BOOK`);
    for (const net of networks) {
      const rec = byNet[net];
      if (!rec) continue;
      console.log("");
      console.log(magenta("┌── ") + bold(cyan(rec.label)) + magenta(` (${net}) ──`));
      console.log(magenta("│"));
      console.log(magenta("│  ") + gray(`chainId=${rec.chainId}  domainId=${rec.domainId}`));
      console.log(magenta("│  ") + gray(`deployer=${rec.deployer}`));
      console.log(magenta("│"));
      const line = (label: string, addr?: string) => {
        if (!addr) return;
        const link = `${rec.explorerUrl}/address/${addr}`;
        console.log(magenta("│  ") + cyan(label.padEnd(28)) + green(addr) + gray(`  ↗ ${link}`));
      };
      line("StableNaira (proxy)", rec.contracts.stableNaira);
      line("StableNaira (impl)", rec.contracts.stableNairaImpl);
      line("ValidatorRegistry (proxy)", rec.contracts.validatorRegistry);
      line("MultisigVerifier", rec.contracts.verifier);
      line("MessageTransmitter (proxy)", rec.contracts.messageTransmitter);
      line("TokenMessenger (proxy)", rec.contracts.tokenMessenger);
      line("StableNairaPriceOracle", rec.contracts.priceOracle);
      console.log(magenta("└" + "─".repeat(60)));
    }
    console.log("");
  }

  /* ---------------- 7. SMOKE (cross-chain) ---------------- */
  if (PHASES.has("smoke")) {
    const src = byNet["testnet"];
    const dst = byNet["sepolia"];
    if (!src || !dst) return;
    banner(
      "BONUS / CROSS-CHAIN SMOKE",
      `${template.networks.testnet.label} → ${template.networks.sepolia.label}  amount=100 SNR`
    );
    header(`${EMOJI.fire} Step 1: mint 100 SNR on ${template.networks.testnet.label}`);
    info(`pre-mint balance`, `0 SNR`);
    await sleep(STEP_MS);
    ok(`minted`, `tx=0xabc…123`);
    info(`post-mint balance`, `100 SNR`);

    header(`${EMOJI.warp} Step 2: depositForBurn → ${template.networks.sepolia.label}`);
    action(`depositForBurn`, `amount=100 dest=${template.networks.sepolia.domainId} recipient=…`);
    await sleep(STEP_MS);
    ok(`burned`, `tx=0xdef…456`);
    info(`envelope captured`, `148 bytes`);

    header(`${EMOJI.shield} Step 3: validator signs attestation digest`);
    info(`digest`, `0xc0ffee…beef`);
    await sleep(STEP_MS);
    ok(`signed`, `validator=${DEPLOYER}  sig=0xfeedface…cafebabe`);

    header(`${EMOJI.beacon} Step 4: receiveMessage on ${template.networks.sepolia.label}`);
    info(`pre-receive balance on dest`, `0 SNR`);
    await sleep(STEP_MS);
    ok(`received`, `tx=0x789…abc`);
    info(`post-receive balance on dest`, `100 SNR`);
    rocket(`Round-trip success.`, `Burned 100 on BSC Testnet, minted 100 on Sepolia.`);
    console.log("");
  }

  console.log(green("\n  ✦ Demo complete. Run with COUNTDOWN_SEC=3600 to feel the real ceremony cadence.\n"));
}

main().catch((e) => {
  fail("FATAL", e?.message ?? String(e));
  console.error(e);
  process.exitCode = 1;
});
