import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore } from "../../src/core/service/types";
import { ChromeLocalKV } from "../../src/platform/chrome-kv";
import { createDiagLogger, readDiag } from "../../src/platform/diag";
import { IdbKV } from "../../src/platform/idb-kv";
import { webLock } from "../../src/platform/locks";
import { ChromeSessionCache } from "../../src/platform/session";
import { addEntry } from "../../src/core/vault/ops";
import { createProtected } from "../helpers/vaults";

/** The slice of chrome.storage.StorageArea the adapters use, with the real API's behaviour (get(null) returns everything). */
function fakeArea() {
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

const impls: [string, () => KV][] = [
  ["MemoryKV", () => new MemoryKV()],
  ["ChromeLocalKV", () => new ChromeLocalKV(fakeArea() as unknown as chrome.storage.StorageArea)],
  ["IdbKV", () => new IdbKV(`t${Math.random()}`, new IDBFactory())],
];

for (const [name, make] of impls) {
  describe(`KV contract: ${name}`, () => {
    it("get returns only present keys; set overwrites; remove deletes; keys lists", async () => {
      const kv = make();
      expect(await kv.get(["a", "b"])).toEqual({});
      await kv.set({ a: 1, b: { x: [1, 2, { y: "z" }] } });
      expect(await kv.get(["a", "b", "c"])).toEqual({ a: 1, b: { x: [1, 2, { y: "z" }] } });
      await kv.set({ a: 2 });
      expect((await kv.get(["a"])).a).toBe(2);
      expect((await kv.keys()).sort()).toEqual(["a", "b"]);
      await kv.remove(["a", "missing"]);
      expect(await kv.get(["a", "b"])).toEqual({ b: { x: [1, 2, { y: "z" }] } });
      expect(await kv.keys()).toEqual(["b"]);
    });
    it("values are copies, not references", async () => {
      const kv = make();
      const v = { n: [1] };
      await kv.set({ v });
      v.n.push(2);
      expect((await kv.get(["v"])).v).toEqual({ n: [1] });
    });
    it("stores null and empty-string values", async () => {
      const kv = make();
      await kv.set({ n: null, e: "" });
      expect(await kv.get(["n", "e"])).toEqual({ n: null, e: "" });
    });
    it("holds up under many concurrent writers", async () => {
      const kv = make();
      await Promise.all(Array.from({ length: 40 }, (_, i) => kv.set({ [`k${i}`]: i })));
      expect((await kv.keys()).length).toBe(40);
      expect((await kv.get(["k7"])).k7).toBe(7);
    });
  });
}

describe("the real store on the real adapters", () => {
  it("runs a full service session over ChromeLocalKV + IdbKV mirror, and recovers from the mirror after the primary is wiped", async () => {
    const area = fakeArea();
    const local = new ChromeLocalKV(area as unknown as chrome.storage.StorageArea);
    const mirror = new IdbKV("mirror-test", new IDBFactory());
    const sessionArea = fakeArea();
    const session = new ChromeSessionCache(sessionArea as unknown as chrome.storage.StorageArea);
    const mk = () =>
      new VaultService({
        store: new VaultStore({ kv: local, mirror, lock: webLock("t") }),
        session,
        settings: new KvSettingsStore(local),
      });
    const svc = mk();
    await createProtected(svc);
    await svc.mutate(
      (v, c) =>
        addEntry(
          v,
          {
            type: "totp",
            issuer: "GitHub",
            label: "a",
            secret: "JBSWY3DPEHPK3PXP",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          },
          c,
        ).vault,
    );
    area.data.clear(); // the browser lost the extension's local storage
    const after = mk();
    const st = await after.status();
    expect(st.state).toBe("unlocked");
    expect((await after.read()).vault.entries).toHaveLength(1);
    expect((st as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual(["mirror_restore"]);
  });
});

describe("session cache", () => {
  it("round-trips, clears, and ignores junk", async () => {
    const area = fakeArea();
    const s = new ChromeSessionCache(area as unknown as chrome.storage.StorageArea);
    expect(await s.get()).toBeNull();
    await s.set({ vk: "abc", lastActive: 5 });
    expect(await s.get()).toEqual({ vk: "abc", lastActive: 5 });
    await s.clear();
    expect(await s.get()).toBeNull();
    area.data.set("sk_session", { vk: 5 });
    expect(await s.get()).toBeNull();
  });
});

describe("diagnostics log", () => {
  it("keeps the newest 50 entries and records error class, not text", async () => {
    const kv = new MemoryKV();
    const log = createDiagLogger(kv, () => 1);
    for (let i = 0; i < 60; i++)
      log(`m${i}`, Object.assign(new Error("secret text JBSWY3DP"), { code: "verify_failed" }));
    await new Promise((r) => setTimeout(r, 50));
    const d = await readDiag(kv);
    expect(d.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(d)).not.toContain("JBSWY3DP");
    expect(d.at(-1)).toMatchObject({ error: "verify_failed" });
  });
});

describe("web lock", () => {
  it("falls back to a mutex and serialises", async () => {
    const lock = webLock("x");
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        lock(async () => {
          await new Promise((r) => setTimeout(r, 10 - n * 2));
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });
});
