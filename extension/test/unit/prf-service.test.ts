// The device unlock through the service (QUICK-UNLOCK §5.3–§5.9, §7.1; Stage 2), with platform/webauthn.ts replaced by a
// software authenticator (test/helpers/fake-webauthn.ts): enrolment and how it classifies what the authenticator
// returned (PRF or gate, synced or not, the opt-in), the persistent PRF unlock and its 14 days, the session gate and its
// assertion check, the hard locks, the gate beside the PIN (its own record since 2026-10-30), removal, "turn back on" after
// a key change, a new vault, and nothing secret on disk or in a log.
import { describe, expect, it } from "vitest";
import { fromB64, toB64 } from "../../src/core/crypto/bytes";
import { QUICK_TTL_MS, type QuickDevice, type QuickSession } from "../../src/core/crypto/pin";
import { parsePrfRecord, PRF_PASSWORD_MS, type PrfCred, type PrfRecord } from "../../src/core/crypto/prf-record";
import { applyPreset } from "../../src/core/service/presets";
import { rotatedBy } from "../../src/core/service/rotated";
import { updatePrf } from "../../src/core/service/prf-write";
import type { Vk } from "../../src/core/crypto/vk";
import { NO_PAGE, STRONG, codeOf } from "../helpers/vaults";
import { AAGUID, type FakeOptions, type Tamper } from "../helpers/fake-webauthn";
import { lockScreen, notePassword, PIN, pinIn, quickWorld, type QuickWorld } from "../helpers/quick-world";

const DAY = 86_400_000;
const STRONG2 = "granite-river-compass-31";

const prfOf = (w: QuickWorld): PrfRecord => {
  const r = parsePrfRecord(w.kv.data.get("sk_prf"));
  if (r === null || r === "damaged") throw new Error(`sk_prf is ${r}`);
  return r;
};
const quickOf = (w: QuickWorld): Promise<QuickSession | null> => w.area.getQuick();
const enrol = (w: QuickWorld, o: { allowSynced?: boolean; ctx?: ReturnType<QuickWorld["ctx"]> } = {}) =>
  (o.ctx ?? w.first).device.enrol(STRONG, { name: "Touch ID", allowSynced: o.allowSynced ?? false });
/** A world with one credential enrolled (`fake` options as the virtual authenticator's), then soft-locked. */
async function enrolled(fake: Partial<FakeOptions> = {}, o: { pin?: string | null; allowSynced?: boolean } = {}) {
  const w = await quickWorld({ pin: o.pin ?? null, fake });
  const r = await enrol(w, { allowSynced: o.allowSynced });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  await w.first.service.lock();
  return w;
}
const view = async (w: QuickWorld) => w.ctx().service.openView();
/** A browser restart, as far as Sixkey's state goes: chrome.storage.session is gone (QUICK-UNLOCK §7.2). */
function restart(w: QuickWorld) {
  w.area.data = null;
  w.area.quick = null;
}

describe("enrolment classifies by what the authenticator returned (§5.3; Q2)", () => {
  it("a PRF result, not synced: 'prf'; the vault key wrapped for it; the 14 days start; nothing armed; prf_enrolled", async () => {
    const w = await quickWorld({ pin: null });
    const r = await enrol(w);
    expect(r).toEqual({ ok: true, mode: "prf", synced: false });
    const rec = prfOf(w);
    expect(rec.lastPasswordAt).toBe(w.t.now);
    expect(rec.creds).toHaveLength(1);
    const c = rec.creds[0]!;
    expect(c).toMatchObject({ kind: "platform", mode: "prf", name: "Touch ID", synced: false, provider: "chrome" });
    expect(c.wrap!.vkId).toBe((await w.first.service.currentGeneration())!.keyring.vkId);
    expect(c.publicKey).toBeUndefined();
    // the PRF was asked for at creation and in the verification get with the very salt stored (YR-28: the get decides)
    const salt = c.salt!;
    expect(toB64(w.fake.requests.create[0]!.prfSalt)).toBe(salt);
    expect(toB64(w.fake.requests.get[0]!.prf![c.id]!)).toBe(salt);
    expect(w.fake.requests.get[0]!.allow).toEqual([c.id]);
    expect(w.fake.requests.create[0]!.userId).toHaveLength(16);
    expect(w.fake.requests.create[0]!.exclude).toEqual([]);
    expect(await quickOf(w)).toBeNull(); // the persistent unlock arms nothing
    expect(await w.kinds()).toEqual(["prf_enrolled"]);
  });

  it("no PRF result (the Chrome-profile Touch ID): 'gate': its public key kept, no key material, armed at once", async () => {
    const w = await quickWorld({ pin: null, fake: { prf: false } });
    await expect(enrol(w)).resolves.toEqual({ ok: true, mode: "gate", synced: false }); // an answer, never a throw
    const c = prfOf(w).creds[0]!;
    expect(c).toMatchObject({ mode: "gate", alg: -7 });
    expect(c.salt).toBeUndefined();
    expect(c.wrap).toBeUndefined();
    expect(fromB64(c.publicKey!).length).toBeGreaterThan(60);
    const q = (await quickOf(w)) as QuickDevice;
    expect(q).toMatchObject({ method: "device", armedAt: w.t.now, expiresAt: w.t.now + QUICK_TTL_MS });
    expect(w.kv.data.has("sk_quick")).toBe(false); // memory only
  });

  it("a synced passkey (BE set) without the opt-in: a gate, and the answer says why; with it: 'prf', marked synced", async () => {
    const a = await quickWorld({ pin: null, fake: { be: true, bs: true, aaguid: AAGUID.icloud } });
    expect(await enrol(a)).toEqual({ ok: true, mode: "gate", synced: true, refused: "synced" });
    expect(prfOf(a).creds[0]).toMatchObject({ mode: "gate", synced: true, provider: "icloud" });
    const b = await quickWorld({ pin: null, fake: { be: true, bs: true, aaguid: AAGUID.google } });
    expect(await enrol(b, { allowSynced: true })).toEqual({ ok: true, mode: "prf", synced: true });
    expect(prfOf(b).creds[0]).toMatchObject({ mode: "prf", synced: true, provider: "google" });
  });

  it("a synced passkey refused without the opt-in: added again with the box ticked it is 'exists'; removed first, it is 'prf'", async () => {
    // what dvSyncedRefused tells the user to do (REVIEW F2): the provider refuses the same passkey twice
    const w = await quickWorld({ pin: null, fake: { be: true, bs: true, aaguid: AAGUID.icloud } });
    expect(await enrol(w)).toMatchObject({ ok: true, mode: "gate", refused: "synced" });
    const id = prfOf(w).creds[0]!.id;
    expect(await enrol(w, { allowSynced: true })).toEqual({ ok: false, reason: "exists" });
    expect(w.fake.requests.create.at(-1)!.exclude).toEqual([id]);
    await w.first.device.remove(STRONG, id);
    expect(await enrol(w, { allowSynced: true })).toEqual({ ok: true, mode: "prf", synced: true });
    expect(prfOf(w).creds.map((c) => c.mode)).toEqual(["prf"]);
  });

  it("the opt-in with no PRF result: a gate ('no_prf'); the opt-in with a device-bound PRF one: 'prf', not synced", async () => {
    const a = await quickWorld({ pin: null, fake: { prf: false, be: true } });
    expect(await enrol(a, { allowSynced: true })).toEqual({ ok: true, mode: "gate", synced: true, refused: "no_prf" });
    const b = await quickWorld({ pin: null, fake: { aaguid: AAGUID.windows } });
    expect(await enrol(b, { allowSynced: true })).toEqual({ ok: true, mode: "prf", synced: false });
    expect(prfOf(b).creds[0]!.provider).toBe("windows");
    const c = await quickWorld({ pin: null, fake: { aaguid: AAGUID.none } });
    await enrol(c);
    expect(prfOf(c).creds[0]!.provider).toBeUndefined(); // unknown: the removal text names every place
  });

  it("an RS256 key (Windows Hello commonly uses one): a gate that opens", async () => {
    const w = await enrolled({ prf: false, alg: -257 });
    expect(prfOf(w).creds[0]!.alg).toBe(-257);
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
  });

  it("refused, nothing saved: a cross-platform authenticator, no UV or UP, another challenge, origin, type or RP ID", async () => {
    for (const [o, t] of [
      [{ attachment: "cross-platform" as const }, null],
      [{}, "uv"],
      [{}, "up"],
      [{}, "challenge"],
      [{}, "origin"],
      [{}, "type"],
      [{}, "crossOrigin"],
      [{}, "rpIdHash"],
    ] as const) {
      const w = await quickWorld({ pin: null, fake: o });
      w.fake.tamper = t as Tamper | null;
      expect(await enrol(w), JSON.stringify([o, t])).toEqual({ ok: false, reason: "refused" });
      expect(w.kv.data.has("sk_prf")).toBe(false);
      expect(await w.kinds()).toEqual([]);
    }
  });

  it("refused when the verification get does not pass the gate's own check with the key just made, or names another", async () => {
    for (const t of ["signature", "otherKey", "uv", "challenge", "otherCredential", "wrongId"] as const) {
      const w = await quickWorld({ pin: null });
      w.fake.tamperGet = t;
      if (t === "otherCredential") {
        await enrol(w); // a second credential to answer with
        w.kv.data.delete("sk_prf");
        w.fake.requests.create.length = 0;
      }
      expect(await enrol(w), t).toEqual({ ok: false, reason: "refused" });
      expect(w.kv.data.has("sk_prf"), t).toBe(false);
    }
  });

  it("the creation's own check refuses each clause by itself, before any get, though the get would answer truly", async () => {
    for (const t of ["uv", "up", "challenge", "origin", "type", "crossOrigin", "rpIdHash"] as const) {
      const w = await quickWorld({ pin: null });
      w.fake.tamperCreate = t; // the creation only: a verification get would pass the gate's check
      expect(await enrol(w), t).toEqual({ ok: false, reason: "refused" });
      expect(w.fake.requests.get, t).toHaveLength(0);
      expect(w.kv.data.has("sk_prf"), t).toBe(false);
    }
  });

  it("a cancel at either touch saves nothing and records nothing; the passkey made stays the OS's", async () => {
    const a = await quickWorld({ pin: null });
    a.fake.tamper = "cancel";
    expect(await enrol(a)).toEqual({ ok: false, reason: "cancelled" });
    const b = await quickWorld({ pin: null });
    b.fake.tamperGet = "cancel";
    expect(await enrol(b)).toEqual({ ok: false, reason: "cancelled" });
    expect(b.fake.creds.size).toBe(1);
    for (const w of [a, b]) {
      expect(w.kv.data.has("sk_prf")).toBe(false);
      expect(await w.kinds()).toEqual([]);
    }
  });

  it("the same passkey twice: excluded, 'exists'; a second one is added beside it", async () => {
    const w = await quickWorld({ pin: null });
    await enrol(w);
    const id = prfOf(w).creds[0]!.id;
    expect(await enrol(w)).toEqual({ ok: false, reason: "exists" });
    expect(w.fake.requests.create[1]!.exclude).toEqual([id]);
    w.fake.creds.clear(); // another authenticator, as far as the exclude list goes
    expect((await enrol(w)).ok).toBe(true);
    expect(prfOf(w).creds).toHaveLength(2);
  });

  it("the master password first: a wrong one is refused and recorded before any ceremony; locked; no master password", async () => {
    const w = await quickWorld({ pin: null });
    await expect(w.first.device.enrol("not the password", { name: "x", allowSynced: false })).rejects.toMatchObject({
      code: "wrong_secret",
    });
    expect(w.fake.requests.create).toHaveLength(0);
    expect(await w.kinds()).toEqual(["unlock_failed"]);
    await w.first.service.lock();
    await expect(enrol(w)).rejects.toMatchObject({ code: "locked" });
    expect(w.fake.requests.create).toHaveLength(0);
  });

  it("a Phase 0 device-key vault: not_protected", async () => {
    const { legacyDeviceVault } = await import("../helpers/vaults");
    const { MemoryKV, createMutex } = await import("../../src/core/storage/kv");
    const { VaultStore } = await import("../../src/core/storage/store");
    const { PrfStore } = await import("../../src/core/service/prf-store");
    const { DeviceAdmin } = await import("../../src/core/service/device-admin");
    const { VaultService } = await import("../../src/core/service/service");
    const { KvSettingsStore, MemorySession } = await import("../../src/core/service/types");
    const { FakeAuthenticator } = await import("../helpers/fake-webauthn");
    const kv = new MemoryKV();
    const store = new VaultStore({ kv, lock: createMutex() });
    await legacyDeviceVault(store);
    const svc = new VaultService({
      store,
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
      prfs: new PrfStore(kv, createMutex()),
    });
    const admin = new DeviceAdmin(svc, new FakeAuthenticator());
    await expect(admin.enrol(STRONG, { name: "x", allowSynced: false })).rejects.toMatchObject({
      code: "not_protected",
    });
    expect((await admin.state()).available).toBe("no_password");
  });

  it("a profile declared shared: the synced opt-in refused (quick_off); a gate is kept but never armed", async () => {
    const w = await quickWorld({ pin: null, fake: { prf: false } });
    await w.first.service.updateSettings(applyPreset(await w.settings.get(), "shared"));
    await w.first.service.unlockWithPassword(STRONG);
    await expect(enrol(w, { allowSynced: true })).rejects.toMatchObject({ code: "quick_off" });
    expect(w.fake.requests.create).toHaveLength(0);
    expect(await enrol(w)).toMatchObject({ ok: true, mode: "gate" });
    expect(await quickOf(w)).toBeNull();
    expect((await w.first.device.state()).shared).toBe(true);
  });

  it("at most ten; a key change between the ceremony and the write saves nothing", async () => {
    const w = await quickWorld({ pin: null });
    for (let i = 0; i < 10; i++) {
      w.fake.creds.clear();
      expect((await enrol(w)).ok).toBe(true);
    }
    w.fake.creds.clear();
    await expect(enrol(w)).rejects.toMatchObject({ code: "bad_state", message: "device_full" });
    expect((await w.first.device.state()).full).toBe(true);
    const v = await quickWorld({ pin: null });
    v.fake.during = async () => {
      v.fake.during = null;
      await v.ctx().service.rotateKey(STRONG, NO_PAGE); // another page, during the OS dialog
    };
    await expect(enrol(v)).rejects.toMatchObject({ code: "bad_state" });
    expect(v.kv.data.has("sk_prf")).toBe(false);
  });
});

describe("the persistent device unlock (§5.4 'PRF unlock'; Q3)", () => {
  it("opens the vault after a lock and after a browser restart; it never arms the session quick unlock", async () => {
    const w = await enrolled();
    expect(await view(w)).toMatchObject({ state: "locked", device: { prf: true } });
    const r = await w.ctx().unlocker.unlockWithPrf();
    expect(r).toMatchObject({ ok: true, view: { state: "unlocked" } });
    expect(await quickOf(w)).toBeNull();
    restart(w);
    const page = w.ctx();
    expect(await page.service.openView()).toMatchObject({ state: "locked", device: { prf: true } });
    expect(await page.unlocker.unlockWithPrf()).toMatchObject({ ok: true });
    expect((await page.service.status()).state).toBe("unlocked");
    expect(await w.kinds()).toEqual(["prf_enrolled"]); // nothing recorded for a device unlock
  });

  it("two credentials: the one that answered opens it, not the first asked for (its passkey deleted in the OS)", async () => {
    const w = await quickWorld({ pin: null });
    await enrol(w);
    w.fake.creds.clear(); // the first one's passkey deleted in the OS; a second added (another authenticator)
    await enrol(w);
    const [a, b] = prfOf(w).creds;
    await w.first.service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true });
    expect(w.fake.requests.get.at(-1)!.allow).toEqual([a!.id, b!.id]); // both asked for; the second answered
    expect(await w.kinds()).not.toContain("prf_failed");
  });

  it("the PRF output is zeroed once used, opened or not (REVIEW S5)", async () => {
    for (const tamper of [null, "otherPrf"] as const) {
      const w = await enrolled();
      w.fake.tamperGet = tamper;
      const outs: Uint8Array[] = [];
      const get = w.fake.get.bind(w.fake);
      w.fake.get = async (r) => {
        const a = await get(r);
        if (a.prf) outs.push(a.prf);
        return a;
      };
      const r = await w.ctx().unlocker.unlockWithPrf();
      expect(r.ok, String(tamper)).toBe(tamper === null);
      expect(outs, String(tamper)).toHaveLength(1);
      expect(
        [...outs[0]!].every((x) => x === 0),
        String(tamper),
      ).toBe(true);
    }
  });

  it("the 14 days, enforced in the service: day 14 opens; a millisecond later 'due', with no ceremony asked for", async () => {
    const w = await enrolled();
    const at = prfOf(w).lastPasswordAt!;
    w.t.now = at + PRF_PASSWORD_MS;
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true });
    await w.ctx().service.lock();
    w.t.now = at + PRF_PASSWORD_MS + 1;
    const asked = w.fake.requests.get.length;
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "due" });
    expect(w.fake.requests.get).toHaveLength(asked);
    expect(await view(w)).toMatchObject({ device: { due: true } });
    // a time more than a day ahead of the clock (the clock was set back): due too
    w.t.now = at - DAY - 1;
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "due" });
    w.t.now = at - DAY;
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true });
  });

  it("the master password resets the 14 days (the lock screen notes it), at most once a day; a recovery key does not", async () => {
    const w = await enrolled();
    /** A master-password unlock on a lock screen that offers the device unlock: the unlock, then its note. */
    const typed = async () => {
      const page = w.ctx();
      await page.service.unlockWithPassword(STRONG);
      await page.unlocker.notePasswordTyped();
    };
    const at = prfOf(w).lastPasswordAt!;
    w.t.now = at + DAY - 1;
    await typed();
    expect(prfOf(w).lastPasswordAt).toBe(at); // less than a day: not written
    w.t.now = at + DAY;
    await w.ctx().service.lock();
    await w.ctx().service.unlockWithPassword(STRONG);
    expect(prfOf(w).lastPasswordAt).toBe(at); // the service's unlock itself writes nothing of sk_prf
    await typed();
    expect(prfOf(w).lastPasswordAt).toBe(at + DAY);
    w.t.now = at + DAY + PRF_PASSWORD_MS + 1;
    await w.ctx().service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "due" });
    await w.ctx().service.unlockWithRecoveryCode(w.recoveryCode);
    expect(prfOf(w).lastPasswordAt).toBe(at + DAY); // the recovery key proves the root, not the password
    await w.ctx().service.lock();
    await typed();
    await w.ctx().service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true });
    // a time ahead of the clock (the clock was set back) is written again at once
    w.kv.data.set("sk_prf", { ...prfOf(w), lastPasswordAt: w.t.now + 5 });
    await typed();
    expect(prfOf(w).lastPasswordAt).toBe(w.t.now);
  });

  it("an answer that does not open the wrap: prf_failed recorded (never unlock_failed), no session", async () => {
    for (const t of ["otherPrf", "noPrf", "uv", "otherCredential"] as const) {
      const w = await enrolled();
      if (t === "otherCredential") {
        w.fake.creds.set("b3RoZXItY3JlZGVudGlhbC1pZA", [...w.fake.creds.values()][0]!); // one this vault never enrolled
      }
      w.fake.tamperGet = t;
      expect(await w.ctx().unlocker.unlockWithPrf(), t).toEqual({ ok: false, reason: "failed" });
      expect((await w.ctx().service.status()).state, t).toBe("locked");
      expect(await w.kinds(), t).toEqual(["prf_enrolled", "prf_failed"]);
    }
    // a wrap edited on disk
    const w = await enrolled();
    const rec = prfOf(w);
    const ct = fromB64(rec.creds[0]!.wrap!.wrapped);
    ct[0]! ^= 1;
    rec.creds[0]!.wrap!.wrapped = toB64(ct);
    w.kv.data.set("sk_prf", rec);
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "failed" });
    expect(await w.kinds()).toEqual(["prf_enrolled", "prf_failed"]);
  });

  it("a cancel records nothing; a passkey deleted in the OS looks the same; the master password still works", async () => {
    const w = await enrolled();
    w.fake.tamperGet = "cancel";
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "cancelled" });
    w.fake.tamperGet = null;
    w.fake.creds.clear(); // removed in the OS
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "cancelled" });
    expect(await w.kinds()).toEqual(["prf_enrolled"]);
    const page = w.ctx();
    await page.service.unlockWithPassword(STRONG);
    await page.device.remove(STRONG, prfOf(w).creds[0]!.id); // "Not working on this computer? Remove"
    expect(w.kv.data.has("sk_prf")).toBe(false);
    await page.service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "ended" });
  });

  it("a lock during the OS dialog voids the new session: 'locked'", async () => {
    const w = await enrolled();
    w.fake.during = () => w.ctx().service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "locked" });
    expect((await w.ctx().service.status()).state).toBe("locked");
  });

  it("a key change pauses it (wraps set aside, credentials kept): 'paused', nothing tried; one touch turns it back on", async () => {
    const w = await enrolled();
    const page = w.ctx();
    await page.service.unlockWithPassword(STRONG);
    await codeOf((d) => page.service.rotateKey(STRONG, d));
    const c = prfOf(w).creds[0]!;
    expect(c.wrap).toBeNull();
    await page.service.lock();
    const asked = w.fake.requests.get.length;
    expect(await view(w)).toMatchObject({ device: { paused: true } });
    expect(await w.ctx().unlocker.unlockWithPrf()).toEqual({ ok: false, reason: "paused" });
    expect(w.fake.requests.get).toHaveLength(asked);
    expect(await w.kinds()).not.toContain("prf_failed");
    await page.service.unlockWithPassword(STRONG);
    expect((await page.device.state()).creds[0]!.paused).toBe(true);
    await expect(page.device.reenable("wrong password", c.id)).rejects.toMatchObject({ code: "wrong_secret" });
    w.kv.data.set("sk_prf", { ...prfOf(w), lastPasswordAt: w.t.now - 3 * DAY }); // the master password typed 3 days ago
    expect(await page.device.reenable(STRONG, c.id)).toEqual({ ok: true, mode: "prf", synced: false });
    expect(prfOf(w).lastPasswordAt).toBe(w.t.now); // it was typed again for this: the 14 days restart (Q3)
    const back = prfOf(w).creds[0]!;
    expect(back.salt).not.toBe(c.salt); // a new salt
    expect(back.wrap!.vkId).toBe((await page.service.currentGeneration())!.keyring.vkId);
    await page.service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true });
  });

  it("turning back on refuses an answer without user verification, or naming another credential: nothing written", async () => {
    for (const t of ["uv", "wrongId", "otherCredential"] as const) {
      const w = await enrolled();
      const page = w.ctx();
      await page.service.unlockWithPassword(STRONG);
      await codeOf((d) => page.service.rotateKey(STRONG, d));
      const c = prfOf(w).creds[0]!;
      expect(c.wrap, t).toBeNull();
      // another passkey of the authenticator to answer with (its PRF the same: only the id tells them apart)
      if (t === "otherCredential") w.fake.creds.set("b3RoZXItcGFzc2tleS1oZXJlMDE", { ...w.fake.creds.get(c.id)! });
      w.fake.tamperGet = t;
      expect(await page.device.reenable(STRONG, c.id), t).toEqual({ ok: false, reason: "refused" });
      expect(prfOf(w).creds[0], t).toEqual(c); // still paused, the old salt
    }
  });

  it("a changed password (same vault key) keeps it working; the cleanup reports it current", async () => {
    const w = await enrolled();
    const page = w.ctx();
    await page.service.unlockWithPassword(STRONG);
    await page.service.changePassword(STRONG, STRONG2);
    await page.service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true });
  });

  it("in a profile declared shared it still opens (asked at every opening), with the key in that page's memory only", async () => {
    const w = await enrolled();
    const page = w.ctx();
    await page.service.unlockWithPassword(STRONG);
    await page.service.updateSettings(applyPreset(await w.settings.get(), "shared"));
    const popup = w.ctx();
    expect(await popup.unlocker.unlockWithPrf()).toMatchObject({ ok: true });
    expect(w.area.data).toBeNull(); // "lock every time": not in chrome.storage.session
    expect((await popup.service.status()).state).toBe("unlocked");
  });

  it("never a way past the master password: exports, a new code and the permanent delete still ask for it", async () => {
    const w = await enrolled();
    const page = w.ctx();
    await page.unlocker.unlockWithPrf();
    await expect(page.service.verifyPassword("")).rejects.toMatchObject({ code: "empty_password" });
    await expect(page.service.purgeForever([], "")).rejects.toBeTruthy();
    await expect(page.service.newRecoveryCode("not it", NO_PAGE)).rejects.toMatchObject({ code: "wrong_secret" });
  });
});

describe("the session gate (§5.4 'Gate unlock')", () => {
  it("a gate credential planted in the profile's storage, of an authenticator that answers, is never asked for (REVIEW S1)", async () => {
    const w = await enrolled({ prf: false }); // a gate, armed
    const real = prfOf(w).creds[0]!;
    // the planter's own credential for this origin, made outside Sixkey, with the real one's MAC copied, or one under
    // this key's id that is not a MAC, or none
    const made = await w.fake.create({
      challenge: new Uint8Array(32),
      userId: new Uint8Array(16),
      displayName: "x",
      exclude: [],
      prfSalt: new Uint8Array(32),
    });
    const planted = { ...real, id: made.id, publicKey: toB64(made.publicKey!), alg: made.alg as -7 };
    for (const mac of [real.mac, { vkId: real.mac!.vkId, tag: toB64(new Uint8Array(32)) }, undefined]) {
      w.kv.data.set("sk_prf", { ...prfOf(w), creds: [{ ...planted, mac }] });
      const asked = w.fake.requests.get.length;
      await expect(w.ctx().unlocker.unlockWithGate(), JSON.stringify(mac)).resolves.toEqual({
        ok: false,
        reason: "ended",
      });
      expect(w.fake.requests.get, JSON.stringify(mac)).toHaveLength(asked); // no OS dialog for it
      expect((await w.ctx().service.openView()).state).toBe("locked");
      await w.ctx().service.unlockWithPassword(STRONG); // arms again, if the gate counts at all
      await w.ctx().service.lock();
    }
    // the real one, put back, still opens
    w.kv.data.set("sk_prf", { ...prfOf(w), creds: [real] });
    await w.ctx().service.unlockWithPassword(STRONG);
    await w.ctx().service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
  });

  it("a key change pauses a gate as a PRF one: not armed, the PIN alone, 'paused'; turned back on it opens again", async () => {
    const w = await enrolled({ prf: false }, { pin: PIN });
    const page = w.ctx();
    await page.service.unlockWithPassword(STRONG);
    await codeOf((d) => page.service.rotateKey(STRONG, d));
    const c = prfOf(w).creds[0]!;
    const vkId = (await page.service.currentGeneration())!.keyring.vkId;
    expect(c.mac!.vkId).not.toBe(vkId); // made under the old key: it no longer counts
    expect((await page.device.state()).creds[0]).toMatchObject({ mode: "gate", paused: true });
    await page.service.lock();
    const lockPage = w.ctx().service;
    await lockPage.unlockWithPassword(STRONG);
    await notePassword(lockPage); // the lock screen's note: the PIN's record, paused by the key change, made again
    expect(await quickOf(w)).toBeNull(); // a paused gate is not armed
    await w.ctx().service.lock();
    expect(await lockScreen(w)).toMatchObject({ state: "locked", device: { paused: true }, field: { digits: 6 } });
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    // turn back on: the master password, one touch, a new MAC under the current key; the gate armed again at once
    const p2 = w.ctx();
    await p2.service.unlockWithPassword(STRONG);
    w.fake.tamperGet = "wrongId";
    expect(await p2.device.reenable(STRONG, c.id)).toEqual({ ok: false, reason: "refused" });
    w.fake.tamperGet = "signature";
    expect(await p2.device.reenable(STRONG, c.id)).toEqual({ ok: false, reason: "refused" });
    expect(prfOf(w).creds[0]).toEqual(c); // nothing written
    w.fake.tamperGet = null;
    expect(await p2.device.reenable(STRONG, c.id)).toEqual({ ok: true, mode: "gate", synced: false });
    expect(prfOf(w).creds[0]!.mac!.vkId).toBe(vkId);
    expect(prfOf(w).creds[0]!.publicKey).toBe(c.publicKey);
    expect(await quickOf(w)).toMatchObject({ method: "device" }); // armed again, from now
    await p2.service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
  });

  it("reopens Sixkey after a soft lock with a checked assertion; the arming stays for the next lock", async () => {
    const w = await enrolled({ prf: false });
    expect(await view(w)).toMatchObject({ state: "locked", device: { gate: true } });
    expect((await view(w)).state === "locked" && ((await view(w)) as { quick?: unknown }).quick).toBeFalsy();
    const r = await w.ctx().unlocker.unlockWithGate();
    expect(r).toMatchObject({ ok: true, view: { state: "unlocked" } });
    expect(w.fake.requests.get.at(-1)!.prf).toBeUndefined(); // no PRF asked of a gate
    expect(w.fake.requests.get.at(-1)!.challenge).toHaveLength(32);
    expect(await quickOf(w)).toMatchObject({ method: "device" });
    await w.ctx().service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
  });

  it("each clause of the check refuses on its own: prf_failed, no session, the arming kept", async () => {
    for (const t of [
      "uv",
      "up",
      "challenge",
      "origin",
      "type",
      "crossOrigin",
      "rpIdHash",
      "signature",
      "otherKey",
    ] as const) {
      const w = await enrolled({ prf: false });
      w.fake.tamperGet = t;
      expect(await w.ctx().unlocker.unlockWithGate(), t).toEqual({ ok: false, reason: "failed" });
      expect((await w.ctx().service.status()).state, t).toBe("locked");
      expect(await w.kinds(), t).toEqual(["prf_enrolled", "prf_failed"]);
      w.fake.tamperGet = null;
      expect(await w.ctx().unlocker.unlockWithGate(), t).toMatchObject({ ok: true });
    }
  });

  it("an answer from a credential not asked for is refused", async () => {
    const w = await enrolled({ prf: false });
    w.fake.creds.set("b3RoZXItY3JlZGVudGlhbC1pZA", [...w.fake.creds.values()][0]!);
    w.fake.tamperGet = "otherCredential";
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "failed" });
  });

  it("ends at a browser restart: the master password once, which arms it again; the lock screen says so", async () => {
    const w = await enrolled({ prf: false });
    restart(w);
    expect(await view(w)).toMatchObject({ state: "locked", device: { waiting: true } });
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    const page = w.ctx();
    await page.service.unlockWithPassword(STRONG);
    expect(await quickOf(w)).toMatchObject({ method: "device", armedAt: w.t.now });
    await page.service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
  });

  it("12 hours from the master password (exactly 12 still counts), and a clock set back by more than a minute, end it", async () => {
    const w = await enrolled({ prf: false });
    const q = (await quickOf(w))!;
    w.t.now = q.expiresAt;
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
    await w.ctx().service.lock();
    w.t.now = q.expiresAt + 1;
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    expect(await quickOf(w)).toBeNull();
    const v = await enrolled({ prf: false });
    v.t.now -= 60_001;
    expect(await v.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    // and the service worker's alarm deletes an expired one with no page open, and keeps a live one
    const u = await enrolled({ prf: false });
    expect(await u.ctx().service.enforceQuickExpiry()).toBe((await quickOf(u))!.expiresAt);
    u.t.now += QUICK_TTL_MS + 1;
    expect(await u.ctx().service.enforceQuickExpiry()).toBeNull();
    expect(await quickOf(u)).toBeNull();
  });

  it("hard locks end it (§5.5): End quick unlock now, a shared profile, a key change, a removal", async () => {
    const steps: [string, (w: QuickWorld) => Promise<unknown>][] = [
      ["end now", (w) => w.ctx().admin.endQuickUnlock()],
      ["shared", async (w) => w.ctx().service.updateSettings(applyPreset(await w.settings.get(), "shared"))],
      ["password", (w) => w.first.service.changePassword(STRONG, STRONG2)],
      ["rotation", (w) => codeOf((d) => w.first.service.rotateKey(STRONG, d))],
      ["new code", (w) => codeOf((d) => w.first.service.newRecoveryCode(STRONG, d))],
      ["removal", async (w) => w.first.device.remove(STRONG, prfOf(w).creds[0]!.id)],
    ];
    for (const [what, step] of steps) {
      const w = await quickWorld({ pin: null, fake: { prf: false } });
      await enrol(w);
      await step(w);
      await w.ctx().service.lock();
      expect(await w.ctx().unlocker.unlockWithGate(), what).toEqual({ ok: false, reason: "ended" });
      expect(await quickOf(w), what).toBeNull();
    }
  });

  it("a soft lock keeps it: Lock now, the lock command, the idle timer", async () => {
    const w = await enrolled({ prf: false });
    await w.ctx().service.lock();
    await w.ctx().service.lock();
    expect(await quickOf(w)).toMatchObject({ method: "device" });
  });

  // OWNER-DECISIONS/26 (2026-11-24): a change of lock mode no longer locks, nor ends the gate
  it("a change of lock mode keeps it, and the session too", async () => {
    const w = await quickWorld({ pin: null, fake: { prf: false } });
    await enrol(w);
    const s = w.ctx().service;
    await s.updateSettings({ ...(await w.settings.get()), autoLock: { mode: "session" } });
    expect((await s.status()).state).toBe("unlocked");
    expect(await quickOf(w)).toMatchObject({ method: "device" });
  });

  it("never in a profile declared shared: refused and swept, even if one was written", async () => {
    const w = await enrolled({ prf: false });
    const q = (await quickOf(w))!;
    await w.settings.set(applyPreset(await w.settings.get(), "shared"));
    await w.area.setQuick(q); // written by a page that had not seen the switch
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    expect(await quickOf(w)).toBeNull();
    const page = w.ctx();
    await page.service.unlockWithPassword(STRONG);
    expect(await quickOf(w)).toBeNull(); // the master password never arms it there
  });

  it("an arming ended or a lock during the OS dialog: 'ended' / 'locked', no session", async () => {
    const a = await enrolled({ prf: false });
    a.fake.during = () => a.ctx().admin.endQuickUnlock();
    expect(await a.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    const b = await enrolled({ prf: false });
    b.fake.during = () => b.ctx().service.lock();
    expect(await b.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "locked" });
    expect((await b.ctx().service.status()).state).toBe("locked");
    // a removal in a page that still holds its key (a settings tab in "lock every time"): its writes, in its order
    const c = await enrolled({ prf: false });
    c.fake.during = async () => {
      await c.area.clearQuick(); // the gate's arming first
      c.kv.data.delete("sk_prf"); // then the credential
    };
    expect(await c.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    expect((await c.ctx().service.status()).state).toBe("locked");
  });

  it("an arming whose gate credential is gone (sk_prf deleted by hand) is not offered on the lock screen, nor opens", async () => {
    const w = await enrolled({ prf: false }); // a gate, armed at enrolment
    expect(await view(w)).toMatchObject({ state: "locked", device: { gate: true } });
    w.kv.data.delete("sk_prf");
    const v = (await view(w)) as { state: string; device?: unknown };
    expect(v.state).toBe("locked");
    expect(v.device).toBeUndefined(); // no button: there is nothing to check an answer against
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
  });

  it("an arming whose parked key was edited is refused (its id is checked)", async () => {
    const w = await enrolled({ prf: false });
    const q = (await quickOf(w)) as QuickDevice;
    await w.area.setQuick({ ...q, vk: toB64(new Uint8Array(32).fill(7)) });
    await expect(w.ctx().unlocker.unlockWithGate()).resolves.toEqual({ ok: false, reason: "ended" }); // an answer, never a throw
  });
});

describe("the PIN and the gate side by side (OWNER-DECISIONS/17 Q1; OWNER-DECISIONS/20, 2026-10-30): either opens, each its own", () => {
  it("with a gate and a PIN, the master password arms the gate (sk_quick, alone); the PIN is its record's; the lock screen offers both; either opens", async () => {
    const w = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(w);
    await w.first.service.lock();
    w.t.now += 60_000;
    await w.ctx().service.unlockWithPassword(STRONG);
    const q = (await quickOf(w))!;
    expect(q).toMatchObject({ method: "device", armedAt: w.t.now, expiresAt: w.t.now + QUICK_TTL_MS });
    await w.ctx().service.lock();
    expect(await lockScreen(w)).toMatchObject({
      state: "locked",
      pin: "pin",
      field: { digits: 6, triesLeft: 5 },
      device: { gate: true },
    });
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
    await w.ctx().service.lock();
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true });
    await w.ctx().service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
    expect(await quickOf(w)).toEqual(q); // neither unlock spent or moved anything of the other's
    expect(await w.ctx().admin.state()).toMatchObject({
      pin: { digits: 6 },
      restart: { state: "pin", triesLeft: 5 },
      gate: { armed: true },
    });
    expect(await w.first.device.state()).toMatchObject({ pin: true, armed: true });
  });

  it("the gate's 12 hours end the gate only: the PIN still opens (it has no time limit); the next master password arms the gate from then", async () => {
    const w = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(w);
    const q = (await quickOf(w))!;
    await w.first.service.lock();
    w.t.now = q.expiresAt - 1;
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
    expect(await quickOf(w)).toMatchObject({ armedAt: q.armedAt, expiresAt: q.expiresAt });
    await w.ctx().service.lock();
    w.t.now = q.expiresAt + 1; // past the 12 hours from the master password
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true });
    await w.ctx().service.lock();
    await w.ctx().service.unlockWithPassword(STRONG);
    expect(await quickOf(w)).toMatchObject({ method: "device", armedAt: w.t.now });
  });

  it("the 5th wrong PIN ends the gate's arming too (someone is guessing at the keyboard); so does End quick unlock now; a key change ends it and pauses the PIN", async () => {
    const w = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(w);
    await w.first.service.lock();
    for (let i = 0; i < 4; i++) expect((await pinIn(w.ctx().service, "135790")).ok).toBe(false);
    expect(await quickOf(w)).toMatchObject({ method: "device" }); // a wrong PIN spends the PIN's tries only
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true }); // the gate still opens, with a try left
    await w.ctx().service.lock();
    expect(await pinIn(w.ctx().service, "135790")).toEqual({ ok: false, reason: "exhausted" });
    expect(await quickOf(w)).toBeNull();
    await expect(w.ctx().unlocker.unlockWithGate()).resolves.toEqual({ ok: false, reason: "ended" });
    // End quick unlock now (the PIN box's, and the device box's): both
    const e = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(e);
    await e.first.admin.endQuickUnlock();
    expect(await quickOf(e)).toBeNull();
    expect(await pinIn(e.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    // a key change ends the gate's arming (committed()) and pauses the PIN's record
    const k = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(k);
    await codeOf((d) => k.first.service.rotateKey(STRONG, d));
    expect(await quickOf(k)).toBeNull();
    await k.first.service.lock();
    expect(await lockScreen(k)).toMatchObject({ pin: "paused" });
  });

  it("each is its own: a PIN typed with only the gate set up is refused, the arming untouched; a gate unusable beside the PIN leaves the PIN", async () => {
    // the gate alone (no PIN): a PIN typed anyway is refused, the arming untouched
    const g = await enrolled({ prf: false });
    const gate = await quickOf(g);
    expect(gate).toMatchObject({ method: "device" });
    expect(await pinIn(g.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    expect(await quickOf(g)).toEqual(gate);
    // both: the gate credential gone (sk_prf deleted by hand): the gate refuses and its arming goes (nothing can answer
    // for it: REVIEW-r2 G2); the PIN still opens
    const w = await enrolled({ prf: false }, { pin: PIN });
    w.kv.data.delete("sk_prf");
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    expect(await quickOf(w)).toBeNull();
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true });
  });

  it("the gate's arming taken away during the OS dialog (its last credential removed elsewhere): 'ended', the PIN untouched", async () => {
    const w = await enrolled({ prf: false }, { pin: PIN });
    const pinRec = JSON.stringify(w.kv.data.get("sk_pin_restart"));
    w.fake.during = async () => {
      await w.area.clearQuick(); // as the removal of the last gate leaves it
    };
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    w.fake.during = null;
    expect(await quickOf(w)).toBeNull();
    expect(JSON.stringify(w.kv.data.get("sk_pin_restart"))).toBe(pinRec);
  });

  it("a planted gate (a MAC that names this key but is not one) leaves no dead button: its arming goes at the first press (REVIEW-r2 G2)", async () => {
    for (const pin of [PIN, null]) {
      const w = await quickWorld({ pin, fake: { prf: false } });
      await enrol(w);
      const real = prfOf(w).creds[0]!;
      const planted = { ...real, mac: { vkId: real.mac!.vkId, tag: toB64(new Uint8Array(32).fill(9)) } };
      w.kv.data.set("sk_prf", { ...prfOf(w), creds: [planted] });
      await w.first.service.lock();
      await w.ctx().service.unlockWithPassword(STRONG); // the main chunk counts it: the gate's arming is made
      await w.ctx().service.lock();
      expect(await view(w), String(pin)).toMatchObject({ state: "locked", device: { gate: true } });
      const asked = w.fake.requests.get.length;
      expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
      expect(w.fake.requests.get).toHaveLength(asked); // no OS dialog for it
      const v = (await view(w)) as { state: string; device?: { gate?: true } };
      expect(v.device?.gate, String(pin)).toBeUndefined(); // the button is gone
      expect(await quickOf(w)).toBeNull();
      if (pin) expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true }); // the PIN stays
    }
  });

  it("the gate's arming is of no use once the keyring's wraps changed, even if the page died after the commit, before it cleared the arming: 'ended' (review of PINONE, PO-10; QUICKPIN-REVIEW M1)", async () => {
    const w = await enrolled({ prf: false });
    await w.ctx().service.unlockWithPassword(STRONG); // arms the gate
    await w.ctx().service.lock();
    expect(await view(w)).toMatchObject({ state: "locked", device: { gate: true } });
    const wraps = async () => JSON.stringify((await w.ctx().service.currentGeneration())!.keyring.wraps);
    const before = await wraps();
    // a page whose security-record write never returns: it died right there, after the keyring's commit and before
    // committed() could end the gate's arming
    const c = w.ctx();
    (c.service as unknown as { security: { append: (k: string) => Promise<void> } }).security.append = () =>
      new Promise<never>(() => undefined);
    void c.service.changePassword(STRONG, STRONG2);
    for (let i = 0; i < 400 && (await wraps()) === before; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await wraps()).not.toBe(before); // the new password is committed (the same vault key)
    await new Promise((r) => setTimeout(r, 20));
    expect(await quickOf(w)).not.toBeNull(); // the arming is still there: the page died before it could end it
    const asked = w.fake.requests.get.length;
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    expect(w.fake.requests.get).toHaveLength(asked); // no OS dialog for it
    expect((await w.ctx().service.openView()).state).toBe("locked");
  });

  it("a store that cannot be read during a gate unlock leaves both as they are ('ended', nothing dropped)", async () => {
    const w = await enrolled({ prf: false }, { pin: PIN });
    const before = await quickOf(w);
    const stash = [...w.kv.data.entries()].filter(([k]) => /^sk_(slot|active|snap|keyring)/.test(k));
    for (const [k] of stash) w.kv.data.delete(k); // unreadable for the moment
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    for (const [k, v] of stash) w.kv.data.set(k, v);
    expect(await quickOf(w)).toEqual(before); // a moment's unreadable store is not the arming's fault
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true });
  });

  it("a re-arm from another page during the gate unlock's look is left alone (REVIEW-r3 H1, G2r)", async () => {
    const w = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(w);
    await w.first.service.lock();
    const rec = w.kv.data.get("sk_prf");
    w.kv.data.delete("sk_prf"); // this unlock reads no gate credential: nothing can answer for the gate's half
    const page = w.ctx();
    const svc = page.service as unknown as { vkOf: (raw: Uint8Array) => Promise<unknown> };
    const vkOf = svc.vkOf.bind(page.service);
    svc.vkOf = async (raw) => {
      // meanwhile, another page: the credential back, a master password, a new arming of both from a later time
      w.kv.data.set("sk_prf", rec);
      w.t.now += 1_000;
      await w.ctx().service.unlockWithPassword(STRONG);
      await w.ctx().service.lock();
      return vkOf(raw);
    };
    const armedBefore = (await quickOf(w))!.armedAt;
    expect(await page.unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" });
    const q = (await quickOf(w))!;
    expect(q.armedAt).toBeGreaterThan(armedBefore); // the other page's arming
    expect(q.method).toBe("device"); // not taken away by this stale look
    expect((await w.ctx().unlocker.unlockWithGate()).ok).toBe(true);
  });

  it("a PIN set-up whose ciphertext is damaged (its shape intact) never stops the gate: armed at the unlock and at an enrolment (REVIEW-r2 G3)", async () => {
    const w = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(w);
    const rec = w.kv.data.get("sk_pin") as { wrapped: string };
    const bytes = fromB64(rec.wrapped);
    bytes[0]! ^= 1; // the ciphertext damaged, its shape intact
    w.kv.data.set("sk_pin", { ...rec, wrapped: toB64(bytes) });
    await w.first.service.lock();
    restart(w);
    await w.ctx().service.unlockWithPassword(STRONG); // arm()
    expect(await quickOf(w)).toMatchObject({ method: "device" });
    await w.ctx().service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
    // and the PIN's record, made before the damage, does not need sk_pin's ciphertext: the PIN still opens
    await w.ctx().service.lock();
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true });
    // and an enrolment (armGate): the gate alone too
    const g = await quickWorld({ pin: PIN, fake: { prf: false } });
    const r2 = g.kv.data.get("sk_pin") as { wrapped: string };
    const b2 = fromB64(r2.wrapped);
    b2[0]! ^= 1;
    g.kv.data.set("sk_pin", { ...r2, wrapped: toB64(b2) });
    await enrol(g);
    expect(await quickOf(g)).toMatchObject({ method: "device" });
  });

  it("setting and removing the PIN never touch the gate's arming", async () => {
    const w = await quickWorld({ pin: null, fake: { prf: false } });
    await enrol(w); // the gate alone: no PIN yet
    const gate = (await quickOf(w))!;
    expect(gate).toMatchObject({ method: "device" });
    w.t.now += 60_000;
    await w.first.admin.setPin(STRONG, PIN);
    expect(await quickOf(w)).toEqual(gate);
    w.t.now += 60_000;
    await w.first.admin.removePin(STRONG);
    expect(await quickOf(w)).toEqual(gate);
    await w.first.service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
  });

  it("after a restart the lock screen says the gate waits for the master password, and offers the PIN, which works", async () => {
    const w = await enrolled({ prf: false }, { pin: PIN });
    restart(w);
    expect(await lockScreen(w)).toMatchObject({ state: "locked", device: { waiting: true }, pin: "pin" });
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true });
  });

  it("a gate with a MAC of this key's id but no public key is not one: nothing is armed for it (REVIEW S2)", async () => {
    const w = await quickWorld({ pin: PIN });
    await enrol(w); // a PRF credential
    const vkId = (await w.first.service.currentGeneration())!.keyring.vkId;
    const junk = { ...prfOf(w).creds[0]!, id: "anVuay1nYXRlLWNyZWRlbnRpYWw", mode: "gate", mac: { vkId, tag: "AAAA" } };
    delete (junk as Partial<PrfCred>).salt;
    delete (junk as Partial<PrfCred>).wrap;
    w.kv.data.set("sk_prf", { ...prfOf(w), creds: [...prfOf(w).creds, junk] });
    await w.first.service.lock();
    await w.ctx().service.unlockWithPassword(STRONG);
    expect(await quickOf(w)).toBeNull();
  });
});

describe('turning back on right after this page\'s key change, and "Also after a restart" (OWNER-DECISIONS/17 Q3, Q4)', () => {
  it("right after this page's own key change: one touch, no master password again; another page or 10 minutes later: asked", async () => {
    for (const fake of [{}, { prf: false }]) {
      const w = await enrolled(fake, { pin: PIN });
      const page = w.ctx();
      await page.service.unlockWithPassword(STRONG);
      await codeOf((d) => page.service.rotateKey(STRONG, d));
      const c = prfOf(w).creds[0]!;
      expect((await page.device.state()).creds[0]!.paused, JSON.stringify(fake)).toBe(true);
      // another page, unlocked by the same session, did not change the key itself: the master password is asked
      await expect(w.ctx().device.reenable(null, c.id)).rejects.toMatchObject({ code: "wrong_secret" });
      // more than 10 minutes after it: asked as well
      expect(rotatedBy(page.service)).toMatchObject({ vkId: expect.any(String), at: w.t.now }); // this page's own, noted
      const r = rotatedBy(page.service)!;
      r.at -= 10 * 60_000 + 1;
      await expect(page.device.reenable(null, c.id)).rejects.toMatchObject({ code: "wrong_secret" });
      r.at += 10 * 60_000 + 1;
      // a note dated after now (the clock moved back since): no proof either (REVIEW-r2 G5)
      r.at += 10 * 60_000;
      await expect(page.device.reenable(null, c.id)).rejects.toMatchObject({ code: "wrong_secret" });
      r.at -= 10 * 60_000;
      // a note of a key change to another key (one that was replaced again since) is no proof for this one
      const real = r.vkId;
      r.vkId = real.replace(/^./, (x) => (x === "0" ? "1" : "0"));
      await expect(page.device.reenable(null, c.id)).rejects.toMatchObject({ code: "wrong_secret" });
      r.vkId = real;
      expect(prfOf(w).creds[0]).toEqual(c); // nothing written
      const asked = w.fake.requests.get.length;
      w.t.now += 60_000; // a minute after the key change
      expect(await page.device.reenable(null, c.id)).toMatchObject({ ok: true, mode: c.mode });
      expect(w.fake.requests.get).toHaveLength(asked + 1); // one touch
      // the hours and the 14 days count from the master password typed for the key change, not from the touch
      expect(prfOf(w).lastPasswordAt).toBe(r.at);
      if (c.mode === "gate") expect(await quickOf(w)).toMatchObject({ method: "device", armedAt: r.at });
      expect((await page.device.state()).creds[0]!.paused).toBe(false);
      expect(await w.kinds()).not.toContain("unlock_failed"); // no password was checked, none failed
      await page.service.lock();
      const back = c.mode === "prf" ? await w.ctx().unlocker.unlockWithPrf() : await w.ctx().unlocker.unlockWithGate();
      expect(back).toMatchObject({ ok: true });
    }
  });

  it("a synced gate made one that also works after a restart, in place: one touch, no new passkey, the same credential", async () => {
    const w = await quickWorld({ pin: PIN, fake: { be: true, bs: true, aaguid: AAGUID.icloud } });
    expect(await enrol(w)).toMatchObject({ ok: true, mode: "gate", synced: true, refused: "synced" });
    const c = prfOf(w).creds[0]!;
    expect(await quickOf(w)).toMatchObject({ method: "device" });
    expect(await quickOf(w)).not.toBeNull();
    const creates = w.fake.requests.create.length;
    await expect(w.first.device.alsoAfterRestart("not it", c.id)).rejects.toMatchObject({ code: "wrong_secret" });
    for (const t of ["uv", "wrongId", "signature"] as const) {
      w.fake.tamperGet = t;
      expect(await w.first.device.alsoAfterRestart(STRONG, c.id), t).toEqual({ ok: false, reason: "refused" });
      expect(prfOf(w).creds[0], t).toEqual(c); // nothing written
    }
    // its provider gives no PRF after all: it stays a gate, and the answer says why (dvNoPrf), nothing written
    w.fake.tamperGet = "noPrf";
    await expect(w.first.device.alsoAfterRestart(STRONG, c.id)).resolves.toEqual({
      ok: true,
      mode: "gate",
      synced: true,
      refused: "no_prf",
    });
    expect(prfOf(w).creds[0]).toEqual(c);
    w.fake.tamperGet = null;
    expect(await w.first.device.alsoAfterRestart(STRONG, c.id)).toEqual({ ok: true, mode: "prf", synced: true });
    const now = prfOf(w).creds[0]!;
    expect(now).toMatchObject({ id: c.id, mode: "prf", synced: true, provider: "icloud", name: c.name });
    expect(now.publicKey).toBeUndefined();
    expect(now.mac).toBeUndefined();
    expect(now.wrap!.vkId).toBe((await w.first.service.currentGeneration())!.keyring.vkId);
    expect(w.fake.requests.create).toHaveLength(creates); // no new passkey, none left behind in the provider
    expect(prfOf(w).lastPasswordAt).toBe(w.t.now); // the 14 days start
    expect(await quickOf(w)).toBeNull(); // the last gate gone: its arming with it (the PIN is its own record's)
    restart(w);
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true }); // after a restart too
  });

  it("only a synced gate of Sixkey's own, in a solo profile: a PRF one, a device-bound gate, a planted one, a shared profile", async () => {
    const w = await quickWorld({ pin: null, fake: { be: true, bs: true } });
    await enrol(w);
    const c = prfOf(w).creds[0]!;
    // planted: a credential of an authenticator that answers, made outside Sixkey, with the real one's MAC copied
    const made = await w.fake.create({
      challenge: new Uint8Array(32),
      userId: new Uint8Array(16),
      displayName: "x",
      exclude: [],
      prfSalt: new Uint8Array(32),
    });
    const planted = { ...c, id: made.id, publicKey: toB64(made.publicKey!), alg: made.alg as -7 };
    w.kv.data.set("sk_prf", { ...prfOf(w), creds: [c, planted] });
    const asked = w.fake.requests.get.length;
    expect(await w.first.device.alsoAfterRestart(STRONG, made.id)).toEqual({ ok: false, reason: "refused" });
    expect(w.fake.requests.get).toHaveLength(asked); // refused before any ceremony
    expect(prfOf(w).creds[1]).toEqual(planted); // nothing written
    w.kv.data.set("sk_prf", { ...prfOf(w), creds: [c] });
    const g = await quickWorld({ pin: null, fake: { prf: false } }); // device-bound, no PRF: not "synced"
    await enrol(g);
    await expect(g.first.device.alsoAfterRestart(STRONG, prfOf(g).creds[0]!.id)).rejects.toMatchObject({
      code: "bad_state",
    });
    const p = await quickWorld({ pin: null });
    await enrol(p); // already a PRF one
    await expect(p.first.device.alsoAfterRestart(STRONG, prfOf(p).creds[0]!.id)).rejects.toMatchObject({
      code: "bad_state",
    });
    await w.first.service.updateSettings(applyPreset(await w.settings.get(), "shared"));
    await expect(w.first.device.alsoAfterRestart(STRONG, c.id)).rejects.toMatchObject({ code: "quick_off" });
  });
});

describe("removal (§5.6), a new vault, and what is kept", () => {
  it("remove: master password first; the gate's arming first, then the credential, then prf_removed; the last takes the record", async () => {
    const w = await quickWorld({ pin: null, fake: { prf: false } });
    await enrol(w);
    const id = prfOf(w).creds[0]!.id;
    await expect(w.first.device.remove("not it", id)).rejects.toMatchObject({ code: "wrong_secret" });
    expect(prfOf(w).creds).toHaveLength(1);
    expect(await quickOf(w)).toMatchObject({ method: "device" });
    await w.first.device.remove(STRONG, id);
    expect(w.kv.data.has("sk_prf")).toBe(false);
    expect(await quickOf(w)).toBeNull();
    expect(await w.kinds()).toEqual(["prf_enrolled", "unlock_failed", "prf_removed"]);
    expect(w.fake.creds.size).toBe(1); // the passkey itself stays in the OS
  });

  it("End quick unlock now in the device box (the gate, no PIN): a hard lock, the gate's arming gone, quick_ended (REVIEW S9)", async () => {
    const w = await quickWorld({ pin: null, fake: { prf: false } });
    await enrol(w);
    expect((await w.first.device.state()).armed).toBe(true);
    expect((await w.first.device.state()).pin).toBe(false); // no PIN beside it: the box offers the button
    await w.first.device.endQuickUnlock();
    expect(await quickOf(w)).toBeNull();
    expect((await w.ctx().service.openView()).state).toBe("locked");
    expect((await w.kinds()).at(-1)).toBe("quick_ended");
  });

  it("removing a PRF credential or one of two gates leaves the arming; the last gate's takes it, and leaves the PIN", async () => {
    const w = await quickWorld({ pin: PIN, fake: { prf: false } });
    await enrol(w); // gate 1, armed
    const gate = (await quickOf(w))!;
    w.fake.creds.clear();
    await enrol(w); // gate 2 (another authenticator); armed again, from now
    w.fake.creds.clear();
    w.fake.o.prf = true;
    await enrol(w); // a PRF credential
    const [g1, g2, p] = prfOf(w).creds;
    expect([g1!.mode, g2!.mode, p!.mode]).toEqual(["gate", "gate", "prf"]);
    const armed = (await quickOf(w))!;
    w.t.now += 60_000;
    let writes = 0; // the arming left alone: not even ended and put back
    const clear = w.area.clearQuick.bind(w.area);
    w.area.clearQuick = async () => {
      writes++;
      return clear();
    };
    await w.first.device.remove(STRONG, p!.id);
    expect(await quickOf(w)).toEqual(armed); // no gate removed
    await w.first.device.remove(STRONG, g1!.id);
    expect(await quickOf(w)).toEqual(armed); // another gate still opens it
    expect(writes).toBe(0);
    expect(armed).toMatchObject({ method: "device" });
    await w.first.device.remove(STRONG, g2!.id);
    expect(await quickOf(w)).toBeNull(); // the last gate gone: its arming with it
    expect(gate.armedAt).toBeLessThanOrEqual(armed.armedAt);
    await w.first.service.lock();
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: true }); // the PIN, its own record's, stays
  });

  it("a new vault (start over, a restore with another id) removes the record; turning sync off would keep it", async () => {
    const w = await quickWorld({ pin: null });
    await enrol(w);
    const { createProtected } = await import("../helpers/vaults");
    // the stored data made unreadable, then a new vault in its place
    for (const k of [...w.kv.data.keys()]) if (/^sk_(slot|active|keyring|ptr)/.test(k)) w.kv.data.delete(k);
    const s = w.ctx().service;
    if ((await s.status()).state === "empty") await createProtected(s);
    else await s.startOver(await s.prepareKeys(STRONG));
    expect(w.kv.data.has("sk_prf")).toBe(false);
  });

  it("not vault data: a profile with only sk_prf opens as empty", async () => {
    const w = await quickWorld({ pin: null });
    await enrol(w);
    const rec = w.kv.data.get("sk_prf");
    const { MemoryKV, createMutex } = await import("../../src/core/storage/kv");
    const { VaultStore } = await import("../../src/core/storage/store");
    const kv = new MemoryKV();
    kv.data.set("sk_prf", rec);
    expect((await new VaultStore({ kv, lock: createMutex() }).load()).status).toBe("empty");
  });
});

describe("an unusable credential (written past the checks, by hand or a tool)", () => {
  it("one the popup's shape check lets through but the full check does not is never asked for: PRF and gate", async () => {
    const w = await quickWorld({ pin: null });
    await enrol(w); // a PRF credential
    const good = prfOf(w).creds[0]!;
    const junk = { ...good, id: "anVuay1wcmYtY3JlZGVudGlhbA", salt: toB64(new Uint8Array(16)) }; // a 16-byte salt
    w.kv.data.set("sk_prf", { ...prfOf(w), creds: [junk, good] });
    await w.first.service.lock();
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true });
    expect(w.fake.requests.get.at(-1)!.allow).toEqual([good.id]);
    const g = await enrolled({ prf: false }); // a gate, armed
    const gate = prfOf(g).creds[0]!;
    // its MAC checks (the MAC binds the vault, id, algorithm and key), the full check does not: a name of 41 code points
    const bad = { ...gate, name: "x".repeat(41) };
    g.kv.data.set("sk_prf", { ...prfOf(g), creds: [bad, gate] });
    expect(await g.ctx().unlocker.unlockWithGate()).toMatchObject({ ok: true });
    expect(g.fake.requests.get.at(-1)!.allow).toEqual([gate.id]);
  });

  it("never hides the usable ones, is dropped by the next write (the record heals), and never keeps the PIN away for good", async () => {
    const w = await quickWorld({ pin: PIN });
    await enrol(w); // a PRF credential
    const good = prfOf(w).creds[0]!;
    const junk = {
      id: "anVuay1nYXRlLWNyZWRlbnRpYWw",
      kind: "platform",
      mode: "gate",
      name: "x",
      synced: false,
      createdAt: 1,
    };
    w.kv.data.set("sk_prf", { ...prfOf(w), creds: [good, junk] }); // a gate with no public key
    const page = w.ctx();
    expect((await page.device.state()).creds.map((c) => c.id)).toEqual([good.id]); // the box lists the usable one
    await page.service.lock();
    // the popup's shape check counts the junk gate, so the master password arms the gate; the lock screen's note heals
    await page.service.unlockWithPassword(STRONG);
    await page.unlocker.notePasswordTyped();
    expect(prfOf(w).creds.map((c) => c.id)).toEqual([good.id]);
    await page.service.lock();
    expect(await w.ctx().unlocker.unlockWithGate()).toEqual({ ok: false, reason: "ended" }); // it never opened
    expect(await w.ctx().unlocker.unlockWithPrf()).toMatchObject({ ok: true }); // the usable one always did
    await w.ctx().service.lock();
    await w.ctx().service.unlockWithPassword(STRONG); // and now nothing is armed for the junk gate
    expect(await quickOf(w)).toBeNull();
    // an enrolment over it keeps the usable credential
    w.kv.data.set("sk_prf", { ...prfOf(w), creds: [good, junk] });
    w.fake.creds.clear();
    expect((await enrol(w)).ok).toBe(true);
    expect(prfOf(w).creds.map((c) => c.id)).toContain(good.id);
    expect(prfOf(w).creds.map((c) => c.id)).not.toContain(junk.id);
  });
});

describe("nothing secret on disk or in a log", () => {
  it("no PRF output, vault key, challenge or parked key in chrome.storage.local, the diagnostics or the security record", async () => {
    const w = await quickWorld({ pin: PIN, fake: {} });
    await enrol(w);
    const g = await quickWorld({ pin: null, fake: { prf: false } });
    await enrol(g);
    for (const x of [w, g]) {
      const page = x.ctx();
      await page.service.lock();
      if (x === w) {
        await page.unlocker.unlockWithPrf();
        x.fake.tamperGet = "otherPrf";
        await page.service.lock();
        await page.unlocker.unlockWithPrf();
      } else {
        await page.unlocker.unlockWithGate();
        x.fake.tamperGet = "signature";
        await page.service.lock();
        await page.unlocker.unlockWithGate();
      }
      const vk = (await x.first.service.currentGeneration())!.keyring.vkId;
      const disk = JSON.stringify([...x.kv.data.entries()]);
      const rec = prfOf(x);
      const secrets: string[] = [];
      const session = x.area.data?.vk ?? ((await quickOf(x)) as QuickDevice | null)?.vk;
      if (session) secrets.push(session); // the vault key as the session holds it
      for (const c of rec.creds) if (c.salt) secrets.push(toB64(x.fake.prfFor(c.id, fromB64(c.salt)))); // the PRF output
      for (const r of x.fake.requests.get) secrets.push(toB64(r.challenge));
      for (const s of secrets) {
        expect(disk, "chrome.storage.local").not.toContain(s);
        expect(x.diag.join("\n"), "diagnostics").not.toContain(s);
      }
      expect(disk).not.toContain("sk_quick");
      expect(vk).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("every write of sk_prf is one critical section under the vault lock (§7.3 item 16)", () => {
  it("the key change's step (PrfStore.reencrypt) and the lazy writer (updatePrf) write nothing while the lock is held, then both land", async () => {
    const w = await enrolled();
    const vkId = (await w.first.service.currentGeneration())!.keyring.vkId;
    // a wrap under an older key, as a key change finds it (another key's id of the same form)
    const older = vkId.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const rec = prfOf(w);
    w.kv.data.set("sk_prf", { ...rec, creds: rec.creds.map((c) => ({ ...c, wrap: { ...c.wrap!, vkId: older } })) });
    const before = JSON.stringify(w.kv.data.get("sk_prf"));
    let release!: () => void;
    const held = w.vaultLock(() => new Promise<void>((r) => (release = r))); // another page's critical section
    const step = w.first.prfs.reencrypt({ id: vkId } as Vk);
    const write = updatePrf(w.first.prfs, (r) => (r && r !== "damaged" ? { ...r, lastPasswordAt: 12_345 } : undefined));
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.stringify(w.kv.data.get("sk_prf"))).toBe(before); // neither wrote before the lock was theirs
    release();
    await held;
    expect(await step).toBe("rewritten");
    await write;
    // one after the other, each from what the one before wrote: the wrap set aside AND the time stored (no lost update)
    expect(prfOf(w).creds[0]!.wrap).toBeNull();
    expect(prfOf(w).lastPasswordAt).toBe(12_345);
  });
});
