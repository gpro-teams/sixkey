// M3, SYNC-DESIGN §8.2's named scenarios through the engine and the FakeServer: a storage recovery before an edit (F3,
// D1), the outbox against a recovery and two pages (D2), server rollbacks (F4, D5), clocks two days off (F5, S3), a bad
// head and a newer schema (F6a, R6), big merges (F15, D7, D3), "lock every time" (P10), HOTP (§4.12), joins onto local
// data (§3.5), the guard (§4.4), and the repair of a rolled-back bundle (N24/N27).
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { generateVk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { MemorySession } from "../../src/core/service/types";
import { tear } from "../helpers/faulty-kv";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { parseOutbox } from "../../src/core/sync/local/outbox";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { totpOffset } from "../../src/core/sync/engine/clock";
import { headOf } from "../../src/core/sync/engine/state";
import { FakeServer } from "../helpers/fake-server";
import { commitJoin, joinSummary, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import { repairKeys } from "../../src/core/sync/engine/keys";
import { mergeVaults } from "../../src/core/vault/merge";
import { aliveEntries, emptyVault, isAlive, isPurged, trashEntries, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, editEntry, purgeEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";
import { input } from "../helpers/m2-world";
import {
  bulkEntries,
  cj,
  contextOver,
  Device,
  EMAIL,
  firstDevice,
  joinDevice,
  quiesce,
  World,
  worldOf,
} from "../helpers/m3-world";

const puts = (w: World) => w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;
const issuers = (v: Vault) =>
  aliveEntries(v)
    .map((e) => e.issuer)
    .sort();
const two = async (names?: string[]) => {
  const w = await worldOf(2, names);
  return { w, a: w.devices[0]!, b: w.devices[1]! };
};

describe("F3/D1: a storage recovery, then an edit", () => {
  it("the recovered (older) local state is merged, never uploaded over the newer server head; the new edit goes up; nothing is lost", async () => {
    const { w, a, b } = await two(["GitHub"]);
    w.advance(1000);
    await a.add("synced-on-A");
    await a.engine.round(); // the server and A have it
    await b.engine.round();
    // A's active slot breaks: the store falls back to the other slot, one generation older (without "synced-on-A")
    const ptr = a.disk.kv.data.get(KEYS.active) as "a" | "b";
    a.disk.kv.data.set(KEYS.slot[ptr], tear(a.disk.kv.data.get(KEYS.slot[ptr])));
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull();
    a.restartWorker();
    const st = await a.svc.status(); // the recovery runs (and its hook clears lastSynced)
    expect(st.state).toBe("unlocked");
    expect(issuers(await a.vault())).toEqual(["GitHub"]);
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toBeNull();
    await a.svc.ackEvents(); // the user dismissed the "restored" notice before any round ran
    w.advance(1000);
    await a.add("after-recovery");
    await a.engine.round();
    await quiesce(w);
    expect(issuers(await b.vault())).toEqual(["GitHub", "after-recovery", "synced-on-A"]);
    expect(cj(await a.vault())).toBe(cj(await b.vault()));
  });
});

describe("D2: the outbox against a recovery and two pages", () => {
  it("a recovery between the commit and the push: the push does not bring lastSynced back (the hook cleared it), the next round merges", async () => {
    const { w, a, b } = await two(["GitHub"]);
    w.advance(1000);
    await a.add("in outbox");
    const ob = parseOutbox(a.disk.kv.data.get(SYNC_KEYS.outbox))!;
    expect(ob).not.toBeNull();
    // a recovery write happens (here: the store's hook as the recovery calls it), then the outbox is pushed by a stale copy
    await a.ctx.port.clearLastSynced();
    a.disk.kv.data.set(SYNC_KEYS.outbox, ob); // as if an older context still held it: the CAS must still refuse to revive lastSynced
    await a.lockNow();
    await a.engine.round();
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toBeNull();
    await a.unlock();
    await quiesce(w);
    expect(issuers(await b.vault())).toEqual(["GitHub", "in outbox"]);
  });
  it("two pages commit one after the other: the outbox always holds the newest generation (same lock)", async () => {
    const { w, a } = await two(["GitHub"]);
    const popup = contextOver({
      ...a.disk,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: a.net,
      clock: a.now,
    });
    const page = contextOver({
      ...a.disk,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: a.net,
      clock: a.now,
    });
    w.advance(1000);
    await Promise.all([
      popup.svc.mutate((v, c) => addEntry(v, input("from popup"), c).vault),
      page.svc.mutate((v, c) => addEntry(v, input("from page"), c).vault),
    ]);
    const ob = parseOutbox(a.disk.kv.data.get(SYNC_KEYS.outbox))!;
    expect(ob.checksum).toBe((await a.generation()).envelope.checksum);
  });
});

describe("F4/D5: server rollbacks", () => {
  it("the server goes back 3 versions (PITR): pull, a one-time warning, merge, upload; no 409 loop; nothing lost", async () => {
    const { w, a, b } = await two(["GitHub"]);
    const snap = w.server.snapshot();
    for (const n of ["x1", "x2", "x3"]) {
      w.advance(1000);
      await a.add(n);
      await a.engine.round();
    }
    await b.engine.round();
    w.server.restore(snap); // back to before x1–x3
    const r = await a.engine.round();
    expect(r.status).toBe("ok");
    expect(r.uploaded).toBe(true);
    const view = await a.engine.view();
    expect(view.state.notices?.some((n) => n.kind === "rollback")).toBe(true);
    await quiesce(w);
    expect(issuers(await b.vault())).toEqual(["GitHub", "x1", "x2", "x3"]);
    expect(w.server.requests.filter((q) => q.op === "PUT /v1/vault" && q.status === 409).length).toBeLessThanOrEqual(2);
  });
  it("D5: after a rollback another device reuses the same version number with other content; this device pulls because the head differs", async () => {
    const { w, a, b } = await two(["GitHub"]);
    w.advance(1000);
    await a.add("A only");
    await a.engine.round(); // version n+1, A in sync with it
    const before = w.server.account(EMAIL).vault!;
    // roll back one version (PITR), then B writes its own version with the same number
    const s = w.server.snapshot();
    const acct = Object.values(s.accounts).find((x) => x.vault)!;
    const prev = acct.history[acct.history.length - 2]!;
    acct.vault = { ...acct.vault!, version: prev.version, envelope: prev.envelope, head: await headOf(prev.envelope) };
    acct.history = acct.history.slice(0, -1);
    w.server.restore(s);
    w.advance(1000);
    await b.add("B only");
    await b.engine.round();
    const reused = w.server.account(EMAIL).vault!;
    expect(reused.version).toBe(before.version); // the same number…
    expect(reused.head).not.toBe(before.head); // …other content
    const r = await a.engine.round();
    expect(r.pulled).toBe(true);
    await quiesce(w);
    expect(issuers(await a.vault())).toEqual(["A only", "B only", "GitHub"]);
    expect(cj(await a.vault())).toBe(cj(await b.vault()));
  });
});

describe("F5/S3: clocks two days off", () => {
  it("a device 2 days fast and one 2 days slow: after an edit each uploads at most once, the other commits at most once, then it is quiet", async () => {
    const DAY = 86_400_000;
    const w = await worldOf(3, ["GitHub"], [0, 2 * DAY, -2 * DAY]);
    const [a, fast, slow] = w.devices as [Device, Device, Device];
    await quiesce(w);
    for (const d of [fast, slow])
      expect(Math.abs((await d.engine.view()).offsetMs + (d === fast ? 2 * DAY : -2 * DAY))).toBeLessThan(5000);
    const p0 = puts(w);
    w.advance(1000);
    const id = aliveEntries(await fast.vault())[0]!.id;
    await fast.svc.mutate((v, c) => editEntry(v, id, { label: "edited fast" }, c));
    await quiesce(w);
    expect(puts(w) - p0).toBe(1); // only the edit itself, no ping-pong
    expect(aliveEntries(await slow.vault())[0]!.label).toBe("edited fast");
    expect(aliveEntries(await a.vault())[0]!.hlc < `${String(w.clock.now + 60_000).padStart(13, "0")}`).toBe(true); // corrected time, not 2 days ahead
  });
  it("the server's clock 40 minutes off: TOTP keeps the local clock unless the user turns the correction on; over an hour, no correction", async () => {
    const { w, a } = await two(["GitHub"]);
    w.server.skewMs = 40 * 60_000;
    await a.engine.round();
    const v = await a.engine.view();
    expect(Math.abs(v.offsetMs - 40 * 60_000)).toBeLessThan(5000);
    expect(totpOffset(v.offsetMs, v.useCorrectedTotp)).toBe(0);
    expect(totpOffset(v.offsetMs, true)).toBe(v.offsetMs);
    w.server.skewMs = 61 * 60_000;
    await a.engine.round();
    expect(totpOffset((await a.engine.view()).offsetMs, true)).toBe(0);
    expect((await a.engine.view()).state.notices?.some((n) => n.kind === "clock_skew")).toBe(true);
  });
});

describe("F6a/R6: a bad head, a newer schema", () => {
  it("a holder of the VK writes a head that does not open: the newest readable version is merged and uploaded over it; nothing lost", async () => {
    const { w, a, b } = await two(["GitHub"]);
    w.advance(1000);
    await b.add("before the bad head");
    await b.engine.round();
    const vk = await a.vk();
    const v = w.server.account(EMAIL).vault!;
    const bad = await encryptVault(utf8("{not a vault"), vk, {
      vaultId: (await a.generation()).keyring.vaultId,
      rev: v.version + 1,
    });
    await w.server.adminSetHead(JSON.stringify(bad));
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "ok", uploaded: true });
    await quiesce(w);
    expect(issuers(await a.vault())).toEqual(["GitHub", "before the bad head"]);
    expect(issuers((await w.serverVault(vk))!)).toEqual(["GitHub", "before the bad head"]);
  });
  it("R6: a schemaVersion 2 head pauses (paused_newer): nothing uploaded, the outbox kept, the local vault unchanged", async () => {
    const { w, a } = await two(["GitHub"]);
    w.advance(1000);
    await a.add("local edit");
    const local = cj(await a.vault());
    const ob = a.disk.kv.data.get(SYNC_KEYS.outbox);
    const vk = await a.vk();
    const v2 = await encryptVault(
      utf8(JSON.stringify({ schemaVersion: 2, vaultId: (await a.generation()).keyring.vaultId, entries: [] })),
      vk,
      { vaultId: (await a.generation()).keyring.vaultId, rev: w.server.account(EMAIL).vault!.version + 1 },
    );
    await w.server.adminSetHead(JSON.stringify(v2));
    const p0 = puts(w);
    const r = await a.engine.round();
    expect(r.status).toBe("paused_newer");
    expect(puts(w)).toBe(p0);
    expect(cj(await a.vault())).toBe(local);
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox)).toEqual(ob);
    expect((await a.engine.round()).status).toBe("paused_newer"); // and stays paused
  });
  it("R6 during the walk: the head does not open, the version below it is schemaVersion 2: stop, never merge an older v1 version over the head", async () => {
    const { w, a } = await two(["GitHub"]);
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const version = w.server.account(EMAIL).vault!.version;
    await w.server.adminSetHead(
      JSON.stringify(
        await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), vk, {
          vaultId,
          rev: version + 1,
        }),
      ),
    );
    await w.server.adminSetHead(JSON.stringify(await encryptVault(utf8("garbage"), vk, { vaultId, rev: version + 2 })));
    const p0 = puts(w);
    expect((await a.engine.round()).status).toBe("paused_newer");
    expect(puts(w)).toBe(p0);
  });
  it("nothing opens at all: remote_unreadable, nothing uploaded, the local vault untouched", async () => {
    const { w, a } = await two(["GitHub"]);
    const other = await generateVk();
    const vaultId = (await a.generation()).keyring.vaultId;
    // every history version replaced with an envelope under another key
    for (const h of w.server.account(EMAIL).history)
      h.envelope = JSON.stringify(await encryptVault(utf8("{}"), other, { vaultId, rev: h.version }));
    await w.server.adminSetHead(JSON.stringify(await encryptVault(utf8("x"), other, { vaultId, rev: 99 })));
    const local = cj(await a.vault());
    const p0 = puts(w);
    expect((await a.engine.round()).status).toBe("remote_unreadable");
    expect(puts(w)).toBe(p0);
    expect(cj(await a.vault())).toBe(local);
  });
});

describe("F15/D7/D3: big merges", () => {
  it("a merge past 5000 accounts keeps syncing (the 5000 limit is for adding)", async () => {
    const { w, a, b } = await two([]);
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const remote: Vault = { ...emptyVault(vaultId), entries: bulkEntries(5001, "bulk", w.clock.now - 1000) };
    const up = await uploadEnvelope(remote, vk, { vaultId, rev: w.server.account(EMAIL).vault!.version + 1 });
    await w.server.adminSetHead(up.text);
    expect((await a.engine.round()).status).toBe("ok");
    expect(aliveEntries(await a.vault()).length).toBe(5001);
    expect((await b.engine.round()).status).toBe("ok");
  }, 60_000);
  it("D7: a merge past 50 000 entries is not committed and becomes too_large (not retried every round); the local vault stays as it was", async () => {
    // Only a holder of the VK with a server that ignores the size limit can serve this (§4.3): a server without the gate.
    const w = await worldOf(2, ["GitHub"], [], { validateWire: false });
    const a = w.devices[0]!;
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    // the remote holds 49 000 entries, this device 1 500 others: the merge would hold 50 501 (past the parse limit)
    const remote: Vault = { ...emptyVault(vaultId), entries: bulkEntries(49_000, "huge", w.clock.now - 1000) };
    const env = await encryptVault(serializeVault(remote), vk, {
      vaultId,
      rev: w.server.account(EMAIL).vault!.version + 1,
    });
    await w.server.adminSetHead(JSON.stringify(env));
    w.advance(1000);
    await a.svc.mutate((v) => ({
      ...v,
      entries: [...v.entries, ...bulkEntries(1500, "mine", w.clock.now - 500, { device: "mineee" })].sort((x, y) =>
        x.id < y.id ? -1 : 1,
      ),
    }));
    const local = cj(await a.vault());
    const r = await a.engine.round();
    expect(r.status).toBe("too_large");
    expect(r.error).toBeUndefined(); // a state, not a failure: no backoff loop retrying it
    expect(cj(await a.vault())).toBe(local);
    expect((await a.engine.view()).state.failures ?? 0).toBe(0);
  }, 180_000);
  it("D3: a merge over 8 MiB is committed locally, the upload pauses (too_large); deleting into the trash and erasing are allowed, and the upload resumes below the limit", async () => {
    const { w, a, b } = await two(["GitHub"]);
    // B holds many long entries (under the limit on its own), A as many others (also under it): their merge is over 8 MiB
    w.advance(1000);
    await b.svc.mutate((v) => ({
      ...v,
      entries: [...v.entries, ...bulkEntries(6500, "bbbb", w.clock.now - 500, { text: 250, device: "bbbbb" })].sort(
        (x, y) => (x.id < y.id ? -1 : 1),
      ),
    }));
    expect((await b.engine.round()).uploaded).toBe(true);
    await a.svc.mutate((v) => ({
      ...v,
      entries: [...v.entries, ...bulkEntries(3500, "aaaa", w.clock.now - 400, { text: 250, device: "aaaaa" })].sort(
        (x, y) => (x.id < y.id ? -1 : 1),
      ),
    }));
    const r = await a.engine.round();
    expect(r.status).toBe("too_large");
    expect(aliveEntries(await a.vault()).length).toBe(10_001); // committed locally: nothing merged is dropped
    // clean up: delete into the trash, then erase (allowed whatever the size, §4.3 D3)
    w.advance(1000);
    await a.svc.mutate((v, c) =>
      v.entries.filter((e) => e.id.startsWith("aaaa-")).reduce((x, e) => deleteEntry(x, e.id, c), v),
    );
    await a.svc.mutate((v, c) =>
      v.entries.filter((e) => e.id.startsWith("aaaa-")).reduce((x, e) => purgeEntry(x, e.id, c), v),
    );
    const r2 = await a.engine.round();
    expect(r2.status).toBe("ok");
    expect(r2.uploaded).toBe(true);
    await b.engine.round();
    expect(aliveEntries(await b.vault()).length).toBe(6501);
  }, 180_000);
});

describe('P10: "lock every time": the key lives in the popup only', () => {
  it("an edit in the popup writes the outbox; the popup closes; the service worker (no key) pushes it", async () => {
    const { w, a, b } = await two(["GitHub"]);
    // the popup's own memory holds the key; the worker's storage.session has none
    const popupSession = new MemorySession();
    popupSession.data = a.disk.session.data ? { ...a.disk.session.data } : null;
    a.disk.session.data = null;
    const popup = contextOver({
      ...a.disk,
      session: popupSession,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: a.net,
      clock: a.now,
    });
    w.advance(1000);
    await popup.svc.mutate((v, c) => addEntry(v, input("popup edit"), c).vault);
    a.restartWorker(); // the worker: no key in storage.session
    expect(await a.flows.current().catch((e) => e.code)).toBe("locked");
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "locked", pushedOutbox: true });
    await b.engine.round();
    expect(issuers(await b.vault())).toContain("popup edit");
  });
});

describe("§4.12 HOTP", () => {
  it("two offline devices advance the counter; after sync the counter is the maximum; a HOTP kick asks for a round now", async () => {
    const { w, a, b } = await two([]);
    w.advance(1000);
    await a.svc.mutate(
      (v, c) =>
        addEntry(
          v,
          {
            type: "hotp",
            issuer: "Bank",
            label: "a",
            secret: "JBSWY3DPEHPK3PXP",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
            counter: 0,
          },
          c,
        ).vault,
    );
    await quiesce(w);
    const id = (await a.vault()).entries[0]!.id;
    a.net.partition(true);
    b.net.partition(true);
    await a.svc.mutate((v, c) => editEntry(v, id, { counter: 3 }, c));
    await b.svc.mutate((v, c) => editEntry(v, id, { counter: 5 }, c));
    await a.engine.kick({ immediate: true });
    expect(a.scheduler.wakes.get("sync")!.at).toBe(a.now());
    a.net.partition(false);
    b.net.partition(false);
    await quiesce(w);
    expect((await a.vault()).entries[0]!.counter).toBe(5);
    expect((await b.vault()).entries[0]!.counter).toBe(5);
  });
});

describe("§3.5 joining with data on this device", () => {
  it("another vault here: its live accounts are added to the cloud's (new ids, duplicates skipped), the old vault kept as sk_prejoin", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const b = w.device("B");
    const { createProtected } = await import("../helpers/vaults");
    await createProtected(b.svc, "another-strong-pass-77");
    await b.add("Local only");
    await b.add("GitHub"); // the same secret (secretOf) and issuer as the cloud's: skipped
    const session = await w.server.session(EMAIL);
    const plan = await joinWithRecoveryCode(b.engine, { session, recoveryCode: w.code, deviceName: "B", email: EMAIL });
    expect(joinSummary(plan)).toMatchObject({ mode: "added", added: 1, skipped: 1 });
    expect(await commitJoin(plan)).toBe("enrolled");
    expect(b.disk.kv.data.has(SYNC_KEYS.prejoin)).toBe(true);
    await b.engine.round();
    await quiesce(w);
    expect(issuers(await w.devices[0]!.vault())).toEqual(["AWS", "GitHub", "Local only"]);
  });
});

describe("§4.4 the guard through the engine", () => {
  it("a remote that erases an account alive here stops the merge (review_needed), keeps nothing; [Apply] after review commits it", async () => {
    const { w, a, b } = await two(["GitHub", "AWS"]);
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    // B erases AWS in one step (skipping A's trash): delete and purge before A ever synced the delete
    w.advance(1000);
    await b.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c));
    await b.engine.round();
    const before = cj(await a.vault());
    const p0 = puts(w);
    // every write of the round, not only what is left at its end: a worker that dies between two writes keeps the first
    const written: string[] = [];
    const set = a.disk.kv.set.bind(a.disk.kv);
    a.disk.kv.set = async (items) => {
      written.push(JSON.stringify(items));
      return set(items);
    };
    const r = await a.engine.round();
    a.disk.kv.set = set;
    expect(r.status).toBe("review_needed");
    expect(r.blocked!.report.purgedAlive).toEqual([aws]);
    expect(cj(await a.vault())).toBe(before);
    expect(puts(w)).toBe(p0);
    const digest = Object.values(r.blocked!.seen)[0]!;
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((x) => x.includes(digest))).toEqual([]); // C1: the digest is never stored, not even for a moment
    expect(JSON.stringify(a.disk.kv.data.get(SYNC_KEYS.state))).not.toContain(digest);
    const r2 = await a.engine.round({ answer: { seen: r.blocked!.seen, accept: [aws] } });
    expect(r2.status).toBe("ok");
    expect(isPurged((await a.vault()).entries.find((e) => e.id === aws)!)).toBe(true);
  });
  it("a remote that changes a secret stops it; [Keep mine] keeps this device's account and uploads it", async () => {
    const { w, a, b } = await two(["GitHub"]);
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const mine = await a.vault();
    const gh = mine.entries[0]!;
    const evil: Vault = {
      ...mine,
      entries: [
        {
          ...gh,
          secret: "GEZDGNBVGY3TQOJQ",
          hlc: gh.hlc.replace(/^\d{13}/, String(w.clock.now + 5000).padStart(13, "0")),
        },
      ],
    };
    await w.server.adminSetHead(
      (await uploadEnvelope(evil, vk, { vaultId, rev: w.server.account(EMAIL).vault!.version + 1 })).text,
    );
    const r = await a.engine.round();
    expect(r.status).toBe("review_needed");
    expect(r.blocked!.report.secretChanged).toEqual([gh.id]);
    const r2 = await a.engine.round({ answer: { seen: r.blocked!.seen, keepMine: [gh.id] } });
    expect(r2).toMatchObject({ status: "ok", uploaded: true });
    await b.engine.round();
    expect((await b.vault()).entries[0]!.secret).toBe(gh.secret);
  });
  it("3 or more moved to the trash by a merge: a notice, never a block", async () => {
    const { w, a, b } = await two(["A1", "A2", "A3", "A4"]);
    w.advance(1000);
    await b.svc.mutate((v, c) => v.entries.slice(0, 3).reduce((x, e) => deleteEntry(x, e.id, c), v));
    await b.engine.round();
    const r = await a.engine.round();
    expect(r.status).toBe("ok");
    expect(trashEntries(await a.vault()).length).toBe(3);
    expect((await a.engine.view()).state.notices?.some((n) => n.kind === "deleted_remotely" && n.n === 3)).toBe(true);
  });
});

describe("N27/N24: the repair of a rolled-back bundle (the same VK)", () => {
  it("the server's bundle goes back to an older one (another recovery code then): keys_behind; the repair republishes this device's keyring; others are in sync", async () => {
    const { w, a, b } = await two(["GitHub"]);
    const old = w.server.account(EMAIL).vault!;
    const oldBundle = old.bundle;
    const oldKver = old.kver;
    // A changes the recovery code (§3.7), B adopts it
    const { prepareRecoveryCode, commitRecoveryCode } = await import("../../src/core/sync/engine/keys");
    const h = await prepareRecoveryCode(a.engine, w.password);
    await commitRecoveryCode(a.engine, h);
    w.code = h.recoveryCode;
    await b.engine.round();
    await b.engine.round();
    expect(cj((await b.generation()).keyring)).toBe(cj((await a.generation()).keyring));
    // the server's bundle is rolled back (PITR of the keys only)
    w.server.adminSetBundle(oldBundle, oldKver);
    expect((await a.engine.round()).keyStatus).toBe("keys_behind");
    await repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: w.code });
    expect(w.server.account(EMAIL).vault!.kver).toBeGreaterThan(oldKver + 1);
    const rb = await b.engine.round();
    expect(rb.keyStatus).toBe("ok");
    expect(cj((await b.generation()).keyring)).toBe(cj((await a.generation()).keyring));
  });
});

export { firstDevice, joinDevice };

describe("D7: a head that cannot be taken in is not pulled again every round", () => {
  it("paused_newer: the second round does not GET the head again while nothing changed; a local edit makes it look again", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    await w.server.adminSetHead(
      JSON.stringify(
        await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), vk, {
          vaultId,
          rev: w.server.account(EMAIL).vault!.version + 1,
        }),
      ),
    );
    expect((await a.engine.round()).status).toBe("paused_newer");
    const gets = () => w.server.requests.filter((q) => q.op === "GET /v1/vault").length;
    const g0 = gets();
    expect((await a.engine.round()).status).toBe("paused_newer");
    expect(gets()).toBe(g0);
    w.advance(1000);
    await a.add("new");
    expect((await a.engine.round()).status).toBe("paused_newer");
    expect(gets()).toBe(g0 + 1);
  });
});

describe("§4.4 D6: the danger colour", () => {
  it("entries another device moved to the trash and erased within 24 hours: the banner is danger; older ones are not", async () => {
    const w = await worldOf(2, ["A1", "A2", "A3", "A4"]);
    const [a, b] = w.devices as [Device, Device];
    w.advance(1000);
    await b.svc.mutate((v, c) => v.entries.slice(0, 3).reduce((x, e) => deleteEntry(x, e.id, c), v));
    await b.engine.round();
    await a.engine.round(); // in A's trash now
    w.advance(3_600_000);
    await b.unlock(); // an hour idle: locked meanwhile
    await b.svc.mutate((v, c) => v.entries.slice(0, 3).reduce((x, e) => purgeEntry(x, e.id, c), v));
    await b.engine.round();
    await a.unlock();
    expect((await a.engine.round()).status).toBe("ok");
    const n = (await a.engine.view()).state.notices!.filter((x) => x.kind === "deleted_remotely");
    expect(n.at(-1)).toMatchObject({ n: 3, danger: true });
  });
});
