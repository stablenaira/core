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
 * stack carries StableNaira to/from Arbitrum with domain 421614.
 *
 * Arbitrum (Nitro L2) is EVM-compatible, so there is no new VM port: the
 * same contracts deploy with `localDomain = chainId` (the live convention
 * every existing EVM chain uses). This test stands up two real stacks —
 * Arbitrum Sepolia (421614) and Base Sepolia (84532) — and proves
 * bidirectional burn -> attest -> mint, attestation-digest destination
 * binding, supply conservation, and replay rejection, the same way
 * 06-roundtrip does for the abstract-domain pair.
 */

const DOMAIN_ARBITRUM_SEPOLIA = 421_614; // == Arbitrum Sepolia chainId
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

describe("Arbitrum <-> EVM cross-chain round-trip (domain 421614)", () => {
  // Shared validator set across both chains (mainnet hard-gate: identical set).
  const vWallet = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  );

  async function fixture() {
    const [owner, alice] = await ethers.getSigners();

    // ---- Arbitrum Sepolia stack (domain 421614) ----
    const { stableNaira: snrArb } = await deployStableNaira(owner.address, "StableNaira", "SNR");
    const { validatorRegistry: regArb } = await deployValidatorRegistry(
      [vWallet.address],
      1n,
      owner.address
    );
    const { verifier: vArb } = await deployMultisigVerifier(await regArb.getAddress());
    const { messageTransmitter: tmArb } = await deployMessageTransmitter(
      DOMAIN_ARBITRUM_SEPOLIA,
      await vArb.getAddress(),
      4096n,
      owner.address
    );
    const { tokenMessenger: bridgeArb } = await deployTokenMessenger(
      await tmArb.getAddress(),
      await snrArb.getAddress(),
      owner.address
    );
    await snrArb.connect(owner).addMinter(await bridgeArb.getAddress());

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
    const arbBytes32 = addrToBytes32(await bridgeArb.getAddress());
    const baseBytes32 = addrToBytes32(await bridgeBase.getAddress());

    let tx = await bridgeArb
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_BASE_SEPOLIA, baseBytes32);
    let evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const arbActionId = evt.args.actionId as bigint;

    tx = await bridgeBase
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_ARBITRUM_SEPOLIA, arbBytes32);
    evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const baseActionId = evt.args.actionId as bigint;

    await time.increase(3600 + 1);
    await bridgeArb.commitSetRemoteRouter(arbActionId, DOMAIN_BASE_SEPOLIA, baseBytes32);
    await bridgeBase.commitSetRemoteRouter(baseActionId, DOMAIN_ARBITRUM_SEPOLIA, arbBytes32);

    return { owner, alice, snrArb, snrBase, tmArb, tmBase, bridgeArb, bridgeBase };
  }

  it("Arbitrum -> Base: burn 500 on 421614, mint 500 on 84532; replay blocked", async () => {
    const { owner, alice, snrArb, snrBase, tmBase, bridgeArb } =
      await loadFixture(fixture);

    await snrArb.connect(owner).mint(alice.address, 1000n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeArb
        .connect(alice)
        .depositForBurn(500n, DOMAIN_BASE_SEPOLIA, recipient, await snrArb.getAddress())
    ).wait();
    expect(await snrArb.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmBase);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmBase.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmBase.receiveMessage(envelope, attestation);

    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);
    expect(await snrArb.totalSupply()).to.equal(500n); // burned
    expect(await snrBase.totalSupply()).to.equal(500n); // minted

    await expect(
      tmBase.receiveMessage(envelope, attestation)
    ).to.be.revertedWithCustomError(tmBase, "NonceAlreadyUsed");
  });

  it("Base -> Arbitrum: burn 300 on 84532, mint 300 on 421614 (reverse direction)", async () => {
    const { owner, alice, snrArb, snrBase, tmArb, bridgeBase } =
      await loadFixture(fixture);

    await snrBase.connect(owner).mint(alice.address, 800n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeBase
        .connect(alice)
        .depositForBurn(300n, DOMAIN_ARBITRUM_SEPOLIA, recipient, await snrBase.getAddress())
    ).wait();
    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmArb);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmArb.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmArb.receiveMessage(envelope, attestation);

    expect(await snrArb.balanceOf(alice.address)).to.equal(300n);
    expect(await snrBase.totalSupply()).to.equal(500n); // burned 300 of 800
    expect(await snrArb.totalSupply()).to.equal(300n); // minted on Arbitrum
  });

  it("attestation bound to the wrong destination transmitter is rejected", async () => {
    const { owner, alice, snrArb, tmArb, tmBase, bridgeArb } = await loadFixture(fixture);
    await snrArb.connect(owner).mint(alice.address, 100n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeArb
        .connect(alice)
        .depositForBurn(50n, DOMAIN_BASE_SEPOLIA, recipient, await snrArb.getAddress())
    ).wait();
    const envelope = envelopeFrom(receipt, tmBase);

    // Sign for the SOURCE transmitter (Arbitrum) instead of the destination
    // (Base). Digest is destination-scoped, so the recovered signer is wrong.
    const { chainId } = await ethers.provider.getNetwork();
    const wrongDigest = attestationDigest(envelope, chainId, await tmArb.getAddress());
    const attestation = vWallet.signingKey.sign(wrongDigest).serialized;

    await expect(tmBase.receiveMessage(envelope, attestation)).to.be.reverted;
  });
});
