// The service worker module (src/background/sw.ts) loaded over fake chrome.* APIs, with an ordered log of the calls the
// access-level and sender tests care about, and counters for the observable effect of each message type. Used by
// test/unit/autofill-pre-sender.test.ts and autofill-pre-storage.test.ts, and by sidepanel-mode.test.ts, which drives the
// toolbar icon (chrome.action, chrome.sidePanel: `panel: false` leaves the side panel API out, as another browser would).
// storage.sync is test/helpers/fake-sync-area.ts's (Chrome's quotas and texts), with the access level answered as
// `sync` says (the backup in Chrome's sync storage: CSB-3).
import "fake-indexeddb/auto";
import { vi } from "vitest";
import { FakeSyncArea } from "./fake-sync-area";

type Listener = (...args: unknown[]) => unknown;
export const SELF = "abcdefghijklmnopabcdefghijklmnop";
export const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
export const API = "https://api.sixkey.app/*";
export const url = (path: string, id = SELF) => `chrome-extension://${id}${path}`;

export type AccessBehaviour = "ok" | "reject" | "throw" | "hang" | "absent";
export type WorldOptions = {
  local?: AccessBehaviour;
  session?: AccessBehaviour;
  /** storage.sync's answer to the access level (CSB-3, the maintainers' C7): accepted unless said otherwise. */
  sync?: AccessBehaviour;
  /** storage.sync's items at the start (another computer's slot, say). */
  seedSync?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  dev?: boolean;
  /**
   * The sync user interface's release gate (scripts/sync-ui.mjs, the build's define): open unless false, as in the dev
   * and e2e builds, whose worker has sync; false is the store build's worker, with no sync worker, bridge or transport.
   */
  syncUi?: boolean;
  seedLocal?: Record<string, unknown>;
  panel?: boolean;
  /** More of chrome.*, merged over the fake (chrome.tabs, chrome.scripting, chrome.i18n, ...): the fill shortcut's APIs. */
  chrome?: Record<string, unknown>;
  /**
   * The host permissions granted, as Chrome lists them (getAll): contains() then answers as Chrome matches patterns (one
   * granted pattern covers an asked one: https://*\/* covers every https origin). Absent: contains() is always true and
   * getAll() lists the API origin, as before.
   */
  grants?: string[];
  /** Whether Sixkey holds `scripting` (optional since W1b): held unless false. */
  scripting?: boolean;
  /**
   * The site rules' updater's release gate open (AF3-U2), with the build's values: the pinned keys, the rules origin, the
   * built-in rules' version (scripts/build.mjs's defines). Absent: the gate closed, as in the store build.
   */
  rules?: { keys: unknown; origin: string; baseline: number };
};

/** Whether a granted origin pattern covers an asked one (the scheme, then the host: exact or "*"; paths are all "/*" here). */
export function covers(granted: string, asked: string): boolean {
  const g = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(granted);
  const a = /^(https?):\/\/([^/]+)\/\*$/.exec(asked);
  if (!g || !a) return granted === asked;
  return (g[1] === "*" || g[1] === a[1]) && (g[2] === "*" || g[2] === a[2]);
}

export async function wait(ms = 40) {
  await new Promise((r) => setTimeout(r, ms));
}

function area(name: string, log: string[], behaviour: AccessBehaviour, levels: unknown[]) {
  const data = new Map<string, unknown>();
  const reads: string[][] = [];
  const base = {
    data,
    reads,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      log.push(`${name}.get`);
      reads.push(ks);
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      log.push(`${name}.set`);
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      log.push(`${name}.remove`);
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
  if (behaviour === "absent") return base;
  return {
    ...base,
    setAccessLevel(o: unknown) {
      log.push(`${name}.setAccessLevel`);
      levels.push(structuredClone(o));
      if (behaviour === "throw") throw new Error("setAccessLevel is not supported");
      if (behaviour === "reject") return Promise.reject(new Error("setAccessLevel failed"));
      if (behaviour === "hang") return new Promise<void>(() => undefined);
      return Promise.resolve();
    },
  };
}

export async function loadWorker(o: WorldOptions = {}) {
  vi.resetModules();
  const log: string[] = [];
  const levels = { local: [] as unknown[], session: [] as unknown[], sync: [] as unknown[] };
  const listeners: Record<string, Listener[]> = {
    message: [],
    // the removed plugin platform's listener and port refusal: the worker adds none now (m5-sw-wiring.test.ts)
    messageExternal: [],
    connectExternal: [],
    alarm: [],
    installed: [],
    startup: [],
    idle: [],
    permAdded: [],
    permRemoved: [],
    command: [],
    clicked: [],
    localChanged: [],
    // the removed plugin platform's watch on its proposals: the worker adds none now
    sessionChanged: [],
  };
  const on = (name: string) => ({
    addListener: (l: Listener) => {
      log.push(`addListener:${name}`);
      listeners[name]!.push(l);
    },
  });
  const sent: unknown[] = [];
  const fx = { created: 0, closed: 0, fetched: [] as string[] };
  const alarms = new Map<string, unknown>();
  const local = area("local", log, o.local ?? "ok", levels.local);
  for (const [k, v] of Object.entries(o.seedLocal ?? {})) local.data.set(k, structuredClone(v));
  const session = area("session", log, o.session ?? "ok", levels.session);
  const syncArea = new FakeSyncArea({ items: o.seedSync ?? {} });
  const syncHow = o.sync ?? "ok";
  const sync = Object.assign(syncArea, {
    // the access level, logged with the other two, answered as `sync` says (absent: no such function)
    ...(syncHow === "absent"
      ? {}
      : {
          setAccessLevel(x: unknown) {
            log.push("sync.setAccessLevel");
            levels.sync.push(structuredClone(x));
            if (syncHow === "throw") throw new Error("setAccessLevel is not supported");
            if (syncHow === "reject") return Promise.reject(new Error("setAccessLevel failed"));
            if (syncHow === "hang") return new Promise<void>(() => undefined);
            return Promise.resolve();
          },
        }),
  });
  const badges: string[] = [];
  /** What the worker told the browser about the toolbar icon, in order: ["popup", path] and ["panel", options]. */
  const icon: unknown[][] = [];
  const opened: unknown[] = [];
  /** The chrome.permissions calls, in order: [name, origins]. */
  const perms: [string, string[]][] = [];
  const grants = o.grants ? new Set(o.grants) : null;
  /** The content scripts registered (chrome.scripting's registration calls), by ID, and the calls in order. */
  const registered = new Map<string, Record<string, unknown>>();
  const regLog: string[] = [];
  /** Each tab's badge text and title as the worker set them (chrome.action with a tabId). */
  const tabBadges = new Map<number, { text?: string | null; title?: string }>();
  const chrome = {
    runtime: {
      id: SELF,
      onMessage: on("message"),
      onMessageExternal: on("messageExternal"),
      onConnectExternal: on("connectExternal"),
      onInstalled: on("installed"),
      onStartup: on("startup"),
      getManifest: () => o.manifest ?? { version: "0.1.0" },
      getPlatformInfo: async () => ({}),
      getContexts: async () => (fx.created > fx.closed ? [{}] : []),
      sendMessage: async (m: unknown) => void sent.push(m),
    },
    alarms: {
      onAlarm: on("alarm"),
      get: async (n: string) => (alarms.has(n) ? { name: n } : undefined),
      create: async (n: string, i: unknown) => void alarms.set(n, i),
      clear: async (n: string) => alarms.delete(n),
    },
    idle: { onStateChanged: on("idle") },
    storage: {
      local: { ...local, onChanged: on("localChanged") },
      session: { ...session, onChanged: on("sessionChanged") },
      sync,
    },
    scripting: {
      getRegisteredContentScripts: async (f: { ids: string[] }) =>
        [...registered.values()].filter((s) => f.ids.includes(s.id as string)).map((s) => structuredClone(s)),
      registerContentScripts: async (ss: Record<string, unknown>[]) => {
        log.push("scripting.register");
        for (const s of ss) {
          if (registered.has(s.id as string)) throw new Error(`Duplicate script ID '${String(s.id)}'`);
          registered.set(s.id as string, structuredClone(s));
          regLog.push("register");
        }
      },
      updateContentScripts: async (ss: Record<string, unknown>[]) => {
        for (const s of ss) registered.set(s.id as string, structuredClone(s));
        regLog.push("update");
      },
      unregisterContentScripts: async (f: { ids: string[] }) => {
        for (const id of f.ids) registered.delete(id);
        regLog.push("unregister");
      },
    },
    commands: { onCommand: on("command"), getAll: async () => [{ name: "fill", shortcut: "Alt+Shift+F" }] },
    i18n: {
      getMessage: (k: string, s?: string[]) => `${k}${s ? `:${s.join(",")}` : ""}`,
      getUILanguage: () => "en-US", // the cloud backup's file names (CLOUDBK patch 4)
    },
    action: {
      setBadgeText: async (d: { text: string; tabId?: number }) => {
        if (d.tabId === undefined) badges.push(d.text);
        else tabBadges.set(d.tabId, { ...tabBadges.get(d.tabId), text: d.text });
      },
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async (d: { tabId?: number; title: string }) => {
        if (d.tabId !== undefined) tabBadges.set(d.tabId, { ...tabBadges.get(d.tabId), title: d.title });
      },
      setPopup: async (d: { popup: string }) => {
        log.push("action.setPopup");
        icon.push(["popup", d.popup]);
      },
      openPopup: async () => void icon.push(["openPopup"]),
      onClicked: on("clicked"),
    },
    ...(o.panel === false
      ? {}
      : {
          sidePanel: {
            setOptions: async (d: unknown) => {
              log.push("sidePanel.setOptions");
              icon.push(["panel", structuredClone(d)]);
            },
            open: async (d: unknown) => {
              log.push("sidePanel.open");
              opened.push(structuredClone(d));
            },
          },
        }),
    offscreen: {
      createDocument: async () => void fx.created++,
      closeDocument: async () => void fx.closed++,
    },
    permissions: {
      contains: async (p: { origins?: string[]; permissions?: string[] }) => {
        // an API permission, not logged with the hosts: `scripting` (optional since W1b) held unless the test says it is
        // not; `management` never held here (no test plugin); the clipboard's held, as before
        if (!p.origins)
          return (p.permissions ?? []).every((x) => (x === "scripting" ? o.scripting !== false : x !== "management"));
        perms.push(["contains", p.origins]);
        return !grants || p.origins.every((a) => [...grants].some((g) => covers(g, a)));
      },
      request: async (p: { origins: string[] }) => {
        perms.push(["request", p.origins]);
        return false;
      },
      remove: async (p: { origins: string[] }) => {
        perms.push(["remove", p.origins]);
        return !!grants && p.origins.every((x) => grants.delete(x));
      },
      getAll: async () => ({ origins: grants ? [...grants] : [API] }),
      onAdded: on("permAdded"),
      onRemoved: on("permRemoved"),
    },
  };
  vi.stubGlobal("chrome", {
    ...chrome,
    ...o.chrome,
    action: { ...chrome.action, ...(o.chrome?.action as object | undefined) },
  });
  if (o.dev !== undefined) vi.stubGlobal("__SYNC_DEV__", o.dev); // the build's define (scripts/build.mjs)
  vi.stubGlobal("__SYNC_UI__", o.syncUi ?? true); // and the sync release gate's
  if (o.rules) {
    vi.stubGlobal("__RULES_UPDATE__", true);
    vi.stubGlobal("__SK_RULES_KEYS__", o.rules.keys);
    vi.stubGlobal("__SK_RULES_ORIGIN__", o.rules.origin);
    vi.stubGlobal("__SK_RULES_BASELINE__", o.rules.baseline);
  }
  vi.stubGlobal("fetch", async (u: string) => {
    fx.fetched.push(u);
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  });
  await import("../../src/background/sw");
  await wait(60); // the start's own reads
  const syncReads = () => local.reads.filter((k) => k.includes("sk_sync_state")).length;
  /** Every message listener is called, as the browser does; the return values say which kept the channel open. */
  const answers: { type: unknown; reply: unknown }[] = [];
  const send = (msg: unknown, sender: unknown, respond: (r: unknown) => void = () => undefined) =>
    listeners.message!.map((l) =>
      l(msg, sender, (reply: unknown) => {
        answers.push({ type: (msg as { type?: unknown } | null)?.type, reply }); // every answer, of every listener
        respond(reply);
      }),
    );
  return {
    chrome,
    listeners,
    log,
    levels,
    sent,
    fx,
    local,
    session,
    sync: syncArea,
    alarms,
    badges,
    syncReads,
    send,
    answers,
    icon,
    opened,
    perms,
    grants,
    registered,
    regLog,
    tabBadges,
  };
}
export type World = Awaited<ReturnType<typeof loadWorker>>;

export const unload = () => vi.unstubAllGlobals();
