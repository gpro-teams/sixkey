import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromB64, toB64, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { KEYS } from "../../src/core/storage/format";
import { StorageError, VaultStore } from "../../src/core/storage/store";
import { CrashError, FaultyKV, LyingKV, tear, type CrashMode } from "../helpers/faulty-kv";
import { makeWorld, type World } from "../helpers/world";

let clockMs = 1_700_000_000_000;
const tick = (ms = 60_000) => (clockMs += ms);
const mkStore = (kv: MemoryKV | FaultyKV, mirror?: MemoryKV, extra: object = {}) =>
  new VaultStore({ lock: createMutex(), kv, ...(mirror ? { mirror } : {}), now: () => clockMs, ...extra });
const count = (n: number, w: World) => async () => ({ envelope: await w.state(n), keyring: w.keyring });
const commit = async (s: VaultStore, w: World, n: number) => {
  tick();
  return s.transact(count(n, w));
};
/** What the user would see: the checksum of the active saved state. */
const loadedChecksum = async (s: VaultStore) => {
  const r = await s.load();
  return r.status === "ok" ? r.gen.envelope.checksum : r.status;
};

describe("basic behaviour", () => {
  it("empty -> first save -> alternates slots, pointer follows", async () => {
    const w = await makeWorld();
    const kv = new MemoryKV();
    const s = mkStore(kv);
    expect((await s.load()).status).toBe("empty");
    const g1 = await commit(s, w, 1);
    expect(g1.seq).toBe(1);
    expect(kv.data.get(KEYS.active)).toBe("a");
    const g2 = await commit(s, w, 2);
    expect(g2.seq).toBe(2);
    expect(kv.data.get(KEYS.active)).toBe("b");
    const g3 = await commit(s, w, 3);
    expect(kv.data.get(KEYS.active)).toBe("a");
    const r = await s.load();
    expect(r.status === "ok" && r.gen.seq).toBe(3);
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe(g3.envelope.checksum);
  });
  it("the inactive slot always holds the previous complete state", async () => {
    const w = await makeWorld();
    const kv = new MemoryKV();
    const s = mkStore(kv);
    await commit(s, w, 1);
    await commit(s, w, 2);
    const a = kv.data.get(KEYS.slot.a) as { envelope: { checksum: string } };
    const b = kv.data.get(KEYS.slot.b) as { envelope: { checksum: string } };
    expect(a.envelope.checksum).toBe((await w.state(1)).checksum);
    expect(b.envelope.checksum).toBe((await w.state(2)).checksum);
  });
  it("serialises concurrent saves: no lost updates", async () => {
    const w = await makeWorld();
    const s = mkStore(new MemoryKV());
    await commit(s, w, 1);
    const seen: number[] = [];
    await Promise.all(
      [2, 3, 4, 5].map((n) =>
        s.transact(async (cur) => {
          seen.push(cur!.seq);
          return { envelope: await w.state(n), keyring: w.keyring };
        }),
      ),
    );
    expect(seen).toEqual([1, 2, 3, 4]); // each save started from the previous one's result
    const r = await s.load();
    expect(r.status === "ok" && r.gen.seq).toBe(5);
  });
  it("refuses to write something inconsistent", async () => {
    const w = await makeWorld();
    const other = await makeWorld();
    const s = mkStore(new MemoryKV());
    await expect(
      s.transact(async () => ({ envelope: await w.state(1), keyring: other.keyring })),
    ).rejects.toMatchObject({ code: "verify_failed" });
    expect((await s.load()).status).toBe("empty");
  });
});

describe("PLAN 4.4: interrupted writes", () => {
  const MODES: CrashMode[] = ["before", "after", "partial", "torn"];
  for (const withMirror of [false, true]) {
    for (const mode of MODES) {
      it(`a crash at every write of a save never loses data (${mode}, ${withMirror ? "with" : "without"} mirror)`, async () => {
        const w = await makeWorld();
        const s2c = (await w.state(2)).checksum;
        const s3c = (await w.state(3)).checksum;

        // count the writes one save performs
        const probe = new FaultyKV(new MemoryKV());
        const ps = mkStore(probe, withMirror ? new MemoryKV() : undefined);
        await commit(ps, w, 1);
        await commit(ps, w, 2);
        const before = probe.calls;
        await commit(ps, w, 3);
        const writes = probe.calls - before;
        expect(writes).toBeGreaterThan(2);

        for (let at = 1; at <= writes; at++) {
          const mem = new MemoryKV();
          const mirror = withMirror ? new MemoryKV() : undefined;
          const faulty = new FaultyKV(mem);
          const s = mkStore(faulty, mirror);
          await commit(s, w, 1);
          await commit(s, w, 2);
          faulty.arm({ at: faulty.calls + at, mode });
          await commit(s, w, 3).then(
            () => undefined,
            (e) => expect(e).toBeInstanceOf(CrashError),
          );
          // restart: a new store over whatever is on disk
          const after = mkStore(mem, mirror);
          const checked = await after.selfCheck();
          const where = `crash ${mode} at write ${at}/${writes}`;
          expect(checked.status, where).toBe("ok");
          const cs = checked.status === "ok" ? checked.gen.envelope.checksum : "";
          expect([s2c, s3c], where).toContain(cs);
          expect(await loadedChecksum(after), where).toBe(cs);
          // and the store is usable again
          await commit(after, w, 4);
          expect(await loadedChecksum(after), where).toBe((await w.state(4)).checksum);
        }
      });
    }
  }

  it("a half-written active slot falls back to the previous slot and says so", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const s = mkStore(mem);
    await commit(s, w, 1);
    const t1 = clockMs;
    await commit(s, w, 2);
    mem.data.set(KEYS.slot.b, tear(mem.data.get(KEYS.slot.b)));
    const fresh = mkStore(mem);
    const r = await fresh.load();
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(1)).checksum);
    expect(r.status === "ok" && r.events.map((e) => e.kind)).toEqual(["slot_fallback"]);
    expect(r.status === "ok" && r.events[0]!.restoredTo).toBe(t1);
    expect((await fresh.listEvents()).map((e) => e.kind)).toEqual(["slot_fallback"]);
  });
});

describe("PLAN 4.4: checksum mismatch", () => {
  const damages: [string, (g: any) => void][] = [
    [
      "flipped ciphertext byte",
      (g) => {
        const b = fromB64(g.envelope.ciphertext);
        b[4]! ^= 1;
        g.envelope.ciphertext = toB64(b);
      },
    ],
    [
      "wrong checksum",
      (g) => {
        g.envelope.checksum = toB64(new Uint8Array(32));
      },
    ],
    [
      "changed rev",
      (g) => {
        g.envelope.rev += 1;
      },
    ],
    [
      "keyring does not match the data",
      (g) => {
        g.keyring.vkId = "0000000000000000";
      },
    ],
    [
      "missing field",
      (g) => {
        delete g.envelope.iv;
      },
    ],
    [
      "emptied object",
      (g) => {
        for (const k of Object.keys(g)) delete g[k];
      },
    ],
  ];
  for (const [name, damage] of damages) {
    it(`${name} in the active slot -> previous slot`, async () => {
      const w = await makeWorld();
      const mem = new MemoryKV();
      const s = mkStore(mem);
      await commit(s, w, 1);
      await commit(s, w, 2);
      const g = structuredClone(mem.data.get(KEYS.slot.b)) as any;
      damage(g);
      mem.data.set(KEYS.slot.b, g);
      const r = await mkStore(mem).load();
      expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(1)).checksum);
    });
  }
});

describe("PLAN 4.4: both slots damaged -> snapshots", () => {
  async function setup(mirror?: MemoryKV) {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const s = mkStore(mem, mirror);
    for (const n of [1, 2, 3]) await commit(s, w, n);
    return { w, mem, tCommit3: clockMs };
  }
  it("restores the newest snapshot, without needing the mirror", async () => {
    const { w, mem, tCommit3 } = await setup();
    mem.data.set(KEYS.slot.a, tear(mem.data.get(KEYS.slot.a)));
    mem.data.set(KEYS.slot.b, tear(mem.data.get(KEYS.slot.b)));
    const r = await mkStore(mem).load();
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(3)).checksum);
    expect(r.status === "ok" && r.events[0]).toMatchObject({ kind: "snapshot_restore", restoredTo: tCommit3 });
    expect(await mkStore(mem).selfCheck()).toMatchObject({ status: "ok", events: [] }); // both slots healthy again
  });
  it("deleting both slots and the pointer is also recoverable", async () => {
    const { w, mem } = await setup();
    mem.data.delete(KEYS.slot.a);
    mem.data.delete(KEYS.slot.b);
    mem.data.delete(KEYS.active);
    const r = await mkStore(mem).load();
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(3)).checksum);
  });
  it("skips damaged snapshots and uses an older good one", async () => {
    const { w, mem } = await setup();
    mem.data.set(KEYS.slot.a, 1);
    mem.data.set(KEYS.slot.b, 2);
    mem.data.set(KEYS.snap("r3"), tear(mem.data.get(KEYS.snap("r3"))));
    const r = await mkStore(mem).load();
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(2)).checksum);
  });
  it("uses the mirror when the primary store is wiped", async () => {
    const mirror = new MemoryKV();
    const { w, mem } = await setup(mirror);
    mem.data.clear();
    const r = await mkStore(mem, mirror).load();
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(3)).checksum);
    expect(r.status === "ok" && r.events[0]!.kind).toBe("mirror_restore");
  });
  it("keys gone and nothing else left: reported as lost, never as an empty fresh install", async () => {
    const { mem } = await setup();
    mem.data.set(KEYS.slot.a, null);
    mem.data.set(KEYS.slot.b, null);
    mem.data.delete(KEYS.keyringCopy);
    mem.data.delete(KEYS.snapIndex);
    expect((await mkStore(mem).load()).status).toBe("lost");
  });
  it("a wiped store with no mirror looks like a fresh install", async () => {
    const { mem } = await setup();
    mem.data.clear();
    expect((await mkStore(mem).load()).status).toBe("empty");
  });
  it("lost data is not overwritten unless the caller says so", async () => {
    const { w, mem } = await setup();
    mem.data.set(KEYS.slot.a, null);
    mem.data.set(KEYS.slot.b, null);
    mem.data.delete(KEYS.keyringCopy);
    mem.data.delete(KEYS.snapIndex);
    const s = mkStore(mem);
    await expect(s.transact(count(9, w))).rejects.toMatchObject({ code: "lost_needs_confirm" });
    await expect(s.transact(count(9, w), { overwriteLost: true })).resolves.toBeDefined();
  });
});

describe("pointer and healing", () => {
  it("a missing or garbled pointer is repaired quietly and the newer slot wins", async () => {
    const w = await makeWorld();
    for (const bad of [undefined, "z", 5, null]) {
      const mem = new MemoryKV();
      const s = mkStore(mem);
      await commit(s, w, 1);
      await commit(s, w, 2);
      if (bad === undefined) mem.data.delete(KEYS.active);
      else mem.data.set(KEYS.active, bad);
      const r = await mkStore(mem).load();
      expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(2)).checksum);
      expect(r.status === "ok" && r.events).toEqual([]);
      expect(mem.data.get(KEYS.active)).toBe("b");
    }
  });
  it("a pointer to a damaged slot is repaired and reported", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const s = mkStore(mem);
    await commit(s, w, 1);
    await commit(s, w, 2);
    mem.data.set(KEYS.slot.b, "garbage");
    const r = await mkStore(mem).load();
    expect(r.status === "ok" && r.events[0]!.kind).toBe("slot_fallback");
    expect(mem.data.get(KEYS.active)).toBe("a");
  });
  it("selfCheck rewrites a damaged other slot from the good one", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const s = mkStore(mem);
    await commit(s, w, 1);
    await commit(s, w, 2);
    mem.data.set(KEYS.slot.a, tear(mem.data.get(KEYS.slot.a)));
    const r = await mkStore(mem).selfCheck();
    expect(r).toMatchObject({ status: "ok", events: [] });
    expect((mem.data.get(KEYS.slot.a) as any).envelope.checksum).toBe((await w.state(2)).checksum);
  });
});

describe("snapshots", () => {
  it("keeps the last 10 changes and the last 7 days, and no more", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    let day = 0;
    const s = mkStore(mem, undefined, { dayKey: () => `2026-01-${String(day).padStart(2, "0")}` });
    for (let n = 1; n <= 15; n++) await commit(s, w, n);
    for (day = 1; day <= 10; day++) {
      tick(86_400_000);
      expect(await s.ensureDailySnapshot()).toBe(true);
      expect(await s.ensureDailySnapshot()).toBe(false); // once per day
    }
    const snaps = await s.snapshots();
    expect(snaps.filter((m) => m.kind === "rolling")).toHaveLength(10);
    expect(snaps.filter((m) => m.kind === "daily")).toHaveLength(7);
    expect(
      snaps
        .filter((m) => m.kind === "daily")
        .map((m) => m.day)
        .sort(),
    ).toEqual(["2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10"]);
    const snapKeys = [...mem.data.keys()].filter((k) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex);
    expect(snapKeys).toHaveLength(17);
  });
  it("a save that only changes the keyring does not add a rolling snapshot", async () => {
    const w = await makeWorld();
    const s = mkStore(new MemoryKV());
    await commit(s, w, 1);
    const before = (await s.snapshots()).length;
    tick();
    await s.transact(async (cur) => ({ envelope: cur!.envelope, keyring: { ...cur!.keyring } }));
    expect((await s.snapshots()).length).toBe(before);
  });
  it("orphan snapshot records are cleaned up by the self-check", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const s = mkStore(mem);
    await commit(s, w, 1);
    mem.data.set("sk_snap_rGHOST", { v: 1 });
    await mkStore(mem).selfCheck();
    expect(mem.data.has("sk_snap_rGHOST")).toBe(false);
  });
  it("a failing mirror never fails the save itself", async () => {
    const w = await makeWorld();
    const brokenMirror = new MemoryKV();
    brokenMirror.set = async () => {
      throw new Error("idb is gone");
    };
    const diags: string[] = [];
    const s = mkStore(new MemoryKV(), brokenMirror, { onDiag: (m: string) => diags.push(m) });
    await expect(commit(s, w, 1)).resolves.toBeDefined();
    expect(diags).toContain("mirror failed");
    expect(await loadedChecksum(s)).toBe((await w.state(1)).checksum);
  });
});

describe("verification and a lying disk", () => {
  it("a store that drops the slot write is detected before the pointer moves", async () => {
    const w = await makeWorld();
    const honest = new MemoryKV();
    const s = mkStore(honest);
    await commit(s, w, 1);
    await commit(s, w, 2);
    const liar = new LyingKV((k) => k === KEYS.slot.a || k === KEYS.slot.b);
    for (const [k, v] of honest.data) liar.data.set(k, v);
    const s2 = mkStore(liar);
    await expect(commit(s2, w, 3)).rejects.toBeInstanceOf(StorageError);
    expect(liar.data.get(KEYS.active)).toBe("b"); // not switched
    expect(await loadedChecksum(s2)).toBe((await w.state(2)).checksum);
  });
});

describe("events", () => {
  it("are listed until acknowledged", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const s = mkStore(mem);
    await commit(s, w, 1);
    await commit(s, w, 2);
    mem.data.set(KEYS.slot.b, "x");
    const fresh = mkStore(mem);
    await fresh.load();
    const evs = await fresh.listEvents();
    expect(evs).toHaveLength(1);
    await fresh.ackEvents([evs[0]!.id]);
    expect(await fresh.listEvents()).toEqual([]);
  });
});

describe("decrypt-level fallback", () => {
  it("an active copy that passes its checksum but is not a vault falls back to the previous one", async () => {
    const w = await makeWorld();
    const s = mkStore(new MemoryKV());
    await commit(s, w, 2);
    tick();
    const junk = await encryptVault(utf8("this is not a vault"), w.vk, { vaultId: w.keyring.vaultId, rev: 9 });
    await s.transact(async () => ({ envelope: junk, keyring: w.keyring }));
    const opened = await s.openVault(w.vk);
    expect(opened.vault.entries).toHaveLength(2);
    expect(opened.recovered?.kind).toBe("decrypt_fallback");
    expect(await loadedChecksum(s)).toBe((await w.state(2)).checksum); // repaired for next time
  });
  it("data from a newer schema is never recovered around", async () => {
    const w = await makeWorld();
    const s = mkStore(new MemoryKV());
    await commit(s, w, 2);
    tick();
    const future = await encryptVault(
      utf8(JSON.stringify({ schemaVersion: 2, vaultId: w.keyring.vaultId, entries: [] })),
      w.vk,
      { vaultId: w.keyring.vaultId, rev: 10 },
    );
    await s.transact(async () => ({ envelope: future, keyring: w.keyring }));
    await expect(s.openVault(w.vk)).rejects.toMatchObject({ code: "newer_schema" });
    expect(await loadedChecksum(s)).toBe(future.checksum); // untouched
  });
  it("opens normally when nothing is wrong", async () => {
    const w = await makeWorld();
    const s = mkStore(new MemoryKV());
    await commit(s, w, 3);
    const o = await s.openVault(w.vk);
    expect(o.vault.entries).toHaveLength(3);
    expect(o.recovered).toBeUndefined();
  });
});

describe("random single faults (model-based)", () => {
  it("after any one corrupted or deleted key, a restart yields a state that was really saved", async () => {
    const w = await makeWorld();
    const fault = fc.record({ kind: fc.constantFrom("delete", "tear", "garbage", "null"), pick: fc.nat(1000) });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.constant("save" as const), fault), { minLength: 3, maxLength: 14 }),
        fc.boolean(),
        async (ops, withMirror) => {
          const mem = new MemoryKV();
          const mirror = withMirror ? new MemoryKV() : undefined;
          let s = mkStore(mem, mirror);
          const saved: string[] = [];
          let n = 0;
          for (const op of ops) {
            if (op === "save") {
              n++;
              const g = await commit(s, w, (n % 6) + 1);
              saved.push(g.envelope.checksum);
            } else if (saved.length > 0) {
              const keys = [...mem.data.keys()].filter((k) => k !== KEYS.events);
              const k = keys[op.pick % keys.length]!;
              if (op.kind === "delete") mem.data.delete(k);
              else if (op.kind === "tear") mem.data.set(k, tear(mem.data.get(k)));
              else if (op.kind === "null") mem.data.set(k, null);
              else mem.data.set(k, "garbage");
              // restart + self-check heals before the next fault, so at most one fault is outstanding
              s = mkStore(mem, mirror);
              const r = await s.selfCheck();
              expect(r.status).toBe("ok");
              expect(saved).toContain(r.status === "ok" ? r.gen.envelope.checksum : "");
            }
          }
          if (saved.length) {
            const r = await mkStore(mem, mirror).load();
            expect(r.status === "ok" && saved.includes(r.gen.envelope.checksum)).toBe(true);
          }
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 60) },
    );
  }, 60_000);
});
