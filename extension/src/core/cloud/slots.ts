// The backup in Chrome's sync storage (CSB): how one device's copy is laid out in chrome.storage.sync, how it is
// read back, and when a device may write it. Pure: nothing here touches chrome.*; the worker (and only the worker)
// writes the area, and the pages read it.
//
// The copy is the cloud backup's file unchanged (format.ts: the generation as on disk, opened by the master password or
// the recovery key), cut into items, because Chrome limits each item to 8,192 bytes and the whole area to 102,400
// (QUOTA_BYTES_PER_ITEM, QUOTA_BYTES; key length plus the value's JSON, as Chrome counts them).
//   - A slot is one device's copy, named by a random 8-character id of [a-z0-9]. Its manifest is the item
//     `bk1.<slot>`, its chunks `bk1.<slot>.<i>` for i = 0…n-1 (decimal, at most 13 chunks). Keys of any other shape
//     are not read here; `bk2.` is left free for a later format.
//   - A chunk is a plain string, a piece of the file's text. The text is printable ASCII (base64, hex, digits, field
//     names, the app's name), and planSlot refuses anything else: control characters, < > & (some JSON writers escape
//     them as \u003C and so on: six bytes, not one), and the backslash (two bytes in every JSON writer, refused only
//     because a file never holds one). So what a piece takes is known exactly: its length, one more for each quote,
//     two for the quotes around it.
//   - The manifest, read strictly (exactly these fields): v (1), g (a random 64-bit tag, new at every write), n (the
//     chunk count), z (the text's length), h (its SHA-256, base64), t (the generation's savedAt, also inside the file,
//     which must agree). Nothing else: no device name, no account count, no vault id.
// The writer puts the manifest and every chunk in one `set` call. Chrome sync carries each item on its own, so another
// computer may see old and new items mixed for a while: a slot is used only when the manifest parses, chunks 0…n-1 are
// all there, the joined text has the length z and the hash h, and the file parses (format.ts, which runs the store's
// own checks: shape and envelope checksum). Anything else is "partial" (still arriving) or "invalid", never used.
//
// When a device writes (decideSlot), in order. The worker cannot decrypt, so the rule is about lineage, as rules.ts's
// is for Drive: a device writes only the slot it made or adopted at a restore, and anything else becomes a new slot.
//   1. its vault is empty and no slot of this vault exists yet: skip (a new, empty device never writes; isEmptyVault);
//   2. no link (never written, or the record did not check out): a new slot;
//   3. the link is held (the store fell back to an older copy, or rule 7 held it): hold, until a page merges the slot;
//   4. its own slot is absent (Chrome's "clear data", an uninstall elsewhere, a merge-and-remove): write it again,
//      under the same id;
//   5. its own slot carries a tag this device did not write or adopt (another computer adopted it after a restore, a
//      cloned profile wrote it, a later Sixkey's format): it is theirs now: a new slot, theirs left as it is;
//   6. another vault than the link's (start over; a file restored over unreadable data): a new slot, the old one left;
//   7. a save counter below the link's, or the link's counter with another envelope (an older copy of the vault put
//      back: the store numbers each save one past the copy it has, so a save with the link's counter and other data is
//      a branch from an older copy, never a descendant of what was written): hold, as rule 3. The store's own fallbacks
//      reach rule 3 through its recovery hook; rule 7 is the net for a copy put back by hand, and it is only a net: the
//      counter is all it can compare, so if two or more saves are made on the put-back copy before the worker runs
//      (it runs 30 s after the last change), the counter has passed the link's, the copy looks like a descendant, and
//      the next write overwrites the slot with the older data (csb-slots.test.ts pins this window);
//   8. nothing changed (counter, key, `opens`, wraps; past rule 7 the counter names the envelope), the slot intact and
//      carrying the last write's tag, and no merge owed (`dirty`): skip;
//   9. otherwise: overwrite its own slot.
// Then the room: no item of a slot takes more than QUOTA_BYTES_PER_ITEM less ITEM_MARGIN, no slot more than QUOTA_BYTES
// less AREA_MARGIN, and none more than what the other items leave (room). Nothing is trimmed to fit: the old slot stays
// as the last copy that fitted.
//
// A write records itself in the link (storage.local) before the `set` (linkBefore), its new tag as `pending`, so that
// a worker stopped after the write recognises the slot as its own (rule 5 accepts the link's `gen` and `pending`), and
// the final link after it (linkAfter); a hold is saved as `held` (heldLink). A restore adopts the newest slot it opened
// (adoptSlot); a page's merge of a held slot re-bases the link on the merged vault (mergedLink). No device ever deletes
// or writes another device's slot by itself (the maintainers' C2).
//
// What this cannot keep: two computers writing one slot (one adopted it at a restore, or a profile was cloned) each
// write what they hold, and whichever write lands last is the slot; the other forks at its next run (rule 5) and writes
// what it holds to a new slot. What neither holds any more (one wrote it, then started over before it saw the other's
// write) is gone. And the rule-7 window above.
import { sha256, toB64, utf8, randomBytes, type Random } from "../crypto/bytes";
import type { EncryptedVault } from "../crypto/envelope";
import { CloudBackupError, cloudBackupText, parseCloudBackupText, type CloudBackup, type CloudOpens } from "./format";
import type { CloudCandidate } from "./restore";
import {
  AREA_MARGIN,
  EMPTY_BELOW,
  ITEM_BYTES,
  ITEM_MARGIN,
  MAX_CHUNKS,
  MAX_MINE,
  QUOTA_BYTES,
  QUOTA_BYTES_PER_ITEM,
  ROOM_BYTES,
} from "./slot-limits";

// The limits, in a module of their own that imports nothing, so the records' reader takes them without this one
// (platform/csb-config.ts, which the popup's chunk loads; options/csb/model.ts: slot-limits.ts).
export {
  AREA_MARGIN,
  EMPTY_BELOW,
  ITEM_BYTES,
  ITEM_MARGIN,
  MAX_CHUNKS,
  MAX_MINE,
  QUOTA_BYTES,
  QUOTA_BYTES_PER_ITEM,
  ROOM_BYTES,
};

const PREFIX = "bk1.";
const SLOT_RE = /^[a-z0-9]{8}$/;
const KEY_RE = /^bk1\.([a-z0-9]{8})(?:\.(0|[1-9][0-9]?))?$/;
const TAG_RE = /^[0-9a-f]{16}$/;
/** A SHA-256 in canonical base64: 32 bytes leave the last character before "=" with its two low bits zero. */
const HASH_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
/** The characters a text may have: printable ASCII but < > & and the backslash (the header says why). */
const TEXT_RE = /^[\x20-\x25\x27-\x3b\x3d\x3f-\x5b\x5d-\x7e]*$/;
const SLOT_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const MANIFEST_FIELDS = ["v", "g", "n", "z", "h", "t"];
/**
 * The most characters chunk i of any writer holds: the whole item (QUOTA_BYTES_PER_ITEM, not this writer's ITEM_BYTES,
 * so that a later Sixkey with another margin still reads) less its key (14 characters, 15 from chunk 10) and the two
 * quotes. A manifest whose length no n chunks can hold is not one of ours.
 */
const pieceMax = (i: number): number => QUOTA_BYTES_PER_ITEM - `${PREFIX}aaaaaaaa.${i}`.length - 2;
const textMax = (n: number): number => Array.from({ length: n }, (_, i) => pieceMax(i)).reduce((a, x) => a + x, 0);

export class SlotError extends Error {
  constructor(
    readonly code: "bad_slot" | "bad_tag" | "bad_text" | "bad_time",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SlotError";
  }
}

// ---- keys -----------------------------------------------------------------------------------------------------------

export const manifestKey = (slot: string): string => `${PREFIX}${slot}`;
export const chunkKey = (slot: string, i: number): string => `${PREFIX}${slot}.${i}`;

/** A key of a slot: its slot id, and its chunk's index (null for the manifest); null for any other key. */
export function parseKey(key: string): { slot: string; chunk: number | null } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  if (m[2] === undefined) return { slot: m[1]!, chunk: null };
  const i = Number(m[2]);
  return i < MAX_CHUNKS ? { slot: m[1]!, chunk: i } : null;
}

/** A new slot id, none of `taken` (unbiased: bytes past the last whole multiple of 36 are drawn again). */
export function newSlotId(taken: ReadonlySet<string>, rng: Random = randomBytes): string {
  for (;;) {
    let id = "";
    while (id.length < 8) for (const b of rng(16)) if (b < 252 && id.length < 8) id += SLOT_ALPHABET.charAt(b % 36);
    if (!taken.has(id)) return id;
  }
}

/** A new write's tag: 64 random bits, hex. */
export const newTag = (rng: Random = randomBytes): string =>
  Array.from(rng(8), (b) => b.toString(16).padStart(2, "0")).join("");

// ---- the manifest and the measure -----------------------------------------------------------------------------------

export type SlotManifest = { v: 1; g: string; n: number; z: number; h: string; t: number };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isTime = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0 && !Object.is(t, -0); // (-0: no time is; Chrome would keep it as the integer 0)
const isCount = (x: unknown, max: number): x is number =>
  Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= max;

/** A manifest, strictly; "newer" for a later version's (it owns its fields); null for anything else. */
export function parseManifest(x: unknown): SlotManifest | "newer" | null {
  if (!isObject(x)) return null;
  if (Number.isSafeInteger(x.v) && (x.v as number) > 1) return "newer";
  const keys = Object.keys(x);
  if (keys.length !== MANIFEST_FIELDS.length || !MANIFEST_FIELDS.every((f) => Object.hasOwn(x, f))) return null;
  // (read through the field list, in its order: the settings page loads this module, and its message-key check takes
  // any `t` read out of an object for the page's translation function, scripts/catalog-keys.mjs)
  const [v, g, n, z, h, savedAt] = MANIFEST_FIELDS.map((f) => x[f]);
  if (v !== 1 || typeof g !== "string" || !TAG_RE.test(g)) return null;
  if (!isCount(n, MAX_CHUNKS) || !isCount(z, textMax(n)) || z < n) return null;
  if (typeof h !== "string" || !HASH_RE.test(h) || !isTime(savedAt)) return null;
  return { v: 1, g, n, z, h, t: savedAt };
}

const quotes = (s: string): number => {
  let q = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 34) q++;
  return q;
};

/**
 * The bytes of a number in Chromium's JSON (base::JSONWriter), as Chromium 145 and 156 count them
 * (test/e2e/csb-probe.spec.ts): a 32-bit integer is written as JS writes it; any other number is a double, in its
 * shortest digits, in decimal while its decimal exponent is from -6 to 11, with ".0" when that has no point, and
 * otherwise in exponent form as JS's toExponential() writes it. So 2^31 counts 12 ("2147483648.0") and a savedAt such
 * as 1793379341960 counts 17 ("1.79337934196e+12"), where JSON.stringify writes 10 and 13.
 */
function numberBytes(x: number): number {
  if (Number.isInteger(x) && x >= -(2 ** 31) && x < 2 ** 31) return String(x).length;
  const exp = x.toExponential();
  const e = Number(exp.slice(exp.indexOf("e") + 1));
  if (e < -6 || e > 11) return exp.length;
  const s = String(x);
  return s.includes(".") ? s.length : s.length + 2;
}

/** What a manifest's value takes as Chrome writes it: the JSON of the six fields, its numbers as numberBytes says. */
const manifestBytes = (m: SlotManifest): number =>
  JSON.stringify(m).length - [m.v, m.n, m.z, m.t].reduce((a, x) => a + String(x).length - numberBytes(x), 0);

/**
 * What an item takes of QUOTA_BYTES and QUOTA_BYTES_PER_ITEM, for the values a slot holds: a chunk of the text's
 * alphabet, or a manifest that parses. Null for any other value: this module does not guess at it.
 */
export function itemBytes(key: string, value: unknown): number | null {
  if (typeof value === "string") return TEXT_RE.test(value) ? key.length + 2 + value.length + quotes(value) : null;
  const m = parseManifest(value);
  return m === null || m === "newer" ? null : key.length + manifestBytes(m);
}

// ---- the plan of one write ------------------------------------------------------------------------------------------

/** The cut of a text into one slot's items. */
export type TextPlan = {
  kind: "plan";
  slot: string;
  manifest: SlotManifest;
  /** The one `set`: the manifest and chunks 0…n-1. */
  items: Record<string, string | SlotManifest>;
  /** What they take of QUOTA_BYTES (itemBytes, summed). */
  bytes: number;
};

/** The plan of one write: the cut of the file, and the generation it holds, as the rule and the link compare it. */
export type SlotPlan = TextPlan & { local: SlotLocal };

/** The text alone does not fit in ROOM_BYTES; `bytes` is what it would take. Nothing is written. */
export type TooLarge = { kind: "too_large"; bytes: number };

/**
 * The write of `backup` (format.ts makeCloudBackup) to `slot` under the new tag `g`: its text, its savedAt (the
 * manifest's `t`) and the generation it holds (`local`, which the link records) all come from the one file.
 */
export async function planSlot(backup: CloudBackup, slot: string, g: string): Promise<SlotPlan | TooLarge> {
  const p = await planText(cloudBackupText(backup), slot, g, backup.generation.savedAt);
  return p.kind === "plan" ? { ...p, local: slotLocal(backup) } : p;
}

/**
 * planSlot's cut, for a text: the items that write `text` to `slot` under the tag `g`, `t` the savedAt the manifest
 * names. Each chunk is as long as its item allows (ITEM_BYTES: its key, the two quotes and each quote's escape
 * counted), so a text is cut the same way every time. Refuses a bad slot id, tag or time, and an empty text or one
 * outside the alphabet. Exported for its tests (the limits need texts of exact lengths); the worker calls planSlot.
 */
export async function planText(text: string, slot: string, g: string, t: number): Promise<TextPlan | TooLarge> {
  if (!SLOT_RE.test(slot)) throw new SlotError("bad_slot");
  if (!TAG_RE.test(g)) throw new SlotError("bad_tag");
  if (!isTime(t)) throw new SlotError("bad_time");
  if (text.length === 0 || !TEXT_RE.test(text)) throw new SlotError("bad_text");
  const pieces: string[] = [];
  let bytes = 0;
  for (let at = 0; at < text.length;) {
    const key = chunkKey(slot, pieces.length);
    let left = ITEM_BYTES - key.length - 2;
    let end = at;
    for (; end < text.length; end++) {
      const cost = text.charCodeAt(end) === 34 ? 2 : 1;
      if (cost > left) break;
      left -= cost;
    }
    pieces.push(text.slice(at, end));
    bytes += ITEM_BYTES - left;
    at = end;
  }
  const manifest: SlotManifest = {
    v: 1,
    g,
    n: pieces.length,
    z: text.length,
    h: toB64(await sha256(utf8(text))),
    t,
  };
  bytes += manifestKey(slot).length + manifestBytes(manifest);
  if (bytes > ROOM_BYTES) return { kind: "too_large", bytes }; // (and so never more than MAX_CHUNKS chunks)
  const items: Record<string, string | SlotManifest> = { [manifestKey(slot)]: manifest };
  pieces.forEach((p, i) => (items[chunkKey(slot, i)] = p));
  return { kind: "plan", slot, manifest, items, bytes };
}

/**
 * The chunks of `slot` past its count `n` that are in the area now: the `remove` after a write that shrank the slot
 * (`n` the plan's), and after a skip of its own intact slot (`n` its manifest's: a worker stopped between the `set` and
 * the `remove` leaves them, and the next run that writes nothing removes them, rather than the next change).
 */
export function leftovers(area: Readonly<Record<string, unknown>>, slot: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n; i < MAX_CHUNKS; i++) if (Object.hasOwn(area, chunkKey(slot, i))) out.push(chunkKey(slot, i));
  return out;
}

/** Whether the plan fits beside everything else. */
export type Room = { kind: "ok" } | { kind: "no_room"; need: number; free: number };

/**
 * The room for a planned write, from `inUse` (chrome.storage.sync.getBytesInUse(null)) and the area as read: the
 * items the plan overwrites free their bytes (only those this module measures exactly); everything else stays, the
 * chunks a shrinking slot removes after the write included, as Chrome counts them when the `set` lands.
 */
export function room(plan: TextPlan, area: Readonly<Record<string, unknown>>, inUse: number): Room {
  let freed = 0;
  for (const key of Object.keys(plan.items)) if (Object.hasOwn(area, key)) freed += itemBytes(key, area[key]) ?? 0;
  const free = ROOM_BYTES - (inUse - freed);
  return plan.bytes <= free ? { kind: "ok" } : { kind: "no_room", need: plan.bytes, free };
}

// ---- reading --------------------------------------------------------------------------------------------------------

export type Assembled =
  | { kind: "ok"; manifest: SlotManifest; text: string; backup: CloudBackup }
  /** No manifest and no chunk under this id. */
  | { kind: "absent" }
  /** Not all there yet: no manifest beside chunks, a chunk missing, or chunks of another write (length, hash). */
  | { kind: "partial"; manifest: SlotManifest | null; why: "manifest" | "chunk" | "length" | "hash" }
  /** Not a slot this version can use: a manifest or chunk of the wrong shape, a file that does not parse. */
  | { kind: "invalid"; manifest: SlotManifest | null; why: "manifest" | "chunk" | "file" | "time" }
  /** A later Sixkey's manifest or file. */
  | { kind: "newer"; manifest: SlotManifest | null };

/** One slot of `area` (chrome.storage.sync.get(null)'s answer), assembled and checked as the header says. */
export async function assembleSlot(area: Readonly<Record<string, unknown>>, slot: string): Promise<Assembled> {
  if (!SLOT_RE.test(slot)) throw new SlotError("bad_slot");
  const mk = manifestKey(slot);
  if (!Object.hasOwn(area, mk)) {
    for (let i = 0; i < MAX_CHUNKS; i++)
      if (Object.hasOwn(area, chunkKey(slot, i))) return { kind: "partial", manifest: null, why: "manifest" };
    return { kind: "absent" };
  }
  const m = parseManifest(area[mk]);
  if (m === "newer") return { kind: "newer", manifest: null };
  if (m === null) return { kind: "invalid", manifest: null, why: "manifest" };
  const pieces: string[] = [];
  for (let i = 0; i < m.n; i++) {
    const key = chunkKey(slot, i);
    if (!Object.hasOwn(area, key)) return { kind: "partial", manifest: m, why: "chunk" };
    const p = area[key];
    if (typeof p !== "string") return { kind: "invalid", manifest: m, why: "chunk" };
    pieces.push(p);
  }
  const text = pieces.join("");
  if (text.length !== m.z) return { kind: "partial", manifest: m, why: "length" };
  if (toB64(await sha256(utf8(text))) !== m.h) return { kind: "partial", manifest: m, why: "hash" };
  let backup: CloudBackup;
  try {
    backup = await parseCloudBackupText(text);
  } catch (e) {
    if (e instanceof CloudBackupError && e.code === "newer_format") return { kind: "newer", manifest: m };
    return { kind: "invalid", manifest: m, why: "file" };
  }
  if (backup.generation.savedAt !== m.t) return { kind: "invalid", manifest: m, why: "time" };
  return { kind: "ok", manifest: m, text, backup };
}

export type SlotRead = { slot: string; keys: string[]; read: Assembled };

/** Every slot of the area, by id, and the keys of no slot (counted as used space, never read). */
export async function readSlots(
  area: Readonly<Record<string, unknown>>,
): Promise<{ slots: SlotRead[]; foreign: string[] }> {
  const bySlot = new Map<string, string[]>();
  const foreign: string[] = [];
  for (const key of Object.keys(area).sort()) {
    const k = parseKey(key);
    if (k === null) foreign.push(key);
    else bySlot.set(k.slot, [...(bySlot.get(k.slot) ?? []), key]);
  }
  const slots: SlotRead[] = [];
  for (const [slot, keys] of bySlot)
    // in the order of the sorted keys: by slot id
    slots.push({ slot, keys, read: await assembleSlot(area, slot) });
  return { slots, foreign };
}

/** An intact slot as a restore takes it (restore.ts): the slot id, its tag, its manifest's time, the file. */
export const slotCandidate = (slot: string, a: Extract<Assembled, { kind: "ok" }>): CloudCandidate => ({
  id: slot,
  head: a.manifest.g,
  modified: a.manifest.t,
  backup: a.backup,
});

// ---- the write rule -------------------------------------------------------------------------------------------------

/**
 * The wraps a file carries, as one string: each wrap's method and its random IV, which names it (a new wrap has a new
 * IV). No secret: the IVs are in the file. (rules.ts's, copied: that module goes with the Drive path.)
 */
export function wrapsOf(wraps: readonly { method: string; iv: string }[]): string {
  return wraps
    .map((w) => `${w.method}:${w.iv}`)
    .sort()
    .join(",");
}

/** Whether an envelope holds an empty vault (EMPTY_BELOW), with no key. */
export const isEmptyVault = (e: Pick<EncryptedVault, "ciphertext">): boolean => e.ciphertext.length < EMPTY_BELOW;

/** The generation that would be written now, as the rule compares it. */
export type SlotLocal = {
  seq: number;
  /**
   * The envelope's checksum: it names the data, which `seq` alone does not (the store counts on from a copy it falls
   * back to, so a save's counter may come again with other data).
   */
  sum: string;
  vaultId: string;
  vkId: string;
  opens: CloudOpens;
  wraps: string;
  empty: boolean;
};

/** The rule's view of a file the worker made (format.ts makeCloudBackup). */
export const slotLocal = (b: CloudBackup): SlotLocal => ({
  seq: b.generation.seq,
  sum: b.generation.envelope.checksum,
  vaultId: b.generation.envelope.vaultId,
  vkId: b.generation.keyring.vkId,
  opens: b.opens,
  wraps: wrapsOf(b.generation.keyring.wraps),
  empty: isEmptyVault(b.generation.envelope),
});

/** What a device knows of its slot (storage.local, read strictly by the worker's record reader). */
export type SlotLink = {
  v: 1;
  slot: string;
  /** The tag it last wrote there, or found there when it adopted the slot. */
  gen: string;
  /**
   * An overwrite's tag, recorded before its `set` (linkBefore): accepted as its own, and until the slot carries it, the
   * slot does not hold what the fields below say.
   */
  pending?: string;
  /** What was written last, or is being written while `pending` is set (SlotLocal's fields, `empty` aside). */
  seq: number;
  sum: string;
  vaultId: string;
  vkId: string;
  opens: CloudOpens;
  wraps: string;
  /** Rules 3 and 7: the slot may be newer than this computer's data; nothing is written until a page merges it. */
  held?: true;
  /** A restore merged more than one slot, or a page merged a held one: the next run writes, though nothing changed. */
  dirty?: true;
  /** The slot ids this device created, the last MAX_MINE. */
  mine: string[];
};

/** The own slot as read now: null when its manifest is absent; `g` null when its manifest is not one this reads. */
export type OwnSlot = null | { g: string | null; intact: boolean };

export function ownSlot(a: Assembled): OwnSlot {
  switch (a.kind) {
    case "ok":
      return { g: a.manifest.g, intact: true };
    case "absent":
      return null;
    case "partial":
      return a.manifest === null ? null : { g: a.manifest.g, intact: false };
    default:
      return { g: a.manifest?.g ?? null, intact: false };
  }
}

export type WriteDecision =
  | { kind: "write"; to: "new"; why: "first" | "other_writer" | "other_vault" }
  | { kind: "write"; to: "same"; why: "gone" | "changed" | "repair" | "dirty" };
export type SlotDecision =
  { kind: "skip"; why: "empty" | "unchanged" } | { kind: "hold"; why: "held" | "older" } | WriteDecision;

/** The decision for one run (the header's rules, in order). `own` is read only when there is a link. */
export function decideSlot(local: SlotLocal, link: SlotLink | null, own: OwnSlot): SlotDecision {
  if (local.empty && (link === null || link.vaultId !== local.vaultId)) return { kind: "skip", why: "empty" };
  if (link === null) return { kind: "write", to: "new", why: "first" };
  if (link.held) return { kind: "hold", why: "held" };
  if (own === null) return { kind: "write", to: "same", why: "gone" };
  if (own.g === null || (own.g !== link.gen && own.g !== link.pending))
    return { kind: "write", to: "new", why: "other_writer" };
  if (local.vaultId !== link.vaultId) return { kind: "write", to: "new", why: "other_vault" };
  if (local.seq < link.seq || (local.seq === link.seq && local.sum !== link.sum)) return { kind: "hold", why: "older" };
  // (past rule 7, the link's counter means the link's envelope)
  const same =
    local.seq === link.seq && local.vkId === link.vkId && local.opens === link.opens && local.wraps === link.wraps;
  const landed = link.pending === undefined || own.g === link.pending;
  if (same && own.intact && landed && !link.dirty) return { kind: "skip", why: "unchanged" };
  return { kind: "write", to: "same", why: !same ? "changed" : link.dirty ? "dirty" : "repair" };
}

const mineAfter = (mine: readonly string[], slot: string): string[] =>
  [...mine.filter((s) => s !== slot), slot].slice(-MAX_MINE);

/** The link after a write of `plan`: the new tag, what was written; `held`, `dirty` and `pending` gone. */
export function linkAfter(link: SlotLink | null, d: WriteDecision, plan: SlotPlan): SlotLink {
  const mine = link?.mine ?? [];
  const local = plan.local;
  return {
    v: 1,
    slot: plan.slot,
    gen: plan.manifest.g,
    seq: local.seq,
    sum: local.sum,
    vaultId: local.vaultId,
    vkId: local.vkId,
    opens: local.opens,
    wraps: local.wraps,
    mine: d.to === "new" ? mineAfter(mine, plan.slot) : [...mine],
  };
}

/**
 * The link saved before the write: already what is being written, so that a worker stopped after the `set` compares the
 * next generation with what the slot holds (an older copy put back meanwhile is held by rule 7). Overwriting its own
 * slot, the new tag is `pending` and the tag read there now (its own, rule 5) becomes `gen`: stopped before the `set`,
 * the slot carries `gen`, is its own, and is written again (rule 8 skips only once the slot carries `pending`); stopped
 * after it, the slot carries `pending`. A new slot's link is the final one at once: if the `set` never lands, the slot
 * is absent and rule 4 writes it again under the same id.
 */
export function linkBefore(link: SlotLink | null, own: OwnSlot, d: WriteDecision, plan: SlotPlan): SlotLink {
  if (d.to === "new") return linkAfter(link, d, plan);
  if (link === null || plan.slot !== link.slot) throw new SlotError("bad_slot", "an overwrite is of the link's slot");
  return { ...linkAfter(link, d, plan), gen: own?.g ?? link.gen, pending: plan.manifest.g };
}

/**
 * The link after a hold (rules 3 and 7): marked `held`, so that it stays held until a page merges the slot, whatever
 * the next saves do to the counter (without the mark, saves on an older copy would raise the counter past the link's
 * and rule 9 would overwrite the newer slot).
 */
export const heldLink = (link: SlotLink): SlotLink => ({ ...link, held: true });

/**
 * The link of a device restored from slots: it continues `slot`, the newest one it opened, from the tag it read there,
 * at its own save counter (the restore's write). `dirty` when the restore merged more than one slot, so the merge is
 * written at the next run; otherwise at the first change. Its own slot ids are kept; the adopted one is not among them.
 */
export const adoptSlot = (
  link: SlotLink | null,
  slot: string,
  g: string,
  local: SlotLocal,
  dirty: boolean,
): SlotLink => ({
  v: 1,
  slot,
  gen: g,
  seq: local.seq,
  sum: local.sum,
  vaultId: local.vaultId,
  vkId: local.vkId,
  opens: local.opens,
  wraps: local.wraps,
  ...(dirty ? { dirty: true as const } : {}),
  mine: [...(link?.mine ?? [])],
});

/**
 * A page merged the held slot into this computer's vault (`read`: the slot and the tag it read, null when it found
 * none). If the slot still carries that tag, and is still whole (a slot that is arriving again may be another write
 * under that tag's manifest: the page merges again once it is whole), the link is re-based on the merged vault and
 * marked `dirty`: rule 7 no longer holds (the store's counter restarts from the copy it fell back to, so the merge's
 * save may count below what was written last), and the next run writes the merge. The tag, `pending` and the vault are
 * kept: a slot another device wrote meanwhile still forks (rule 5), another vault still does (rule 6). Otherwise the
 * link stays held. Not handled here: the store falling back once more between the page's merge and this call (an
 * older copy put back after the merge). Then `local` is older than the merge, and the next write would drop what the
 * merge brought in; the page's message can carry the merge's counter and checksum, and the worker keep the link held
 * unless `local` is that save or a later one.
 */
export function mergedLink(
  link: SlotLink,
  local: SlotLocal,
  read: { slot: string; g: string | null },
  own: OwnSlot,
): SlotLink {
  if (!link.held || read.slot !== link.slot || (own?.g ?? null) !== read.g) return link;
  if (read.g !== null && !own?.intact) return link;
  const { held: _held, ...rest } = link;
  return {
    ...rest,
    seq: local.seq,
    sum: local.sum,
    vkId: local.vkId,
    opens: local.opens,
    wraps: local.wraps,
    dirty: true,
  };
}
