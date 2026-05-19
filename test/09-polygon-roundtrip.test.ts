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
 * stack carries StableNaira to/from Polygon with domain 80002.
 *
 * Polygon PoS is EVM-compatible, so there is no new VM port: the same
 * contracts deploy with `localDomain = chainId` (the live convention every
 * existing EVM chain uses). This test stands up two real stacks — Polygon
 * Amoy (80002) and Base Sepolia (84532) — and proves bidirectional
 * burn -> attest -> mint, attestation-digest destination binding, supply
 * conservation, and replay rejection, the same way 06-roundtrip does for the
 * abstract-domain pair.
 */

const DOMAIN_POLYGON_AMOY = 80_002; // == Polygon Amoy chainId
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

describe("Polygon <-> EVM cross-chain round-trip (domain 80002)", () => {
  // Shared validator set across both chains (mainnet hard-gate: identical set).
  const vWallet = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  );

  async function fixture() {
    const [owner, alice] = await ethers.getSigners();

    // ---- Polygon Amoy stack (domain 80002) ----
    const { stableNaira: snrPoly } = await deployStableNaira(owner.address, "StableNaira", "SNR");
    const { validatorRegistry: regPoly } = await deployValidatorRegistry(
      [vWallet.address],
      1n,
      owner.address
    );
    const { verifier: vPoly } = await deployMultisigVerifier(await regPoly.getAddress());
    const { messageTransmitter: tmPoly } = await deployMessageTransmitter(
      DOMAIN_POLYGON_AMOY,
      await vPoly.getAddress(),
      4096n,
      owner.address
    );
    const { tokenMessenger: bridgePoly } = await deployTokenMessenger(
      await tmPoly.getAddress(),
      await snrPoly.getAddress(),
      owner.address
    );
    await snrPoly.connect(owner).addMinter(await bridgePoly.getAddress());

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
    const polyBytes32 = addrToBytes32(await bridgePoly.getAddress());
    const baseBytes32 = addrToBytes32(await bridgeBase.getAddress());

    let tx = await bridgePoly
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_BASE_SEPOLIA, baseBytes32);
    let evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const polyActionId = evt.args.actionId as bigint;

    tx = await bridgeBase
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_POLYGON_AMOY, polyBytes32);
    evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const baseActionId = evt.args.actionId as bigint;

    await time.increase(3600 + 1);
    await bridgePoly.commitSetRemoteRouter(polyActionId, DOMAIN_BASE_SEPOLIA, baseBytes32);
    await bridgeBase.commitSetRemoteRouter(baseActionId, DOMAIN_POLYGON_AMOY, polyBytes32);

    return { owner, alice, snrPoly, snrBase, tmPoly, tmBase, bridgePoly, bridgeBase };
  }

  it("Polygon -> Base: burn 500 on 80002, mint 500 on 84532; replay blocked", async () => {
    const { owner, alice, snrPoly, snrBase, tmBase, bridgePoly } =
      await loadFixture(fixture);

    await snrPoly.connect(owner).mint(alice.address, 1000n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgePoly
        .connect(alice)
        .depositForBurn(500n, DOMAIN_BASE_SEPOLIA, recipient, await snrPoly.getAddress())
    ).wait();
    expect(await snrPoly.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmBase);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmBase.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmBase.receiveMessage(envelope, attestation);

    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);
    expect(await snrPoly.totalSupply()).to.equal(500n); // burned
    expect(await snrBase.totalSupply()).to.equal(500n); // minted

    await expect(
      tmBase.receiveMessage(envelope, attestation)
    ).to.be.revertedWithCustomError(tmBase, "NonceAlreadyUsed");
  });

  it("Base -> Polygon: burn 300 on 84532, mint 300 on 80002 (reverse direction)", async () => {
    const { owner, alice, snrPoly, snrBase, tmPoly, bridgeBase } =
      await loadFixture(fixture);

    await snrBase.connect(owner).mint(alice.address, 800n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeBase
        .connect(alice)
        .depositForBurn(300n, DOMAIN_POLYGON_AMOY, recipient, await snrBase.getAddress())
    ).wait();
    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmPoly);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmPoly.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmPoly.receiveMessage(envelope, attestation);

    expect(await snrPoly.balanceOf(alice.address)).to.equal(300n);
    expect(await snrBase.totalSupply()).to.equal(500n); // burned 300 of 800
    expect(await snrPoly.totalSupply()).to.equal(300n); // minted on Polygon
  });

  it("attestation bound to the wrong destination transmitter is rejected", async () => {
    const { owner, alice, snrPoly, tmPoly, tmBase, bridgePoly } = await loadFixture(fixture);
    await snrPoly.connect(owner).mint(alice.address, 100n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgePoly
        .connect(alice)
        .depositForBurn(50n, DOMAIN_BASE_SEPOLIA, recipient, await snrPoly.getAddress())
    ).wait();
    const envelope = envelopeFrom(receipt, tmBase);

    // Sign for the SOURCE transmitter (Polygon) instead of the destination
    // (Base). Digest is destination-scoped, so the recovered signer is wrong.
    const { chainId } = await ethers.provider.getNetwork();
    const wrongDigest = attestationDigest(envelope, chainId, await tmPoly.getAddress());
    const attestation = vWallet.signingKey.sign(wrongDigest).serialized;

    await expect(tmBase.receiveMessage(envelope, attestation)).to.be.reverted;
  });
});
