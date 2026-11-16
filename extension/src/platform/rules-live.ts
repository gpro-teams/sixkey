// The site rules' updater (TOTP autofill Stage 3, AF3-U2; docs/design/notes/AUTOFILL3-NOTES.md §10; the plan's §5): in the
// worker alone, behind its release gate (scripts/rules-update.mjs; with the gate closed, scripts/rules-guard.mjs keeps
// this module out of every build). Only the worker imports it (background/sw.ts, through the gate's branch), and it is
// the one module that opens the updater's database, `sixkey-rules-live`: pages never do (the plan's S9, N14). They ask
// the worker instead: the Fill paths for one host's rule (`sk-af-rule`, platform/site-rule.ts), Settings for the switch
// and its status line (`sk-af-rules-status`, options/RulesUpdate.tsx).
//
// What it keeps, in one IndexedDB object store: the switch (SWITCH_KEY, off unless it was turned on), the record of
// core/rules/signed.ts ({kid, version, retired, held}: the floor, the retired keys, the bundle in use), when the next
// daily check is due, and when the bundle in use was taken (the status line's date). Nothing of the user's: no account,
// site or page. Never in chrome.storage, so no storage read of any page or of the worker's start changes (the plan's §6:
// perf and W2B-04).
//
// - The daily check (check(), on `sk-daily`, every 6 hours): with the switch on, and the next check due (24 hours after
//   the last one, plus a random 0 to 6 hours; a due time further away than that, set while the clock was ahead, is due
//   at once: the review's N2), the signed manifest; checkManifest (signed.ts: the pinned key, the
//   signature, the times, the version above the built-in rules' and the key's floor); only then the bundle it names,
//   and checkSigned with the format's whole checker (format.ts validate, a live bundle; the e2e build allows its reserved
//   test hosts); one attempt each. A bundle accepted is written in a transaction that reads the switch again first: a
//   switch turned off while the bundle was being fetched is never overwritten by a record holding one (§9.8). "No newer
//   version" is the usual answer of a daily check, not an error ("same").
// - The answer to a Fill path (answer(host)): with the switch off, or no live bundle in use (none, expired, reached by
//   the built-in rules, or no longer a valid live bundle), null, and the Fill path reads its own package. With one in
//   use, its version and that host's rule, or null for a host it has none for: the live bundle replaces the built-in
//   rules whole (the plan's R4-1, C24), so a host it does not name has no rule, whatever the package says.
// - The switch (status(on)): off deletes the bundle in the same transaction and keeps the floor and the retired keys
//   (signed.ts switchedOff: off and on again is not a fresh install, M3 NIT c); the record is ignored while it is off
//   (S8). On asks for a check at once.
// - The pinned keys (the build's, scripts/rules-keys.mjs, through the define) are imported once per worker life; if that
//   fails, the updater reads, writes and answers nothing (signed.ts's functions are called with a successful
//   importPinned's keys only: AF3-U1 §9.8).
import { canonicalHost } from "../core/match";
import { isShared } from "../core/site-domains";
import { validate, type Bundle } from "../core/rules/format";
import { ruleFor, type Found } from "../core/rules/lookup";
import {
  BOUNDS,
  checkManifest,
  checkSigned,
  heldBundle,
  importPinned,
  readRecord,
  switchedOff,
  type Checker,
  type Context,
  type LiveRecord,
  type Pinned,
} from "../core/rules/signed";
import { getCapped } from "./rules-fetch";

/** The updater's database: the worker's alone (check-dist refuses the name in any page's script). */
export const DATABASE = "sixkey-rules-live";
const STORE = "kv";
/** The switch's key in the database (check-dist looks for it: in the worker only, and in no build without the updater). */
export const SWITCH_KEY = "sk_rules_switch";
const RECORD = "record";
const DUE = "due";
const GOT = "got";
const KEYS = [SWITCH_KEY, RECORD, DUE, GOT] as const;

/** A daily check is due this long after the last one, plus a random part of JITTER_MS (the plan's §5.3, C19). */
export const DAY_MS = 86_400_000;
export const JITTER_MS = 6 * 3_600_000;

/** What `sk-af-rule` answers: null, no live bundle in use; else its version and the host's rule in it (null: none). */
export type Answer = { v: number; rule: Found | null } | null;
/** What `sk-af-rules-status` answers. `floor`: the version a new bundle must pass, when it is above the built-in one. */
export type Status = {
  on: boolean;
  /** The live bundle in use, its version, and when this browser took it; null when the built-in rules are in use. */
  v: number | null;
  got: number | null;
  /** The built-in rules' version. */
  base: number;
  floor: number | null;
  /** The rules origin's host, for the switch's words. */
  host: string;
};
/**
 * How a check ended: "off" (the switch), "later" (not due), "keys" (no pinned key could be imported), "net" (a read
 * failed: network, CORS, a redirect, a status, too large or too slow), "same" (no newer version), "manifest" (the
 * manifest refused), "bundle" (the bundle refused), "new" (a bundle taken).
 */
export type Outcome = "off" | "later" | "keys" | "net" | "same" | "manifest" | "bundle" | "new";

type State = { [SWITCH_KEY]?: unknown; record?: unknown; due?: unknown; got?: unknown };
type Change = Partial<Record<(typeof KEYS)[number], unknown>>;

export type UpdaterDeps = {
  idb: IDBFactory;
  get: typeof fetch;
  now(): number;
  random(): number;
  /** The pinned keys as the build lists them (importPinned checks them). */
  keys: unknown;
  /** The rules origin (https, no path): the manifest is at /v1/manifest.json, a bundle at /v1/bundle-<version>.json. */
  origin: string;
  /** The built-in rules' version (the package's rules/baseline.json). */
  baseline: number;
  /** The e2e build's: its test bundles name hosts under reserved names. */
  allowReserved: boolean;
};
export type Updater = {
  check(force?: boolean): Promise<Outcome>;
  answer(host: string): Promise<Answer>;
  status(on?: boolean): Promise<Status>;
};

export function createUpdater(d: UpdaterDeps): Updater {
  const checker: Checker = {
    validate,
    checks: { canonicalHost, isShared },
    options: { allowReserved: d.allowReserved },
  };
  let pinnedP: Promise<Pinned[] | null> | undefined;
  const pinned = () => (pinnedP ??= importPinned(d.keys).then((r) => (r.ok && r.value.length > 0 ? r.value : null)));
  let dbP: Promise<IDBDatabase> | undefined;
  const db = () =>
    (dbP ??= new Promise<IDBDatabase>((ok, no) => {
      const r = d.idb.open(DATABASE, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    }).catch((e: unknown) => {
      dbP = undefined; // a failed open is tried again at the next call
      throw e;
    }));

  /** One transaction: the state, then (with `change`) what it returns written over it (null or undefined: deleted). */
  async function tx(change?: (s: State) => Change | undefined): Promise<{ s: State; wrote: boolean }> {
    const t = (await db()).transaction(STORE, change ? "readwrite" : "readonly");
    const store = t.objectStore(STORE);
    const s: State = {};
    let wrote = false;
    let left = KEYS.length;
    for (const k of KEYS) {
      const r = store.get(k);
      r.onsuccess = () => {
        if (r.result !== undefined) s[k] = r.result;
        if (--left > 0 || !change) return;
        const w = change(s);
        if (!w) return;
        wrote = true;
        for (const [key, v] of Object.entries(w)) {
          if (v === undefined || v === null) store.delete(key);
          else store.put(v, key);
        }
      };
    }
    return new Promise((ok, no) => {
      t.oncomplete = () => ok({ s, wrote });
      t.onerror = t.onabort = () => no(t.error);
    });
  }

  const ctxAt = (keys: Pinned[]): Context => ({ now: d.now(), baseline: d.baseline, pinned: keys });
  /** The record as it is to be read now; what readRecord deletes is deleted (written again in a transaction of its own). */
  async function current(keys: Pinned[]): Promise<{ on: boolean; record: LiveRecord | null; got: unknown }> {
    const { s } = await tx();
    const on = s[SWITCH_KEY] === true;
    if (!on) return { on, record: null, got: undefined }; // the record is not used while the switch is off (S8)
    const ctx = ctxAt(keys);
    const r = readRecord(s.record, ctx);
    if (r.changed)
      await tx((cur) => {
        const again = readRecord(cur.record, ctx);
        return again.changed ? { [RECORD]: again.record } : undefined;
      });
    return { on, record: r.record, got: s.got };
  }

  let parsed: { key: string; bundle: Bundle | null } | undefined;
  /** The record's bundle, checked again as a live bundle of its version (once per worker life and version). */
  function inUse(record: LiveRecord | null, keys: Pinned[]): Bundle | null {
    if (!record?.held) return null;
    const key = `${record.kid} ${record.version} ${record.held.expires}`;
    if (parsed?.key !== key) parsed = { key, bundle: heldBundle(record, ctxAt(keys), checker) };
    return parsed.bundle;
  }

  async function answer(host: string): Promise<Answer> {
    const keys = await pinned();
    if (!keys) return null;
    const live = inUse((await current(keys)).record, keys);
    return live ? { v: live.version, rule: ruleFor(host, live) } : null;
  }

  async function run(force: boolean): Promise<Outcome> {
    const keys = await pinned();
    if (!keys) return "keys";
    const ctx = ctxAt(keys);
    const { s } = await tx();
    if (s[SWITCH_KEY] !== true) return "off";
    // not due yet; a due time further away than a check can set (a clock that was ahead when it was set) is due now
    if (!force && typeof s.due === "number" && ctx.now < s.due && s.due <= ctx.now + DAY_MS + JITTER_MS) return "later";
    const due = ctx.now + DAY_MS + Math.floor(d.random() * JITTER_MS);
    await tx((cur) => (cur[SWITCH_KEY] === true ? { [DUE]: due } : undefined));
    const file = await getCapped(`${d.origin}/v1/manifest.json`, BOUNDS.signedFile, d.get);
    if (!file) return "net";
    const text = new TextDecoder().decode(file);
    const m = await checkManifest(text, s.record, ctx);
    if (!m.ok) return m.error.startsWith("m.version: not above") ? "same" : "manifest";
    const bundle = await getCapped(`${d.origin}/v1/bundle-${m.value.manifest.version}.json`, BOUNDS.bundle, d.get);
    if (!bundle) return "net";
    const c = await checkSigned(text, bundle, s.record, ctx, checker);
    if (!c.ok) return "bundle";
    // written only if the switch is still on (read again in this transaction: §9.8)
    const { wrote } = await tx((cur) =>
      cur[SWITCH_KEY] === true ? { [RECORD]: c.value.record, [GOT]: d.now() } : undefined,
    );
    return wrote ? "new" : "off";
  }
  let queue: Promise<unknown> = Promise.resolve();
  /** One check at a time: a call made while one runs starts after it ends. */
  function check(force = false): Promise<Outcome> {
    const next = queue.then(() => run(force));
    queue = next.catch(() => undefined);
    return next;
  }

  async function status(on?: boolean): Promise<Status> {
    if (on === false) await tx((cur) => ({ [SWITCH_KEY]: false, [RECORD]: switchedOff(cur.record), [GOT]: null }));
    if (on === true) {
      await tx(() => ({ [SWITCH_KEY]: true }));
      await check(true);
    }
    const keys = await pinned();
    const now = keys ? await current(keys) : { on: (await tx()).s[SWITCH_KEY] === true, record: null, got: undefined };
    const live = keys ? inUse(now.record, keys) : null;
    const floor = now.record && !live && now.record.version > d.baseline ? now.record.version : null;
    return {
      on: now.on,
      v: live ? live.version : null,
      got: live && typeof now.got === "number" ? now.got : null,
      base: d.baseline,
      floor,
      host: new URL(d.origin).host,
    };
  }

  return { check, answer, status };
}

// The build's values (scripts/build.mjs; defined in the builds whose gate lets the updater in, and read only there).
declare const __SK_RULES_KEYS__: unknown;
declare const __SK_RULES_ORIGIN__: string;
declare const __SK_RULES_BASELINE__: number;
declare const __SK_RULES_TEST_HOSTS__: boolean;
let theUpdater: Updater | undefined;
/** The worker's updater (made at its first use). */
export const updater = (): Updater =>
  (theUpdater ??= createUpdater({
    idb: indexedDB,
    get: (url, init) => fetch(url, init),
    now: () => Date.now(),
    random: () => Math.random(),
    keys: __SK_RULES_KEYS__,
    origin: __SK_RULES_ORIGIN__,
    baseline: __SK_RULES_BASELINE__,
    allowReserved: typeof __SK_RULES_TEST_HOSTS__ === "boolean" && __SK_RULES_TEST_HOSTS__,
  }));
