import { ethers } from "hardhat";

/**
 * Reusable deploy helpers. Tests load these via @nomicfoundation/hardhat-network-helpers
 * `loadFixture` to snapshot+restore between cases (much faster than re-deploying).
 *
 * `localDomain` defaults to 1 because `MessageTransmitter.initialize` rejects 0.
 */
export interface StackOpts {
  validators?: string[];
  threshold?: bigint;
  localDomain?: number;
  maxMessageBodySize?: bigint;
  initialTimelock?: bigint;
  initialMinTimelock?: bigint;
  tokenName?: string;
  tokenSymbol?: string;
}

const ONE_HOUR = 3600n;

export async function deployStableNaira(admin: string, name = "StableNaira", symbol = "SNR") {
  const Factory = await ethers.getContractFactory("StableNairaUUPSDeployer");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const tx = await factory.deploy(name, symbol, admin);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("deploy receipt null");

  const ev = receipt.logs.find((l: any) => l.fragment?.name === "Deployed") as any;
  if (!ev) throw new Error("Deployed event not found");
  const proxy = ev.args.proxy as string;
  const implementation = ev.args.implementation as string;

  const stableNaira = (await ethers.getContractAt("StableNaira", proxy)) as any;
  return { stableNaira, factory: factory as any, implementation, proxy };
}

export async function deployValidatorRegistry(
  validators: string[],
  threshold: bigint,
  owner: string,
  initialTimelock = 0n,
  initialMinTimelock = 0n
) {
  const Impl = await ethers.getContractFactory("ValidatorRegistry");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData("initialize", [
    validators,
    threshold,
    owner,
    initialTimelock,
    initialMinTimelock,
  ]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const validatorRegistry = (await ethers.getContractAt(
    "ValidatorRegistry",
    await proxy.getAddress()
  )) as any;
  return { validatorRegistry, impl: impl as any, proxy: proxy as any };
}

export async function deployMultisigVerifier(registryAddr: string) {
  const Verifier = await ethers.getContractFactory("MultisigVerifier");
  const verifier = await Verifier.deploy(registryAddr);
  await verifier.waitForDeployment();
  return { verifier: verifier as any };
}

export async function deployMessageTransmitter(
  localDomain: number,
  verifierAddr: string,
  maxMessageBodySize: bigint,
  owner: string,
  initialTimelock = 0n,
  initialMinTimelock = 0n
) {
  const Impl = await ethers.getContractFactory("MessageTransmitter");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData("initialize", [
    localDomain,
    verifierAddr,
    maxMessageBodySize,
    owner,
    initialTimelock,
    initialMinTimelock,
  ]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const messageTransmitter = (await ethers.getContractAt(
    "MessageTransmitter",
    await proxy.getAddress()
  )) as any;
  return { messageTransmitter, impl: impl as any, proxy: proxy as any };
}

export async function deployTokenMessenger(
  transmitterAddr: string,
  tokenAddr: string,
  owner: string,
  initialTimelock = 0n,
  initialMinTimelock = 0n
) {
  const Impl = await ethers.getContractFactory("TokenMessenger");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData("initialize", [
    transmitterAddr,
    tokenAddr,
    owner,
    initialTimelock,
    initialMinTimelock,
  ]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const tokenMessenger = (await ethers.getContractAt(
    "TokenMessenger",
    await proxy.getAddress()
  )) as any;
  return { tokenMessenger, impl: impl as any, proxy: proxy as any };
}

/** Deploys the entire stack on the current network with sane defaults for unit tests. */
export async function deployStack(opts: StackOpts = {}) {
  const [deployer, alice, bob, validator2, validator3, ...others] = await ethers.getSigners();
  const owner = deployer.address;

  const validators = opts.validators ?? [deployer.address];
  const threshold = opts.threshold ?? 1n;
  const localDomain = opts.localDomain ?? 1;
  const maxMessageBodySize = opts.maxMessageBodySize ?? 4096n;
  const initialTimelock = opts.initialTimelock ?? 0n;
  const initialMinTimelock = opts.initialMinTimelock ?? 0n;
  const tokenName = opts.tokenName ?? "StableNaira";
  const tokenSymbol = opts.tokenSymbol ?? "SNR";

  const { stableNaira } = await deployStableNaira(owner, tokenName, tokenSymbol);
  const { validatorRegistry } = await deployValidatorRegistry(
    validators,
    threshold,
    owner,
    initialTimelock,
    initialMinTimelock
  );
  const { verifier } = await deployMultisigVerifier(await validatorRegistry.getAddress());
  const { messageTransmitter } = await deployMessageTransmitter(
    localDomain,
    await verifier.getAddress(),
    maxMessageBodySize,
    owner,
    initialTimelock,
    initialMinTimelock
  );
  const { tokenMessenger } = await deployTokenMessenger(
    await messageTransmitter.getAddress(),
    await stableNaira.getAddress(),
    owner,
    initialTimelock,
    initialMinTimelock
  );

  // Grant MINTER_ROLE to the bridge so it can mint on receive / burn on send.
  await stableNaira.connect(deployer).addMinter(await tokenMessenger.getAddress());

  return {
    stableNaira,
    validatorRegistry,
    verifier,
    messageTransmitter,
    tokenMessenger,
    deployer,
    alice,
    bob,
    validator2,
    validator3,
    others,
    constants: { ONE_HOUR },
  };
}

export const TIMELOCK_FLOOR = ONE_HOUR;
