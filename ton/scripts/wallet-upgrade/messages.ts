// Production message-body builders. Uses the Tact-generated `store*`
// serialisers so the on-wire layout is guaranteed identical to the contract
// (opcodes 0x55504710/11/13). The live CLI adapter uses these; the sandbox
// test path uses the wrapper directly. A unit test asserts the opcodes.

import { Address, beginCell, type Cell } from "@ton/core";
import {
  storeQueueWalletUpgrade,
  storeCommitWalletUpgrade,
  storePushWalletUpgrade,
} from "../../build/StableNairaJettonMaster/tact_StableNairaJettonMaster";

export function queueWalletUpgradeBody(codeHash: bigint): Cell {
  return beginCell()
    .store(storeQueueWalletUpgrade({ $$type: "QueueWalletUpgrade", codeHash }))
    .endCell();
}

export function commitWalletUpgradeBody(code: Cell): Cell {
  return beginCell()
    .store(storeCommitWalletUpgrade({ $$type: "CommitWalletUpgrade", code }))
    .endCell();
}

export function pushWalletUpgradeBody(wallet: Address, code: Cell): Cell {
  return beginCell()
    .store(storePushWalletUpgrade({ $$type: "PushWalletUpgrade", wallet, code }))
    .endCell();
}
