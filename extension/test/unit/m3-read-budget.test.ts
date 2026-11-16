// What a round costs in storage reads and writes (M3; the brief's read-budget impact). The popup's open and unlock never run
// the engine (test/unit/m3-source-rules.test.ts: the popup's module graph holds none of it), so read-budget.test.ts's gates
// (open 4, unlock 7, degraded unlock 10) are untouched by M3 and stay as they are. The sync-on budget of the service worker
// and the settings page is pinned here and documented in docs/design/notes/M3-NOTES.md:
//   - sync off: a round reads sk_sync_cfg and sk_sync_state once each and the identity once; writes and sends nothing;
//   - the steady state (in sync, nothing to do, unlocked): one status request; 8 storage.local reads (listed below), one
//     IndexedDB read, nothing written (the attempt time is written at most every 30 s);
//   - locked, nothing to push: one status request, 9 storage.local reads (the plain keyring for D8 seen while locked),
//     one IndexedDB read, nothing written.
import { describe, expect, it } from "vitest";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { contextOver, newDisk, World, worldOf, type Device } from "../helpers/m3-world";

class Counting implements KV {
  reads: string[][] = [];
  writes: string[][] = [];
  constructor(readonly inner: MemoryKV) {}
  get(k: string[]) {
    this.reads.push(k);
    return this.inner.get(k);
  }
  keys() {
    this.reads.push(["*"]);
    return this.inner.keys();
  }
  set(i: Record<string, unknown>) {
    this.writes.push(Object.keys(i));
    return this.inner.set(i);
  }
  remove(k: string[]) {
    this.writes.push(k);
    return this.inner.remove(k);
  }
}

function counted(d: Device) {
  const kv = new Counting(d.disk.kv);
  const idb = new Counting(d.disk.idb);
  const mirror = new Counting(d.disk.mirror);
  const ctx = contextOver({
    kv,
    mirror,
    idb,
    session: d.disk.session,
    lock: d.lock,
    identityLock: d.identityLock,
    syncLock: d.syncLock,
    transport: d.net,
    clock: d.now,
  });
  return { ctx, kv, idb, mirror };
}

describe("M3: a round's storage cost", () => {
  it("sync off: the configuration and the sync state once each, the identity once; nothing written, nothing sent", async () => {
    const w = new World();
    const d = w.device("Off", newDisk());
    const c = counted(d);
    const n0 = w.server.requests.length;
    expect((await c.ctx.engine.round()).status).toBe("off");
    expect({
      local: c.kv.reads.flat().sort(),
      idb: c.idb.reads.length,
      mirror: c.mirror.reads.length,
      writes: c.kv.writes.length + c.idb.writes.length,
      sent: w.server.requests.length - n0,
    }).toEqual({
      local: ["sk_sync_cfg", "sk_sync_state"].sort(),
      idb: 1,
      mirror: 0,
      writes: 0,
      sent: 0,
    });
  });

  it("the steady state, unlocked: one request; the reads pinned; nothing written", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    await a.engine.round();
    const c = counted(a);
    const n0 = w.server.requests.length;
    expect((await c.ctx.engine.round()).status).toBe("ok");
    const summary = {
      local: c.kv.reads.length,
      idb: c.idb.reads.length,
      mirror: c.mirror.reads.length,
      localWrites: c.kv.writes,
      idbWrites: c.idb.writes,
      sent: w.server.requests.slice(n0).map((r) => r.op),
    };
    expect(summary).toEqual({
      local: 8,
      idb: 1,
      mirror: 0,
      localWrites: [],
      idbWrites: [],
      sent: ["GET /v1/sync/status"],
    });
    // status(): the copy and the settle; the vault (pointer, slot) and the session's settings (requireVk); then the
    // engine's state (after the vault: M3R-1, the same eight reads in another order); the guarded record (read, nothing
    // to write); the rerun check
    // (revision 19: the engine's state read takes sk_sync_orphan in the same get, so the count is unchanged)
    expect(c.kv.reads).toEqual(
      [
        ["sk_sync_cfg"],
        ["sk_sync_state"],
        ["sk_active"],
        ["sk_slot_a"],
        ["sk_settings"],
        ["sk_sync_state", "sk_sync_outbox", "sk_sync_cfg", "sk_sync_orphan"],
        ["sk_sync_state", "sk_sync_cfg"],
        ["sk_sync_state", "sk_sync_outbox", "sk_sync_cfg", "sk_sync_orphan"],
      ].map((x) => x.map((k) => (k === "sk_slot_a" ? c.kv.reads[3]![0]! : k))),
    );
  });

  it("the attempt time is written at most every 30 s: a quiet round 10 s after the last write writes nothing, one 35 s after it writes sk_sync_state once", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    await a.engine.round();
    w.advance(31_000);
    await a.engine.round(); // the attempt time (and the last success) written: 31 s since
    const c = counted(a);
    w.advance(10_000);
    expect((await c.ctx.engine.round()).status).toBe("ok");
    expect(c.kv.writes).toEqual([]);
    w.advance(25_000);
    expect((await c.ctx.engine.round()).status).toBe("ok");
    expect(c.kv.writes).toEqual([["sk_sync_state"]]);
    expect(c.idb.writes).toEqual([]);
  });

  it("locked, nothing to push: one request, nothing written", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    await a.engine.round();
    await a.lockNow();
    await a.engine.round(); // the status write of the first locked round
    const c = counted(a);
    const n0 = w.server.requests.length;
    expect((await c.ctx.engine.round()).status).toBe("locked");
    expect({
      local: c.kv.reads.length,
      idb: c.idb.reads.length,
      mirror: c.mirror.reads.length,
      writes: c.kv.writes.length + c.idb.writes.length,
      sent: w.server.requests.slice(n0).map((r) => r.op),
    }).toEqual({
      local: 9,
      idb: 1,
      mirror: 0,
      writes: 0,
      sent: ["GET /v1/sync/status"],
    });
  });
});
