// The wiring every extension context shares (popup, options page, service worker): storage, the session, the security
// record, the PIN's set-up, the device unlock's record, and the service built over them. platform/runtime.ts builds it
// with the whole VaultService (the settings page, the service worker); the popup builds it with ServiceCore alone
// (createPopupRuntime below), the part of the service it uses, so the rest of the service is not in its bundle
// (docs/design/notes/BUDGET-NOTES.md). Moved here from runtime.ts unchanged, the service's class aside. (The server
// sync's light local side and its outbox were here too, until its client went: OWNER-DECISIONS/25, DV-0b.)
import { PinStore } from "../core/service/pin-store";
import { PrfStore } from "../core/service/prf-store";
import { PwFormatStore } from "../core/service/pw-format";
import { SecurityLog, securityReader } from "../core/service/security-log";
import { ServiceCore, type ServiceDeps, type VkRecord } from "../core/service/service-core";
import { KvSettingsStore } from "../core/service/types";
import type { KV } from "../core/storage/kv";
import { VaultStore } from "../core/storage/store";
import { activeKeyring, noReadableVault } from "../core/storage/active-keyring";
import { ChromeLocalKV } from "./chrome-kv";
import { CSB_CFG_KEY, CSB_STATE_KEY, markCsbHeld } from "./cloud-mark";
import { createDiagLogger } from "./diag";
import { IdbKV } from "./idb-kv";
import { webLock } from "./locks";
import { ChromeSessionCache, RoutedSession } from "./session";

/**
 * Where the runtime keeps things; each one defaults to the browser's own. Tests pass counting fakes, so the popup's real
 * wiring can be measured (test/unit/read-budget.test.ts). `mirror: null` means no mirror.
 */
export type RuntimeStorage = {
  local?: chrome.storage.StorageArea;
  session?: chrome.storage.StorageArea;
  mirror?: KV | null;
};

export function buildRuntime<S>(o: RuntimeStorage, make: (deps: ServiceDeps) => S) {
  const local = new ChromeLocalKV(o.local);
  const mirror =
    o.mirror === null ? undefined : (o.mirror ?? (typeof indexedDB !== "undefined" ? new IdbKV() : undefined));
  const onDiag = createDiagLogger(local);
  const store = new VaultStore({
    kv: local,
    ...(mirror ? { mirror } : {}),
    lock: webLock("sixkey-vault"),
    onDiag,
    // the backup in Chrome sync's link marked held, so nothing is written over a slot that may be newer than this data
    // until a page merges it (CSB: core/cloud/slots.ts rule 3)
    beforeRecoveryWrite: () => markCsbHeld(local, webLock("sixkey-csb")),
  });
  // with the settings, the backup in Chrome sync's two records: the popup's pill and footer show them, and the open reads
  // nothing more for them (src/popup/main/CsbPop.tsx; test/e2e/perf.spec.ts)
  const settings = new KvSettingsStore(local, [CSB_CFG_KEY, CSB_STATE_KEY]);
  const session = new RoutedSession(new ChromeSessionCache(o.session), settings);
  // Local only (never the mirror), its own lock across contexts; constructing it reads nothing (security-log.ts).
  const log = new SecurityLog({ kv: local, lock: webLock("sixkey-security-log"), onDiag });
  // The PIN's set-up (QUICK-UNLOCK §5.2): written only under the store's own lock, and moved by the one cleanup entry
  // point after a key change; its try counter has a lock of its own across contexts.
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
    vkRecords: [pins, prfs, grants],
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
    diag: onDiag,
    formats,
  };
}

/** The popup's runtime: the same wiring, with the part of the service the popup uses. */
export function createPopupRuntime(o: RuntimeStorage = {}) {
  return buildRuntime(o, (deps) => new ServiceCore(deps));
}
export type PopupRuntime = ReturnType<typeof createPopupRuntime>;
