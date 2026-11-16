// The plugin platform, wave 2a, after its review (docs/design/notes/PLUGINS-W2A-NOTES.md §11): the reviewer's probes
// as regression tests, and a test for each of the review's mutants that no test caught.
//   - W2A-01 (RU-1): a tagged write that meets a record its key does not verify while a key change's cleanup is still due
//     writes nothing and is tried again after a bounded, fixed series of waits; every approval survives the race.
//   - withFreshKeys' tries, counted.
// (The other probes were of the plugin platform's screens and lists, removed with it on 2026-11-12.)
import { describe, expect, it, vi } from "vitest";
import {
  CLEANUP_WAITS,
  CleanupPendingError,
  StaleKeyError,
  withFreshKeys,
  type GrantKeys,
} from "../../src/core/plugins/store";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { desc, LISTED, newVk, PID, TestGrantStore } from "../helpers/plugins";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).chrome = { i18n: { getUILanguage: () => "en" } };
});

// ---- W2A-01: a write between a key change's commit and the grant store's re-tag ------------------------------------

/**
 * A grant store whose record is under vk1, and the key change to vk2 as the vault's storage tells it: `commit` makes vk2
 * the active key with its cleanup due (the marker), `cleanup` re-tags the record (the grant store's VkRecord) and ends
 * it. `keys(vk)` is what a context's grantKeys() hands out; `pendingAsked` counts the write's look at the marker.
 */
async function rotation() {
  const local = new MemoryKV();
  const session = new MemoryKV();
  const store = new TestGrantStore({ local, session, lock: createMutex(), entries: "all" });
  const vk1 = await newVk(1);
  const vk2 = await newVk(2);
  let active = vk1.id;
  let pending = false;
  let pendingAsked = 0;
  const keys = (vk: GrantKeys["vk"]): GrantKeys => ({
    vk,
    activeVkId: async () => active,
    cleanupPending: async () => (pendingAsked++, pending),
  });
  await store.approve(keys(vk1), desc(PID), ["ui.slots"]);
  return {
    store,
    local,
    vk1,
    vk2,
    keys,
    commit: () => {
      active = vk2.id;
      pending = true;
    },
    cleanup: async () => {
      const r = await store.reencrypt(vk2, [vk1], async () => active);
      pending = false;
      return r;
    },
    pendingAsked: () => pendingAsked,
    ids: async (vk: GrantKeys["vk"]) => {
      const v = await store.read({ vk });
      return {
        ok: v.ok,
        ids: v.ok ? v.plugins.map((e) => e.pluginId).sort() : [],
        review: v.review.map((e) => e.pluginId),
      };
    },
  };
}
const snapshot = (kv: MemoryKV) => JSON.stringify([...kv.data.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

describe("W2A-01: a tagged write never starts a record afresh while a key change's cleanup is due", () => {
  it("RU-1: the old key refused, the new key's write waits for the re-tag; both approvals survive", async () => {
    const w = await rotation();
    w.commit(); // committed() stored the new key in the session; the cleanup's re-tag has not run yet
    const offered = [w.keys(w.vk1), w.keys(w.vk2), w.keys(w.vk2)];
    const waits: number[] = [];
    const r = await withFreshKeys(
      async () => offered.shift() ?? null,
      (k) => w.store.approve(k, desc(LISTED), ["ui.slots"]),
      async (ms) => {
        waits.push(ms);
        expect(await w.cleanup()).toBe("rewritten"); // the cleanup runs meanwhile
      },
    );
    expect(r).not.toBe(null);
    expect(waits).toEqual([100]);
    expect(await w.ids(w.vk2)).toEqual({ ok: true, ids: [PID, LISTED].sort(), review: [] });
  });
  it("refused with CleanupPendingError, and nothing at all written, the failed record not set aside", async () => {
    const w = await rotation();
    w.commit();
    const before = snapshot(w.local);
    await expect(w.store.approve(w.keys(w.vk2), desc(LISTED), ["ui.slots"])).rejects.toBeInstanceOf(
      CleanupPendingError,
    );
    await expect(w.store.setOn(w.keys(w.vk2), PID, false)).rejects.toBeInstanceOf(CleanupPendingError);
    expect(snapshot(w.local)).toBe(before);
    expect(await w.cleanup()).toBe("rewritten");
    expect(await w.ids(w.vk2)).toEqual({ ok: true, ids: [PID], review: [] });
  });
  it("with no cleanup due, a record its key does not verify is kept aside and a new one started, as before", async () => {
    const w = await rotation();
    const other = await newVk(3); // a key the record was never under (a restored copy, a forged record)
    await w.store.approve(
      { vk: other, activeVkId: async () => other.id, cleanupPending: async () => false },
      desc(LISTED),
      ["ui.slots"],
    );
    expect(await w.local.get(["sk_plugins_unverified"])).not.toEqual({});
    expect(await w.ids(other)).toEqual({ ok: true, ids: [LISTED], review: [PID] });
  });
  it("a record that verifies is written without a look at the marker; a missing record needs none either", async () => {
    const w = await rotation();
    expect(w.pendingAsked()).toBe(0);
    await w.store.approve(w.keys(w.vk1), desc(LISTED), ["ui.slots"]);
    expect(w.pendingAsked()).toBe(0);
    const fresh = new TestGrantStore({
      local: new MemoryKV(),
      session: new MemoryKV(),
      lock: createMutex(),
      entries: "all",
    });
    let asked = 0;
    await fresh.approve({ vk: w.vk1, cleanupPending: async () => (asked++, true) }, desc(PID), ["ui.slots"]);
    expect(asked).toBe(0);
  });
});

describe("withFreshKeys: its tries, counted (W2A-01; the review's R01, R02)", () => {
  /** What the key getter throws when it is asked once more than the code under test may ask (`sentinelAt`). */
  const SENTINEL = new Error("sentinel: a key asked for once too often");
  /**
   * `op` throws what `script` says, call by call (then answers "done"); `get` hands out keys (null after `keysFor`), and
   * throws SENTINEL at its `sentinelAt`th call: a mutant that tries again without bound fails on the assertions at once,
   * never by looping (the round-2 runaway mutant run).
   */
  function tries(script: ("stale" | "pending" | "other")[], sentinelAt: number, keysFor = Infinity) {
    const n = { get: 0, op: 0 };
    const waits: number[] = [];
    const vk = { id: "k", raw: new Uint8Array(32) } as unknown as GrantKeys["vk"];
    const run = withFreshKeys(
      async () => {
        if (++n.get >= sentinelAt) throw SENTINEL;
        return n.get > keysFor ? null : { vk };
      },
      async () => {
        const e = script[n.op++];
        if (e === "stale") throw new StaleKeyError();
        if (e === "pending") throw new CleanupPendingError();
        if (e === "other") throw new Error("other");
        return "done";
      },
      async (ms) => void waits.push(ms),
    );
    return { run, n, waits };
  }
  it("a cleanup still due: five waits, 100 ms to 1.6 s, then the error for the user to try again; never more", async () => {
    expect(CLEANUP_WAITS).toEqual([100, 200, 400, 800, 1600]);
    const t = tries(Array(20).fill("pending"), 7); // it would succeed at the 21st try
    await expect(t.run).rejects.toBeInstanceOf(CleanupPendingError);
    expect([t.n.get, t.n.op]).toEqual([6, 6]);
    expect(t.waits).toEqual([100, 200, 400, 800, 1600]);
  });
  it("a cleanup done after three waits: the write lands at the fourth try", async () => {
    const t = tries(["pending", "pending", "pending"], 5);
    await expect(t.run).resolves.toBe("done");
    expect([t.n.get, t.n.op]).toEqual([4, 4]);
    expect(t.waits).toEqual([100, 200, 400]);
  });
  it("a retired key, then the cleanup due, then done: three tries, one wait", async () => {
    const t = tries(["stale", "pending"], 4);
    await expect(t.run).resolves.toBe("done");
    expect([t.n.get, t.n.op]).toEqual([3, 3]);
    expect(t.waits).toEqual([100]);
  });
  it("a retired key twice: thrown at the second try, the key asked for twice and no more (R02)", async () => {
    const t = tries(["stale", "stale", "stale"], 3); // a third ask throws the sentinel
    await expect(t.run).rejects.toBeInstanceOf(StaleKeyError);
    expect([t.n.get, t.n.op]).toEqual([2, 2]);
    expect(t.waits).toEqual([]);
  });
  it("any other error: thrown at once, the key asked for once (R01)", async () => {
    const t = tries(["other"], 2);
    await expect(t.run).rejects.toThrow("other");
    expect([t.n.get, t.n.op]).toEqual([1, 1]);
  });
  it("locked: the operation is never run", async () => {
    const t = tries([], 2, 0);
    await expect(t.run).resolves.toBe(null);
    expect([t.n.get, t.n.op]).toEqual([1, 0]);
  });
});
