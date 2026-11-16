// Merge two replicas of one vault. Each register of each entry keeps the value with the larger timestamp;
// exact ties fall back to comparing canonical JSON. Both rules are total orders, so the merge is commutative,
// associative and idempotent: devices can sync in any order and converge.
import type { Entry, Vault } from "./model";

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** True when the first register value should win. */
function wins(ha: string, ca: string, hb: string, cb: string): boolean {
  return ha > hb || (ha === hb && ca >= cb);
}

/** Later deletion stamp wins; an exact tie prefers "deleted". A missing stamp is older than any stamp. */
function deletionWins(x: Entry, y: Entry): boolean {
  const hx = x.dhlc ?? "";
  const hy = y.dhlc ?? "";
  if (hx !== hy) return hx > hy;
  return (x.deleted ? 1 : 0) >= (y.deleted ? 1 : 0);
}

const contentOf = (e: Entry) => ({
  type: e.type,
  issuer: e.issuer,
  label: e.label,
  secret: e.secret,
  algorithm: e.algorithm,
  digits: e.digits,
  period: e.period,
  domains: e.domains,
});
const placementOf = (e: Entry) => ({ group: e.group, order: e.order });

export function mergeEntry(x: Entry, y: Entry): Entry {
  if (x.id !== y.id) throw new MergeError("different entries");
  const c = wins(x.hlc, canonicalJson(contentOf(x)), y.hlc, canonicalJson(contentOf(y))) ? x : y;
  const p = wins(x.phlc, canonicalJson(placementOf(x)), y.phlc, canonicalJson(placementOf(y))) ? x : y;
  const d = deletionWins(x, y) ? x : y;

  // A hotp counter only moves forward, whichever side wrote the rest of the content. It is kept even if the type
  // later changes, so the merge stays associative.
  const cs = [x.counter, y.counter].filter((n): n is number => n !== undefined);
  const counter = cs.length ? Math.max(...cs) : undefined;
  const merged = clean({
    id: x.id,
    createdAt: Math.min(x.createdAt, y.createdAt),
    ...contentOf(c),
    counter,
    hlc: c.hlc,
    group: p.group,
    order: p.order,
    phlc: p.phlc,
    deleted: d.deleted,
    dhlc: d.dhlc,
  }) as Entry;
  // "deleted: false" with no deletion stamp says the same as no flag at all; keep one spelling so the bytes agree.
  if (!merged.deleted && merged.dhlc === undefined) delete merged.deleted;
  return merged;
}

export function mergeVaults(a: Vault, b: Vault): Vault {
  if (a.vaultId !== b.vaultId) throw new MergeError("different vaults");
  const byId = new Map<string, Entry>();
  for (const e of [...a.entries, ...b.entries]) {
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? mergeEntry(prev, e) : e);
  }
  return {
    schemaVersion: 1,
    vaultId: a.vaultId,
    entries: [...byId.values()].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)),
  };
}
