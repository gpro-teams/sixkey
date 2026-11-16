// QUICK-UNLOCK §5.11 "Reads" for the device unlock (Stage 2), through the popup's real wiring (createPopupRuntime over
// counting storage areas, as quick-read-budget.test.ts measures the PIN): sk_prf comes with the pointer's first read
// (loadView `also`), never on a read of its own; the lock screen stays within the open budget; a device unlock reads no
// more of chrome.storage.local than a password unlock; a password unlock with a credential enrolled reads and writes
// nothing more than before, except the master password's time, written at most once a day (YR-14: one read of sk_prf and
// one write, in the vault lock).
import { describe, expect, it } from "vitest";
import { DeviceAdmin } from "../../src/core/service/device-admin";
import { DeviceUnlocker } from "../../src/core/service/device-unlock";
import { addEntry } from "../../src/core/vault/ops";
import { createRuntime } from "../../src/platform/runtime";
import { createPopupRuntime, type PopupRuntime } from "../../src/platform/runtime-base";
import { loadScreen, screenOf } from "../../src/popup/load";
import { FakeAuthenticator, type FakeOptions } from "../helpers/fake-webauthn";
import { STRONG } from "../helpers/vaults";

const DAY = 86_400_000;

function countingArea() {
  const data = new Map<string, unknown>();
  const c = { gets: 0, keys: [] as string[][], sets: [] as string[][] };
  const area = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      c.gets++;
      c.keys.push(ks);
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      c.sets.push(Object.keys(items));
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
  return { data, c, area: area as unknown as chrome.storage.StorageArea };
}

async function profile(fake: Partial<FakeOptions> | null) {
  const local = countingArea();
  const session = countingArea();
  const wa = new FakeAuthenticator(fake ?? {});
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
  if (fake)
    expect((await new DeviceAdmin(rt.service, wa).enrol(STRONG, { name: "Touch ID", allowSynced: false })).ok).toBe(
      true,
    );
  // the popup opened once while unlocked (the one full check a new store gets), as quick-read-budget.test.ts does
  expect((await loadScreen(createRuntime({ local: local.area, session: session.area, mirror: null }))).k).toBe("main");
  await rt.service.lock();
  /** A new popup, counters at zero. */
  const popup = (): PopupRuntime => {
    local.c.gets = 0;
    local.c.keys = [];
    local.c.sets = [];
    session.c.gets = 0;
    return createPopupRuntime({ local: local.area, session: session.area, mirror: null });
  };
  const count = () => ({ reads: local.c.gets, keys: [...local.c.keys], sets: [...local.c.sets] });
  return { local, session, rt, wa, popup, count };
}

describe("reads of the device unlock (§5.11)", () => {
  it("the lock screen with a credential: within the open budget, sk_prf in the pointer's read only", async () => {
    for (const fake of [{}, { prf: false }]) {
      const f = await profile(fake);
      const screen = await loadScreen(f.popup());
      expect(screen).toMatchObject({ k: "locked", device: fake.prf === false ? { gate: true } : { prf: true } });
      const c = f.count();
      expect(c.reads, JSON.stringify(c.keys)).toBeLessThanOrEqual(4);
      expect(c.keys[0]).toContain("sk_prf");
      expect(c.keys.filter((k) => k.includes("sk_prf"))).toHaveLength(1);
      expect(c.sets).toEqual([]);
    }
  });

  it("lock screen + device unlock reads no more of chrome.storage.local than lock screen + password unlock", async () => {
    for (const fake of [{}, { prf: false }]) {
      const f = await profile(fake);
      const rtPw = f.popup();
      expect((await loadScreen(rtPw)).k).toBe("locked");
      expect(screenOf((await rtPw.service.unlockWithPassword(STRONG)).view).k).toBe("main");
      const password = f.count();
      await f.rt.service.lock();
      const rtDev = f.popup();
      expect((await loadScreen(rtDev)).k).toBe("locked");
      const u = new DeviceUnlocker(rtDev.service, f.wa);
      const r = fake.prf === false ? await u.unlockWithGate() : await u.unlockWithPrf();
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const dev = f.count();
      expect(
        dev.reads,
        `device ${JSON.stringify(dev.keys)} / password ${JSON.stringify(password.keys)}`,
      ).toBeLessThanOrEqual(password.reads);
      expect(dev.reads).toBeLessThanOrEqual(8); // the unlock gate (read-budget.test.ts)
      expect(dev.sets.filter((k) => k.includes("sk_prf"))).toEqual([]); // a device unlock writes nothing of sk_prf
    }
  });

  it("a password unlock with a credential: the same reads as without one, while the master password's time is fresh", async () => {
    const none = await profile(null);
    const rt0 = none.popup();
    expect(await loadScreen(rt0)).toEqual({ k: "locked" });
    await rt0.service.unlockWithPassword(STRONG);
    const without = none.count();
    expect(without.reads).toBe(7); // as read-budget.test.ts measures it today
    const f = await profile({});
    const rt = f.popup();
    expect((await loadScreen(rt)).k).toBe("locked");
    await rt.service.unlockWithPassword(STRONG);
    const c = f.count();
    expect(c.reads, JSON.stringify(c.keys)).toBe(without.reads);
    expect(c.keys.map((k) => k.filter((x) => x !== "sk_prf")).every((k) => k.length > 0)).toBe(true); // none for sk_prf alone
    expect(c.sets.filter((k) => k.includes("sk_prf"))).toEqual([]);
  });

  it("after it, the lock screen's note of the master password's time: one read of sk_prf, and a write at most once a day (YR-14)", async () => {
    const real = Date.now;
    const f = await profile({});
    try {
      const later = real() + DAY + 1;
      Date.now = () => later;
      const rt = f.popup();
      expect((await loadScreen(rt)).k).toBe("locked");
      await rt.service.unlockWithPassword(STRONG);
      expect(f.count().reads).toBe(7); // the unlock: as without a credential
      expect(f.count().sets.filter((k) => k.includes("sk_prf"))).toEqual([]);
      await new DeviceUnlocker(rt.service, f.wa).notePasswordTyped(); // the lock screen's device chunk, after it
      const c = f.count();
      expect(c.reads, JSON.stringify(c.keys)).toBe(8);
      expect(c.keys.at(-1)).toEqual(["sk_prf"]);
      expect(c.sets.filter((k) => k.includes("sk_prf"))).toEqual([["sk_prf"]]);
      expect((f.local.data.get("sk_prf") as { lastPasswordAt: number }).lastPasswordAt).toBe(later);
      await f.rt.service.lock();
      const again = f.popup();
      await again.service.unlockWithPassword(STRONG);
      await new DeviceUnlocker(again.service, f.wa).notePasswordTyped();
      expect(f.count().sets.filter((k) => k.includes("sk_prf"))).toEqual([]); // not twice in a day
    } finally {
      Date.now = real;
    }
  });
});
