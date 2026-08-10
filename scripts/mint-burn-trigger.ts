/* eslint-disable no-console */
/**
 * Emit one mint and one burn on the StableNaira proxy so block explorers
 * classify it as an ERC20 and surface the Token Tracker page. The two ERC20
 * Transfer events (mint from 0x0, burn to 0x0) are what the explorers key on;
 * totalSupply returns to 0 at the end.
 *
 * Treasury minting is timelocked, so this runs in two passes:
 *   pass 1  queues the mint and prints the actionId + eta, then exits.
 *   pass 2  (re-run after the eta) commits it and self-burns.
 *
 * Pass the queued id explicitly with ACTION_ID=<n> if you have it; otherwise
 * the script re-reads it from the pending-action state.
 */
import "dotenv/config";

import hre from "hardhat";
import { ethers } from "hardhat";

import { readDeployment } from "./lib/persistence";

async function main() {
  const networkName = hre.network.name;
  const rec = readDeployment(networkName);
  if (!rec) throw new Error(`No deployment for ${networkName}`);

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const proxy = rec.contracts.stableNaira!;
  const stable = (await ethers.getContractAt("StableNaira", proxy, signer)) as any;

  console.log(`net=${networkName}  proxy=${proxy}  signer=${me}`);

  const minterRole = await stable.MINTER_ROLE();
  if (!(await stable.hasRole(minterRole, me))) {
    throw new Error(`signer ${me} lacks MINTER_ROLE on ${proxy}`);
  }
  const adminRole = await stable.DEFAULT_ADMIN_ROLE();
  if (!(await stable.hasRole(adminRole, me))) {
    throw new Error(`signer ${me} lacks DEFAULT_ADMIN_ROLE (needed to commit) on ${proxy}`);
  }

  const before = await stable.balanceOf(me);
  const supplyBefore = await stable.totalSupply();
  console.log(`  balance before = ${before}, totalSupply before = ${supplyBefore}`);

  const envId = process.env.ACTION_ID;

  if (!envId) {
    console.log(`  → queueMint(1) to self`);
    const tx = await stable.queueMint(me, 1n);
    const r = await tx.wait();
    const evt = r!.logs.find((l: any) => l.fragment?.name === "MintQueued") as any;
    const actionId = evt.args.actionId.toString();
    const pending = await stable.pendingAction(actionId);
    const eta = Number(pending.eta);
    console.log(`    tx: ${r!.hash}  actionId=${actionId}`);
    console.log(`    committable at ${new Date(eta * 1000).toISOString()}`);
    console.log(`    re-run with:  ACTION_ID=${actionId} npx hardhat run scripts/mint-burn-trigger.ts --network ${networkName}`);
    return;
  }

  const pending = await stable.pendingAction(envId);
  if (Number(pending.eta) === 0) {
    throw new Error(`action ${envId} not found — it was committed, cancelled, or never queued`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(pending.eta)) {
    throw new Error(
      `action ${envId} not ready — eta ${new Date(Number(pending.eta) * 1000).toISOString()}`
    );
  }

  console.log(`  → commitMint(${envId}, self, 1)`);
  let tx = await stable.commitMint(envId, me, 1n);
  let r = await tx.wait();
  console.log(`    tx: ${r!.hash}  gasUsed=${r!.gasUsed}`);

  // Self-burn needs no role and no allowance.
  console.log(`  → burn(1) from self`);
  tx = await stable.burn(1n);
  r = await tx.wait();
  console.log(`    tx: ${r!.hash}  gasUsed=${r!.gasUsed}`);

  const after = await stable.balanceOf(me);
  const supplyAfter = await stable.totalSupply();
  console.log(`  balance after = ${after}, totalSupply after = ${supplyAfter}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
