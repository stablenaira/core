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

const BYTES32_ZERO = "0x" + "00".repeat(32);

const ENVELOPE_VERSION = 1;
const DOMAIN_A = 100;
const DOMAIN_B = 200;

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

describe("Cross-chain round-trip", () => {
  // Validator wallet (chain A and B share validator set in this test).
  const vWallet = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  );

  async function fixture() {
    const [owner, alice] = await ethers.getSigners();

    // ---- Chain A stack ----
    const { stableNaira: tokenA } = await deployStableNaira(owner.address, "TokenA", "TA");
    const { validatorRegistry: regA } = await deployValidatorRegistry(
      [vWallet.address],
      1n,
      owner.address
    );
    const { verifier: vA } = await deployMultisigVerifier(await regA.getAddress());
    const { messageTransmitter: tmA } = await deployMessageTransmitter(
      DOMAIN_A,
      await vA.getAddress(),
      4096n,
      owner.address
    );
    const { tokenMessenger: bridgeA } = await deployTokenMessenger(
      await tmA.getAddress(),
      await tokenA.getAddress(),
      owner.address
    );
    await tokenA.connect(owner).addMinter(await bridgeA.getAddress());

    // ---- Chain B stack ----
    const { stableNaira: tokenB } = await deployStableNaira(owner.address, "TokenB", "TB");
    const { validatorRegistry: regB } = await deployValidatorRegistry(
      [vWallet.address],
      1n,
      owner.address
    );
    const { verifier: vB } = await deployMultisigVerifier(await regB.getAddress());
    const { messageTransmitter: tmB } = await deployMessageTransmitter(
      DOMAIN_B,
      await vB.getAddress(),
      4096n,
      owner.address
    );
    const { tokenMessenger: bridgeB } = await deployTokenMessenger(
      await tmB.getAddress(),
      await tokenB.getAddress(),
      owner.address
    );
    await tokenB.connect(owner).addMinter(await bridgeB.getAddress());

    // ---- Wire remote routers (queue + commit each side) ----
    const bridgeBBytes32 = addrToBytes32(await bridgeB.getAddress());
    const bridgeABytes32 = addrToBytes32(await bridgeA.getAddress());

    let tx = await bridgeA.connect(owner).queueSetRemoteRouter(DOMAIN_B, bridgeBBytes32);
    let evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const aActionId = evt.args.actionId as bigint;

    tx = await bridgeB.connect(owner).queueSetRemoteRouter(DOMAIN_A, bridgeABytes32);
    evt = (await tx.wait())!.logs.find(
      (l: any) => l.fragment?.name === "RemoteRouterChangeQueued"
    ) as any;
    const bActionId = evt.args.actionId as bigint;

    await time.increase(3600 + 1);
    await bridgeA.commitSetRemoteRouter(aActionId, DOMAIN_B, bridgeBBytes32);
    await bridgeB.commitSetRemoteRouter(bActionId, DOMAIN_A, bridgeABytes32);

    return {
      owner,
      alice,
      tokenA,
      tokenB,
      tmA,
      tmB,
      bridgeA,
      bridgeB,
    };
  }

  it("alice burns 500 on A, receives 500 on B", async () => {
    const { owner, alice, tokenA, tokenB, tmA, tmB, bridgeA, bridgeB } = await loadFixture(fixture);

    // Mint 1000 to alice on chain A.
    await tokenA.connect(owner).mint(alice.address, 1000n);
    expect(await tokenA.balanceOf(alice.address)).to.equal(1000n);

    // alice initiates cross-chain transfer.
    const recipient = addrToBytes32(alice.address);
    const tx = await bridgeA
      .connect(alice)
      .depositForBurn(500n, DOMAIN_B, recipient, await tokenA.getAddress());
    const receipt = await tx.wait();

    // Capture envelope from MessageSent on chain A.
    const sentEvt = receipt!.logs.find(
      (l: any) => l.fragment?.name === "MessageSent" || l.topics?.[0] === ethers.id("MessageSent(bytes)")
    ) as any;
    let envelope: string;
    if (sentEvt && sentEvt.args && sentEvt.args.message) {
      envelope = sentEvt.args.message as string;
    } else {
      // Fallback: parse manually.
      const iface = tmA.interface;
      const parsed = receipt!.logs
        .map((l: any) => {
          try {
            return iface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p && p.name === "MessageSent");
      envelope = (parsed as any).args.message as string;
    }
    expect(envelope).to.match(/^0x/);
    expect(await tokenA.balanceOf(alice.address)).to.equal(500n);

    // Build attestation: validator signs the attestationDigest for transmitter B.
    const network = await ethers.provider.getNetwork();
    const digest = attestationDigest(envelope, network.chainId, await tmB.getAddress());
    const sigObj = vWallet.signingKey.sign(digest);
    const attestation = sigObj.serialized; // 65 bytes

    // Submit on chain B.
    await tmB.receiveMessage(envelope, attestation);

    expect(await tokenB.balanceOf(alice.address)).to.equal(500n);
    expect(await tokenA.totalSupply()).to.equal(500n); // burned 500
    expect(await tokenB.totalSupply()).to.equal(500n); // minted 500

    // Replay on B should fail.
    await expect(tmB.receiveMessage(envelope, attestation)).to.be.revertedWithCustomError(
      tmB,
      "NonceAlreadyUsed"
    );
  });

  it("attestation signed for wrong transmitter rejected", async () => {
    const { owner, alice, tokenA, bridgeA, tmA, tmB } = await loadFixture(fixture);
    await tokenA.connect(owner).mint(alice.address, 100n);
    const recipient = addrToBytes32(alice.address);
    const tx = await bridgeA
      .connect(alice)
      .depositForBurn(50n, DOMAIN_B, recipient, await tokenA.getAddress());
    const receipt = await tx.wait();
    const iface = tmA.interface;
    const parsed = receipt!.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "MessageSent");
    const envelope = (parsed as any).args.message as string;

    // Sign with the WRONG transmitter address (use tmA instead of tmB).
    const network = await ethers.provider.getNetwork();
    const wrongDigest = attestationDigest(envelope, network.chainId, await tmA.getAddress());
    const sigObj = vWallet.signingKey.sign(wrongDigest);
    const attestation = sigObj.serialized;

    // Verifier reverts (wrong digest -> wrong recovered signer -> SignerNotValidator).
    // Error originates in MultisigVerifier; bubbles up through MessageTransmitter.
    await expect(tmB.receiveMessage(envelope, attestation)).to.be.reverted;
  });
});
