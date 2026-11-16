// The sync engine as a context that syncs builds it (SYNC-DESIGN §4.9; M5): the service worker (sync-worker.ts) and a page
// that runs the engine itself (bridge-page.ts). One engine per context, over that context's runtime (runtime.ts): the
// same VaultService, store and outbox writer every page uses, plus the parts only syncing contexts carry: the device
// identity in IndexedDB (sixkey-identity), SyncLocal, SyncFlows and the engine. The popup never builds one; nothing here
// is in its module graph (test/unit/m3-source-rules.test.ts).
//
// The locks are the extension-wide Web Locks (§4.9): webLock("sixkey-vault") is the store's own lock, which every
// sk_sync_* read-modify-write holds; webLock("sixkey-identity") is the identity record's; tryWebLock("sixkey-sync") is
// held by the context that runs a round or a key operation, and a round that finds it taken asks for a rerun instead of
// waiting. The worker's page transport never takes it (bridge-worker.ts).
import { randomBytes } from "../core/crypto/bytes";
import type { KV } from "../core/storage/kv";
import { SyncFlows } from "../core/service/sync-flows";
import { SyncEngine } from "../core/sync/engine/engine";
import type { Scheduler } from "../core/sync/engine/schedule";
import type { Transport } from "../core/sync/engine/transport";
import { IDENTITY_DB } from "../core/sync/local/keys";
import { SyncLocal } from "../core/sync/local/sync-local";
import { API_ORIGIN } from "./api-origin";
import { apiPermissionGranted } from "./api-permission";
import { IdbKV } from "./idb-kv";
import { tryWebLock, webLock, type TryLock } from "./locks";
import type { Runtime } from "./runtime";

/** A uniform number in [0, 1) from the platform's cryptographic random source (backoff jitter, the periodic phase). */
export function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

export type SyncEngineOptions = {
  rt: Runtime;
  transport: Transport;
  /** The worker's timers and alarms (sync-worker.ts); a page that runs the engine schedules nothing. */
  scheduler?: Scheduler;
  /**
   * Defaults: the build's API origin, IndexedDB sixkey-identity, the manifest's version, webLock("sixkey-sync"), and the
   * API host permission as the network switch (chrome.permissions.contains, api-permission.ts).
   */
  origin?: string;
  identity?: KV;
  clientVersion?: string;
  syncLock?: TryLock;
  networkAllowed?: () => Promise<boolean>;
  now?: () => number;
};

export function createSyncEngine(o: SyncEngineOptions): { local: SyncLocal; flows: SyncFlows; engine: SyncEngine } {
  const vaultLock = webLock("sixkey-vault");
  const local = new SyncLocal({
    local: o.rt.local,
    identity: o.identity ?? new IdbKV(IDENTITY_DB),
    vaultLock,
    identityLock: webLock("sixkey-identity"),
    rng: randomBytes,
  });
  const flows = new SyncFlows(o.rt.service, local);
  const engine = new SyncEngine({
    origin: o.origin ?? API_ORIGIN,
    transport: o.transport,
    flows,
    local,
    kv: o.rt.local,
    vaultLock,
    syncLock: o.syncLock ?? tryWebLock("sixkey-sync"),
    now: o.now ?? Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...(o.scheduler ? { scheduler: o.scheduler } : {}),
    rng: randomBytes,
    random: cryptoRandom,
    clientVersion: o.clientVersion ?? chrome.runtime.getManifest().version,
    hlcDevice: () => o.rt.settings.deviceId(),
    diag: (message) => o.rt.diag(message),
    networkAllowed: o.networkAllowed ?? (() => apiPermissionGranted()),
  });
  return { local, flows, engine };
}
