// What settlePins() and status() read (docs/audit/internal-reviews/M2-REREVIEW.md, Notes): M3 calls one of them before every adoption or
// pre-send decision, in the service worker or the settings page (never on the popup's open or unlock, whose gates are
// read-budget.test.ts's). In the steady state (no pending copy): one storage.local read and one IndexedDB read for the
// settle, one more storage.local read (sk_sync_cfg) for status(), nothing written. With a pending copy to apply, a few
// more, and the read-back of the pin write (RR-7).
import { describe, expect, it } from "vitest";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { bundleFor, m2World, newCode, publishedOf, steadyState, vaultWith } from "../helpers/m2-world";

class Counting implements KV {
  reads: string[][] = [];
  writes = 0;
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
    this.writes++;
    return this.inner.set(i);
  }
  remove(k: string[]) {
    this.writes++;
    return this.inner.remove(k);
  }
  reset() {
    this.reads = [];
    this.writes = 0;
  }
}
class NoWrite implements KV {
  constructor(readonly inner: MemoryKV) {}
  get(k: string[]) {
    return this.inner.get(k);
  }
  keys() {
    return this.inner.keys();
  }
  async set(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
  async remove(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
}

describe("settlePins / status() read cost", () => {
  it("steady state: the settle reads sk_sync_state and the identity once each, status() also sk_sync_cfg, nothing written; with a pending copy to apply: pointer, slot, state again, the identity and its read-back, two writes", async () => {
    const w = m2World();
    await vaultWith(w, ["A", "B"], { syncOn: true });
    const st = await steadyState(w, 5);
    const lk = new Counting(w.kv);
    const ik = new Counting(w.idb);
    await w.local(lk, ik).settlePins();
    expect([lk.reads, ik.reads.length, lk.writes + ik.writes]).toEqual([[[SYNC_KEYS.state]], 1, 0]);
    lk.reset();
    ik.reset();
    await w.local(lk, ik).status();
    expect([lk.reads.flat().sort(), ik.reads.length, lk.writes + ik.writes]).toEqual([
      [SYNC_KEYS.cfg, SYNC_KEYS.state].sort(),
      1,
      0,
    ]);
    // a commit whose IndexedDB pins were lost
    const g = await w.active();
    const r = await newCode(g.keyring, st.vk);
    const next = await bundleFor(st.vk, r.keyring, 6, st.bundle.auth);
    const keys = await publishedOf({
      server: st.bundle,
      local: g.keyring,
      vk: st.vk,
      op: "change_recovery",
      sent: next,
      sentVk: st.vk,
      sentSecret: { recoveryCode: r.recoveryCode },
    });
    await w.flows(w.svc(), w.local(w.kv, new NoWrite(w.idb))).commitKeys({ keys });
    expect((w.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeDefined();
    lk.reset();
    ik.reset();
    await w.local(lk, ik).settlePins();
    expect({ local: lk.reads.length, idb: ik.reads.length, writes: lk.writes + ik.writes }).toEqual({
      local: 5,
      idb: 3,
      writes: 2,
    }); // idb: the view, setPins' own read, the read-back
  }, 60_000);
});
