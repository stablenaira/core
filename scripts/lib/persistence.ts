import fs from "fs";
import path from "path";

export interface Addresses {
  stableNaira?: string;
  stableNairaImpl?: string;
  stableNairaDeployer?: string;
  validatorRegistry?: string;
  validatorRegistryImpl?: string;
  verifier?: string;
  messageTransmitter?: string;
  messageTransmitterImpl?: string;
  tokenMessenger?: string;
  tokenMessengerImpl?: string;
  priceOracle?: string;
}

export interface RemoteRouterEntry {
  domainId: number;
  router: string;
  actionId?: string;
  status?: "queued" | "committed";
  queuedAt?: string;
  eta?: number;
  committedAt?: string;
}

export interface DeploymentRecord {
  network: string;
  chainId: number;
  domainId: number;
  label: string;
  explorerUrl: string;
  deployer: string;
  deployedAt: string;
  contracts: Addresses;
  configuration: {
    tokenName?: string;
    tokenSymbol?: string;
    validators?: string[];
    threshold?: number;
    feeBps?: number;
    maxMessageBodySize?: number;
    oracle?: { decimals: number; reporters: string[]; quorum: number };
    minterRoleGranted?: boolean;
  };
  remoteRouters: RemoteRouterEntry[];
}

const ROOT = path.resolve(__dirname, "..", "..");
const DEPLOY_DIR = path.join(ROOT, "ignition", "deployments");

function fileFor(networkName: string): string {
  return path.join(DEPLOY_DIR, networkName, "addresses.json");
}

export function readDeployment(networkName: string): DeploymentRecord | null {
  const f = fileFor(networkName);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf-8")) as DeploymentRecord;
}

export function writeDeployment(networkName: string, rec: DeploymentRecord): void {
  const f = fileFor(networkName);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rec, null, 2) + "\n", "utf-8");
}

export function upsertDeployment(
  networkName: string,
  patch: Partial<DeploymentRecord> & { contracts?: Partial<Addresses> }
): DeploymentRecord {
  const existing = readDeployment(networkName);
  const next: DeploymentRecord = {
    network: patch.network ?? existing?.network ?? networkName,
    chainId: patch.chainId ?? existing?.chainId ?? 0,
    domainId: patch.domainId ?? existing?.domainId ?? 0,
    label: patch.label ?? existing?.label ?? networkName,
    explorerUrl: patch.explorerUrl ?? existing?.explorerUrl ?? "",
    deployer: patch.deployer ?? existing?.deployer ?? "",
    deployedAt: patch.deployedAt ?? existing?.deployedAt ?? new Date().toISOString(),
    contracts: { ...(existing?.contracts ?? {}), ...(patch.contracts ?? {}) },
    configuration: { ...(existing?.configuration ?? {}), ...(patch.configuration ?? {}) },
    remoteRouters: patch.remoteRouters ?? existing?.remoteRouters ?? [],
  };
  writeDeployment(networkName, next);
  return next;
}

export function listDeployments(): { network: string; record: DeploymentRecord }[] {
  if (!fs.existsSync(DEPLOY_DIR)) return [];
  const entries = fs.readdirSync(DEPLOY_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const rec = readDeployment(e.name);
      return rec ? { network: e.name, record: rec } : null;
    })
    .filter(Boolean) as { network: string; record: DeploymentRecord }[];
}
