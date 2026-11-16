// What the engine is given (SYNC-DESIGN §4: "Transport / Clock / KV all injected"). The engine itself holds no state
// beyond one call: everything that must survive a stopped service worker is in storage, so a new engine built over the
// same storage after a restart simply carries on. Production wiring (M5): the service worker and the settings page each
// build one over their context's runtime (SyncFlows on the one VaultService, SyncLocal, webLock("sixkey-vault"),
// webLock("sixkey-sync") with ifAvailable, the fetch transport, Date.now, setTimeout/chrome.alarms, the manifest version).
import type { Random } from "../../crypto/bytes";
import type { KV, Lock } from "../../storage/kv";
import type { SyncFlows } from "../../service/sync-flows";
import type { SyncLocal } from "../local/sync-local";
import type { Scheduler } from "./schedule";
import type { Transport } from "./transport";

/** The service's sync half the engine calls (SyncFlows): storage and keys only, each through the vault lock. */
export type EngineFlows = Pick<
  SyncFlows,
  | "applyRemote"
  | "commitKeys"
  | "prepareJoin"
  | "commitJoin"
  | "restoreSyncIdentity"
  | "turnOffSync"
  | "current"
  | "generation"
  | "vaultStatus"
  | "unlockedKey"
  | "cleanupDue"
  | "truncateForUpload"
  | "prepareUploadRecovery"
  | "commitUploadRecovery"
  | "recordAction"
  | "lockEpoch"
  | "trashJoinDuplicates"
  | "recoverAccounts"
  | "snapshots"
>;

/** Sync's local side the engine reads (SyncLocal): the four combinations, the settled pins, the identity, the copy. */
export type EngineLocal = Pick<SyncLocal, "status" | "settlePins" | "identity" | "cfg" | "switchIdentity">;

/**
 * webLock("sixkey-sync", { ifAvailable: true }) (§4.2, §4.9 D10): the lock belongs to the context that runs the round; a
 * round that finds it held does not wait (it asks for a rerun). The service worker's transport for a page never takes it.
 */
export type TryLock = <T>(fn: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;

export type EngineDeps = {
  /** The configured API origin (the identity's apiOrigin must be this one: dev and prod never mixed, §2.5). */
  origin: string;
  transport: Transport;
  flows: EngineFlows;
  local: EngineLocal;
  /** chrome.storage.local: sk_sync_state, sk_sync_outbox, sk_sync_cfg (read; written only through state.ts). */
  kv: KV;
  /** The store's own lock (webLock("sixkey-vault")): every sk_sync_* read-modify-write (M2-NOTES §4.2 item 3). */
  vaultLock: Lock;
  syncLock: TryLock;
  /** This machine's clock (ms). */
  now: () => number;
  /** For the jitter between 409 retries inside a round (§4.2 step 6). */
  sleep: (ms: number) => Promise<void>;
  scheduler?: Scheduler;
  rng?: Random;
  /** [0, 1): backoff and 409 jitter, the periodic phase. */
  random?: () => number;
  /** This build's manifest version (§5.2 min_client_version, N21). */
  clientVersion: string;
  /** The HLC device suffix (sk_device), for §4.4 D6's "deleted by another device" rule. */
  hlcDevice?: () => Promise<string>;
  /** Non-fatal problems, as fixed phrases and codes only (never data, keys or codes). */
  diag?: (message: string) => void;
  /**
   * The network switch (§4.9, revisions 21 and 22): whether the API origin's host permission is granted (M5:
   * chrome.permissions.contains). Asked in every round and every push after the steps that send nothing (the local
   * stops, step 0's orphan fold) and before the first request; without it the round sends nothing more and ends as
   * permission_removed. Absent: always granted (the tests' FakeServer worlds).
   */
  networkAllowed?: () => Promise<boolean>;
};
