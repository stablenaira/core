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
 * stack carries StableNaira to/from Optimism with domain 11155420.
 *
 * Optimism (OP Stack L2) is EVM-compatible, so there is no new VM port: the
 * same contracts deploy with `localDomain = chainId` (the live convention
 * every existing EVM chain uses). This test stands up two real stacks —
 * Optimism Sepolia (11155420) and Base Sepolia (84532) — and proves
 * bidirectional burn -> attest -> mint, attestation-digest destination
 * binding, supply conservation, and replay rejection, the same way
 * 06-roundtrip does for the abstract-domain pair.
 */

const DOMAIN_OPTIMISM_SEPOLIA = 11_155_420; // == Optimism Sepolia chainId
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

describe("Optimism <-> EVM cross-chain round-trip (domain 11155420)", () => {
  // Shared validator set across both chains (mainnet hard-gate: identical set).
  const vWallet = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  );

  async function fixture() {
    const [owner, alice] = await ethers.getSigners();

    // ---- Optimism Sepolia stack (domain 11155420) ----
    const { stableNaira: snrOp } = await deployStableNaira(owner.address, "StableNaira", "SNR");
    const { validatorRegistry: regOp } = await deployValidatorRegistry(
      [vWallet.address],
      1n,
      owner.address
    );
    const { verifier: vOp } = await deployMultisigVerifier(await regOp.getAddress());
    const { messageTransmitter: tmOp } = await deployMessageTransmitter(
      DOMAIN_OPTIMISM_SEPOLIA,
      await vOp.getAddress(),
      4096n,
      owner.address
    );
    const { tokenMessenger: bridgeOp } = await deployTokenMessenger(
      await tmOp.getAddress(),
      await snrOp.getAddress(),
      owner.address
    );
    await snrOp.connect(owner).addMinter(await bridgeOp.getAddress());

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
    const opBytes32 = addrToBytes32(await bridgeOp.getAddress());
    const baseBytes32 = addrToBytes32(await bridgeBase.getAddress());

    let tx = await bridgeOp
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_BASE_SEPOLIA, baseBytes32);
    let evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const opActionId = evt.args.actionId as bigint;

    tx = await bridgeBase
      .connect(owner)
      .queueSetRemoteRouter(DOMAIN_OPTIMISM_SEPOLIA, opBytes32);
    evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const baseActionId = evt.args.actionId as bigint;

    await time.increase(3600 + 1);
    await bridgeOp.commitSetRemoteRouter(opActionId, DOMAIN_BASE_SEPOLIA, baseBytes32);
    await bridgeBase.commitSetRemoteRouter(baseActionId, DOMAIN_OPTIMISM_SEPOLIA, opBytes32);

    return { owner, alice, snrOp, snrBase, tmOp, tmBase, bridgeOp, bridgeBase };
  }

  it("Optimism -> Base: burn 500 on 11155420, mint 500 on 84532; replay blocked", async () => {
    const { owner, alice, snrOp, snrBase, tmBase, bridgeOp } =
      await loadFixture(fixture);

    await snrOp.connect(owner).mint(alice.address, 1000n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeOp
        .connect(alice)
        .depositForBurn(500n, DOMAIN_BASE_SEPOLIA, recipient, await snrOp.getAddress())
    ).wait();
    expect(await snrOp.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmBase);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmBase.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmBase.receiveMessage(envelope, attestation);

    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);
    expect(await snrOp.totalSupply()).to.equal(500n); // burned
    expect(await snrBase.totalSupply()).to.equal(500n); // minted

    await expect(
      tmBase.receiveMessage(envelope, attestation)
    ).to.be.revertedWithCustomError(tmBase, "NonceAlreadyUsed");
  });

  it("Base -> Optimism: burn 300 on 84532, mint 300 on 11155420 (reverse direction)", async () => {
    const { owner, alice, snrOp, snrBase, tmOp, bridgeBase } =
      await loadFixture(fixture);

    await snrBase.connect(owner).mint(alice.address, 800n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeBase
        .connect(alice)
        .depositForBurn(300n, DOMAIN_OPTIMISM_SEPOLIA, recipient, await snrBase.getAddress())
    ).wait();
    expect(await snrBase.balanceOf(alice.address)).to.equal(500n);

    const envelope = envelopeFrom(receipt, tmOp);
    const { chainId } = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, chainId, await tmOp.getAddress());
    const attestation = vWallet.signingKey.sign(digest).serialized;

    await tmOp.receiveMessage(envelope, attestation);

    expect(await snrOp.balanceOf(alice.address)).to.equal(300n);
    expect(await snrBase.totalSupply()).to.equal(500n); // burned 300 of 800
    expect(await snrOp.totalSupply()).to.equal(300n); // minted on Optimism
  });

  it("attestation bound to the wrong destination transmitter is rejected", async () => {
    const { owner, alice, snrOp, tmOp, tmBase, bridgeOp } = await loadFixture(fixture);
    await snrOp.connect(owner).mint(alice.address, 100n);
    const recipient = addrToBytes32(alice.address);

    const receipt = await (
      await bridgeOp
        .connect(alice)
        .depositForBurn(50n, DOMAIN_BASE_SEPOLIA, recipient, await snrOp.getAddress())
    ).wait();
    const envelope = envelopeFrom(receipt, tmBase);

    // Sign for the SOURCE transmitter (Optimism) instead of the destination
    // (Base). Digest is destination-scoped, so the recovered signer is wrong.
    const { chainId } = await ethers.provider.getNetwork();
    const wrongDigest = attestationDigest(envelope, chainId, await tmOp.getAddress());
    const attestation = vWallet.signingKey.sign(wrongDigest).serialized;

    await expect(tmBase.receiveMessage(envelope, attestation)).to.be.reverted;
  });
});
