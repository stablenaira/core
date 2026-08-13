import fs from "fs";
import path from "path";

export interface NetworkSpec {
  label: string;
  chainId: number;
  domainId: number;
  deployOracle: boolean;
  explorerUrl: string;
  peers: string[];
  /**
   * Bind the bridge to a StableNaira that already exists on this chain instead
   * of deploying a new one. Without it `PHASE=deploy` always deploys a fresh
   * token, which orphans one deployed earlier by `deploy-token.ts` and leaves a
   * duplicate SNR on the chain. Falls back to `common.token.address`.
   */
  tokenAddress?: string;
}

export interface CommonParams {
  token: {
    name: string;
    symbol: string;
    mintCap: string;
    /**
     * Rate limit for the local bridge's synchronous mint path, as a capacity
     * that refills linearly over `bridgePeriodSeconds`. This is what bounds a
     * bridge compromise — size it to a plausible peak day of legitimate
     * cross-chain volume, not to the total supply.
     */
    bridgeCapacity?: string;
    bridgePeriodSeconds?: number;
    /** Chain-agnostic fallback for `NetworkSpec.tokenAddress`. */
    address?: string;
  };
  validatorRegistry: {
    validators: string[];
    threshold: number;
    initialTimelock: number;
    initialMinTimelock: number;
  };
  messageTransmitter: {
    maxMessageBodySize: number;
    initialTimelock: number;
    initialMinTimelock: number;
  };
  tokenMessenger: {
    initialTimelock: number;
    initialMinTimelock: number;
    feeBps: number;
    feeRecipient: string;
  };
  oracle: { decimals: number; reporters: string[]; quorum: number };
  owner: string;
  admin: string;
}

export interface DeploymentTemplate {
  common: CommonParams;
  networks: Record<string, NetworkSpec>;
  deploymentGroups: Record<string, string[]>;
}

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "ignition",
  "parameters",
  "deploy-stable-naira-stack.template.json"
);

export function loadTemplate(): DeploymentTemplate {
  const raw = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  return JSON.parse(raw) as DeploymentTemplate;
}

export function getNetworkSpec(template: DeploymentTemplate, networkName: string): NetworkSpec {
  const spec = template.networks[networkName];
  if (!spec) {
    throw new Error(
      `Network "${networkName}" not found in template. Available: ${Object.keys(template.networks).join(", ")}`
    );
  }
  return spec;
}
