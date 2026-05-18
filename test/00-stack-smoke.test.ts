import { expect } from "chai";
import hre from "hardhat";
import { ethers } from "hardhat";

import StableNairaStackModule from "../ignition/modules/StableNairaStack";

/**
 * Smoke test: deploys the entire StableNaira CCTP stack to the local
 * hardhat network via Ignition with sensible defaults, then asserts the
 * cross-contract wiring is correct. Anything richer lives in the
 * dedicated per-contract spec files.
 */
describe("StableNairaStack [smoke]", () => {
  it("deploys the full stack and wires cross-contract references", async () => {
    const [deployer] = await ethers.getSigners();
    const owner = deployer.address;

    const parameters = {
      StableNaira: {
        tokenName: "StableNaira",
        tokenSymbol: "SNR",
        admin: owner,
      },
      ValidatorRegistry: {
        validators: [owner],
        threshold: 1n,
        owner,
        initialTimelock: 0n,
        initialMinTimelock: 0n,
      },
      MessageTransmitter: {
        localDomain: 97n,
        maxMessageBodySize: 4096n,
        owner,
        initialTimelock: 0n,
        initialMinTimelock: 0n,
      },
      TokenMessenger: {
        owner,
        initialTimelock: 0n,
        initialMinTimelock: 0n,
      },
    };

    const { stableNaira, tokenMessenger, messageTransmitter, verifier, validatorRegistry } =
      await hre.ignition.deploy(StableNairaStackModule, { parameters });

    const tokenAddr = await stableNaira.getAddress();
    const tmAddr = await tokenMessenger.getAddress();
    const mtAddr = await messageTransmitter.getAddress();
    const vAddr = await verifier.getAddress();
    const vrAddr = await validatorRegistry.getAddress();

    expect(tokenAddr).to.match(/^0x/);
    expect(await stableNaira.name()).to.equal("StableNaira");
    expect(await stableNaira.symbol()).to.equal("SNR");
    expect(await stableNaira.decimals()).to.equal(2);
    expect(await stableNaira.owner()).to.equal(owner);

    expect(await tokenMessenger.localToken()).to.equal(tokenAddr);
    expect(await tokenMessenger.messageTransmitter()).to.equal(mtAddr);
    expect(await tokenMessenger.owner()).to.equal(owner);

    expect(await messageTransmitter.localDomain()).to.equal(97n);
    expect(await messageTransmitter.signatureVerifier()).to.equal(vAddr);
    expect(await messageTransmitter.maxMessageBodySize()).to.equal(4096n);
    expect(await messageTransmitter.owner()).to.equal(owner);

    expect(await verifier.registry()).to.equal(vrAddr);

    expect(await validatorRegistry.threshold()).to.equal(1n);
    expect(await validatorRegistry.isValidator(owner)).to.equal(true);
    expect(await validatorRegistry.owner()).to.equal(owner);
  });
});
