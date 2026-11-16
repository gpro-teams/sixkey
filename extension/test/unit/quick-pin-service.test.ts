// The PIN through the service (QUICK-UNLOCK §5.3–§5.5, §5.12; OWNER-DECISIONS/20 and its two 2026-10-30 notes;
// docs/design/notes/PIN-RESTART-NOTES.md §18): setting it behind the master password (4 to 8 digits; one too easy to guess
// taken), its record, the one thing it opens; the PIN unlock and its 5 tries, its one limit (no 12 hours, no 14 days, a
// restart keeps it); soft and hard locks row by row; key changes, which pause it until the master password; the two
// migrations (a PIN set before its record was its one way; a record made with the old switch); the profile marker; and
// nothing secret on disk or in a log. The record's own mechanics (its counter, its crypto, the attacks on it) are
// pin-restart-service.test.ts's.
import { describe, expect, it, vi } from "vitest";
import { toB64 } from "../../src/core/crypto/bytes";
import { PIN_CFG_LABEL, PIN_TAG } from "../../src/core/crypto/pin";
import type { RestartRecord } from "../../src/core/crypto/pin-restart";
import { applyPreset } from "../../src/core/service/presets";
import { ServiceError } from "../../src/core/service/service";
import { MemorySession } from "../../src/core/service/types";
import { NO_PAGE, STRONG, resetWithCode } from "../helpers/vaults";
import {
  lockScreen,
  notePassword,
  PIN,
  PIN2,
  pinIn,
  quickWorld,
  restart,
  type QuickWorld,
} from "../helpers/quick-world";

const STRONG2 = "granite-river-compass-31";
const WRONG = "975310";
const KEY = "sk_pin_restart";
const DAY = 86_400_000;

const rec = (w: QuickWorld) => w.kv.data.get(KEY) as RestartRecord | undefined;
/** The record, which must be stored (its absence fails an assertion here, not a property read later). */
const got = (w: QuickWorld): RestartRecord => {
  const r = rec(w);
  expect(r, "sk_pin_restart is stored").toBeDefined();
  return r!;
};
async function softLocked(w: QuickWorld) {
  await w.ctx().service.lock();
  return lockScreen(w);
}

describe("setting the PIN (§5.3): master password first, a solo profile, a vault with a master password", () => {
  it("set: sk_pin and its record on disk, nothing of it in session memory, pin_set recorded; the box says it opens Sixkey", async () => {
    const w = await quickWorld();
    expect(w.kv.data.has("sk_pin")).toBe(true);
    expect(got(w)).toMatchObject({ fails: 0, lastPasswordAt: w.t.now });
    expect(got(w).wrap).not.toBeNull();
    expect(w.area.quick).toBeNull(); // the PIN has no part in sk_quick (the gate's only)
    expect(await w.first.admin.state()).toEqual({
      available: "ok",
      pin: { digits: 6 },
      restart: { state: "pin", triesLeft: 5 },
    });
    expect(await w.kinds()).toEqual(["pin_set"]);
  });

  it("a wrong master password is refused and recorded; nothing is written", async () => {
    const w = await quickWorld({ pin: null });
    await expect(w.first.admin.setPin("not the password", PIN)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.first.admin.setPin("", PIN)).rejects.toMatchObject({ code: "empty_password" }); // a typo, not recorded
    expect(w.kv.data.has("sk_pin")).toBe(false);
    expect(rec(w)).toBeUndefined();
    expect(await w.kinds()).toEqual(["unlock_failed"]);
  });

  it("a PIN that is not 4 to 8 digits is refused first, before any password is checked or recorded", async () => {
    const w = await quickWorld({ pin: null });
    for (const bad of ["", "123", "825", "123456789", "825193746", "12ab56"])
      await expect(w.first.admin.setPin("not the password", bad), bad).rejects.toMatchObject({ code: "bad_pin" });
    expect(await w.kinds()).toEqual([]);
    expect(w.kv.data.has("sk_pin")).toBe(false);
  });

  it("a PIN too easy to guess is taken (the box says so, it does not refuse: OWNER-DECISIONS/20, 2026-10-30), and opens Sixkey", async () => {
    for (const weak of ["1234", "1111", "1212", "2580", "9876", "123123", "11223344"]) {
      const w = await quickWorld({ pin: null });
      await expect(w.first.admin.setPin(STRONG, weak), weak).resolves.toBeUndefined();
      expect((w.kv.data.get("sk_pin") as { digits: number }).digits, weak).toBe(weak.length);
      expect(got(w).wrap, weak).not.toBeNull();
      await w.ctx().service.lock();
      expect((await pinIn(w.ctx().service, weak)).ok, weak).toBe(true);
    }
  });

  it("refused while locked, in a profile declared shared, and in a vault without a master password", async () => {
    const w = await quickWorld({ pin: null });
    await w.first.service.lock();
    await expect(w.first.admin.setPin(STRONG, PIN)).rejects.toMatchObject({ code: "locked" });
    await w.first.service.unlockWithPassword(STRONG);
    await w.first.service.updateSettings(applyPreset(await w.settings.get(), "shared"));
    await w.first.service.unlockWithPassword(STRONG);
    await expect(w.first.admin.setPin(STRONG, PIN)).rejects.toMatchObject({ code: "quick_off" });
    expect((await w.first.admin.state()).available).toBe("shared");
    expect(w.kv.data.has("sk_pin")).toBe(false);
    expect(rec(w)).toBeUndefined();
  });

  it("a Phase 0 device-key vault: not_protected, and the box says why", async () => {
    const { legacyDeviceVault } = await import("../helpers/vaults");
    const { MemoryKV, createMutex } = await import("../../src/core/storage/kv");
    const { VaultStore } = await import("../../src/core/storage/store");
    const { PinStore } = await import("../../src/core/service/pin-store");
    const { PinAdmin } = await import("../../src/core/service/pin-admin");
    const { VaultService } = await import("../../src/core/service/service");
    const { KvSettingsStore } = await import("../../src/core/service/types");
    const kv = new MemoryKV();
    const store = new VaultStore({ kv, lock: createMutex() });
    await legacyDeviceVault(store);
    const svc = new VaultService({
      store,
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
      pins: new PinStore(kv, createMutex()),
    });
    const admin = new PinAdmin(svc);
    await expect(admin.setPin(STRONG, PIN)).rejects.toMatchObject({ code: "not_protected" });
    expect(await admin.state()).toEqual({ available: "no_password", pin: null });
  });
});

describe("the PIN unlock (§5.4): its record, its 5 tries, and no time limit", () => {
  it("after a soft lock the lock screen offers the PIN; the right PIN opens the vault, without the master password", async () => {
    const w = await quickWorld();
    expect(await softLocked(w)).toEqual({
      state: "locked",
      events: [],
      pin: "pin",
      field: { digits: 6, triesLeft: 5 },
    });
    const popup = w.ctx().service;
    expect((await pinIn(popup, PIN)).ok).toBe(true);
    expect((await popup.openView()).state).toBe("unlocked");
    expect(got(w).fails).toBe(0);
    expect(w.area.quick).toBeNull();
  });

  it("4 wrong and then the right one: each wrong one spends a try and is recorded; success resets the count, and the PIN keeps working", async () => {
    const w = await quickWorld();
    await softLocked(w);
    const popup = w.ctx().service;
    for (const left of [4, 3, 2, 1])
      expect(await pinIn(popup, WRONG)).toEqual({ ok: false, reason: "wrong", triesLeft: left, digits: 6 });
    expect(await lockScreen(w)).toMatchObject({ field: { triesLeft: 1 } });
    expect((await pinIn(popup, PIN)).ok).toBe(true);
    expect(got(w).fails).toBe(0);
    // the right PIN as the 5th try: its wrap, set aside with the count, is back (5 wrong in a row is the limit)
    expect(got(w).wrap).not.toBeNull();
    expect(await w.kinds()).toEqual(["pin_set", "pin_failed", "pin_failed", "pin_failed", "pin_failed"]);
    expect(await w.log.failuresSinceAck()).toBe(4); // the popup's notice counts them with the wrong passwords
    await popup.lock();
    restart(w);
    expect(await lockScreen(w)).toMatchObject({ pin: "pin", field: { triesLeft: 5 } });
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("the right PIN as the 5th try with a hard lock during its derivation: its wrap stays aside, the master password then", async () => {
    const w = await quickWorld();
    await softLocked(w);
    for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
    const p = pinIn(w.ctx().service, PIN);
    await new Promise((r) => setTimeout(r, 0));
    await w.ctx().admin.endQuickUnlock();
    expect((await p).ok).toBe(false);
    expect(got(w).wrap).toBeNull();
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], pin: "wait" });
  });

  it("the 5th wrong PIN: the master password once (quick_ended recorded), which makes the PIN work again", async () => {
    const w = await quickWorld();
    await softLocked(w);
    const popup = w.ctx().service;
    for (let i = 0; i < 4; i++) await pinIn(popup, WRONG);
    expect(await pinIn(popup, WRONG)).toEqual({ ok: false, reason: "exhausted" }); // "Too many wrong PINs"
    expect(got(w).wrap).toBeNull(); // no key material left
    expect(await pinIn(popup, PIN)).toEqual({ ok: false, reason: "ended" }); // a 6th: not even tried
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], pin: "wait" }); // the line, no field
    expect((await w.kinds()).filter((k) => k === "pin_failed")).toHaveLength(5);
    expect((await w.kinds()).at(-1)).toBe("quick_ended");
    await popup.unlockWithPassword(STRONG);
    await notePassword(popup);
    await popup.lock();
    expect(await lockScreen(w)).toMatchObject({ pin: "pin", field: { triesLeft: 5 } });
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("the count outlives a restart: 3 wrong, a restart, 2 wrong, and the master password (no fresh tries from a reload)", async () => {
    const w = await quickWorld();
    await softLocked(w);
    for (let i = 0; i < 3; i++) await pinIn(w.ctx().service, WRONG);
    restart(w);
    expect(await lockScreen(w)).toMatchObject({ field: { triesLeft: 2 } });
    expect(await pinIn(w.ctx().service, WRONG)).toMatchObject({ reason: "wrong", triesLeft: 1 });
    restart(w);
    expect(await pinIn(w.ctx().service, WRONG)).toEqual({ ok: false, reason: "exhausted" });
    restart(w);
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], pin: "wait" });
  });

  it("a malformed PIN is a typo: no try spent, nothing recorded; full-width digits are the same PIN", async () => {
    const w = await quickWorld();
    await softLocked(w);
    const popup = w.ctx().service;
    for (const typo of ["", "123", "12345678901", "12a456"])
      expect(await pinIn(popup, typo)).toEqual({ ok: false, reason: "malformed" });
    expect(got(w).fails).toBe(0);
    expect(await w.kinds()).toEqual(["pin_set"]);
    expect((await pinIn(popup, "２４６８１３")).ok).toBe(true);
  });

  it("no time limit (OWNER-DECISIONS/20, 2026-10-30): 12 hours and a minute, 14 days and a day, a year on, the clock set back", async () => {
    const w = await quickWorld();
    const start = w.t.now;
    for (const at of [start + 12 * 3_600_000 + 60_000, start + 15 * DAY, start + 365 * DAY, start - 2 * DAY]) {
      w.t.now = at;
      restart(w);
      expect(await lockScreen(w), `${at - start}`).toMatchObject({ pin: "pin", field: { triesLeft: 5 } });
      expect((await pinIn(w.ctx().service, PIN)).ok, `${at - start}`).toBe(true);
    }
  });

  it("verifyPassword never accepts the PIN (exports, key changes, the sync gate)", async () => {
    const w = await quickWorld();
    await expect(w.first.service.verifyPassword(PIN)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.first.service.unlockWithPassword(PIN)).rejects.toMatchObject({ code: "wrong_secret" });
  });

  it("a hard lock during the derivation is not undone by the success: the record's wrap stays aside", async () => {
    const w = await quickWorld();
    await softLocked(w);
    const p = pinIn(w.ctx().service, PIN);
    await new Promise((r) => setTimeout(r, 0));
    await w.ctx().admin.endQuickUnlock();
    expect((await p).ok).toBe(false);
    expect(got(w).wrap).toBeNull();
  });
});

describe("the master password, and the recovery code", () => {
  it("the master password typed on a lock screen makes a waiting PIN work again; the recovery code does not", async () => {
    const w = await quickWorld();
    await w.ctx().admin.endQuickUnlock(); // its wrap set aside: the PIN waits for the master password
    const svc = w.ctx().service;
    await svc.unlockWithRecoveryCode(w.recoveryCode);
    await notePassword(svc); // as a lock screen would never call it: the steps refuse it themselves
    expect(got(w).wrap).toBeNull();
    await svc.lock();
    expect(await lockScreen(w)).toMatchObject({ pin: "wait" });
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    expect(got(w).wrap).not.toBeNull();
  });

  it("an sk_pin whose ciphertext is fine is never removed by a failure that is not its own authentication: the key's derivation thrown, WebCrypto failing otherwise, an unexpected error (review of PINONE r2, S-02)", async () => {
    const subtle = crypto.subtle;
    const text = (b: unknown) => (b ? new TextDecoder().decode(b as Uint8Array) : "");
    const hits = { n: 0 };
    // sk_pin's own steps only (its key from HKDF with its label; its decryption with its AAD): everything else passes
    const spies = [
      // the set-up's own key (HKDF from the vault key, pin.ts cfgKey) cannot be made
      () => {
        const real = subtle.deriveKey.bind(subtle);
        return vi.spyOn(subtle, "deriveKey").mockImplementation(async (alg, base, derived, extractable, usages) => {
          const a = alg as { name?: string; info?: unknown };
          if (a.name === "HKDF" && text(a.info) === PIN_CFG_LABEL) {
            hits.n++;
            throw new DOMException("no", "OperationError");
          }
          return real(alg, base, derived, extractable, usages);
        });
      },
      // the decryption fails for a reason of its own, not the ciphertext's authentication
      new DOMException("not now", "NotSupportedError"),
      // anything else thrown there
      new TypeError("unexpected"),
    ].map((f) =>
      typeof f === "function"
        ? f
        : () => {
            const real = subtle.decrypt.bind(subtle);
            return vi.spyOn(subtle, "decrypt").mockImplementation(async (alg, key, data) => {
              if (text((alg as { additionalData?: unknown }).additionalData).startsWith(PIN_TAG)) {
                hits.n++;
                throw f;
              }
              return real(alg, key, data);
            });
          },
    );
    for (const [i, failing] of spies.entries()) {
      const w = await quickWorld();
      w.kv.data.set(KEY, { ...got(w), wrap: null }); // as after the 5th wrong PIN: the note has a record to make
      const before = { pin: JSON.stringify(w.kv.data.get("sk_pin")), rec: JSON.stringify(rec(w)) };
      await w.ctx().service.lock();
      const svc = w.ctx().service;
      await svc.unlockWithPassword(STRONG);
      const spy = failing();
      hits.n = 0;
      try {
        await notePassword(svc);
      } finally {
        spy.mockRestore();
      }
      expect(hits.n, `${i}`).toBe(1); // it did reach sk_pin's opening, and failed there
      expect(JSON.stringify(w.kv.data.get("sk_pin")), `${i}`).toBe(before.pin); // left as it is
      expect(JSON.stringify(rec(w)), `${i}`).toBe(before.rec);
      // and it was fine: the next master password makes the record from it
      await svc.lock();
      await svc.unlockWithPassword(STRONG);
      await notePassword(svc);
      expect(got(w).wrap, `${i}`).not.toBeNull();
    }
  });

  it("an sk_pin whose ciphertext is damaged (its shape whole): the next master password removes it with its record; Settings shows no PIN, and one can be set again (review of PINONE, PO-04)", async () => {
    for (const beside of ["no record", "its record set aside"] as const) {
      const w = await quickWorld();
      const pin = w.kv.data.get("sk_pin") as Record<string, unknown> & { wrapped: string };
      w.kv.data.set("sk_pin", { ...pin, wrapped: (pin.wrapped[0] === "A" ? "B" : "A") + pin.wrapped.slice(1) });
      if (beside === "no record")
        w.kv.data.delete(KEY); // as a PIN set before its record was its one way
      else w.kv.data.set(KEY, { ...got(w), wrap: null }); // as after the 5th wrong PIN
      await w.ctx().service.lock();
      restart(w);
      expect(await lockScreen(w), beside).toMatchObject({ pin: "wait" }); // the line: what the master password promises
      const svc = w.ctx().service;
      await svc.unlockWithPassword(STRONG);
      await notePassword(svc);
      expect(w.kv.data.has("sk_pin"), beside).toBe(false); // it can never be made usable: it goes
      expect(rec(w), beside).toBeUndefined();
      expect((await w.ctx().admin.state()).pin, beside).toBeNull(); // Settings: no PIN
      await svc.lock();
      expect(await lockScreen(w), beside).toEqual({ state: "locked", events: [] }); // and no line any more
      await svc.unlockWithPassword(STRONG);
      await w.ctx().admin.setPin(STRONG, PIN2);
      restart(w);
      expect((await pinIn(w.ctx().service, PIN2)).ok, beside).toBe(true);
    }
  });

  it("with no PIN set nothing is made, and nothing is written to the session area for it", async () => {
    const none = await quickWorld({ pin: null });
    await none.ctx().service.lock();
    const typedHere = none.ctx().service; // the lock screen's page: its unlock, then its note
    await typedHere.unlockWithPassword(STRONG);
    await notePassword(typedHere);
    expect(none.area.quick).toBeNull();
    expect(rec(none)).toBeUndefined();
    await none.ctx().service.lock();
    expect(await lockScreen(none)).toEqual({ state: "locked", events: [] }); // no PIN, no line
  });
});

describe("soft and hard locks (§5.5), row by row", () => {
  it("soft: Lock now / the shortcut / the screen lock (lock()), and the idle timer (enforceAutoLock): the PIN still works", async () => {
    const w = await quickWorld();
    await w.ctx().service.lock();
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
    w.t.now += 16 * 60_000; // past the 15 idle minutes
    expect(await w.ctx().service.enforceAutoLock()).toBe(true);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("End quick unlock now: the master password once (recorded); a change of lock mode keeps the PIN; the profile declared shared removes it", async () => {
    const w = await quickWorld();
    await w.ctx().admin.endQuickUnlock();
    expect((await w.ctx().service.openView()).state).toBe("locked"); // it is a lock too
    expect((await w.kinds()).at(-1)).toBe("quick_ended");
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    const svc = w.ctx().service;
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    await svc.updateSettings({ ...(await w.settings.get()), autoLock: { mode: "session" } }); // a hard lock: the gate's
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
    await svc.updateSettings({ ...(await w.settings.get()), profile: "shared" }); // the same lock mode, a shared profile
    expect(rec(w)).toBeUndefined();
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [] });
  });

  it("not hard: a change that keeps the lock mode and the profile (minutes, the screen lock, the display)", async () => {
    const w = await quickWorld();
    const svc = w.ctx().service;
    const before = got(w);
    await svc.updateSettings({ ...(await w.settings.get()), autoLock: { mode: "idle", minutes: 5 } });
    await svc.updateSettings({ ...(await w.settings.get()), lockOnScreenLock: false });
    await svc.updateSettings({ autoLock: { mode: "idle", minutes: 5 }, lockOnScreenLock: false }); // no profile: kept
    expect((await w.settings.get()).profile).toBe("solo");
    expect(got(w)).toEqual(before);
  });

  it("a key change pauses it (a new password, a new recovery code, a reset): the next master password makes it again", async () => {
    const cases: [string, (w: QuickWorld) => Promise<string>][] = [
      ["password_changed", async (w) => (await w.ctx().service.changePassword(STRONG, STRONG2), STRONG2)],
      ["recovery_code_new", async (w) => (await w.ctx().service.newRecoveryCode(STRONG, NO_PAGE), STRONG)],
      [
        "password_reset",
        async (w) => {
          await w.ctx().service.lock();
          await resetWithCode(w.ctx().service, w.recoveryCode, STRONG2);
          return STRONG2;
        },
      ],
    ];
    for (const [kind, change] of cases) {
      const w = await quickWorld();
      const password = await change(w);
      expect(await w.kinds(), kind).toContain(kind);
      expect(w.kv.data.has("sk_pin"), kind).toBe(true); // the set-up stays (the vault key did not change)
      expect(got(w).wrap, kind).toBeNull(); // paused: no old key material
      await w.ctx().service.lock();
      expect(await lockScreen(w), kind).toEqual({ state: "locked", events: [], pin: "paused" });
      expect(await pinIn(w.ctx().service, PIN), kind).toEqual({ ok: false, reason: "ended" });
      const svc = w.ctx().service;
      await svc.unlockWithPassword(password);
      await notePassword(svc);
      await svc.lock();
      expect((await pinIn(w.ctx().service, PIN)).ok, kind).toBe(true);
    }
  });

  it("a rotation pauses it and moves sk_pin to the new key in the cleanup; the next master password makes it again", async () => {
    const w = await quickWorld();
    const svc = w.ctx().service;
    const before = (w.kv.data.get("sk_pin") as { vkId: string }).vkId;
    await svc.rotateKey(STRONG, NO_PAGE);
    const after = (w.kv.data.get("sk_pin") as { vkId: string }).vkId;
    expect(after).not.toBe(before);
    expect(after).toBe((await svc.currentGeneration())!.keyring.vkId);
    await svc.lock();
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    await svc.lock();
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
    expect(got(w).vkId).toBe(after);
  });

  it("a new vault (a backup restored over unreadable data) removes the PIN's set-up and its record", async () => {
    const w = await quickWorld();
    const backup = (await w.ctx().service.read()).vault;
    for (const k of [...w.kv.data.keys()].filter((k) => /^sk_(slot_|snap|keyring|active|mirror)/.test(k)))
      w.kv.data.set(k, { damaged: true });
    const page = w.ctx().service;
    expect((await page.openView()).state).toBe("lost");
    await page.restoreBackup(backup, await page.prepareKeys(STRONG2, { vaultId: backup.vaultId }));
    expect((await page.openView()).state).toBe("unlocked");
    expect(rec(w)).toBeUndefined();
    expect(w.kv.data.has("sk_pin")).toBe(false); // sealed for the old vault key: of no use, removed
  });

  it("a browser restart or an extension reload (chrome.storage.session emptied) keeps it: the PIN opens Sixkey", async () => {
    const w = await quickWorld();
    await w.ctx().service.lock();
    restart(w);
    expect(await lockScreen(w)).toEqual({
      state: "locked",
      events: [],
      pin: "pin",
      field: { digits: 6, triesLeft: 5 },
    });
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });
});

describe("changing and removing the PIN (master password again)", () => {
  it("change: the old PIN never works again, the new one works at once, also after a restart", async () => {
    const w = await quickWorld();
    await w.first.admin.setPin(STRONG, PIN2);
    await w.ctx().service.lock();
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "wrong", triesLeft: 4, digits: 6 });
    expect((await pinIn(w.ctx().service, PIN2)).ok).toBe(true);
    restart(w);
    expect((await pinIn(w.ctx().service, PIN2)).ok).toBe(true);
    expect(await w.kinds()).toEqual(["pin_set", "pin_set", "pin_failed"]);
  });

  it("remove: refused with a wrong password (recorded); with the right one sk_pin and its record go, pin_removed recorded", async () => {
    const w = await quickWorld();
    await expect(w.first.admin.removePin("nope nope nope")).rejects.toMatchObject({ code: "wrong_secret" });
    expect(w.kv.data.has("sk_pin")).toBe(true);
    await w.first.admin.removePin(STRONG);
    expect(w.kv.data.has("sk_pin")).toBe(false);
    expect(rec(w)).toBeUndefined();
    expect(await w.kinds()).toEqual(["pin_set", "unlock_failed", "pin_removed"]);
    await w.ctx().service.lock();
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [] });
    const typedHere = w.ctx().service; // the lock screen's page: its unlock, then its note
    await typedHere.unlockWithPassword(STRONG);
    await notePassword(typedHere);
    expect(rec(w)).toBeUndefined(); // nothing to make
  });

  it("the old PIN's record written back after a change names the old set-up: never offered, never opens", async () => {
    const w = await quickWorld();
    const old = got(w);
    await w.first.admin.setPin(STRONG, PIN2);
    w.kv.data.set(KEY, old); // the late write of another page, or a writer of the storage
    await w.ctx().service.lock();
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], pin: "paused" });
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    const typedHere = w.ctx().service; // the lock screen's page: its unlock, then its note
    await typedHere.unlockWithPassword(STRONG);
    await notePassword(typedHere);
    await w.ctx().service.lock();
    expect(await pinIn(w.ctx().service, PIN)).toMatchObject({ ok: false, reason: "wrong" });
    expect((await pinIn(w.ctx().service, PIN2)).ok).toBe(true);
  });
});

describe("migrations (OWNER-DECISIONS/20, its second 2026-10-30 note)", () => {
  it("a PIN set before its record was its one way (sk_pin, no record): waits for the master password once, then works, also after a restart", async () => {
    const w = await quickWorld();
    w.kv.data.delete(KEY); // what the update leaves of a session PIN: its set-up, and nothing in session memory
    restart(w);
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], pin: "wait" }); // the line, no field
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    const svc = w.ctx().service;
    await svc.unlockWithRecoveryCode(w.recoveryCode); // a recovery key makes nothing
    await notePassword(svc);
    expect(rec(w)).toBeUndefined();
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    expect(got(w)).toMatchObject({ fails: 0, setup: (w.kv.data.get("sk_pin") as { kdf: { salt: string } }).kdf.salt });
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it('a record made with the old "Also after a restart" switch, its master password 30 days old: used as it is, no 14 days', async () => {
    const w = await quickWorld();
    const old = { ...got(w) };
    w.t.now += 30 * DAY;
    restart(w);
    expect(await lockScreen(w)).toMatchObject({ pin: "pin" });
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
    expect(got(w)).toEqual(old); // nothing made again, nothing migrated
    await w.ctx().service.lock();
    const typedHere = w.ctx().service; // the lock screen's page: its unlock, then its note
    await typedHere.unlockWithPassword(STRONG);
    await notePassword(typedHere);
    expect(got(w)).toEqual(old); // the steady state: the master password writes nothing either
  });
});

describe("the profile marker (§5.12 item 5) and lock when the popup closes (item 4)", () => {
  it("shared: no PIN offered, its record removed, one planted there never used", async () => {
    const w = await quickWorld();
    const old = got(w);
    const svc = w.ctx().service;
    await svc.updateSettings(applyPreset(await w.settings.get(), "shared"));
    expect(rec(w)).toBeUndefined();
    w.kv.data.set(KEY, old); // written back by a context that had not seen the switch
    restart(w);
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [] });
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
    expect(got(w).fails).toBe(0); // not even counted
    const typedHere = w.ctx().service; // the lock screen's page: its unlock, then its note
    await typedHere.unlockWithPassword(STRONG);
    await notePassword(typedHere);
    expect(got(w)).toEqual(old); // nothing made there
  });

  it("solo, lock every time the popup closes: the key lives in the popup's memory only, and the next popup opens with the PIN", async () => {
    const w = await quickWorld();
    const svc = w.ctx().service;
    await svc.updateSettings({ ...(await w.settings.get()), autoLock: { mode: "always" } }); // a hard lock
    const popup = w.ctx().service;
    await popup.unlockWithPassword(STRONG);
    expect(await w.area.get()).toBeNull(); // the unlocked key is not in shared storage
    expect(await lockScreen(w)).toMatchObject({ state: "locked", pin: "pin", field: { digits: 6 } });
    const next = w.ctx().service; // the popup closed (its memory gone) and opened again
    await next.openView();
    expect((await pinIn(next, PIN)).ok).toBe(true);
    expect(await w.area.get()).toBeNull();
  });

  it("a caller that leaves the profile out keeps the one stored: a shared profile stays shared whatever else it saves", async () => {
    const w = await quickWorld();
    const svc = w.ctx().service;
    await svc.updateSettings(applyPreset(await w.settings.get(), "shared"));
    await svc.updateSettings({ autoLock: { mode: "idle", minutes: 5 }, lockOnScreenLock: false }); // written before the marker
    expect((await w.settings.get()).profile).toBe("shared");
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    expect(rec(w)).toBeUndefined(); // still no PIN
  });

  it("a record saved before the marker reads as shared exactly when it is the shared preset's settings", async () => {
    const w = await quickWorld();
    await w.kv.set({
      sk_settings: {
        autoLock: { mode: "always" },
        lockOnScreenLock: true,
        display: { density: "standard", hideCodes: true, sort: "manual" },
      },
    });
    expect((await w.settings.get()).profile).toBe("shared");
    await w.kv.set({ sk_settings: { autoLock: { mode: "always" }, lockOnScreenLock: true } });
    expect((await w.settings.get()).profile).toBe("solo");
  });
});

describe("no PIN, pinKek or vault key on disk; no secret in any log", () => {
  it("chrome.storage.local holds the PIN's record (the vault key under a key only the PIN derives) and no PIN, pinKek or vault key; the diagnostics and the security record name none", async () => {
    const w = await quickWorld();
    const svc = w.ctx().service;
    await svc.lock();
    await pinIn(svc, WRONG);
    expect((await pinIn(svc, PIN)).ok).toBe(true); // every path walked: the PIN opened it, so the change below is allowed
    await w.first.admin.setPin(STRONG, PIN2);
    await svc.lock();
    for (let i = 0; i < 5; i++) await pinIn(svc, WRONG);
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    const disk = JSON.stringify([...w.kv.data.entries()]);
    const logs = JSON.stringify(w.diag) + JSON.stringify(await w.log.read());
    for (const secret of [PIN, PIN2, WRONG]) {
      expect(disk.includes(secret), secret).toBe(false);
      expect(logs.includes(secret), secret).toBe(false);
    }
    expect(disk.includes("sk_quick")).toBe(false);
    const vk = (await svc.openView()).state === "unlocked" ? (await w.area.get())!.vk : null;
    expect(vk).not.toBeNull();
    expect(disk.includes(vk!)).toBe(false);
    expect(logs.includes(vk!)).toBe(false);
  });

  it("a profile copy holds sk_pin (opens nothing without the vault key) and the record (opens with the PIN: the cost the box states)", async () => {
    const w = await quickWorld();
    const pin = w.kv.data.get("sk_pin") as Record<string, unknown>;
    expect(Object.keys(pin).sort()).toEqual(["digits", "iv", "kdf", "v", "vaultId", "vkId", "wrapped"]);
    expect(typeof pin.wrapped).toBe("string");
    expect(pin.wrapped).not.toBe(toB64(new Uint8Array(48)));
    expect(Object.keys(got(w)).sort()).toEqual(
      ["fails", "id", "lastPasswordAt", "mac", "setup", "v", "vaultId", "vkId", "wrap", "wraps"].sort(),
    );
  });
});

describe("errors are ServiceErrors with codes the pages map", () => {
  it("bad_pin, quick_off are codes (weak_pin went: a weak PIN is taken)", () => {
    for (const c of ["bad_pin", "quick_off"] as const) expect(new ServiceError(c).code).toBe(c);
  });
});
