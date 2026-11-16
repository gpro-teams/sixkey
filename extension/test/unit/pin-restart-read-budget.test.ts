// The PIN record's reads (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/PIN-RESTART-NOTES.md §8, §18),
// through the popup's real wiring (createPopupRuntime over counting storage areas): the record comes with the pointer's
// first read (loadView `also`), never on a read of its own, so a popup opening reads chrome.storage.local exactly as often
// with a PIN as without one, and the lock screen tells what it offers from that very read (ServiceCore.seen,
// pin-restart-count.ts restartOffer: no read at all); the lock screen's PIN unlock after a restart reads no more than a
// password unlock there (its four reads in the vault lock included: the try written first; then the compare-and-set and
// the active keyring's check, review of PINONE, PO-01); the master password's note, in the steady state, exactly the
// store's read (the record and the settings with the pointer) and the session's look, no write and no derivation.
import { describe, expect, it } from "vitest";
import { PinAdmin } from "../../src/core/service/pin-admin";
import { pinKit } from "../../src/core/service/pin-kit";
import { restartOffer } from "../../src/core/service/pin-restart-count";
import { notePassword, unlock as viaRecord } from "../../src/core/service/pin-restart-steps";
import { addEntry } from "../../src/core/vault/ops";
import { createRuntime } from "../../src/platform/runtime";
import { createPopupRuntime, type PopupRuntime } from "../../src/platform/runtime-base";
import { loadScreen, screenOf } from "../../src/popup/load";
import { STRONG } from "../helpers/vaults";

const PIN = "246813";

function countingArea() {
  const data = new Map<string, unknown>();
  const c = { gets: 0, sets: 0, keys: [] as string[][] };
  const area = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      c.gets++;
      c.keys.push(ks);
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      c.sets++;
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      c.sets++;
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
  return { data, c, area: area as unknown as chrome.storage.StorageArea };
}

async function profile(withPin: boolean) {
  const local = countingArea();
  const session = countingArea();
  const rt = createRuntime({ local: local.area, session: session.area, mirror: null });
  await rt.service.create(await rt.service.prepareKeys(STRONG));
  await rt.service.mutate(
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
  if (withPin) await new PinAdmin(rt.service).setPin(STRONG, PIN); // the PIN and its record
  await rt.service.lock();
  /** A browser restart: chrome.storage.session emptied. */
  const restart = () => session.data.clear();
  /** A new popup, counters at zero. */
  const popup = (): PopupRuntime => {
    local.c.gets = 0;
    local.c.sets = 0;
    local.c.keys = [];
    session.c.gets = 0;
    return createPopupRuntime({ local: local.area, session: session.area, mirror: null });
  };
  const count = () => ({ reads: local.c.gets, sets: local.c.sets, keys: [...local.c.keys] });
  return { local, session, rt, popup, count, restart };
}

describe("the PIN record's reads", () => {
  for (const restarted of [true, false])
    it(`a popup opening${restarted ? " after a restart" : ""} reads chrome.storage.local as often with a PIN as without; the record in the first get`, async () => {
      const without = await profile(false);
      if (restarted) without.restart();
      expect(await loadScreen(without.popup())).toEqual({ k: "locked" });
      const base = without.count();
      const f = await profile(true);
      if (restarted) f.restart();
      const rt = f.popup();
      expect(await loadScreen(rt)).toEqual({ k: "locked" });
      const c = f.count();
      // what the lock screen offers, told from that read: no read of its own
      expect(restartOffer(rt.service, pinKit)).toEqual({ state: "pin", field: { digits: 6, triesLeft: 5 } });
      expect(f.count().reads).toBe(c.reads);
      expect(c.reads, JSON.stringify(c.keys)).toBe(base.reads);
      expect(c.reads).toBeLessThanOrEqual(4); // the open budget (read-budget.test.ts)
      expect(c.keys[0]).toContain("sk_pin_restart");
      expect(c.keys.filter((k) => k.includes("sk_pin_restart"))).toHaveLength(1);
      expect(c.sets).toBe(0); // a look writes nothing
    });

  it("the lock screen's PIN after a restart reads no more than a password unlock there, its four reads in the vault lock included", async () => {
    const f = await profile(true);
    f.restart();
    const rtPw = f.popup();
    expect((await loadScreen(rtPw)).k).toBe("locked");
    expect(screenOf((await rtPw.service.unlockWithPassword(STRONG)).view).k).toBe("main");
    const password = f.count();
    await f.rt.service.lock();
    f.restart();
    const rtPin = f.popup();
    expect((await loadScreen(rtPin)).k).toBe("locked");
    expect(restartOffer(rtPin.service, pinKit)).toMatchObject({ state: "pin" });
    const r = await viaRecord(rtPin.service, PIN, pinKit);
    expect(r.ok).toBe(true);
    const pin = f.count();
    // the record's unlock reads the settings, the store with the pointer (the record in it), and in the vault lock its
    // counter twice (the try first; the compare-and-set after the right PIN) and the active keyring (the pointer, the
    // slot: its keys still the record's, PO-01): no more than a password unlock reads
    expect(
      pin.reads,
      `pin ${JSON.stringify(pin.keys)} / password ${JSON.stringify(password.keys)}`,
    ).toBeLessThanOrEqual(password.reads);
    expect(pin.keys.filter((k) => k.length === 1 && k[0] === "sk_pin_restart")).toHaveLength(2);
    expect(pin.keys.filter((k) => k.length === 1 && k[0] === "sk_active")).toHaveLength(1); // the keyring's check
    expect(pin.sets).toBeGreaterThanOrEqual(2); // the count, and the count back (plus the session's own writes)
  });

  it("the master password's note in the steady state: the store's read (the record and the settings in it) and the session's look, exactly, no write", async () => {
    const f = await profile(true);
    const rt = f.popup();
    await rt.service.unlockWithPassword(STRONG);
    f.local.c.gets = 0;
    f.local.c.sets = 0;
    f.local.c.keys = [];
    await notePassword(rt.service, pinKit);
    // the pointer with the record, sk_pin and the settings (loadView's `also`), the active slot, and the settings once more
    // for the session's own look (RoutedSession, then the vault key from the session: sessionVk with the settings already
    // read, whose key checks the record's MAC): no write, no derivation. dda3668's note read the record only (it had
    // nothing to check but the 14 days); this one checks the record against the keys and their MAC (review r3,
    // PINR-R2-01) with the session's vault key, which takes the store's read and the session's (review of PINONE, PO-09)
    expect(f.count().keys).toEqual([
      ["sk_active", "sk_events", "sk_keychange", "sk_store_v", "sk_pin", "sk_pin_restart", "sk_prf", "sk_settings"],
      ["sk_slot_b"],
      ["sk_settings"],
    ]);
    expect(f.count().sets).toBe(0);
  });
});
