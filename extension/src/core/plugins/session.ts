// What the plugin platform keeps for one browser session, in chrome.storage.session (memory only, trusted contexts
// only): never synced, backed up or exported, and gone when the browser closes. Pure over a KV and a lock.
//   - sk_plugin_seen: the last valid hello of each official or listed plugin (its normalised descriptor, what it could
//     not use, its shortcuts), written by the worker while the plugin platform was there. Its approval screen approved
//     from it (a fresh descriptor, never the stored one of a record that failed its tag), and the popup counted the
//     plugins waiting. Nothing writes it now.
//   - sk_plugin_log: the request log (§10.10), at most 100 entries (20 per plugin) of the time, the plugin, the type and
//     the outcome; never a code, a secret, a URI, an account name, a handle or text a plugin supplied: a type that is
//     not one of this version's requests is "other" (W1a review F3). At most 30 lines a minute per plugin are written,
//     checked before the write (F11), so one plugin's flood neither crowds out the others nor queues on the lock.
//   - sk_plugin_window: the interaction window (§6.4 item 1 (a)), one per plugin: the slot clicked and when, and for an
//     account slot (wave 2a) a SHA-256 of the account's handle (no storage holds a handle, §10.10), so that what the click
//     allows is for that account only.
//   - sk_plugin_env: the theme and language a Sixkey page last resolved, for the worker's env.get (a worker has
//     neither localStorage nor matchMedia; PLUGINS-W1A-NOTES.md §4.3).
import type { KV, Lock } from "../storage/kv";
import { isStoredDescriptor, isObject, EXTENSION_ID, type Descriptor, type SlotName } from "./descriptor";
import { sha256Hex } from "./jcs";
import { REQUEST_TYPES } from "./protocol";
import { isShortcut } from "./text";

export const SEEN_KEY = "sk_plugin_seen";
export const LOG_KEY = "sk_plugin_log";
export const WINDOW_KEY = "sk_plugin_window";
export const ENV_KEY = "sk_plugin_env";

/** At most this many plugins wait for an approval at once (§5.4); a hello from one more is answered `rate`. */
export const MAX_WAITING = 8;
const MAX_SEEN = 32;
const MAX_LOG = 100;
const MAX_LOG_EACH = 20;
const LOG_RATE = 30;
/** The interaction window (§2.2, §6.4 item 1 (a)): 120 s after a Sixkey-verified click, one surface opening. */
export const WINDOW_MS = 120_000;

export type Seen = {
  pluginId: string;
  at: number;
  descriptor: Descriptor;
  unavailable: string[];
  keys: Record<string, string>;
};
export type LogEntry = { at: number; pluginId: string; type: string; outcome: string };

const UNAVAILABLE = /^(capability|contribution|locale):.{1,80}$/u;
const HANDLE = /^[a-z2-7]{16}$/;
const HASH = /^[0-9a-f]{64}$/;
/** What the window keeps of a clicked account: a hash of its handle, never the handle (§10.10). */
const accountMark = (handle: string): Promise<string> => sha256Hex(`sixkey/v1/plugin-window\u0000${handle}`);
/** The outcomes the log may hold: Sixkey's own words (error codes, ok, port-refused, sent, ...). */
const LOG_WORD = /^[a-z][a-z.-]{0,31}$/;
/** The types it may hold: this version's request types and Sixkey's own two; anything else is "other" (§10.10). */
const LOG_TYPES: ReadonlySet<string> = new Set<string>([...REQUEST_TYPES, "port", "slot.invoked", "other"]);
const typeWord = (t: unknown) => (typeof t === "string" && LOG_TYPES.has(t) ? t : "other");
/** The lines written in this context in the last minute, per plugin (the log's own rate, F11). */
const written = new Map<string, number[]>();

function parseSeen(x: unknown): Seen[] {
  if (!isObject(x) || x.v !== 1 || !Array.isArray(x.seen)) return [];
  return x.seen
    .slice(0, MAX_SEEN)
    .filter(
      (e): e is Seen =>
        isObject(e) &&
        typeof e.pluginId === "string" &&
        EXTENSION_ID.test(e.pluginId) &&
        Number.isSafeInteger(e.at) &&
        isStoredDescriptor(e.descriptor) &&
        e.descriptor.id === e.pluginId &&
        Array.isArray(e.unavailable) &&
        e.unavailable.every((u) => typeof u === "string" && UNAVAILABLE.test(u)) &&
        isObject(e.keys) &&
        Object.values(e.keys).every(isShortcut),
    );
}

export class PluginSession {
  constructor(
    private readonly kv: KV,
    private readonly lock: Lock,
  ) {}

  async seen(): Promise<Seen[]> {
    return parseSeen((await this.kv.get([SEEN_KEY]))[SEEN_KEY]);
  }

  /**
   * The hellos, and `keys` of the same area in the same read (one get): what the popup's plugin view needs of P2's
   * proposals rides on it, so an open reads no more than before (the W2b review's W2B-04).
   */
  async seenWith(keys: readonly string[]): Promise<{ seen: Seen[]; more: Record<string, unknown> }> {
    const got = await this.kv.get([SEEN_KEY, ...keys]);
    return { seen: parseSeen(got[SEEN_KEY]), more: got };
  }

  /**
   * Keep `s` as its plugin's latest hello. `waiting(id)`: whether that plugin has no grant entry (it waits for an
   * approval); one more of those than MAX_WAITING is refused (false), and nothing is written.
   */
  note(s: Seen, waiting: (id: string) => boolean): Promise<boolean> {
    return this.lock(async () => {
      const cur = (await this.seen()).filter((e) => e.pluginId !== s.pluginId);
      if (waiting(s.pluginId) && cur.filter((e) => waiting(e.pluginId)).length >= MAX_WAITING) return false;
      await this.kv.set({ [SEEN_KEY]: { v: 1, seen: [...cur, s].slice(-MAX_SEEN) } });
      return true;
    });
  }

  async log(): Promise<LogEntry[]> {
    const x = (await this.kv.get([LOG_KEY]))[LOG_KEY];
    if (!isObject(x) || x.v !== 1 || !Array.isArray(x.log)) return [];
    return x.log
      .filter(
        (e): e is LogEntry =>
          isObject(e) &&
          Number.isSafeInteger(e.at) &&
          typeof e.pluginId === "string" &&
          EXTENSION_ID.test(e.pluginId) &&
          typeof e.type === "string" &&
          typeof e.outcome === "string" &&
          LOG_WORD.test(e.outcome),
      )
      .map((e) => ({ at: e.at, pluginId: e.pluginId, type: typeWord(e.type), outcome: e.outcome }));
  }

  /**
   * One line of the request log, unless the plugin has had LOG_RATE lines in the last minute here (checked first: a
   * flood is not written at all). A type that is not a request type of this version, or an outcome that is not a
   * protocol word, is written as "other"; a plugin keeps its last MAX_LOG_EACH lines.
   */
  record(e: LogEntry): Promise<void> {
    const recent = (written.get(e.pluginId) ?? []).filter((t) => t > e.at - 60_000 && t <= e.at);
    if (recent.length >= LOG_RATE) return Promise.resolve();
    written.set(e.pluginId, [...recent, e.at]);
    const clean: LogEntry = {
      at: e.at,
      pluginId: e.pluginId,
      type: typeWord(e.type),
      outcome: LOG_WORD.test(e.outcome) ? e.outcome : "other",
    };
    return this.lock(async () => {
      const cur = [...(await this.log()), clean];
      const mine = cur.filter((l) => l.pluginId === e.pluginId);
      const drop = new Set(mine.slice(0, Math.max(0, mine.length - MAX_LOG_EACH)));
      await this.kv.set({ [LOG_KEY]: { v: 1, log: cur.filter((l) => !drop.has(l)).slice(-MAX_LOG) } });
    });
  }

  /**
   * A Sixkey-verified click on `pluginId`'s entry in `slot` opens its interaction window (§6.4 item 1 (a)). `account`: the
   * handle of the account an account slot's entry was clicked on (the window allows a card or change list for that
   * account only).
   */
  async openWindow(pluginId: string, slot: SlotName, at: number, account?: string): Promise<void> {
    const mark = account !== undefined && HANDLE.test(account) ? await accountMark(account) : undefined;
    return this.lock(async () => {
      const cur = await this.windows();
      const w = { pluginId, slot, at, ...(mark !== undefined ? { account: mark } : {}) };
      await this.kv.set({
        [WINDOW_KEY]: { v: 1, windows: [...cur.filter((x) => x.pluginId !== pluginId), w].slice(-64) },
      });
    });
  }

  async windows(): Promise<{ pluginId: string; slot: SlotName; at: number; account?: string }[]> {
    const x = (await this.kv.get([WINDOW_KEY]))[WINDOW_KEY];
    if (!isObject(x) || x.v !== 1 || !Array.isArray(x.windows)) return [];
    return x.windows.filter(
      (w): w is { pluginId: string; slot: SlotName; at: number; account?: string } =>
        isObject(w) &&
        typeof w.pluginId === "string" &&
        typeof w.slot === "string" &&
        Number.isSafeInteger(w.at) &&
        (w.account === undefined || (typeof w.account === "string" && HASH.test(w.account))),
    );
  }

  /**
   * The one surface a request within `pluginId`'s interaction window may open, and spends it (§6.4 item 1 (a)): what the
   * clicked slot allows, and nothing after 120 s or after it was used once. A click in popup.menu, settings.page or
   * action.menu allows nothing; add.sources the change list for accounts.add; an account slot a card or change list for
   * that account (`account`: the request's handle, which must be the clicked account's). No request of wave 2a opens a
   * surface; W2b's change lists ask here.
   */
  async spendWindow(pluginId: string, wants: "add-list" | "account", now: number, account?: string): Promise<boolean> {
    const mark = account !== undefined && HANDLE.test(account) ? await accountMark(account) : undefined;
    return this.lock(async () => {
      const cur = await this.windows();
      const w = cur.find((x) => x.pluginId === pluginId);
      if (!w || now - w.at > WINDOW_MS || now < w.at) return false;
      if (!windowAllows(w.slot, wants)) return false;
      if (wants === "account" && (w.account === undefined || w.account !== mark)) return false;
      await this.kv.set({ [WINDOW_KEY]: { v: 1, windows: cur.filter((x) => x !== w) } });
      return true;
    });
  }

  async env(): Promise<{ theme: "light" | "dark"; locale: "en" | "zh_CN" } | null> {
    const x = (await this.kv.get([ENV_KEY]))[ENV_KEY];
    if (!isObject(x) || (x.theme !== "light" && x.theme !== "dark") || (x.locale !== "en" && x.locale !== "zh_CN"))
      return null;
    return { theme: x.theme, locale: x.locale };
  }

  /** A Sixkey page's resolved theme and language, for the worker (written only when they differ from what is kept). */
  async setEnv(e: { theme: "light" | "dark"; locale: "en" | "zh_CN" }): Promise<void> {
    const cur = await this.env();
    if (cur?.theme !== e.theme || cur?.locale !== e.locale) await this.kv.set({ [ENV_KEY]: e });
  }
}

/** What a click in `slot` lets a request within the window open (§6.4 item 1 (a), W-11). */
export function windowAllows(slot: SlotName, wants: "add-list" | "account"): boolean {
  if (slot === "add.sources") return wants === "add-list";
  if (slot === "account.actions" || slot === "account.primary") return wants === "account";
  return false;
}
