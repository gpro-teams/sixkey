// The message protocol of the removed plugin platform (session.ts still takes its request types for the log; nothing else
// here is called by any build now): the envelopes, who may send which request,
// the fixed order of checks (§10.6) with the first failure answered, the limits (§10.8) and the errors (§10.7). Wave 1a
// answers `hello` and `env.get`, wave 2a `accounts.list` (P1: only while Sixkey's popup or side panel is open and Sixkey
// is unlocked, and only once the grant store's tag verifies), wave 2b P2's `accounts.add`, `accounts.update` and
// `accounts.trash` (`pendingResult` in every state once steps 1 to 5 pass: the proposal waits for Sixkey's change list,
// where the tag and the rest are checked, and the result comes as request.done, from the change list that went with the
// platform); every other request type of version 1 is recognised, checked in the same order, and ends at `not-granted`
// (nothing grants its capability in this version) or earlier. One function serves both ways in:
// `chrome.runtime.sendMessage` from an official or listed plugin (the worker's listener) and a surface port to an
// unlisted one, both gone with the platform. Every decision about the sender uses the fields the browser filled in
// (`sender.id`, `url`, `origin`, `tab`), or, on a port, the ID Sixkey itself connected to: nothing a message says about
// itself. No text, no browser calls.
import {
  CHROME_VERSION,
  isObject,
  onlyHarmless,
  readDescriptor,
  SDK_MAX,
  SDK_MIN,
  contributionsHash,
  type CapabilityName,
  type Descriptor,
} from "./descriptor";
import type { AccountSummary } from "./accounts";
import { tightened, type GrantEntry, type GrantReason, type Pause } from "./grants";
import { isPlainText, isShortcut, wellFormed } from "./text";
import { heldNow, p0Only, stateOf, trustOf, type Catalog, type Install, type PluginState, type Trust } from "./policy";

export const REQUEST_TYPES = [
  "hello",
  "env.get",
  "accounts.list",
  "accounts.add",
  "accounts.update",
  "accounts.trash",
  "sites.propose",
  "codes.get",
  "codes.arm",
  "codes.forPage",
  "page.candidate",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** The P2 request types this version answers (wave 2b; sites.propose is official-only, and no official plugin uses it). */
export const P2_TYPES = ["accounts.add", "accounts.update", "accounts.trash"] as const;
export type P2Type = (typeof P2_TYPES)[number];
export const isP2 = (t: unknown): t is P2Type => (P2_TYPES as readonly unknown[]).includes(t);

/** A message's type as the request log may hold it: one of this version's request types, else "other" (§10.10). */
export const loggedType = (m: unknown): RequestType | "other" => {
  const t = (m as { type?: unknown } | null)?.type;
  return (REQUEST_TYPES as readonly unknown[]).includes(t) ? (t as RequestType) : "other";
};

export type ErrorCode =
  | "version"
  | "not-approved"
  | "developer-mode"
  | "blocked"
  | "suspended"
  | "disabled"
  | "not-granted"
  | "invalid"
  | "sender"
  | "too-large"
  | "rate"
  | "busy"
  | "unavailable"
  | "waiting"
  | "locked"
  | "denied"
  | "timeout"
  | "not-found"
  | "unsupported"
  | "no-arm"
  | "not-in-front"
  | "not-active"
  | "no-account"
  | "choose"
  | "insecure"
  | "internal";

export type Response =
  | { sdk: number; re: string; ok: true; body: Record<string, unknown> }
  | {
      sdk: number;
      re: string;
      ok: false;
      error: { code: ErrorCode; retryAfterMs?: number; supported?: { min: number; max: number } };
    };

/** What the browser says about a message's sender (chrome.runtime.MessageSender's fields Sixkey reads). */
export type Sender = {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { url?: string };
  frameId?: number;
  documentId?: string;
};

/** §10.2: the kind of sender each type needs. "context": a plugin page or its worker; "port": also on a surface port. */
type SenderRule = "contextOrPort" | "context" | "worker" | "contentScript";
const TYPES: Record<RequestType, { cap?: CapabilityName; tier: 0 | 1 | 2 | 3; sender: SenderRule; classes: string[] }> =
  {
    hello: { tier: 0, sender: "contextOrPort", classes: [] },
    "env.get": { cap: "env.read", tier: 0, sender: "contextOrPort", classes: [] },
    "accounts.list": { cap: "accounts.read", tier: 1, sender: "contextOrPort", classes: ["list"] },
    "accounts.add": { cap: "accounts.add", tier: 2, sender: "context", classes: ["add"] },
    "accounts.update": { cap: "accounts.update", tier: 2, sender: "context", classes: ["update"] },
    "accounts.trash": { cap: "accounts.trash", tier: 2, sender: "context", classes: ["trash"] },
    "sites.propose": { cap: "sites.propose", tier: 2, sender: "context", classes: ["propose"] },
    "codes.get": { cap: "codes.read", tier: 3, sender: "context", classes: ["code"] },
    "codes.arm": { cap: "codes.forPage", tier: 3, sender: "worker", classes: ["arm"] },
    "codes.forPage": { cap: "codes.forPage", tier: 3, sender: "contentScript", classes: ["code"] },
    "page.candidate": { cap: "ui.badge", tier: 0, sender: "contentScript", classes: ["candidate"] },
  };

/** §10.8, per plugin: [count, window in ms] for each class (every request is also in "all"). */
export const LIMITS: Record<string, readonly (readonly [number, number])[]> = {
  all: [[60, 60_000]],
  list: [[10, 60_000]],
  add: [[3, 60_000]],
  update: [[3, 60_000]],
  trash: [[3, 60_000]],
  propose: [[3, 60_000]],
  code: [
    [4, 60_000],
    [20, 3_600_000],
  ],
  arm: [[10, 60_000]],
  candidate: [[10, 60_000]],
};

/** A request's size limit, serialised (§3.3 item 7): 256 KiB, or 1 MiB for accounts.add. */
const sizeLimit = (t: RequestType) => (t === "accounts.add" ? 1 << 20 : 256 << 10);

export type Rate = {
  take(pluginId: string, classes: readonly string[], now: number): { ok: true } | { retryAfterMs: number };
};

/** The limits of §10.8 as sliding windows in memory (a worker that stops starts with none: the windows are short). */
export function createRate(limits = LIMITS): Rate {
  const hits = new Map<string, number[]>();
  return {
    take(pluginId, classes, now) {
      const all = ["all", ...classes];
      let wait = 0;
      for (const cls of all)
        for (const [count, window] of limits[cls] ?? []) {
          const key = `${pluginId}|${cls}|${window}`;
          const seen = (hits.get(key) ?? []).filter((t) => t > now - window);
          hits.set(key, seen);
          if (seen.length >= count) wait = Math.max(wait, seen[0]! + window - now);
        }
      if (wait > 0) return { retryAfterMs: Math.min(3_600_000, Math.ceil(wait)) };
      for (const cls of all)
        for (const [, window] of limits[cls] ?? []) hits.get(`${pluginId}|${cls}|${window}`)!.push(now);
      return { ok: true };
    },
  };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TICKET = /^[A-Za-z0-9_-]{16,64}$/;
const HANDLE = /^[a-z2-7]{16}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const KEY_NAME = /^[A-Za-z0-9_-]{1,32}$/;

const exactly = (o: Record<string, unknown>, keys: readonly string[], required: readonly string[] = keys) =>
  Object.keys(o).every((k) => keys.includes(k)) && required.every((k) => k in o);
const len = (s: string) => Array.from(s).length;
const text = isPlainText;
const arrayOf = (x: unknown, min: number, max: number, each: (v: unknown) => boolean, unique = false) =>
  Array.isArray(x) &&
  x.length >= min &&
  x.length <= max &&
  x.every(each) &&
  (!unique || new Set(x.map((v) => JSON.stringify(v))).size === x.length);

/** Each request's body, strictly (Appendix A: `helloRequest`, `empty`, `accountsAddRequest` ...). */
const BODY: Record<RequestType, (b: Record<string, unknown>) => boolean> = {
  hello: (b) =>
    exactly(b, ["descriptor", "keys"], ["descriptor"]) &&
    (b.keys === undefined ||
      (isObject(b.keys) &&
        Object.keys(b.keys).length <= 8 &&
        Object.entries(b.keys).every(([k, v]) => KEY_NAME.test(k) && typeof v === "string" && v.length <= 64))),
  "env.get": (b) => Object.keys(b).length === 0,
  "accounts.list": (b) => Object.keys(b).length === 0,
  "page.candidate": (b) => Object.keys(b).length === 0,
  "accounts.add": (b) =>
    exactly(b, ["accounts", "source"]) &&
    arrayOf(
      b.accounts,
      1,
      200,
      (a) =>
        isObject(a) &&
        exactly(a, ["uri"]) &&
        typeof a.uri === "string" &&
        a.uri.length <= 2048 &&
        /^otpauth:\/\/(totp|hotp)\//.test(a.uri),
    ) &&
    text(b.source, 1, 40),
  "accounts.update": (b) =>
    exactly(b, ["changes"]) &&
    arrayOf(
      b.changes,
      1,
      100,
      (c) =>
        isObject(c) &&
        exactly(c, ["handle", "issuer", "label", "group"], ["handle"]) &&
        Object.keys(c).length >= 2 &&
        typeof c.handle === "string" &&
        HANDLE.test(c.handle) &&
        (c.issuer === undefined || text(c.issuer, 0, 256)) &&
        (c.label === undefined || text(c.label, 0, 256)) &&
        (c.group === undefined || c.group === null || text(c.group, 1, 64)),
    ) &&
    // each account named once (W2b: two changes of one account in one list would be applied one over the other)
    new Set((b.changes as { handle: string }[]).map((c) => c.handle)).size === (b.changes as unknown[]).length,
  "accounts.trash": (b) =>
    exactly(b, ["handles"]) && arrayOf(b.handles, 1, 100, (h) => typeof h === "string" && HANDLE.test(h), true),
  "sites.propose": (b) =>
    exactly(b, ["handle", "host"]) &&
    typeof b.handle === "string" &&
    HANDLE.test(b.handle) &&
    typeof b.host === "string" &&
    HOST.test(b.host),
  "codes.get": (b) => exactly(b, ["handle"]) && typeof b.handle === "string" && HANDLE.test(b.handle),
  "codes.arm": (b) =>
    exactly(b, ["tab", "docs", "release"], ["tab", "docs"]) &&
    Number.isSafeInteger(b.tab) &&
    (b.tab as number) >= 0 &&
    arrayOf(b.docs, 1, 8, (d) => typeof d === "string" && d.length >= 1 && d.length <= 64, true) &&
    (b.release === undefined || (typeof b.release === "string" && TICKET.test(b.release))),
  "codes.forPage": (b) =>
    exactly(b, ["room"]) && Number.isSafeInteger(b.room) && (b.room as number) >= 6 && (b.room as number) <= 8,
};

/**
 * The kind of a message's sender, from the browser's fields only (§10.2, C1–C4, PRB M0-9 (a)): the plugin's worker
 * (no origin, no tab, its own script), one of its pages (its own origin, and a tab only if that tab is its own page), or
 * a content script (a web origin, in a tab). Anything else is none of these.
 */
export function senderKind(s: Sender, pluginId: string): "worker" | "page" | "contentScript" | null {
  if (s.id !== pluginId) return null;
  const base = `chrome-extension://${pluginId}/`;
  const url = typeof s.url === "string" ? s.url : "";
  if (s.origin === undefined && s.tab === undefined) return url.startsWith(base) ? "worker" : null;
  if (s.origin === `chrome-extension://${pluginId}`)
    return url.startsWith(base) && (s.tab === undefined || (s.tab.url ?? "").startsWith(base)) ? "page" : null;
  if (typeof s.origin === "string" && /^https?:\/\//.test(s.origin) && s.tab !== undefined) return "contentScript";
  return null;
}

/** Whether `s` is the worker script `d` declared, both normalised with new URL() (§4.1, §6.3 item 1). */
export function isDeclaredWorker(s: Sender, pluginId: string, d: Descriptor): boolean {
  if (!d.worker || s.origin !== undefined || s.tab !== undefined || typeof s.url !== "string") return false;
  try {
    return new URL(s.url).href === new URL(d.worker, `chrome-extension://${pluginId}/`).href;
  } catch {
    return false;
  }
}

/** Where a message came from: an extension message, or a surface port Sixkey opened to `pluginId`. */
export type Channel = { kind: "message"; sender: Sender } | { kind: "port" };

/** What a valid `hello` tells the caller to keep (the latest descriptor and keys, §4.2, §5.1). */
export type Hello = { descriptor: Descriptor; unavailable: string[]; keys: Record<string, string>; trust: Trust };

export type Deps = {
  catalog: Catalog;
  /** management.get(pluginId), or null without the permission (§8.2). */
  install: Install;
  now: number;
  rate: Rate;
  sixkeyVersion: string;
  /** The plugin's grant entry as stored, the overlay applied (no tag: §6.6 item 3 lets hello and env.get use it). */
  entry: GrantEntry | undefined;
  pauses: readonly Pause[];
  /** A valid hello: the caller keeps it; false refuses it (too many plugins waiting: §5.4, answered `rate`). */
  seen(h: Hello): Promise<boolean>;
  /** A stored plugin's descriptor changed outside the allow-list, or since its review: the caller tightens it. */
  changed(reason: GrantReason): Promise<void>;
  /** env.get's answer (§6.3): the same in every lock state. */
  env(): Promise<{ theme: "light" | "dark"; locale: string; sixkeyVersion: string }>;
  /**
   * P1 (`accounts.list`, §6.3, §10.6 steps 6 to 8), asked only once steps 1 to 5 have passed (and by a valid hello from a
   * plugin whose stored record holds it: W2A-09). `surface`: whether Sixkey's toolbar popup or its side panel is open now
   * (W2A-02: no page in a tab or a window counts). `vault`: null while Sixkey is locked here; else what its session's key
   * verifies, before any vault is opened (W2A-07 b): the plugin's entry in the grant store (null when the tag fails, or
   * the verified record has no entry for it); `accounts`, the vault opened then and its summaries (null: locked
   * meanwhile); `still`, whether that key is still the session's (W2A-07 a). Absent (a surface port, which no unlisted
   * plugin may use for P1): `unavailable`.
   */
  p1?: {
    surface(): Promise<boolean>;
    vault(): Promise<P1Vault | null>;
  };
  /**
   * P2 (wave 2b; §6.3, §6.4, §10.5), asked only once steps 1 to 5 have passed: keep the proposal for Sixkey's change
   * list (the worker's, gone with the platform), whatever the lock state, and give its ticket; "busy" while this
   * plugin has one waiting (§6.4 item 3), "full" with too many waiting from all plugins. Absent (a surface port, which no
   * P2 request may use: step 1): `not-granted`.
   */
  p2?: { propose(type: P2Type, body: Record<string, unknown>): Promise<{ ticket: string } | "busy" | "full"> };
};

/** What Sixkey unlocked gives P1 (Deps.p1.vault). */
export type P1Vault = {
  entry: GrantEntry | null;
  accounts(): Promise<AccountSummary[] | null>;
  still(): Promise<boolean>;
};

const answer = (sdk: number, re: string, body: Record<string, unknown>): Response => ({ sdk, re, ok: true, body });
const refuse = (sdk: number, re: string, code: ErrorCode, extra: Record<string, unknown> = {}): Response => ({
  sdk,
  re,
  ok: false,
  error: { code, ...extra },
});

/**
 * The first look at a message, before anything is read (§5.4): the request ID it would be answered under, or null to
 * drop it silently (not an object, or no valid `id`: there is nothing to answer to). `page.candidate` is never answered
 * (§10.3), so it is dropped here too in this version (its capability, `ui.badge`, is W3's, official only).
 */
export function requestIdOf(msg: unknown): string | null {
  if (!isObject(msg) || typeof msg.id !== "string" || !REQUEST_ID.test(msg.id)) return null;
  if (msg.type === "page.candidate") return null;
  return msg.id;
}

/** The state `hello` answers (§5.2), from a plugin state. */
const helloState = (s: PluginState) =>
  s.state === "unknown" ? "pending" : s.state === "approved" ? "approved" : s.state;

/**
 * Answer one request, in the order of §10.6, with the first failure. `pluginId`: the sender's ID as the browser gave it
 * (sender.id), or the ID of the port Sixkey opened. null: no answer at all (requestIdOf's cases).
 */
export async function dispatch(msg: unknown, pluginId: string, ch: Channel, deps: Deps): Promise<Response | null> {
  const re = requestIdOf(msg);
  if (re === null) return null;
  const m = msg as Record<string, unknown>;
  const type = (REQUEST_TYPES as readonly unknown[]).includes(m.type) ? (m.type as RequestType) : null;
  const rule = type ? TYPES[type] : null;
  const sdkOut = SDK_MAX;
  const { trust, entry: cat } = trustOf(deps.catalog, pluginId, deps.install);

  // 1. the sender kind for the type (§10.2)
  if (rule) {
    if (ch.kind === "port") {
      if (rule.sender !== "contextOrPort") return refuse(sdkOut, re, "sender");
    } else {
      const kind = senderKind(ch.sender, pluginId);
      const ok =
        rule.sender === "contentScript"
          ? kind === "contentScript"
          : rule.sender === "worker"
            ? kind === "worker" &&
              deps.entry !== undefined &&
              isDeclaredWorker(ch.sender, pluginId, deps.entry.descriptor)
            : kind === "worker" || kind === "page";
      if (!ok) return refuse(sdkOut, re, "sender");
    }
  }

  // the plugin's state now; for listed plugins the stored contributions are held to the catalog's pin (§4.2 item 3)
  const storedHash = trust === "listed" && deps.entry ? await contributionsHash(deps.entry.descriptor) : undefined;
  // a hello brings the version the plugin has now: minVersion is held to it (with `management`, Chrome's counts; F5)
  const said =
    type === "hello" ? (m.body as { descriptor?: { version?: unknown } } | undefined)?.descriptor?.version : undefined;
  const state = stateOf(deps.catalog, pluginId, deps.entry, {
    install: deps.install,
    pauses: deps.pauses,
    ...(storedHash !== undefined ? { storedHash } : {}),
    ...(typeof said === "string" && CHROME_VERSION.test(said) ? { version: said } : {}),
  });

  // 2. the approval state (hello is how a plugin learns it: answered below, not refused)
  if (type !== "hello") {
    if (state.state === "unknown") return refuse(sdkOut, re, "not-approved");
    if (state.state === "blocked") return refuse(sdkOut, re, "blocked");
    if (state.state === "disabled") return refuse(sdkOut, re, "disabled");
    if (state.state === "suspended") return refuse(sdkOut, re, "suspended");
    if (rule?.tier === 1 && trust === "unlisted") return refuse(sdkOut, re, "developer-mode"); // no developer mode in wave 1
  }

  // 3. the schema: the envelope strictly, its version, the body, the size
  if (
    !type ||
    !exactly(m, ["sdk", "id", "type", "body"]) ||
    !isObject(m.body) ||
    !Number.isSafeInteger(m.sdk) ||
    (m.sdk as number) < 1
  )
    return refuse(sdkOut, re, "invalid");
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(m)).length;
  } catch {
    return refuse(sdkOut, re, "invalid");
  }
  if (size > sizeLimit(type)) return refuse(sdkOut, re, "too-large");
  // a lone surrogate anywhere is not JSON Sixkey can keep (§2.3 item 1): refused here, before the body is read (F-1)
  if (!wellFormed(m) || !BODY[type](m.body as Record<string, unknown>)) return refuse(sdkOut, re, "invalid");

  if (type === "hello") return hello(m, re, pluginId, trust, cat, state, deps);

  // every later request carries the negotiated version (§5.3)
  if (m.sdk !== SDK_MAX) return refuse(sdkOut, re, "version", { supported: { min: SDK_MIN, max: SDK_MAX } });

  // 4. the capability is in the stored record (no tag) and within the level's ceiling (§6.2, §8.3)
  const entry = (state as { entry: GrantEntry }).entry;
  if (!rule!.cap || !heldNow(entry, trust, cat).includes(rule!.cap)) return refuse(sdkOut, re, "not-granted");

  // 5. the rate (§10.8)
  const r = deps.rate.take(pluginId, rule!.classes, deps.now);
  if ("retryAfterMs" in r) return refuse(sdkOut, re, "rate", { retryAfterMs: r.retryAfterMs });

  // 6. availability, per trust level (§10.6's table), and 8. the answer. P0 skips 7.
  if (type === "env.get") return answer(sdkOut, re, await deps.env());
  if (type === "accounts.list") return accountsList(re, pluginId, trust, cat, deps);
  if (isP2(type)) return propose(re, type, m.body as Record<string, unknown>, deps);
  return refuse(sdkOut, re, "not-granted");
}

/**
 * P2 from step 6 on (§10.6's table: `pendingResult`, a success with a ticket, in every state and at every trust level).
 * Steps 7 and 8 (the tag, the plugin's entry verified now, and the request's own checks) are Sixkey's change list's, when
 * it is drawn and again at the user's Add or Apply (gone with the platform), so no answer here tells the lock state.
 */
async function propose(re: string, type: P2Type, body: Record<string, unknown>, deps: Deps): Promise<Response> {
  if (!deps.p2) return refuse(SDK_MAX, re, "not-granted");
  const r = await deps.p2.propose(type, body);
  if (r === "busy") return refuse(SDK_MAX, re, "busy");
  if (r === "full") return refuse(SDK_MAX, re, "rate", { retryAfterMs: 60_000 });
  return answer(SDK_MAX, re, { pending: true, ticket: r.ticket });
}

/**
 * `accounts.list` from step 6 on (§6.3, §10.6). 6: only while Sixkey's popup or side panel is open and Sixkey is
 * unlocked (reach). 7: the record's tag verifies, and the plugin's verified entry is approved now and holds
 * `accounts.read` within its level's ceiling (a storage writer's unverified "approved" grants nothing); this is checked
 * before the vault is opened (W2A-07 b). 8: the live accounts' summaries; once they are assembled the surface and the key
 * are asked again, so that a popup closed, a lock or a key change while they were read gives nothing (W2A-07 a).
 */
async function accountsList(
  re: string,
  pluginId: string,
  trust: Trust,
  cat: Catalog["plugins"][number] | undefined,
  deps: Deps,
): Promise<Response> {
  const p1 = deps.p1;
  if (!p1) return refuse(SDK_MAX, re, "unavailable");
  const v = await reach(trust, p1);
  if (typeof v === "string") return refuse(SDK_MAX, re, v);
  if (!(await p1Held(pluginId, trust, cat, v.entry, deps))) return refuse(SDK_MAX, re, "not-granted");
  const accounts = await v.accounts();
  if (!accounts || !(await v.still())) return refuse(SDK_MAX, re, trust === "official" ? "locked" : "unavailable");
  if (!(await p1.surface())) return refuse(SDK_MAX, re, "unavailable");
  return answer(SDK_MAX, re, { accounts });
}

/**
 * Step 6 for P1 (§10.6's table): what Sixkey unlocked gives, while its popup or side panel is open; else the answer. A
 * plugin that is not official never sees the lock: closed and locked are both `unavailable`, and the surface is asked
 * first, so a plugin polling with neither open makes Sixkey look at no key at all; an official one is told `locked`.
 */
async function reach(trust: Trust, p1: NonNullable<Deps["p1"]>): Promise<P1Vault | "locked" | "unavailable"> {
  if (trust === "official") {
    const v = await p1.vault();
    if (!v) return "locked";
    return (await p1.surface()) ? v : "unavailable";
  }
  if (!(await p1.surface())) return "unavailable";
  return (await p1.vault()) ?? "unavailable";
}

/**
 * Step 7: the verified entry `e` is the plugin's, approved now (its state as stateOf sees it, the catalog's pin
 * included), and holds P1 within its level's ceiling.
 */
async function p1Held(
  pluginId: string,
  trust: Trust,
  cat: Catalog["plugins"][number] | undefined,
  e: GrantEntry | null,
  deps: Deps,
): Promise<boolean> {
  if (!e || e.pluginId !== pluginId) return false;
  const storedHash = trust === "listed" ? await contributionsHash(e.descriptor) : undefined;
  const now = stateOf(deps.catalog, pluginId, e, {
    install: deps.install,
    pauses: deps.pauses,
    ...(storedHash !== undefined ? { storedHash } : {}),
  });
  return now.state === "approved" && heldNow(e, trust, cat).includes("accounts.read");
}

async function hello(
  m: Record<string, unknown>,
  re: string,
  pluginId: string,
  trust: Trust,
  cat: Catalog["plugins"][number] | undefined,
  state: PluginState,
  deps: Deps,
): Promise<Response> {
  const body = m.body as { descriptor: unknown; keys?: Record<string, string> };
  const read = readDescriptor(body.descriptor);
  if (!read.ok)
    return read.error === "version"
      ? refuse(SDK_MAX, re, "version", { supported: read.supported })
      : refuse(SDK_MAX, re, "invalid");
  // the envelope's sdk is the plugin's sdkVersion (§5.1: else "the wrong sdk", §10.7), and the descriptor is the sender's
  if (m.sdk !== read.descriptor.sdkVersion)
    return refuse(read.sdk, re, "version", { supported: { min: SDK_MIN, max: SDK_MAX } });
  if (read.descriptor.id !== pluginId) return refuse(read.sdk, re, "invalid");
  // 5. the rate: hello counts toward the plugin's 60 a minute
  const r = deps.rate.take(pluginId, [], deps.now);
  if ("retryAfterMs" in r) return refuse(read.sdk, re, "rate", { retryAfterMs: r.retryAfterMs });
  if (state.state === "blocked") return answer(read.sdk, re, { state: "blocked", sdkVersion: read.sdk });
  const keys = Object.fromEntries(Object.entries(body.keys ?? {}).filter(([, v]) => isShortcut(v)));
  if (!(await deps.seen({ descriptor: read.descriptor, unavailable: read.unavailable, keys, trust })))
    return refuse(read.sdk, re, "rate", { retryAfterMs: 10_000 });
  let now = state;
  if (state.state !== "unknown") {
    const stored = state.entry.descriptor;
    // with `management`, a third-party plugin's new version is a change to approve (§8.2, §9.5), unless it holds P0
    // only: then the removed plugin list told it, and it pauses nothing (OD-2)
    const versionHarmless = !(deps.install && trust !== "official" && !p0Only(state.entry));
    let reason: GrantReason | null = null;
    if (!onlyHarmless(stored, read.descriptor, versionHarmless)) reason = "changed";
    else if (trust === "listed" && (await contributionsHash(read.descriptor)) !== cat?.contributionsHash)
      reason = "changed-since-review";
    if (reason) {
      await deps.changed(reason);
      const entry = tightened(state.entry, "suspended", reason);
      now = { state: "suspended", entry, why: entry.reason ?? reason };
    }
  }
  const s = helloState(now);
  if (s !== "approved") return answer(read.sdk, re, { state: s, sdkVersion: read.sdk });
  const entry = (now as { entry: GrantEntry }).entry;
  let granted = heldNow(entry, trust, cat);
  // P1 as the verified record holds it whenever accounts.list would reach its tag now (Sixkey's popup or side panel
  // open, Sixkey unlocked), so that the two answers never disagree (W2A-09); otherwise accounts.list answers
  // unavailable or locked, never not-granted, and the stored record is all there is to say (§6.6 item 3)
  if (granted.includes("accounts.read") && deps.p1) {
    const v = await reach(trust, deps.p1);
    if (typeof v !== "string" && !(await p1Held(pluginId, trust, cat, v.entry, deps)))
      granted = granted.filter((c) => c !== "accounts.read");
  }
  return answer(read.sdk, re, {
    state: "approved",
    sdkVersion: read.sdk,
    trust,
    granted,
    ...(read.unavailable.length ? { unavailable: read.unavailable } : {}),
    sixkey: { version: deps.sixkeyVersion },
  });
}

/** An event to a plugin (§10.4): `{sdk, ev, body}`. Sixkey never waits for a reply to one (§3.3 item 6). */
export const event = (ev: "slot.invoked" | "grants.changed" | "request.done", body: Record<string, unknown>) => ({
  sdk: SDK_MAX,
  ev,
  body,
});
