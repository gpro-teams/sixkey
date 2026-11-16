// The grant store after a key change (src/core/plugins/store.ts): a read
// verifies under the current vault key only, and a previous key counts only inside the key-change cleanup, where the
// runtime's VkRecord (src/platform/runtime-base.ts) re-tags the record under the new key (GrantStore.reencrypt). Over a
// real runtime with fake storage areas: the rotation moves the record; a record rolled back to an older epoch, a damaged
// one or one under a key nobody holds is left as it is, and never holds the cleanup's marker up; a record tagged under a
// retired key later (a storage writer holding an old key) is refused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantKey, GRANTS_KEY, seal, type GrantRecord } from "../../src/core/plugins/grants";
import { createRuntime } from "../../src/platform/runtime";
import { MemoryKV, createMutex } from "../../src/core/storage/kv";
import { createProtected, NO_PAGE, STRONG } from "../helpers/vaults";
import { desc, OTHER, PID, TestGrantStore } from "../helpers/plugins";
import type { Vk } from "../../src/core/crypto/vk";

function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

beforeEach(() => vi.stubGlobal("chrome", { runtime: { sendMessage: async () => undefined } }));
afterEach(() => vi.unstubAllGlobals());

async function profile() {
  const local = area();
  const session = area();
  const rt = createRuntime({
    local: local as unknown as chrome.storage.StorageArea,
    session: session as unknown as chrome.storage.StorageArea,
    mirror: null,
  });
  await createProtected(rt.service);
  const { ChromeLocalKV } = await import("../../src/platform/chrome-kv");
  const store = new TestGrantStore({
    local: new ChromeLocalKV(local as unknown as chrome.storage.StorageArea),
    session: new ChromeLocalKV(session as unknown as chrome.storage.StorageArea),
    lock: createMutex(),
    entries: "all",
  });
  const keys = async () => (await rt.service.grantKeys())!;
  const cleanupDue = async () => {
    const v = await rt.store.loadView([]);
    return v.status === "ok" ? v.cleanup : "no vault";
  };
  return { rt, local, session, store, keys, cleanupDue };
}

describe("the plugin grants after a key change (§6.6 item 6)", () => {
  it("the rotation's cleanup re-tags the record under the new key; the old key no longer opens it", async () => {
    const p = await profile();
    const before = await p.keys();
    await p.store.approve(before, desc(PID), ["ui.slots", "env.read"]);
    const tagBefore = (p.local.data.get(GRANTS_KEY) as GrantRecord).tag;
    await p.rt.service.rotateKey(STRONG, NO_PAGE);
    expect(await p.cleanupDue()).toBe("none");
    const after = await p.keys();
    expect(after.vk.id).not.toBe(before.vk.id);
    const rec = p.local.data.get(GRANTS_KEY) as GrantRecord;
    expect(rec.tag).not.toBe(tagBefore);
    const v = await p.store.read(after);
    expect(v.ok && v.plugins.map((e) => e.pluginId)).toEqual([PID]);
    expect((await p.store.read(before)).ok).toBe(false); // the retired key is not the current one any more
  });

  it("a Settings write that raced the change (its key read before it) is refused and writes nothing (N2, wave 2a)", async () => {
    const p = await profile();
    const before = await p.keys();
    expect(before.activeVkId).toBeTypeOf("function"); // the service hands the check out with the key
    expect(await before.activeVkId!()).toBe(before.vk.id); // the service's own reading of the active key
    await p.store.approve(before, desc(PID), ["ui.slots", "env.read"]);
    await p.rt.service.rotateKey(STRONG, NO_PAGE);
    const tag = (p.local.data.get(GRANTS_KEY) as GrantRecord).tag;
    // the page's grantKeys() came before the change; its approval lands after the cleanup re-tagged the record
    expect(await before.activeVkId!()).not.toBe(before.vk.id);
    const { StaleKeyError, withFreshKeys } = await import("../../src/core/plugins/store");
    await expect(p.store.approve(before, desc(OTHER), ["ui.slots", "env.read"])).rejects.toBeInstanceOf(StaleKeyError);
    expect((p.local.data.get(GRANTS_KEY) as GrantRecord).tag).toBe(tag); // nothing written under the retired key
    expect(p.local.data.has("sk_plugins_unverified")).toBe(false);
    // what Settings does: once more with a fresh key, and the record verifies, both plugins in it
    let first = true;
    const get = async () => (first ? ((first = false), before) : p.keys());
    await expect(
      withFreshKeys(get, (k) => p.store.approve(k, desc(OTHER), ["ui.slots", "env.read"])),
    ).resolves.toBeDefined();
    const v = await p.store.read(await p.keys());
    expect(v.ok && v.plugins.map((e) => e.pluginId).sort()).toEqual([OTHER, PID].sort());
  });

  it("a record tagged under the retired key after the cleanup is refused: no previous key counts at a read", async () => {
    const p = await profile();
    const before = await p.keys();
    await p.store.approve(before, desc(PID), ["ui.slots", "env.read"]);
    await p.rt.service.rotateKey(STRONG, NO_PAGE);
    // a storage writer that holds the retired key forges a newer record under it
    const forged = await seal(await grantKey(before.vk.raw), {
      v: 1,
      epoch: 99,
      developerMode: false,
      plugins: [
        {
          pluginId: OTHER,
          state: "approved",
          descriptor: desc(OTHER),
          granted: ["ui.slots", "env.read"],
          approvedAt: 1,
          trashed: [],
        },
      ],
    });
    p.local.data.set(GRANTS_KEY, forged);
    const v = await p.store.read(await p.keys());
    expect(v.ok).toBe(false);
    expect(v.review.map((e) => e.pluginId)).toEqual([OTHER]); // listed for review, never honoured
  });

  it("a record rolled back to an older epoch before the cleanup is not re-tagged (and the cleanup finishes)", async () => {
    const p = await profile();
    const k = await p.keys();
    await p.store.approve(k, desc(PID), ["ui.slots", "env.read"]);
    const old = structuredClone(p.local.data.get(GRANTS_KEY)) as GrantRecord;
    await p.store.approve(k, desc(OTHER), ["ui.slots", "env.read"]); // the session's epoch moves past `old`
    p.local.data.set(GRANTS_KEY, old);
    await p.rt.service.rotateKey(STRONG, NO_PAGE);
    expect(await p.cleanupDue()).toBe("none");
    expect((p.local.data.get(GRANTS_KEY) as GrantRecord).tag).toBe(old.tag); // left as it was
    expect((await p.store.read(await p.keys())).ok).toBe(false);
  });

  it("a damaged record, or one no held key opens, never holds the cleanup's marker up", async () => {
    for (const junk of ["garbage", { v: 1, epoch: 1, developerMode: false, plugins: [], tag: "A".repeat(43) }]) {
      const p = await profile();
      p.local.data.set(GRANTS_KEY, junk);
      await p.rt.service.rotateKey(STRONG, NO_PAGE);
      expect(await p.cleanupDue(), JSON.stringify(junk)).toBe("none");
      expect(p.local.data.get(GRANTS_KEY)).toEqual(junk); // never wiped
    }
  });
});

describe("GrantStore.reencrypt (the VkRecord contract)", () => {
  const vk = async (fill: number): Promise<Vk> => {
    const { vkFromRaw } = await import("../../src/core/crypto/vk");
    return vkFromRaw(new Uint8Array(32).fill(fill));
  };
  function store() {
    const local = new MemoryKV();
    const session = new MemoryKV();
    return { local, session, s: new TestGrantStore({ local, session, lock: createMutex(), entries: "all" }) };
  }
  it("absent, current, rewritten, superseded, unopenable", async () => {
    const [a, b, c] = [await vk(1), await vk(2), await vk(3)];
    const w = store();
    expect(await w.s.reencrypt(b, [a], async () => b.id)).toBe("absent");
    await w.s.approve({ vk: a }, desc(PID), ["ui.slots"]);
    expect(await w.s.reencrypt(a, [], async () => a.id)).toBe("current");
    expect(await w.s.reencrypt(b, [a], async () => c.id)).toBe("superseded"); // a newer change's cleanup moves it
    expect(await w.s.reencrypt(b, [c], async () => b.id)).toBe("unopenable");
    expect(await w.s.reencrypt(b, [c, a], async () => b.id)).toBe("rewritten");
    expect((await w.s.read({ vk: b })).ok).toBe(true);
    expect(await w.s.reencrypt(b, [a], async () => b.id)).toBe("current");
  });
  it("the session's epoch is the rollback line: an older record under a held key stays unopenable", async () => {
    const [a, b] = [await vk(4), await vk(5)];
    const w = store();
    await w.s.approve({ vk: a }, desc(PID), ["ui.slots"]);
    const old = (await w.local.get([GRANTS_KEY]))[GRANTS_KEY];
    await w.s.approve({ vk: a }, desc(OTHER), ["ui.slots"]);
    await w.local.set({ [GRANTS_KEY]: old });
    expect(await w.s.reencrypt(b, [a], async () => b.id)).toBe("unopenable");
    expect((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]).toEqual(old);
  });
  it("a storage call that fails propagates (the cleanup keeps its marker)", async () => {
    const [a, b] = [await vk(6), await vk(7)];
    const w = store();
    await w.s.approve({ vk: a }, desc(PID), ["ui.slots"]);
    w.local.get = async () => {
      throw new Error("IO error");
    };
    await expect(w.s.reencrypt(b, [a], async () => b.id)).rejects.toThrow("IO error");
  });
});
