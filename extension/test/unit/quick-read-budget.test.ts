// QUICK-UNLOCK §5.11 "Reads", through the popup's real wiring (createPopupRuntime over counting storage areas, as
// read-budget.test.ts measures it): a PIN unlock (its record's, OWNER-DECISIONS/20 and its 2026-10-30 notes) reads no
// more of chrome.storage.local than a password unlock, but for its four reads in the vault lock: the counter's two (the
// try written before the derivation, the compare-and-set after the right PIN: PIN-RESTART-NOTES.md §3, §8.3) and the
// active keyring's check (pointer, slot: review of PINONE, PO-01; §18.11 has the numbers before and after); the lock screen with a PIN stays within the open budget (4 reads,
// one slot); sk_pin comes with the pointer's first read (loadView `also`), never on a read of its own; with no PIN set, a
// password unlock reads exactly the keys it read before Stage 1, plus sk_pin in that same first get.
import { describe, expect, it } from "vitest";
import { PinAdmin } from "../../src/core/service/pin-admin";
import { pinKit } from "../../src/core/service/pin-kit";
import { restartOffer } from "../../src/core/service/pin-restart-count";
import { unlock as viaRecord } from "../../src/core/service/pin-restart-steps";
import { addEntry } from "../../src/core/vault/ops";
import { createRuntime } from "../../src/platform/runtime";
import { createPopupRuntime, type PopupRuntime } from "../../src/platform/runtime-base";
import { loadScreen, screenOf } from "../../src/popup/load";
import { STRONG } from "../helpers/vaults";

const PIN = "246813";

function countingArea() {
  const data = new Map<string, unknown>();
  const c = { gets: 0, keys: [] as string[][] };
  const area = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      c.gets++;
      c.keys.push(ks);
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
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
  if (withPin) await new PinAdmin(rt.service).setPin(STRONG, PIN);
  expect((await loadScreen(createRuntime({ local: local.area, session: session.area, mirror: null }))).k).toBe("main");
  await rt.service.lock();
  /** A new popup, counters at zero. */
  const popup = (): PopupRuntime => {
    local.c.gets = 0;
    local.c.keys = [];
    session.c.gets = 0;
    return createPopupRuntime({ local: local.area, session: session.area, mirror: null });
  };
  const count = () => ({ reads: local.c.gets, keys: [...local.c.keys], sessionReads: session.c.gets });
  return { local, session, rt, popup, count };
}

describe("reads of the PIN (§5.11)", () => {
  it("the lock screen with a PIN: within the open budget, the PIN shown, sk_pin in the pointer's read", async () => {
    const f = await profile(true);
    const rt = f.popup();
    expect(await loadScreen(rt)).toEqual({ k: "locked" });
    expect(restartOffer(rt.service, pinKit)).toMatchObject({ field: { digits: 6, triesLeft: 5 } });
    const c = f.count();
    expect(c.reads, JSON.stringify(c.keys)).toBeLessThanOrEqual(4);
    expect(c.keys[0]).toContain("sk_pin");
    expect(c.keys.filter((k) => k.includes("sk_pin"))).toHaveLength(1);
  });

  it("lock screen + PIN unlock reads no more of chrome.storage.local than lock screen + password unlock, but for its four reads in the vault lock", async () => {
    const f = await profile(true);
    const rtPw = f.popup();
    expect((await loadScreen(rtPw)).k).toBe("locked");
    expect(screenOf((await rtPw.service.unlockWithPassword(STRONG)).view).k).toBe("main");
    const password = f.count();
    await f.rt.service.lock();
    const rtPin = f.popup();
    expect((await loadScreen(rtPin)).k).toBe("locked");
    const r = await viaRecord(rtPin.service, PIN, pinKit);
    expect(r.ok).toBe(true);
    if (r.ok) expect(screenOf(r.view).k).toBe("main");
    const pin = f.count();
    // in the vault lock, its own reads: the counter's two (the record alone: the try first; after the right PIN, the
    // compare-and-set) and the keyring's check beside the second (the pointer, then the active slot: the keys are still
    // the record's; review of PINONE, PO-01). Beyond them, no more than a password unlock reads
    const lockReads = pin.keys.slice(-5, -1);
    expect(lockReads, JSON.stringify(pin.keys)).toEqual([
      ["sk_pin_restart"],
      ["sk_pin_restart"],
      ["sk_active"],
      ["sk_slot_b"],
    ]);
    expect(
      pin.reads - lockReads.length,
      `pin ${JSON.stringify(pin.keys)} / password ${JSON.stringify(password.keys)}`,
    ).toBeLessThanOrEqual(password.reads);
    // sk_pin only with the pointer, each time
    expect(pin.keys.filter((k) => k.includes("sk_pin")).length).toBeLessThanOrEqual(2);
  });

  it("with no PIN set, a password unlock reads what it read before Stage 1: the same gets, sk_pin only inside the first", async () => {
    const f = await profile(false);
    const rt = f.popup();
    expect(await loadScreen(rt)).toEqual({ k: "locked" }); // no PIN field, the screen as before
    await rt.service.unlockWithPassword(STRONG);
    const c = f.count();
    expect(c.reads).toBe(7); // as read-budget.test.ts measures it today
    const withoutPin = c.keys.map((k) => k.filter((x) => x !== "sk_pin"));
    expect(withoutPin.every((k) => k.length > 0)).toBe(true); // no get is for sk_pin alone
    expect(f.session.data.has("sk_quick")).toBe(false); // and nothing is armed
  });
});
