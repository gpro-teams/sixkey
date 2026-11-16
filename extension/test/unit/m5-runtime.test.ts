// The runtime's outbox wiring (src/platform/runtime.ts; SYNC-DESIGN §4.7, §4.8): with sync on, every commit in a page
// writes the outbox and then asks the service worker for a round ("sync soon"), also when the outbox write fails (the
// save stands); with sync off, nothing of the kind; the worker's own runtime never asks itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { addEntry } from "../../src/core/vault/ops";
import { createRuntime, SYNC_SOON_MESSAGE } from "../../src/platform/runtime";
import { input, secretOf } from "../helpers/m2-world";
import { createProtected } from "../helpers/vaults";

function area(o: { failOn?: string } = {}) {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      if (o.failOn && o.failOn in items) throw new Error("IO error");
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

describe("the runtime's outbox and 'sync soon'", () => {
  let sent: unknown[];
  beforeEach(() => {
    sent = [];
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: async (m: unknown) => {
          sent.push(m);
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function profile(o: { sync: boolean; worker?: boolean; failOn?: string }) {
    const local = area(o.failOn ? { failOn: o.failOn } : {});
    const rt = createRuntime({
      local: local as unknown as chrome.storage.StorageArea,
      session: area() as unknown as chrome.storage.StorageArea,
      mirror: null,
      ...(o.worker ? { worker: true } : {}),
    });
    await createProtected(rt.service);
    if (o.sync) {
      // what turning sync on leaves (enough for the writer: the configuration's presence and lastSynced)
      local.data.set(SYNC_KEYS.cfg, { v: 1 });
      local.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 4, head: "h", checksum: "c" } });
    }
    sent.length = 0;
    return { rt, local };
  }
  const edit = (rt: ReturnType<typeof createRuntime>, name: string) =>
    rt.service.mutate((v, c, now) => addEntry(v, input(name, secretOf(name)), c, { now: () => now }).vault);

  it("sync off: an edit writes no outbox and asks for nothing", async () => {
    const { rt, local } = await profile({ sync: false });
    await edit(rt, "GitHub");
    expect(local.data.has(SYNC_KEYS.outbox)).toBe(false);
    expect(sent).toEqual([]);
  }, 60_000);

  it("sync on, in a page: the pushable outbox for the new generation, then one 'sync soon'", async () => {
    const { rt, local } = await profile({ sync: true });
    await edit(rt, "GitHub");
    expect(local.data.get(SYNC_KEYS.outbox)).toMatchObject({
      v: 1,
      base: 4,
      head: "h",
      from: { version: 4, head: "h", checksum: "c" },
    });
    expect(sent).toEqual([{ type: SYNC_SOON_MESSAGE }]);
    await rt.service.mutate((v) => v); // a save that changes nothing commits nothing new
    expect(sent).toHaveLength(1);
  }, 60_000);

  it("sync on, the outbox write failing: the save stands and the worker is still asked for a round", async () => {
    const { rt, local } = await profile({ sync: true, failOn: SYNC_KEYS.outbox });
    await edit(rt, "GitHub");
    expect(local.data.has(SYNC_KEYS.outbox)).toBe(false);
    expect((await rt.service.read()).vault.entries.map((e) => e.issuer)).toContain("GitHub");
    expect(sent).toEqual([{ type: SYNC_SOON_MESSAGE }]);
  }, 60_000);

  it("the worker's runtime writes the outbox but never asks itself", async () => {
    const { rt, local } = await profile({ sync: true, worker: true });
    await edit(rt, "GitHub");
    expect(local.data.get(SYNC_KEYS.outbox)).toMatchObject({ v: 1, base: 4 });
    expect(sent).toEqual([]);
  }, 60_000);
});
