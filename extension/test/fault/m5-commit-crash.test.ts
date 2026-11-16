// A crash at every storage write of a popup edit with sync on, through the REAL runtime wiring
// (platform/runtime.ts: createRuntime's port with the outbox writer and "sync soon"), in "lock every time" (the
// worker never holds the key). After each crash the worker restarts and runs its locked round (status + outbox push),
// then the device is unlocked and syncs to quiescence. What must hold, whatever the step:
//   - an edit whose mutate resolved (the user was told it was saved) is in the local vault and, after the keyed rounds,
//     on the server;
//   - the locked push never puts on the server a state older than what it held, and never one without the saves the
//     server already had (no stale outbox overwrites newer data);
//   - after quiescence nothing is left behind: no outbox, no orphan entry, local = server.
// Modes (test/helpers/m3-crash.ts): "before" (the write never lands, the process dies), "after" (it lands, then the
// process dies), "lie" (acknowledged and dropped, the process goes on). The popup's runtime has no IndexedDB mirror here.
// Two scenarios: the crash on the first edit after a sync (the outbox is the crashing edit's or none), and the crash on
// a second edit while the first one's pushable outbox is still waiting (the stale-outbox case).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fromB64 } from "../../src/core/crypto/bytes";
import { decryptVault } from "../../src/core/crypto/envelope";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import type { MemoryKV } from "../../src/core/storage/kv";
import { StorageError } from "../../src/core/storage/store";
import { createRuntime } from "../../src/platform/runtime";
import { Dead, Proc, type Mode } from "../helpers/m3-crash";
import { cloneWorld, EMAIL, firstDevice, quiesce, World } from "../helpers/m3-world";
import { input, secretOf } from "../helpers/m2-world";

/** chrome.storage.local over a device's MemoryKV, dying at the Proc's step (ProcKV's rules, as a StorageArea). */
function procArea(kv: MemoryKV, p: Proc) {
  return {
    async get(keys?: string | string[] | null) {
      if (p.dead) throw new Dead();
      const ks = keys == null ? [...kv.data.keys()] : Array.isArray(keys) ? keys : [keys];
      return kv.get(ks);
    },
    async set(items: Record<string, unknown>) {
      const land = p.hit(`set ${Object.keys(items).join(",")}`);
      if (land) await kv.set(items);
      if (p.dead) throw new Dead();
    },
    async remove(keys: string | string[]) {
      const ks = Array.isArray(keys) ? keys : [keys];
      const land = p.hit(`remove ${ks.join(",")}`);
      if (land) await kv.remove(ks);
      if (p.dead) throw new Dead();
    },
  };
}
function memArea(init: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(init));
  return {
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

const issuers = (v: Vault) =>
  aliveEntries(v)
    .map((e) => e.issuer)
    .sort();

let base: World;
beforeAll(async () => {
  vi.stubGlobal("chrome", { runtime: { sendMessage: async () => undefined } });
  base = new World();
  base.clock.now = Date.now(); // the popup's runtime runs on the real clock (createRuntime takes none)
  const a = await firstDevice(base, ["GitHub"]);
  expect((await a.engine.round()).status).toBe("ok");
}, 120_000);
afterAll(() => vi.unstubAllGlobals());

async function run(k: number, mode: Mode, stale: boolean) {
  const w = cloneWorld(base);
  const a = w.devices[0]!;
  const keySession = { ...a.disk.session.data! };
  const vk = await vkFromRaw(fromB64(keySession.vk));
  const serverVault = async () => {
    const v = w.server.account(EMAIL).vault!;
    return { version: v.version, issuers: issuers(deserializeVault(await decryptVault(JSON.parse(v.envelope), vk))) };
  };
  const before = await serverVault();
  // the popup holds the key in its own memory ("lock every time"); the worker has none
  a.disk.session.data = null;
  const p = new Proc();
  const rt = createRuntime({
    local: procArea(a.disk.kv, p) as unknown as chrome.storage.StorageArea,
    session: memArea({
      sk_session: { ...keySession, lastActive: Date.now() },
      sk_lock_epoch: a.disk.session.epoch,
    }) as unknown as chrome.storage.StorageArea,
    mirror: null,
  });
  const edit = (name: string) =>
    rt.service.mutate((v, c, now) => addEntry(v, input(name, secretOf(name)), c, { now: () => now }).vault);
  if (stale) await edit("First"); // acknowledged; its pushable outbox waits for the worker
  const expectAlways = stale ? ["First", "GitHub"] : ["GitHub"];
  p.at = p.calls + k;
  p.mode = mode;
  let acked = false;
  try {
    await edit("Crash");
    acked = true;
  } catch (e) {
    if (!(e instanceof Dead) && !(e instanceof StorageError)) throw e; // StorageError: a lied slot write, refused on read-back
  }
  const reached = p.calls >= p.at; // false: the edit made fewer than k writes (this k is past the end)
  // a lie on the commit point itself (the pointer write acknowledged and dropped) is outside the store's fault model
  // (Phase 0: the pointer is not read back); there the save may be lost, everything else below must still hold
  const lieOnCommit = mode === "lie" && reached && (p.steps[p.at - 1] ?? "").includes("sk_active");
  // the worker restarts, without the key: its round is the locked one (the status and the outbox push)
  w.advance(1000);
  a.restartWorker();
  await a.engine.round();
  const mid = await serverVault();
  expect(mid.version).toBeGreaterThanOrEqual(before.version);
  for (const n of before.issuers) expect(mid.issuers, `k=${k} ${mode}: the push dropped ${n}`).toContain(n);
  if (mid.version > before.version) for (const n of expectAlways) expect(mid.issuers, `k=${k} ${mode}`).toContain(n);
  // unlocked: keyed rounds until nothing moves
  a.disk.session.data = { ...keySession, lastActive: w.clock.now };
  a.restartWorker();
  await quiesce(w, 8, [a]);
  const local = issuers(await a.vault());
  const server = await serverVault();
  for (const n of expectAlways) expect(local, `k=${k} ${mode}`).toContain(n);
  if (acked && !lieOnCommit) expect(local, `k=${k} ${mode}: an acknowledged save was lost`).toContain("Crash");
  expect(server.issuers, `k=${k} ${mode}`).toEqual(local);
  expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null, `k=${k} ${mode}`).toBeNull();
  const orphans = a.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: unknown[] } | undefined;
  expect(orphans?.items?.length ?? 0, `k=${k} ${mode}`).toBe(0);
  return { reached, acked, step: p.steps[p.at - 1] ?? "" };
}

describe("a crash at every write of a popup edit with sync on (the real runtime wiring)", () => {
  for (const stale of [false, true]) {
    it(
      stale ? "while an earlier edit's outbox waits" : "the first edit after a sync",
      async () => {
        const seen: string[] = [];
        for (const mode of ["before", "after", "lie"] as const) {
          for (let k = 1; k <= 20; k++) {
            const r = await run(k, mode, stale);
            if (!r.reached) break; // every write of the edit has been a crash point
            seen.push(`${mode}@${k}:${r.step}${r.acked ? " (acked)" : ""}`);
          }
        }
        if (process.env.SIXKEY_DEBUG) console.log(seen.join("\n"));
        // not vacuous: the commit point and the outbox write were both crash points
        expect(seen.some((s) => s.includes("sk_active"))).toBe(true);
        expect(seen.some((s) => s.includes(SYNC_KEYS.outbox))).toBe(true);
      },
      600_000,
    );
  }
});
