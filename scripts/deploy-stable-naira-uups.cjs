/**
 * Ethers deployment with explicit gas limits — avoids Ignition when public RPCs
 * return inconsistent eth_estimateGas vs eth_call (internal invariant error).
 */
const hre = require("hardhat");

const MIN_BNB_WEI = hre.ethers.parseEther("0.001");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer", deployer.address);
  console.log("Balance   ", hre.ethers.formatEther(bal), "BNB");
  if (bal < MIN_BNB_WEI) {
    throw new Error(
      "Deployer balance is very low. Fund it with testnet BNB — insufficient funds " +
        "often makes eth_estimateGas fail while eth_call still succeeds, which breaks Hardhat Ignition."
    );
  }

  const Factory = await hre.ethers.getContractFactory("StableNairaUUPSDeployer");
  const factory = await Factory.deploy({ gasLimit: 5_000_000n });
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("StableNairaUUPSDeployer", factoryAddr);

  const tx = await factory.deploy("StableNaira", "SNR", deployer.address, {
    gasLimit: 15_000_000n,
  });
  const receipt = await tx.wait();
  console.log("deploy() tx", receipt.hash);

  const ev = await factory.queryFilter(factory.filters.Deployed(), receipt.blockNumber, receipt.blockNumber);
  if (ev.length === 0) {
    throw new Error("Deployed event not found in receipt block");
  }
  const { implementation, proxy } = ev[ev.length - 1].args;
  console.log("implementation", implementation);
  console.log("proxy (token address)", proxy);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
