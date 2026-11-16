// Review: merge laws over arbitrary replicas, and whether a merge result is always a vault the reader accepts.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createClock } from "../../src/core/vault/hlc";
import { canonicalJson, mergeVaults } from "../../src/core/vault/merge";
import { emptyVault, type Entry, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, editEntry, moveEntry, purgeEntry, restoreEntry } from "../../src/core/vault/ops";
import { deserializeVault, parseVault, serializeVault } from "../../src/core/vault/validate";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { aliveEntries } from "../../src/core/vault/model";
import { STRONG } from "../helpers/vaults";

const VID = "vault-review-01";
const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

describe("purge on one replica + restore on another", () => {
  function replicas() {
    let now = 1_760_000_000_000;
    const clk = (dev: string) => createClock(dev, { now: () => now });
    const base = addEntry(emptyVault(VID), input("GitHub"), clk("aaaa"), { id: "entry-0000001", now: () => now }).vault;
    now += 1000;
    const a1 = deleteEntry(base, "entry-0000001", clk("aaaa"));
    const b1 = deleteEntry(base, "entry-0000001", clk("bbbb"));
    now += 1000;
    const a2 = purgeEntry(a1, "entry-0000001", clk("aaaa")); // "Delete forever" on computer A
    now += 1000;
    const b2 = restoreEntry(b1, "entry-0000001", clk("bbbb")); // "Restore" from the trash on computer B
    return { a: a2, b: b2 };
  }
  it("the merged vault is one parseVault accepts", () => {
    const { a, b } = replicas();
    const m = mergeVaults(a, b);
    expect(() => parseVault(JSON.parse(new TextDecoder().decode(serializeVault(m))))).not.toThrow();
  });
  it("through importBackup, the merge is saved and then silently reverted on the next read", async () => {
    const { a, b } = replicas();
    const kv = new MemoryKV();
    const settings = new KvSettingsStore(kv);
    const t = { now: 1_760_000_100_000 };
    const session = new MemorySession(); // shared, as chrome.storage.session is; otherwise every later instance is locked
    const make = () =>
      new VaultService({
        store: new VaultStore({ lock: createMutex(), kv, now: () => t.now }),
        session,
        settings,
        now: () => t.now,
      });
    await make().restoreBackup(a, await make().prepareKeys(STRONG, { vaultId: a.vaultId })); // computer A's vault (same vault id as B: restored from a shared backup earlier)
    const svc = make();
    await svc.mutate((v, c) => addEntry(v, input("AWS"), c).vault); // something else the user did
    await svc.importBackup(b); // import computer B's backup
    const r = await make().read();
    expect(r.recovered).toBeUndefined();
    expect(
      aliveEntries(r.vault)
        .map((e) => e.issuer)
        .sort(),
    ).toContain("AWS");
  });
});

// ---- random replicas -----------------------------------------------------------------------------------------------

type Op = {
  dev: 0 | 1 | 2;
  kind: "add" | "edit" | "del" | "restore" | "purge" | "move";
  pick: number;
  dt: number;
  txt: string;
};
const opArb: fc.Arbitrary<Op> = fc.record({
  dev: fc.constantFrom(0, 1, 2) as fc.Arbitrary<0 | 1 | 2>,
  kind: fc.constantFrom("add", "edit", "del", "restore", "purge", "move") as fc.Arbitrary<Op["kind"]>,
  pick: fc.nat(50),
  dt: fc.integer({ min: -5000, max: 5000 }), // device clocks wander, including backwards
  txt: fc.constantFrom("A", "B", "C"),
});

function run(ops: Op[]): Vault[] {
  const devs = ["aaaa", "bbbb", "cccc"];
  const now = [1_760_000_000_000, 1_760_000_000_000, 1_760_000_000_000];
  const clocks = devs.map((d, i) => createClock(d, { now: () => now[i]! }));
  let reps: Vault[] = [emptyVault(VID), emptyVault(VID), emptyVault(VID)];
  let n = 0;
  for (const op of ops) {
    now[op.dev] = now[op.dev]! + op.dt;
    let v = reps[op.dev]!;
    const ids = v.entries.map((e) => e.id);
    const id = ids.length ? ids[op.pick % ids.length]! : null;
    try {
      if (op.kind === "add" || !id)
        v = addEntry(v, input(op.txt), clocks[op.dev]!, {
          id: `entry-${String(n++).padStart(7, "0")}`,
          now: () => now[op.dev]!,
        }).vault;
      else if (op.kind === "edit") v = editEntry(v, id, { issuer: op.txt }, clocks[op.dev]!);
      else if (op.kind === "del") v = deleteEntry(v, id, clocks[op.dev]!);
      else if (op.kind === "restore") v = restoreEntry(v, id, clocks[op.dev]!);
      else if (op.kind === "purge") v = purgeEntry(v, id, clocks[op.dev]!);
      else v = moveEntry(v, id, op.pick % 3, clocks[op.dev]!);
    } catch {
      /* op not allowed in this state */
    }
    reps[op.dev] = v;
    // occasionally sync: device op.dev pulls from the next device
    if (op.pick % 7 === 0) {
      const other = (op.dev + 1) % 3;
      const merged = mergeVaults(reps[op.dev]!, reps[other]!);
      for (const e of merged.entries) for (const h of [e.hlc, e.phlc, e.dhlc]) if (h) clocks[op.dev]!.observe(h);
      reps[op.dev] = merged;
    }
  }
  return reps;
}

describe("merge over random multi-device histories", () => {
  it("commutative, associative, idempotent (canonical bytes) over ops-generated replicas  [expected to pass]", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        const [a, b, c] = run(ops) as [Vault, Vault, Vault];
        const j = (v: Vault) => canonicalJson(v);
        expect(j(mergeVaults(a, b))).toBe(j(mergeVaults(b, a)));
        expect(j(mergeVaults(mergeVaults(a, b), c))).toBe(j(mergeVaults(a, mergeVaults(b, c))));
        expect(j(mergeVaults(a, a))).toBe(j(a));
        expect(j(mergeVaults(mergeVaults(a, b), b))).toBe(j(mergeVaults(a, b)));
      }),
      { numRuns: 500 },
    );
  });

  it("the merge of ops-generated replicas always passes parseVault", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        const [a, b, c] = run(ops) as [Vault, Vault, Vault];
        deserializeVault(serializeVault(mergeVaults(mergeVaults(a, b), c)));
      }),
      { numRuns: 500 },
    );
  });

  it("entries that differ only in deleted:false vs a missing flag merge to the same bytes either way", () => {
    const e = (deleted?: boolean): Entry => ({
      id: "entry-0000001",
      createdAt: 1,
      type: "totp",
      issuer: "X",
      label: "x",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      hlc: "1760000000000.0000.aaaa",
      order: "V",
      phlc: "1760000000000.0000.aaaa",
      ...(deleted === undefined ? {} : { deleted }),
    });
    const x = { schemaVersion: 1 as const, vaultId: VID, entries: [e(false)] };
    const y = { schemaVersion: 1 as const, vaultId: VID, entries: [e(undefined)] };
    // both are accepted by parseVault (a backup file can contain either form)
    parseVault(x);
    parseVault(y);
    expect(canonicalJson(mergeVaults(x, y))).toBe(canonicalJson(mergeVaults(y, x)));
  });
});
