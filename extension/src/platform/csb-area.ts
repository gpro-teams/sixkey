// The one module that writes chrome.storage.sync: the backup in Chrome's sync storage (CSB), whose layout, plan and
// write rule are core/cloud/slots.ts's. Only the worker uses it (from CSB-3, its run of the backup); the pages read the
// area themselves and never write it (platform/csb-read.ts). test/unit/source-rules.test.ts holds both rules.
//
//   - A write is one `set` of one slot's plan (slots.ts planSlot), checked here again before Chrome sees it, its shape
//     and its content: exactly the manifest and chunks 0…n-1, each item within ITEM_BYTES; the chunks' lengths add up
//     to the manifest's `z` and their text hashes to its `h`; the items' bytes are the plan's `bytes`. A plan that fails
//     is a bug: AreaError, and no call. A plan past ROOM_BYTES is refused as "too_large" before any call (Chrome would
//     refuse it for the area's bytes, which would read as "no_room"). The manifest written is the one checked. One
//     call, so one write operation, and Chrome applies it as one batch: a refused set writes none of its items, and a
//     page's onChanged gets one event with every key (Chromium 156, test/e2e/csb-probe.spec.ts). Never split and never
//     retried here: the worker's run decides what comes next.
//   - Two removes, each one call and none for an empty list, and slot keys only, never another key of the area:
//     removeLeftovers(slot, n, keys) takes chunks of that slot from index n on (a shrunk slot's leftovers, slots.ts
//     leftovers), never a manifest; removeSlot(slot) takes the whole slot (the own one when the backup is turned off,
//     the ones a merge drops: which callers may use it is CSB-3's and CSB-4's source rule).
//   - Chrome's refusals are told apart by their exact texts, as Chromium 145 and 156 write them (REFUSALS; the probe
//     pins each one). The quotas' names are not in the first three: they read "Resource::k… quota exceeded", with no
//     period. The hour's text is not measured (1,800 calls would take 15 minutes of the minute's): it is the minute's
//     template. Anything else is "other": another text, a throw, a missing area. So a text that a later Chrome changes
//     costs a retry, never a wrong stop: the worker retries "other" (1, 5, 30 min, with a diagnostics line), and the
//     next run's own room check (slots.ts room, from Chrome's getBytesInUse) finds a real lack of room by itself.
//   - Chrome counts write operations per call and per operation: set and remove have 120 calls a minute each
//     (MAX_WRITE_OPERATIONS_PER_MINUTE), and a clear still passes once both have run out; a set refused for its bytes
//     counts too, reads count nothing (the probe). A run makes one set, and one remove only after a shrink.
//   - Reads (readArea, bytesInUse) are passed through: a read is not refused for a quota, and a failure rejects.
//     bytesInUse asks for each key once (Chrome counts a key given twice twice: the probe).
//   - chrome.storage.sync itself never leaves this module: chromeSync is not exported, and is only the functions'
//     default area (source-rules.test.ts).
import { sha256, toB64, utf8 } from "../core/crypto/bytes";
import {
  chunkKey,
  ITEM_BYTES,
  itemBytes,
  manifestKey,
  MAX_CHUNKS,
  parseKey,
  parseManifest,
  ROOM_BYTES,
  type SlotManifest,
  type TextPlan,
} from "../core/cloud/slots";
import type { CsbError } from "../core/cloud/status";

/** The part of chrome.storage.sync this needs. */
export type SyncArea = {
  get(keys: null): Promise<Record<string, unknown>>;
  getBytesInUse(keys: string[] | null): Promise<number>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

/** chrome.storage.sync, where there is one: the default area of this module's functions, and nothing else. */
const chromeSync = (): SyncArea | undefined => globalThis.chrome?.storage?.sync as unknown as SyncArea | undefined;

/**
 * Why a write was refused: one of Chrome's quotas, anything else Chrome said ("other"), or "too_large", which is not
 * Chrome's: the plan is past ROOM_BYTES, and refused here before any call.
 */
export type Refusal =
  | "QUOTA_BYTES"
  | "QUOTA_BYTES_PER_ITEM"
  | "MAX_ITEMS"
  | "MAX_WRITE_OPERATIONS_PER_MINUTE"
  | "MAX_WRITE_OPERATIONS_PER_HOUR"
  | "too_large"
  | "other";

/** Chromium's texts (145 and 156), each whole: a Map, so that no text can name a property of an object. */
export const REFUSALS: ReadonlyMap<string, Exclude<Refusal, "too_large" | "other">> = new Map([
  ["Resource::kQuotaBytes quota exceeded", "QUOTA_BYTES"],
  ["Resource::kQuotaBytesPerItem quota exceeded", "QUOTA_BYTES_PER_ITEM"],
  ["Resource::kMaxItems quota exceeded", "MAX_ITEMS"],
  ["This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.", "MAX_WRITE_OPERATIONS_PER_MINUTE"],
  ["This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.", "MAX_WRITE_OPERATIONS_PER_HOUR"],
]);

/**
 * What the backup records for a refusal (status.ts CsbError): the write-operation quotas are "busy" (retried); the
 * area's bytes are "no_room" (the plan fitted when it was made, so another computer's items arrived since, or Chrome's
 * count passed this module's: the worker stops and its daily check tries again); the item quotas, which the plan makes
 * impossible, and everything else are "other" (retried, with a diagnostics line).
 */
export function errorOf(r: Refusal): CsbError {
  switch (r) {
    case "MAX_WRITE_OPERATIONS_PER_MINUTE":
    case "MAX_WRITE_OPERATIONS_PER_HOUR":
      return "busy";
    case "QUOTA_BYTES":
      return "no_room";
    case "too_large":
      return "too_large";
    default:
      return "other";
  }
}

export type Refused = { ok: false; refusal: Refusal; error: CsbError; message: string };
export type Written = { ok: true } | Refused;

const textOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string")
    return (e as { message: string }).message;
  return String(e);
};

/** A rejection (or a throw) of a write, told apart by its whole text; the text is kept for the diagnostics line. */
export function refusalOf(e: unknown): Refused {
  const message = textOf(e);
  const refusal = REFUSALS.get(message) ?? "other";
  return { ok: false, refusal, error: errorOf(refusal), message };
}

export class AreaError extends Error {
  constructor(
    readonly code: "bad_plan" | "bad_keys",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AreaError";
  }
}

const MANIFEST_FIELDS = ["v", "g", "n", "z", "h", "t"] as const;

/**
 * The items of one slot's write and their bytes, or an AreaError (the header's checks): exactly the manifest (as
 * parseManifest reads it, equal to the plan's, and written as read) and chunks 0…n-1 (strings), each within ITEM_BYTES
 * by slots.ts's measure, whose lengths add up to `z` and whose text hashes to `h`, the items' bytes the plan's.
 */
async function slotItems(plan: TextPlan): Promise<{ items: Record<string, string | SlotManifest>; bytes: number }> {
  const bad = (why: string) => new AreaError("bad_plan", why);
  if (plan.kind !== "plan") throw bad("not a plan");
  const mk = manifestKey(plan.slot);
  const parsed = parseKey(mk);
  if (parsed === null || parsed.chunk !== null) throw bad("slot id"); // (an id with a dot could make a chunk's key)
  const m = parseManifest(plan.items[mk]);
  if (m === null || m === "newer" || !MANIFEST_FIELDS.every((f) => m[f] === plan.manifest[f])) throw bad("manifest");
  const want = [mk, ...Array.from({ length: m.n }, (_, i) => chunkKey(plan.slot, i))];
  const keys = Object.keys(plan.items);
  if (keys.length !== want.length || !want.every((k) => Object.hasOwn(plan.items, k))) throw bad("keys");
  const items: Record<string, string | SlotManifest> = { [mk]: m };
  const pieces: string[] = [];
  let bytes = itemBytes(mk, m)!;
  for (const k of want.slice(1)) {
    const v = plan.items[k];
    if (typeof v !== "string") throw bad("chunk");
    const b = itemBytes(k, v);
    if (b === null || b > ITEM_BYTES) throw bad("item size");
    items[k] = v;
    pieces.push(v);
    bytes += b;
  }
  if (pieces.reduce((a, x) => a + x.length, 0) !== m.z) throw bad("text length");
  if (toB64(await sha256(utf8(pieces.join("")))) !== m.h) throw bad("text hash");
  if (bytes !== plan.bytes) throw bad("bytes");
  return { items, bytes };
}

/**
 * One slot's write: its items in one `set`. Ok; "too_large" for a plan past ROOM_BYTES, with no call; or Chrome's
 * refusal told apart. A malformed plan throws an AreaError (no call).
 */
export async function writeSlot(plan: TextPlan, area: SyncArea | undefined = chromeSync()): Promise<Written> {
  const { items, bytes } = await slotItems(plan);
  if (bytes > ROOM_BYTES)
    return {
      ok: false,
      refusal: "too_large",
      error: "too_large",
      message: `${bytes} B, past ROOM_BYTES (${ROOM_BYTES})`,
    };
  if (!area) return refusalOf(new Error("storage.sync is not available"));
  try {
    await area.set(items);
    return { ok: true };
  } catch (e) {
    return refusalOf(e);
  }
}

/** The one `remove` call (of keys checked by its callers); an empty list makes no call. */
async function removeItems(keys: readonly string[], area: SyncArea | undefined): Promise<Written> {
  if (keys.length === 0) return { ok: true };
  if (!area) return refusalOf(new Error("storage.sync is not available"));
  try {
    await area.remove([...keys]);
    return { ok: true };
  } catch (e) {
    return refusalOf(e);
  }
}

const isCount = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= MAX_CHUNKS;

/**
 * The leftover chunks of `slot` past its count `n` (1 to 13), in one `remove`: only chunk keys of that slot with an
 * index of `n` or more, never a manifest, never another slot's (else AreaError("bad_keys"), no call).
 */
export async function removeLeftovers(
  slot: string,
  n: number,
  keys: readonly string[],
  area: SyncArea | undefined = chromeSync(),
): Promise<Written> {
  if (parseKey(manifestKey(slot))?.chunk !== null || !isCount(n)) throw new AreaError("bad_keys", "slot or count");
  for (const k of keys) {
    const x = typeof k === "string" ? parseKey(k) : null;
    if (x === null || x.slot !== slot || x.chunk === null || x.chunk < n) throw new AreaError("bad_keys", String(k));
  }
  return removeItems(keys, area);
}

/** A whole slot, in one `remove`: its manifest and every chunk key it can have (those not there cost nothing). */
export async function removeSlot(slot: string, area: SyncArea | undefined = chromeSync()): Promise<Written> {
  if (parseKey(manifestKey(slot))?.chunk !== null) throw new AreaError("bad_keys", "slot");
  return removeItems([manifestKey(slot), ...Array.from({ length: MAX_CHUNKS }, (_, i) => chunkKey(slot, i))], area);
}

/**
 * The area and what it takes, for decideSlot and room (slots.ts): get(null) and getBytesInUse(null), asked together.
 * Chrome may apply another computer's item between the two answers; room's verdict can then be off by that item, and
 * Chrome's own count at the `set` is the backstop (QUOTA_BYTES: "no_room").
 */
export async function readArea(
  area: SyncArea | undefined = chromeSync(),
): Promise<{ items: Record<string, unknown>; inUse: number }> {
  if (!area) throw new Error("storage.sync is not available");
  const [items, inUse] = await Promise.all([area.get(null), area.getBytesInUse(null)]);
  return { items, inUse };
}

/**
 * Chrome's own count of some keys (null: the whole area), for the worker's record of what the slots take. Each key is
 * asked once: Chrome counts a key given twice twice.
 */
export async function bytesInUse(
  keys: readonly string[] | null,
  area: SyncArea | undefined = chromeSync(),
): Promise<number> {
  if (!area) throw new Error("storage.sync is not available");
  return area.getBytesInUse(keys === null ? null : [...new Set(keys)]);
}
