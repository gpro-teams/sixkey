// M3 (SYNC-DESIGN §8.3, §4.8, §3.14 S2): what the server and the network can do to a round, and when the engine runs.
// 500 / 503 / 429 with Retry-After / a timeout / a body that is not JSON / an envelope whose header no longer matches its
// AAD; the backoff (bounded, counted per device, never a lockout); the per-device wrong-password counter as a banner,
// never a lockout; the scheduler's wakes (3 s debounce, 30 s backstop, setTimeout below 30 s, alarms above; persisted so
// a restarted worker carries on); and the outbox delivered twice or after a timeout taking effect exactly once.
import { describe, expect, it } from "vitest";
import { sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { BACKOFF_MAX_MS, DEBOUNCE_MS } from "../../src/core/sync/engine/schedule";
import { aliveEntries } from "../../src/core/vault/model";
import { EMAIL, quiesce, type Device, type World, worldOf } from "../helpers/m3-world";

const two = async (names = ["GitHub"]) => {
  const w = await worldOf(2, names);
  return { w, a: w.devices[0]! as Device, b: w.devices[1]! as Device };
};
const puts = (w: World) => w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;

describe("§8.3 server failures: counted, backed off, never a lockout; nothing local changes", () => {
  it("500 on the status: offline/error, failures 1, a retry scheduled after the backoff; success resets it", async () => {
    const { w, a } = await two();
    w.server.fault({ match: "GET /v1/sync/status", kind: "status", status: 500, code: "internal_error" });
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "error", error: "internal_error" });
    const v = await a.engine.view();
    expect(v.state.failures).toBe(1);
    expect(v.state.backoffUntil).toBeGreaterThan(a.now());
    expect(a.scheduler.wakes.get("retry")).toBeDefined();
    expect((await a.engine.round()).status).toBe("ok");
    expect((await a.engine.view()).state.failures).toBe(0);
    expect((await a.engine.view()).state.backoffUntil ?? null).toBeNull();
  });
  it("429 and 503 with Retry-After: the next try is not before it; wake() inside the backoff does not run a round", async () => {
    const { w, a } = await two();
    w.server.fault({
      match: "GET /v1/sync/status",
      kind: "status",
      status: 429,
      code: "rate_limited",
      retryAfter: 600,
    });
    await a.engine.round();
    const until = (await a.engine.view()).state.backoffUntil!;
    expect(until - a.now()).toBeGreaterThanOrEqual(600_000);
    expect(a.scheduler.wakes.get("retry")).toEqual({ at: until, via: "alarm" });
    const n0 = w.server.requests.length;
    await a.engine.wake("sync");
    expect(w.server.requests.length).toBe(n0); // backed off
    w.advance(601_000);
    expect((await a.engine.wake("retry")).status).toBe("ok");
    w.server.fault({ match: "GET /v1/vault", kind: "status", status: 503, code: "unavailable", retryAfter: 45 });
    await a
      .add("x")
      .then(() => w.devices[1]!.add("y"))
      .then(() => w.devices[1]!.engine.round());
    await a.engine.round();
    expect((await a.engine.view()).state.backoffUntil! - a.now()).toBeGreaterThanOrEqual(45_000);
  });
  it("the backoff is bounded however long the server keeps failing (30 min ± 20 %), and failures are only a number", async () => {
    const { w, a } = await two();
    w.server.fault({ match: "GET /v1/sync/status", kind: "status", status: 500, code: "internal_error", count: 40 });
    for (let i = 0; i < 40; i++) {
      await a.engine.round({ explicit: true });
      const v = await a.engine.view();
      expect(v.state.backoffUntil! - a.now(), `after ${i + 1}`).toBeLessThanOrEqual(BACKOFF_MAX_MS * 1.2);
    }
    expect((await a.engine.view()).state.failures).toBe(40);
    expect((await a.engine.round({ explicit: true })).status).toBe("ok"); // and it is never locked out
  });
  it("a timeout (the answer never comes): offline; the outbox and the local edit are kept; the next round settles it", async () => {
    const { w, a, b } = await two();
    w.advance(1000);
    await a.add("edit");
    a.net.inject({ match: "PUT /v1/vault", kind: "lose_response" });
    const r = await a.engine.round();
    expect(r.status).toBe("offline");
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox)).toBeTruthy();
    await quiesce(w);
    expect(aliveEntries(await b.vault()).map((e) => e.issuer)).toContain("edit");
  });
  it("a body that is not JSON (a proxy's error page, a truncated answer): an error, nothing stored", async () => {
    const { w, a } = await two();
    const send = w.server.send.bind(w.server);
    let once = true;
    w.server.send = async (req) => {
      const res = await send(req);
      if (once && req.target === "/v1/sync/status") {
        once = false;
        return { ...res, body: res.body.slice(0, 20) };
      }
      return res;
    };
    const before = JSON.stringify(a.disk.kv.data.get(SYNC_KEYS.state));
    const r = await a.engine.round();
    expect(r.status).toBe("error");
    expect(r.error).toBe("malformed_response");
    expect(JSON.stringify((await a.engine.view()).lastSynced)).toBe(JSON.stringify(JSON.parse(before).lastSynced));
  });
  it("an envelope whose header was changed and its checksum recomputed (the checksum is right, the AAD wrong): it does not open; the history is walked", async () => {
    const { w, a, b } = await two();
    w.advance(1000);
    await b.add("from B");
    await b.engine.round();
    const head = JSON.parse(w.server.account(EMAIL).vault!.envelope);
    const forged = { ...head, rev: head.rev + 1 };
    // the checksum covers aad || iv || ciphertext: recompute it over the changed header so only the AAD check catches it
    const aad = utf8(`sixkey-vault|1|${forged.vaultId}|${forged.vkId}|${forged.rev}`);
    const { fromB64 } = await import("../../src/core/crypto/bytes");
    forged.checksum = toB64(await sha256(aad, fromB64(forged.iv), fromB64(forged.ciphertext)));
    await w.server.adminSetHead(JSON.stringify(forged));
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "ok", uploaded: true }); // F6a: the version below opened, merged, uploaded over it
    expect(aliveEntries(await a.vault()).map((e) => e.issuer)).toContain("from B");
  });
});

describe("§3.14 S2: wrong passwords on a device are a banner, never a lockout", () => {
  it("three wrong pw_auth from one device: the others see the danger banner; that device's correct proof still works", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, b, c] = w.devices as [Device, Device, Device];
    const cid = ((await c.local.settlePins()) as { deviceId: string }).deviceId;
    const bid = ((await b.local.settlePins()) as { deviceId: string }).deviceId;
    const signer = {
      kind: "device" as const,
      deviceId: bid,
      key: ((await b.local.settlePins()) as { keyPair: CryptoKeyPair }).keyPair.privateKey,
    };
    for (let i = 0; i < 3; i++)
      await b.engine.api.revoke(signer, cid, toB64(new Uint8Array(32).fill(i + 1))).catch(() => undefined);
    expect(w.server.state(EMAIL).devices.find((d) => d.device_id === bid)!.auth_failures).toBe(3);
    await a.engine.round();
    const n = (await a.engine.view()).state.notices ?? [];
    expect(n.some((x) => x.kind === "auth_failures" && x.danger)).toBe(true);
    const { revokeDevice } = await import("../../src/core/sync/engine/keys");
    await revokeDevice(b.engine, cid, w.password); // not locked out
    expect(w.server.state(EMAIL).devices.find((d) => d.device_id === cid)!.revoked_at).not.toBeNull();
    expect((await b.engine.round()).status).toBe("ok");
  });
});

describe("§4.8 when the engine runs (wakes on a virtual clock)", () => {
  it("a local edit asks for a round 3 s later (setTimeout) and a 30 s backstop (alarm), persisted for a restarted worker", async () => {
    const { a } = await two();
    await a.add("x");
    await a.engine.kick();
    expect(a.scheduler.wakes.get("sync")).toEqual({ at: a.now() + DEBOUNCE_MS, via: "timeout" });
    expect(a.scheduler.wakes.get("kick")).toEqual({ at: a.now() + 30_000, via: "alarm" });
    const st = (await a.engine.view()).state;
    expect(st.kickAt).toBe(a.now());
    expect(st.dirtySince).toBe(a.now());
    // the worker stops; a new one starts: dirty is derived, the round is scheduled again
    a.restartWorker();
    a.scheduler.wakes.clear();
    await a.engine.start();
    expect(a.scheduler.wakes.get("sync")).toBeDefined();
    const r = await a.engine.wake("sync");
    expect(r).toMatchObject({ status: "ok", uploaded: true });
    expect((await a.engine.view()).state.dirtySince ?? null).toBeNull();
  });
  it("the busy lock asks for a rerun instead of waiting; a kick during a round runs it again at the end", async () => {
    const { w, a } = await two();
    await a.add("first");
    let second: Promise<unknown> | null = null;
    w.server.fault({
      match: "PUT /v1/vault",
      kind: "hook",
      fn: async () => {
        second = a.engine.round();
        await a.add("during");
        await a.engine.kick();
      },
    });
    // the clock does not move inside the round here: a kick at the same ms as the round's start; nudge it forward
    const now = a.now;
    let t = 0;
    a.ctx.engine.deps.now = () => now() + t++;
    const r = await a.engine.round();
    expect(r.status).toBe("ok");
    expect((await second!) as unknown).toMatchObject({ status: "busy" });
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull(); // "during" went up in the rerun
    expect(puts(w)).toBeGreaterThanOrEqual(2);
  });
});

describe("§4.7 exactly-once effect of the outbox", () => {
  it("delivered twice (a duplicate): one version on the server, the second answered 409 and harmless", async () => {
    const { w, a } = await two();
    await a.add("once");
    await a.lockNow();
    a.net.inject({ match: "PUT /v1/vault", kind: "duplicate" });
    const v0 = w.server.account(EMAIL).vault!.version;
    await a.engine.round();
    expect(w.server.account(EMAIL).vault!.version).toBe(v0 + 1);
    expect(a.net.orphans.some((o) => o.op === "PUT /v1/vault" && o.status === 409)).toBe(true);
  });
  it("delivered after the worker gave up (late), then pushed again: still exactly one version with it", async () => {
    const { w, a } = await two();
    await a.add("late");
    await a.lockNow();
    a.net.inject({ match: "PUT /v1/vault", kind: "late" });
    const v0 = w.server.account(EMAIL).vault!.version;
    expect((await a.engine.round()).status).toBe("offline");
    await a.net.flushLate(); // it lands now
    expect(w.server.account(EMAIL).vault!.version).toBe(v0 + 1);
    const r = await a.engine.round(); // the status says it landed (version and head are the outbox's): lastSynced moves on
    expect(r.pushedOutbox).toBe(true);
    expect(w.server.account(EMAIL).vault!.version).toBe(v0 + 1);
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull();
  });
  it("D5: after a rollback another device reused the outbox's version with another head: the outbox is never pushed over it", async () => {
    const { w, a, b } = await two();
    const snap = w.server.snapshot(); // version v
    await a.add("X");
    await a.engine.round(); // version v+1, A in sync with it
    await a.add("in outbox"); // outbox built on (v+1, A's head)
    await a.lockNow();
    const ob = a.disk.kv.data.get(SYNC_KEYS.outbox) as { base: number; head: string };
    w.server.restore(snap); // back to v
    await b.add("B1");
    await b.engine.round(); // B's version v+1: the same number, other content
    const sv = w.server.account(EMAIL).vault!;
    expect(sv.version).toBe(ob.base);
    expect(sv.head).not.toBe(ob.head);
    const p0 = puts(w);
    const r = await a.engine.round();
    expect(r.pushedOutbox).toBe(false);
    expect(puts(w)).toBe(p0);
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull(); // dropped: a full round with the key merges first
    await a.unlock();
    await quiesce(w);
    expect(
      aliveEntries(await b.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["B1", "GitHub", "X", "in outbox"]);
  });
});

describe("§4.7: lastSynced null means no outbox (merge first)", () => {
  it("after a join or a key commit (lastSynced cleared) an edit writes no pushable outbox until a full round (revision 20: a merge-only one, never pushed)", async () => {
    const { w, a } = await two();
    const { prepareRecoveryCode, commitRecoveryCode } = await import("../../src/core/sync/engine/keys");
    const h = await prepareRecoveryCode(a.engine, w.password);
    await commitRecoveryCode(a.engine, h);
    expect((await a.engine.view()).lastSynced).toBeNull();
    await a.add("after the key commit");
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox)).toMatchObject({ from: null }); // merge-only (R3R-5): no base, no proof
    expect((a.disk.kv.data.get(SYNC_KEYS.outbox) as { proof?: string }).proof).toBeUndefined();
    await a.lockNow();
    const puts = w.server.requests.filter((r) => r.op === "PUT /v1/vault").length;
    await a.engine.push(); // the locked worker never pushes a merge-only record
    expect(w.server.requests.filter((r) => r.op === "PUT /v1/vault").length).toBe(puts);
    await a.svc.unlockWithPassword(w.password); // (the recovery code changed above)
    await a.engine.round();
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull(); // the full round's lastSynced write removed it
    await a.add("after the round");
    expect((a.disk.kv.data.get(SYNC_KEYS.outbox) as { proof?: string }).proof).toBeTruthy(); // pushable again
  });
});

export { encryptVault };
