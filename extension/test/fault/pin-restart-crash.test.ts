// The PIN record's write orders under a page that dies at any write (OWNER-DECISIONS/20 and its 2026-10-30 notes;
// docs/design/notes/PIN-RESTART-NOTES.md §6, §18). Every write to chrome.storage.local or chrome.storage.session is a point where the page can
// die, before the write lands or just after it; each operation is run once per point and side, on a fresh profile; then
// a healthy page, on the same storage (and, where it says so, after a browser restart), checks what must hold:
//   - a PIN try with the record: the count is written before any derivation ("the count half written": dead before it
//     lands, nothing was tried; after, the try is spent though nothing was learned); a recorded wrong PIN always spent
//     one; never more than one per try; the right PIN still opens while tries are left;
//   - the 5th wrong PIN ("the deletion half written"): whatever the point, the record never opens again with the PIN
//     until the master password makes it anew, which it then does;
//   - setting a PIN: its record is whole (it opens) or not there (the PIN then waits for the master password);
//   - changing the PIN: the old PIN never opens after a restart once the new set-up is stored; the new one once its
//     record is stored; the change visibly happened or not;
//   - removing the PIN, "End quick unlock now": once the record is gone (or its wrap), no PIN opens after a restart;
//   - a key change: once the new keyring is stored, the record never opens, whether or not its wrap was set aside yet,
//     until the master password makes it again (which it then does).
import { describe, expect, it, vi } from "vitest";
import type { QuickSession } from "../../src/core/crypto/pin";
import type { RestartRecord } from "../../src/core/crypto/pin-restart";
import { pinKit } from "../../src/core/service/pin-kit";
import { notePassword, unlock as viaRecord } from "../../src/core/service/pin-restart-steps";
import type { VaultService } from "../../src/core/service/service";
import { MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { NO_PAGE, STRONG } from "../helpers/vaults";
import { PIN, PIN2, quickWorld, type QuickWorld } from "../helpers/quick-world";

const WRONG = "975310";
const KEY = "sk_pin_restart";

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
 * Run `op` in a page that dies at each write in turn (both sides), on a fresh profile from `world` each time, then `check`
 * in a new, healthy page. Returns how many points were tried (the matrix is not vacuous).
 */
async function matrix(
  world: () => Promise<QuickWorld>,
  op: (page: ReturnType<QuickWorld["ctx"]>, w: QuickWorld) => Promise<unknown>,
  check: (w: QuickWorld, crashed: { at: number; side: string }) => Promise<void>,
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
      await check(w, { at, side });
    }
    if (finished) return points;
  }
}

const rec = (w: QuickWorld) => w.kv.data.get(KEY) as RestartRecord | undefined;
/** The record, which must be stored (its absence fails an assertion here, not a property read later). */
const got = (w: QuickWorld): RestartRecord => {
  const r = rec(w);
  expect(r, "sk_pin_restart is stored").toBeDefined();
  return r!;
};
/** A browser restart: chrome.storage.session emptied. */
function restart(w: QuickWorld) {
  w.area.quick = null;
  w.area.data = null;
}
/** The lock screen's PIN (Locked.tsx): the record's own unlock. */
const pinIn = (svc: VaultService, pin: string) => viaRecord(svc, pin, pinKit);
/** The PIN opens Sixkey in a healthy page, after a restart (the record's path). */
async function opensAfterRestart(w: QuickWorld, pin: string) {
  restart(w);
  const ok = (await pinIn(w.ctx().service, pin)).ok;
  restart(w);
  return ok;
}
/** The lock screen's master password, then its note. */
async function passwordAgain(w: QuickWorld) {
  const s = w.ctx().service;
  await s.lock();
  await s.unlockWithPassword(STRONG);
  await notePassword(s, pinKit);
  await s.lock();
}
/** A world with a PIN and its record (every PIN has one since 2026-10-30). */
const onWorld = () => quickWorld();
const failed = async (w: QuickWorld) => (await w.kinds()).filter((k) => k === "pin_failed").length;

describe("crash matrix: a PIN try with the record (after a restart)", () => {
  it("a wrong PIN: the count lands before anything is tried; a recorded wrong PIN always spent one; at most one", async () => {
    const points = await matrix(
      async () => {
        const w = await onWorld();
        restart(w);
        return w;
      },
      (page) => pinIn(page.service, WRONG),
      async (w, at) => {
        const where = JSON.stringify(at);
        const fails = got(w).fails;
        expect(fails, where).toBeLessThanOrEqual(1);
        if ((await failed(w)) > 0) expect(fails, where).toBe(1);
        // "the count half written": dead before it landed, nothing was tried; after, spent, nothing learned
        expect(await opensAfterRestart(w, PIN), where).toBe(true);
        expect(got(w).fails, where).toBe(0);
      },
    );
    expect(points).toBeGreaterThanOrEqual(4); // the count, the security record (both sides)
  }, 120_000);

  it("the right PIN: the count lands first, then goes back to none; the PIN keeps opening", async () => {
    const points = await matrix(
      async () => {
        const w = await onWorld();
        restart(w);
        return w;
      },
      (page) => pinIn(page.service, PIN),
      async (w, at) => {
        const where = JSON.stringify(at);
        expect(got(w).fails, where).toBeLessThanOrEqual(1);
        expect(got(w).wrap, where).not.toBeNull();
        expect(await opensAfterRestart(w, PIN), where).toBe(true);
      },
    );
    expect(points).toBeGreaterThanOrEqual(4); // the count, the count back, the session (both sides)
  }, 120_000);

  it("the 5th wrong PIN, the deletion half written at any point: the record never opens again until the master password", async () => {
    const points = await matrix(
      async () => {
        const w = await onWorld();
        restart(w);
        for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
        return w;
      },
      (page) => pinIn(page.service, WRONG),
      async (w, at) => {
        const where = JSON.stringify(at);
        const r = got(w);
        // either the count of 5 landed (its wrap may still be there: then no try is left) or the try never started
        if (r.wrap) expect(r.fails === 5 || r.fails === 4, where).toBe(true);
        const counted = r.fails === 5 || r.wrap === null;
        expect(await opensAfterRestart(w, PIN), where).toBe(!counted);
        if (counted) {
          // the master password once makes it anew: a new wrap, no count
          await passwordAgain(w);
          expect(got(w).wrap, where).not.toBeNull();
          expect(got(w).fails, where).toBe(0);
          expect(await opensAfterRestart(w, PIN), where).toBe(true);
        }
      },
    );
    expect(points).toBeGreaterThanOrEqual(6); // the count, pin_failed, the wrap set aside, quick_ended
  }, 120_000);
});

describe("crash matrix: setting, changing and removing the PIN, ending, a key change", () => {
  it("setting a PIN: its record is whole (it opens after a restart) or it is not there, and then the master password makes it", async () => {
    const points = await matrix(
      () => quickWorld({ pin: null }),
      (page) => page.admin.setPin(STRONG, PIN),
      async (w, at) => {
        const where = JSON.stringify(at);
        expect(await opensAfterRestart(w, PIN), where).toBe(rec(w) !== undefined);
        if (w.kv.data.has("sk_pin")) {
          await passwordAgain(w);
          expect(await opensAfterRestart(w, PIN), where).toBe(true);
        } else expect(rec(w), where).toBeUndefined();
      },
    );
    expect(points).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("changing the PIN: the old PIN never opens after a restart once the new set-up is stored; the new one once its record is", async () => {
    let oldSalt = "";
    const points = await matrix(
      async () => {
        const w = await onWorld();
        oldSalt = (w.kv.data.get("sk_pin") as { kdf: { salt: string } }).kdf.salt;
        return w;
      },
      (page) => page.admin.setPin(STRONG, PIN2),
      async (w, at) => {
        const where = JSON.stringify(at);
        const changed = (w.kv.data.get("sk_pin") as { kdf: { salt: string } }).kdf.salt !== oldSalt;
        const r = rec(w);
        if (changed) expect(await opensAfterRestart(w, PIN), where).toBe(false);
        else expect(await opensAfterRestart(w, PIN), where).toBe(r !== undefined); // visibly not changed
        expect(await opensAfterRestart(w, PIN2), where).toBe(changed && r !== undefined);
        if (r) expect(r.setup === oldSalt, where).toBe(!changed); // a record only ever of the stored set-up
      },
    );
    expect(points).toBeGreaterThanOrEqual(8);
  }, 300_000);

  it("a page closed during the slow part of a PIN change (the new record's derivation) leaves the old PIN as it was: setPin derives before any write (review of PINONE, PO-07)", async () => {
    const w = await onWorld();
    const before = { pin: JSON.stringify(w.kv.data.get("sk_pin")), rec: JSON.stringify(rec(w)) };
    // the page dies in the record's PBKDF2 (the derivation from the new PIN's key, after the PIN's own one): the master
    // password's derivation before them passes through
    const subtle = crypto.subtle;
    const bits = subtle.deriveBits.bind(subtle);
    const key = subtle.deriveKey.bind(subtle);
    let pinDerived = false;
    const b = vi.spyOn(subtle, "deriveBits").mockImplementation(async (alg, base, length) => {
      if ((alg as { name?: string }).name === "PBKDF2") pinDerived = true;
      return bits(alg, base, length);
    });
    const k = vi.spyOn(subtle, "deriveKey").mockImplementation(async (alg, base, derived, extractable, usages) => {
      if (pinDerived && (alg as { name?: string }).name === "PBKDF2") throw new Dead();
      return key(alg, base, derived, extractable, usages);
    });
    try {
      await expect(w.ctx().admin.setPin(STRONG, PIN2)).rejects.toBeInstanceOf(Dead);
    } finally {
      b.mockRestore();
      k.mockRestore();
    }
    expect(pinDerived).toBe(true); // it did die in the record's derivation
    expect(JSON.stringify(w.kv.data.get("sk_pin"))).toBe(before.pin); // the set-up as it was
    expect(JSON.stringify(rec(w))).toBe(before.rec); // and its record
    expect(await opensAfterRestart(w, PIN)).toBe(true);
    expect(await opensAfterRestart(w, PIN2)).toBe(false);
  });

  it("removing the PIN: the record goes before sk_pin; once it is gone no PIN opens after a restart", async () => {
    const points = await matrix(
      () => onWorld(),
      (page) => page.admin.removePin(STRONG),
      async (w, at) => {
        const where = JSON.stringify(at);
        if (!w.kv.data.has("sk_pin")) expect(rec(w), where).toBeUndefined(); // the record went first
        expect(await opensAfterRestart(w, PIN), where).toBe(rec(w) !== undefined);
      },
    );
    expect(points).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("removing a damaged sk_pin at the master password (PO-04): its record goes first, so wherever the page dies no record outlives its set-up; the next master password finishes it (review of PINONE r2, S-03)", async () => {
    const points = await matrix(
      async () => {
        const w = await onWorld();
        const pin = w.kv.data.get("sk_pin") as Record<string, unknown> & { wrapped: string };
        w.kv.data.set("sk_pin", { ...pin, wrapped: (pin.wrapped[0] === "A" ? "B" : "A") + pin.wrapped.slice(1) });
        w.kv.data.set(KEY, { ...got(w), wrap: null }); // as after the 5th wrong PIN: the note has a record to make
        await w.ctx().service.lock();
        return w;
      },
      async (page) => {
        await page.service.unlockWithPassword(STRONG);
        await notePassword(page.service, pinKit);
      },
      async (w, at) => {
        const where = JSON.stringify(at);
        if (rec(w) !== undefined) expect(w.kv.data.has("sk_pin"), where).toBe(true); // a record never without its set-up
        await passwordAgain(w); // a healthy page's master password, and its note
        expect(rec(w), where).toBeUndefined();
        expect(w.kv.data.has("sk_pin"), where).toBe(false);
      },
    );
    expect(points).toBeGreaterThanOrEqual(4);
  }, 300_000);

  it("a damaged sk_pin read by the note, then a new PIN set in another page before the removal: the new one is not removed (compare-and-delete; review of PINONE r2, S-03)", async () => {
    const w = await onWorld();
    const pin = w.kv.data.get("sk_pin") as Record<string, unknown> & { wrapped: string };
    w.kv.data.set("sk_pin", { ...pin, wrapped: (pin.wrapped[0] === "A" ? "B" : "A") + pin.wrapped.slice(1) });
    w.kv.data.set(KEY, { ...got(w), wrap: null });
    await w.ctx().service.lock();
    let armed = false;
    let fired = false;
    const inner = w.kv;
    const racing: KV = {
      get: async (keys) => {
        const out = await inner.get(keys);
        // the note's session look reads the settings alone: after its read of sk_pin, before its removal
        if (armed && !fired && keys.length === 1 && keys[0] === "sk_settings") {
          fired = true;
          const other = w.ctx();
          await other.service.unlockWithPassword(STRONG);
          await other.admin.setPin(STRONG, PIN2);
        }
        return out;
      },
      set: (x) => inner.set(x),
      remove: (k) => inner.remove(k),
      keys: () => inner.keys(),
    };
    const page = w.ctx({ local: racing });
    await page.service.unlockWithPassword(STRONG);
    armed = true;
    await notePassword(page.service, pinKit);
    expect(fired).toBe(true);
    const set = w.kv.data.get("sk_pin") as { kdf: { salt: string } } | undefined;
    expect(set, "the new PIN's set-up is still there").toBeDefined();
    expect(got(w).setup).toBe(set!.kdf.salt); // and its own record
    expect(await opensAfterRestart(w, PIN2)).toBe(true);
  });

  it("'End quick unlock now': once its wrap is set aside nothing opens after a restart; the master password makes it again", async () => {
    const points = await matrix(
      () => onWorld(),
      (page) => page.admin.endQuickUnlock(),
      async (w, at) => {
        const where = JSON.stringify(at);
        const aside = got(w).wrap === null;
        // its wrap goes before the hard lock: a page that died in between is never locked with the wrap still there
        if ((await w.area.get()) === null) expect(aside, `${where}: hard-locked, its wrap still on disk`).toBe(true);
        expect(await opensAfterRestart(w, PIN), where).toBe(!aside);
        await passwordAgain(w);
        expect(await opensAfterRestart(w, PIN), where).toBe(true);
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("a key change: once the new keyring is stored the record never opens, whether its wrap was set aside yet or not", async () => {
    let oldVk = "";
    const points = await matrix(
      async () => {
        const w = await onWorld();
        oldVk = got(w).vkId;
        return w;
      },
      (page) => page.service.rotateKey(STRONG, NO_PAGE),
      async (w, at) => {
        const where = JSON.stringify(at);
        const changed = (await w.ctx().service.currentGeneration())!.keyring.vkId !== oldVk;
        expect(await opensAfterRestart(w, PIN), where).toBe(!changed);
        if (changed) {
          // the master password brings it back (OWNER-DECISIONS/20, 2026-10-30), with a record of the new keys: a stale
          // wrap that the key change's own step did not set aside is replaced, never used. Once sk_pin has moved to the
          // new key (the cleanup's step), that is; before it, the PIN waits for the next one
          await passwordAgain(w);
          const moved = (w.kv.data.get("sk_pin") as { vkId: string }).vkId !== oldVk;
          expect(await opensAfterRestart(w, PIN), where).toBe(moved);
        }
      },
    );
    expect(points).toBeGreaterThanOrEqual(10);
  }, 600_000);
});
