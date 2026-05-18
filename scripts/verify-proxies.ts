/* eslint-disable no-console */
import "dotenv/config";

import hre from "hardhat";
import { ethers } from "hardhat";

import { loadTemplate } from "./lib/params";
import { readDeployment } from "./lib/persistence";

const PROXY_FQN = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

async function verify(label: string, address: string, args: any[]) {
  console.log(`\n→ verifying ${label} @ ${address}`);
  try {
    await hre.run("verify:verify", {
      address,
      contract: PROXY_FQN,
      constructorArguments: args,
    });
    console.log(`  ✓ ${label} verified`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/already verified/i.test(msg)) {
      console.log(`  ✓ ${label} already verified`);
    } else {
      console.log(`  ✗ ${label} failed: ${msg.split("\n")[0]}`);
    }
  }
}

async function main() {
  const networkName = hre.network.name;
  const template = loadTemplate();
  const rec = readDeployment(networkName);
  if (!rec) throw new Error(`No deployment for ${networkName}`);

  const owner = template.common.owner;
  const admin = template.common.admin;
  const c = rec.contracts;

  console.log(`== Verifying ERC1967 proxies on ${rec.label} (${networkName}) ==`);

  // StableNaira proxy
  if (c.stableNaira && c.stableNairaImpl) {
    const sn = await ethers.getContractFactory("StableNaira");
    const initData = sn.interface.encodeFunctionData("initialize", [
      template.common.token.name,
      template.common.token.symbol,
      admin,
    ]);
    await verify("StableNaira (proxy)", c.stableNaira, [c.stableNairaImpl, initData]);
  }

  // ValidatorRegistry proxy
  if (c.validatorRegistry && c.validatorRegistryImpl) {
    const vr = await ethers.getContractFactory("ValidatorRegistry");
    const initData = vr.interface.encodeFunctionData("initialize", [
      template.common.validatorRegistry.validators,
      template.common.validatorRegistry.threshold,
      owner,
      template.common.validatorRegistry.initialTimelock,
      template.common.validatorRegistry.initialMinTimelock,
    ]);
    await verify("ValidatorRegistry (proxy)", c.validatorRegistry, [c.validatorRegistryImpl, initData]);
  }

  // MessageTransmitter proxy
  if (c.messageTransmitter && c.messageTransmitterImpl) {
    const mt = await ethers.getContractFactory("MessageTransmitter");
    const initData = mt.interface.encodeFunctionData("initialize", [
      rec.domainId,
      c.verifier,
      template.common.messageTransmitter.maxMessageBodySize,
      owner,
      template.common.messageTransmitter.initialTimelock,
      template.common.messageTransmitter.initialMinTimelock,
    ]);
    await verify("MessageTransmitter (proxy)", c.messageTransmitter, [c.messageTransmitterImpl, initData]);
  }

  // TokenMessenger proxy
  if (c.tokenMessenger && c.tokenMessengerImpl) {
    const tm = await ethers.getContractFactory("TokenMessenger");
    const initData = tm.interface.encodeFunctionData("initialize", [
      c.messageTransmitter,
      c.stableNaira,
      owner,
      template.common.tokenMessenger.initialTimelock,
      template.common.tokenMessenger.initialMinTimelock,
    ]);
    await verify("TokenMessenger (proxy)", c.tokenMessenger, [c.tokenMessengerImpl, initData]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
