// The PIN's write orders under a page that dies at any write (QUICK-UNLOCK Stage 1; OWNER-DECISIONS/20 and its 2026-10-30
// notes: the PIN's record, sk_pin_restart, is the one thing it opens; docs/design/notes/QUICK-PIN-NOTES.md "Crash
// matrix", PIN-RESTART-NOTES.md §6). Every write to chrome.storage.local or chrome.storage.session is a point where the
// page can die, before the write lands or just after it; each operation is run once per point and side. Afterwards a
// new page, on the same storage, checks what must hold whatever the point:
//   - setting a PIN: no PIN but the new one ever works, and the new one only once its set-up is stored;
//   - changing it: the old PIN does not work again until the next master password, and then only if its set-up is still
//     the stored one (the change visibly did not happen);
//   - removing it: once sk_pin is gone, no PIN works, now or after the next master password;
//   - a PIN unlock: a try is spent before any key derivation; a recorded wrong PIN always spent one;
//   - the 5th wrong PIN: the PIN never works afterwards, before the master password.
import { describe, expect, it } from "vitest";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import type { QuickSession } from "../../src/core/crypto/pin";
import type { RestartRecord } from "../../src/core/crypto/pin-restart";
import { MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { NO_PAGE, STRONG } from "../helpers/vaults";
import { notePassword, PIN, PIN2, pinIn, quickWorld, type QuickWorld } from "../helpers/quick-world";

const STRONG2 = "granite-river-compass-31";

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

const opens = async (w: QuickWorld, pin: string) => (await pinIn(w.ctx().service, pin)).ok;
/** The master password typed on a lock screen, and its note (the PIN's record made, or made usable, again). */
async function passwordAgain(w: QuickWorld) {
  const s = w.ctx().service;
  await s.lock();
  await s.unlockWithPassword(STRONG);
  await notePassword(s);
  await s.lock();
}
const recOf = (w: QuickWorld) => w.kv.data.get("sk_pin_restart") as RestartRecord | undefined;
const storedSalt = (w: QuickWorld) => (w.kv.data.get("sk_pin") as { kdf: { salt: string } } | undefined)?.kdf.salt;

describe("the write orders themselves (kept on purpose, though the record's set-up alone would already refuse an old one)", () => {
  /** The writes a page makes, in order: "local:sk_pin", "local:-sk_pin_restart" and so on. */
  function recording(w: QuickWorld) {
    const writes: string[] = [];
    const local = Object.assign(Object.create(w.kv) as MemoryKV, {
      set: async (items: Record<string, unknown>) => {
        writes.push(...Object.keys(items).map((k) => `local:${k}`));
        return w.kv.set(items);
      },
      remove: async (keys: string[]) => {
        writes.push(...keys.map((k) => `local:-${k}`));
        return w.kv.remove(keys);
      },
    });
    const session = Object.assign(Object.create(w.area) as MemorySession, {
      setQuick: async (q: QuickSession) => {
        writes.push("quick:set");
        return w.area.setQuick(q);
      },
      clearQuick: async () => {
        writes.push("quick:clear");
        return w.area.clearQuick();
      },
    });
    return { writes, page: w.ctx({ local, session }) };
  }
  const pinWrites = (writes: string[]) => writes.filter((x) => /^(quick:|local:-?sk_pin(_restart)?$)/.test(x));
  it("setting or changing: the old record goes, then sk_pin, then the new record; nothing in session memory", async () => {
    const w = await quickWorld({ pin: PIN });
    const { writes, page } = recording(w);
    await page.admin.setPin(STRONG, PIN2);
    expect(pinWrites(writes)).toEqual(["local:-sk_pin_restart", "local:sk_pin", "local:sk_pin_restart"]);
  });
  it("removing: the record goes, then sk_pin", async () => {
    const w = await quickWorld({ pin: PIN });
    const { writes, page } = recording(w);
    await page.admin.removePin(STRONG);
    expect(pinWrites(writes)).toEqual(["local:-sk_pin_restart", "local:-sk_pin"]);
  });
});

describe("crash matrix: the PIN's write orders", () => {
  it("setting a PIN: only the new PIN ever works, and only once its set-up is stored", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: null });
        return w;
      },
      (page) => page.admin.setPin(STRONG, PIN),
      async (w, at) => {
        const where = JSON.stringify(at);
        const stored = w.kv.data.has("sk_pin");
        await w.ctx().service.lock();
        if (!stored) expect(await opens(w, PIN), where).toBe(false);
        expect(await opens(w, PIN2), where).toBe(false);
        await passwordAgain(w);
        expect(await opens(w, PIN), where).toBe(stored);
      },
    );
    expect(points).toBeGreaterThanOrEqual(6); // sk_pin, the PIN's record, the security record (both sides)
  }, 120_000);

  it("changing the PIN: the old one does not work again before the next master password, and after it only if the change did not land", async () => {
    let oldSalt = "";
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: PIN });
        oldSalt = storedSalt(w)!;
        return w;
      },
      (page) => page.admin.setPin(STRONG, PIN2),
      async (w, at) => {
        const where = JSON.stringify(at);
        await w.ctx().service.lock();
        const landed = storedSalt(w) !== oldSalt;
        // the old record went first: whatever else happened, the old PIN no longer opens Sixkey
        if (at.at > 1 || at.side === "after") expect(await opens(w, PIN), where).toBe(false);
        await passwordAgain(w);
        expect(await opens(w, landed ? PIN2 : PIN), where).toBe(true);
        await w.ctx().service.lock();
        expect(await opens(w, landed ? PIN : PIN2), where).toBe(false);
      },
    );
    expect(points).toBeGreaterThanOrEqual(6);
  }, 180_000);

  it("removing the PIN: once sk_pin is gone, no PIN works, now or after the next master password", async () => {
    const points = await matrix(
      () => quickWorld({ pin: PIN }),
      (page) => page.admin.removePin(STRONG),
      async (w, at) => {
        const where = JSON.stringify(at);
        await w.ctx().service.lock();
        if (!w.kv.data.has("sk_pin")) {
          expect(await opens(w, PIN), where).toBe(false);
          await passwordAgain(w);
          expect(await opens(w, PIN), where).toBe(false);
        } else {
          // the removal did not happen, and the box says so: the PIN is shown as on
          expect((await w.ctx().admin.state()).pin, where).not.toBeNull();
        }
      },
    );
    expect(points).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("a wrong PIN: the try is spent before the derivation; a recorded wrong PIN always spent a try", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: PIN });
        await w.ctx().service.lock();
        return w;
      },
      (page) => pinIn(page.service, "975310"),
      async (w, at) => {
        const where = JSON.stringify(at);
        const spent = recOf(w)!.fails;
        const failed = (await w.kinds()).filter((k) => k === "pin_failed").length;
        expect(failed, where).toBeLessThanOrEqual(spent);
        expect(spent, where).toBeLessThanOrEqual(1);
        expect(await opens(w, PIN), where).toBe(true); // a crash never locks the user out of the PIN
      },
    );
    expect(points).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("the 5th wrong PIN: even if its delete is lost, the PIN never works again before the master password", async () => {
    const points = await matrix(
      async () => {
        const w = await quickWorld({ pin: PIN });
        const s = w.ctx().service;
        await s.lock();
        for (let i = 0; i < 4; i++) await pinIn(s, "975310");
        return w;
      },
      (page) => pinIn(page.service, "975310"),
      async (w, at) => {
        const where = JSON.stringify(at);
        const r = recOf(w)!;
        if (r.fails < 5) {
          // died before the 5th try was spent: that try never reached the derivation
          expect(r.fails, where).toBe(4);
          expect(r.wrap, where).not.toBeNull();
          return;
        }
        expect(r.wrap, where).toBeNull(); // the count and the wrap's removal are one write
        expect(await opens(w, PIN), where).toBe(false);
      },
    );
    expect(points).toBeGreaterThanOrEqual(3);
  }, 180_000);

  // The key changes that keep the vault key (the PIN's record could still unwrap it): a new password, a new recovery code,
  // a reset by the recovery code; and a rotation. Wherever the page dies, once the keyring's wraps have changed the old
  // record never opens Sixkey again (it is tied to the wraps it was made under: "paused"), and before that it is untouched.
  for (const [name, op] of [
    ["a new master password", (page: ReturnType<QuickWorld["ctx"]>) => page.service.changePassword(STRONG, STRONG2)],
    ["a new recovery code", (page: ReturnType<QuickWorld["ctx"]>) => page.service.newRecoveryCode(STRONG, NO_PAGE)],
    [
      "a reset by the recovery code",
      async (page: ReturnType<QuickWorld["ctx"]>, w: QuickWorld) => {
        await page.service.lock();
        await page.service.commitReset(await page.service.prepareReset(w.recoveryCode, STRONG2));
      },
    ],
    ["a rotation", (page: ReturnType<QuickWorld["ctx"]>) => page.service.rotateKey(STRONG, NO_PAGE)],
  ] as const)
    it(`${name}: once the keyring's wraps changed, the old record never opens Sixkey, wherever the page died`, async () => {
      let before = "";
      const wraps = async (w: QuickWorld) => JSON.stringify((await w.ctx().service.currentGeneration())!.keyring.wraps);
      const points = await matrix(
        async () => {
          const w = await quickWorld({ pin: PIN });
          before = await wraps(w);
          return w;
        },
        (page, w) => op(page, w),
        async (w, at) => {
          const where = JSON.stringify(at);
          const changed = (await wraps(w)) !== before;
          await w.ctx().service.lock();
          expect(await opens(w, PIN), where).toBe(!changed);
        },
      );
      expect(points).toBeGreaterThanOrEqual(4);
    }, 240_000);
});
