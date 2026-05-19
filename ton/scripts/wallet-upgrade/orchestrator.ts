// Pure rollout orchestration for the TON wallet fleet. The network is
// injected (`UpgradeNetwork`) so this is unit-tested against @ton/sandbox and
// driven against a live TonClient in production with the same code path.
// Procedure mirrors 08 Operations/TON Wallet Fleet Upgrade Runbook.

import type { Address, Cell } from "@ton/core";
import type { ProgressStore } from "./progress.js";

export interface UpgradeNetwork {
  /// master.get blessedWalletHash()
  blessedHash(): Promise<bigint>;
  /// owner → QueueWalletUpgrade{codeHash}
  queueWalletUpgrade(codeHash: bigint): Promise<void>;
  /// (after timelock) anyone → CommitWalletUpgrade{code}
  commitWalletUpgrade(code: Cell): Promise<void>;
  /// admin → PushWalletUpgrade{wallet, code}
  pushWalletUpgrade(wallet: Address, code: Cell): Promise<void>;
  /// wallet.get balanceValue()
  walletBalance(wallet: Address): Promise<bigint>;
  /// master.get totalSupplyValue()
  totalSupply(): Promise<bigint>;
  /// advance past the upgrade timelock (sandbox: bump now; live: real wait)
  advanceTimelock(): Promise<void>;
}

export class RolloutError extends Error {}

/// Queue → wait out timelock → commit. Asserts the master actually blessed the
/// exact code hash before any push happens.
export async function bless(net: UpgradeNetwork, code: Cell): Promise<bigint> {
  const codeHash = BigInt(`0x${code.hash().toString("hex")}`);
  await net.queueWalletUpgrade(codeHash);
  await net.advanceTimelock();
  await net.commitWalletUpgrade(code);
  const blessed = await net.blessedHash();
  if (blessed !== codeHash) {
    throw new RolloutError(
      `bless failed: master blessedHash=${blessed} expected=${codeHash}`,
    );
  }
  return codeHash;
}

export interface PushReport {
  pushed: number;
  skipped: number; // already upgraded (idempotent re-run)
  total: number;
  upgraded: number;
  pending: number;
}

export interface RunPushOpts {
  batchSize?: number;
  /// resolve a stored address string back to an Address (chain-specific)
  toAddress: (s: string) => Address;
  onBatch?: (done: number, total: number) => void;
}

/// Push the blessed code to every pending wallet, in batches, resumable and
/// idempotent. A wallet is marked upgraded ONLY after the post-push balance
/// matches the pre-push snapshot (value must never move during an upgrade).
export async function runPush(
  net: UpgradeNetwork,
  store: ProgressStore,
  code: Cell,
  opts: RunPushOpts,
): Promise<PushReport> {
  const codeHash = BigInt(`0x${code.hash().toString("hex")}`);
  const blessed = await net.blessedHash();
  if (blessed !== codeHash) {
    throw new RolloutError("refusing to push: code is not the blessed code");
  }

  const batchSize = opts.batchSize ?? 50;
  const pending = store.pending();
  let pushed = 0;
  let done = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    for (const addrStr of batch) {
      const wallet = opts.toAddress(addrStr);
      const before = store.balanceBefore(addrStr) ?? (await net.walletBalance(wallet));
      store.recordBalanceBefore(addrStr, before);

      await net.pushWalletUpgrade(wallet, code);

      const after = await net.walletBalance(wallet);
      if (after !== before) {
        throw new RolloutError(
          `balance moved during upgrade of ${addrStr}: ${before} -> ${after}`,
        );
      }
      store.markUpgraded(addrStr);
      pushed++;
      done++;
    }
    opts.onBatch?.(done, pending.length);
  }

  const s = store.stats();
  return {
    pushed,
    skipped: s.upgraded - pushed,
    total: s.total,
    upgraded: s.upgraded,
    pending: s.pending,
  };
}

/// Global safety invariant: an upgrade must never change the money supply.
/// Capture `baseline` before the rollout; assert again after.
export async function supplyInvariantHolds(
  net: UpgradeNetwork,
  baseline: bigint,
): Promise<boolean> {
  return (await net.totalSupply()) === baseline;
}
