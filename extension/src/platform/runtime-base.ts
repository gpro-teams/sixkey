// The wiring every extension context shares (popup, options page, service worker): storage, the session, the security
// record, the PIN's set-up, sync's light local side and the outbox, and the service built over them. platform/runtime.ts
// builds it with the whole VaultService (the settings page, the service worker, the developer page); the popup builds
// it with ServiceCore alone (createPopupRuntime below), the part of the service it uses, so the rest of the service is
// not in its bundle (docs/design/notes/BUDGET-NOTES.md). Moved here from runtime.ts unchanged, the service's class aside.
import { PinStore } from "../core/service/pin-store";
import { PrfStore } from "../core/service/prf-store";
import { PwFormatStore } from "../core/service/pw-format";
import { SecurityLog, securityReader } from "../core/service/security-log";
import { ServiceCore, type ServiceDeps, type SyncPort, type VkRecord } from "../core/service/service-core";
import { KvSettingsStore } from "../core/service/types";
import type { KV } from "../core/storage/kv";
import { VaultStore } from "../core/storage/store";
import { createOutboxWriter } from "../core/sync/local/outbox-writer";
import { createSyncPort, type SyncRuntime } from "../core/sync/local/port";
import { activeKeyring } from "../core/sync/local/records";
import { noReadableVault } from "../core/storage/active-keyring";
import { keysChangedElsewhere as keysNews } from "../core/sync/local/state";
import { ChromeLocalKV } from "./chrome-kv";
import { CSB_CFG_KEY, CSB_STATE_KEY, markCsbHeld } from "./cloud-mark";
import { createDiagLogger } from "./diag";
import { IdbKV } from "./idb-kv";
import { webLock } from "./locks";
import { ChromeSessionCache, RoutedSession } from "./session";

/**
 * Where the runtime keeps things; each one defaults to the browser's own. Tests pass counting fakes, so the popup's real
 * wiring can be measured (test/unit/read-budget.test.ts). `mirror: null` means no mirror. `worker`: this is the service
 * worker's runtime (its own commits are its sync rounds', so they do not ask it for another round).
 */
export type RuntimeStorage = {
  local?: chrome.storage.StorageArea;
  session?: chrome.storage.StorageArea;
  mirror?: KV | null;
  worker?: boolean;
};

/** The message a page sends after a commit with sync on (§4.8 "sync soon"); the service worker answers it (sync-worker.ts). */
export const SYNC_SOON_MESSAGE = "sk-sync-soon";

/** Asks the service worker for a round soon. Fire and forget: a page that closes meanwhile loses nothing (§4.8). */
function askWorkerToSync(): void {
  try {
    void chrome.runtime.sendMessage({ type: SYNC_SOON_MESSAGE }).catch(() => undefined);
  } catch {
    /* no extension runtime here (tests run the runtime outside Chrome) */
  }
}

/**
 * The service's port with the outbox (SYNC-DESIGN §4.7, D2; M5): after every commit of new data with sync on, inside the
 * vault lock, the writer stores the next upload for the generation just committed (createOutboxWriter: one read of the
 * sync state, then the record), and then a page asks the worker to run a round, also when the write failed (the save
 * stands, and a round with the key computes the upload itself). The service calls afterCommit only with sync on; with
 * sync off nothing here runs.
 */
function withOutbox(
  port: SyncRuntime,
  local: KV,
  kick: (() => void) | null,
): SyncRuntime & Required<Pick<SyncPort, "afterCommit">> {
  const write = createOutboxWriter(local);
  return {
    ...port,
    afterCommit: async (c) => {
      try {
        await write(c);
      } finally {
        kick?.();
      }
    },
  };
}

export function buildRuntime<S>(o: RuntimeStorage, make: (deps: ServiceDeps) => S) {
  const local = new ChromeLocalKV(o.local);
  const mirror =
    o.mirror === null ? undefined : (o.mirror ?? (typeof indexedDB !== "undefined" ? new IdbKV() : undefined));
  const onDiag = createDiagLogger(local);
  // Sync's local side as every context needs it (SYNC-DESIGN M2): a cleanup in any of them must move the two
  // VK-encrypted records (§0.0i req. 5), every recovery write must clear lastSynced (D1), and every commit with sync on
  // writes the outbox (§4.7, M5). Constructing it reads nothing; with sync off it reads only where the design says (a
  // local edit: one get of two keys; with sync on the outbox writer's one more, after the commit). The device identity
  // and the sync flows (SyncLocal, SyncFlows) are built by the contexts that sync (platform/sync-engine.ts).
  const sync = withOutbox(
    createSyncPort({ local, vaultLock: webLock("sixkey-vault") }),
    local,
    o.worker ? null : askWorkerToSync,
  );
  const store = new VaultStore({
    kv: local,
    ...(mirror ? { mirror } : {}),
    lock: webLock("sixkey-vault"),
    onDiag,
    // sync's lastSynced cleared (D1), and the backup in Chrome sync's link marked held, so nothing is written over a
    // slot that may be newer than this data until a page merges it (CSB: core/cloud/slots.ts rule 3)
    beforeRecoveryWrite: async () => {
      await sync.clearLastSynced();
      await markCsbHeld(local, webLock("sixkey-csb"));
    },
  });
  // with the settings, the backup in Chrome sync's two records: the popup's pill and footer show them, and the open reads
  // nothing more for them (src/popup/main/CsbPop.tsx; test/e2e/perf.spec.ts)
  const settings = new KvSettingsStore(local, [CSB_CFG_KEY, CSB_STATE_KEY]);
  const session = new RoutedSession(new ChromeSessionCache(o.session), settings);
  // Local only (never the mirror), its own lock across contexts; constructing it reads nothing (security-log.ts).
  const log = new SecurityLog({ kv: local, lock: webLock("sixkey-security-log"), onDiag });
  // The PIN's set-up (QUICK-UNLOCK §5.2): written only under the store's own lock, and moved by the one cleanup entry
  // point after a key change like the sync records; its try counter has a lock of its own across contexts.
  const pins = new PinStore(local, webLock("sixkey-vault"));
  // The device unlock's record (QUICK-UNLOCK §5.2, Stage 2): the same lock, the same cleanup entry point (which pauses its
  // PRF wraps after a key change).
  const prfs = new PrfStore(local, webLock("sixkey-vault"));
  // The grant store's record (autofill's switch; src/core/plugins/store.ts): tagged under a key derived from the
  // vault key, so the one cleanup entry point moves it like the records above, and only there does an old key count. Its
  // code loads only when a cleanup runs (the plugin platform is lazy; the worker's build inlines it). No session area
  // (outside an extension): no plugins to move.
  const grants: VkRecord = {
    name: "plugin grants",
    reencrypt: async (current, held) => {
      const area = o.session ?? globalThis.chrome?.storage?.session;
      if (!area) return "absent";
      const { GrantStore } = await import("../core/plugins/store");
      const g = new GrantStore({ local, session: new ChromeLocalKV(area), lock: webLock("sixkey-vault") });
      return g.reencrypt(current, held, async () => (await activeKeyring(local)).vkId);
    },
    // before a new vault's commit: the plugins of a record its new key will not verify removed through the overlay, so a
    // set-aside below cut short leaves none of them honoured (CLOUD-PLUGIN-NOTES.md §3.5); only while the slots, read
    // under the same lock, still hold no vault (N2-2)
    beforeNewVault: async (next) => {
      const area = o.session ?? globalThis.chrome?.storage?.session;
      if (!area) return;
      const { GrantStore } = await import("../core/plugins/store");
      const g = new GrantStore({ local, session: new ChromeLocalKV(area), lock: webLock("sixkey-vault") });
      await g.beforeNewVault(next, () => noReadableVault(local));
    },
    // a new vault: a record left beside it, which its new key does not verify, set aside for review (W2a r3)
    newVault: async (current) => {
      const area = o.session ?? globalThis.chrome?.storage?.session;
      if (!area) return;
      const { GrantStore } = await import("../core/plugins/store");
      const g = new GrantStore({ local, session: new ChromeLocalKV(area), lock: webLock("sixkey-vault") });
      await g.newVault({ vk: current, activeVkId: async () => (await activeKeyring(local)).vkId });
    },
  };
  // The master-password prompts' input hint (pw-format.ts): chrome.storage.session only (memory, trusted contexts),
  // never chrome.storage.local; written by the service, read by the settings page (passwordFormat, runtime.ts) and by the
  // service for the popup's lock screen (openView) and after an unlock. Fails closed: with no session area there is no
  // hint store at all, never one over the KV's default (chrome.storage.local).
  const hintArea = o.session ?? globalThis.chrome?.storage?.session;
  const formats = hintArea && new PwFormatStore(new ChromeLocalKV(hintArea));
  const service = make({
    store,
    session,
    settings,
    onDiag,
    security: log,
    vkRecords: [...sync.records, pins, prfs, grants],
    sync,
    pins,
    prfs,
    formats,
    quickLock: webLock("sixkey-quick"),
  });
  // The pages get the read side only: emptying the log is service.clearSecurityLog(password).
  // `formats`: for passwordFormat (runtime.ts); only the service writes it (test/unit/password-entry-service.test.ts).
  return {
    local,
    mirror,
    store,
    session,
    settings,
    security: securityReader(log),
    service,
    sync,
    diag: onDiag,
    formats,
  };
}

/** The popup's runtime: the same wiring, with the part of the service the popup uses. */
export function createPopupRuntime(o: RuntimeStorage = {}) {
  return buildRuntime(o, (deps) => new ServiceCore(deps));
}
export type PopupRuntime = ReturnType<typeof createPopupRuntime>;

/**
 * What the popup's lock screen says about keys changed on another device (SYNC-DESIGN §6 P2), read from the runtime's
 * storage after an unlock attempt fails: the popup reaches sync through the runtime only. A build without the sync user
 * interface never calls it.
 */
export function keysChangedElsewhere(rt: Pick<PopupRuntime, "local">): Promise<"password" | "keys" | "pending" | null> {
  return keysNews(rt.local);
}
