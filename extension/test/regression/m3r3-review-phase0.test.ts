// The third M3 review, departure 3: store.ts runs the recovery hook over lost data BEFORE the caller's function. With sync
// never turned on, every recovery path must leave storage exactly as main's store does (test/helpers/store-main.ts is a
// verbatim copy of main's store.ts, imports re-rooted). With sync records present, the only difference allowed is
// the outbox moved to sk_sync_orphan instead of deleted (revision 19; revision 20: appended to its list).
import { describe, expect, it } from "vitest";
import { KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultStore as MainStore } from "../helpers/store-main";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { SyncStateStore } from "../../src/core/sync/local/state";
import { tear } from "../helpers/faulty-kv";
import { createProtected, STRONG } from "../helpers/vaults";

const T = 1_792_051_200_000;
const clone = (m: MemoryKV) => {
  const n = new MemoryKV();
  for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
  return n;
};
const dump = (m: MemoryKV) => JSON.stringify([...m.data.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

async function seed(
  keyChange = false,
): Promise<{ kv: MemoryKV; mirror: MemoryKV; gen0: Generation; gen1: Generation }> {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const store = new VaultStore({ kv, mirror, lock: createMutex(), now: () => T });
  const svc = new VaultService({
    store,
    session: new MemorySession(),
    settings: new KvSettingsStore(kv),
    now: () => T,
  });
  await createProtected(svc);
  const gen0 = (await svc.currentGeneration())!;
  await svc.mutate((v) => ({ ...v })); // an unchanged write: nothing; then a real one below
  const { addEntry } = await import("../../src/core/vault/ops");
  const { input } = await import("../helpers/m2-world");
  await svc.mutate((v, c) => addEntry(v, input("X"), c).vault);
  const gen1 = (await svc.currentGeneration())!;
  // FIXa2's case: a key change (a Phase 0 password change: another keyring) committed into the other slot; the prep
  // then points back at gen1's slot, so the newer slot with another keyring is "never committed" and rolled back
  if (keyChange) {
    const before = clone(kv);
    const mirrorBefore = clone(mirror);
    await svc.changePassword(STRONG, "violet-harbour-cinder-93");
    const newGen = kv.data.get(KEYS.slot[kv.data.get(KEYS.active) as "a" | "b"]);
    for (const [m, b] of [
      [kv, before],
      [mirror, mirrorBefore],
    ] as const) {
      m.data.clear();
      for (const [k, v] of b.data) m.data.set(k, v);
    }
    const ptr = kv.data.get(KEYS.active) as "a" | "b";
    kv.data.set(KEYS.slot[ptr === "a" ? "b" : "a"], newGen); // written and verified, the pointer flip never landed
  }
  return { kv, mirror, gen0, gen1 };
}

type Kind = "phase0" | "sync";
async function both(
  kind: Kind,
  prep: (kv: MemoryKV, mirror: MemoryKV) => void,
  op: (s: VaultStore | MainStore, gen0: Generation) => Promise<unknown>,
  keyChange = false,
) {
  const s = await seed(keyChange);
  if (kind === "sync") {
    s.kv.data.set(SYNC_KEYS.cfg, { v: 1 });
    s.kv.data.set(SYNC_KEYS.state, {
      v: 1,
      lastSynced: { version: 3, head: "h", checksum: s.gen1.envelope.checksum },
      serverOffsetMs: 5,
    });
    s.kv.data.set(SYNC_KEYS.outbox, {
      v: 1,
      base: 3,
      head: "h",
      from: { version: 3, head: "h", checksum: "c" },
      checksum: s.gen1.envelope.checksum,
      envelope: "{}",
      proof: "p",
    });
  }
  prep(s.kv, s.mirror);
  const out: Record<string, { kv: string; mirror: string; err: string | null; diag: string[] }> = {};
  for (const which of ["main", "rev3"] as const) {
    const kv = clone(s.kv);
    const mirror = clone(s.mirror);
    const state = new SyncStateStore(kv);
    const diag: string[] = [];
    const store =
      which === "main"
        ? new MainStore({
            kv,
            mirror,
            lock: createMutex(),
            now: () => T + 1,
            beforeRecoveryWrite: () => state.clearLastSynced(),
            onDiag: (m) => diag.push(m),
          })
        : new VaultStore({
            kv,
            mirror,
            lock: createMutex(),
            now: () => T + 1,
            beforeRecoveryWrite: () => state.recoveryHook(),
            onDiag: (m) => diag.push(m),
          });
    let err: string | null = null;
    try {
      await op(store, s.gen0);
    } catch (e) {
      err = String(e);
    }
    out[which] = { kv: dump(kv), mirror: dump(mirror), err, diag };
  }
  return { ...out, gen0: s.gen0, gen1: s.gen1 } as {
    main: { kv: string; mirror: string; err: string | null; diag: string[] };
    rev3: { kv: string; mirror: string; err: string | null; diag: string[] };
    gen0: Generation;
    gen1: Generation;
  };
}

const tearActive = (kv: MemoryKV) => {
  const p = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[p], tear(kv.data.get(KEYS.slot[p])));
};
const loseAll = (kv: MemoryKV, mirror: MemoryKV) => {
  for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) kv.data.set(k, { torn: "x" });
  for (const k of [...kv.data.keys()]) if (k.startsWith("sk_snap")) kv.data.delete(k);
  mirror.data.clear();
};

describe("M3-R3 review: departure 3, Phase 0 storage unchanged", () => {
  const cases: [
    string,
    (kv: MemoryKV, mirror: MemoryKV) => void,
    (s: VaultStore | MainStore, g: () => Generation) => Promise<unknown>,
  ][] = [
    ["a torn active slot, then load()", (kv) => tearActive(kv), (s) => s.load()],
    ["a torn active slot, then selfCheck()", (kv) => tearActive(kv), (s) => s.selfCheck()],
    [
      "the pointer lost (a newer slot not named)",
      (kv) => kv.data.set(KEYS.active, kv.data.get(KEYS.active) === "a" ? "b" : "a"),
      (s) => s.selfCheck(),
    ],
    [
      "both slots torn: rebuilt from the newest snapshot (writeBoth)",
      (kv) => {
        for (const k of [KEYS.slot.a, KEYS.slot.b]) kv.data.set(k, tear(kv.data.get(k)));
      },
      (s) => s.load(),
    ],
    [
      "both slots torn, snapshots gone: rebuilt from the mirror (writeBoth)",
      (kv) => {
        for (const k of [KEYS.slot.a, KEYS.slot.b]) kv.data.set(k, tear(kv.data.get(k)));
        for (const k of [...kv.data.keys()]) if (k.startsWith("sk_snap")) kv.data.delete(k);
      },
      (s) => s.load(),
    ],
    [
      "a lost vault, a transact over it (overwriteLost)",
      loseAll,
      (s, g) => s.transact(async () => ({ envelope: g().envelope, keyring: g().keyring }), { overwriteLost: true }),
    ],
    [
      "a lost vault, a transact over it whose function throws",
      loseAll,
      (s) =>
        s.transact(
          async () => {
            throw new Error("refused");
          },
          { overwriteLost: true },
        ),
    ],
    [
      "a lost vault, a transact without overwriteLost",
      loseAll,
      (s, g) => s.transact(async () => ({ envelope: g().envelope, keyring: g().keyring })),
    ],
  ];
  for (const [name, prep, op] of cases) {
    it(`sync never on: ${name}`, async () => {
      const r = await both("phase0", prep, (s, g0) => op(s, () => g0));
      expect(r.rev3.err).toBe(r.main.err);
      if (name.endsWith("(overwriteLost)")) expect(r.rev3.err).toBeNull(); // it really wrote
      if (name.includes("throws")) expect(r.rev3.err).toContain("refused");
      if (name.includes("without overwriteLost")) expect(r.rev3.err).toContain("refusing to overwrite");
      if (name.includes("writeBoth")) {
        expect(r.rev3.err).toBeNull();
        expect(r.rev3.kv).not.toContain('"torn"');
      } // really rebuilt
      expect(r.rev3.kv).toBe(r.main.kv);
      expect(r.rev3.mirror).toBe(r.main.mirror);
    });
  }
  it("sync never on: FIXa2, a newer slot with another keyring that the pointer does not name, rolled back (selfCheck and load)", async () => {
    const back = () => undefined; // seed(true) leaves the pointer on gen1's slot, the newer slot holding another keyring
    for (const op of [
      (s: VaultStore | MainStore) => s.selfCheck(),
      (s: VaultStore | MainStore) => s.selfCheck().then(() => s.load()),
    ]) {
      let rolledBack = false;
      const r = await both(
        "phase0",
        back,
        async (s) => {
          const l = await op(s);
          rolledBack = (l as { status: string; gen?: Generation }).status === "ok";
          return l;
        },
        true,
      );
      expect(rolledBack).toBe(true);
      expect(r.rev3.diag.some((m) => m.startsWith("key change rolled back"))).toBe(true); // FIXa2's branch ran
      expect(r.rev3.diag).toEqual(r.main.diag);
      const kv = new Map(JSON.parse(r.rev3.kv) as [string, unknown][]);
      const active = kv.get(kv.get(KEYS.active) === "a" ? KEYS.slot.a : KEYS.slot.b) as Generation;
      expect(JSON.stringify(active.keyring)).toBe(JSON.stringify(r.gen1.keyring)); // the pointer slot won: the key change rolled back
      expect(r.rev3.err).toBe(r.main.err);
      expect(r.rev3.kv).toBe(r.main.kv);
      expect(r.rev3.mirror).toBe(r.main.mirror);
    }
  });
  // gen0 for the overwrite: the seed's own first generation (valid envelope + keyring)
  it("sync on: the only difference is the outbox kept as sk_sync_orphan (a lost vault, the function throws)", async () => {
    const r = await both("sync", loseAll, (s) =>
      s.transact(
        async () => {
          throw new Error("refused");
        },
        { overwriteLost: true },
      ),
    );
    const main = new Map(JSON.parse(r.main.kv) as [string, unknown][]);
    const rev3 = new Map(JSON.parse(r.rev3.kv) as [string, unknown][]);
    // main: the hook never ran (it ran after the function, which threw): lastSynced and the outbox as they were
    expect((main.get(SYNC_KEYS.state) as { lastSynced: unknown }).lastSynced).not.toBeNull();
    // rev. 3: the hook ran first: lastSynced null, the outbox moved
    expect((rev3.get(SYNC_KEYS.state) as { lastSynced: unknown }).lastSynced).toBeNull();
    expect(rev3.get(SYNC_KEYS.outbox) ?? null).toBeNull();
    expect(rev3.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [main.get(SYNC_KEYS.outbox)] }); // revision 20: a list
    for (const k of new Set([...main.keys(), ...rev3.keys()]))
      if (![SYNC_KEYS.state, SYNC_KEYS.outbox, SYNC_KEYS.orphan].includes(k as never))
        expect(JSON.stringify(rev3.get(k)), k).toBe(JSON.stringify(main.get(k)));
  });
});
