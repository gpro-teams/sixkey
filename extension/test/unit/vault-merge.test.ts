import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalJson, mergeVaults, MergeError } from "../../src/core/vault/merge";
import {
  aliveEntries,
  emptyVault,
  isAlive,
  isPurged,
  trashEntries,
  type Entry,
  type Vault,
} from "../../src/core/vault/model";
import { createClock, formatHlc } from "../../src/core/vault/hlc";
import {
  addEntry,
  deleteEntry,
  editEntry,
  moveEntry,
  observeVault,
  purgeEntry,
  restoreEntry,
  setGroup,
  type NewEntry,
} from "../../src/core/vault/ops";

const VID = "vault-0123456789";
const canon = (v: Vault) => canonicalJson(v);

// --- generators: tiny value pools so replicas collide on ids, timestamps and content ---
const hlcArb = fc
  .record({
    wall: fc.integer({ min: 1_700_000_000_000, max: 1_700_000_000_006 }),
    counter: fc.integer({ min: 0, max: 2 }),
    dev: fc.constantFrom("aaaa", "bbbb", "cccc"),
  })
  .map((r) => formatHlc(r.wall, r.counter, r.dev));
const entryArb = (id: string): fc.Arbitrary<Entry> =>
  fc
    .record({
      type: fc.constantFrom("totp" as const, "hotp" as const),
      issuer: fc.constantFrom("A", "B", ""),
      label: fc.constantFrom("x", "y"),
      secret: fc.constantFrom("JBSWY3DP", "GEZDGNBV", ""),
      algorithm: fc.constantFrom("SHA1" as const, "SHA256" as const),
      digits: fc.constantFrom(6 as const, 8 as const),
      period: fc.constantFrom(30, 60),
      counter: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
      domains: fc.option(fc.constantFrom(["a.com"], ["b.com"]), { nil: undefined }),
      hlc: hlcArb,
      group: fc.option(fc.constantFrom("g1", "g2"), { nil: undefined }),
      order: fc.constantFrom("V", "k", "t"),
      phlc: hlcArb,
      deleted: fc.option(fc.boolean(), { nil: undefined }),
      dhlc: hlcArb,
      createdAt: fc.integer({ min: 1, max: 5 }),
    })
    .map((r) => {
      const e: Record<string, unknown> = { id, ...r };
      if (r.counter === undefined) delete e.counter;
      if (r.domains === undefined) delete e.domains;
      if (r.group === undefined) delete e.group;
      if (r.deleted === undefined) delete e.dhlc; // a deletion stamp only exists with a deletion flag
      return e as unknown as Entry;
    });
const vaultArb: fc.Arbitrary<Vault> = fc
  .tuple(
    fc.option(entryArb("entry-aaaaaaa"), { nil: undefined }),
    fc.option(entryArb("entry-bbbbbbb"), { nil: undefined }),
    fc.option(entryArb("entry-ccccccc"), { nil: undefined }),
  )
  .map((es) => ({ schemaVersion: 1 as const, vaultId: VID, entries: es.filter((e): e is Entry => !!e) }));

describe("merge is a CRDT join", () => {
  it("commutative", () => {
    fc.assert(
      fc.property(vaultArb, vaultArb, (a, b) => canon(mergeVaults(a, b)) === canon(mergeVaults(b, a))),
      { numRuns: 500 },
    );
  });
  it("associative", () => {
    fc.assert(
      fc.property(
        vaultArb,
        vaultArb,
        vaultArb,
        (a, b, c) => canon(mergeVaults(mergeVaults(a, b), c)) === canon(mergeVaults(a, mergeVaults(b, c))),
      ),
      { numRuns: 500 },
    );
  });
  it("idempotent, and re-merging a replica changes nothing", () => {
    fc.assert(
      fc.property(vaultArb, vaultArb, (a, b) => {
        const m = mergeVaults(a, b);
        return (
          canon(mergeVaults(m, m)) === canon(m) &&
          canon(mergeVaults(m, a)) === canon(m) &&
          canon(mergeVaults(m, b)) === canon(m)
        );
      }),
      { numRuns: 500 },
    );
  });
  it("never loses an entry", () => {
    fc.assert(
      fc.property(vaultArb, vaultArb, (a, b) => {
        const ids = new Set(mergeVaults(a, b).entries.map((e) => e.id));
        return [...a.entries, ...b.entries].every((e) => ids.has(e.id));
      }),
    );
  });
  it("refuses to merge different vaults", () => {
    expect(() => mergeVaults(emptyVault(VID), emptyVault("another-vault-id"))).toThrow(MergeError);
  });
});

// --- scenarios with two devices ---
const input = (over: Partial<NewEntry> = {}): NewEntry => ({
  type: "totp",
  issuer: "GitHub",
  label: "alice",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  ...over,
});
function devices() {
  let t = 1_700_000_000_000;
  const tick = () => (t += 1000);
  const a = createClock("aaaa", { now: () => t });
  const b = createClock("bbbb", { now: () => t });
  return { a, b, tick, advance: (ms: number) => (t += ms) };
}

describe("two devices", () => {
  it("a rename on one device and a reorder on another both survive", () => {
    const { a, b, tick } = devices();
    let base = emptyVault(VID);
    const e1 = addEntry(base, input({ issuer: "One" }), a, { id: "entry-0000001" });
    const e2 = addEntry(e1.vault, input({ issuer: "Two" }), a, { id: "entry-0000002" });
    base = e2.vault;
    tick();
    const onA = editEntry(base, "entry-0000001", { issuer: "Renamed" }, a);
    tick();
    const onB = moveEntry(base, "entry-0000002", 0, b);
    const m = mergeVaults(onA, onB);
    const list = aliveEntries(m);
    expect(list.map((e) => e.id)).toEqual(["entry-0000002", "entry-0000001"]);
    expect(list[1]!.issuer).toBe("Renamed");
    expect(canon(mergeVaults(onB, onA))).toBe(canon(m));
  });
  it("a note written on one device and a reorder on another both survive; the later of two notes wins", () => {
    const { a, b, tick } = devices();
    const base = addEntry(emptyVault(VID), input(), a, { id: "entry-0000001" }).vault;
    tick();
    const noted = editEntry(base, "entry-0000001", { note: "Shop A" }, a);
    tick();
    const moved = moveEntry(base, "entry-0000001", 0, b);
    expect(mergeVaults(noted, moved).entries[0]!.note).toBe("Shop A");
    tick();
    const later = editEntry(base, "entry-0000001", { note: "Shop B" }, b);
    expect(mergeVaults(noted, later).entries[0]!.note).toBe("Shop B");
    expect(canon(mergeVaults(later, noted))).toBe(canon(mergeVaults(noted, later)));
  });
  it("an edit made after a delete wins; an older edit leaves the entry in the trash with the edit kept", () => {
    const { a, b, tick } = devices();
    const base = addEntry(emptyVault(VID), input(), a, { id: "entry-0000001" }).vault;
    tick();
    const deleted = deleteEntry(base, "entry-0000001", a);
    tick();
    const editedLater = editEntry(base, "entry-0000001", { label: "newer" }, b);
    const m1 = mergeVaults(deleted, editedLater);
    expect(isAlive(m1.entries[0]!)).toBe(true);
    expect(m1.entries[0]!.label).toBe("newer");

    tick();
    const editedEarlier = editEntry(base, "entry-0000001", { label: "older" }, b); // stamped before the next delete
    tick();
    const deletedLater = deleteEntry(base, "entry-0000001", a);
    const m2 = mergeVaults(deletedLater, editedEarlier);
    expect(isAlive(m2.entries[0]!)).toBe(false);
    expect(trashEntries(m2).map((e) => e.label)).toEqual(["older"]); // the edit is not lost, it is in the bin
  });
  it("restore brings an entry back and survives a merge with the stale deleted copy", () => {
    const { a, b, tick } = devices();
    const base = addEntry(emptyVault(VID), input(), a, { id: "entry-0000001" }).vault;
    tick();
    const deleted = deleteEntry(base, "entry-0000001", a);
    tick();
    const restored = restoreEntry(deleted, "entry-0000001", b);
    expect(isAlive(mergeVaults(deleted, restored).entries[0]!)).toBe(true);
    expect(isAlive(mergeVaults(restored, deleted).entries[0]!)).toBe(true);
  });
  it("purge removes the secret and a stale replica cannot bring it back", () => {
    const { a, b, tick } = devices();
    const base = addEntry(emptyVault(VID), input(), a, { id: "entry-0000001" }).vault;
    const stale = structuredClone(base);
    tick();
    const purged = purgeEntry(deleteEntry(base, "entry-0000001", a), "entry-0000001", a);
    expect(isPurged(purged.entries[0]!)).toBe(true);
    const m = mergeVaults(purged, stale);
    expect(m.entries[0]!.secret).toBe("");
    expect(JSON.stringify(m)).not.toContain("JBSWY3DP");
    expect(aliveEntries(m)).toEqual([]);
    expect(trashEntries(m)).toEqual([]);
    void b;
  });
  it("hotp counter only moves forward", () => {
    const { a, b, tick } = devices();
    const base = addEntry(emptyVault(VID), input({ type: "hotp", counter: 3 }), a, { id: "entry-0000001" }).vault;
    tick();
    const onA = editEntry(base, "entry-0000001", { counter: 9 }, a);
    tick();
    const onB = editEntry(base, "entry-0000001", { label: "renamed", counter: 4 }, b); // wins the content register
    const m = mergeVaults(onA, onB);
    expect(m.entries[0]!.label).toBe("renamed");
    expect(m.entries[0]!.counter).toBe(9);
  });
  it("group changes are placement edits and do not clobber content edits", () => {
    const { a, b, tick } = devices();
    const base = addEntry(emptyVault(VID), input(), a, { id: "entry-0000001" }).vault;
    tick();
    const g = setGroup(base, "entry-0000001", "Work", a);
    tick();
    const ed = editEntry(base, "entry-0000001", { issuer: "Edited" }, b);
    const m = mergeVaults(g, ed);
    expect(m.entries[0]).toMatchObject({ group: "Work", issuer: "Edited" });
  });
  it("two devices adding entries independently end up with both", () => {
    const { a, b } = devices();
    const base = emptyVault(VID);
    const onA = addEntry(base, input({ issuer: "FromA" }), a).vault;
    const onB = addEntry(base, input({ issuer: "FromB" }), b).vault;
    expect(
      aliveEntries(mergeVaults(onA, onB))
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["FromA", "FromB"]);
  });
  it("edits after observing a merged vault always sort after everything in it", () => {
    const { a, b } = devices();
    const x = addEntry(emptyVault(VID), input(), b, { id: "entry-0000001" }).vault;
    for (let i = 0; i < 5; i++) b.next(); // device b runs ahead
    const y = editEntry(x, "entry-0000001", { label: "from-b" }, b);
    observeVault(a, y);
    const z = editEntry(y, "entry-0000001", { label: "from-a" }, a);
    expect(mergeVaults(y, z).entries[0]!.label).toBe("from-a");
  });
});

describe("ordering and moves", () => {
  it("add appends, move places exactly", () => {
    const { a } = devices();
    let v = emptyVault(VID);
    for (const n of ["A", "B", "C", "D"]) v = addEntry(v, input({ issuer: n }), a).vault;
    expect(aliveEntries(v).map((e) => e.issuer)).toEqual(["A", "B", "C", "D"]);
    const d = aliveEntries(v)[3]!;
    v = moveEntry(v, d.id, 0, a);
    expect(aliveEntries(v).map((e) => e.issuer)).toEqual(["D", "A", "B", "C"]);
    v = moveEntry(v, d.id, 2, a);
    expect(aliveEntries(v).map((e) => e.issuer)).toEqual(["A", "B", "D", "C"]);
    v = moveEntry(v, d.id, 99, a);
    expect(aliveEntries(v).map((e) => e.issuer)).toEqual(["A", "B", "C", "D"]);
  });
  it("recovers when two devices picked the same key", () => {
    const { a, b } = devices();
    const base = addEntry(addEntry(emptyVault(VID), input({ issuer: "A" }), a).vault, input({ issuer: "B" }), a).vault;
    const onA = addEntry(base, input({ issuer: "FromA" }), a).vault;
    const onB = addEntry(base, input({ issuer: "FromB" }), b).vault;
    let m = mergeVaults(onA, onB);
    const orders = aliveEntries(m).map((e) => e.order);
    expect(new Set(orders).size).toBeLessThan(orders.length); // genuinely colliding keys
    const last = aliveEntries(m).at(-1)!;
    m = moveEntry(m, last.id, 0, a);
    expect(aliveEntries(m)[0]!.id).toBe(last.id);
    expect(new Set(aliveEntries(m).map((e) => e.order)).size).toBe(aliveEntries(m).length);
  });
  it("hundreds of appends keep keys short", () => {
    const { a } = devices();
    let v = emptyVault(VID);
    for (let i = 0; i < 400; i++) v = addEntry(v, input({ issuer: `I${i}` }), a).vault;
    expect(aliveEntries(v).map((e) => e.issuer)).toEqual(Array.from({ length: 400 }, (_, i) => `I${i}`));
    expect(Math.max(...v.entries.map((e) => e.order.length))).toBeLessThanOrEqual(40);
  });
});
