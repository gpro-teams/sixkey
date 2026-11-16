// The backup in Chrome's sync storage (CSB): its two records in storage.local, read strictly, as the Google Drive
// backup's were. A record that does not check out is taken as none, which is the safe answer: a configuration that
// does not check out is a backup never set up (off), a link that does not is no link (the next write makes a new slot,
// which overwrites nothing: core/cloud/slots.ts rule 2), a state that does not is a fresh one. Neither holds a secret:
// slot ids, write tags, the vault's save counter, envelope checksum, ids and wraps' IVs (all in the copy itself), times
// and byte counts. The worker (platform/csb-worker.ts) is their only writer, but for the store's recovery hook, which
// marks the link held (platform/cloud-mark.ts); pages send sk-csb-* messages.
//   sk_csb_cfg    { v, on, opens, declined, link }
//                 link: { v, slot, gen, pending?, seq, sum, vaultId, vkId, opens, wraps, held?, dirty?, mine } (slots.ts
//                 SlotLink)
//   sk_csb_state  { v, lastOk, err, errSince, pendingSince, retries, lastRun, bytes, used, others, seen, unsafe }
//                 others: { n, bytes, otherVaults, latest }; unsafe may be absent (a record written before it): false
import { MAX_MINE } from "../core/cloud/slot-limits";
import type { SlotLink } from "../core/cloud/slots";
import type { CloudOpens } from "../core/cloud/format";
import { csbStatus, type CloudRecord, type CsbError } from "../core/cloud/status";
import { CSB_CFG_KEY, CSB_STATE_KEY } from "./cloud-mark";

export { CSB_CFG_KEY, CSB_STATE_KEY };

export type CsbConfig = {
  v: 1;
  /** The backup is on: every change is written after the debounce. */
  on: boolean;
  /** "both", or the card's switch "只用恢复密钥打开". */
  opens: CloudOpens;
  /** The user turned the backup off: the popup's reminder no longer hands "turn on now" to the card. */
  declined: boolean;
  /** This device's slot (slots.ts SlotLink), or none yet. */
  link: SlotLink | null;
};

/** What the area held at the last run that read it, for the card's lines. */
export type CsbOthers = {
  /** The slots that are not this device's. */
  n: number;
  /** What they take, as Chrome counts it. */
  bytes: number;
  /** How many of them, whole, are copies of another vault. */
  otherVaults: number;
  /** The newest of their whole copies' times (the manifest's `t`), or null. */
  latest: number | null;
};

export type CsbState = Omit<CloudRecord, "err"> & {
  v: 1;
  err: CsbError | null;
  /** Failures in a row since the last success: picks the next retry's delay. */
  retries: number;
  /** When the last run ended, for the daily check. */
  lastRun: number | null;
  /** What this device's slot takes, as Chrome counts it; null when it has none. */
  bytes: number | null;
  /** What the whole area takes (getBytesInUse), at the last run that read it. */
  used: number | null;
  others: CsbOthers;
  /** A slot this device did not create was seen there (or it was restored from one): sync carries the area. */
  seen: boolean;
  /**
   * This worker's start could not close storage.sync to scripts in web pages (storage-access.ts restrictSyncAccess),
   * so nothing is written in this run of the worker: the card says why. Written by the worker when a run, a page's
   * message or its routine finds the answer other than this says.
   */
  unsafe: boolean;
};

export const NEW_CSB_CONFIG: CsbConfig = { v: 1, on: false, opens: "both", declined: false, link: null };
export const NEW_CSB_STATE: CsbState = {
  v: 1,
  lastOk: null,
  err: null,
  errSince: null,
  pendingSince: null,
  retries: 0,
  lastRun: null,
  bytes: null,
  used: null,
  others: { n: 0, bytes: 0, otherVaults: 0, latest: null },
  seen: false,
  unsafe: false,
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** Exactly these own fields, and the optional ones if present. */
const fieldsAre = (x: Record<string, unknown>, need: readonly string[], may: readonly string[] = []): boolean =>
  need.every((f) => Object.hasOwn(x, f)) && Object.keys(x).every((f) => need.includes(f) || may.includes(f));
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isTime = isCount;
const timeOrNull = (x: unknown): x is number | null => x === null || isTime(x);
const isOpens = (x: unknown): x is CloudOpens => x === "both" || x === "recovery";

const SLOT_RE = /^[a-z0-9]{8}$/;
const TAG_RE = /^[0-9a-f]{16}$/;
/** An envelope's checksum: a SHA-256 in canonical base64 (envelope.ts). */
const SUM_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const VAULT_RE = /^[A-Za-z0-9_-]{8,64}$/;
const VK_RE = /^[0-9a-f]{16}$/;
/** slots.ts wrapsOf: "method:iv" pairs joined by commas (base64 IVs). */
const WRAPS_RE = /^[a-z]{1,16}:[A-Za-z0-9+/=]{1,64}(?:,[a-z]{1,16}:[A-Za-z0-9+/=]{1,64}){0,15}$/;
const LINK_FIELDS = ["v", "slot", "gen", "seq", "sum", "vaultId", "vkId", "opens", "wraps", "mine"];
const LINK_OPTIONAL = ["pending", "held", "dirty"];

/** A stored link (slots.ts SlotLink), field by field, or null. */
export function parseSlotLink(x: unknown): SlotLink | null {
  if (!isRecord(x) || !fieldsAre(x, LINK_FIELDS, LINK_OPTIONAL) || x.v !== 1) return null;
  const { slot, gen, pending, seq, sum, vaultId, vkId, opens, wraps, held, dirty, mine } = x;
  if (typeof slot !== "string" || !SLOT_RE.test(slot) || typeof gen !== "string" || !TAG_RE.test(gen)) return null;
  if (pending !== undefined && (typeof pending !== "string" || !TAG_RE.test(pending))) return null;
  if (!isCount(seq) || typeof sum !== "string" || !SUM_RE.test(sum)) return null;
  if (typeof vaultId !== "string" || !VAULT_RE.test(vaultId) || typeof vkId !== "string" || !VK_RE.test(vkId))
    return null;
  if (!isOpens(opens) || typeof wraps !== "string" || !WRAPS_RE.test(wraps)) return null;
  if ((held !== undefined && held !== true) || (dirty !== undefined && dirty !== true)) return null;
  if (!Array.isArray(mine) || mine.length > MAX_MINE || new Set(mine).size !== mine.length) return null;
  if (!mine.every((s) => typeof s === "string" && SLOT_RE.test(s))) return null;
  return {
    v: 1,
    slot,
    gen,
    ...(pending !== undefined ? { pending } : {}),
    seq,
    sum,
    vaultId,
    vkId,
    opens,
    wraps,
    ...(held ? { held: true as const } : {}),
    ...(dirty ? { dirty: true as const } : {}),
    mine: [...(mine as string[])],
  };
}

/** The configuration, or the one of a backup never set up when the record is absent or does not check out. */
export function parseCsbConfig(x: unknown): CsbConfig {
  if (!isRecord(x) || !fieldsAre(x, ["v", "on", "opens", "declined", "link"]) || x.v !== 1)
    return { ...NEW_CSB_CONFIG };
  if (typeof x.on !== "boolean" || !isOpens(x.opens) || typeof x.declined !== "boolean") return { ...NEW_CSB_CONFIG };
  return { v: 1, on: x.on, opens: x.opens, declined: x.declined, link: x.link === null ? null : parseSlotLink(x.link) };
}

const ERRORS: readonly CsbError[] = ["too_large", "no_room", "held", "no_password", "unreadable", "busy", "other"];
/** At most every chunk and manifest of every slot the area can hold: a count past it is not one of ours. */
const MAX_BYTES = 1 << 30;
const isBytes = (x: unknown): x is number => isCount(x) && x <= MAX_BYTES;

function parseOthers(x: unknown): CsbOthers | null {
  if (!isRecord(x) || !fieldsAre(x, ["n", "bytes", "otherVaults", "latest"])) return null;
  const { n, bytes, otherVaults, latest } = x;
  // (no more slots than items: 512, each slot at least its manifest)
  if (!isCount(n) || n > 512 || !isBytes(bytes) || !isCount(otherVaults) || otherVaults > n || !timeOrNull(latest))
    return null;
  return { n, bytes, otherVaults, latest };
}

/**
 * Whether the backup runs: on, and not stopped by what only the person can fix (an error no retry fixes, changes waiting
 * three days or more, this browser's refusal to close the area: the popup's "备份已停"). While it runs, no reminder to
 * back up is shown, whatever the last copy's age (sk_last_backup): a vault unchanged for a week is not handed over again,
 * and its copy is the vault as it is. The popup's footer, and the settings page's rail.
 */
export function backupRuns(cfg: CsbConfig, st: CsbState, now: number): boolean {
  if (!cfg.on || st.unsafe) return false;
  const k = csbStatus(true, st, now).kind;
  return k !== "stopped" && k !== "stale";
}

/** The state, or a fresh one when the record is absent or does not check out. */
export function parseCsbState(x: unknown): CsbState {
  const fields = [
    "v",
    "lastOk",
    "err",
    "errSince",
    "pendingSince",
    "retries",
    "lastRun",
    "bytes",
    "used",
    "others",
    "seen",
  ];
  if (!isRecord(x) || !fieldsAre(x, fields, ["unsafe"]) || x.v !== 1) return { ...NEW_CSB_STATE };
  const { lastOk, err, errSince, pendingSince, retries, lastRun, bytes, used, seen } = x;
  const unsafe = Object.hasOwn(x, "unsafe") ? x.unsafe : false; // (absent: a record written before the field)
  const others = parseOthers(x.others);
  if (
    !timeOrNull(lastOk) ||
    !timeOrNull(errSince) ||
    !timeOrNull(pendingSince) ||
    !timeOrNull(lastRun) ||
    !(err === null || ERRORS.includes(err as CsbError)) ||
    !isCount(retries) ||
    !(bytes === null || isBytes(bytes)) ||
    !(used === null || isBytes(used)) ||
    others === null ||
    typeof seen !== "boolean" ||
    typeof unsafe !== "boolean"
  )
    return { ...NEW_CSB_STATE };
  return {
    v: 1,
    lastOk,
    err: err as CsbError | null,
    errSince,
    pendingSince,
    retries,
    lastRun,
    bytes,
    used,
    others,
    seen,
    unsafe,
  };
}
