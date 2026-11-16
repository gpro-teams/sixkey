// A settings page's world for the backup in Chrome's sync storage's pages (test/unit/csb-pages-dom.test.ts,
// csb-firstrun-dom.test.ts): the real service and store over one storage.local (with its change event), the real worker
// (platform/csb-worker.ts) over the same storage.local and a fake storage.sync (test/helpers/fake-sync-area.ts), and a
// stand-in chrome.* whose runtime.sendMessage hands the page's sk-csb-* messages to that worker as the service worker's
// handler table does (src/background/sw.ts CSB_HANDLERS). The store's lock is the one the worker's two hold-lifting
// handlers take first, and the store's recovery hook marks the link held under the records' lock, as in the extension
// (platform/runtime-base.ts). A test can answer a message in its place (`answer`) and see every message sent (`sent`).
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { createMutex, MemoryKV, type Lock } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { addEntry } from "../../src/core/vault/ops";
import { markCsbHeld } from "../../src/platform/cloud-mark";
import { createCsbWorker } from "../../src/platform/csb-worker";
import { account } from "./cloud";
import { FakeSyncArea } from "./fake-sync-area";
import { TEST_KDF_ITERATIONS } from "./kdf";

type Listener = (changes: Record<string, unknown>) => void;
export function events() {
  const ls = new Set<Listener>();
  return {
    addListener: (l: Listener) => void ls.add(l),
    removeListener: (l: Listener) => void ls.delete(l),
    fire: (c: Record<string, unknown>) => ls.forEach((l) => l(c)),
    count: () => ls.size,
  };
}

/** storage.local as a page sees it: a MemoryKV whose writes fire onChanged with the keys they touched. */
export class EventKV extends MemoryKV {
  readonly onChanged = events();
  override async set(items: Record<string, unknown>): Promise<void> {
    await super.set(items);
    this.onChanged.fire(Object.fromEntries(Object.keys(items).map((k) => [k, { newValue: items[k] }])));
  }
  override async remove(keys: string[]): Promise<void> {
    await super.remove(keys);
    this.onChanged.fire(Object.fromEntries(keys.map((k) => [k, {}])));
  }
}

export const STRONG = "Lantern#Orbit7!Tulip2$Mesa";
export const T0 = 1_900_000_000_000;

export type Answer = Record<string, unknown> | undefined;

/**
 * One computer: its storage.local, service, store, worker and storage.sync; `access`: whether the worker's start closed
 * storage.sync to web pages.
 */
export function computer(o: { area?: FakeSyncArea; access?: boolean } = {}) {
  const kv = new EventKV();
  const session = Object.assign(new MemoryKV(), { onChanged: events() });
  // the store's lock, counted while held: whether a message was sent from inside it (`lockedAt`)
  const storeMutex = createMutex();
  let holding = 0;
  const vaultLock: Lock = (fn) =>
    storeMutex(async () => {
      holding++;
      try {
        return await fn();
      } finally {
        holding--;
      }
    });
  const recordsLock = createMutex();
  let now = T0;
  const store = new VaultStore({
    lock: vaultLock,
    kv,
    now: () => now,
    beforeRecoveryWrite: () => markCsbHeld(kv, recordsLock),
  });
  const settings = new KvSettingsStore(kv);
  const service = new VaultService({
    store,
    session: new MemorySession(),
    settings,
    now: () => now,
    kdfIterations: TEST_KDF_ITERATIONS,
  });
  const area = o.area ?? new FakeSyncArea({ now: () => now });
  const alarms = new Map<string, number>();
  const notes: string[] = [];
  const access = { ok: o.access ?? true };
  const worker = createCsbWorker({
    kv,
    lock: recordsLock,
    vaultLock,
    load: () => store.load(),
    alarms: {
      create: (name, info) => void alarms.set(name, info.when),
      clear: async (name) => alarms.delete(name),
    },
    now: () => now,
    app: "Sixkey 0.0.0",
    access: async () => access.ok,
    note: (line) => void notes.push(line),
    area: area as never,
  });
  const handlers: Record<string, (m: Record<string, unknown>) => Promise<unknown>> = {
    "sk-csb-on": () => worker.on(),
    "sk-csb-off": () => worker.off(),
    "sk-csb-now": () => worker.now(),
    "sk-csb-opens": (m) => worker.opens(m.opens).then((ok) => ({ ok })),
    "sk-csb-restored": (m) => worker.restored(m),
    "sk-csb-merged": (m) => worker.merged(m),
    "sk-csb-drop": (m) => worker.drop(m),
  };
  const sent: Record<string, unknown>[] = [];
  /** For each message sent, whether the store's lock was held then (the page's commit, before it let go). */
  const lockedAt: boolean[] = [];
  /** Answers a test gives in the worker's place, per type, first come first used; the worker answers the rest. */
  const answer: Record<string, Answer[]> = {};
  /**
   * What happens between a message's sending and the worker's handling of it, per type, first come first used (another
   * page's save, a fallback, another computer's write arriving): run once the page has let the store's lock go.
   */
  const meanwhile: Record<string, ((m: Record<string, unknown>) => Promise<void>)[]> = {};
  const chromeStub = {
    storage: { local: kv, session, sync: area },
    runtime: {
      sendMessage: async (m: Record<string, unknown>) => {
        sent.push(m);
        lockedAt.push(holding > 0);
        const type = m.type as string;
        if (answer[type]?.length) return answer[type]!.shift();
        const between = meanwhile[type]?.shift();
        if (between) await vaultLock(() => between(m)); // after the page's commit let go, before the worker takes over
        return handlers[type]?.(m) ?? { ok: false };
      },
    },
    tabs: { create: async () => undefined },
    permissions: { contains: async () => true, request: async () => true },
  };
  const rt = { service, settings, local: kv, store } as never;
  return {
    kv,
    session,
    store,
    service,
    settings,
    area,
    alarms,
    notes,
    access,
    worker,
    sent,
    lockedAt,
    answer,
    meanwhile,
    vaultLock,
    chrome: chromeStub,
    rt,
    types: () => sent.map((m) => m.type),
    setNow: (t: number) => void (now = t),
    /** A vault made by first run's steps, with the master password `password`, unlocked; its recovery key. */
    async makeVault(password = STRONG, preset: "standard" | "shared" = "standard") {
      const keys = await service.prepareKeys(password, {});
      const code = keys.recoveryCode;
      await service.create(keys, { preset });
      return code;
    },
    /** Accounts added, as Add account adds them. */
    async add(...names: string[]) {
      await service.mutate((v, clock) =>
        names.reduce((x, n, i) => addEntry(x, account(n, `JBSWY3DPEHPK3PX${"ABCDEFGHIJ"[i % 10]}`), clock).vault, v),
      );
    },
  };
}
export type Computer = ReturnType<typeof computer>;
