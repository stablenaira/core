// Resumable, idempotent progress store for the TON wallet-fleet rollout.
// One row per wallet address; the file is the source of truth so the rollout
// survives restarts (see 08 Operations/TON Wallet Fleet Upgrade Runbook).

import { existsSync, readFileSync, writeFileSync } from "fs";

export interface WalletRow {
  upgraded: boolean;
  /// balance snapshot taken immediately before the first push, so the
  /// post-push verify can assert value was preserved.
  balanceBefore?: string;
}

export interface ProgressStats {
  total: number;
  upgraded: number;
  pending: number;
}

export class ProgressStore {
  private rows = new Map<string, WalletRow>();

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, WalletRow>;
      for (const [k, v] of Object.entries(raw)) this.rows.set(k, v);
    }
  }

  /// Add any addresses not already tracked (never resets known rows — safe to
  /// re-run after a fresh `enumerate`/`sweep`).
  seed(addresses: string[]): void {
    for (const a of addresses) {
      if (!this.rows.has(a)) this.rows.set(a, { upgraded: false });
    }
    this.save();
  }

  pending(): string[] {
    return [...this.rows.entries()]
      .filter(([, r]) => !r.upgraded)
      .map(([a]) => a);
  }

  has(addr: string): boolean {
    return this.rows.has(addr);
  }

  recordBalanceBefore(addr: string, balance: bigint): void {
    const r = this.rows.get(addr);
    if (r && r.balanceBefore === undefined) {
      r.balanceBefore = balance.toString();
      this.save();
    }
  }

  balanceBefore(addr: string): bigint | undefined {
    const v = this.rows.get(addr)?.balanceBefore;
    return v === undefined ? undefined : BigInt(v);
  }

  markUpgraded(addr: string): void {
    const r = this.rows.get(addr);
    if (r) {
      r.upgraded = true;
      this.save();
    }
  }

  stats(): ProgressStats {
    const total = this.rows.size;
    let upgraded = 0;
    for (const r of this.rows.values()) if (r.upgraded) upgraded++;
    return { total, upgraded, pending: total - upgraded };
  }

  save(): void {
    if (!this.path) return;
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.rows), null, 2));
  }
}
