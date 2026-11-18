// The PIN's record through the service (OWNER-DECISIONS/20 and its two 2026-10-30 notes; docs/design/notes/
// PIN-RESTART-NOTES.md §3–§5, §17, §18): made with the PIN (any PIN of 4 to 8 digits; the records made for 6 to 8 digits under
// the old switch open as they did), at the master password's count; the PIN after a browser restart or an extension
// reload; its counter, written before every derivation, in the vault lock; the 5th wrong PIN; the master password's note
// (never a recovery key's), which makes it again whenever it is not as it should be, and writes nothing when it is; every
// deletion, pause and what keeps it; "Turn back on" in Settings; "lock every time"; the attacks of §2.3 (a record rewritten,
// swapped back, planted, its counter rolled back); nothing secret on disk or in a log. The PIN's general rows (setting it,
// the locks, the migrations) are quick-pin-service.test.ts's.
import { describe, expect, it } from "vitest";
import { QUICK_TRIES, wrapsTag, type PinRecord } from "../../src/core/crypto/pin";
import type { RestartRecord } from "../../src/core/crypto/pin-restart";
import { openRestart, restartMac, restartOk, sealRestart } from "../../src/core/crypto/pin-restart-wrap";
import { fromB64 } from "../../src/core/crypto/bytes";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { REWRAPPED_MS } from "../../src/core/service/pin-restart-admin";
import { pinKit, type PinKit } from "../../src/core/service/pin-kit";
import { restartOffer } from "../../src/core/service/pin-restart-count";
import { unlock as viaRecord } from "../../src/core/service/pin-restart-steps";
import type { VaultService } from "../../src/core/service/service";
import { applyPreset } from "../../src/core/service/presets";
import { activeKeyring } from "../../src/core/storage/active-keyring";
import { LOCAL_ONLY_KEYS } from "../../src/core/storage/local-keys";
import { SERVER_SYNC_KEYS } from "../../src/platform/server-sync-leftovers";
import { NO_PAGE, STRONG, resetWithCode } from "../helpers/vaults";
import { notePassword, PIN, PIN2, quickWorld, restart, type QuickWorld } from "../helpers/quick-world";

const STRONG2 = "granite-river-compass-31";
const WRONG = "975310";
const KEY = "sk_pin_restart";

const rec = (w: QuickWorld) => w.kv.data.get(KEY) as RestartRecord | undefined;
/** The record, which must be stored (its absence fails an assertion here, not a property read later). */
const got = (w: QuickWorld): RestartRecord => {
  const r = rec(w);
  expect(r, "sk_pin_restart is stored").toBeDefined();
  return r!;
};
/** A record's wrap, which must be there (not set aside). */
const wrapOf = (r: RestartRecord) => {
  expect(r.wrap, "the record holds its wrap").not.toBeNull();
  return r.wrap!;
};
/**
 * What the popup's lock screen shows (src/popup/screens/Locked.tsx): openView, with what the PIN offers folded in as the
 * screen does (pin-restart-count.ts restartOffer, from what openView read): its state as `restart`, its field as `quick`.
 */
async function lockScreen(w: QuickWorld) {
  const svc = w.ctx().service;
  const v = await svc.openView();
  const o = v.state === "locked" ? restartOffer(svc, pinKit) : null;
  if (v.state !== "locked" || !o) return v;
  return { ...v, ...(o.field ? { quick: o.field } : {}), restart: o.state };
}
/** The lock screen's PIN, as Locked.tsx and UnlockBar.tsx route it: the record's own unlock, with the kit they hand it. */
const pinIn = (svc: VaultService, pin: string, kit: PinKit = pinKit) => viaRecord(svc, pin, kit);

describe("made with the PIN (PinAdmin.setPin): any PIN of 4 to 8 digits, at the master password's count", () => {
  it("one record: the vault key under the PIN's key, no try counted, made now; no switch to turn on", async () => {
    const w = await quickWorld();
    const r = got(w);
    expect(restartOk(r)).toBe(true);
    const pin = w.kv.data.get("sk_pin") as PinRecord;
    const k = (await w.first.service.currentGeneration())!.keyring;
    expect(r).toMatchObject({
      v: 1,
      vaultId: k.vaultId,
      vkId: k.vkId,
      setup: pin.kdf.salt,
      wraps: k.wraps.map((x) => x.wrapped).join(","),
      lastPasswordAt: w.t.now,
      fails: 0,
    });
    expect(wrapOf(r).kdf.iterations).toBe(600_000); // the tests' hook; the shipped count is held below
    expect(wrapOf(r).kdf.salt).not.toBe(pin.kdf.salt); // a salt of its own
    expect(await w.first.restart.state()).toMatchObject({ on: true, state: "pin", triesLeft: 5, byPin: false });
    expect(await w.kinds()).toEqual(["pin_set"]); // the switch's lines went with the switch
  });

  it("a PIN of 4 or 5 digits (OWNER-DECISIONS/20, 2026-10-30) has its record as any other, and it opens after a restart", async () => {
    for (const short of ["4826", "48263"]) {
      const w = await quickWorld({ pin: short });
      const r = got(w);
      expect(restartOk(r), short).toBe(true);
      expect(r.setup).toBe((w.kv.data.get("sk_pin") as PinRecord).kdf.salt);
      restart(w);
      expect(await lockScreen(w)).toMatchObject({ quick: { digits: short.length, triesLeft: 5 }, restart: "pin" });
      expect(await pinIn(w.ctx().service, WRONG.slice(0, short.length))).toMatchObject({ ok: false, reason: "wrong" });
      expect((await pinIn(w.ctx().service, short)).ok).toBe(true);
    }
  });

  it("records made before 2026-10-30 (6 to 8 digits, with the old switch; the record's shape has not changed) open as before", async () => {
    for (const pin of ["246813", "2468135", "24681357"]) {
      const w = await quickWorld({ pin });
      const r = got(w);
      expect(Object.keys(r).sort(), pin).toEqual(
        ["fails", "id", "lastPasswordAt", "mac", "setup", "v", "vaultId", "vkId", "wrap", "wraps"].sort(),
      );
      expect(r.v).toBe(1);
      restart(w);
      expect(await lockScreen(w)).toMatchObject({ quick: { digits: pin.length }, restart: "pin" });
      expect((await pinIn(w.ctx().service, pin)).ok, pin).toBe(true);
      expect(got(w)).toEqual(r); // used as it was: nothing made again, nothing migrated
    }
  });

  it("as shipped: the count of a new master-password wrap (2M), never below what the keyring's password wrap carries", async () => {
    const w = await quickWorld();
    const page = w.ctx({ deps: { kdfIterations: undefined } }); // no test hook: production's counts
    await page.admin.setPin(STRONG, PIN2);
    const r = got(w);
    expect(wrapOf(r).kdf.iterations).toBe(2_000_000);
    const k = (await page.service.currentGeneration())!.keyring;
    for (const wr of k.wraps.filter((x) => x.method === "password"))
      expect(wrapOf(r).kdf.iterations).toBeGreaterThanOrEqual((wr.kdf as { iterations: number }).iterations);
    // and it opens after a restart with the PIN, at that count
    restart(w);
    expect((await pinIn(page.service, PIN2)).ok).toBe(true);
  }, 60_000);
});

describe("after a browser restart or an extension reload: the PIN opens Sixkey with the record", () => {
  it("the lock screen offers the PIN (no master password first); the PIN opens; nothing is armed in session memory by it", async () => {
    const w = await quickWorld();
    restart(w);
    expect(await lockScreen(w)).toEqual({
      state: "locked",
      events: [],
      quick: { digits: 6, triesLeft: 5 },
      restart: "pin",
    });
    const popup = w.ctx().service;
    const r = await pinIn(popup, PIN);
    expect(r.ok).toBe(true);
    expect((await popup.openView()).state).toBe("unlocked");
    expect(w.area.quick).toBeNull(); // the gate's only: the next lock opens with the record again
    expect(got(w).fails).toBe(0);
    await popup.lock();
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("4 wrong and the right one: each wrong one counted on the record and recorded; the right one takes the count back to none", async () => {
    const w = await quickWorld();
    restart(w);
    const popup = w.ctx().service;
    for (const left of [4, 3, 2, 1]) {
      expect(await pinIn(popup, WRONG)).toEqual({ ok: false, reason: "wrong", triesLeft: left, digits: 6 });
      expect(got(w).fails).toBe(5 - left);
    }
    expect(await lockScreen(w)).toMatchObject({ quick: { triesLeft: 1 }, restart: "pin" });
    expect((await pinIn(popup, PIN)).ok).toBe(true);
    expect(got(w).fails).toBe(0);
    expect((await w.kinds()).filter((k) => k === "pin_failed")).toHaveLength(4);
  });

  it("1, 2 or 3 wrong and the right one: the count back to none, 5 tries again; then 4 wrong are 'wrong', the 5th 'exhausted' (5 wrong in a row is the limit; review of PINONE, PO-08)", async () => {
    for (const k of [1, 2, 3]) {
      const w = await quickWorld();
      restart(w);
      const popup = w.ctx().service;
      for (let i = 0; i < k; i++) await pinIn(popup, WRONG);
      expect(got(w).fails, `${k}`).toBe(k);
      expect((await pinIn(popup, PIN)).ok, `${k}`).toBe(true);
      expect(got(w).fails, `${k}`).toBe(0);
      expect(got(w).wrap, `${k}`).not.toBeNull();
      await popup.lock();
      restart(w);
      expect(await lockScreen(w), `${k}`).toMatchObject({ quick: { triesLeft: 5 }, restart: "pin" });
      const page = w.ctx().service;
      for (const left of [4, 3, 2, 1])
        expect(await pinIn(page, WRONG), `${k}`).toEqual({ ok: false, reason: "wrong", triesLeft: left, digits: 6 });
      expect(await pinIn(page, WRONG), `${k}`).toEqual({ ok: false, reason: "exhausted" });
    }
  });

  it("the 5th wrong PIN deletes the wrap (no key material left); then only the master password, which makes it again", async () => {
    const w = await quickWorld();
    restart(w);
    const popup = w.ctx().service;
    const before = got(w);
    for (let i = 0; i < 4; i++) await pinIn(popup, WRONG);
    expect(await pinIn(popup, WRONG)).toEqual({ ok: false, reason: "exhausted" });
    expect(got(w).wrap).toBeNull();
    expect(got(w).id).toBe(before.id); // the record stays: it waits for the master password
    expect((await w.kinds()).at(-1)).toBe("quick_ended");
    expect(await pinIn(popup, PIN)).toEqual({ ok: false, reason: "ended" }); // the right PIN no longer opens
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], restart: "wait" });
    // the master password on the lock screen, and its note: a new wrap (new id, salt, MAC), no try counted
    w.t.now += 60_000;
    await popup.unlockWithPassword(STRONG);
    await notePassword(popup);
    const after = got(w);
    expect(after.wrap).not.toBeNull();
    expect(after.id).not.toBe(before.id);
    expect(after.mac).not.toBe(before.mac);
    expect(wrapOf(after).kdf.salt).not.toBe(wrapOf(before).kdf.salt);
    expect(after).toMatchObject({ fails: 0, lastPasswordAt: w.t.now });
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("a 6th try after the 5th finds nothing: no wrap left, not counted; a malformed PIN is a typo, never counted", async () => {
    const w = await quickWorld();
    restart(w);
    const popup = w.ctx().service;
    for (const typo of ["", "123", "12a456"]) {
      expect(await pinIn(popup, typo)).toEqual({ ok: false, reason: "malformed" });
      // and the record's own steps, asked directly (any caller): a typo, before anything is read or counted
      const direct = await viaRecord(popup, typo, pinKit).catch((e: unknown) => ({ thrown: String(e) }));
      expect(direct, typo).toEqual({ ok: false, reason: "malformed" });
    }
    expect(got(w).fails).toBe(0);
    for (let i = 0; i < 5; i++) await pinIn(popup, WRONG);
    expect(await pinIn(popup, WRONG)).toEqual({ ok: false, reason: "ended" });
    expect(got(w).fails).toBe(5);
    expect((await w.kinds()).filter((k) => k === "pin_failed")).toHaveLength(5);
  });

  it("the count is written FIRST, in the vault lock: two pages trying at once spend two; a page closed while deriving spent its one", async () => {
    const w = await quickWorld();
    restart(w);
    const [a, b] = await Promise.all([pinIn(w.ctx().service, WRONG), pinIn(w.ctx().service, WRONG)]);
    expect([a, b]).toEqual(
      expect.arrayContaining([
        { ok: false, reason: "wrong", triesLeft: 4, digits: 6 },
        { ok: false, reason: "wrong", triesLeft: 3, digits: 6 },
      ]),
    );
    expect(got(w).fails).toBe(2);
    // the derivation of the next try never finishes (the page closes): the count has landed already
    const svc = w.ctx().service;
    const kit: PinKit = {
      ...pinKit,
      derivePinKek: async () => {
        expect(got(w).fails).toBe(3); // written before any derivation
        throw new Error("page closed");
      },
    };
    await expect(pinIn(svc, PIN, kit)).rejects.toThrow("page closed");
    expect(got(w).fails).toBe(3);
  });

  it("a right PIN whose record ended or was made again during the derivation is refused (compare-and-set), nothing reset", async () => {
    for (const meanwhile of ["set aside", "made again", "removed"] as const) {
      const w = await quickWorld();
      restart(w);
      await pinIn(w.ctx().service, WRONG);
      const svc = w.ctx().service;
      const kit: PinKit = {
        ...pinKit,
        derivePinKek: async (p, k) => {
          const r = got(w);
          if (meanwhile === "set aside") w.kv.data.set(KEY, { ...r, wrap: null });
          else if (meanwhile === "made again") w.kv.data.set(KEY, { ...r, id: "AAAAAAAAAAAAAAAAAAAAAA==", fails: 2 });
          else w.kv.data.delete(KEY);
          return pinKit.derivePinKek(p, k);
        },
      };
      expect(await pinIn(svc, PIN, kit), meanwhile).toEqual({ ok: false, reason: "ended" });
      expect((await svc.openView()).state, meanwhile).toBe("locked");
      if (meanwhile === "made again") expect(got(w).fails).toBe(2);
    }
  });

  it("the right PIN as the 5th try with a key event during its derivation (a reset with the recovery code; a rotation in another page): 'ended', no wrap under the old keys back on disk, no session from it (review of PINONE, PO-01)", async () => {
    for (const event of ["reset", "rotation"] as const) {
      const w = await quickWorld();
      restart(w);
      for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
      const svc = w.ctx().service;
      const kit: PinKit = {
        ...pinKit,
        derivePinKek: async (p, k) => {
          // the 5th try is counted (its wrap aside); the key event lands while it derives
          expect(got(w), event).toMatchObject({ fails: 5, wrap: null });
          if (event === "reset") await resetWithCode(w.ctx().service, w.recoveryCode, STRONG2);
          else {
            const other = w.ctx().service;
            await other.unlockWithPassword(STRONG);
            await other.rotateKey(STRONG, NO_PAGE);
          }
          return pinKit.derivePinKek(p, k);
        },
      };
      const answer = await pinIn(svc, PIN, kit);
      expect(answer, event).toEqual({ ok: false, reason: "ended" });
      const kr = await activeKeyring(w.kv);
      const after = got(w);
      expect(after.wrap, event).toBeNull(); // nothing put back
      expect(after.vkId === kr.vkId && after.wraps === wrapsTag(kr), event).toBe(false); // the old keys' record: paused
      // no session opened by the old keys: the session there (if any) is the one the key event left, of the new key
      const s = await w.area.get();
      if (s) expect((await vkFromRaw(fromB64(s.vk))).id, event).toBe(kr.vkId);
      // the next master password typed on a lock screen makes it for the new keys
      const page = w.ctx().service;
      await page.lock();
      await page.unlockWithPassword(event === "reset" ? STRONG2 : STRONG);
      await notePassword(page);
      expect(got(w), event).toMatchObject({ vkId: kr.vkId, wraps: wrapsTag(kr), fails: 0 });
      restart(w);
      expect((await pinIn(w.ctx().service, PIN)).ok, event).toBe(true);
    }
  });

  it("the right PIN as the 5th try while the active slot cannot be read: 'ended', nothing written, no session (the keyring's check fails closed; review of PINONE r2, S-04)", async () => {
    const w = await quickWorld();
    restart(w);
    for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
    const slot = `sk_slot_${w.kv.data.get("sk_active") as string}`;
    const good = w.kv.data.get(slot);
    let counted = "";
    const kit: PinKit = {
      ...pinKit,
      derivePinKek: async (p, k) => {
        counted = JSON.stringify(got(w)); // the 5th try as written (its wrap aside)
        w.kv.data.set(slot, { not: "a generation" }); // unreadable now
        return pinKit.derivePinKek(p, k);
      },
    };
    const svc = w.ctx().service;
    expect(await pinIn(svc, PIN, kit)).toEqual({ ok: false, reason: "ended" });
    expect(JSON.stringify(got(w))).toBe(counted); // nothing put back, the count not reset
    expect(await w.area.get()).toBeNull(); // no session
    w.kv.data.set(slot, good);
  });

  it("the right PIN as the 5th try with a lock during its derivation: 'waiting', its wrap stays aside, the master password once as after the 5th wrong one; nothing recorded (review of PINONE, PO-03)", async () => {
    const w = await quickWorld();
    restart(w);
    for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
    const recorded = (await w.kinds()).length;
    const svc = w.ctx().service;
    const kit: PinKit = {
      ...pinKit,
      derivePinKek: async (p, k) => {
        await w.ctx().service.lock(); // the idle timer, Lock now, the screen lock: a soft lock
        return pinKit.derivePinKek(p, k);
      },
    };
    expect(await pinIn(svc, PIN, kit)).toEqual({ ok: false, reason: "waiting" });
    expect(got(w)).toMatchObject({ fails: 0, wrap: null });
    expect((await w.kinds()).slice(recorded)).toEqual([]); // no pin_failed, no quick_ended
    expect((await svc.openView()).state).toBe("locked");
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], restart: "wait" }); // the line, no field
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("a lock during the derivation voids the new session: 'locked', and the page stays locked", async () => {
    const w = await quickWorld();
    restart(w);
    const svc = w.ctx().service;
    const kit: PinKit = {
      ...pinKit,
      derivePinKek: async (p, k) => {
        await w.ctx().service.lock();
        return pinKit.derivePinKek(p, k);
      },
    };
    expect(await pinIn(svc, PIN, kit)).toEqual({ ok: false, reason: "locked" });
    expect((await w.ctx().service.openView()).state).toBe("locked");
  });
});

describe("the master password's note on a lock screen: the record made again when it is not as it should be, never by a recovery key", () => {
  it("the steady state writes nothing (no 14 days, no daily time): one record, as it was", async () => {
    const w = await quickWorld();
    const before = JSON.stringify(rec(w));
    for (const days of [1, 13, 15, 400]) {
      w.t.now += days * 86_400_000;
      const svc = w.ctx().service;
      await svc.lock();
      await svc.unlockWithPassword(STRONG); // the master password on a lock screen, then its note
      await notePassword(svc);
      expect(JSON.stringify(rec(w)), `${days}`).toBe(before);
    }
  });

  it("a try counted, a wrap set aside, a wrap weaker than a new one, a record not even whole: made again, its count none", async () => {
    const cases: [string, (r: RestartRecord) => unknown][] = [
      ["a try counted", (r) => ({ ...r, fails: 2 })],
      ["set aside", (r) => ({ ...r, wrap: null })],
      ["5 counted", (r) => ({ ...r, fails: 5, wrap: null })],
      ["damaged", () => ({ v: 1, damaged: true })],
      ["another vault's", (r) => ({ ...r, vaultId: "anotherVaultId123456" })],
    ];
    for (const [what, edit] of cases) {
      const w = await quickWorld();
      const r = got(w);
      w.kv.data.set(KEY, edit(r));
      const svc = w.ctx().service;
      await svc.lock();
      await svc.unlockWithPassword(STRONG);
      await notePassword(svc);
      const now = got(w);
      expect(restartOk(now), what).toBe(true);
      expect(now.id, what).not.toBe(r.id);
      expect(now.fails, what).toBe(0);
      restart(w);
      expect((await pinIn(w.ctx().service, PIN)).ok, what).toBe(true);
    }
  });

  it("a recovery key unlock never makes the wrap again (the lock screen calls no note after it; the steps refuse it too)", async () => {
    const w = await quickWorld();
    restart(w);
    for (let i = 0; i < 5; i++) await pinIn(w.ctx().service, WRONG);
    const popup = w.ctx().service;
    await popup.unlockWithRecoveryCode(w.recoveryCode);
    await notePassword(popup);
    await notePassword(popup);
    expect(got(w).wrap).toBeNull();
    expect(await lockScreen(w)).toMatchObject({ state: "unlocked" });
  });

  it("a paused record is made again by the master password, for the keys and set-up of now", async () => {
    const w = await quickWorld();
    await w.ctx().service.changePassword(STRONG, STRONG2); // paused
    expect(got(w).wrap).toBeNull();
    const svc = w.ctx().service;
    await svc.lock();
    await expect(svc.unlockWithPassword(STRONG)).rejects.toMatchObject({ code: "wrong_secret" }); // the old one
    await notePassword(svc); // proves nothing now
    expect(got(w).wrap).toBeNull();
    await svc.unlockWithPassword(STRONG2);
    await notePassword(svc);
    const k = (await svc.currentGeneration())!.keyring;
    expect(got(w)).toMatchObject({ vkId: k.vkId, wraps: k.wraps.map((x) => x.wrapped).join(","), fails: 0 });
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("the note leaves a shared profile's alone, and makes nothing without a PIN set up here", async () => {
    const w = await quickWorld();
    const kept = got(w);
    await w.first.service.updateSettings(applyPreset(await w.settings.get(), "shared"));
    w.kv.data.set(KEY, { ...kept, fails: 3 }); // planted, or written back there
    const typedHere = w.ctx().service; // the lock screen's page: its unlock, then its note
    await typedHere.unlockWithPassword(STRONG);
    await notePassword(typedHere);
    expect(got(w).fails).toBe(3);
    const v = await quickWorld();
    await v.first.admin.removePin(STRONG);
    await notePassword(v.ctx().service);
    expect(rec(v)).toBeUndefined();
  });
});

describe("what deletes it, what sets its wrap aside, what pauses it, what keeps it (PIN-RESTART-NOTES §5)", () => {
  it("'End quick unlock now': the wrap set aside (the record kept), the session ended; the next master password makes it again", async () => {
    const w = await quickWorld();
    await w.ctx().admin.endQuickUnlock();
    expect(got(w).wrap).toBeNull();
    expect(w.area.quick).toBeNull();
    expect((await w.kinds()).at(-1)).toBe("quick_ended");
    restart(w);
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    const popup = w.ctx().service;
    await popup.unlockWithPassword(STRONG);
    await notePassword(popup);
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("'End quick unlock now' while locked: it is ended too, and recorded", async () => {
    const w = await quickWorld();
    restart(w);
    await w.ctx().admin.endQuickUnlock();
    expect(got(w).wrap).toBeNull();
    expect((await w.kinds()).at(-1)).toBe("quick_ended");
  });

  it("the PIN removed: the record deleted first, then sk_pin", async () => {
    const w = await quickWorld();
    await w.first.admin.removePin(STRONG);
    expect(rec(w)).toBeUndefined();
    expect(w.kv.data.has("sk_pin")).toBe(false);
  });

  it("the PIN changed: the old record deleted, a new one made with the new PIN; the old PIN never opens again", async () => {
    const w = await quickWorld();
    const old = got(w);
    w.t.now += 60_000;
    await w.first.admin.setPin(STRONG, PIN2);
    const now = got(w);
    expect(now.id).not.toBe(old.id);
    expect(now.setup).toBe((w.kv.data.get("sk_pin") as PinRecord).kdf.salt);
    expect(now.setup).not.toBe(old.setup);
    expect(now.lastPasswordAt).toBe(w.t.now);
    restart(w);
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: false, reason: "wrong" });
    expect((await pinIn(w.ctx().service, PIN2)).ok).toBe(true);
  });

  it("a new PIN of 4 or 5 digits is taken (OWNER-DECISIONS/20, 2026-10-30): the record made again with it", async () => {
    for (const short of ["4826", "48263"]) {
      const w = await quickWorld();
      const old = got(w);
      w.t.now += 60_000;
      await expect(w.first.admin.setPin(STRONG, short), short).resolves.toBeUndefined();
      const set = w.kv.data.get("sk_pin") as PinRecord;
      expect(set.digits).toBe(short.length);
      const now = got(w);
      expect(now.id, short).not.toBe(old.id);
      expect(now.setup).toBe(set.kdf.salt);
      expect(now).toMatchObject({ fails: 0, lastPasswordAt: w.t.now });
      expect(wrapOf(now)).toBeTruthy();
      expect(await w.kinds()).toEqual(["pin_set", "pin_set"]);
      restart(w);
      expect(await lockScreen(w)).toMatchObject({ quick: { digits: short.length }, restart: "pin" });
      expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: false, reason: "wrong" });
      expect((await pinIn(w.ctx().service, short)).ok).toBe(true);
    }
  });

  it("the PIN's own refusals stand before anything is checked or written: not 4 to 8 digits; a weak one is taken", async () => {
    const w = await quickWorld();
    const before = JSON.stringify([...w.kv.data.entries()]);
    for (const bad of ["", "123", "825", "123456789", "825193746", "12a4"])
      await expect(w.first.admin.setPin("not the password", bad), bad).rejects.toMatchObject({ code: "bad_pin" });
    expect(JSON.stringify([...w.kv.data.entries()])).toBe(before);
    expect(await w.kinds()).toEqual(["pin_set"]); // no password checked: nothing recorded
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true); // the old PIN still opens with the record
    for (const weak of ["1234", "1111", "1212", "2580", "1004", "9876", "123123"]) {
      await expect(w.first.admin.setPin(STRONG, weak), weak).resolves.toBeUndefined();
      restart(w);
      expect((await pinIn(w.ctx().service, weak)).ok, weak).toBe(true);
    }
  });

  it("a profile declared shared: deleted at once; one planted there is never offered or used, and goes at the next save", async () => {
    const w = await quickWorld();
    const kept = got(w);
    await w.first.service.updateSettings(applyPreset(await w.settings.get(), "shared"));
    expect(rec(w)).toBeUndefined();
    w.kv.data.set(KEY, kept);
    restart(w);
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [] });
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    // and the record's own unlock refuses there, whoever asks it (not only because the lock screen offers nothing)
    const direct = await viaRecord(w.ctx().service, PIN, pinKit).catch((e: unknown) => ({ thrown: String(e) }));
    expect(direct).toEqual({ ok: false, reason: "ended" });
    expect(got(w).fails).toBe(0); // not even counted
    await w.ctx().service.updateSettings({ ...(await w.settings.get()), lockOnScreenLock: false });
    expect(rec(w)).toBeUndefined();
  });

  it("a new vault (a backup restored over unreadable data, as Start over): deleted", async () => {
    const w = await quickWorld();
    const backup = (await w.ctx().service.read()).vault;
    for (const k of [...w.kv.data.keys()].filter((k) => /^sk_(slot_|snap|keyring|active|mirror)/.test(k)))
      w.kv.data.set(k, { damaged: true });
    const page = w.ctx().service;
    expect((await page.openView()).state).toBe("lost");
    await page.restoreBackup(backup, await page.prepareKeys(STRONG2, { vaultId: backup.vaultId }));
    expect(rec(w)).toBeUndefined();
  });

  it("a key change pauses it: the wrap set aside by the cleanup, not offered after a restart, no try spent; the master password makes it again", async () => {
    const w = await quickWorld();
    await w.ctx().service.rotateKey(STRONG, NO_PAGE);
    const r = got(w);
    expect(r.wrap).toBeNull(); // the old key's wrap is gone from the disk
    restart(w);
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], restart: "paused" });
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    expect(got(w).fails).toBe(0);
    const popup = w.ctx().service;
    await popup.unlockWithPassword(STRONG);
    await notePassword(popup);
    expect(got(w).wrap).not.toBeNull();
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("a new master password, a reset and a new recovery key pause it too (any re-wrap of the keyring)", async () => {
    const cases: [string, (w: QuickWorld) => Promise<void>][] = [
      ["password_changed", (w) => w.ctx().service.changePassword(STRONG, STRONG2)],
      ["recovery_code_new", (w) => w.ctx().service.newRecoveryCode(STRONG, NO_PAGE)],
      [
        "password_reset",
        async (w) => {
          await w.ctx().service.lock();
          await resetWithCode(w.ctx().service, w.recoveryCode, STRONG2);
        },
      ],
    ];
    for (const [kind, change] of cases) {
      const w = await quickWorld();
      await change(w);
      expect(got(w).wrap, kind).toBeNull();
      restart(w);
      expect((await lockScreen(w)) as { restart?: string }, kind).toMatchObject({ restart: "paused" });
    }
  });

  it("right after this page's own key change the PIN alone turns it back on in Settings; a wrong one is refused and recorded", async () => {
    const w = await quickWorld();
    const page = w.ctx();
    await page.service.rotateKey(STRONG, NO_PAGE);
    expect(await page.restart.state()).toMatchObject({ on: true, state: "paused", byPin: true });
    await expect(page.restart.turnBackOn({ pin: WRONG })).rejects.toMatchObject({ code: "wrong_secret" });
    expect((await w.kinds()).at(-1)).toBe("pin_failed");
    await expect(page.restart.turnBackOn({ pin: "12" })).rejects.toMatchObject({ code: "bad_pin" });
    w.t.now += 60_000;
    await page.restart.turnBackOn({ pin: PIN });
    expect(rec(w)).toMatchObject({ vkId: (await page.service.currentGeneration())!.keyring.vkId, fails: 0 });
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("from another page, or 10 minutes later, the PIN alone is refused; the master password turns it back on", async () => {
    const w = await quickWorld();
    await w.ctx().service.changePassword(STRONG, STRONG2);
    const other = w.ctx();
    expect((await other.restart.state())!.byPin).toBe(false);
    await expect(other.restart.turnBackOn({ pin: PIN })).rejects.toMatchObject({ code: "wrong_secret" });
    const page = w.ctx();
    await page.service.rotateKey(STRONG2, NO_PAGE);
    w.t.now += REWRAPPED_MS + 1;
    await expect(page.restart.turnBackOn({ pin: PIN })).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(page.restart.turnBackOn({ password: STRONG })).rejects.toMatchObject({ code: "wrong_secret" });
    await page.restart.turnBackOn({ password: STRONG2 });
    expect(got(w).wrap).not.toBeNull();
    expect(got(w).lastPasswordAt).toBe(w.t.now);
  });

  it("the PIN alone never turns back on a record that is not there, nor one that only waits for the master password", async () => {
    const w = await quickWorld();
    w.kv.data.delete(KEY); // a PIN set before its record was its one way
    await w.first.service.rotateKey(STRONG, NO_PAGE);
    await expect(w.first.restart.turnBackOn({ pin: PIN })).rejects.toMatchObject({ code: "bad_state" });
    const v = await quickWorld();
    await v.first.service.rotateKey(STRONG, NO_PAGE);
    await v.first.restart.turnBackOn({ pin: PIN });
    await v.first.admin.endQuickUnlock(); // its wrap set aside: it waits for the master password
    await v.first.service.unlockWithPassword(STRONG);
    await expect(v.first.restart.turnBackOn({ pin: PIN })).rejects.toMatchObject({ code: "wrong_secret" });
  });

  it("soft locks keep it, and so does a change of lock mode (a hard lock for the gate's arming only)", async () => {
    const w = await quickWorld();
    const kept = JSON.stringify(rec(w));
    const svc = w.ctx().service;
    await svc.lock();
    w.t.now += 16 * 60_000;
    await svc.enforceAutoLock();
    await svc.unlockWithPassword(STRONG);
    await svc.updateSettings({ ...(await w.settings.get()), autoLock: { mode: "always" } });
    expect(JSON.stringify(rec(w))).toBe(kept);
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });
});

describe("lock every time the popup closes", () => {
  it("the record opens every popup after a restart (each one derives again); the key stays in that popup's memory", async () => {
    const w = await quickWorld();
    await w.first.service.updateSettings({ ...(await w.settings.get()), autoLock: { mode: "always" } });
    restart(w);
    for (let i = 0; i < 3; i++) {
      const popup = w.ctx().service;
      expect(await popup.openView()).toMatchObject({ state: "locked" });
      expect(restartOffer(popup, pinKit)).toEqual({ state: "pin", field: { digits: 6, triesLeft: 5 } });
      expect((await pinIn(popup, PIN)).ok).toBe(true);
      expect(await w.area.get()).toBeNull(); // lock every time: the key is in this page's memory only
      expect(got(w).fails).toBe(0);
    }
  });
});

describe("the attacks of PIN-RESTART-NOTES §2.3 (a writer of the profile's storage, without the PIN or the vault key)", () => {
  it("a rewritten record never opens: an edited wrap counts as a wrong PIN; an edited head is not even offered", async () => {
    const w = await quickWorld();
    restart(w);
    const r = got(w);
    const flip = (s: string) => {
      const b = Buffer.from(s, "base64");
      b[3] = b[3]! ^ 1;
      return b.toString("base64");
    };
    w.kv.data.set(KEY, { ...r, wrap: { ...wrapOf(r), wrapped: flip(wrapOf(r).wrapped) } });
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: false, reason: "wrong" });
    w.kv.data.set(KEY, { ...r, id: flip(r.id) }); // the record's id, bound in the AAD
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: false, reason: "wrong" });
    for (const head of [{ setup: flip(r.setup) }, { wraps: "AAAA" }, { vkId: "0123456789abcdef" }]) {
      w.kv.data.set(KEY, { ...r, ...head, fails: 0 });
      expect(await pinIn(w.ctx().service, PIN), JSON.stringify(head)).toEqual({ ok: false, reason: "ended" });
    }
    w.kv.data.set(KEY, r);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("a record out of shape where the lock screen does not look (its wrap's count, its tries, a field it does not know): refused before any try, nothing counted", async () => {
    const w = await quickWorld();
    const r = got(w);
    const svc = w.ctx().service;
    await svc.lock();
    restart(w);
    const bad: Partial<RestartRecord>[] = [
      { wrap: { ...wrapOf(r), kdf: { ...wrapOf(r).kdf, iterations: 1_000 } } }, // below kdf.ts's floor
      { wrap: { ...wrapOf(r), iv: "AAAA" } },
      { fails: -1 },
      { extra: 1 } as Partial<RestartRecord>,
    ];
    for (const x of bad) {
      const rec2 = { ...r, ...x };
      w.kv.data.set(KEY, rec2);
      expect((await lockScreen(w)) as object, JSON.stringify(x)).toMatchObject({ state: "locked", restart: "pin" });
      expect(await pinIn(svc, PIN), JSON.stringify(x)).toEqual({ ok: false, reason: "ended" });
      expect(rec(w), JSON.stringify(x)).toEqual(rec2); // not counted, not rewritten
      expect(
        (await w.kinds()).filter((k) => k === "pin_failed"),
        JSON.stringify(x),
      ).toHaveLength(0);
    }
  });

  it("a record of an older PIN swapped back after a change is never tried (another PIN set-up): paused", async () => {
    const w = await quickWorld();
    const old = got(w);
    await w.first.admin.setPin(STRONG, PIN2);
    w.kv.data.set(KEY, old);
    restart(w);
    expect(await lockScreen(w)).toMatchObject({ restart: "paused" });
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
  });

  it("a planted record (the planter's own key under the planter's PIN) never opens Sixkey, with any PIN", async () => {
    const w = await quickWorld();
    const r = got(w);
    const pin = w.kv.data.get("sk_pin") as PinRecord;
    const own = await vkFromRaw(new Uint8Array(32).fill(7));
    const pinKek = new Uint8Array(32).fill(9); // the planter knows what he derived, not the user's PIN
    const wrap = await sealRestart(own.raw, r, pinKek, 600_000);
    w.kv.data.set(KEY, { ...r, wrap });
    restart(w);
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: false, reason: "wrong" });
    // a wrap of the real key under some pinKek needs the real key (which only opens the vault): it would not check either
    expect(pin.vkId).toBe(r.vkId);
  });

  it("a planted record that the planter's own PIN opens (sk_pin's salt is no secret): another key, refused and counted", async () => {
    const w = await quickWorld();
    const r = got(w);
    const pin = w.kv.data.get("sk_pin") as PinRecord;
    const own = await vkFromRaw(new Uint8Array(32).fill(7));
    const theirs = "111111";
    const { derivePinKek } = await import("../../src/core/crypto/pin");
    const wrap = await sealRestart(own.raw, r, await derivePinKek(theirs, pin.kdf), 600_000);
    w.kv.data.set(KEY, { ...r, wrap });
    restart(w);
    const svc = w.ctx().service;
    // the unwrap succeeds, the key it gives is not the vault's (its id): a wrong PIN, never a session
    const res = await pinIn(svc, theirs).catch((e: unknown) => ({ thrown: String(e) }));
    expect(res).toMatchObject({ ok: false, reason: "wrong", triesLeft: 4 });
    expect(got(w).fails).toBe(1);
    expect(await w.area.get()).toBeNull();
    expect((await lockScreen(w)).state).toBe("locked");
  });

  it("a planted record (its MAC not under the vault key): the master password never renews it, it replaces it with Sixkey's own", async () => {
    for (const wrap of ["kept", "set aside"] as const) {
      const w = await quickWorld();
      const r = got(w);
      const forged = await restartMac(new Uint8Array(32).fill(5), r); // a MAC under a key that is not the vault's
      const planted = { ...r, fails: 3, mac: forged, ...(wrap === "set aside" ? { wrap: null } : {}) };
      w.kv.data.set(KEY, planted);
      const popup = w.ctx().service;
      await popup.lock();
      await popup.unlockWithPassword(STRONG);
      await notePassword(popup);
      const now = got(w);
      expect(now.id, wrap).not.toBe(planted.id);
      expect(now.mac, wrap).not.toBe(forged);
      expect(now.fails, wrap).toBe(0);
      restart(w);
      expect((await pinIn(w.ctx().service, PIN)).ok, wrap).toBe(true);
    }
  });

  it("a counter rolled back by a writer of the storage gives tries again (the known limit: that writer can also copy the record)", async () => {
    const w = await quickWorld();
    restart(w);
    for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
    w.kv.data.set(KEY, { ...got(w), fails: 0 });
    expect(await pinIn(w.ctx().service, WRONG)).toEqual({ ok: false, reason: "wrong", triesLeft: 4, digits: 6 });
  });
});

describe("nothing secret on disk or in a log; local only", () => {
  it("chrome.storage.local holds no PIN, pinKek, KEK or vault key, through every path; nor the diagnostics or the record", async () => {
    const w = await quickWorld();
    const svc = w.ctx().service;
    restart(w);
    await pinIn(svc, WRONG);
    expect((await pinIn(svc, PIN)).ok).toBe(true);
    const session = await w.area.get();
    expect(session, "the PIN opened a session").not.toBeNull();
    const vk = session!.vk;
    await w.first.admin.setPin(STRONG, PIN2);
    await svc.lock();
    for (let i = 0; i < 5; i++) await pinIn(svc, WRONG);
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    const disk = JSON.stringify([...w.kv.data.entries()]);
    const logs = JSON.stringify(w.diag) + JSON.stringify(await w.log.read());
    for (const secret of [PIN, PIN2, WRONG, vk]) {
      expect(disk.includes(secret), secret).toBe(false);
      expect(logs.includes(secret), secret).toBe(false);
    }
    // the pinKek (sk_pin's, opened with the key) and the KEK it derives are on no disk either
    const r = got(w);
    const set = w.kv.data.get("sk_pin") as PinRecord;
    const { derivePinKek } = await import("../../src/core/crypto/pin");
    const pinKek = await derivePinKek(PIN2, set.kdf);
    expect(disk.includes(Buffer.from(pinKek).toString("base64"))).toBe(false);
    expect(Buffer.from(await openRestart(wrapOf(r), r, pinKek)).toString("base64")).toBe(vk);
    expect(Object.keys(r).sort()).toEqual(
      ["fails", "id", "lastPasswordAt", "mac", "setup", "v", "vaultId", "vkId", "wrap", "wraps"].sort(),
    );
    expect(disk.includes("sk_quick")).toBe(false);
  });

  it("its key is this profile's own: local only, none of the server sync's records (their removal keeps it); not vault data", async () => {
    expect(LOCAL_ONLY_KEYS.restart).toBe(KEY);
    expect(SERVER_SYNC_KEYS).not.toContain(KEY);
    const w = await quickWorld();
    for (const k of [...w.kv.data.keys()].filter((k) => k !== KEY)) w.kv.data.delete(k);
    expect((await w.ctx().service.openView()).state).toBe("empty"); // a profile holding only it opens as empty
  });

  it("the tries are QUICK_TRIES", () => {
    expect(QUICK_TRIES).toBe(5);
  });
});
