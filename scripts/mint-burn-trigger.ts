/* eslint-disable no-console */
/**
 * Mint 1 unit then burnFrom(self, 1) on the StableNaira proxy. The two ERC20
 * Transfer events (mint from 0x0, burn to 0x0) cause BscScan / BaseScan to
 * classify the contract as an ERC20 and surface the Token Tracker page.
 * totalSupply returns to 0 at end.
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
  const stable = await ethers.getContractAt("StableNaira", proxy, signer);

  console.log(`net=${networkName}  proxy=${proxy}  signer=${me}`);

  const minterRole = await (stable as any).MINTER_ROLE();
  const hasMinter = await (stable as any).hasRole(minterRole, me);
  if (!hasMinter) throw new Error(`signer ${me} lacks MINTER_ROLE on ${proxy}`);

  const before = await (stable as any).balanceOf(me);
  const supplyBefore = await (stable as any).totalSupply();
  console.log(`  balance before = ${before}, totalSupply before = ${supplyBefore}`);

  console.log(`  → mint(1) to self`);
  let tx = await (stable as any).mint(me, 1n);
  let r = await tx.wait();
  console.log(`    tx: ${r!.hash}  gasUsed=${r!.gasUsed}`);

  console.log(`  → burnFrom(self, 1)`);
  tx = await (stable as any).burnFrom(me, 1n);
  r = await tx.wait();
  console.log(`    tx: ${r!.hash}  gasUsed=${r!.gasUsed}`);

  const after = await (stable as any).balanceOf(me);
  const supplyAfter = await (stable as any).totalSupply();
  console.log(`  balance after = ${after}, totalSupply after = ${supplyAfter}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
