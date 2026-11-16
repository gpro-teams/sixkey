// What every context builds for sync (platform/runtime.ts; SYNC-DESIGN M2), and all the popup carries of it: the sync
// state's one read for a local edit, the recovery hook's clear (D1), and the two VkRecords the one cleanup entry point
// moves to the current key (§0.0i req. 5), which with sync never turned on read their key once and do nothing more.
// The rest of sync's local side (the device identity, the identity restore, turning sync off) is SyncLocal, and the
// service's sync flows are SyncFlows: both are built by the contexts that sync (M5), never by the popup.
import type { Random } from "../../crypto/bytes";
import type { KV, Lock } from "../../storage/kv";
import type { SyncPort, VkRecord } from "../../service/service";
import { PrejoinRecord, SyncCfgRecord } from "./records";
import { SyncStateStore } from "./state";

export type SyncRuntime = SyncPort & {
  /** For the cleanup entry point (ServiceDeps.vkRecords). An open list: the YubiKey records join it (R5). */
  readonly records: VkRecord[];
};

/** `vaultLock`: the store's own lock, webLock("sixkey-vault") (the records' critical sections, A4R-4). */
export function createSyncPort(o: { local: KV; vaultLock: Lock; rng?: Random }): SyncRuntime {
  const state = new SyncStateStore(o.local);
  return {
    context: () => state.context(),
    // the store's beforeRecoveryWrite, its one caller: lastSynced cleared and the outbox appended to the orphan list (D1, rev. 19, 20)
    clearLastSynced: () => state.recoveryHook(),
    records: [new SyncCfgRecord(o.local, o.vaultLock, o.rng), new PrejoinRecord(o.local, o.vaultLock, o.rng)],
  };
}
