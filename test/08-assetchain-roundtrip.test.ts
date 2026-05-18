import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployStableNaira,
  deployTokenMessenger,
  deployMessageTransmitter,
  deployValidatorRegistry,
  deployMultisigVerifier,
} from "./helpers/fixtures";

/**
 * Phase 2 gate — deterministic, in-process proof that the existing EVM CCTP
 * stack carries StableNaira to/from Asset Chain with domain 42421.
 *
 * Asset Chain is EVM-compatible, so there is no new VM port: the same
 * contracts deploy with `localDomain = chainId` (the live convention every
 * existing EVM chain uses). This test stands up two real stacks — Asset Chain
 * (42421) and Base Sepolia (84532) — and proves bidirectional
 * burn -> attest -> mint, attestation-digest destination binding, supply
 * conservation, and replay rejection, the same way 06-roundtrip does for the
 * abstract-domain pair.
 */

const DOMAIN_ASSETCHAIN = 42_421; // == Asset Chain Testnet chainId
const DOMAIN_BASE_SEPOLIA = 84_532; // an existing EVM testnet peer

function addrToBytes32(addr: string): string {
  return ethers.zeroPadValue(ethers.getAddress(addr), 32);
}

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

function envelopeFrom(receipt: any, tm: any): string {
  const iface = tm.interface;
  const parsed = receipt!.logs
    .map((l: any) => {
      try {
        return iface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p && p.name === "MessageSent");
  return (parsed as any).args.message as string;
}

describe("Asset Chain <-> EVM cross-chain round-trip (domain 42421)", () => {
  // Shared validator set across both chains (mainnet hard-gate: identical set).
  const vWallet = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  );

  async function fixture() {
    const [owner, alice] = await ethers.getSigners();

    // ---- Asset Chain stack (domain 42421) ----
    const { stableNaira: snrAC } = await deployStableNaira(owner.address, "StableNaira", "SNR");
    const { validatorRegistry: regAC } = await deployValidatorRegistry(
      [vWallet.address],
      1n,
      owner.address
    );
    const { verifier: vAC } = await deployMultisigVerifier(await regAC.getAddress());
    const { messageTransmitter: tmAC } = await deployMessageTransmitter(
      DOMAIN_ASSETCHAIN,
      await vAC.getAddress(),
      4096n,
      owner.address
    );
    const { tokenMessenger: bridgeAC } = await deployTokenMessenger(
      await tmAC.getAddress(),
      await snrAC.getAddress(),
      owner.address
    );
    await snrAC.connect(owner).addMinter(await bridgeAC.getAddress());

    // ---- Base Sepolia stack (domain 84532) ----
    const { stableNaira: snrBase } = await deployStableNaira(owner.address, "StableNaira", "SNR");
    const { validatorRegistry: regBase } = await deployValidatorRegistry(
      [vWallet.address],
      1n,
      owner.address
    );
    const { verifier: vBase } = await deployMultisigVerifier(await regBase.getAddress());
    const { messageTransmitter: tmBase } = await deployMessageTransmitter(
      DOMAIN_BASE_SEPOLIA,
      await vBase.getAddress(),
      4096n,
      owner.address
    );
    const { tokenMessenger: bridgeBase } = await deployTokenMessenger(
      await tmBase.getAddress(),
      await snrBase.getAddress(),
      owner.address
    );
    await snrBase.connect(owner).addMinter(await bridgeBase.getAddress());

    // ---- Cross-register remote routers (queue + timelock + commit) ----
    const acBytes32 = addrToBytes32(await bridgeAC.getAddress());
    const baseBytes32 = addrToBytes32(await bridgeBase.getAddress());

    let tx = await bridgeAC
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_BASE_SEPOLIA, baseBytes32);
    let evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const acActionId = evt.args.actionId as bigint;

    tx = await bridgeBase
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_ASSETCHAIN, acBytes32);
    evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const baseActionId = evt.args.actionId as bigint;

    await time.increase(3600 + 1);
    await bridgeAC.commitSetRemoteRouter(acActionId, DOMAIN_BASE_SEPOLIA, baseBytes32);
    await bridgeBase.commitSetRemoteRouter(baseActionId, DOMAIN_ASSETCHAIN, acBytes32);

    return { owner, alice, snrAC, snrBase, tmAC, tmBase, bridgeAC, bridgeBase };
  }

  it("Asset Chain -> Base: burn 500 on 42421, mint 500 on 84532; replay blocked", async () => {
    const { owner, alice, snrAC, snrBase, tmBase, bridgeAC } =
      await loadFixture(fixture);

    await snrAC.connect(owner).mint(alice.address, 1000n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeAC
        .connect(alice)
        .depositForBurn(500n, DOMAIN_BASE_SEPOLIA, recipient, await snrAC.getAddress())
    ).wait();
    expect(await snrAC.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmBase);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmBase.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmBase.receiveMessage(envelope, attestation);

    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);
    expect(await snrAC.totalSupply()).to.equal(500n); // burned
    expect(await snrBase.totalSupply()).to.equal(500n); // minted

    await expect(
      tmBase.receiveMessage(envelope, attestation)
    ).to.be.revertedWithCustomError(tmBase, "NonceAlreadyUsed");
  });

  it("Base -> Asset Chain: burn 300 on 84532, mint 300 on 42421 (reverse direction)", async () => {
    const { owner, alice, snrAC, snrBase, tmAC, bridgeBase } =
      await loadFixture(fixture);

    await snrBase.connect(owner).mint(alice.address, 800n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeBase
        .connect(alice)
        .depositForBurn(300n, DOMAIN_ASSETCHAIN, recipient, await snrBase.getAddress())
    ).wait();
    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmAC);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmAC.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmAC.receiveMessage(envelope, attestation);

    expect(await snrAC.balanceOf(alice.address)).to.equal(300n);
    expect(await snrBase.totalSupply()).to.equal(500n); // burned 300 of 800
    expect(await snrAC.totalSupply()).to.equal(300n); // minted on Asset Chain
  });

  it("attestation bound to the wrong destination transmitter is rejected", async () => {
    const { owner, alice, snrAC, tmAC, tmBase, bridgeAC } = await loadFixture(fixture);
    await snrAC.connect(owner).mint(alice.address, 100n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeAC
        .connect(alice)
        .depositForBurn(50n, DOMAIN_BASE_SEPOLIA, recipient, await snrAC.getAddress())
    ).wait();
    const envelope = envelopeFrom(receipt, tmBase);

    // Sign for the SOURCE transmitter (Asset Chain) instead of the destination
    // (Base). Digest is destination-scoped, so the recovered signer is wrong.
    const { chainId } = await ethers.provider.getNetwork();
    const wrongDigest = attestationDigest(envelope, chainId, await tmAC.getAddress());
    const attestation = vWallet.signingKey.sign(wrongDigest).serialized;

    await expect(tmBase.receiveMessage(envelope, attestation)).to.be.reverted;
  });
});
