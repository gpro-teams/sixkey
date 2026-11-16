// Edits. Each one returns a new vault and stamps the register it touches with the next clock tick.
import { normalizeBase32 } from "../totp/base32";
import type { OtpParams } from "../totp/otpauth";
import { formatHlc, parseHlc, succHlc, MAX_FUTURE_DRIFT_MS, type Clock, type Hlc } from "./hlc";
import { orderBetween } from "./fractional";
import { aliveEntries, entryIdentity, isAlive, isPurged, type Entry, type Vault } from "./model";
import { LIMITS } from "./validate";

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}

export type NewEntry = Pick<
  OtpParams,
  "type" | "issuer" | "label" | "secret" | "algorithm" | "digits" | "period" | "counter"
> & { group?: string; domains?: string[] };
export type ContentPatch = Partial<
  Pick<Entry, "issuer" | "label" | "algorithm" | "digits" | "period" | "domains" | "counter">
>;

const LONG_KEY = 32;

function replace(v: Vault, e: Entry): Vault {
  return { ...v, entries: v.entries.map((x) => (x.id === e.id ? e : x)) };
}
function get(v: Vault, id: string): Entry {
  const e = v.entries.find((x) => x.id === id);
  if (!e) throw new OpError("no such entry");
  return e;
}
/** A timestamp later than every stamp the entry already carries, even ones written while this clock ran far ahead. */
function stampAfter(clock: Clock, e: Entry): Hlc {
  const s = clock.next();
  const floor = [e.hlc, e.phlc, e.dhlc].filter((h): h is Hlc => !!h).reduce((a, b) => (a > b ? a : b));
  return s > floor ? s : succHlc(floor, clock.device);
}

function strip(e: Entry): Entry {
  return Object.fromEntries(Object.entries(e).filter(([, x]) => x !== undefined)) as Entry;
}

/** Spread keys for n entries evenly (balanced, so key length stays about log n). */
function spread(n: number, lo: string | null, hi: string | null): string[] {
  if (n <= 0) return [];
  const mid = Math.floor((n - 1) / 2);
  const key = orderBetween(lo, hi);
  return [...spread(mid, lo, key), key, ...spread(n - mid - 1, key, hi)];
}

/** Give every live entry a fresh, short ordering key. Used when keys collide or grow long. */
export function rebalance(v: Vault, clock: Clock): Vault {
  const alive = aliveEntries(v);
  const keys = spread(alive.length, null, null);
  const byId = new Map(alive.map((e, i) => [e.id, keys[i]!]));
  const stamp = clock.next();
  return { ...v, entries: v.entries.map((e) => (byId.has(e.id) ? { ...e, order: byId.get(e.id)!, phlc: stamp } : e)) };
}

/**
 * A new account. Refused once the vault holds LIMITS.entries accounts that are not erased (SYNC-DESIGN §3.13 C13): the
 * limit applies to adding and importing, not to reading or merging, so a vault a merge took past it stays usable.
 */
export function addEntry(
  v: Vault,
  input: NewEntry,
  clock: Clock,
  opts: { id?: string; now?: () => number } = {},
): { vault: Vault; entry: Entry } {
  if (v.entries.filter((e) => !isPurged(e)).length >= LIMITS.entries) throw new OpError("too many accounts");
  let vault = v;
  const last = aliveEntries(vault).at(-1);
  if (last && last.order.length > LONG_KEY) vault = rebalance(vault, clock);
  const tail = aliveEntries(vault).at(-1);
  const h = clock.next();
  const entry = strip({
    id: opts.id ?? crypto.randomUUID(),
    createdAt: (opts.now ?? Date.now)(),
    type: input.type,
    issuer: input.issuer,
    label: input.label,
    secret: normalizeBase32(input.secret),
    algorithm: input.algorithm,
    digits: input.digits,
    period: input.period,
    counter: input.type === "hotp" ? (input.counter ?? 0) : undefined,
    domains: input.domains,
    hlc: h,
    group: input.group,
    order: orderBetween(tail?.order ?? null, null),
    phlc: h,
  });
  if (vault.entries.some((x) => x.id === entry.id)) throw new OpError("duplicate id");
  return { vault: { ...vault, entries: [...vault.entries, entry].sort((a, b) => (a.id < b.id ? -1 : 1)) }, entry };
}

/** The key the added mode deduplicates by: the account's identity, issuer and label (case-insensitive). Null if erased. */
export function addedModeKey(e: Entry): string | null {
  const id = entryIdentity(e);
  return id === null ? null : `${id}\u0000${e.issuer.toLowerCase()}\u0000${e.label.toLowerCase()}`;
}

/**
 * The "added" mode (importBackup of another vault; the SYNC-DESIGN §3.5 join into another vault): every live account of
 * `source` that `target` does not already have becomes a new entry of `target`, with a new id. Accounts in the trash or
 * erased in `source` are not brought along. `against` says which accounts of `target` count as already there: "all" (the
 * import: an account the user put in the trash is not brought back) or "alive" (the join: an account must come out
 * alive, so one that matches only an account in the cloud's trash is added anew).
 */
export function addAccountsFrom(
  target: Vault,
  source: Vault,
  clock: Clock,
  against: "all" | "alive",
): { vault: Vault; added: number; skipped: number } {
  const have = new Set(
    target.entries
      .filter((e) => against === "all" || isAlive(e))
      .map(addedModeKey)
      .filter((k): k is string => k !== null),
  );
  let v = target;
  let added = 0;
  let skipped = 0;
  for (const e of source.entries) {
    if (!isAlive(e)) continue;
    const key = addedModeKey(e);
    if (key === null || have.has(key)) {
      skipped++;
      continue;
    }
    // the account's content as a new entry (a new id); the type's own fields come along
    const { type, issuer, label, secret, algorithm, digits, period, counter, group, domains } = e;
    v = addEntry(
      v,
      {
        type,
        issuer,
        label,
        secret,
        algorithm,
        digits,
        period,
        ...(counter !== undefined ? { counter } : {}),
        ...(group ? { group } : {}),
        ...(domains ? { domains } : {}),
      },
      clock,
    ).vault;
    added++; // `have` stays what `target` had, as importBackup always did: two equal accounts in `source` both come
  }
  return { vault: v, added, skipped };
}

export function editEntry(v: Vault, id: string, patch: ContentPatch, clock: Clock): Vault {
  const e = get(v, id);
  if (!isAlive(e)) throw new OpError("entry is in the trash");
  return replace(v, strip({ ...e, ...patch, hlc: stampAfter(clock, e) }));
}

export function setGroup(v: Vault, id: string, group: string | undefined, clock: Clock): Vault {
  const e = get(v, id);
  return replace(v, strip({ ...e, group, phlc: stampAfter(clock, e) }));
}

/** Move to `toIndex` in the list of live entries (counted without the moved entry). */
export function moveEntry(v: Vault, id: string, toIndex: number, clock: Clock): Vault {
  let vault = v;
  for (let attempt = 0; attempt < 2; attempt++) {
    const others = aliveEntries(vault).filter((e) => e.id !== id);
    const i = Math.max(0, Math.min(toIndex, others.length));
    const before = others[i - 1]?.order ?? null;
    const after = others[i]?.order ?? null;
    if (before !== null && after !== null && before >= after) {
      vault = rebalance(vault, clock); // two devices picked the same key; make room and retry
      continue;
    }
    const moving = get(vault, id);
    return replace(vault, { ...moving, order: orderBetween(before, after), phlc: stampAfter(clock, moving) });
  }
  throw new OpError("could not order entry");
}

export function deleteEntry(v: Vault, id: string, clock: Clock): Vault {
  const e = get(v, id);
  return replace(v, { ...e, deleted: true, dhlc: stampAfter(clock, e) });
}

export function restoreEntry(v: Vault, id: string, clock: Clock): Vault {
  const e = get(v, id);
  if (isPurged(e)) throw new OpError("entry was erased for good");
  return replace(v, { ...e, deleted: false, dhlc: stampAfter(clock, e) });
}

/** Erase the secret and details for good, keeping only the tombstone so the deletion still syncs. */
export function purgeEntry(v: Vault, id: string, clock: Clock): Vault {
  const e = get(v, id);
  const h = stampAfter(clock, e);
  const cleared = strip({ ...e, issuer: "", label: "", secret: "", domains: undefined, counter: undefined, hlc: h });
  return replace(v, { ...cleared, deleted: true, dhlc: succHlc(h, clock.device) }); // dhlc > hlc keeps it dead
}

/** Bring a clock past every timestamp in a vault, e.g. after loading from disk or merging a remote copy. */
export function observeVault(clock: Clock, v: Vault): void {
  for (const e of v.entries) for (const h of [e.hlc, e.phlc, e.dhlc]) if (h) clock.observe(h);
}

/**
 * Pull the timestamps of an untrusted vault (a backup, a remote copy) back to at most now + 24h before merging it.
 * Each entry's three stamps move down together, so their order relative to each other survives and a deleted entry
 * does not come back to life (or the other way round) just because it was clamped.
 */
export function clampVault(v: Vault, now: number): Vault {
  const limit = now + MAX_FUTURE_DRIFT_MS;
  return {
    ...v,
    entries: v.entries.map((e) => {
      const stamps = [e.hlc, e.phlc, e.dhlc].filter((h): h is Hlc => !!h);
      const top = Math.max(...stamps.map((h) => parseHlc(h)?.wall ?? 0));
      if (top <= limit) return e;
      const delta = top - limit;
      const shift = (h: Hlc): Hlc => {
        const p = parseHlc(h)!;
        return formatHlc(Math.max(0, p.wall - delta), p.counter, p.device);
      };
      return strip({ ...e, hlc: shift(e.hlc), phlc: shift(e.phlc), dhlc: e.dhlc ? shift(e.dhlc) : undefined });
    }),
  };
}
