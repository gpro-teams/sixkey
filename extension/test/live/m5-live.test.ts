// The sync engine against the real API server (SYNC-DESIGN §8.5, §9 M5): the scenarios M5 must show working end to end,
// each run twice, against the real server (api/server, a private database, the extension's own fetch transport in Node)
// and against the FakeServer, with the same expectations. Run: npm run test:live (docs/design/notes/M5-NOTES.md says what it needs).
//   - join and sync between two devices;
//   - a rotation racing another device's write;
//   - a rotation whose answer is lost, retried later with the same handle;
//   - the kill switch (min_client_version) raised between preparing and committing a rotation and a new recovery code;
//   - a sustained outage (503 with Retry-After): every failure counts, the gaps grow, a restarted worker keeps waiting;
//   - an outbox and a torn active slot in a context without the key: the orphan entry pushed, and folded back;
//   - a worker restart in identity_missing: nothing signed, the stored server offset kept; restored once unlocked.
// The real server is the unmodified M4 server with its default limits; this file starts its own (server.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEYS } from "../../src/core/storage/format";
import { unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import { SyncEngine } from "../../src/core/sync/engine/engine";
import {
  adoptWithSecret,
  commitRecoveryCode,
  commitRotation,
  prepareRecoveryCode,
  prepareRotation,
} from "../../src/core/sync/engine/keys";
import type { Scheduler, Wake, WakeName } from "../../src/core/sync/engine/schedule";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { openRemote } from "../../src/core/sync/engine/remote";
import { aliveEntries } from "../../src/core/vault/model";
import { fakeBackend, liveBackend, LiveWorld, stateOf, type Backend, type LiveDevice } from "./live";
import { startLiveServer, type LiveServer } from "./server";

let server: LiveServer;
const backends: Record<"live" | "fake", Backend> = {} as Record<"live" | "fake", Backend>;
beforeAll(async () => {
  server = await startLiveServer();
  backends.live = liveBackend(server);
  backends.fake = fakeBackend(server.origin);
}, 120_000);
afterAll(async () => {
  await server?.stop();
});

/** The server's head vault, opened with `d`'s key: its live issuers. */
async function serverIssuers(d: LiveDevice): Promise<string[]> {
  const head = await d.engine.api.getVault({
    kind: "device",
    deviceId: (await d.identity()).deviceId,
    key: (await d.identity()).keyPair.privateKey,
  });
  const opened = await openRemote(head.envelope, await d.vk(), (await d.generation()).keyring.vaultId);
  if (opened.kind !== "ok") throw new Error(`head: ${opened.kind}`);
  return aliveEntries(opened.vault)
    .map((e) => e.issuer)
    .sort();
}

for (const kind of ["live", "fake"] as const) {
  describe(`${kind}: the M5 scenarios`, () => {
    const world = (tag: string) => new LiveWorld(backends[kind], `${kind}-${tag}`);

    it("two devices join and sync: edits on each reach the other and the server's head", async () => {
      const w = world("join");
      const a = await w.first(["GitHub", "AWS"]);
      const b = await w.join("B");
      await w.quiesce();
      await a.add("From A");
      await b.add("From B");
      await w.quiesce();
      const all = ["AWS", "From A", "From B", "GitHub"];
      expect(await a.issuers()).toEqual(all);
      expect(await b.issuers()).toEqual(all);
      expect(await serverIssuers(a)).toEqual(all);
      expect(w.wire.filter((e) => typeof e.status === "number" && e.status >= 400)).toEqual([]);
    }, 240_000);

    it("a rotation racing another device's write: the rotation's 409 merges the write and sends the same new key again; the other device adopts it with the password", async () => {
      const w = world("race");
      const a = await w.first(["GitHub"]);
      const b = await w.join("B");
      await w.quiesce();
      const h = await prepareRotation(a.engine, w.password);
      a.net.beforeOnce("POST /v1/keys/rotate", async () => {
        await b.add("During the rotation");
        expect((await b.round()).uploaded).toBe(true);
      });
      await commitRotation(a.engine, h);
      expect(w.wire.filter((e) => e.op === "POST /v1/keys/rotate").map((e) => [e.status, e.code])).toEqual([
        [409, "version_conflict"],
        [200, undefined],
      ]);
      const vk2 = await a.vk();
      expect((await a.generation()).keyring.vkId).toBe(vk2.id);
      expect(await serverIssuers(a)).toEqual(["During the rotation", "GitHub"]);
      // B: the server is on a key it does not hold yet; the password adopts it (§3.9 R3/R4), nothing is lost
      expect((await b.round()).status).toBe("needs_password");
      expect((await adoptWithSecret(b.engine, { password: w.password })).kind).toBe("adopted");
      await w.quiesce();
      expect(await b.issuers()).toEqual(["During the rotation", "GitHub"]);
      expect((await b.generation()).keyring.vkId).toBe(vk2.id);
      // the new recovery code opens the new keyring
      expect((await unlockWithRecoveryCode((await a.generation()).keyring, h.recoveryCode)).id).toBe(vk2.id);
    }, 240_000);

    it("a rotation whose answer is lost, and whose reconciliation cannot reach the server: unconfirmed; retried with the same handle, found in effect and committed", async () => {
      const w = world("lost");
      const a = await w.first(["GitHub"]);
      await a.round();
      const h = await prepareRotation(a.engine, w.password);
      const vk1 = (await a.generation()).keyring.vkId;
      a.net.dropAnswerOnce("POST /v1/keys/rotate");
      a.net.failOnce("GET /v1/keys");
      await expect(commitRotation(a.engine, h)).rejects.toMatchObject({ code: "unconfirmed" });
      expect((await a.generation()).keyring.vkId).toBe(vk1); // nothing committed here yet: the server may hold it
      const sent = w.count("POST /v1/keys/rotate");
      await commitRotation(a.engine, h); // the same handle: the status shows the keys moved, GET /v1/keys says it is ours
      expect(w.count("POST /v1/keys/rotate")).toBe(sent); // not sent again: reconciled
      const vk2 = (await a.generation()).keyring.vkId;
      expect(vk2).not.toBe(vk1);
      expect(
        (
          await a.engine.api.status({
            kind: "device",
            deviceId: (await a.identity()).deviceId,
            key: (await a.identity()).keyPair.privateKey,
          })
        ).vk_id,
      ).toBe(vk2);
      expect((await unlockWithRecoveryCode((await a.generation()).keyring, h.recoveryCode)).id).toBe(vk2);
      expect((await a.round()).status).toBe("ok");
    }, 240_000);

    it("the kill switch raised between prepare and commit: neither the rotation nor the new recovery code is sent; lowered again, the same handles commit", async () => {
      const w = world("kill");
      const a = await w.first(["GitHub"]);
      await a.round();
      try {
        const rot = await prepareRotation(a.engine, w.password);
        const code = await prepareRecoveryCode(a.engine, w.password);
        await w.backend.setMinimum("9.0.0");
        const n0 = w.wire.length;
        await expect(commitRotation(a.engine, rot)).rejects.toMatchObject({ code: "update_required" });
        await expect(commitRecoveryCode(a.engine, code)).rejects.toMatchObject({ code: "update_required" });
        expect(w.wire.slice(n0).map((e) => e.op)).toEqual(["GET /v1/sync/status", "GET /v1/sync/status"]); // only asked, never sent
        expect((await a.round()).status).toBe("update_required");
        await w.backend.setMinimum("0.1.0");
        await commitRecoveryCode(a.engine, code);
        expect(w.count("PUT /v1/keys", 200)).toBe(1);
        expect((await unlockWithRecoveryCode((await a.generation()).keyring, code.recoveryCode)).id).toBe(
          (await a.generation()).keyring.vkId,
        );
      } finally {
        await w.backend.setMinimum("0.1.0");
      }
    }, 240_000);

    it("a sustained outage (503, Retry-After 5): every failure counts and the gaps grow; a wake in a backoff sends nothing, a restarted worker waits for the stored end; then it recovers", async () => {
      const w = world("outage");
      const a = await w.first(["GitHub"]);
      await a.round();
      const wakes: { name: WakeName; wake: Wake }[] = [];
      const scheduler: Scheduler = { schedule: (name, wake) => wakes.push({ name, wake }), cancel: () => undefined };
      await w.backend.outage(true);
      try {
        await a.add("During the outage");
        const gaps: number[] = [];
        for (let i = 1; i <= 4; i++) {
          const r = await a.round({ explicit: true }); // the user's "sync now": it runs inside a backoff, and still counts
          expect(r).toMatchObject({ status: "error", error: "unavailable" });
          const s = stateOf(a)!;
          expect(s.failures).toBe(i);
          gaps.push(s.backoffUntil! - Date.now());
        }
        for (const g of gaps) expect(g).toBeGreaterThanOrEqual(4_000); // Retry-After (5 s) is the floor
        for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
        // a timer or alarm inside the backoff: nothing sent; a worker restart: start() schedules at the stored end
        const sent = w.wire.length;
        expect((await a.engine.wake("sync")).pulled).toBe(false);
        a.restartWorker();
        const restarted = new SyncEngine({ ...a.engine.deps, scheduler }); // a new worker's engine over the same storage
        await restarted.start();
        await restarted.wake("retry");
        expect(w.wire.length).toBe(sent);
        expect(wakes.length).toBeGreaterThan(0);
        for (const x of wakes) expect(x.wake.at).toBeGreaterThanOrEqual(stateOf(a)!.backoffUntil!);
      } finally {
        await w.backend.outage(false);
      }
      for (let i = 0; i < 20 && (await a.round({ explicit: true })).status !== "ok"; i++)
        await new Promise((r) => setTimeout(r, 500));
      expect(stateOf(a)).toMatchObject({ status: "ok", failures: 0, backoffUntil: null });
      expect(await serverIssuers(a)).toEqual(["During the outage", "GitHub"]);
    }, 240_000);

    it("an outbox and a torn active slot with no key in this context ('lock every time'): the worker's round pushes the orphan entry; unlocked, the save is in the vault again", async () => {
      const w = world("torn");
      const a = await w.first(["GitHub"]);
      const b = await w.join("B");
      await w.quiesce();
      await a.add("The last save");
      expect(a.kv.data.get(SYNC_KEYS.outbox)).toMatchObject({ v: 1 }); // the pushable outbox, written at the commit
      await a.restartBrowser(); // no key in this context any more
      const ptr = a.kv.data.get(KEYS.active) as "a" | "b";
      a.kv.data.set(KEYS.slot[ptr], { torn: true }); // the active slot damaged on disk
      const r = await a.round(); // the worker's round: the load recovers the older slot, its hook keeps the outbox as an orphan entry
      expect(r).toMatchObject({ status: "locked", pushedOutbox: true });
      expect(w.count("PUT /v1/vault", 200)).toBeGreaterThan(0);
      expect(a.kv.data.get(SYNC_KEYS.orphan) ?? null).toBeNull(); // retired by its push (the list is empty)
      expect((await b.round()).pulled).toBe(true);
      expect(await b.issuers()).toEqual(["GitHub", "The last save"]);
      await a.unlock();
      await w.quiesce();
      expect(await a.issuers()).toEqual(["GitHub", "The last save"]);
    }, 240_000);

    it("a worker restart in identity_missing: locked, nothing is signed and the stored server offset stays; unlocked, the identity is restored with the same device id", async () => {
      const w = world("idmissing");
      await w.first(["GitHub"]);
      const b = await w.join("B");
      await w.quiesce();
      const id0 = (await b.identity()).deviceId;
      const st = b.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
      b.kv.data.set(SYNC_KEYS.state, { ...st, serverOffsetMs: 90_000 }); // an offset learned earlier, recognisable
      await b.restartBrowser(); // locked
      b.idb.data.clear(); // the identity's IndexedDB gone
      const n0 = w.wire.length;
      expect((await b.round()).status).toBe("identity_missing");
      expect(w.wire.length).toBe(n0);
      expect(stateOf(b)!.serverOffsetMs).toBe(90_000);
      await b.unlock();
      expect((await b.round()).status).toBe("ok");
      expect((await b.identity()).deviceId).toBe(id0);
      expect(Math.abs(stateOf(b)!.serverOffsetMs!)).toBeLessThan(5_000); // learned again from the real answer
      const a = w.devices[0]!;
      const list = await a.engine.api.devices({
        kind: "device",
        deviceId: (await a.identity()).deviceId,
        key: (await a.identity()).keyPair.privateKey,
      });
      expect(list.devices.filter((d) => d.revoked_at === null).length).toBe(2); // no new device row
    }, 240_000);
  });
}
