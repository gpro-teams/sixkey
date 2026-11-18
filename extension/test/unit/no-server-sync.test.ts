// The server sync's client is gone from the extension (DV-0b; OWNER-DECISIONS/25: its engine can be found in the history
// if it is ever needed; api/ and contract/ stay, for a possible paid cloud). Held here:
//   - the tree: none of the client's modules, its worker, bridge, transport, API origin and permission, its badge's
//     text, its pairing code, its tests' harness and live suite; no script and no source names its define or its API origin;
//     the build's graph guard names its paths to refuse them (test/unit/m5-build-guard.test.ts builds them back in);
//   - the one-time removal of what it left in a profile (src/platform/server-sync-leftovers.ts): exactly its six
//     records, its identity's database and its four alarms, nothing else; what is not there is not written; and the worker runs it at an
//     install or an update in the dev and e2e builds only (their define), never in the store or test builds, whose files
//     check-dist holds to none of its names (test/unit/m5-check-dist.test.ts has the mutant).
// check-dist's own rule (no API origin in any shipped file of any build) is test/unit/m5-check-dist.test.ts's.
import "fake-indexeddb/auto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryKV } from "../../src/core/storage/kv";
import {
  dropServerSyncLeftovers,
  SERVER_SYNC_ALARMS,
  SERVER_SYNC_IDENTITY_DB,
  SERVER_SYNC_KEYS,
  type DatabaseDeleter,
} from "../../src/platform/server-sync-leftovers";
import { loadWorker, unload, wait } from "../helpers/sw-world";

const EXT = resolve(__dirname, "../..");
function filesOf(dir: string, out: string[] = [], base = dir): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesOf(p, out, base);
    else
      out.push(
        p
          .slice(base.length + 1)
          .split("\\")
          .join("/"),
      );
  }
  return out;
}

describe("the tree has none of the server sync's client", () => {
  it("none of its files, its live suite or its tests' harness; no script that runs them", () => {
    for (const p of [
      "src/core/sync",
      "src/core/service/sync-flows.ts",
      "src/core/crypto/pairing-code.ts",
      "src/platform/sync-worker.ts",
      "src/platform/sync-engine.ts",
      "src/platform/bridge-page.ts",
      "src/platform/bridge-worker.ts",
      "src/platform/fetch-transport.ts",
      "src/platform/api-permission.ts",
      "src/platform/api-origin.ts",
      "scripts/api-origin.mjs",
      "scripts/api-origin.d.mts",
      "test/live",
      "vitest.live.config.ts",
      "test/e2e/sync-helpers.ts",
      "test/helpers/fake-server.ts",
      "test/helpers/m3-world.ts",
    ])
      expect(existsSync(join(EXT, p)), p).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(EXT, "package.json"), "utf8")).scripts)).not.toContain("test:live");
  });

  it("no source or script names its define, its API origin or its modules in code; the build's graph guard names their paths", () => {
    // comments may say what went (they do, with its history); code may not name it
    const code = (p: string, text: string) =>
      p.endsWith(".py")
        ? text.replace(/#.*$/gm, "")
        : text
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split("\n")
            .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
            .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
            .join("\n");
    const sources = [
      ...filesOf(join(EXT, "src")).map((p) => `src/${p}`),
      ...filesOf(join(EXT, "scripts")).map((p) => `scripts/${p}`),
    ]
      .filter((p) => /\.(?:ts|tsx|mjs|mts|py)$/.test(p))
      .map((p) => ({ p, text: code(p, readFileSync(join(EXT, p), "utf8")) }));
    expect(sources.length).toBeGreaterThan(100);
    const allowed: Record<string, string[]> = {
      // the build's graph guard names the paths it refuses
      "scripts/build.mjs": ["sync-flows", "sync-worker", "fetch-transport", "api-origin", "api-permission"],
      // check-dist refuses the API's addresses (GONE_API) and the sync badge's title (SYNC_BADGE_KEYS) in every shipped file
      "scripts/check-dist.mjs": ["api.sixkey.app", "127.0.0.1:8787", "syncBadgeTitle"],
    };
    for (const word of [
      "__SERVER_SYNC__",
      "__API_ORIGIN__",
      "api.sixkey.app",
      "127.0.0.1:8787",
      "core/sync/",
      "sync-flows",
      "sync-worker",
      "fetch-transport",
      "api-origin",
      "api-permission",
      "SyncPort",
      "SyncFlows",
      "keptVaultCount",
      "keptUnchecked",
      "syncBadgeTitle", // the sync badge's title (its text was a count); the badge's module itself may come back (DV-5)
      "syncText",
      "syncTitle",
    ])
      expect(
        sources.filter((f) => f.text.includes(word) && !(allowed[f.p] ?? []).includes(word)).map((f) => f.p),
        word,
      ).toEqual([]);
    const build = readFileSync(join(EXT, "scripts/build.mjs"), "utf8");
    const guard = build.slice(
      build.indexOf("const SYNC_SECTION_FORBIDDEN = ["),
      build.indexOf("function syncSectionGuard"),
    );
    for (const path of [
      "core[\\\\/]sync[\\\\/]/,",
      "sync-flows\\.ts$",
      "pairing-code\\.ts$",
      "(?:sync-worker|sync-engine|bridge-page|bridge-worker|fetch-transport|api-permission|api-origin)\\.ts$",
    ])
      expect(guard, path).toContain(path);
  });
});

describe("the removal of what it left in a profile (src/platform/server-sync-leftovers.ts)", () => {
  /** A KV that counts its calls. */
  class Counting extends MemoryKV {
    gets: string[][] = [];
    removes: string[][] = [];
    override async get(keys: string[]) {
      this.gets.push(keys);
      return super.get(keys);
    }
    override async remove(keys: string[]) {
      this.removes.push(keys);
      return super.remove(keys);
    }
  }
  const KEPT = {
    sk_pin: { v: 1 },
    sk_pin_restart: { v: 1 },
    sk_prf: { v: 1 },
    sk_csb_cfg: { on: true },
    sk_settings: { v: 1 },
    sk_slot_a: { v: 1 },
    sk_active: "a",
    sk_security_log: { v: 2, entries: [] },
  };
  const seed = (kv: MemoryKV, keys: readonly string[]) => {
    for (const [k, v] of Object.entries(KEPT)) kv.data.set(k, v);
    for (const k of keys) kv.data.set(k, { v: 1, left: k });
  };

  it("the six records, as the server sync named them", () => {
    expect([...SERVER_SYNC_KEYS]).toEqual([
      "sk_sync_cfg",
      "sk_sync_state",
      "sk_sync_staged",
      "sk_sync_outbox",
      "sk_sync_orphan",
      "sk_prejoin",
    ]);
    expect(SERVER_SYNC_IDENTITY_DB).toBe("sixkey-identity");
  });

  it("removes exactly those that are there, in one remove after one get, and says which; keeps everything else", async () => {
    const kv = new Counting();
    seed(kv, ["sk_sync_cfg", "sk_sync_orphan", "sk_prejoin"]);
    expect(await dropServerSyncLeftovers(kv)).toEqual({
      keys: ["sk_sync_cfg", "sk_sync_orphan", "sk_prejoin"],
      alarms: [],
    });
    expect(kv.gets).toEqual([[...SERVER_SYNC_KEYS]]);
    expect(kv.removes).toEqual([["sk_sync_cfg", "sk_sync_orphan", "sk_prejoin"]]);
    expect(Object.fromEntries(kv.data)).toEqual(KEPT); // the PIN's, the device unlock's, the backup's, the vault's
  });

  it("with none there (every store and test profile, a second run): one get, nothing removed or written", async () => {
    const kv = new Counting();
    seed(kv, []);
    const before = JSON.stringify([...kv.data]);
    expect(await dropServerSyncLeftovers(kv)).toEqual({ keys: [], alarms: [] });
    expect(await dropServerSyncLeftovers(kv)).toEqual({ keys: [], alarms: [] });
    expect(kv.gets).toHaveLength(2);
    expect(kv.removes).toEqual([]);
    expect(JSON.stringify([...kv.data])).toBe(before);
  });

  it("all six, then none: the second run finds nothing", async () => {
    const kv = new Counting();
    seed(kv, SERVER_SYNC_KEYS);
    expect(await dropServerSyncLeftovers(kv)).toEqual({ keys: [...SERVER_SYNC_KEYS], alarms: [] });
    expect(await dropServerSyncLeftovers(kv)).toEqual({ keys: [], alarms: [] });
    expect(kv.removes).toHaveLength(1);
  });

  it("a read that throws propagates and removes nothing (the next update tries again)", async () => {
    const kv = new Counting();
    seed(kv, ["sk_sync_cfg"]);
    kv.get = async () => {
      throw new Error("IO error");
    };
    await expect(dropServerSyncLeftovers(kv)).rejects.toThrow("IO error");
    expect(kv.data.has("sk_sync_cfg")).toBe(true);
  });

  it("deletes the identity's database, and only it; a database that is not there, blocked or failing settles too", async () => {
    // the real thing (fake-indexeddb): the identity's database and the mirror's, then the identity's is gone
    for (const name of [SERVER_SYNC_IDENTITY_DB, "sixkey-mirror"])
      await new Promise<void>((ok, err) => {
        const r = indexedDB.open(name, 1);
        r.onsuccess = () => (r.result.close(), ok());
        r.onerror = () => err(r.error);
      });
    await dropServerSyncLeftovers(new MemoryKV(), indexedDB);
    const names = (await indexedDB.databases()).map((d) => d.name).sort();
    expect(names).toContain("sixkey-mirror");
    expect(names).not.toContain(SERVER_SYNC_IDENTITY_DB);
    await dropServerSyncLeftovers(new MemoryKV(), indexedDB); // not there any more: still settles
    // each way a delete can end, and a factory that throws: the call settles, and asks for that one name
    for (const end of ["onsuccess", "onerror", "onblocked", "throw"] as const) {
      const asked: string[] = [];
      const idb: DatabaseDeleter = {
        deleteDatabase: (name: string) => {
          asked.push(name);
          if (end === "throw") throw new Error("SecurityError");
          const req = {} as IDBOpenDBRequest;
          setTimeout(() => (req[end] as ((e: Event) => void) | null)?.(new Event(end.slice(2))), 1);
          return req;
        },
      };
      await expect(dropServerSyncLeftovers(new MemoryKV(), idb), end).resolves.toEqual({ keys: [], alarms: [] });
      expect(asked, end).toEqual([SERVER_SYNC_IDENTITY_DB]);
    }
  });

  it("clears its four alarms, and only those; one that is not there is not listed, and a clear that fails settles", async () => {
    expect([...SERVER_SYNC_ALARMS]).toEqual(["sk-sync-sync", "sk-sync-kick", "sk-sync-retry", "sk-sync-periodic"]);
    const set = new Set(["sk-sync-periodic", "sk-sync-retry", "sk-daily", "sk-csb-soon", "sk-autolock"]);
    const asked: string[] = [];
    const alarms = {
      clear: async (name: string) => {
        asked.push(name);
        if (name === "sk-sync-kick") throw new Error("no alarms here");
        return set.delete(name);
      },
    };
    expect(await dropServerSyncLeftovers(new MemoryKV(), undefined, alarms)).toEqual({
      keys: [],
      alarms: ["sk-sync-retry", "sk-sync-periodic"],
    });
    expect(asked).toEqual([...SERVER_SYNC_ALARMS]); // asked for its own four, nothing else
    expect([...set].sort()).toEqual(["sk-autolock", "sk-csb-soon", "sk-daily"]);
  });
});

describe("the worker runs it once at an install or an update, in the dev and e2e builds only", () => {
  afterEach(unload);
  const left = Object.fromEntries(SERVER_SYNC_KEYS.map((k) => [k, { v: 1, left: k }]));
  const lines = (w: { local: { data: Map<string, unknown> } }) =>
    ((w.local.data.get("sk_diag") ?? []) as { message: string }[]).map((d) => d.message);

  it("a dev or e2e build (the define true): an install or an update removes them, writes one diagnostics line, keeps the rest", async () => {
    const w = await loadWorker({ dev: true, seedLocal: { ...left, sk_pin: { v: 1 } } });
    await wait();
    for (const name of ["sk-sync-periodic", "sk-sync-retry", "another-alarm"])
      w.alarms.set(name, { periodInMinutes: 30 });
    expect(SERVER_SYNC_KEYS.filter((k) => w.local.data.has(k))).toEqual([...SERVER_SYNC_KEYS]); // a start alone: nothing
    for (const l of w.listeners.startup!) l();
    await wait();
    expect(SERVER_SYNC_KEYS.filter((k) => w.local.data.has(k))).toEqual([...SERVER_SYNC_KEYS]); // nor a browser start
    for (const l of w.listeners.installed!) l({ reason: "update" });
    await wait(200);
    expect(SERVER_SYNC_KEYS.filter((k) => w.local.data.has(k))).toEqual([]);
    expect(w.local.data.get("sk_pin")).toEqual({ v: 1 });
    expect([...w.alarms.keys()].filter((n) => n.startsWith("sk-sync-"))).toEqual([]);
    expect(w.alarms.has("another-alarm")).toBe(true); // nothing but its four
    const ours = () => lines(w).filter((l) => l.startsWith("the server sync's"));
    expect(ours()).toEqual([
      `the server sync's leftovers removed: ${[...SERVER_SYNC_KEYS, "sk-sync-retry", "sk-sync-periodic"].join(", ")}`,
    ]);
    // a second update finds nothing, and writes no second line
    for (const l of w.listeners.installed!) l({ reason: "update" });
    await wait(200);
    expect(ours()).toHaveLength(1);
  });

  it("the store and test builds (the define false) and a bare module (no define): an install or an update leaves them", async () => {
    for (const dev of [false, undefined]) {
      const w = await loadWorker(dev === undefined ? { seedLocal: left } : { dev, seedLocal: left });
      await wait();
      w.alarms.set("sk-sync-periodic", { periodInMinutes: 30 });
      for (const l of w.listeners.installed!) l({ reason: "update" });
      await wait(200);
      expect(
        SERVER_SYNC_KEYS.filter((k) => w.local.data.has(k)),
        `dev=${dev}`,
      ).toEqual([...SERVER_SYNC_KEYS]);
      expect(w.local.reads.flat().filter((k) => (SERVER_SYNC_KEYS as readonly string[]).includes(k))).toEqual([]);
      expect(w.alarms.has("sk-sync-periodic"), `dev=${dev}`).toBe(true);
      unload();
    }
  });

  it("the worker's code calls it only there, behind the define", () => {
    const sw = readFileSync(join(EXT, "src/background/sw.ts"), "utf8");
    expect(sw.match(/dropServerSyncLeftovers\(/g)).toHaveLength(1);
    const at = sw.indexOf("dropServerSyncLeftovers(rt.local");
    const before = sw.slice(sw.lastIndexOf("chrome.runtime.onInstalled.addListener(", at), at);
    expect(before).toMatch(/if \(typeof __SYNC_DEV__ === "boolean" && __SYNC_DEV__\)\s*void $/);
  });
});
