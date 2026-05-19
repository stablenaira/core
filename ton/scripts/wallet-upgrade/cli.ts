#!/usr/bin/env node
// ton-wallet-upgrade — operator CLI for the TON wallet-fleet rollout.
//
//   ton-wallet-upgrade enumerate   # snapshot fleet -> PROGRESS_DB
//   ton-wallet-upgrade bless       # queue+commit (honours timelock)
//   ton-wallet-upgrade push        # batched, resumable, idempotent
//   ton-wallet-upgrade sweep       # re-enumerate + push stragglers
//   ton-wallet-upgrade report      # progress + supply invariant
//
// The orchestration (orchestrator.ts / progress.ts) is fully unit-tested
// against @ton/sandbox. The LIVE network adapter below intentionally requires
// explicit configuration (endpoint, signer, indexer) and is NOT exercised in
// CI — wiring it is a deployment task, see
// 08 Operations/TON Wallet Fleet Upgrade Runbook.

import { readFileSync } from "fs";
import { Address, Cell } from "@ton/core";
import { ProgressStore } from "./progress.js";
import {
  bless,
  runPush,
  supplyInvariantHolds,
  type UpgradeNetwork,
} from "./orchestrator.js";

interface Env {
  endpoint: string;
  master: string;
  codePath: string;
  progressDb: string;
  batchSize: number;
}

function env(): Env {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k} (see runbook Configuration table)`);
    return v;
  };
  return {
    endpoint: need("TON_ENDPOINT"),
    master: need("SNR_JETTON_MASTER"),
    codePath: need("WALLET_CODE_V_NEXT"),
    progressDb: process.env.PROGRESS_DB ?? "ton-wallet-upgrade.sqlite.json",
    batchSize: Number(process.env.BATCH_SIZE ?? "50"),
  };
}

function loadCode(path: string): Cell {
  return Cell.fromBoc(readFileSync(path))[0]!;
}

/// Live adapter skeleton. Implement against @ton/ton TonClient + an indexer +
/// the operator signer when deploying. Left unconfigured on purpose so the
/// rollout is never run by accident from CI/dev.
function liveNetwork(_e: Env): UpgradeNetwork {
  throw new Error(
    "live TON network not configured: implement the TonClient/indexer/" +
      "signer adapter per the Wallet Fleet Upgrade Runbook before running " +
      "against testnet/mainnet",
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const e = env();
  const store = new ProgressStore(e.progressDb);

  switch (cmd) {
    case "enumerate":
    case "sweep": {
      // Indexer query lives in the live adapter; document the contract:
      // list all jetton wallets of e.master, then store.seed(addresses).
      throw new Error(
        `'${cmd}' needs the configured indexer adapter (see runbook step 2/6)`,
      );
    }
    case "bless": {
      await bless(liveNetwork(e), loadCode(e.codePath));
      return;
    }
    case "push": {
      const net = liveNetwork(e);
      const code = loadCode(e.codePath);
      const rep = await runPush(net, store, code, {
        batchSize: e.batchSize,
        toAddress: (s) => Address.parse(s),
        onBatch: (d, t) => console.log(`pushed ${d}/${t}`),
      });
      console.log(JSON.stringify(rep, null, 2));
      return;
    }
    case "report": {
      const net = liveNetwork(e);
      const baseline = BigInt(process.env.SUPPLY_BASELINE ?? "0");
      console.log(JSON.stringify(store.stats(), null, 2));
      console.log("supply invariant:", await supplyInvariantHolds(net, baseline));
      return;
    }
    default:
      console.error(
        "usage: ton-wallet-upgrade <enumerate|bless|push|sweep|report>",
      );
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
