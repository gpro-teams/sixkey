// The device unlock's writes under a page that dies at any write (QUICK-UNLOCK Stage 2; docs/design/notes/PRF-NOTES.md
// "Crash matrix"). As test/fault/quick-pin-crash.test.ts does for the PIN: every write to chrome.storage.local or
// chrome.storage.session is a point where the page can die, before the write lands or just after it; each operation is
// run once per point and side, then a new, healthy page on the same storage checks what must hold whatever the point:
//   - enrolling: sk_prf holds the whole credential or nothing of it; a stored one opens Sixkey (a PRF one at once and
//     after a restart, a gate one after the next master password); never an arming without its credential;
//   - removing: once the credential is gone, nothing opens with it, now or after the next master password; while it is
//     still listed it can be removed again;
//   - turning one back on: still paused (one touch again) or working, never a wrap under another key;
//   - removing the last gate beside a PIN: the PIN (its own record since 2026-10-30) always opens; the gate's arming never
//     outlives the credential (OWNER-DECISIONS/17 Q1);
//   - the master password's time: the old one or the new one, never a damaged record;
//   - a key change: the device unlock never opens with a wrap of an older key, and the master password always works.
import { describe, expect, it } from "vitest";
import type { QuickSession } from "../../src/core/crypto/pin";
import { parsePrfRecord, type PrfRecord } from "../../src/core/crypto/prf-record";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { NO_PAGE, STRONG } from "../helpers/vaults";
import { PIN, pinIn, quickWorld, type QuickWorld } from "../helpers/quick-world";

class Dead extends Error {}
/** Dies at write number `at` (1-based), "before" it lands or "after". */
class Proc {
  n = 0;
  dead = false;
  constructor(
    readonly at: number,
    readonly side: "before" | "after",
  ) {}
  async write(land: () => Promise<void>) {
    if (this.dead) throw new Dead();
    this.n++;
    if (this.n === this.at && this.side === "before") {
      this.dead = true;
      throw new Dead();
    }
    await land();
    if (this.n === this.at) {
      this.dead = true;
      throw new Dead();
    }
  }
}
class FaultKV implements KV {
  constructor(
    private readonly inner: MemoryKV,
    private readonly p: Proc,
  ) {}
  async get(keys: string[]) {
    if (this.p.dead) throw new Dead();
    return this.inner.get(keys);
  }
  keys() {
    return this.inner.keys();
  }
  set(items: Record<string, unknown>) {
    return this.p.write(() => this.inner.set(items));
  }
  remove(keys: string[]) {
    return this.p.write(() => this.inner.remove(keys));
  }
}
class FaultSession implements SessionCache {
  constructor(
    private readonly inner: MemorySession,
    private readonly p: Proc,
  ) {}
  async get() {
    if (this.p.dead) throw new Dead();
    return this.inner.get();
  }
  set(d: SessionData) {
    return this.p.write(() => this.inner.set(d));
  }
  clear() {
    return this.p.write(() => this.inner.clear());
  }
  lockEpoch() {
    return this.inner.lockEpoch();
  }
  bumpLockEpoch() {
    return this.p.write(() => this.inner.bumpLockEpoch());
  }
  async getQuick() {
    if (this.p.dead) throw new Dead();
    return this.inner.getQuick();
  }
  setQuick(q: QuickSession) {
    return this.p.write(() => this.inner.setQuick(q));
  }
  clearQuick() {
    return this.p.write(() => this.inner.clearQuick());
  }
}

/**
 * Run `op` in a page that dies at each write in turn (both sides), on a fresh profile from `world` each time, then
 * `check` in a new, healthy page. Returns how many points were tried (the matrix is not vacuous).
 */
async function matrix(
  world: () => Promise<QuickWorld>,
  op: (page: ReturnType<QuickWorld["ctx"]>, w: QuickWorld) => Promise<unknown>,
  check: (w: QuickWorld, crashed: string) => Promise<void>,
): Promise<number> {
  let points = 0;
  for (let at = 1; ; at++) {
    let finished = false;
    for (const side of ["before", "after"] as const) {
      const w = await world();
      const p = new Proc(at, side);
      const page = w.ctx({ local: new FaultKV(w.kv, p), session: new FaultSession(w.area, p) });
      try {
        await op(page, w);
        finished = !p.dead;
      } catch (e) {
        if (!(e instanceof Dead)) throw e;
      }
      if (finished) break;
      points++;
      await check(w, `write ${at} ${side}`);
    }
    if (finished) return points;
  }
}

const recOf = (w: QuickWorld): PrfRecord | null | "damaged" => parsePrfRecord(w.kv.data.get("sk_prf"));
const enrol = (page: ReturnType<QuickWorld["ctx"]>) =>
  page.device.enrol(STRONG, { name: "Touch ID", allowSynced: false });
/** After the page died: a browser restart's worth of a check (chrome.storage.session gone) is done by the caller. */
async function passwordThenLock(w: QuickWorld) {
  const page = w.ctx();
  await page.service.unlockWithPassword(STRONG);
  await page.service.lock();
}

describe("enrolment under a crash", () => {
  it("a PRF credential: all of it or nothing; a stored one opens Sixkey, also after a restart", async () => {
    const points = await matrix(
      () => quickWorld({ pin: null }),
      (page) => enrol(page),
      async (w, where) => {
        const rec = recOf(w);
        expect(rec, where).not.toBe("damaged");
        await w.ctx().service.lock();
        w.area.data = null;
        w.area.quick = null; // a restart
        const r = await w.ctx().unlocker.unlockWithPrf();
        if (rec === null) expect(r, where).toEqual({ ok: false, reason: "ended" });
        else expect(r, where).toMatchObject({ ok: true });
        await w.ctx().service.lock();
        expect((await w.ctx().service.unlockWithPassword(STRONG)).view.state, where).toBe("unlocked");
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("a gate: all of it or nothing; never an arming without its credential; the next master password arms it", async () => {
    const points = await matrix(
      () => quickWorld({ pin: null, fake: { prf: false } }),
      (page) => enrol(page),
      async (w, where) => {
        const rec = recOf(w);
        expect(rec, where).not.toBe("damaged");
        const armed = await w.area.getQuick();
        if (rec === null) expect(armed, where).toBeNull();
        await w.ctx().service.lock();
        await passwordThenLock(w);
        const r = await w.ctx().unlocker.unlockWithGate();
        if (rec === null) expect(r, where).toEqual({ ok: false, reason: "ended" });
        else expect(r, where).toMatchObject({ ok: true });
      },
    );
    expect(points).toBeGreaterThanOrEqual(3);
  }, 120_000);
});

describe("removal under a crash", () => {
  it("a removed gate never opens anything, now or after the next master password; one still listed can be removed", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: null, fake: { prf: false } });
        expect((await enrol(w.first)).ok).toBe(true);
        return w;
      },
      (page, w) => {
        const r = recOf(w) as PrfRecord;
        return page.device.remove(STRONG, r.creds[0]!.id);
      },
      async (w, where) => {
        const rec = recOf(w);
        expect(rec, where).not.toBe("damaged");
        const listed = rec !== null && rec !== "damaged" && rec.creds.length > 0;
        await w.ctx().service.lock();
        const now = await w.ctx().unlocker.unlockWithGate();
        if (!listed) expect(now, where).toEqual({ ok: false, reason: "ended" });
        await passwordThenLock(w);
        const after = await w.ctx().unlocker.unlockWithGate();
        if (!listed) expect(after, where).toEqual({ ok: false, reason: "ended" });
        else {
          expect(after, where).toMatchObject({ ok: true });
          const page = w.ctx();
          await page.service.unlockWithPassword(STRONG);
          await page.device.remove(STRONG, (rec as PrfRecord).creds[0]!.id);
          expect(recOf(w), where).toBeNull();
        }
      },
    );
    expect(points).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("a removed PRF credential never opens Sixkey again", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: null });
        expect((await enrol(w.first)).ok).toBe(true);
        return w;
      },
      (page, w) => page.device.remove(STRONG, (recOf(w) as PrfRecord).creds[0]!.id),
      async (w, where) => {
        const rec = recOf(w);
        expect(rec, where).not.toBe("damaged");
        await w.ctx().service.lock();
        const r = await w.ctx().unlocker.unlockWithPrf();
        if (rec === null) expect(r, where).toEqual({ ok: false, reason: "ended" });
        else expect(r, where).toMatchObject({ ok: true });
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe("a key change, turning back on, the session choice, the password's time, under a crash", () => {
  it("a rotation: the PRF unlock never opens with an older key's wrap; the master password opens the current vault", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: null });
        expect((await enrol(w.first)).ok).toBe(true);
        return w;
      },
      (page) => page.service.rotateKey(STRONG, NO_PAGE),
      async (w, where) => {
        const rec = recOf(w);
        expect(rec, where).not.toBe("damaged");
        const page = w.ctx();
        await page.service.lock();
        const r = await page.unlocker.unlockWithPrf();
        const kr = (await page.service.currentGeneration())!.keyring;
        if (r.ok) expect(r.view.state, where).toBe("unlocked");
        // whatever it answered, a wrap it could have used is under the current key, and the session's key is current
        if (r.ok) expect((rec as PrfRecord).creds[0]!.wrap!.vkId, where).toBe(kr.vkId);
        else expect(["paused", "ended"], where).toContain(r.reason);
        await page.service.lock();
        await page.service.unlockWithPassword(STRONG);
        expect((await page.service.status()).state, where).toBe("unlocked");
      },
    );
    expect(points).toBeGreaterThanOrEqual(4);
  }, 300_000);

  it("turning back on: still paused, or working under the current key", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: null });
        expect((await enrol(w.first)).ok).toBe(true);
        await w.first.service.rotateKey(STRONG, NO_PAGE);
        return w;
      },
      (page, w) => page.device.reenable(STRONG, (recOf(w) as PrfRecord).creds[0]!.id),
      async (w, where) => {
        const rec = recOf(w) as PrfRecord;
        expect(rec, where).not.toBe("damaged");
        const page = w.ctx();
        await page.service.lock();
        const r = await page.unlocker.unlockWithPrf();
        if (rec.creds[0]!.wrap === null) expect(r, where).toEqual({ ok: false, reason: "paused" });
        else expect(r, where).toMatchObject({ ok: true });
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("the last gate removed beside a PIN: the PIN (its own record) always opens; the gate's arming never outlives its credential", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: PIN, fake: { prf: false } });
        expect((await enrol(w.first)).ok).toBe(true);
        expect(await w.area.getQuick()).toMatchObject({ method: "device" }); // the gate's alone
        return w;
      },
      (page, w) => page.device.remove(STRONG, (recOf(w) as PrfRecord).creds[0]!.id),
      async (w, where) => {
        const q = await w.area.getQuick();
        const rec = recOf(w);
        if (rec === null) expect(q, where).toBeNull(); // gone with the credential
        await w.ctx().service.lock();
        expect(await pinIn(w.ctx().service, PIN), where).toMatchObject({ ok: true });
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("the master password's time: the old one or the new, never a damaged record", async () => {
    const DAY = 86_400_000;
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: null });
        expect((await enrol(w.first)).ok).toBe(true);
        await w.first.service.lock();
        w.t.now += 2 * DAY;
        return w;
      },
      async (page) => {
        await page.service.unlockWithPassword(STRONG);
        await page.unlocker.notePasswordTyped(); // as the lock screen does after it
      },
      async (w, where) => {
        const rec = recOf(w) as PrfRecord;
        expect(rec, where).not.toBe("damaged");
        expect([w.t.now, w.t.now - 2 * DAY], where).toContain(rec.lastPasswordAt);
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
