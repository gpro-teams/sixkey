// The grant store's records (from the plugin SDK's specification, which is in the history before the plugin platform's
// removal, as store.ts says; the section numbers in this file are its own; its schemas `#/$defs/grantStore`,
// `grantOverlay`, `pluginPauses`): what each one holds, how it is read back (strictly: a record Sixkey did not write is
// not one), its tag, and the transitions between a plugin's states. Pure, apart from WebCrypto; the reads and writes,
// their order and their lock are store.ts's.
//   - sk_plugins (storage.local): one record of every plugin's approval, tagged with K_g, a key derived from the vault
//     key, over the JCS text of the record without its tag. It binds every plugin ID, its stored descriptor, its grants
//     and state, `developerMode` and an `epoch` raised on every change. The trust level is never in it (§8).
//   - sk_plugins_overlay (storage.local): what was decided while the tag could not be computed. No tag: its entries can
//     only suspend, disable or remove, and an entry is honoured only if it is newer than the plugin's last loosening
//     (its approvedAt), so a stale one can never undo a later approval (PLUGINS-W1A-NOTES.md §3.4).
//   - sk_plugin_pauses (storage.session): the pauses after three denials; no tag, gone with the browser session.
import {
  CAPABILITY_NAMES,
  EXTENSION_ID,
  isObject,
  isStoredDescriptor,
  sameVersion,
  type CapabilityName,
  type Descriptor,
} from "./descriptor";
import { isBuiltin } from "./builtin";
import { jcs } from "./jcs";

export const GRANTS_KEY = "sk_plugins";
export const OVERLAY_KEY = "sk_plugins_overlay";
/** The approvals a failed tag left behind once one of them was approved again (§6.6 item 6; store.ts): kept for review. */
export const UNVERIFIED_KEY = "sk_plugins_unverified";
export const PAUSES_KEY = "sk_plugin_pauses";
/** The last epoch written or verified in this browser session (§6.6 item 5): an older record is a rollback. */
export const EPOCH_KEY = "sk_plugins_epoch";
/** The HKDF label of K_g. Local only: not a label of the contract's (contract/vectors/sync-v1.json lists those). */
export const GRANT_LABEL = "sixkey/v1/plugin-grants";

export type GrantState = "approved" | "disabled" | "suspended";
export type GrantReason = "user" | "changed" | "changed-since-review" | "version-changed";
export type GrantEntry = {
  pluginId: string;
  state: GrantState;
  reason?: GrantReason;
  descriptor: Descriptor;
  granted: CapabilityName[];
  /** The last time the user loosened this entry: approved it, or turned it on again. */
  approvedAt: number;
  trashed: string[];
};
export type GrantBody = { v: 1; epoch: number; developerMode: boolean; plugins: GrantEntry[] };
export type GrantRecord = GrantBody & { tag: string };
export type OverlayAction = "suspend" | "disable" | "remove";
export type OverlayEntry = { pluginId: string; action: OverlayAction; reason?: GrantReason; at: number };
export type Pause = { pluginId: string; since: number };

const REASONS: readonly GrantReason[] = ["user", "changed", "changed-since-review", "version-changed"];
const TRASHED_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TAG = /^[A-Za-z0-9_-]{43}$/;
const isInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const exactly = (o: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(o).every((k) => allowed.includes(k));

const utf8 = (s: string) => new TextEncoder().encode(s);

export const emptyBody = (): GrantBody => ({ v: 1, epoch: 0, developerMode: false, plugins: [] });

/** One plugin's entry, checked against `#/$defs/grantStore`'s items; null for anything else. */
export function parseEntry(x: unknown): GrantEntry | null {
  if (!isObject(x)) return null;
  if (!exactly(x, ["pluginId", "state", "reason", "descriptor", "granted", "approvedAt", "trashed"])) return null;
  const { pluginId, state, reason, descriptor, granted, approvedAt, trashed } = x;
  if (typeof pluginId !== "string" || !EXTENSION_ID.test(pluginId)) return null;
  if (state !== "approved" && state !== "disabled" && state !== "suspended") return null;
  // approved: no reason; the other states: one
  if (state === "approved" ? reason !== undefined : !REASONS.includes(reason as GrantReason)) return null;
  // (an approval an earlier version stored may name a capability retired since: it reads, and is held by no one)
  if (!isStoredDescriptor(descriptor, { retired: true }) || descriptor.id !== pluginId) return null;
  if (
    !Array.isArray(granted) ||
    new Set(granted).size !== granted.length ||
    !granted.every((g) => (CAPABILITY_NAMES as readonly unknown[]).includes(g))
  )
    return null;
  if (!isInt(approvedAt)) return null;
  if (
    !Array.isArray(trashed) ||
    trashed.length > 5000 ||
    !trashed.every((t) => typeof t === "string" && TRASHED_ID.test(t))
  )
    return null;
  return {
    pluginId,
    state,
    ...(reason !== undefined ? { reason: reason as GrantReason } : {}),
    descriptor,
    granted: granted as CapabilityName[],
    approvedAt,
    trashed: trashed as string[],
  };
}

/**
 * sk_plugins, checked against `#/$defs/grantStore` as a whole (every entry, unique plugin IDs, at most 256). null when
 * there is none; "damaged" for anything else that is there.
 */
export function parseRecord(x: unknown): GrantRecord | "damaged" | null {
  if (x === undefined) return null;
  if (!isObject(x) || !exactly(x, ["v", "epoch", "developerMode", "plugins", "tag"])) return "damaged";
  if (x.v !== 1 || !isInt(x.epoch) || typeof x.developerMode !== "boolean") return "damaged";
  if (typeof x.tag !== "string" || !TAG.test(x.tag)) return "damaged";
  if (!Array.isArray(x.plugins) || x.plugins.length > 256) return "damaged";
  const plugins: GrantEntry[] = [];
  for (const p of x.plugins) {
    const e = parseEntry(p);
    if (!e || plugins.some((q) => q.pluginId === e.pluginId)) return "damaged";
    plugins.push(e);
  }
  return { v: 1, epoch: x.epoch, developerMode: x.developerMode, plugins, tag: x.tag };
}

/** The entries of a record that did not verify, or did not parse as a whole, that still parse one by one: for review. */
export function looseEntries(x: unknown): GrantEntry[] {
  if (!isObject(x) || !Array.isArray(x.plugins)) return [];
  const out: GrantEntry[] = [];
  for (const p of x.plugins.slice(0, 256)) {
    const e = parseEntry(p);
    if (e && !out.some((q) => q.pluginId === e.pluginId)) out.push(e);
  }
  return out;
}

/** sk_plugins_overlay's entries (`#/$defs/grantOverlay`). It has no tag: a malformed entry is skipped, never honoured. */
export function parseOverlay(x: unknown): OverlayEntry[] {
  if (!isObject(x) || x.v !== 1 || !Array.isArray(x.entries)) return [];
  const out: OverlayEntry[] = [];
  for (const e of x.entries.slice(0, 256)) {
    if (!isObject(e) || !exactly(e, ["pluginId", "action", "reason", "at"])) continue;
    if (typeof e.pluginId !== "string" || !EXTENSION_ID.test(e.pluginId) || !isInt(e.at)) continue;
    if (e.action !== "suspend" && e.action !== "disable" && e.action !== "remove") continue;
    if (e.reason !== undefined && !REASONS.includes(e.reason as GrantReason)) continue;
    if (e.action === "suspend" && e.reason === undefined) continue;
    out.push({
      pluginId: e.pluginId,
      action: e.action,
      ...(e.reason !== undefined ? { reason: e.reason as GrantReason } : {}),
      at: e.at,
    });
  }
  return out;
}

/** sk_plugin_pauses' entries (`#/$defs/pluginPauses`). */
export function parsePauses(x: unknown): Pause[] {
  if (!isObject(x) || x.v !== 1 || !Array.isArray(x.pauses)) return [];
  return x.pauses
    .slice(0, 256)
    .filter(
      (p): p is Pause =>
        isObject(p) &&
        exactly(p, ["pluginId", "since"]) &&
        typeof p.pluginId === "string" &&
        EXTENSION_ID.test(p.pluginId) &&
        isInt(p.since),
    )
    .map((p) => ({ pluginId: p.pluginId, since: p.since }));
}

// ---- the tag (§6.6 item 2) -----------------------------------------------------------------------------------------

/** K_g = HKDF-SHA256(IKM = the vault key, salt = empty, info = GRANT_LABEL, L = 32), as an HMAC-SHA256 key. */
export async function grantKey(vkRaw: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", vkRaw as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(GRANT_LABEL) as BufferSource },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));

/** The body as it is tagged: the record without its tag, in JCS. */
const signed = (b: GrantBody) =>
  utf8(jcs({ v: b.v, epoch: b.epoch, developerMode: b.developerMode, plugins: b.plugins }));

/** The record: `body` with `tag` = base64url, unpadded, of HMAC-SHA256(K_g, JCS(body)). */
export async function seal(key: CryptoKey, body: GrantBody): Promise<GrantRecord> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed(body) as BufferSource));
  return { ...body, tag: b64url(mac) };
}

/** Whether `rec`'s tag is K_g's over the rest of it (a constant-time compare: WebCrypto's verify). */
export async function verify(key: CryptoKey, rec: GrantRecord): Promise<boolean> {
  let mac: Uint8Array;
  try {
    mac = unb64url(rec.tag);
  } catch {
    return false;
  }
  if (mac.length !== 32 || b64url(mac) !== rec.tag) return false; // one spelling only (the last character's spare bits zero)
  return crypto.subtle.verify("HMAC", key, mac as BufferSource, signed(rec) as BufferSource);
}

// ---- states and transitions ----------------------------------------------------------------------------------------

/**
 * How far an entry is from being used: approved 0, disabled 1, suspended 2, and suspended because it changed since a
 * review 3 (only a Sixkey release lifts that one). Nothing without a tag may lower it (§6.6 item 4).
 */
export function strength(state: GrantState, reason?: GrantReason): number {
  if (state === "approved") return 0;
  if (state === "disabled") return 1;
  return reason === "changed-since-review" ? 3 : 2;
}

/** `e` made at least as tight as `state`/`reason`: never looser than it was. */
export function tightened(e: GrantEntry, state: GrantState, reason: GrantReason): GrantEntry {
  if (strength(state, reason) <= strength(e.state, e.reason)) return e;
  return { ...e, state, reason };
}

/**
 * The entries with the overlay applied (§6.6 item 4): each overlay entry newer than the plugin's last loosening removes
 * it, or tightens it to disabled or suspended; none loosens anything, and an older one is stale (a later approval saw
 * everything it was about).
 */
export function withOverlay(entries: readonly GrantEntry[], overlay: readonly OverlayEntry[]): GrantEntry[] {
  let out = [...entries];
  for (const o of [...overlay].sort((a, b) => a.at - b.at)) {
    const i = out.findIndex((e) => e.pluginId === o.pluginId);
    if (i === -1 || o.at <= out[i]!.approvedAt) continue;
    // a built-in's entry is never removed by the overlay, which only tightens: for it, no entry is On (builtin.ts)
    if (o.action === "remove" && !isBuiltin(o.pluginId)) out = out.filter((_, j) => j !== i);
    else if (o.action === "remove") out[i] = tightened(out[i]!, "disabled", "user");
    else
      out[i] =
        o.action === "disable" ? tightened(out[i]!, "disabled", "user") : tightened(out[i]!, "suspended", o.reason!);
  }
  return out;
}

/**
 * `e` (what a page verified when it opened a surface port) narrowed by `now` (the store as it is at this message, the
 * overlay applied): removed since, it is gone; otherwise it is at least as tight as `now`, and holds only what both grant.
 * Nothing in `now` loosens `e`, so an unverified record read for this can only take away (wave 2a: a switch turned off,
 * or a removal, counts on a port already open, at its next message).
 */
export function narrowedBy(e: GrantEntry | undefined, now: GrantEntry | undefined): GrantEntry | undefined {
  if (!e || !now || now.pluginId !== e.pluginId) return undefined;
  const t = now.state === "approved" ? e : tightened(e, now.state, now.reason ?? "user");
  return {
    ...t,
    granted: t.granted.filter((g) => now.granted.includes(g)),
    approvedAt: Math.min(e.approvedAt, now.approvedAt),
  };
}

/** Whether a pause (after denials) holds for `e`: one taken after its last loosening. */
export const pausedNow = (e: GrantEntry, pauses: readonly Pause[]): boolean =>
  pauses.some((p) => p.pluginId === e.pluginId && p.since > e.approvedAt);

/** The overlay with `entry` added: at most one entry per plugin and action (the newest), at most 256 entries. */
export function overlayWith(cur: readonly OverlayEntry[], entry: OverlayEntry): OverlayEntry[] {
  const rest = cur.filter((o) => !(o.pluginId === entry.pluginId && o.action === entry.action));
  // past 256 the oldest go: the newest of each plugin's suspensions is what matters, and the record holds 256 plugins
  return [...rest, entry].sort((a, b) => a.at - b.at).slice(-256);
}

/** Approve (or approve again) `descriptor` with `granted`: approved, its last loosening now; its trash marks kept. */
export function approved(
  body: GrantBody,
  p: { descriptor: Descriptor; granted: CapabilityName[]; now: number },
): GrantBody {
  const old = body.plugins.find((e) => e.pluginId === p.descriptor.id);
  const entry: GrantEntry = {
    pluginId: p.descriptor.id,
    state: "approved",
    descriptor: p.descriptor,
    granted: [...new Set(p.granted)],
    approvedAt: p.now,
    trashed: old?.trashed ?? [],
  };
  const plugins = old ? body.plugins.map((e) => (e === old ? entry : e)) : [...body.plugins, entry];
  if (plugins.length > 256) throw new RangeError("at most 256 plugins");
  return { ...body, plugins };
}

/** The user's switch, off: disabled (from approved only; a suspended entry stays suspended). */
export function disabled(body: GrantBody, id: string): GrantBody {
  return { ...body, plugins: body.plugins.map((e) => (e.pluginId === id ? tightened(e, "disabled", "user") : e)) };
}

/**
 * The user's switch, on again: only a plugin the user turned off (disabled, reason "user") goes back to approved,
 * without a new approval screen (its descriptor is the one approved). A suspended one needs the approval screen.
 */
export function enabled(body: GrantBody, id: string, now: number): GrantBody {
  return {
    ...body,
    plugins: body.plugins.map((e) =>
      e.pluginId === id && e.state === "disabled" && e.reason === "user"
        ? {
            pluginId: e.pluginId,
            state: "approved",
            descriptor: e.descriptor,
            granted: e.granted,
            approvedAt: now,
            trashed: e.trashed,
          }
        : e,
    ),
  };
}

/**
 * The approved descriptors' versions set to what Chrome reports, nothing else (OD-2: done once Sixkey gets
 * `management`, so that holding it pauses no plugin for the versions it already had).
 */
export function versioned(body: GrantBody, versions: ReadonlyMap<string, string>): GrantBody {
  return {
    ...body,
    plugins: body.plugins.map((e) => {
      const v = versions.get(e.pluginId);
      // a version written another way is the same version (N5): nothing to record
      return v && !sameVersion(v, e.descriptor.version) ? { ...e, descriptor: { ...e.descriptor, version: v } } : e;
    }),
  };
}

/** The trash marks (§9.7, wave 2b): `ids`, the accounts `id`'s plugin moved to the trash, kept with its entry (5,000 at most). */
export function markTrashed(body: GrantBody, id: string, ids: readonly string[]): GrantBody {
  const add = ids.filter((t) => TRASHED_ID.test(t));
  return {
    ...body,
    plugins: body.plugins.map((e) =>
      e.pluginId === id ? { ...e, trashed: [...e.trashed.filter((t) => !add.includes(t)), ...add].slice(-5000) } : e,
    ),
  };
}

/**
 * The trash marks of `ids` dropped from every entry (§9.7): accounts the user brought back from the trash, whose next
 * stay there would otherwise read as the plugin's doing (docs/design/notes/BUDGET3-NOTES.md §4). Nothing else changes.
 */
export function unmarkTrashed(body: GrantBody, ids: readonly string[]): GrantBody {
  return {
    ...body,
    plugins: body.plugins.map((e) =>
      e.trashed.some((t) => ids.includes(t)) ? { ...e, trashed: e.trashed.filter((t) => !ids.includes(t)) } : e,
    ),
  };
}

export function removed(body: GrantBody, id: string): GrantBody {
  return { ...body, plugins: body.plugins.filter((e) => e.pluginId !== id) };
}
