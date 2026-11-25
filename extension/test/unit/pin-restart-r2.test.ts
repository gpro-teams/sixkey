// The PIN after a restart, review r2 (docs/design/notes/PIN-RESTART-NOTES.md §16; the independent review's REVIEW.md,
// PINR-01 to PINR-13): the reviewer's proposed tests (REVIEW-proposed.test.ts: PINR-02, 03, 06, 08), taken in as they
// were save for the master password the note now takes (PINR-06) and the source rules' new call, and a regression test
// for each finding r2 fixes, most of them the reviewer's probes (REVIEW-probes.test.ts) turned round: what they showed
// happening must not happen any more.
// r3 (the second review's REVIEW-r2.md, PINR-R2-01 to R2-06): its proposed tests (REVIEW-r2-proposed.test.ts: M02, M16,
// M20, M22c/d/e), taken in as they were, and a regression test for R2-01 and R2-04, its probes Q1 and Q3 turned round.
// The sync engine's side of R2-03 is test/unit/pin-restart-sync.test.ts.
// r4 (the r3 review's REVIEW-r3.md, PINR-R3-01 and R3-03): a PIN change carried over a usable record only.
// Since OWNER-DECISIONS/20's two 2026-10-30 notes (PIN-RESTART-NOTES.md §18) every PIN has its record and there is no
// switch: a PIN change carries nothing over (it makes its own record), the master password's note replaces whatever is
// not as it should be (never renews it), there are no 14 days and no session path, and no floor of 6 digits; the tests
// below hold each finding against that design (the probes still turned round: what they showed must not happen).
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The PIN derivation, able to fail once as a page closed during it does (REVIEW-r2-proposed.test.ts: M16's test);
// otherwise the real one.
const ctl = vi.hoisted(() => ({ closeNext: false }));
vi.mock("../../src/core/crypto/pin", async (orig) => {
  const m = (await orig()) as typeof import("../../src/core/crypto/pin");
  return {
    ...m,
    derivePinKek: async (...a: Parameters<typeof m.derivePinKek>) => {
      if (ctl.closeNext) {
        ctl.closeNext = false;
        throw new Error("page closed");
      }
      return m.derivePinKek(...a);
    },
  };
});

import { derivePinKek, wrapsTag, type PinRecord } from "../../src/core/crypto/pin";
import type { RestartRecord } from "../../src/core/crypto/pin-restart";
import { restartIterations, restartMac, restartOk, sealRestart } from "../../src/core/crypto/pin-restart-wrap";
import { PRF_PASSWORD_MS } from "../../src/core/crypto/prf-record";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import type { KV } from "../../src/core/storage/kv";
import { pinKit, type PinKit } from "../../src/core/service/pin-kit";
import { makeRestart } from "../../src/core/service/pin-restart-admin";
import { restartOffer } from "../../src/core/service/pin-restart-count";
import { notePassword as note, unlock as viaRecord } from "../../src/core/service/pin-restart-steps";
import type { VaultService } from "../../src/core/service/service";
import { applyPreset } from "../../src/core/service/presets";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";
import { NO_PAGE, STRONG } from "../helpers/vaults";
import { PIN, PIN2, quickWorld, type QuickWorld } from "../helpers/quick-world";

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
/** A record's wrap, which must be there (not set aside): its absence fails an assertion, not a property read. */
const wrapOf = (r: RestartRecord) => {
  expect(r.wrap, "the record holds its wrap").not.toBeNull();
  return r.wrap!;
};
const restart = (w: QuickWorld) => {
  w.area.quick = null;
  w.area.data = null;
};
/** A world with a PIN and its record (since 2026-10-30 every PIN has one: there is no switch to turn on). */
const onWorld = (o: { pin?: string } = {}) => quickWorld(o);
const aad = (r: RestartRecord) => `sixkey-pin-restart|1|${r.vaultId}|${r.vkId}|${r.id}|${r.setup}|${r.wraps}`;
/** The wrap opened by node:crypto at the count the record states: the vault key's 32 bytes, or null when it does not open. */
async function nodeOpen(w: QuickWorld, r: RestartRecord, pin = PIN): Promise<Buffer | null> {
  if (!r.wrap) return null;
  const set = w.kv.data.get("sk_pin") as PinRecord;
  const pinKek = await derivePinKek(pin, set.kdf);
  const kek = pbkdf2Sync(pinKek, Buffer.from(r.wrap!.kdf.salt, "base64"), r.wrap!.kdf.iterations, 32, "sha256");
  const ct = Buffer.from(r.wrap!.wrapped, "base64");
  const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(r.wrap!.iv, "base64"));
  d.setAAD(Buffer.from(aad(r), "utf8"));
  d.setAuthTag(ct.subarray(32));
  try {
    return Buffer.concat([d.update(ct.subarray(0, 32)), d.final()]);
  } catch {
    return null; // the tag does not check: not the wrap of this PIN at this count
  }
}
const vkOf = async (w: QuickWorld) => {
  const session = await w.area.get();
  expect(session, "a session is open").not.toBeNull();
  return Buffer.from(session!.vk, "base64");
};
/** The unlocked vault's key (the session's), as a Vk. */
const sessionVk = async (w: QuickWorld): Promise<Vk> => vkFromRaw(await vkOf(w));
/** Locked.tsx's routing (as pin-restart-service.test.ts's pinIn): the record's own unlock. */
const pinIn = (svc: VaultService, pin: string, kit: PinKit = pinKit) => viaRecord(svc, pin, kit);
/** A kit that counts the record path's PIN derivations. */
function countingKit() {
  const n = { derivations: 0 };
  const kit: PinKit = { ...pinKit, derivePinKek: async (p, k) => (n.derivations++, pinKit.derivePinKek(p, k)) };
  return { kit, n };
}
/**
 * A stub planted by a writer of the storage who has no vault key (REVIEW P1a, E1): the head copied from sk_pin and the
 * keyring (none of it secret), a MAC under some other key, no wrap.
 */
async function plantStub(w: QuickWorld, o: Partial<RestartRecord> = {}) {
  const set = w.kv.data.get("sk_pin") as PinRecord;
  const k = (await w.first.service.currentGeneration())!.keyring;
  const head = {
    vaultId: k.vaultId,
    vkId: k.vkId,
    id: Buffer.alloc(16, 3).toString("base64"),
    setup: set.kdf.salt,
    wraps: k.wraps.map((x) => x.wrapped).join(","),
  };
  const stub = {
    v: 1,
    ...head,
    mac: await restartMac(new Uint8Array(32).fill(5), head),
    lastPasswordAt: 0,
    fails: 5,
    wrap: null,
    ...o,
  };
  w.kv.data.set(KEY, stub);
  return stub;
}
/** The service's own private step, by element access (as the reviewer's probe P8 calls it). */
const committed = (svc: VaultService) =>
  svc as unknown as {
    committed(kind: string, vk: Vk, o?: object): Promise<void>;
    currentVk(k: unknown): Promise<Vk | null>;
  };
/**
 * A record planted by a writer of the storage who has no vault key, WITH a wrap of its own making: shape-perfect (the
 * head copied from sk_pin and the keyring, none of it secret), a MAC under some other key, a count and an old note
 * (REVIEW-r2-probes.test.ts plantWithWrap: the second review's Q1, E1).
 */
async function plantWithWrap(w: QuickWorld) {
  const set = w.kv.data.get("sk_pin") as PinRecord;
  const k = (await w.first.service.currentGeneration())!.keyring;
  const head = {
    vaultId: k.vaultId,
    vkId: k.vkId,
    id: Buffer.alloc(16, 4).toString("base64"),
    setup: set.kdf.salt,
    wraps: wrapsTag(k),
  };
  const planted: RestartRecord = {
    v: 1,
    ...head,
    mac: await restartMac(new Uint8Array(32).fill(5), head),
    lastPasswordAt: w.t.now - 2 * DAY,
    fails: 3,
    // the count a record of this world gets: the note has no weak wrap to remake, so only the MAC can catch it
    wrap: await sealRestart(
      new Uint8Array(32).fill(7),
      head,
      new Uint8Array(32).fill(9),
      restartIterations(TEST_KDF_ITERATIONS, k),
    ),
  };
  w.kv.data.set(KEY, planted);
  return planted;
}
/**
 * A KV whose `n`-th single-key read of the record after `arm()` first runs `fn` (another page's write landing just then;
 * REVIEW-r2-proposed.test.ts).
 */
function racingOn(w: QuickWorld, n: number, fn: () => void): { kv: KV; arm: () => void } {
  const inner = w.kv;
  let seen = 0;
  let armed = false;
  const kv: KV = {
    get: async (keys) => {
      if (armed && keys.length === 1 && keys[0] === KEY && ++seen === n) fn();
      return inner.get(keys);
    },
    set: (x) => inner.set(x),
    remove: (k) => inner.remove(k),
    keys: () => inner.keys(),
  };
  return { kv, arm: () => void (armed = true) };
}

describe("PINR-01: only a record Sixkey made is ever shown, turned back on, or used; a changed PIN makes its own", () => {
  it("a planted stub (forged MAC) is shown as none and removed; a PIN change then makes a record of its own, never of it", async () => {
    const w = await quickWorld();
    const stub = await plantStub(w); // in place of Sixkey's own
    expect(await w.first.restart.state()).toMatchObject({ on: false, state: "wait" });
    expect(rec(w)).toBeUndefined(); // removed by the box's look
    w.kv.data.set(KEY, stub); // planted again
    expect((await w.first.admin.state()).restart).toEqual({ state: "wait", triesLeft: 5 }); // waits for the password
    expect(rec(w)).toBeUndefined();
    w.kv.data.set(KEY, stub); // and again, right before the user changes the PIN
    await w.first.admin.setPin(STRONG, PIN2);
    expect(got(w).id).not.toBe(stub.id); // removed, and a new record made from the new PIN's own set-up
    expect(got(w).mac).not.toBe(stub.mac);
    restart(w);
    expect((await pinIn(w.ctx().service, PIN2)).ok).toBe(true);
  });

  it("turning back on a planted stub is refused (bad_state) and removes it; so is one whose MAC is under another vault key", async () => {
    const w = await quickWorld();
    await plantStub(w);
    await expect(w.first.restart.turnBackOn({ password: STRONG })).rejects.toMatchObject({ code: "bad_state" });
    expect(rec(w)).toBeUndefined();
    await plantStub(w, { vkId: "0123456789abcdef" }); // as if paused by a rotation, but no retired key of this keyring
    expect(await w.first.restart.state()).toMatchObject({ on: false });
    expect(rec(w)).toBeUndefined();
  });

  it("a record Sixkey made, paused by a rotation, is still its own (its MAC under the retired key): on, and turned back on", async () => {
    const w = await onWorld();
    const before = got(w);
    await w.first.service.rotateKey(STRONG, NO_PAGE);
    expect(got(w)).toMatchObject({ id: before.id, wrap: null }); // paused, kept
    expect(await w.first.restart.state()).toMatchObject({ on: true, state: "paused" });
    expect(got(w).id).toBe(before.id); // not removed by the look
    await w.first.restart.turnBackOn({ password: STRONG });
    expect(got(w).wrap).not.toBeNull();
    restart(w);
    expect((await pinIn(w.ctx().service, PIN)).ok).toBe(true);
  });

  it("a damaged record is never used: with it there, a new PIN of 5 digits is taken, and a whole record made for it", async () => {
    const w = await onWorld();
    w.kv.data.set(KEY, { ...got(w), mac: "x" }); // not whole
    await w.first.admin.setPin(STRONG, "48263");
    expect(got(w).mac).not.toBe("x");
    expect((await w.first.admin.state()).pin).toEqual({ digits: 5 });
    restart(w);
    expect((await pinIn(w.ctx().service, "48263")).ok).toBe(true);
  });
});

describe("PINR-02: the production count, derived for real, on every path that makes a wrap (REVIEW-proposed)", () => {
  it("setting the PIN (no test hook): the wrap opens under node:crypto's PBKDF2 at the stored count, which is >= 2,000,000", async () => {
    const w = await quickWorld();
    const page = w.ctx({ deps: { kdfIterations: undefined } });
    await page.admin.setPin(STRONG, PIN);
    const r = got(w);
    expect(wrapOf(r).kdf.iterations).toBeGreaterThanOrEqual(2_000_000);
    expect(await nodeOpen(w, r)).toEqual(await vkOf(w));
  }, 60_000);

  it("the master password's note remaking it after the 5th wrong PIN (no test hook): >= 2,000,000, derived for real", async () => {
    const w = await quickWorld();
    const page = w.ctx({ deps: { kdfIterations: undefined } });
    await page.admin.endQuickUnlock(); // its wrap set aside: the next master password remakes it
    await page.service.unlockWithPassword(STRONG);
    await note(page.service, pinKit);
    const r = got(w);
    expect(wrapOf(r).kdf.iterations).toBeGreaterThanOrEqual(2_000_000);
    expect(await nodeOpen(w, r)).toEqual(await vkOf(w));
  }, 60_000);

  it("never fewer than the keyring's own password wrap: a 3,000,000 password wrap gives the record 3,000,000", async () => {
    const w = await quickWorld();
    await w.ctx({ deps: { kdfIterations: 3_000_000 } }).service.changePassword(STRONG, STRONG2); // paused
    const page = w.ctx(); // the tests' hook (600k) again: only the keyring says 3M
    await page.restart.turnBackOn({ password: STRONG2 });
    expect(wrapOf(got(w)).kdf.iterations).toBe(3_000_000);
  }, 60_000);

  it("the record's own unlock refuses a wrap weaker than a new one would get here (nothing counted); the note then makes it anew at that count", async () => {
    const w = await onWorld(); // the tests' hook: 600k
    restart(w);
    const strict = w.ctx({ deps: { kdfIterations: 1_000_000 } }); // a page whose new wraps get 1M
    expect(await viaRecord(strict.service, PIN, pinKit)).toEqual({ ok: false, reason: "ended" });
    expect(got(w).fails).toBe(0);
    await strict.service.unlockWithPassword(STRONG);
    await note(strict.service, pinKit);
    expect(wrapOf(got(w)).kdf.iterations).toBe(1_000_000);
    await strict.service.lock();
    restart(w);
    expect((await viaRecord(strict.service, PIN, pinKit)).ok).toBe(true);
  }, 60_000);

  it("restartIterations takes no keyring count above kdf.ts's maximum (20M)", () => {
    const wraps = [{ method: "password", kdf: { iterations: 100_000_000 } }];
    expect(restartIterations(undefined, { wraps })).toBe(2_000_000);
    expect(restartIterations(undefined, { wraps: [{ method: "password", kdf: { iterations: 20_000_000 } }] })).toBe(
      20_000_000,
    );
  });
});

describe("PINR-03: the record's own unlock re-checks what it offers (REVIEW-proposed)", () => {
  it("asked directly long after its making (no 14 days since 2026-10-30): it opens", async () => {
    const w = await quickWorld();
    restart(w);
    w.t.now = got(w).lastPasswordAt + PRF_PASSWORD_MS + 30 * DAY;
    expect((await viaRecord(w.ctx().service, PIN, pinKit)).ok).toBe(true);
    expect(got(w).fails).toBe(0);
  });

  it("asked directly for a paused record that still holds its wrap (a page died before the key event's step): 'ended'", async () => {
    const w = await quickWorld();
    const before = got(w);
    await w.ctx().service.changePassword(STRONG, STRONG2); // the same vault key; the keyring's wraps change
    w.kv.data.set(KEY, { ...got(w), wrap: before.wrap }); // as if setAsideRestart had not run
    restart(w);
    expect(await viaRecord(w.ctx().service, PIN, pinKit)).toEqual({ ok: false, reason: "ended" });
    expect(await w.area.get()).toBeNull();
  });
});

describe("PINR-06: a remade wrap follows the master password only, in the service itself", () => {
  it("the note writes nothing without the master password typed in this very service: a recovery code, a wrong or no password, another page's, a lock since change nothing (review of PINONE, PO-02: its mark, no second derivation)", async () => {
    const w = await onWorld();
    await w.first.admin.endQuickUnlock(); // its wrap set aside: a note would make it again
    w.t.now += 2 * DAY;
    const svc = w.ctx().service;
    const before = JSON.stringify(got(w));
    const unchanged = (why: string) => expect(JSON.stringify(got(w)), why).toBe(before);
    await svc.unlockWithRecoveryCode(w.recoveryCode);
    await note(svc, pinKit);
    unchanged("a recovery code");
    await svc.lock();
    await expect(svc.unlockWithPassword("not-the-master-password")).rejects.toMatchObject({ code: "wrong_secret" });
    await note(svc, pinKit);
    unchanged("a wrong password");
    await note(svc, pinKit);
    unchanged("no password at all");
    const other = w.ctx().service;
    await other.unlockWithPassword(STRONG); // another page's unlock: this service has no mark of its own
    await note(svc, pinKit);
    unchanged("another page's password");
    await svc.unlockWithPassword(STRONG);
    await svc.lock(); // a lock since the unlock voids its mark
    await note(svc, pinKit);
    unchanged("a lock since");
    await svc.unlockWithPassword(STRONG);
    await w.ctx().service.lock(); // so does a lock in another page (the lock epoch)
    await note(svc, pinKit);
    unchanged("a lock elsewhere since");
    await svc.unlockWithPassword(STRONG);
    await w.ctx().service.lock(); // a lock elsewhere, then the recovery code there: its session is the one in place
    await w.ctx().service.unlockWithRecoveryCode(w.recoveryCode);
    await note(svc, pinKit); // this page's mark is from before that lock: void
    unchanged("a lock and the recovery code elsewhere since");
    await svc.lock();
    await svc.unlockWithPassword(STRONG);
    {
      // another page rotates the key after this page's unlock (a rotation moves no lock epoch): this page's mark is of
      // the old key, so its note writes nothing (review of PINONE r2, S-06)
      const rotating = w.ctx().service;
      await rotating.unlockWithPassword(STRONG);
      await rotating.rotateKey(STRONG, NO_PAGE);
      const after = JSON.stringify(got(w));
      await note(svc, pinKit);
      expect(JSON.stringify(got(w)), "another page's rotation since").toBe(after);
    }
    await svc.unlockWithPassword(STRONG);
    await note(svc, pinKit);
    expect(got(w).wrap).not.toBeNull();
    expect(got(w).lastPasswordAt).toBe(w.t.now);
    // one shot: the note took the mark
    expect((svc as unknown as { typed: unknown }).typed).toBeNull();
  });

  const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
  it("Locked.tsx: the note inside the password branch, guarded by the record's state, waited for (capped) before the list; never after the recovery key", () => {
    const s = src("popup/screens/Locked.tsx");
    const at = s.indexOf('if (asked === "password") {');
    const end = s.indexOf("} else done = await rt.service.unlockWithRecoveryCode(secret);", at);
    expect(at).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(at);
    const calls = [...s.matchAll(/m\.notePassword\(rt\.service, pinKit\)/g)].map((m) => m.index!); // the PIN's note (the device unlock has its own)
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(at);
    expect(calls[0]).toBeLessThan(end);
    expect(s.slice(at, calls[0])).toMatch(/if \(offer\) await capped\(pinSteps\(\)\.then\(\(m\) => $/);
  });
  it("UnlockBar.tsx: the note after unlockWithPassword, guarded by the record's state, waited for (capped) before the page reloads", () => {
    const s = src("options/UnlockBar.tsx");
    const pw = s.indexOf("await ctx.rt.service.unlockWithPassword(value);");
    const call = s.indexOf("m.notePassword(ctx.rt.service, pinKit)");
    const reload = s.indexOf("await ctx.reload();", pw);
    expect([...s.matchAll(/m\.notePassword\(ctx\.rt\.service, pinKit\b/g)]).toHaveLength(1);
    expect(pw).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(pw);
    expect(reload).toBeGreaterThan(call);
    expect(s.slice(pw, call)).toMatch(/if \(waiting \|\| pinTries > 0\) await capped\(pinSteps\(\)\.then\(\(m\) => $/);
  });
});

describe("PINR-07: the 5th try on the record path takes the wrap off the disk with its count", () => {
  it("a page closed during the 5th's derivation leaves its count and no key material (REVIEW P5, turned round)", async () => {
    const w = await onWorld();
    restart(w);
    for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
    const closed: PinKit = {
      ...pinKit,
      derivePinKek: async () => {
        throw new Error("page closed");
      },
    };
    await expect(viaRecord(w.ctx().service, WRONG, closed)).rejects.toThrow("page closed");
    expect(got(w)).toMatchObject({ fails: 5, wrap: null });
    const svc = w.ctx().service;
    await svc.openView();
    expect(restartOffer(svc, pinKit)).toMatchObject({ state: "wait" });
  });

  it("the right PIN on the 5th still opens, and its wrap comes back: 5 wrong in a row is the limit (OWNER-DECISIONS/20, 2026-10-30)", async () => {
    // (until 2026-10-30 the wrap stayed aside until the master password; the session PIN, tried first then, kept working)
    const w = await onWorld();
    restart(w);
    for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
    const before = got(w);
    expect((await viaRecord(w.ctx().service, PIN, pinKit)).ok).toBe(true);
    expect(got(w)).toEqual({ ...before, fails: 0 }); // the same record, the same wrap, its count back to none
    restart(w);
    expect((await viaRecord(w.ctx().service, PIN, pinKit)).ok).toBe(true);
  });
});

describe("PINR-08: counts under concurrency and compare-and-set (REVIEW-proposed, and R04, R05, R07, R08; the session path's went with it on 2026-10-30)", () => {
  it("two pages at once with one try left: one derivation in all, the wrap gone, no 6th", async () => {
    const w = await quickWorld();
    restart(w);
    w.kv.data.set(KEY, { ...got(w), fails: 4 });
    const n = { derivations: 0 };
    const kit: PinKit = { ...pinKit, derivePinKek: async (p, k) => (n.derivations++, pinKit.derivePinKek(p, k)) };
    await Promise.all([viaRecord(w.ctx().service, WRONG, kit), viaRecord(w.ctx().service, WRONG, kit)]);
    expect(n.derivations).toBe(1);
    expect(rec(w)).toMatchObject({ fails: 5, wrap: null });
  });

  it("the record path never counts on a record made again between its look and its count (its id compared in the lock)", async () => {
    const w = await onWorld();
    restart(w);
    let remade: RestartRecord | null = null;
    const inner = w.kv;
    const racing: KV = {
      get: async (keys) => {
        // the count's own read in the vault lock (the record alone): another page has made it again, 4 tries counted
        if (!remade && keys.length === 1 && keys[0] === KEY) {
          remade = { ...got(w), id: Buffer.alloc(16, 7).toString("base64"), fails: 4 };
          w.kv.data.set(KEY, remade);
        }
        return inner.get(keys);
      },
      set: (x) => inner.set(x),
      remove: (k) => inner.remove(k),
      keys: () => inner.keys(),
    };
    const { kit, n } = countingKit();
    expect(await viaRecord(w.ctx({ local: racing }).service, WRONG, kit)).toEqual({ ok: false, reason: "ended" });
    expect(n.derivations).toBe(0);
    expect(got(w)).toEqual(remade);
  });
});

describe("PINR-08 (R06): the count's own guard in the lock", () => {
  it("a record whose 5 tries were counted (its wrap still there: a writer of the storage, or an older Sixkey) between the look and the count: 'exhausted', no 6th derivation", async () => {
    const w = await onWorld();
    restart(w);
    let spent = false;
    const inner = w.kv;
    const racing: KV = {
      get: async (keys) => {
        if (!spent && keys.length === 1 && keys[0] === KEY) {
          spent = true;
          w.kv.data.set(KEY, { ...got(w), fails: 5 }); // the same record, 5 counted, its wrap not set aside
        }
        return inner.get(keys);
      },
      set: (x) => inner.set(x),
      remove: (k) => inner.remove(k),
      keys: () => inner.keys(),
    };
    const { kit, n } = countingKit();
    expect(await viaRecord(w.ctx({ local: racing }).service, WRONG, kit)).toEqual({ ok: false, reason: "exhausted" });
    expect(n.derivations).toBe(0);
    expect(got(w).fails).toBe(5);
  });
});

describe("PINR-09: only a key event typed on this page opens the PIN-only window", () => {
  // (A key adopted in a background round, which typed nothing here, opened none either: the server sync's, gone with its
  // client, DV-0b. Every commit there is now is this page's own key event.)
  it("another page's key event does not open this page's window; this page's own change does", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await w.ctx().service.changePassword(STRONG, STRONG2); // another page's change
    expect((await page.restart.state())?.byPin).toBe(false);
    await expect(page.restart.turnBackOn({ pin: PIN })).rejects.toMatchObject({ code: "wrong_secret" });
    await page.service.changePassword(STRONG2, STRONG); // this page's own: typed here
    expect((await page.restart.state())?.byPin).toBe(true);
  });

  it("the window is this page's key event's keys: another page's later re-wrap closes it (the wraps compared)", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await page.service.changePassword(STRONG, STRONG2);
    expect((await page.restart.state())?.byPin).toBe(true);
    await w.ctx().service.changePassword(STRONG2, "another-strong-password-77"); // the same key, other wraps
    expect((await page.restart.state())?.byPin).toBe(false);
  });

  it("every key event's own step pauses a record of other wraps, also one another page's step left unpaused", async () => {
    const w = await onWorld();
    const before = got(w);
    const page = w.ctx();
    await w.ctx().service.changePassword(STRONG, STRONG2); // paused by that page's own step
    w.kv.data.set(KEY, { ...got(w), wrap: before.wrap }); // as if its step had not landed
    const k = (await page.service.currentGeneration())!.keyring;
    const vk = (await committed(page.service).currentVk(k))!;
    await committed(page.service).committed("password_changed", vk, { session: false });
    expect(got(w).wrap).toBeNull();
  });
});

describe("PINR-10: the PIN alone, turning it back on, is counted on the record's 5 tries", () => {
  it("5 wrong PINs, then even the right one is refused (the master password then); each counted first, each recorded", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await page.service.rotateKey(STRONG, NO_PAGE);
    for (let i = 0; i < 5; i++)
      await expect(page.restart.turnBackOn({ pin: String(100000 + i) })).rejects.toMatchObject({
        code: "wrong_secret",
      });
    expect(got(w)).toMatchObject({ fails: 5, wrap: null });
    expect((await page.restart.state())?.byPin).toBe(false);
    await expect(page.restart.turnBackOn({ pin: PIN })).rejects.toMatchObject({ code: "wrong_secret" });
    expect(got(w).wrap).toBeNull();
    expect((await w.kinds()).filter((k) => k === "pin_failed")).toHaveLength(5);
    await page.restart.turnBackOn({ password: STRONG });
    expect(got(w)).toMatchObject({ fails: 0 });
    expect(got(w).wrap).not.toBeNull();
  });

  it("a typo is no try; a wrong PIN is one", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await page.service.rotateKey(STRONG, NO_PAGE);
    await expect(page.restart.turnBackOn({ pin: "12a456" })).rejects.toMatchObject({ code: "bad_pin" });
    expect(got(w).fails).toBe(0);
    await expect(page.restart.turnBackOn({ pin: WRONG })).rejects.toMatchObject({ code: "wrong_secret" });
    expect(got(w).fails).toBe(1);
  });

  it("a page closed during the derivation has spent its try: counted before it (REVIEW-r2-proposed, kills M16)", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await page.service.rotateKey(STRONG, NO_PAGE);
    ctl.closeNext = true;
    await expect(page.restart.turnBackOn({ pin: WRONG })).rejects.toThrow("page closed");
    expect(got(w).fails).toBe(1);
  });
});

describe("PINR-11, PINR-12: the master password's note", () => {
  it("a record whole in its head but not in its body is replaced by the note with a whole one (never used as it is)", async () => {
    for (const body of [{ wrap: {} }, { fails: "1" }, { mac: 5 }, { lastPasswordAt: "1" }] as object[]) {
      const w = await onWorld();
      const broken = { ...got(w), ...body };
      w.kv.data.set(KEY, broken);
      const svc = w.ctx().service;
      await svc.lock();
      await svc.unlockWithPassword(STRONG);
      await note(svc, pinKit);
      expect(restartOk(got(w)), JSON.stringify(body)).toBe(true);
      expect(got(w).id, JSON.stringify(body)).not.toBe(broken.id);
      restart(w);
      expect((await pinIn(w.ctx().service, PIN)).ok, JSON.stringify(body)).toBe(true);
    }
  });

  it("tries counted in another page while the note runs are never erased by its write (its count compared: REVIEW P9, turned round)", async () => {
    const w = await onWorld();
    restart(w);
    await pinIn(w.ctx().service, WRONG); // one wrong try: the note has something to write
    const attacker = w.ctx().service;
    let armed = false;
    let fired = false;
    const inner = w.kv;
    const racing: KV = {
      get: async (keys) => {
        const out = await inner.get(keys);
        // the note's session look reads the settings (alone): after its read of the record, before its write (outside
        // the vault lock)
        if (armed && !fired && keys.length === 1 && keys[0] === "sk_settings") {
          fired = true;
          for (let i = 0; i < 3; i++) await viaRecord(attacker, WRONG, pinKit);
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
    await note(page.service, pinKit);
    expect(fired).toBe(true);
    expect(got(w).fails).toBe(4); // 1 + 3: none taken back
  });

  it("the master password takes a count of wrong tries back to none (the record made again)", async () => {
    const w = await onWorld();
    restart(w);
    for (let i = 0; i < 3; i++) await pinIn(w.ctx().service, WRONG);
    const svc = w.ctx().service;
    await svc.unlockWithPassword(STRONG);
    await note(svc, pinKit);
    expect(got(w).fails).toBe(0);
  });

  it("a paused record whose old wrap a page that died left there is replaced by the note: no old key material stays", async () => {
    const w = await onWorld();
    const before = got(w);
    await w.ctx().service.changePassword(STRONG, STRONG2);
    w.kv.data.set(KEY, { ...got(w), wrap: before.wrap }); // as if the pause had not landed
    const svc = w.ctx().service;
    await svc.lock();
    await svc.unlockWithPassword(STRONG2);
    await note(svc, pinKit);
    const k = (await svc.currentGeneration())!.keyring;
    expect(got(w).id).not.toBe(before.id);
    expect(got(w).wraps).toBe(wrapsTag(k));
    expect(JSON.stringify(got(w).wrap)).not.toBe(JSON.stringify(before.wrap));
  });

  it("the note leaves a profile declared shared alone (a record planted there is not made anew)", async () => {
    const w = await onWorld();
    await w.first.admin.endQuickUnlock();
    const aside = got(w); // Sixkey's own, its wrap set aside
    await w.first.service.updateSettings(applyPreset(await w.settings.get(), "shared"));
    expect(rec(w)).toBeUndefined();
    w.kv.data.set(KEY, aside);
    const svc = w.ctx().service;
    await svc.unlockWithPassword(STRONG);
    await note(svc, pinKit);
    expect(got(w).wrap).toBeNull();
  });

  it("the note makes the wrap again for a PIN of 4 digits too (OWNER-DECISIONS/20, 2026-10-30: no floor of its own)", async () => {
    const w = await quickWorld({ pin: "4826" });
    const before = got(w);
    await w.first.admin.endQuickUnlock(); // its wrap set aside
    expect(got(w).wrap).toBeNull();
    const svc = w.ctx().service;
    await svc.unlockWithPassword(STRONG);
    await note(svc, pinKit);
    const after = got(w);
    expect(after.wrap).not.toBeNull();
    expect(after.id).not.toBe(before.id);
    restart(w);
    expect((await pinIn(w.ctx().service, "4826")).ok).toBe(true);
  });
});

describe("PINR-13: the rest of the reviewer's survivors (R18, R20 is the crash matrix's, R26, R27)", () => {
  it("a key event removes another vault's record (not only its wrap)", async () => {
    const w = await onWorld();
    w.kv.data.set(KEY, { ...got(w), vaultId: "anotherVaultId123456" });
    await w.first.service.changePassword(STRONG, STRONG2);
    expect(rec(w)).toBeUndefined();
  });

  it("makeRestart writes nothing for a keyring whose wraps changed meanwhile", async () => {
    const w = await onWorld();
    const k0 = (await w.first.service.currentGeneration())!.keyring;
    const set = w.kv.data.get("sk_pin") as PinRecord;
    const vk = await sessionVk(w);
    await w.ctx().service.changePassword(STRONG, STRONG2); // the same key; the wraps change
    const before = JSON.stringify(rec(w));
    expect(await makeRestart(w.first.service, vk, k0, set, await derivePinKek(PIN, set.kdf), w.t.now)).toBe(false);
    expect(JSON.stringify(rec(w))).toBe(before);
  });

  it("a Phase 0 device-key vault: not_protected (turning it back on refused)", async () => {
    const { legacyDeviceVault } = await import("../helpers/vaults");
    const { MemoryKV, createMutex } = await import("../../src/core/storage/kv");
    const { VaultStore } = await import("../../src/core/storage/store");
    const { PinStore } = await import("../../src/core/service/pin-store");
    const { RestartAdmin } = await import("../../src/core/service/pin-restart-admin");
    const { VaultService } = await import("../../src/core/service/service");
    const { KvSettingsStore, MemorySession } = await import("../../src/core/service/types");
    const kv = new MemoryKV();
    const lock = createMutex();
    const store = new VaultStore({ kv, lock });
    await legacyDeviceVault(store);
    const pins = new PinStore(kv, lock);
    const svc = new VaultService({ store, session: new MemorySession(), settings: new KvSettingsStore(kv), pins });
    await expect(new RestartAdmin(svc).turnBackOn({ password: STRONG })).rejects.toMatchObject({
      code: "not_protected",
    });
    expect(kv.data.get(KEY)).toBeUndefined();
  });
});

describe("PINR-R2-01: the master password's note never renews a record that is not Sixkey's own: it replaces it", () => {
  it("a planted record WITH a wrap, shaped as one that offers the PIN (no try counted): the note checks its MAC even then, and replaces it (Q1 turned round)", async () => {
    for (const fails of [0, 3]) {
      const w = await quickWorld();
      const planted = await plantWithWrap(w);
      w.kv.data.set(KEY, { ...planted, fails });
      const svc = w.ctx().service;
      await svc.lock();
      await svc.unlockWithPassword(STRONG);
      await note(svc, pinKit);
      expect(got(w).id, `${fails}`).not.toBe(planted.id);
      expect(got(w).mac, `${fails}`).not.toBe(planted.mac);
      restart(w);
      expect((await pinIn(w.ctx().service, PIN)).ok, `${fails}`).toBe(true);
    }
  });

  it("a record Sixkey made with tries counted is made again by the note (its count back to none)", async () => {
    const w = await onWorld();
    w.kv.data.set(KEY, { ...got(w), fails: 2, lastPasswordAt: w.t.now - 2 * DAY });
    const svc = w.ctx().service;
    await svc.lock();
    await svc.unlockWithPassword(STRONG);
    await note(svc, pinKit);
    expect(got(w)).toMatchObject({ fails: 0, lastPasswordAt: w.t.now });
  });

  it("the replacement is compare-and-set: a record Sixkey made, written by another page between the look and the write, stays", async () => {
    const w = await onWorld();
    const genuine = got(w);
    await plantWithWrap(w);
    // the note's look comes with the pointer's read; its 1st single-key read of the record is the write's, in the vault lock
    const race = racingOn(w, 1, () => w.kv.data.set(KEY, genuine));
    const page = w.ctx({ local: race.kv });
    await page.service.lock();
    await page.service.unlockWithPassword(STRONG);
    race.arm();
    await note(page.service, pinKit);
    expect(rec(w)).toEqual(genuine);
  });
});

describe("PINR-R2-04, PINR-R3-01 (since 2026-10-30): a PIN change carries nothing over; it makes its own record", () => {
  it("whatever was stored (paused by a rotation or a re-wrap and written back, waiting, of no set-up): removed, and a new one made with the new PIN", async () => {
    const cases: [string, (w: QuickWorld) => Promise<string>][] = [
      [
        "paused by a rotation, written back",
        async (w) => {
          await w.ctx().service.rotateKey(STRONG, NO_PAGE);
          const old = got(w);
          w.kv.data.delete(KEY);
          w.kv.data.set(KEY, old);
          return STRONG;
        },
      ],
      [
        "paused by a new master password",
        async (w) => (await w.ctx().service.changePassword(STRONG, STRONG2), STRONG2),
      ],
      ["waiting ('End quick unlock now')", async (w) => (await w.ctx().admin.endQuickUnlock(), STRONG)],
      [
        "of no set-up, written back",
        async (w) => {
          const old = got(w);
          await w.first.admin.removePin(STRONG);
          w.kv.data.set(KEY, old);
          return STRONG;
        },
      ],
    ];
    for (const [what, before] of cases) {
      const w = await onWorld();
      const password = await before(w);
      const was = rec(w);
      const page = w.ctx();
      await page.service.unlockWithPassword(password).catch(() => undefined); // unlocked again where a lock came
      await page.admin.setPin(password, PIN2);
      const set = w.kv.data.get("sk_pin") as PinRecord;
      expect(got(w).id, what).not.toBe(was?.id);
      expect(got(w)).toMatchObject({ setup: set.kdf.salt, fails: 0 });
      expect(wrapOf(got(w))).toBeTruthy();
      restart(w);
      expect(await pinIn(w.ctx().service, PIN), what).toMatchObject({ ok: false, reason: "wrong" });
      expect((await pinIn(w.ctx().service, PIN2)).ok, what).toBe(true);
    }
  });

  it("a paused record asks nothing of the new PIN: one of 5 digits is taken (the r3 review's Z14)", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await page.service.changePassword(STRONG, STRONG2);
    await expect(page.admin.setPin(STRONG2, "48263")).resolves.toBeUndefined();
    expect((w.kv.data.get("sk_pin") as PinRecord).digits).toBe(5);
    restart(w);
    expect((await pinIn(w.ctx().service, "48263")).ok).toBe(true);
  });
});

describe("PINR-R2-05: the second review's survivors (REVIEW-r2-proposed.test.ts)", () => {
  it("genuineRestart's removal is compare-and-set: a record Sixkey made, written by another page between the look and the removal, stays (kills M02)", async () => {
    const w = await onWorld();
    const genuine = got(w);
    const head = {
      vaultId: genuine.vaultId,
      vkId: genuine.vkId,
      id: Buffer.alloc(16, 3).toString("base64"),
      setup: genuine.setup,
      wraps: genuine.wraps,
    };
    w.kv.data.set(KEY, { ...genuine, ...head, mac: await restartMac(new Uint8Array(32).fill(5), head) }); // planted
    // RestartAdmin.state(): its 1st read of the record is genuineRestart's look, its 2nd the removal's, in the vault lock
    const race = racingOn(w, 2, () => w.kv.data.set(KEY, genuine));
    const page = w.ctx({ local: race.kv });
    race.arm();
    expect(await page.restart.state()).toMatchObject({ on: false });
    expect(rec(w)).toEqual(genuine);
  });

  it("the note's replacement of a broken record is compare-and-set: a record made again by another page meanwhile stays (kills M20)", async () => {
    const w = await onWorld();
    const genuine = got(w);
    w.kv.data.set(KEY, { ...genuine, fails: "1" }); // broken in its body
    // the note's look comes with the pointer's read; its 1st single-key read of the record is the write's, in the lock
    const race = racingOn(w, 1, () => w.kv.data.set(KEY, genuine));
    const page = w.ctx({ local: race.kv });
    await page.service.lock();
    await page.service.unlockWithPassword(STRONG);
    race.arm();
    await note(page.service, pinKit);
    expect(rec(w)).toEqual(genuine);
  });

  it("PINR-09: a master password reset (the recovery key and a new password typed here) opens the PIN-only window (kills M22c)", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await page.service.commitReset(await page.service.prepareReset(w.recoveryCode, STRONG2));
    expect(await page.restart.state()).toMatchObject({ state: "paused", byPin: true });
  });

  it("PINR-09: a new recovery key (the master password typed here) opens it (kills M22d)", async () => {
    const w = await onWorld();
    const page = w.ctx();
    await page.service.newRecoveryCode(STRONG, NO_PAGE);
    expect(await page.restart.state()).toMatchObject({ state: "paused", byPin: true });
  });
});
