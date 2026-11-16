// The page's read of the backup in Chrome's sync storage (CSB-2; src/platform/csb-read.ts): the slots listed and
// assembled (intact, still arriving, not one this version reads, a later Sixkey's, keys of no slot), the intact ones as
// a restore takes them, and the watch while Chrome delivers another computer's items one by one, in any order: nothing
// is ever offered whole before its last item is here, a change is read once however many come during a read, and a
// stopped watch reads nothing more. Against the fake area (test/helpers/fake-sync-area.ts) and its "remote".
import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeCloudBackup, cloudBackupText, type CloudBackup } from "../../src/core/cloud/format";
import { openCloudBackups } from "../../src/core/cloud/restore";
import { chunkKey, manifestKey, planSlot, slotCandidate, type SlotPlan } from "../../src/core/cloud/slots";
import {
  listSlots,
  MAX_WAIT_MS,
  nothingArriving,
  slotList,
  waitForSlots,
  watchSlots,
  type SlotList,
  type SyncReader,
} from "../../src/platform/csb-read";
import { account, PASSWORD, protectedKeys, seal, T0, vaultOf, type Keys } from "../helpers/cloud";
import { FakeSyncArea } from "../helpers/fake-sync-area";

const A = "aaaa1111";
const B = "bbbb2222";
const C = "cccc3333";
const reader = (f: FakeSyncArea) => f as unknown as SyncReader;
const accounts = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => account(`Issuer ${from + i}`, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"));

let keys: Keys;
let older: CloudBackup; // 40 accounts, saved at T0 + 3
let newer: CloudBackup; // 60 accounts, saved at T0 + 4: more chunks
let pa: SlotPlan; // older in slot A
let pb: SlotPlan; // newer in slot B
let pb2: SlotPlan; // older in slot B, another tag: the write before pb
const plan = async (b: CloudBackup, slot: string, g: string) => {
  const p = await planSlot(b, slot, g);
  if (p.kind !== "plan") throw new Error("too large");
  return p;
};
beforeAll(async () => {
  keys = await protectedKeys();
  const file = async (n: number, seq: number) =>
    makeCloudBackup(
      await seal(keys, vaultOf(keys.keyring.vaultId, accounts(n)), seq, T0 + seq),
      "both",
      "Sixkey 0.1.0",
    );
  older = await file(40, 3);
  newer = await file(60, 4);
  pa = await plan(older, A, "0123456789abcdef");
  pb = await plan(newer, B, "fedcba9876543210");
  pb2 = await plan(older, B, "00000000000000ff");
  expect([pa.manifest.n, pb.manifest.n, pb2.manifest.n]).toEqual([3, 4, 3]);
});

const EMPTY: SlotList = { slots: [], intact: [], latest: null, partial: [], invalid: [], newer: [], foreign: [] };
const without = (items: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(items).filter(([k]) => !keys.includes(k)));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The lists a watch gives, its errors (each with where it came from), and a wait for the next one. */
function collect() {
  const lists: SlotList[] = [];
  const errors: unknown[] = [];
  const from: ("read" | "on")[] = [];
  let waiting: (() => void) | null = null;
  const onError = (e: unknown, where: "read" | "on") => {
    errors.push(e);
    from.push(where);
    waiting?.();
  };
  return {
    lists,
    errors,
    from,
    on: (l: SlotList) => {
      lists.push(l);
      waiting?.();
    },
    onError,
    /** The watch's options: this area, and this collector's onError. */
    with: (area: SyncReader | undefined) => ({ area, onError }),
    /** Resolves once there are `n` lists (and errors) in all. */
    async until(n: number) {
      while (lists.length + errors.length < n) await new Promise<void>((r) => (waiting = r));
      waiting = null;
    },
  };
}

describe("listSlots", () => {
  it("an empty area: nothing, from one get(null) and nothing else", async () => {
    const f = new FakeSyncArea();
    expect(await listSlots(reader(f))).toEqual(EMPTY);
    expect(f.calls).toEqual([{ op: "get", arg: null }]);
  });

  it("each slot as it is: intact (newest first, as a restore takes them), still arriving, not ours to read, a later Sixkey's; keys of no slot apart", async () => {
    const items = {
      ...pa.items,
      ...pb.items,
      [chunkKey(C, 0)]: "no manifest yet",
      [manifestKey("dddd4444")]: { v: 1, g: "zz" },
      [manifestKey("eeee5555")]: { v: 2, anything: true },
      [manifestKey("ffff6666")]: pa.manifest, // its chunks not here yet
      sk_other: 1,
      "bk2.aaaa1111": "a later format's key",
      "bk1.aaaa1111.13": "not a chunk key",
    };
    const f = new FakeSyncArea({ items });
    const l = await listSlots(reader(f));
    expect(l.slots.map((s) => [s.slot, s.read.kind])).toEqual([
      [A, "ok"],
      [B, "ok"],
      [C, "partial"],
      ["dddd4444", "invalid"],
      ["eeee5555", "newer"],
      ["ffff6666", "partial"],
    ]);
    const okA = l.slots[0]!.read;
    const okB = l.slots[1]!.read;
    if (okA.kind !== "ok" || okB.kind !== "ok") throw new Error("not ok");
    expect(l.intact).toEqual([slotCandidate(B, okB), slotCandidate(A, okA)]);
    expect(l.latest).toBe(newer.generation.savedAt);
    expect([l.partial, l.invalid, l.newer]).toEqual([[C, "ffff6666"], ["dddd4444"], ["eeee5555"]]);
    expect(l.foreign).toEqual(["bk1.aaaa1111.13", "bk2.aaaa1111", "sk_other"]);
    expect(okB.text).toBe(cloudBackupText(newer));
    expect(f.callsOf("get")).toEqual([null]);
    expect(f.calls.map((c) => c.op)).toEqual(["get"]);
  });

  it("the intact slots open with restore.ts as they are: the master password, both merged, the newest the base", async () => {
    const f = new FakeSyncArea({ items: { ...pa.items, ...pb.items } });
    const l = await listSlots(reader(f));
    const r = await openCloudBackups(l.intact, { password: PASSWORD }, { now: T0 + 60_000, device: "restored1" });
    expect(r).not.toBeNull();
    expect(r!.base.id).toBe(B);
    expect(r!.merged).toEqual([B, A]);
    expect(r!.vault.entries.filter((e) => !e.deleted)).toHaveLength(100); // 40 and 60 accounts, each its own
  });

  it("a slot missing a chunk, or under a manifest of another write, is still arriving: never offered", async () => {
    for (const items of [
      without(pb.items, chunkKey(B, 2)),
      { ...pb.items, [manifestKey(B)]: pb2.manifest }, // the old manifest over the new chunks
      { ...pb2.items, [manifestKey(B)]: pb.manifest, [chunkKey(B, 1)]: pb.items[chunkKey(B, 1)] }, // a mix
    ]) {
      const l = await listSlots(reader(new FakeSyncArea({ items })));
      expect([l.intact, l.partial, l.latest]).toEqual([[], [B], null]);
    }
  });

  it("slotList is listSlots without the read", async () => {
    const items = { ...pa.items, x: 1 };
    expect(await slotList(items)).toEqual(await listSlots(reader(new FakeSyncArea({ items }))));
  });

  it("no area, or a read that fails: rejects", async () => {
    await expect(listSlots(undefined)).rejects.toThrow("storage.sync is not available");
    const f = new FakeSyncArea();
    f.fail.get = ["Something went wrong"];
    await expect(listSlots(reader(f))).rejects.toThrow("Something went wrong");
    expect(globalThis.chrome).toBeUndefined();
    await expect(listSlots()).rejects.toThrow("storage.sync is not available"); // chrome.storage.sync by default
  });
});

describe("watchSlots", () => {
  it("the listener first, then the first read: what arrives in between is not missed", async () => {
    const f = new FakeSyncArea();
    const get = f.get.bind(f);
    const listening: number[] = [];
    f.get = (k) => (listening.push(f.listenerCount()), get(k));
    const c = collect();
    const stop = watchSlots(c.on, c.with(reader(f)));
    expect(listening).toEqual([1]); // its first get, made with the listener already there
    f.remote.put(pa.items);
    f.remote.deliverAll(); // before the first read has run
    await c.until(1);
    // in a list: the first read's, or the one its change event gives (however long the hashing takes)
    await vi.waitFor(() => expect(c.lists.at(-1)!.intact.map((x) => x.id)).toEqual([A]), { timeout: 5_000 });
    stop();
    expect(c.errors).toEqual([]);
  });

  it("another computer's slot, delivered in any order: offered only once its last item is here, then whole", async () => {
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(Object.keys(pb.items), { minLength: 5, maxLength: 5 }), async (order) => {
        const f = new FakeSyncArea({ items: pa.items });
        const c = collect();
        const stop = watchSlots(c.on, c.with(reader(f)));
        await c.until(1);
        f.remote.put(pb.items);
        for (const [i, key] of order.entries()) {
          const before = c.lists.length;
          f.remote.deliver(key);
          await c.until(before + 1);
          const l = c.lists.at(-1)!;
          const last = i === order.length - 1;
          expect(l.intact.map((x) => x.id)).toEqual(last ? [B, A] : [A]);
          expect(l.partial).toEqual(last ? [] : [B]);
          expect(l.invalid).toEqual([]);
        }
        stop();
        expect(f.callsOf("get")).toHaveLength(6); // the first read, then one for each item
      }),
      { numRuns: 15 },
    );
  });

  it("an overwrite of a slot arriving in any order (an adopter's write, more chunks): each list has the old copy whole, the new one whole, or neither; never a third text, never invalid", async () => {
    const texts = [cloudBackupText(older), cloudBackupText(newer)];
    const keysOf = Object.keys(pb.items);
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(keysOf, { minLength: keysOf.length, maxLength: keysOf.length }),
        async (order) => {
          const f = new FakeSyncArea({ items: pb2.items });
          const c = collect();
          const stop = watchSlots(c.on, c.with(reader(f)));
          await c.until(1);
          expect(c.lists[0]!.intact.map((x) => x.head)).toEqual([pb2.manifest.g]);
          f.remote.put(pb.items);
          for (const key of order) {
            const before = c.lists.length;
            f.remote.deliver(key);
            await c.until(before + 1);
            const s = c.lists.at(-1)!.slots;
            expect(s.map((x) => x.slot)).toEqual([B]);
            const r = s[0]!.read;
            expect(["ok", "partial"]).toContain(r.kind);
            if (r.kind === "ok") expect(texts).toContain(r.text);
          }
          stop();
          const r = c.lists.at(-1)!.slots[0]!.read;
          expect(r.kind === "ok" && r.text).toBe(texts[1]);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("changes of keys of no slot read nothing", async () => {
    const f = new FakeSyncArea();
    const c = collect();
    const stop = watchSlots(c.on, c.with(reader(f)));
    await c.until(1);
    f.remote.put({ sk_other: 1, "bk2.aaaa1111": "x" });
    f.remote.deliverAll();
    await f.set({ another: 2 });
    for (let i = 0; i < 5; i++) await tick();
    stop();
    expect(f.callsOf("get")).toHaveLength(1);
    expect(c.lists).toHaveLength(1);
  });

  it("changes during a read: one more read for all of them, not one each", async () => {
    const f = new FakeSyncArea({ items: pa.items });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const get = f.get.bind(f);
    let n = 0;
    f.get = async (k) => {
      n++;
      if (n === 1) await held; // the first read waits until the three items have come
      return get(k);
    };
    const c = collect();
    const stop = watchSlots(c.on, c.with(reader(f)));
    await tick();
    f.remote.put(without(pb.items, chunkKey(B, 3)));
    f.remote.deliverAll();
    for (let i = 0; i < 5; i++) await tick();
    expect(n).toBe(1);
    release();
    await c.until(2);
    for (let i = 0; i < 5; i++) await tick();
    stop();
    expect(n).toBe(2);
    expect(c.lists).toHaveLength(2);
    expect(c.lists[1]!.partial).toEqual([B]);
  });

  it("stopped: the listener gone, no read after it, and a read in flight not delivered", async () => {
    const f = new FakeSyncArea();
    const c = collect();
    const stop = watchSlots(c.on, c.with(reader(f)));
    stop(); // before its first read has ended
    expect(f.listenerCount()).toBe(0);
    for (let i = 0; i < 5; i++) await tick();
    f.remote.put(pa.items);
    f.remote.deliverAll();
    for (let i = 0; i < 5; i++) await tick();
    expect(c.lists).toEqual([]);
    expect(f.callsOf("get").length).toBeLessThanOrEqual(1);
  });

  it("a read that fails goes to onError, and the watch goes on at the next change", async () => {
    const f = new FakeSyncArea();
    f.fail.get = ["Something went wrong"];
    const c = collect();
    const stop = watchSlots(c.on, c.with(reader(f)));
    await c.until(1);
    expect(c.errors.map((e) => (e as Error).message)).toEqual(["Something went wrong"]);
    expect(c.from).toEqual(["read"]);
    f.remote.put(pa.items);
    f.remote.deliver(manifestKey(A));
    await c.until(2);
    stop();
    expect(c.lists.map((l) => l.partial)).toEqual([[A]]);
  });

  it("`on` that throws: its exception to onError as from `on` (never taken for a failed read, never dropped), and the watch goes on", async () => {
    const f = new FakeSyncArea();
    const c = collect();
    let calls = 0;
    const stop = watchSlots(
      (l) => {
        calls++;
        c.on(l);
        if (calls === 1) throw new Error("the page's own bug");
      },
      c.with(reader(f)),
    );
    await c.until(2);
    expect([c.errors.map((e) => (e as Error).message), c.from]).toEqual([["the page's own bug"], ["on"]]);
    f.remote.put(pa.items);
    f.remote.deliverAll();
    while (c.lists.at(-1)!.intact.length === 0) await c.until(c.lists.length + c.errors.length + 1);
    stop();
    expect(c.lists.at(-1)!.intact.map((x) => x.id)).toEqual([A]);
    expect(c.from).toEqual(["on"]);
  });

  it("stopped while a read is under way and changes are owed: no read after it (the loop ends with the stop)", async () => {
    const f = new FakeSyncArea();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const get = f.get.bind(f);
    let n = 0;
    f.get = async (k) => {
      n++;
      if (n === 1) await held;
      return get(k);
    };
    const c = collect();
    const stop = watchSlots(c.on, c.with(reader(f)));
    await tick();
    f.remote.put(pa.items);
    f.remote.deliverAll(); // changes during the first read: one more read is owed
    for (let i = 0; i < 5; i++) await tick();
    stop();
    release();
    for (let i = 0; i < 10; i++) await tick();
    expect([n, c.lists.length, c.errors.length]).toEqual([1, 0, 0]);
  });

  it("stopped from inside `on` (as waitForSlots ends) while a read is owed: no read after it", async () => {
    const f = new FakeSyncArea();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const get = f.get.bind(f);
    let n = 0;
    f.get = async (k) => {
      n++;
      if (n === 1) await held;
      return get(k);
    };
    const c = collect();
    let stop: () => void = () => undefined;
    stop = watchSlots(
      (l) => {
        c.on(l);
        stop();
      },
      c.with(reader(f)),
    );
    await tick();
    f.remote.put(pa.items);
    f.remote.deliverAll(); // changes during the first read: one more read is owed
    for (let i = 0; i < 5; i++) await tick();
    release();
    for (let i = 0; i < 10; i++) await tick();
    expect([n, c.lists.length, c.errors.length, f.listenerCount()]).toEqual([1, 1, 0, 0]);
  });

  it("no area: throws at once", () => {
    expect(() => watchSlots(() => undefined, { area: undefined, onError: () => undefined })).toThrow(
      "storage.sync is not available",
    );
  });
});

describe("waitForSlots", () => {
  it("resolves, settled, once the slot that was arriving is whole", async () => {
    const f = new FakeSyncArea({ items: without(pb.items, chunkKey(B, 1)) });
    f.remote.put({ [chunkKey(B, 1)]: pb.items[chunkKey(B, 1)] });
    const wait = waitForSlots({ ms: 10_000, area: reader(f) });
    for (let i = 0; i < 20; i++) await tick();
    f.remote.deliverAll();
    const r = await wait;
    expect(r.settled).toBe(true);
    expect(r.list.intact.map((x) => x.id)).toEqual([B]);
    expect(f.listenerCount()).toBe(0); // its watch stopped
  });

  it("at its time limit: the last list, unsettled (a slot whose items never all arrive)", async () => {
    const f = new FakeSyncArea({ items: without(pb.items, chunkKey(B, 1)) });
    const r = await waitForSlots({ ms: 50, area: reader(f) });
    expect(r.settled).toBe(false);
    expect(r.list.partial).toEqual([B]);
    expect(f.listenerCount()).toBe(0);
  });

  it("a condition of its own: the first intact slot", async () => {
    const f = new FakeSyncArea();
    f.remote.put(pa.items);
    const wait = waitForSlots({ ms: 10_000, area: reader(f), done: (l) => l.intact.length > 0 });
    for (let i = 0; i < 5; i++) await tick();
    f.remote.deliverAll();
    const r = await wait;
    expect([r.settled, r.list.latest]).toEqual([true, older.generation.savedAt]);
    expect(nothingArriving(r.list)).toBe(true);
  });

  it("an empty area is settled at once (nothing arriving)", async () => {
    const r = await waitForSlots({ ms: 10_000, area: reader(new FakeSyncArea()) });
    expect(r).toEqual({ list: EMPTY, settled: true });
  });

  it("a first read that ends after the time limit: the wait ends with it, unsettled, its watch stopped", async () => {
    const f = new FakeSyncArea({ items: without(pb.items, chunkKey(B, 1)) }); // a slot whose last item never comes
    const get = f.get.bind(f);
    f.get = async (k) => {
      await new Promise((r) => setTimeout(r, 60));
      return get(k);
    };
    const r = await waitForSlots({ ms: 10, area: reader(f) });
    expect([r.settled, r.list.partial]).toEqual([false, [B]]);
    expect(f.listenerCount()).toBe(0);
  });

  it("a read that fails after the first list: rejects, its watch stopped", async () => {
    const f = new FakeSyncArea({ items: without(pb.items, chunkKey(B, 1)) });
    f.remote.put({ [chunkKey(B, 1)]: pb.items[chunkKey(B, 1)] });
    const wait = waitForSlots({ ms: 10_000, area: reader(f) });
    for (let i = 0; i < 20; i++) await tick();
    expect(f.callsOf("get")).toHaveLength(1); // the first list read, partial: still waiting
    f.fail.get = ["Something went wrong later"];
    f.remote.deliverAll();
    await expect(wait).rejects.toThrow("Something went wrong later");
    expect(f.listenerCount()).toBe(0);
  });

  it("a condition that throws: rejects, its watch stopped", async () => {
    const f = new FakeSyncArea();
    await expect(
      waitForSlots({
        ms: 10_000,
        area: reader(f),
        done: () => {
          throw new Error("a bad condition");
        },
      }),
    ).rejects.toThrow("a bad condition");
    expect(f.listenerCount()).toBe(0);
  });

  it.each([NaN, -1, 1.5, Infinity, MAX_WAIT_MS + 1])(
    "refuses a time limit of %s (setTimeout would end it at once): no watch",
    async (ms) => {
      const f = new FakeSyncArea();
      await expect(waitForSlots({ ms, area: reader(f) })).rejects.toThrow(RangeError);
      expect([f.listenerCount(), f.calls.length]).toEqual([0, 0]);
    },
  );

  it("time limits of 0 and MAX_WAIT_MS (2^31 - 1) are taken", async () => {
    expect(MAX_WAIT_MS).toBe(2 ** 31 - 1);
    const f = new FakeSyncArea();
    expect((await waitForSlots({ ms: 0, area: reader(f) })).settled).toBe(true);
    expect((await waitForSlots({ ms: MAX_WAIT_MS, area: reader(f) })).settled).toBe(true);
    expect(f.listenerCount()).toBe(0);
  });

  it("rejects when a read fails, or when there is no area", async () => {
    const f = new FakeSyncArea();
    f.fail.get = ["Something went wrong"];
    await expect(waitForSlots({ ms: 10_000, area: reader(f) })).rejects.toThrow("Something went wrong");
    expect(f.listenerCount()).toBe(0);
    await expect(waitForSlots({ ms: 10_000, area: undefined })).rejects.toThrow("storage.sync is not available");
  });
});
