// A fake chrome.storage.sync for the backup in Chrome's sync storage (CSB; src/core/cloud/slots.ts,
// src/platform/csb-area.ts, src/platform/csb-read.ts): Chrome's quotas, its write-operation counters, onChanged, and a
// "remote", another computer's writes, which Chrome delivers here item by item and in any order.
//
// What it follows was measured in Chromium 156 (test/e2e/csb-probe.spec.ts pins each fact against the browser, this
// file's measure included; Chromium 145 gave the same texts, numbers and counters):
//   - An item takes its key's length and its value's JSON as Chromium writes it (chromiumJson): a string escapes `"`
//     and the backslash (2 bytes), \b \f \n \r \t (2), other control characters, `<`, U+2028 and U+2029 (6, \u…), and
//     takes every other character as its UTF-8 bytes (DEL, `>` and `&` one each); a 32-bit integer is written as JS
//     writes it; any other number is a double: decimal while its decimal exponent is from -6 to 11, with ".0" when it
//     has no point ("2147483648.0"), else in exponent form as JS's toExponential() writes it ("1.79337934196e+12").
//   - set: each item within QUOTA_BYTES_PER_ITEM (checked first), then the area within QUOTA_BYTES (102,400 is taken,
//     102,401 refused), then MAX_ITEMS items. A refused set writes none of its items. Chromium's own texts (TEXTS).
//   - set and remove each have their own counter of write operations: 120 calls a minute; the 121st call of that
//     operation is refused (TEXTS.minute) while the other still passes, and a clear too; a set refused for its bytes
//     counts too; get and getBytesInUse count nothing.
//   - getBytesInUse(keys) counts a key given twice twice (as Chrome does: csb-area.ts bytesInUse asks for each once).
//   - get(null) answers with the keys sorted, as Chrome's store keeps them; -0 is kept as the integer 0 (1 byte).
//   - onChanged: one event for each call that changed something, with every key it changed (old and new values); none
//     for a set that changes nothing (values compared as Chrome compares them, whatever the order of an object's keys).
// What it takes on trust, not measurable here: the counters' window (Chromium's quota service, as remembered: a fixed
// window from the first call after the last one ran out), clear's own counter (120 a minute, as set's), the hour's
// counter (1,800) and its text (the minute's template), the order of the item count against the area's bytes, and
// that items delivered by Chrome sync are applied without the quotas or counters (Chromium applies sync's own changes
// with its IGNORE_QUOTA option), so the area can hold more than QUOTA_BYTES.

/** Chromium's texts for its refusals (as measured: no period after the first three). */
export const TEXTS = {
  perItem: "Resource::kQuotaBytesPerItem quota exceeded",
  bytes: "Resource::kQuotaBytes quota exceeded",
  items: "Resource::kMaxItems quota exceeded",
  minute: "This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.",
  hour: "This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.",
} as const;

const escapeChar = (c: string): string => {
  switch (c) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
  }
  const u = c.charCodeAt(0);
  if (u < 0x20 || c === "<" || u === 0x2028 || u === 0x2029)
    return `\\u${u.toString(16).toUpperCase().padStart(4, "0")}`;
  return c;
};

/** A number as base::JSONWriter writes it (the header's rule). */
function chromiumNumber(x: number): string {
  if (Number.isInteger(x) && x >= -(2 ** 31) && x < 2 ** 31) return String(x); // (-0 too: "0", as Chrome keeps it)
  const exp = x.toExponential();
  const e = Number(exp.slice(exp.indexOf("e") + 1));
  if (e < -6 || e > 11) return exp;
  const s = String(x);
  return s.includes(".") ? s : `${s}.0`;
}

/** A value's JSON as Chromium writes it (a value as chrome.storage keeps it: JSON's types only). */
export function chromiumJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return chromiumNumber(v);
  if (typeof v === "string") return `"${Array.from(v, escapeChar).join("")}"`;
  if (Array.isArray(v)) return `[${v.map(chromiumJson).join(",")}]`;
  if (typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${chromiumJson(k)}:${chromiumJson(x)}`)
      .join(",")}}`;
  throw new Error(`not a stored value: ${typeof v}`);
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length; // a lone surrogate: U+FFFD, 3 bytes
/** What an item takes of QUOTA_BYTES and QUOTA_BYTES_PER_ITEM, as Chromium counts it. */
export const chromiumItemBytes = (key: string, value: unknown): number =>
  utf8Length(key) + utf8Length(chromiumJson(value));

export type Change = { oldValue?: unknown; newValue?: unknown };
export type Changes = Record<string, Change>;
type Listener = (changes: Changes) => void;
type WriteOp = "set" | "remove" | "clear";
type Op = WriteOp | "get" | "getBytesInUse";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const copy = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
/** A value's JSON with every object's keys sorted, as Chrome's store holds a value: what "unchanged" compares. */
const canonical = (v: unknown): string =>
  v !== null && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
    : JSON.stringify(v);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const keyList = (keys: null | undefined | string | readonly string[]): string[] | null =>
  keys === null || keys === undefined ? null : typeof keys === "string" ? [keys] : [...keys];

/** Another computer's writes, not yet here: Chrome sync delivers each item on its own, in any order. */
export class Remote {
  /** By key, in the order queued: a value, or a remove. A later write of a key replaces the queued one. */
  readonly queued = new Map<string, { value: unknown } | { gone: true }>();
  constructor(private readonly area: FakeSyncArea) {}

  /** Another computer's set (its items queued here). */
  put(items: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(items)) {
      this.queued.delete(k);
      this.queued.set(k, { value: copy(v) });
    }
  }

  /** Another computer's remove. */
  drop(keys: readonly string[]): void {
    for (const k of keys) {
      this.queued.delete(k);
      this.queued.set(k, { gone: true });
    }
  }

  pending(): string[] {
    return [...this.queued.keys()];
  }

  /** One queued item applied here, without quotas or counters, and its onChanged event. */
  deliver(key: string): void {
    const q = this.queued.get(key);
    if (!q) throw new Error(`nothing queued for ${key}`);
    this.queued.delete(key);
    this.area.applyRemote(key, q);
  }

  /** Every queued item, one at a time, in this order (default: as queued). */
  deliverAll(order: readonly string[] = this.pending()): void {
    for (const k of order) this.deliver(k);
  }
}

/** The fake area. Times come from `now` (default Date.now). */
export class FakeSyncArea {
  readonly QUOTA_BYTES = 102_400;
  readonly QUOTA_BYTES_PER_ITEM = 8_192;
  readonly MAX_ITEMS = 512;
  readonly MAX_WRITE_OPERATIONS_PER_MINUTE = 120;
  readonly MAX_WRITE_OPERATIONS_PER_HOUR = 1_800;
  /** The items, as Chrome keeps them (JSON copies). */
  readonly items = new Map<string, unknown>();
  /** Every call, in order, with its argument. */
  readonly calls: { op: Op; arg: unknown }[] = [];
  /** Rejections a test queues for the next calls of an operation (after the counters, as Chrome's refusals come). */
  readonly fail: Partial<Record<Op, string[]>> = {};
  readonly remote = new Remote(this);
  now: () => number;
  private readonly counters = new Map<string, { left: number; until: number }>();
  private readonly listeners = new Set<Listener>();
  readonly onChanged = {
    addListener: (f: Listener) => void this.listeners.add(f),
    removeListener: (f: Listener) => void this.listeners.delete(f),
    hasListener: (f: Listener) => this.listeners.has(f),
  };

  constructor(o: { now?: () => number; items?: Record<string, unknown> } = {}) {
    this.now = o.now ?? Date.now;
    for (const [k, v] of Object.entries(o.items ?? {})) this.items.set(k, copy(v));
  }

  /** The calls of one operation, in order. */
  callsOf(op: Op): unknown[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.arg);
  }

  /** The items now, as get(null) answers. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(
      [...this.items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, copy(v)]),
    );
  }

  /** What the area takes now, as getBytesInUse(null) answers. */
  inUse(): number {
    let n = 0;
    for (const [k, v] of this.items) n += chromiumItemBytes(k, v);
    return n;
  }

  /** The number of listeners onChanged has. */
  listenerCount(): number {
    return this.listeners.size;
  }

  async get(keys: null | string | readonly string[] = null): Promise<Record<string, unknown>> {
    this.calls.push({ op: "get", arg: keys });
    this.injected("get");
    const ks = keyList(keys);
    const all = this.snapshot();
    return ks === null ? all : Object.fromEntries(ks.filter((k) => Object.hasOwn(all, k)).map((k) => [k, all[k]]));
  }

  async getBytesInUse(keys: null | string | readonly string[] = null): Promise<number> {
    this.calls.push({ op: "getBytesInUse", arg: keys });
    this.injected("getBytesInUse");
    const ks = keyList(keys);
    if (ks === null) return this.inUse();
    let n = 0;
    for (const k of ks) if (this.items.has(k)) n += chromiumItemBytes(k, this.items.get(k)); // a key twice: twice
    return n;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.calls.push({ op: "set", arg: copy(items) });
    this.count("set");
    this.injected("set");
    const next = new Map(this.items);
    for (const [k, v] of Object.entries(items)) {
      const value = copy(v);
      if (chromiumItemBytes(k, value) > this.QUOTA_BYTES_PER_ITEM) throw new Error(TEXTS.perItem);
      next.set(k, value);
    }
    let total = 0;
    for (const [k, v] of next) total += chromiumItemBytes(k, v);
    if (total > this.QUOTA_BYTES) throw new Error(TEXTS.bytes);
    if (next.size > this.MAX_ITEMS) throw new Error(TEXTS.items);
    const changes: Changes = {};
    for (const [k, value] of Object.entries(items).map(([k, v]) => [k, copy(v)] as const)) {
      if (this.items.has(k) && same(this.items.get(k), value)) continue;
      changes[k] = this.items.has(k) ? { oldValue: this.items.get(k), newValue: value } : { newValue: value };
    }
    for (const [k, v] of next) this.items.set(k, v);
    this.emit(changes);
  }

  async remove(keys: string | readonly string[]): Promise<void> {
    this.calls.push({ op: "remove", arg: keyList(keys) });
    this.count("remove");
    this.injected("remove");
    const changes: Changes = {};
    for (const k of keyList(keys) ?? [])
      if (this.items.has(k)) {
        changes[k] = { oldValue: this.items.get(k) };
        this.items.delete(k);
      }
    this.emit(changes);
  }

  async clear(): Promise<void> {
    this.calls.push({ op: "clear", arg: null });
    this.count("clear");
    this.injected("clear");
    const changes: Changes = {};
    for (const [k, v] of this.items) changes[k] = { oldValue: v };
    this.items.clear();
    this.emit(changes);
  }

  /** Remote's delivery of one item (not a call of this context's: no counter, no quota). */
  applyRemote(key: string, q: { value: unknown } | { gone: true }): void {
    const had = this.items.has(key);
    const old = this.items.get(key);
    if ("gone" in q) {
      if (!had) return;
      this.items.delete(key);
      this.emit({ [key]: { oldValue: old } });
      return;
    }
    if (had && same(old, q.value)) return;
    this.items.set(key, copy(q.value));
    this.emit({ [key]: had ? { oldValue: old, newValue: copy(q.value) } : { newValue: copy(q.value) } });
  }

  private injected(op: Op): void {
    const text = this.fail[op]?.shift();
    if (text !== undefined) throw new Error(text);
  }

  /** One write operation of `op`: the minute's counter first, then the hour's. */
  private count(op: WriteOp): void {
    const t = this.now();
    for (const [name, period, limit, text] of [
      ["minute", MINUTE, this.MAX_WRITE_OPERATIONS_PER_MINUTE, TEXTS.minute],
      ["hour", HOUR, this.MAX_WRITE_OPERATIONS_PER_HOUR, TEXTS.hour],
    ] as const) {
      const key = `${op} ${name}`;
      let c = this.counters.get(key);
      if (!c || t > c.until) this.counters.set(key, (c = { left: limit, until: t + period }));
      if (c.left === 0) throw new Error(text);
      c.left--;
    }
  }

  /** onChanged's listeners, after the call has settled (a task later, as an event from the browser comes). */
  private emit(changes: Changes): void {
    if (Object.keys(changes).length === 0) return;
    setTimeout(() => {
      for (const f of [...this.listeners]) f(changes);
    }, 0);
  }
}
