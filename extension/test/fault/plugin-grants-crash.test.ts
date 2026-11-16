// The grant store's crash safety (src/core/plugins/store.ts): every write of every
// operation is interrupted in turn (before it lands, or after it landed but before the caller heard), in chrome.storage.
// local and chrome.storage.session alike, and the store is read again by a new context, with the session kept (a worker
// or a page restarted) or emptied (the browser restarted). After each:
//   - the read never throws, and what it honours is the state before the operation or the state after it, never a third
//     one, never looser than both;
//   - a suspension decided before the crash (in the overlay or the record) is never lost;
//   - nothing is wiped: every plugin of the record is still in it, or listed for review;
//   - the session's epoch never makes the store refuse its own record (the epoch is written after the record);
//   - a value cut short (a store that is not atomic per key) fails closed: nothing is honoured, nothing throws.
import { describe, expect, it } from "vitest";
import type { GrantKeys } from "../../src/core/plugins/store";
import { GRANTS_KEY, OVERLAY_KEY, type GrantState } from "../../src/core/plugins/grants";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { CrashError, tear, type CrashMode } from "../helpers/faulty-kv";
import { desc, keysOf, newVk, OTHER, PID, TestGrantStore } from "../helpers/plugins";

/** Both storage areas under one counter of writes: the process dies at the Nth write, in whichever area it falls. */
class Areas {
  calls = 0;
  dead = false;
  plan: { at: number; mode: CrashMode } | null = null;
  readonly local = new MemoryKV();
  readonly session = new MemoryKV();
  wrap(inner: MemoryKV): KV {
    const self = this;
    const write = async (fn: () => Promise<void>, torn?: () => Promise<void>) => {
      if (self.dead) throw new CrashError();
      self.calls++;
      if (self.plan && self.calls === self.plan.at) {
        self.dead = true;
        if (self.plan.mode === "after") await fn();
        if (self.plan.mode === "torn" && torn) await torn();
        throw new CrashError();
      }
      await fn();
    };
    return {
      async get(keys) {
        if (self.dead) throw new CrashError();
        return inner.get(keys);
      },
      async keys() {
        return inner.keys();
      },
      set: (items) =>
        write(
          () => inner.set(items),
          () => {
            const [k0, v0] = Object.entries(items)[0]!;
            return inner.set({ [k0]: tear(v0) });
          },
        ),
      remove: (keys) => write(() => inner.remove(keys)),
    };
  }
  store(now: () => number): TestGrantStore {
    return new TestGrantStore({
      local: this.wrap(this.local),
      session: this.wrap(this.session),
      lock: createMutex(),
      now,
      entries: "all",
    });
  }
  /** A new context over what landed: the plan gone. `restart`: the browser restarted (storage.session is empty). */
  fresh(now: () => number, restart: boolean): TestGrantStore {
    this.plan = null;
    this.dead = false;
    if (restart) this.session.data.clear();
    return this.store(now);
  }
}

type View = Map<string, GrantState>;
async function honoured(s: TestGrantStore, keys: GrantKeys): Promise<{ ok: boolean; view: View; listed: Set<string> }> {
  const r = await s.read(keys);
  const view: View = new Map(r.ok ? r.plugins.map((p) => [p.pluginId, p.state]) : []);
  const listed = new Set([...(r.ok ? r.plugins : []), ...r.review].map((p) => p.pluginId));
  return { ok: r.ok, view, listed };
}
const looser = (a: GrantState | undefined, b: GrantState | undefined) => {
  const rank = (s: GrantState | undefined) => (s === undefined ? 3 : s === "approved" ? 0 : s === "disabled" ? 1 : 2);
  return rank(a) < rank(b);
};

type Op = {
  name: string;
  /** what is there before the operation (run without faults) */
  setup: (s: TestGrantStore, keys: GrantKeys, tick: () => void) => Promise<void>;
  run: (s: TestGrantStore, keys: GrantKeys) => Promise<unknown>;
  /** plugins whose suspension is decided before the operation and must hold after any crash */
  suspendedBefore?: string[];
};

const OPS: Op[] = [
  {
    name: "approve a first plugin",
    setup: async () => undefined,
    run: (s, k) => s.approve(k, desc(PID), ["ui.slots"]),
  },
  {
    name: "approve a second plugin",
    setup: async (s, k) => void (await s.approve(k, desc(PID), ["ui.slots"])),
    run: (s, k) => s.approve(k, desc(OTHER), ["ui.slots"]),
  },
  {
    name: "turn a plugin off",
    setup: async (s, k) => void (await s.approve(k, desc(PID), ["ui.slots"])),
    run: (s, k) => s.setOn(k, PID, false),
  },
  {
    name: "turn a plugin on again",
    setup: async (s, k, tick) => {
      await s.approve(k, desc(PID), ["ui.slots"]);
      tick();
      await s.setOn(k, PID, false);
      tick();
    },
    run: (s, k) => s.setOn(k, PID, true),
  },
  {
    name: "remove a plugin",
    setup: async (s, k) => {
      await s.approve(k, desc(PID), ["ui.slots"]);
      await s.approve(k, desc(OTHER), ["ui.slots"]);
    },
    run: (s, k) => s.remove(k, PID),
  },
  {
    name: "merge an overlay suspension at a verified read",
    setup: async (s, k, tick) => {
      await s.approve(k, desc(PID), ["ui.slots"]);
      tick();
      await s.tighten(PID, "suspend", "changed");
      tick();
    },
    run: (s, k) => s.read(k),
    suspendedBefore: [PID],
  },
  {
    // W1b: the built-in autofill switched off (core/plugins/builtin.ts), a tagged write of its entry
    name: "turn the built-in autofill off",
    setup: async (s, k) => void (await s.approve(k, desc(PID), ["ui.slots"])),
    run: (s, k) => s.setAutofill(k, false),
  },
  {
    name: "an overlay entry (the worker, locked)",
    setup: async (s, k, tick) => {
      await s.approve(k, desc(PID), ["ui.slots"]);
      tick();
    },
    run: (s) => s.tighten(PID, "suspend", "changed"),
  },
  {
    // r2 N8: the versions Chrome reports recorded as the approved ones (OD-2), a tagged write like the others
    name: "record the versions Chrome reports",
    setup: async (s, k) => {
      await s.approve(k, desc(PID), ["ui.slots"]);
      await s.approve(k, desc(OTHER), ["ui.slots"]);
    },
    run: (s, k) => s.recordVersions(k, new Map([[PID, "2.0.1"]])),
  },
  {
    // r2 N8: the key-change cleanup's re-tag (GrantStore.reencrypt): written under the old key, read under the new one
    name: "re-tag under the new key in the key-change cleanup",
    setup: async (s) => {
      const old = keysOf(await newVk(8));
      await s.approve(old, desc(PID), ["ui.slots"]);
      await s.approve(old, desc(OTHER), ["ui.slots"]);
    },
    run: async (s, k) => s.reencrypt(k.vk, [await newVk(8)], async () => k.vk.id),
  },
  {
    name: "approve again after a failed tag (the record kept aside first)",
    setup: async (s, k) => {
      await s.approve(k, desc(PID), ["ui.slots"]);
      await s.approve(k, desc(OTHER), ["ui.slots"]);
    },
    run: (s, k) => s.approve(k, desc(PID), ["ui.slots"]),
  },
];

describe.each(OPS)("$name: interrupted at every write", (op) => {
  it.each(["before", "after", "torn"] as const)("mode %s, session kept and browser restarted", async (mode) => {
    // how many writes the operation makes, from a clean run
    const count = async () => {
      const a = new Areas();
      let t = 1_000;
      const now = () => t;
      const keys = keysOf(await newVk(9));
      const s = a.store(now);
      await op.setup(s, keys, () => void (t += 1_000));
      if (op.name.startsWith("approve again")) await breakTag(a);
      t += 1_000;
      const before = a.calls;
      await op.run(s, keys);
      return a.calls - before;
    };
    const writes = await count();
    expect(writes, "the operation writes something").toBeGreaterThan(0);
    for (let at = 1; at <= writes; at++)
      for (const restart of [false, true]) {
        const a = new Areas();
        let t = 1_000;
        const now = () => t;
        const keys = keysOf(await newVk(9));
        const s = a.store(now);
        await op.setup(s, keys, () => void (t += 1_000));
        if (op.name.startsWith("approve again")) await breakTag(a);
        // the states on either side, from runs without faults
        const pre = await expected(op, mode, false);
        const post = await expected(op, mode, true);
        t += 1_000;
        a.plan = { at: a.calls + at, mode };
        await expect(op.run(s, keys)).rejects.toThrow(CrashError);
        const after = a.fresh(now, restart);
        const got = await honoured(after, keys);
        const where = `${op.name}, write ${at}/${writes}, ${mode}, ${restart ? "restart" : "same session"}`;
        if (mode === "torn") {
          // a value cut short: whatever it was, nothing is honoured from a record that does not parse, and nothing throws
          if (recordTorn(await a.local.get([GRANTS_KEY]))) expect(got.ok, where).toBe(false);
          continue;
        }
        // the session's epoch never makes the store refuse its own record: where both sides read, so does this one
        if (pre.ok && post.ok) expect(got.ok, `${where}: refused`).toBe(true);
        for (const id of [PID, OTHER]) {
          const g = got.view.get(id);
          const ok = g === pre.view.get(id) || g === post.view.get(id);
          expect(ok, `${where}: ${id} is ${g}, before ${pre.view.get(id)}, after ${post.view.get(id)}`).toBe(true);
          expect(looser(g, pre.view.get(id)) && looser(g, post.view.get(id)), `${where}: ${id} looser than both`).toBe(
            false,
          );
          // nothing wiped: a plugin there before is still there, or listed for review, unless the operation removed it
          if (pre.listed.has(id) && !(op.name === "remove a plugin" && id === PID))
            expect(got.listed.has(id), `${where}: ${id} not listed`).toBe(true);
        }
        for (const id of op.suspendedBefore ?? [])
          expect(got.view.get(id), `${where}: suspension lost`).toBe("suspended");
      }
  });
});

async function breakTag(a: Areas) {
  const r = (await a.local.get([GRANTS_KEY]))[GRANTS_KEY] as Record<string, unknown>;
  await a.local.set({ [GRANTS_KEY]: { ...r, tag: "A".repeat(43) } });
}
const recordTorn = (r: Record<string, unknown>) => !!(r[GRANTS_KEY] as { torn?: unknown } | undefined)?.torn;

/** The honoured state before (`done` false) or after (`done` true) the operation, without faults. */
async function expected(op: Op, _mode: CrashMode, done: boolean) {
  const a = new Areas();
  let t = 1_000;
  const now = () => t;
  const keys = keysOf(await newVk(9));
  const s = a.store(now);
  await op.setup(s, keys, () => void (t += 1_000));
  if (op.name.startsWith("approve again")) await breakTag(a);
  t += 1_000;
  if (done) await op.run(s, keys);
  return honoured(a.fresh(now, false), keys);
}

describe("an overlay suspension survives a worker restart and a browser restart, and is merged at the next unlock", () => {
  it("written while locked, honoured without the key, still there after both restarts, then merged", async () => {
    const a = new Areas();
    let t = 1_000;
    const keys = keysOf(await newVk(3));
    await a.store(() => t).approve(keys, desc(PID), ["ui.slots"]);
    t = 2_000;
    await a.store(() => t).tighten(PID, "suspend", "changed"); // the worker, Sixkey locked
    for (const restart of [false, true]) {
      const s = a.fresh(() => t, restart);
      expect((await s.unverified()).plugins[0]!.state, `restart ${restart}`).toBe("suspended");
      expect((await a.local.get([GRANTS_KEY]))[GRANTS_KEY]).toBeDefined(); // the store is not emptied
    }
    const r = await a.fresh(() => t, true).read(keys);
    expect(r.ok && r.plugins[0]!.state).toBe("suspended");
    expect((await a.local.get([OVERLAY_KEY]))[OVERLAY_KEY]).toBeUndefined();
  });
});
