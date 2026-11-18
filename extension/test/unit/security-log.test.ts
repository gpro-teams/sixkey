// SYNC-DESIGN H6, PHASE0X-PLAN A3: the local security log on its own (security-log.ts). What it records through the
// service, and what it must never break there, is in test/unit/service.test.ts ("H3 and H6"); a crash at any write is
// in test/fault/security-log-crash.test.ts. Since budget work 3 (docs/design/notes/BUDGET3-NOTES.md §5) the record knows
// a kind by its form only, and the names are security-kinds.ts's: what it writes, reads back and keeps is held here.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { SECURITY_KINDS, type SecurityKind } from "../../src/core/service/security-kinds";
import {
  FAILURES,
  parseSecurityLog,
  SECURITY_LOG_KEY,
  SECURITY_LOG_MAX,
  SecurityLog,
  securityReader,
} from "../../src/core/service/security-log";
import { tear } from "../helpers/faulty-kv";

/** Records every key asked for, so a test can show the log touches nothing but its own. */
class SpyKV implements KV {
  readonly touched: string[] = [];
  gets = 0;
  sets = 0;
  keysCalls = 0;
  constructor(readonly inner: MemoryKV = new MemoryKV()) {}
  async get(keys: string[]) {
    this.gets++;
    this.touched.push(...keys);
    return this.inner.get(keys);
  }
  async set(items: Record<string, unknown>) {
    this.sets++;
    this.touched.push(...Object.keys(items));
    return this.inner.set(items);
  }
  async remove(keys: string[]) {
    this.touched.push(...keys);
    return this.inner.remove(keys);
  }
  async keys() {
    this.keysCalls++;
    return this.inner.keys();
  }
}
/** Reads, writes or both fail, as chrome.storage can. */
class BrokenKV extends MemoryKV {
  constructor(private readonly what: { get?: boolean; set?: boolean }) {
    super();
  }
  override async get(keys: string[]) {
    if (this.what.get) throw new Error("IO error");
    return super.get(keys);
  }
  override async set(items: Record<string, unknown>) {
    if (this.what.set) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    return super.set(items);
  }
}

function make(kv: KV = new MemoryKV()) {
  const t = { now: 1_700_000_000_000 };
  const diag: string[] = [];
  const log = new SecurityLog({ kv, now: () => (t.now += 1000), onDiag: (m) => diag.push(m) });
  return { kv, t, diag, log };
}
const stored = (kv: MemoryKV) => kv.data.get(SECURITY_LOG_KEY);
const kindsOldestFirst = async (log: SecurityLog) => (await log.read()).entries.map((e) => e.kind).reverse();
async function appendMany(log: SecurityLog, kind: SecurityKind, n: number) {
  for (let i = 0; i < n; i++) await log.append(kind);
}

describe("the security log on its own", () => {
  it("starts empty; constructing it reads nothing, reading it writes nothing", async () => {
    const spy = new SpyKV();
    const { log } = make(spy);
    expect(spy.gets + spy.sets).toBe(0);
    expect(await log.read()).toEqual({ state: "ok", entries: [], failed: 0, ackAt: null }); // no log yet: a true zero
    expect(await log.failuresSinceAck()).toBe(0);
    expect(await log.recent(5)).toEqual([]);
    expect(spy.sets).toBe(0);
    expect(spy.inner.data.has(SECURITY_LOG_KEY)).toBe(false);
  });

  it("keeps a time and a kind per entry, nothing else; read and recent give the newest first", async () => {
    const kv = new MemoryKV();
    const { log, t } = make(kv);
    await log.append("unlock_failed");
    await log.append("export_plain");
    await log.append("key_rotated");
    const v = await log.read();
    expect(v.entries.map((e) => e.kind)).toEqual(["key_rotated", "export_plain", "unlock_failed"]);
    expect(v.entries[0]!.at).toBe(t.now);
    expect(v.entries[0]!.at).toBeGreaterThan(v.entries[1]!.at);
    expect(await log.recent(2)).toEqual(v.entries.slice(0, 2));
    expect(await log.recent(0)).toEqual([]);
    expect(await log.recent(-3)).toEqual([]);
    const raw = stored(kv) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["entries", "failed", "v"]);
    expect(raw.v).toBe(2); // R8: written as version 2
    for (const e of raw.entries as object[]) expect(Object.keys(e).sort()).toEqual(["at", "kind"]);
  });

  it("counts wrong passwords and recovery codes since the last ack; ack takes off what was shown and keeps the entries", async () => {
    const kv = new MemoryKV();
    const { log, t } = make(kv);
    await appendMany(log, "unlock_failed", 3);
    await log.append("recovery_failed");
    await log.append("export_plain");
    await log.append("recovery_used"); // a success, not a guess
    expect(await log.failuresSinceAck()).toBe(4);
    await log.ack(4);
    const after = await log.read();
    expect(after.failed).toBe(0);
    expect(after.ackAt).toBe(t.now);
    expect(after.entries).toHaveLength(6);
    await log.append("unlock_failed");
    expect(await log.failuresSinceAck()).toBe(1);
    expect(FAILURES).toEqual(["unlock_failed", "recovery_failed", "pin_failed"]); // a wrong PIN is a guess too (QUICK-UNLOCK)
  });

  it("a wrong guess added after the notice read the count is still reported: ack takes off only what was shown", async () => {
    const { log } = make();
    await appendMany(log, "unlock_failed", 3);
    const shown = await log.failuresSinceAck(); // the popup shows "3" ...
    await log.append("unlock_failed"); // ... another page records a 4th ...
    await log.ack(shown); // ... and the popup acks what it showed
    expect(await log.failuresSinceAck()).toBe(1);
    await log.ack(10); // more than there is: down to zero, not below
    expect(await log.failuresSinceAck()).toBe(0);
    expect((await log.read()).entries).toHaveLength(4);
  });

  it("ack writes nothing when there is nothing to take off, creates no log, and ignores a count that is not a positive whole number", async () => {
    const spy = new SpyKV();
    const { log } = make(spy);
    await log.ack(1);
    expect(spy.sets).toBe(0);
    expect(spy.inner.data.has(SECURITY_LOG_KEY)).toBe(false);
    await log.append("export_plain");
    const sets = spy.sets;
    await log.ack(1); // no wrong guess to take off
    expect(spy.sets).toBe(sets);
    await appendMany(log, "unlock_failed", 2);
    const sets2 = spy.sets;
    for (const n of [0, -1, Number.NaN, 1.5, Infinity]) await log.ack(n);
    expect(spy.sets).toBe(sets2);
    expect(await log.failuresSinceAck()).toBe(2);
  });

  it("the count does not depend on the clock: wrong guesses after an ack count even if the clock went back", async () => {
    const { log, t } = make();
    await log.append("unlock_failed");
    t.now = 4_000_000_000_000; // the clock was far ahead when the user looked ...
    await log.ack(1);
    t.now = 1_700_000_000_000; // ... and is right again when someone guesses
    await appendMany(log, "unlock_failed", 2);
    expect(await log.failuresSinceAck()).toBe(2);
  });

  it("clear forgets the entries, the count and the last ack, and leaves one log_cleared entry", async () => {
    const kv = new MemoryKV();
    const { log, t } = make(kv);
    await appendMany(log, "unlock_failed", 3);
    await log.ack(3);
    await log.append("recovery_failed");
    await log.clear();
    expect(await log.read()).toEqual({
      state: "ok",
      entries: [{ at: t.now, kind: "log_cleared" }],
      failed: 0,
      ackAt: null,
    });
    expect(stored(kv)).toEqual({ v: 2, entries: [{ at: t.now, kind: "log_cleared" }], failed: 0 }); // R8: every write is version 2
  });

  it("holds at most 50 entries, dropping the oldest", async () => {
    const { log } = make();
    for (let i = 0; i < 60; i++) await log.append(i % 2 ? "export_plain" : "export_encrypted");
    const v = await log.read();
    expect(v.entries).toHaveLength(SECURITY_LOG_MAX);
    expect(SECURITY_LOG_MAX).toBe(50);
    // the newest 50 of the 60: the first ten are gone
    expect(v.entries.at(-1)!.at).toBe(1_700_000_000_000 + 11 * 1000);
    expect(v.entries[0]!.at).toBe(1_700_000_000_000 + 60 * 1000);
  });

  it("a burst of wrong guesses cannot push out the record of exports and key changes, and the count stays exact", async () => {
    const { log } = make();
    await appendMany(log, "export_plain", 10);
    await log.append("key_rotated");
    await appendMany(log, "unlock_failed", 200);
    const v = await log.read();
    expect(v.entries).toHaveLength(SECURITY_LOG_MAX);
    expect(v.entries.filter((e) => e.kind === "export_plain")).toHaveLength(10);
    expect(v.entries.filter((e) => e.kind === "key_rotated")).toHaveLength(1);
    expect(v.failed).toBe(200);
    // the wrong guesses kept are the newest ones
    expect(v.entries[0]).toMatchObject({ kind: "unlock_failed", at: 1_700_000_000_000 + 211 * 1000 });
    expect(v.entries.filter((e) => e.kind === "unlock_failed").at(-1)!.at).toBe(1_700_000_000_000 + (211 - 38) * 1000);
  });

  it("and the reverse: many other entries keep the newest 25 wrong guesses, and the count", async () => {
    const { log } = make();
    await appendMany(log, "unlock_failed", 30);
    await appendMany(log, "export_encrypted", 200);
    const v = await log.read();
    expect(v.entries).toHaveLength(SECURITY_LOG_MAX);
    const fails = v.entries.filter((e) => e.kind === "unlock_failed");
    expect(fails).toHaveLength(SECURITY_LOG_MAX / 2);
    expect(fails[0]!.at).toBe(1_700_000_000_000 + 30 * 1000); // the newest of them
    expect(v.failed).toBe(30);
  });

  it("stays small: a thousand entries of every kind fit in a few kilobytes", async () => {
    const kv = new MemoryKV();
    const { log } = make(kv);
    for (let i = 0; i < 1000; i++) await log.append(SECURITY_KINDS[i % SECURITY_KINDS.length]!);
    expect((stored(kv) as { entries: unknown[] }).entries).toHaveLength(SECURITY_LOG_MAX);
    expect(JSON.stringify(stored(kv)).length).toBeLessThan(4096);
  });

  it.each([
    ["a string", "garbage"],
    ["a number", 42],
    ["null", null],
    ["an array", [{ at: 1, kind: "unlock_failed" }]],
    ["no version", { entries: [] }],
    ["version as text", { v: "1", entries: [] }],
    ["entries not a list", { v: 1, entries: "x" }],
    ["a torn write", tear({ v: 1, entries: [{ at: 1, kind: "unlock_failed" }], failed: 1 })],
  ])(
    "damaged (%s): reads as damaged, not as a clean zero, and the next entry starts a new log",
    async (_name, value) => {
      const kv = new MemoryKV();
      kv.data.set(SECURITY_LOG_KEY, value);
      const { log, diag, t } = make(kv);
      expect(await log.read()).toEqual({ state: "damaged", entries: [], failed: 0, ackAt: null });
      await log.append("unlock_failed");
      expect(stored(kv)).toEqual({ v: 2, entries: [{ at: t.now, kind: "unlock_failed" }], failed: 1 });
      expect(diag).toContain("security log was damaged; starting a new one");
    },
  );

  it("drops entries it cannot read and keeps the rest; a missing count is recounted from the entries after the last ack", async () => {
    const kv = new MemoryKV();
    kv.data.set(SECURITY_LOG_KEY, {
      v: 1,
      ackAt: 2,
      entries: [
        { at: 1, kind: "unlock_failed" },
        { at: "x", kind: "export_plain" },
        { at: 2, kind: "made_up" }, // a kind's form, of no name this version has: read back (the card lists names only)
        { at: 2.5, kind: "Made-Up" }, // not a kind's form: not read
        null,
        { at: 3, kind: "recovery_failed", note: "dropped" },
        { at: Infinity, kind: "unlock_failed" },
        { at: 4, kind: "key_rotated" },
      ],
    });
    const { log } = make(kv);
    expect(await log.read()).toEqual({
      state: "ok",
      entries: [
        { at: 4, kind: "key_rotated" },
        { at: 3, kind: "recovery_failed" },
        { at: 2, kind: "made_up" },
        { at: 1, kind: "unlock_failed" },
      ],
      failed: 1,
      ackAt: 2,
    });
    expect(
      parseSecurityLog({
        v: 1,
        entries: [
          { at: 1, kind: "unlock_failed" },
          { at: 2, kind: "recovery_failed" },
        ],
        failed: -1,
      }),
    ).toMatchObject({ failed: 2 });
    expect(parseSecurityLog({ v: 1, entries: [], failed: 7 })).toMatchObject({ failed: 7 });
    // a long list (edited by hand) is cut to the newest 50 when read
    const many = Array.from({ length: 500 }, (_, i) => ({ at: i, kind: "export_plain" }));
    const p = parseSecurityLog({ v: 1, entries: many, failed: 0 });
    expect(p !== null && p !== "newer" && p.entries.length).toBe(SECURITY_LOG_MAX);
    expect(p !== null && p !== "newer" && p.entries[0]!.at).toBe(450);
  });

  it("a newer version's kinds and fields in a version 2 record are kept as they are when it is rewritten, counted and trimmed like the rest, and read back", async () => {
    const kv = new MemoryKV();
    const unknown = { at: 5, kind: "from_a_newer_version", detail: { n: 1 } };
    const withField = { at: 6, kind: "export_plain", note: "a field this version does not know" };
    kv.data.set(SECURITY_LOG_KEY, {
      v: 2,
      entries: [{ at: 4, kind: "unlock_failed" }, unknown, withField],
      failed: 1,
      extra: { x: 1 },
    });
    const { log } = make(kv);
    expect(await log.read()).toEqual({
      state: "ok",
      entries: [
        { at: 6, kind: "export_plain" },
        { at: 5, kind: "from_a_newer_version" }, // its fields stay in the record; a page gets a time and a kind
        { at: 4, kind: "unlock_failed" },
      ],
      failed: 1,
      ackAt: null,
    });
    await log.append("unlock_failed");
    await log.ack(1);
    const after = stored(kv) as { v: number; entries: unknown[]; failed: number; extra: unknown };
    expect(after.v).toBe(2);
    expect(after.extra).toEqual({ x: 1 }); // the record's own unknown field
    expect(after.entries.slice(0, 3)).toEqual([{ at: 4, kind: "unlock_failed" }, unknown, withField]); // byte for byte
    expect(after.failed).toBe(1); // the new wrong guess, after the ack of one
    // counted and trimmed like the rest: the oldest go first when the list is full
    for (let i = 0; i < SECURITY_LOG_MAX; i++) await log.append("export_plain");
    const full = stored(kv) as { entries: { kind: string }[] };
    expect(full.entries).toHaveLength(SECURITY_LOG_MAX);
    expect(full.entries.some((e) => e.kind === "from_a_newer_version")).toBe(false);
  });

  it("a log from a newer version reads as newer (not as a clean zero), and is left exactly as it is, except by an explicit clear", async () => {
    const kv = new MemoryKV();
    const newer = { v: 3, entries: [{ at: 1, kind: "something_new" }], extra: { x: 1 } }; // R8: version 2 is this one; newer is 3
    kv.data.set(SECURITY_LOG_KEY, structuredClone(newer));
    const { log, diag } = make(kv);
    expect(await log.read()).toEqual({ state: "newer", entries: [], failed: 0, ackAt: null });
    await log.append("unlock_failed");
    await log.append("export_plain");
    await log.ack(1);
    expect(stored(kv)).toEqual(newer);
    // each entry it could not add is reported, not dropped silently
    expect(diag).toEqual([
      "security log is from a newer version; entry not added",
      "security log is from a newer version; entry not added",
    ]);
    await log.clear();
    expect(stored(kv)).toMatchObject({ v: 2, entries: [{ kind: "log_cleared" }] });
  });

  it("a read that throws: append writes nothing (the record is not replaced on its account) and resolves; read and ack reject", async () => {
    const kv = new BrokenKV({ get: true });
    kv.data.set(SECURITY_LOG_KEY, { v: 1, entries: [{ at: 1, kind: "export_plain" }], failed: 0 });
    const before = structuredClone(kv.data.get(SECURITY_LOG_KEY));
    const { log, diag } = make(kv);
    await expect(log.append("unlock_failed")).resolves.toBeUndefined();
    expect(kv.data.get(SECURITY_LOG_KEY)).toEqual(before);
    expect(diag).toEqual(["security log entry not written"]);
    await expect(log.read()).rejects.toThrow("IO error");
    await expect(log.failuresSinceAck()).rejects.toThrow("IO error");
    await expect(log.ack(1)).rejects.toThrow("IO error");
    expect(kv.data.get(SECURITY_LOG_KEY)).toEqual(before);
  });

  it("the server sync's kinds, no kinds since its client went (DV-0b), are kept in a record that has them, like a newer version's", async () => {
    const kv = new MemoryKV();
    const { log } = make(kv);
    kv.data.set(SECURITY_LOG_KEY, {
      v: 2,
      entries: [
        { at: 1, kind: "keys_adopted" },
        { at: 2, kind: "keys_adopted_back" },
      ],
      failed: 0,
    });
    await log.append("unlock_failed");
    const kinds = await kindsOldestFirst(log);
    expect(kinds).toHaveLength(3);
    expect(kinds).toEqual(expect.arrayContaining(["keys_adopted", "keys_adopted_back", "unlock_failed"]));
  });

  // the form: a lower-case ASCII letter, then lower-case ASCII letters and underscores, 1 to 32 in all
  const NOT_A_KIND: unknown[] = [
    "",
    "Unlock_failed",
    "unlock-failed",
    "unlock failed",
    " unlock_failed",
    "unlock_failed\n",
    "_unlock",
    "1unlock",
    "pin2",
    "ünlock",
    "unlock_f\u0430iled", // a Cyrillic a
    "a".repeat(33),
    "x".repeat(32) + "_",
    42,
    null,
    undefined,
    { kind: "unlock_failed" },
  ];
  it("a kind not of a kind's form is not added (so nothing unreadable is ever written), nor read back", async () => {
    const spy = new SpyKV();
    const { log, diag } = make(spy);
    for (const k of NOT_A_KIND) await log.append(k as never);
    expect(spy.sets).toBe(0);
    expect(spy.inner.data.has(SECURITY_LOG_KEY)).toBe(false);
    expect(diag).toEqual(NOT_A_KIND.map(() => "security log: malformed kind not added"));
    // stored by another writer, such an entry stays in the record, as it is, and is not read
    const kv = new MemoryKV();
    const odd = NOT_A_KIND.map((kind, i) => ({ at: i + 1, kind }));
    kv.data.set(SECURITY_LOG_KEY, { v: 2, entries: [...odd, { at: 100, kind: "export_plain" }], failed: 0 });
    const other = make(kv).log;
    expect((await other.read()).entries).toEqual([{ at: 100, kind: "export_plain" }]);
    await other.append("key_rotated");
    const after = (stored(kv) as { entries: unknown[] }).entries;
    const kept = odd.filter((e) => typeof e.kind === "string"); // an entry without a string kind is no entry at all
    expect(after.slice(0, kept.length)).toEqual(kept);
    expect(after).toHaveLength(kept.length + 2);
  });

  it("every kind's form, 1 to 32 characters, is added and read back, whatever its name; every named kind has the form", async () => {
    const { log, diag } = make();
    const odd = ["a", "z".repeat(32), "x_", "a__b", "from_a_newer_version", "constructor", "to_string"];
    for (const k of odd) await log.append(k as never);
    expect(diag).toEqual([]);
    expect(await kindsOldestFirst(log)).toEqual(odd);
    const named = make().log;
    for (const k of SECURITY_KINDS) await named.append(k);
    expect(await kindsOldestFirst(named)).toEqual([...SECURITY_KINDS].slice(-SECURITY_LOG_MAX));
    for (const k of SECURITY_KINDS) expect(k, k).toMatch(/^[a-z][a-z_]{0,31}$/);
  });

  it("whatever version wrote it, every entry of a kind's form is read back and kept as it was when the record is rewritten", async () => {
    const form = fc.stringMatching(/^[a-z][a-z_]{0,31}$/);
    const entry = fc.record(
      { at: fc.nat({ max: 2 ** 40 }), kind: form, extra: fc.option(fc.jsonValue(), { nil: undefined }) },
      { requiredKeys: ["at", "kind"] },
    );
    await fc.assert(
      fc.asyncProperty(fc.array(entry, { maxLength: SECURITY_LOG_MAX - 1 }), async (entries) => {
        const kv = new MemoryKV();
        const written = entries.map((e) => (e.extra === undefined ? { at: e.at, kind: e.kind } : { ...e }));
        kv.data.set(SECURITY_LOG_KEY, { v: 2, entries: structuredClone(written), failed: 0 });
        const { log } = make(kv);
        expect((await log.read()).entries).toEqual(written.map((e) => ({ at: e.at, kind: e.kind })).reverse());
        await log.append("export_plain"); // rewritten: one more entry, the list still under 50
        const after = (stored(kv) as { entries: unknown[] }).entries;
        expect(after.slice(0, written.length)).toEqual(written);
        expect((await log.read()).entries.slice(1)).toEqual(written.map((e) => ({ at: e.at, kind: e.kind })).reverse());
      }),
      { numRuns: 150 },
    );
  });

  it("a write that throws: append still resolves, and the failure goes to the diagnostics log", async () => {
    const { log, diag } = make(new BrokenKV({ set: true }));
    await expect(log.append("export_plain")).resolves.toBeUndefined();
    expect(diag).toEqual(["security log entry not written"]);
  });

  it("touches its own key and nothing else: not sk_events, not the vault, never a listing of keys", async () => {
    const spy = new SpyKV();
    const events = [{ id: "1-0-slot_fallback", kind: "slot_fallback", at: 1, restoredTo: 1, detail: "x" }];
    spy.inner.data.set("sk_events", structuredClone(events));
    const { log } = make(spy);
    for (const k of SECURITY_KINDS) await log.append(k);
    await log.read();
    await log.recent(3);
    await log.failuresSinceAck();
    await log.ack(1);
    await log.clear();
    expect(new Set(spy.touched)).toEqual(new Set([SECURITY_LOG_KEY]));
    expect(spy.keysCalls).toBe(0);
    expect(spy.inner.data.get("sk_events")).toEqual(events);
  });

  it("entries added at the same time from several pages are all kept (one lock across them)", async () => {
    const kv = new MemoryKV();
    const lock = createMutex();
    const pages = [0, 1, 2].map(() => new SecurityLog({ kv, lock }));
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => pages[i % 3]!.append(i % 2 ? "unlock_failed" : "export_plain")),
    );
    const v = await pages[0]!.read();
    expect(v.entries).toHaveLength(30);
    expect(v.failed).toBe(15);
  });

  it("ack runs under the log's lock: entries added around it are all kept, and exactly the count shown comes off", async () => {
    // Storage as slow as a real one, so a read-modify-write outside the lock would overlap the appends (review A3-3).
    class SlowKV extends MemoryKV {
      override async get(keys: string[]) {
        await new Promise((r) => setTimeout(r, 2));
        return super.get(keys);
      }
      override async set(items: Record<string, unknown>) {
        await new Promise((r) => setTimeout(r, 2));
        return super.set(items);
      }
    }
    const kv = new SlowKV();
    const lock = createMutex();
    const popup = new SecurityLog({ kv, lock });
    const other = new SecurityLog({ kv, lock });
    await other.append("unlock_failed"); // the one the popup shows
    await Promise.all([
      ...Array.from({ length: 3 }, () => other.append("unlock_failed")),
      popup.ack(1),
      ...Array.from({ length: 3 }, () => other.append("export_plain")),
    ]);
    const v = await popup.read();
    expect(v.entries).toHaveLength(7);
    expect(v.failed).toBe(3);
  });

  it("clear runs under the log's lock: nothing added before it survives it, everything added after it does", async () => {
    const kv = new MemoryKV();
    const lock = createMutex();
    const a = new SecurityLog({ kv, lock });
    const b = new SecurityLog({ kv, lock });
    await Promise.all([
      ...Array.from({ length: 10 }, () => a.append("unlock_failed")),
      b.clear(),
      ...Array.from({ length: 5 }, () => a.append("export_plain")),
    ]);
    const v = await a.read();
    expect(v.entries.map((e) => e.kind).reverse()).toEqual(["log_cleared", ...Array(5).fill("export_plain")]);
    expect(v.failed).toBe(0);
  });

  it("the pages' reader reads and acks the same log, and has no way to clear it", async () => {
    const kv = new MemoryKV();
    const { log } = make(kv);
    await appendMany(log, "unlock_failed", 2);
    const reader = securityReader(log);
    expect(Object.keys(reader).sort()).toEqual(["ack", "failuresSinceAck", "read", "recent"]);
    expect("clear" in reader).toBe(false);
    expect(Object.isFrozen(reader)).toBe(true);
    expect(await reader.read()).toEqual(await log.read());
    expect((await reader.recent(1)).map((e) => e.kind)).toEqual(["unlock_failed"]);
    await reader.ack(await reader.failuresSinceAck());
    expect(await log.failuresSinceAck()).toBe(0);
  });
});
