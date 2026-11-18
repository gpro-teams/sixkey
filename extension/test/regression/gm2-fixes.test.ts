// Regression tests for PHASE0X-PLAN A4, the G-M2 gate fixes (docs/audit/internal-reviews/GM2-REVIEW.md). Each REPRO of that review, turned
// round to assert the fixed behaviour, plus the review's SOUND probes that pinned rules no package test did (GM2-12:
// mutants X4, B3, C4, K6). The crash matrix is test/fault/gm2-crash-matrix.test.ts.
import { describe, expect, it } from "vitest";
import { fromB64, utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import {
  changePassword as changePasswordWrap,
  createKeyring,
  setRecovery,
  unlockWithPassword,
  unlockWithRecoveryCode,
  type Keyring,
} from "../../src/core/crypto/keyring";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { checkGeneration, checkKeyringCopy, KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type ServiceDeps, type VkRecord } from "../../src/core/service/service";
import { SecurityLog } from "../../src/core/service/security-log";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { RoutedSession } from "../../src/platform/session";
import { aliveEntries } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { canonicalJson } from "../../src/core/vault/merge";
import { deserializeVault } from "../../src/core/vault/validate";
import { codeOf, createProtected, legacyDeviceVault, NO_PAGE, resetWithCode, STRONG } from "../helpers/vaults";

const STRONG2 = "granite-river-compass-31";
const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

function world() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const diag: string[] = [];
  const store = (k: KV = kv, m: KV = mirror) =>
    new VaultStore({ kv: k, mirror: m, lock: createMutex(), now: () => t.now, onDiag: (s) => diag.push(s) });
  const svc = (k: KV = kv, m: KV = mirror, s: SessionCache = session, extra: Partial<ServiceDeps> = {}) =>
    new VaultService({
      store: store(k, m),
      session: s,
      settings,
      now: () => t.now,
      onDiag: (x) => diag.push(x),
      ...extra,
    });
  const add = async (s: VaultService, n: string) => {
    t.now += 60_000;
    await s.mutate((v, c) => addEntry(v, input(n), c).vault);
  };
  return { kv, mirror, session, t, settings, store, svc, add, diag };
}
type W = ReturnType<typeof world>;

const wrap = (inner: KV, o: Partial<KV>): KV => ({
  get: (k) => inner.get(k),
  keys: () => inner.keys(),
  set: (i) => inner.set(i),
  remove: (k) => inner.remove(k),
  ...o,
});
const ptrOf = (w: W) => w.kv.data.get(KEYS.active) as "a" | "b";
const otherOf = (s: "a" | "b") => (s === "a" ? "b" : "a");
const active = async (w: W) => (await checkGeneration(w.kv.data.get(KEYS.slot[ptrOf(w)])))!;
const otherSlot = async (w: W) => checkGeneration(w.kv.data.get(KEYS.slot[otherOf(ptrOf(w))]));
const losePointerWrite = (w: W) => w.kv.data.set(KEYS.active, otherOf(ptrOf(w)));
const namesOf = async (w: W, s?: VaultService) =>
  aliveEntries((await (s ?? w.svc()).read()).vault).map((e) => e.issuer);
const opensWithCode = (k: Keyring, code: string) =>
  unlockWithRecoveryCode(k, code).then(
    () => true,
    () => false,
  );
const opensWithPw = (k: Keyring, pw: string) =>
  unlockWithPassword(k, pw).then(
    () => true,
    () => false,
  );
const sessionVk = (w: W) => vkFromRaw(fromB64(w.session.data!.vk));
const snapRecords = (m: MemoryKV) => [...m.data].filter(([k]) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex);

class Dead extends Error {}
const dying = (at: (items: Record<string, unknown>) => boolean) => {
  let dead = false;
  return (inner: KV): KV => ({
    get: async (k) => {
      if (dead) throw new Dead();
      return inner.get(k);
    },
    keys: async () => {
      if (dead) throw new Dead();
      return inner.keys();
    },
    set: async (i) => {
      if (dead) throw new Dead();
      if (at(i)) {
        dead = true;
        throw new Dead();
      }
      return inner.set(i);
    },
    remove: async (k) => {
      if (dead) throw new Dead();
      return inner.remove(k);
    },
  });
};
const atCommit = (i: Record<string, unknown>) => KEYS.active in i;
/** The pointer write lands and still reports an error (once). */
const landsThenThrows = (inner: MemoryKV) => {
  let done = false;
  return wrap(inner, {
    set: async (i) => {
      await inner.set(i);
      if (!done && KEYS.active in i) {
        done = true;
        throw new Error("IO error after the write");
      }
    },
  });
};

/** Pointer slot, keyring copy and mirror generation all carry the same keyring. */
async function tripleConsistent(w: W): Promise<string[]> {
  const g = await active(w);
  const out: string[] = [];
  const c = checkKeyringCopy(w.kv.data.get(KEYS.keyringCopy));
  if (!c || canonicalJson(c.keyring) !== canonicalJson(g.keyring))
    out.push("keyring copy differs from the pointer slot");
  const m = await checkGeneration(w.mirror.data.get(KEYS.mirrorGen));
  if (!m || canonicalJson(m.keyring) !== canonicalJson(g.keyring))
    out.push("mirror generation differs from the pointer slot");
  return out;
}

/** Every keyring on disk (slots, keyring copy, mirror generation) that `opens` accepts. */
async function keyringsOpenedBy(w: W, opens: (k: Keyring) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (const [name, m] of [
    ["local", w.kv],
    ["mirror", w.mirror],
  ] as const) {
    for (const [k, v] of m.data) {
      const keyring =
        k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen
          ? (await checkGeneration(v))?.keyring
          : k === KEYS.keyringCopy
            ? checkKeyringCopy(v)?.keyring
            : undefined;
      if (keyring && (await opens(keyring))) out.push(`${name}:${k}`);
    }
  }
  return out;
}

/** Writes in the order they were made, across this store, the mirror and the session. */
function traced(w: W) {
  const log: string[] = [];
  const kv = wrap(w.kv, {
    set: async (i) => {
      log.push(...Object.keys(i).map((k) => `local:${k}`));
      return w.kv.set(i);
    },
    remove: async (k) => {
      log.push(...k.map((x) => `local:-${x}`));
      return w.kv.remove(k);
    },
  });
  const mirror = wrap(w.mirror, {
    set: async (i) => {
      log.push(...Object.keys(i).map((k) => `mirror:${k}`));
      return w.mirror.set(i);
    },
    remove: async (k) => {
      log.push(...k.map((x) => `mirror:-${x}`));
      return w.mirror.remove(k);
    },
  });
  const session: SessionCache = {
    get: () => w.session.get(),
    set: async (d) => {
      log.push("session");
      return w.session.set(d);
    },
    clear: async () => {
      log.push("session:clear");
      return w.session.clear();
    },
    lockEpoch: () => w.session.lockEpoch(),
    getQuick: () => w.session.getQuick(),
    setQuick: (q) => w.session.setQuick(q),
    clearQuick: () => w.session.clearQuick(),
    bumpLockEpoch: () => w.session.bumpLockEpoch(),
  };
  return { log, kv, mirror, session };
}

// ---- GM2-1 ----------------------------------------------------------------------------------------------------------------

class FailingSet extends MemorySession {
  fail = false;
  override async set(d: SessionData) {
    if (this.fail) {
      this.fail = false;
      throw new Error("session write failed");
    }
    return super.set(d);
  }
}

describe("GM2-1(a): a key change that committed is never reported as failed when the session write after it fails", () => {
  it("rotateKey, enableMasterPassword and the reset succeed and hand over their code, and it is the live one", async () => {
    const cases: [string, (w: W, s: VaultService, r1: string | null) => Promise<string>][] = [
      ["rotateKey", async (_w, s) => codeOf((d) => s.rotateKey(STRONG, d))],
      ["enableMasterPassword", async (_w, s) => codeOf((d) => s.enableMasterPassword(STRONG, d))],
      ["resetPasswordWithRecovery", async (_w, s, r1) => resetWithCode(s, r1!, STRONG2)],
    ];
    for (const [name, run] of cases) {
      const w = world();
      let r1: string | null = null;
      if (name === "enableMasterPassword") await legacyDeviceVault(w.store());
      else r1 = (await createProtected(w.svc())).recoveryCode;
      await w.add(w.svc(), "GitHub");
      if (name === "resetPasswordWithRecovery") await w.svc().lock();
      const s = new FailingSet();
      s.data = w.session.data;
      s.epoch = w.session.epoch;
      s.fail = true;
      const code = await run(w, w.svc(w.kv, w.mirror, s), r1);
      await w.store().selfCheck();
      expect(await opensWithCode((await active(w)).keyring, code), name).toBe(true);
      // a reset keeps the recovery key (the owner's report of 2026-11-18); the other two replace it
      if (r1)
        expect(await opensWithCode((await active(w)).keyring, r1), name).toBe(name === "resetPasswordWithRecovery");
      expect(w.diag, name).toContain("session not stored after a key change");
      // the user unlocks again (SYNC-DESIGN I2) and finds everything
      const fresh = w.svc(w.kv, w.mirror, new MemorySession());
      await fresh.unlockWithRecoveryCode(code);
      expect(await namesOf(w, fresh), name).toEqual(["GitHub"]);
    }
  });
});

describe("GM2-1(b): the new code reaches the page before anything else is written after the commit", () => {
  type Deliver = { onCode: (c: string) => void };
  const ops: [string, (w: W) => Promise<void>, (s: VaultService, d: Deliver) => Promise<void>, boolean][] = [
    [
      "rotateKey",
      async (w) => {
        await createProtected(w.svc());
      },
      (s, d) => s.rotateKey(STRONG, d),
      true,
    ],
    [
      "enableMasterPassword",
      async (w) => {
        await legacyDeviceVault(w.store());
      },
      (s, d) => s.enableMasterPassword(STRONG, d),
      true,
    ],
    [
      "newRecoveryCode",
      async (w) => {
        await createProtected(w.svc());
      },
      (s, d) => s.newRecoveryCode(STRONG, d),
      false,
    ],
  ];
  // A4 (A4R-2): this test said "the log comes after the cleanup, last". The entry is now written right after the code is
  // handed over, before the session and the cleanup, so a page closed during the cleanup cannot leave it out.
  it.each(ops)(
    "%s: onCode comes right after the transact's own writes, the log entry right after it, then the session and the cleanup",
    async (_name, setup, run, session) => {
      const w = world();
      await setup(w);
      await w.add(w.svc(), "GitHub");
      const tr = traced(w);
      const log = new SecurityLog({ kv: tr.kv, now: () => w.t.now });
      const s = w.svc(tr.kv, tr.mirror, tr.session, { security: log });
      let atCode: string[] | null = null;
      let markerAtCode = false;
      let delivered = "";
      await run(s, {
        onCode: (c) => {
          atCode = [...tr.log];
          markerAtCode = w.kv.data.has(KEYS.keyChange);
          delivered = c;
        },
      });
      expect(await opensWithCode((await active(w)).keyring, delivered)).toBe(true);
      const before = atCode as unknown as string[];
      expect(before).toContain("local:sk_active"); // committed ...
      expect(before.at(-1)).toBe("mirror:sk_mirror_gen"); // ... and nothing after the transact's last guarded write
      expect(markerAtCode).toBe(true); // the cleanup has not run yet
      const after = tr.log.slice(before.length);
      expect(after[0]).toBe("local:sk_security_log"); // the entry, right after the code
      if (session) expect(after[1]).toBe("session");
      expect(after.indexOf("local:-sk_keychange")).toBeGreaterThan(0); // the cleanup, after both
      expect(after.filter((x) => x === "local:sk_security_log")).toHaveLength(1);
      expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    },
  );

  it("commitReset (no code to hand over: it was shown before) writes the log entry right after the commit, before the session and the cleanup", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().lock();
    const p = await w.svc().prepareReset(r1, STRONG2);
    const tr = traced(w);
    await w
      .svc(tr.kv, tr.mirror, tr.session, { security: new SecurityLog({ kv: tr.kv, now: () => w.t.now }) })
      .commitReset(p);
    const commit = tr.log.indexOf("local:sk_active");
    const entry = tr.log.indexOf("local:sk_security_log");
    expect(entry).toBeGreaterThan(commit);
    expect(tr.log.indexOf("session")).toBeGreaterThan(entry);
    expect(tr.log.indexOf("local:-sk_keychange")).toBeGreaterThan(entry);
  });

  it("a page whose onCode throws does not make the change look failed", async () => {
    const w = world();
    await createProtected(w.svc());
    const before = (await active(w)).keyring;
    await w.svc().rotateKey(STRONG, {
      onCode: () => {
        throw new Error("page gone");
      },
    });
    expect((await active(w)).keyring.vkId).not.toBe(before.vkId); // committed all the same
    expect(await opensWithPw((await active(w)).keyring, STRONG)).toBe(true);
    expect(w.diag).toContain("onCode failed");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

// ---- GM2-13 ---------------------------------------------------------------------------------------------------------------

describe("GM2-13: the popup's reset is prepared in memory and written only after the user confirms the new code", () => {
  async function lockedWorld() {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().lock();
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    const s = w.svc(w.kv, w.mirror, w.session, { security: log });
    return { w, r1, s, log };
  }
  const kinds = async (log: SecurityLog) => (await log.read()).entries.map((e) => e.kind);

  it("prepareReset writes nothing of the vault: closing the popup before 'I saved it' leaves the old code and password working, and the new code opens nothing", async () => {
    const { w, r1, s } = await lockedWorld();
    const vaultKeys = () =>
      JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log")) + JSON.stringify([...w.mirror.data]);
    const before = vaultKeys();
    const p = await s.prepareReset(r1, STRONG2);
    expect(vaultKeys()).toBe(before); // only the security log's entry for the accepted code
    expect(w.session.data).toBeNull();
    const k = (await active(w)).keyring;
    expect(await opensWithCode(k, r1)).toBe(true);
    expect(await opensWithPw(k, STRONG)).toBe(true);
    expect(await keyringsOpenedBy(w, (x) => opensWithCode(x, p.recoveryCode))).toEqual([]);
  });

  it("commitReset: the new password opens everything, no copy anywhere opens with the old one, the recovery key goes on, unlocked; the code's use and the reset recorded once each", async () => {
    const { w, r1, s, log } = await lockedWorld();
    const p = await s.prepareReset(r1, STRONG2);
    expect(p.recoveryCode).toBe(""); // no new recovery key (the owner's report of 2026-11-18)
    await s.commitReset(p);
    expect((await s.status()).state).toBe("unlocked");
    const k = (await active(w)).keyring;
    expect(await opensWithCode(k, r1)).toBe(true);
    expect(await opensWithPw(k, STRONG2)).toBe(true);
    expect(await keyringsOpenedBy(w, (x) => opensWithPw(x, STRONG))).toEqual([]);
    expect(await keyringsOpenedBy(w, (x) => opensWithPw(x, STRONG))).toEqual([]);
    expect(await kinds(log)).toEqual(["password_reset", "recovery_used"]); // newest first
    await expect(s.commitReset(p)).rejects.toMatchObject({ code: "bad_state" }); // spent
  });

  it("a right code that is then abandoned (Back, or the popup closed) is still recorded: holding the code cannot be tested here unseen (A3-9)", async () => {
    const { w, r1, s, log } = await lockedWorld();
    const before = JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log"));
    await s.prepareReset(r1, STRONG2); // and then nothing
    expect(await kinds(log)).toEqual(["recovery_used"]);
    expect(JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log"))).toBe(before); // nothing of the vault written
  });

  it("refused, writing nothing, if the keys changed in another page between the two steps", async () => {
    const { w, r1, s } = await lockedWorld();
    const p = await s.prepareReset(r1, STRONG2);
    // another page (unlocked there) makes a new recovery code meanwhile
    const vk = await unlockWithRecoveryCode((await active(w)).keyring, r1);
    let r3 = "";
    await w.store().transact(async (cur) => {
      const r = await setRecovery(cur!.keyring, vk);
      r3 = r.recoveryCode;
      return { envelope: cur!.envelope, keyring: r.keyring };
    });
    const before = JSON.stringify([...w.kv.data]);
    await expect(s.commitReset(p)).rejects.toMatchObject({ code: "bad_state" });
    expect(JSON.stringify([...w.kv.data])).toBe(before);
    expect(await opensWithCode((await active(w)).keyring, r3)).toBe(true);
  });

  it("a wrong code is recorded and refused; a malformed one and a weak new password are not guesses", async () => {
    const { s, log } = await lockedWorld();
    await expect(s.prepareReset("0000-0000-0000-0000-0000-0000-00VM", STRONG2)).rejects.toMatchObject({
      code: "wrong_secret",
    });
    await expect(s.prepareReset("0000-0000-0000-0000-0000-0000-00VN", STRONG2)).rejects.toMatchObject({
      code: expect.stringMatching(/^recovery_/),
    });
    await expect(s.prepareReset("0000-0000-0000-0000-0000-0000-00VM", "short")).rejects.toMatchObject({
      code: "weak_password",
    });
    expect(await kinds(log)).toEqual(["recovery_failed"]);
  });

  it("a commit that landed although it reported a failure is finished by a retry with the same handle, not refused", async () => {
    const { w, r1, s } = await lockedWorld();
    const p = await s.prepareReset(r1, STRONG2);
    // the pointer write lands and throws, and FIXb's write-back of the old generation fails too: committed, told "failed"
    let pointer = false;
    let backFails = false;
    const kv = wrap(w.kv, {
      set: async (i) => {
        if (backFails && (KEYS.slot.a in i || KEYS.slot.b in i)) {
          backFails = false;
          throw new Error("IO error");
        }
        await w.kv.set(i);
        if (!pointer && KEYS.active in i) {
          pointer = true;
          backFails = true;
          throw new Error("IO error after the write");
        }
      },
    });
    await expect(w.svc(kv, w.mirror, w.session).commitReset(p)).rejects.toThrow("IO error after the write");
    expect(await opensWithPw((await active(w)).keyring, STRONG2)).toBe(true); // it did commit
    await s.commitReset(p); // the retry recognises its own reset
    expect((await s.status()).state).toBe("unlocked");
    expect(await keyringsOpenedBy(w, (x) => opensWithPw(x, STRONG))).toEqual([]);
  });
});

// ---- GM2-2 ----------------------------------------------------------------------------------------------------------------

describe("GM2-2: FIXa2 overwrites the keyring it rejects, and says so in the diagnostics log", () => {
  it("newRecoveryCode dies at the commit: after selfCheck the other slot holds the old keyring too, so a later fault on the pointer slot cannot commit the unseen code", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const die = dying(atCommit);
    await expect(w.svc(die(w.kv), die(w.mirror)).newRecoveryCode(STRONG, NO_PAGE)).rejects.toBeInstanceOf(Dead);
    w.session.data = null;
    await w.store().selfCheck();
    expect(await opensWithCode((await active(w)).keyring, r1)).toBe(true); // rolled back
    expect(canonicalJson((await otherSlot(w))!.keyring)).toBe(canonicalJson((await active(w)).keyring)); // the rejected one is gone
    expect(w.diag.some((m) => m.startsWith("key change rolled back"))).toBe(true);
    expect(await w.store().listEvents()).toEqual([]); // a diagnostics line, not a "data restored" banner
    // a second, unrelated fault: the pointer slot is damaged
    w.kv.data.set(KEYS.slot[ptrOf(w)], { torn: "x" });
    await w.store().selfCheck();
    expect(await opensWithCode((await active(w)).keyring, r1)).toBe(true); // the saved code still opens
  });

  it("an ordinary save's newer slot is not 'rejected' (no line; highest save wins)", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const die = dying(atCommit);
    await expect(
      w.svc(die(w.kv), die(w.mirror)).mutate((v, c) => addEntry(v, input("AWS"), c).vault),
    ).rejects.toBeInstanceOf(Dead);
    await w.store().selfCheck();
    expect(await namesOf(w)).toEqual(["GitHub", "AWS"]);
    expect(w.diag.some((m) => m.startsWith("key change rolled back"))).toBe(false);
  });

  // The review's lying-disk probe (Q1(c) SOUND): it alone killed mutants X4 (no redundancy repair in the FIXa2 branch) and
  // K6 (the keyring copy healed only when missing, not when it differs).
  it("a lying disk that drops only the key change's pointer write (later writes land): the self-check makes slot, keyring copy and mirror agree; nothing is lost", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    let dropped = false;
    const lying = wrap(w.kv, {
      set: async (i) => {
        if (!dropped && KEYS.active in i && Object.keys(i).length === 1 && w.kv.data.has(KEYS.keyChange)) {
          dropped = true;
          return;
        }
        return w.kv.set(i);
      },
    });
    const r2 = await codeOf((d) => w.svc(lying).rotateKey(STRONG, d)); // "success": the code is shown
    expect(dropped).toBe(true);
    expect(await tripleConsistent(w)).not.toEqual([]); // before the self-check the triple is out of step
    await expect(w.add(w.svc(), "AWS")).rejects.toMatchObject({ code: "locked" }); // the new key's session does not match the old keyring
    await w.store().selfCheck();
    expect(await tripleConsistent(w)).toEqual([]);
    expect(await opensWithCode((await active(w)).keyring, r1)).toBe(true);
    expect(await opensWithCode((await active(w)).keyring, r2)).toBe(false); // the shown code is dead (FIXa2's accepted cost)
    expect(await keyringsOpenedBy(w, (k) => opensWithCode(k, r2))).toEqual([]); // and nothing on disk still holds it
    await w.svc().unlockWithPassword(STRONG);
    expect(await namesOf(w)).toEqual(["GitHub"]);
  });
});

// ---- GM2-3 ----------------------------------------------------------------------------------------------------------------

describe("GM2-3 (P-5): a new password or recovery code of the same key leaves no copy that the old one opens", () => {
  it("changePassword, newRecoveryCode, resetPasswordWithRecovery: no slot, keyring copy or mirror generation opens with the superseded secret", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().changePassword(STRONG, STRONG2);
    expect(await keyringsOpenedBy(w, (k) => opensWithPw(k, STRONG))).toEqual([]);
    expect(await keyringsOpenedBy(w, (k) => opensWithPw(k, STRONG2))).toHaveLength(4); // both slots, the copy, the mirror
    const r2 = await codeOf((d) => w.svc().newRecoveryCode(STRONG2, d));
    expect(await keyringsOpenedBy(w, (k) => opensWithCode(k, r1))).toEqual([]);
    await w.svc().lock();
    const r3 = await resetWithCode(w.svc(), r2, STRONG);
    expect(r3).toBe(r2); // a reset keeps the recovery key (the owner's report of 2026-11-18)
    expect(await keyringsOpenedBy(w, (k) => opensWithPw(k, STRONG2))).toEqual([]);
    expect(await keyringsOpenedBy(w, (k) => opensWithCode(k, r3))).toHaveLength(4);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("the hook M2 is told to use works for a same-key adoption: the transact marks it by itself, finishKeyChange takes the old wrap out", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const vk = await sessionVk(w);
    await w.store().transact(async (cur) => ({
      envelope: cur!.envelope,
      keyring: await changePasswordWrap(cur!.keyring, vk, STRONG2),
    }));
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true); // no keyChange flag needed: the keyring changed
    const r = await w.store().finishKeyChange(vk, async () => null);
    expect(r.done).toBe(true);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(await keyringsOpenedBy(w, (k) => opensWithPw(k, STRONG))).toEqual([]);
  });

  // The review's late probe pinned FIXb for one same-key operation (mutant B3, FIXb by key id, survived the package's
  // tests); here for all three.
  const sameKey: [
    string,
    (s: VaultService, r1: string) => Promise<unknown>,
    (k: Keyring, r1: string) => Promise<boolean>,
  ][] = [
    ["resetPasswordWithRecovery", (s, r1) => resetWithCode(s, r1, STRONG2), (k, r1) => opensWithCode(k, r1)],
    ["changePassword", (s) => s.changePassword(STRONG, STRONG2), (k) => opensWithPw(k, STRONG)],
    ["newRecoveryCode", (s) => s.newRecoveryCode(STRONG, NO_PAGE), (k, r1) => opensWithCode(k, r1)],
  ];
  it.each(sameKey)(
    "%s whose pointer write lands and still reports an error: the old secret still works after a restart, and a retry works",
    async (name, run, oldOpens) => {
      const w = world();
      const { recoveryCode: r1 } = await createProtected(w.svc());
      await w.add(w.svc(), "GitHub");
      if (name === "resetPasswordWithRecovery") await w.svc().lock();
      await expect(run(w.svc(landsThenThrows(w.kv)), r1)).rejects.toThrow("IO error after the write");
      await w.store().selfCheck();
      expect(await oldOpens((await active(w)).keyring, r1)).toBe(true);
      await expect(run(w.svc(), r1)).resolves.not.toThrow();
    },
  );
});

// ---- GM2-4 ----------------------------------------------------------------------------------------------------------------

describe("GM2-4 (SYNC-DESIGN §0.0i): copies under a key the keyring does not list are offered to the callback first", () => {
  /** A vault with snapshots in both stores, then a keyring of ANOTHER vault adopted through transact (§3.5's shape). */
  async function joined() {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.store().ensureDailySnapshot(); // a daily copy in the mirror too
    const vk1 = await sessionVk(w);
    const vault1 = (await active(w)).keyring.vaultId;
    const other = world();
    await createProtected(other.svc());
    const g2 = await active(other);
    const vk2 = await sessionVk(other);
    const plain = await decryptVault((await active(w)).envelope, vk1);
    const env = await encryptVault(plain, vk2, { vaultId: g2.keyring.vaultId, rev: 1 });
    await w.store().transact(async () => ({ envelope: env, keyring: g2.keyring }), { keyChange: true });
    const under = (m: MemoryKV, id: string) =>
      snapRecords(m)
        .filter(([, v]) => (v as { envelope?: EncryptedVault }).envelope?.vkId === id)
        .map(([k]) => k);
    expect(under(w.kv, vk1.id).length).toBeGreaterThan(0);
    expect(under(w.mirror, vk1.id).length).toBeGreaterThan(0);
    return { w, vk1, vk2, vault1, under };
  }

  it("the §3.5 join: a callback that holds the device's old key re-encrypts them; kept, under the new key, with their own vault id, in both stores", async () => {
    const { w, vk1, vk2, vault1, under } = await joined();
    const offered: string[] = [];
    const r = await w.store().finishKeyChange(vk2, async (e) => {
      offered.push(e.vkId);
      return e.vkId === vk1.id
        ? encryptVault(await decryptVault(e, vk1), vk2, { vaultId: e.vaultId, rev: e.rev })
        : null;
    });
    expect(offered).toContain(vk1.id);
    expect(r).toMatchObject({ done: true, dropped: 0 });
    expect(r.rewritten).toBeGreaterThan(0);
    expect(under(w.kv, vk1.id)).toEqual([]);
    expect(under(w.mirror, vk1.id)).toEqual([]);
    const moved = [...snapRecords(w.kv), ...snapRecords(w.mirror)]
      .map(([, v]) => (v as { envelope: EncryptedVault }).envelope)
      .filter((e) => e.vaultId === vault1);
    expect(moved.length).toBeGreaterThan(0);
    const opened: string[][] = [];
    for (const e of moved) {
      expect(e.vkId).toBe(vk2.id);
      opened.push(aliveEntries(deserializeVault(await decryptVault(e, vk2))).map((x) => x.issuer));
    }
    expect(opened).toContainEqual(["GitHub"]); // readable for "find accounts" (§4.6)
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("a callback that cannot open them: another vault's copies are dropped from both stores, and the marker is gone", async () => {
    const { w, vk1, vk2, under } = await joined();
    let offered = 0;
    const r = await w.store().finishKeyChange(vk2, async (e) => {
      if (e.vkId === vk1.id) offered++;
      return null;
    });
    expect(offered).toBeGreaterThan(0);
    expect(r.done).toBe(true);
    expect(r.dropped).toBeGreaterThan(0);
    expect(under(w.kv, vk1.id)).toEqual([]);
    expect(under(w.mirror, vk1.id)).toEqual([]);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("another vault's copy left only in the mirror counts as stale there: a cleanup runs for it and drops it", async () => {
    const { w, vk1, vk2, under } = await joined();
    await w.store().finishKeyChange(vk2, async () => null); // this store and the mirror cleaned
    // plant a copy of another vault, under a key nobody here has, in the mirror only
    const { vk: lost } = await createKeyring();
    const env = await encryptVault(utf8("x"), lost, { vaultId: "another-vault-01", rev: 0 });
    w.mirror.data.set(KEYS.snap("d1999-01-01"), {
      v: 1,
      meta: { id: "d1999-01-01", kind: "daily", at: 1, seq: 0, day: "1999-01-01" },
      envelope: env,
    });
    w.mirror.data.set(KEYS.snapIndex, [
      ...(w.mirror.data.get(KEYS.snapIndex) as unknown[]),
      { id: "d1999-01-01", kind: "daily", at: 1, seq: 0, day: "1999-01-01" },
    ]);
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: vk2.id, at: 1, mirror: true }); // only the mirror is left to check
    const r = await w.store().finishKeyChange(vk2, async () => null);
    expect(r.done).toBe(true);
    expect(w.mirror.data.has(KEYS.snap("d1999-01-01"))).toBe(false);
    expect(under(w.mirror, vk1.id)).toEqual([]);
  });

  it("startOver over a lost device-key vault: the old device key's snapshots do not outlive the cleanup (A2-4)", async () => {
    const w = world();
    const { vk: oldVk } = await legacyDeviceVault(w.store());
    await w.add(w.svc(), "GitHub");
    await w.add(w.svc(), "AWS");
    await w.store().ensureDailySnapshot();
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) w.kv.data.set(k, { torn: "x" });
    w.mirror.data.delete(KEYS.mirrorGen);
    const svc = w.svc();
    expect((await svc.openView()).state).toBe("lost");
    await svc.startOver(await svc.prepareKeys(STRONG));
    await svc.openView(); // the cleanup the marker asks for
    const left = [...snapRecords(w.kv), ...snapRecords(w.mirror)].filter(
      ([, v]) => (v as { envelope?: EncryptedVault }).envelope?.vkId === oldVk.id,
    );
    expect(left).toEqual([]);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("purgeForever is erasure, not a key-change cleanup: a copy of this vault under a key nobody here holds is dropped, not kept (it cannot be checked for the secret)", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "Bank");
    await w.add(w.svc(), "GitHub");
    const vaultId = (await active(w)).keyring.vaultId;
    const { vk: lost } = await createKeyring();
    // a copy of this vault under a key it does not list (a newer key after a rollback, say): it may hold the secret
    const env = await encryptVault(utf8("{}"), lost, { vaultId, rev: 0 });
    const meta = { id: "r900", kind: "rolling", at: 1, seq: 900 };
    w.kv.data.set(KEYS.snap("r900"), { v: 1, meta, envelope: env });
    w.kv.data.set(KEYS.snapIndex, [...(w.kv.data.get(KEYS.snapIndex) as unknown[]), meta]);
    const id = (await w.svc().read()).vault.entries.find((e) => e.issuer === "Bank")!.id;
    await w.svc().purgeForever([id], STRONG);
    expect(w.kv.data.has(KEYS.snap("r900"))).toBe(false);
  });

  it("a copy of another vault is never a decrypt fallback for this one, even under this key", async () => {
    const { w, vk1, vk2, vault1 } = await joined();
    await w
      .store()
      .finishKeyChange(vk2, async (e) =>
        e.vkId === vk1.id ? encryptVault(await decryptVault(e, vk1), vk2, { vaultId: e.vaultId, rev: e.rev }) : null,
      );
    // the old vault's copies are under this key now; give one the highest save counter
    const [k, rec] = snapRecords(w.kv).find(
      ([, v]) => (v as { envelope: EncryptedVault }).envelope.vaultId === vault1,
    )! as [string, { meta: { seq: number } }];
    w.kv.data.set(k, { ...rec, meta: { ...rec.meta, seq: 999 } });
    w.kv.data.set(
      KEYS.snapIndex,
      (w.kv.data.get(KEYS.snapIndex) as { id: string; seq: number }[]).map((m) =>
        KEYS.snap(m.id) === k ? { ...m, seq: 999 } : m,
      ),
    );
    // the active copy passes its checksum but does not open
    const act = await active(w);
    w.kv.data.set(KEYS.slot[ptrOf(w)], {
      ...act,
      envelope: await encryptVault(utf8("not a vault"), vk2, {
        vaultId: act.keyring.vaultId,
        rev: act.envelope.rev + 1,
      }),
    });
    const r = await w.store().openVault(vk2);
    expect(r.gen.envelope.vaultId).toBe(act.keyring.vaultId); // restored from this vault's own copy
    expect(r.recovered?.kind).toBe("decrypt_fallback");
  });
});

// ---- the one cleanup entry point and M2's VK-encrypted records (§0.0i M2 req. 5) -----------------------------------------

/** A stand-in for sk_sync_cfg.enc / sk_prejoin: an envelope under the vault key, kept in its own store. */
class FakeRecord implements VkRecord {
  readonly name = "fake record";
  calls: { current: string; held: string[] }[] = [];
  failRead = false;
  constructor(
    readonly kv: MemoryKV,
    readonly key: string,
    readonly order?: string[],
  ) {}
  async reencrypt(current: Vk, held: readonly Vk[]): Promise<"absent" | "current" | "rewritten" | "unopenable"> {
    this.calls.push({ current: current.id, held: held.map((k) => k.id) });
    if (this.failRead) throw new Error("IO error: transient");
    const env = this.kv.data.get(this.key) as EncryptedVault | undefined;
    if (!env) return "absent";
    if (env.vkId === current.id) return "current";
    const k = held.find((h) => h.id === env.vkId);
    if (!k) return "unopenable";
    this.kv.data.set(
      this.key,
      await encryptVault(await decryptVault(env, k), current, { vaultId: env.vaultId, rev: env.rev }),
    );
    this.order?.push("record");
    return "rewritten";
  }
}

describe("the one cleanup entry point (SYNC-DESIGN §0.0i M2 req. 5): VK-encrypted records outside the store move first", () => {
  async function withRecord() {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const vk1 = await sessionVk(w);
    const recs = new MemoryKV();
    recs.data.set("sk_prejoin", await encryptVault(utf8("prejoin data"), vk1, { vaultId: "prejoin-vault-01", rev: 3 }));
    return { w, vk1, recs };
  }

  it("after a rotation: the record is under the new key (same content, its own vault id), before the store's cleanup ends; the old key was offered", async () => {
    const { w, vk1, recs } = await withRecord();
    const tr = traced(w);
    const rec = new FakeRecord(recs, "sk_prejoin", tr.log);
    await w.svc(tr.kv, tr.mirror, w.session, { vkRecords: [rec] }).rotateKey(STRONG, NO_PAGE);
    const vk2 = await sessionVk(w);
    const env = recs.data.get("sk_prejoin") as EncryptedVault;
    expect(env.vkId).toBe(vk2.id);
    expect(env.vaultId).toBe("prejoin-vault-01");
    expect(new TextDecoder().decode(await decryptVault(env, vk2))).toBe("prejoin data");
    expect(rec.calls[0]!.held).toContain(vk1.id);
    expect(tr.log.indexOf("record")).toBeLessThan(tr.log.indexOf("local:-sk_keychange")); // before the marker goes
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("the keys the caller holds besides the keyring's previous ones (M2's §3.5 join: the device's own old key) open copies and records too", async () => {
    // No Phase 0 path holds such a key (a rotation's old key is in previous), so the entry point is called directly here,
    // as M2's join will call it: a keyring of another vault adopted, the device's old key in memory.
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const vk1 = await sessionVk(w);
    const recs = new MemoryKV();
    recs.data.set("sk_prejoin", await encryptVault(utf8("prejoin data"), vk1, { vaultId: "prejoin-vault-01", rev: 0 }));
    const other = world();
    await createProtected(other.svc());
    const g2 = await active(other);
    const vk2 = await sessionVk(other);
    const env = await encryptVault(await decryptVault((await active(w)).envelope, vk1), vk2, {
      vaultId: g2.keyring.vaultId,
      rev: 1,
    });
    await w.store().transact(async () => ({ envelope: env, keyring: g2.keyring }));
    const svc = w.svc(w.kv, w.mirror, w.session, { vkRecords: [new FakeRecord(recs, "sk_prejoin")] });
    const entry = (
      svc as unknown as { finishKeyChanges(vk: Vk, k: Keyring, held: Vk[]): Promise<{ done: boolean }> }
    ).finishKeyChanges.bind(svc);
    expect((await entry(vk2, g2.keyring, [vk1])).done).toBe(true);
    expect((recs.data.get("sk_prejoin") as EncryptedVault).vkId).toBe(vk2.id);
    const left = snapRecords(w.kv).map(([, v]) => (v as { envelope: EncryptedVault }).envelope);
    expect(left.filter((e) => e.vkId === vk1.id)).toEqual([]);
    expect(left.filter((e) => e.vaultId !== g2.keyring.vaultId).length).toBeGreaterThan(0); // re-encrypted and kept, not dropped
  });

  it("a record whose read throws stops the cleanup before the store's part: the marker stays, the next unlock finishes", async () => {
    const { w, vk1, recs } = await withRecord();
    const rec = new FakeRecord(recs, "sk_prejoin");
    rec.failRead = true;
    await w.svc(w.kv, w.mirror, w.session, { vkRecords: [rec] }).rotateKey(STRONG, NO_PAGE); // still succeeds: the change is made
    expect(w.diag).toContain("key change cleanup incomplete");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    expect((await otherSlot(w))!.keyring.vkId).toBe(vk1.id); // the store's copies were not touched
    rec.failRead = false;
    const s = w.svc(w.kv, w.mirror, w.session, { vkRecords: [rec] });
    await s.lock();
    await s.unlockWithPassword(STRONG); // housekeeping goes through the same entry point
    const vk2 = await sessionVk(w);
    expect((recs.data.get("sk_prejoin") as EncryptedVault).vkId).toBe(vk2.id);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect((await otherSlot(w))!.keyring.vkId).toBe(vk2.id);
  });

  it("a record no key opens is reported and left alone; it does not hold the marker up", async () => {
    const { w, recs } = await withRecord();
    const { vk: stranger } = await createKeyring();
    recs.data.set("sk_prejoin", await encryptVault(utf8("x"), stranger, { vaultId: "prejoin-vault-01", rev: 0 }));
    const before = JSON.stringify(recs.data.get("sk_prejoin"));
    await w
      .svc(w.kv, w.mirror, w.session, { vkRecords: [new FakeRecord(recs, "sk_prejoin")] })
      .rotateKey(STRONG, NO_PAGE);
    expect(JSON.stringify(recs.data.get("sk_prejoin"))).toBe(before);
    expect(w.diag).toContain("fake record: no key opens it");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

// ---- GM2-7 ----------------------------------------------------------------------------------------------------------------

describe("GM2-7: the decrypt fallback does not pass over a copy it could not read for an older one", () => {
  async function brokenActive(o: { keepMirror?: boolean } = {}) {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    const vk = await sessionVk(w);
    const act = await active(w);
    w.kv.data.set(KEYS.slot[ptrOf(w)], {
      ...act,
      envelope: await encryptVault(utf8("not a vault"), vk, {
        vaultId: act.keyring.vaultId,
        rev: act.envelope.rev + 1,
      }),
    });
    w.kv.data.set(KEYS.slot[otherOf(ptrOf(w))], { torn: "x" });
    if (!o.keepMirror) w.mirror.data.delete(KEYS.mirrorGen);
    return { w, act };
  }
  const failOnce = (inner: KV, key: string) => {
    let thrown = 0;
    return {
      kv: wrap(inner, {
        get: async (k) => {
          if (k.length === 1 && k[0] === key && thrown === 0) {
            thrown++;
            throw new Error("IO error: transient");
          }
          return inner.get(k);
        },
      }),
      thrown: () => thrown,
    };
  };

  it("the newest snapshot's read throws once: the open fails (Retry) and commits nothing; the retry restores the newest", async () => {
    const { w, act } = await brokenActive();
    const before = JSON.stringify(w.kv.data.get(KEYS.slot[ptrOf(w)]));
    const f = failOnce(w.kv, KEYS.snap(`r${act.seq}`));
    await expect(w.svc(f.kv).openView()).rejects.toThrow("IO error: transient");
    expect(f.thrown()).toBe(1);
    expect(JSON.stringify(w.kv.data.get(KEYS.slot[ptrOf(w)]))).toBe(before); // nothing committed
    expect(await w.store().listEvents()).toEqual([]);
    const v = await w.svc(f.kv).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]);
    expect(v.state === "unlocked" && v.events.map((e) => e.kind)).toEqual(["decrypt_fallback"]);
  });

  it("an older snapshot's read throws: the newest copy that opens is still restored", async () => {
    const { w, act } = await brokenActive();
    const f = failOnce(w.kv, KEYS.snap(`r${act.seq - 1}`));
    const v = await w.svc(f.kv).openView();
    expect(f.thrown()).toBe(1);
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]);
  });

  // A4 (A4R-3): this test had the open fail. The mirror is written after the local commit, with the same save counter,
  // so an unreadable mirror cannot hide a save newer than the active slot's: the local copy of that very save is
  // restored, also with an IndexedDB that fails for good. Only a copy older than that is refused while the mirror is unread.
  it("an IndexedDB that always fails (A4R-3): the local copy of the very save that does not open is restored, at every open", async () => {
    const { w } = await brokenActive();
    const fail = async () => {
      throw new Error("Internal error opening backing store for indexedDB.open.");
    };
    const broken: KV = { get: fail, keys: fail, set: fail, remove: fail };
    const v = await w.svc(w.kv, broken).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]);
    expect(v.state === "unlocked" && v.events.map((e) => e.kind)).toEqual(["decrypt_fallback"]);
    const again = await w.svc(w.kv, broken).openView();
    expect(again.state === "unlocked" && aliveEntries(again.vault).map((e) => e.issuer)).toEqual([
      "GitHub",
      "AWS",
      "Stripe",
    ]);
  });

  it("the mirror unread and only an older local copy opening: the open fails rather than restore it; so does a local index that cannot be read", async () => {
    const { w, act } = await brokenActive();
    w.kv.data.delete(KEYS.snap(`r${act.seq}`)); // the copy of the last save is gone: the best local copy is older
    w.kv.data.set(
      KEYS.snapIndex,
      (w.kv.data.get(KEYS.snapIndex) as { id: string }[]).filter((m) => m.id !== `r${act.seq}`),
    );
    const f = failOnce(w.mirror, KEYS.mirrorGen);
    await expect(w.svc(w.kv, f.kv).openView()).rejects.toThrow("IO error: transient");
    // a local index that cannot be read may hide anything: even the mirror's copy of the last save, which opens, is not
    // committed in its place (only the mirror's own unknowns count as the active save)
    const { w: w2 } = await brokenActive({ keepMirror: true });
    expect(w2.mirror.data.has(KEYS.mirrorGen)).toBe(true);
    const idx = failOnce(w2.kv, KEYS.snapIndex);
    await expect(w2.svc(idx.kv).openView()).rejects.toThrow("IO error: transient");
    expect(idx.thrown()).toBe(1);
    const v = await w2.svc(idx.kv).openView(); // the retry
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]);
  });
});

// ---- GM2-10 ---------------------------------------------------------------------------------------------------------------

describe("GM2-10: touch() and a lock in another context", () => {
  const routed = (inner: SessionCache, kv: MemoryKV) => new RoutedSession(inner, new KvSettingsStore(kv));
  const facade = (shared: MemorySession, o: Partial<SessionCache>): SessionCache => ({
    get: () => shared.get(),
    set: (d) => shared.set(d),
    clear: () => shared.clear(),
    lockEpoch: () => shared.lockEpoch(),
    bumpLockEpoch: () => shared.bumpLockEpoch(),
    getQuick: () => shared.getQuick(),
    setQuick: (q) => shared.setQuick(q),
    clearQuick: () => shared.clearQuick(),
    ...o,
  });

  it("the lock lands while touch() holds the session it read: the key is not written back", async () => {
    const kv = new MemoryKV();
    const shared = new MemorySession(); // chrome.storage.session, shared by every context
    let gate: (() => void) | null = null;
    const slowGet = facade(shared, {
      get: async () => {
        const d = await shared.get();
        if (gate === null)
          await new Promise<void>((r) => {
            gate = r;
          });
        return d;
      },
    });
    shared.data = { vk: "AAAA", lastActive: 1, epoch: 0 };
    const popup = new VaultService({
      store: new VaultStore({ kv, lock: createMutex() }),
      session: routed(slowGet, kv),
      settings: new KvSettingsStore(kv),
    });
    const sw = new VaultService({
      store: new VaultStore({ kv, lock: createMutex() }),
      session: routed(shared, kv),
      settings: new KvSettingsStore(kv),
    });
    const touching = popup.touch();
    while (gate === null) await new Promise((r) => setTimeout(r, 1));
    await sw.lock(); // screen lock: cleared, epoch bumped
    let writes = 0;
    const set = shared.set.bind(shared);
    shared.set = async (d) => {
      writes++;
      return set(d);
    };
    (gate as () => void)();
    await touching;
    expect(shared.data).toBeNull();
    expect(writes).toBe(0); // not written back even for a moment
    expect(await shared.lockEpoch()).toBe(1); // and nothing else was locked on its account
  });

  it("the lock lands between touch()'s check and its write: the key it wrote goes again", async () => {
    const kv = new MemoryKV();
    const shared = new MemorySession();
    shared.data = { vk: "AAAA", lastActive: 1, epoch: 0 };
    const sw = new VaultService({
      store: new VaultStore({ kv, lock: createMutex() }),
      session: routed(shared, kv),
      settings: new KvSettingsStore(kv),
    });
    let raced = false;
    const racing = facade(shared, {
      set: async (d) => {
        if (!raced) {
          raced = true;
          await sw.lock();
        }
        return shared.set(d);
      },
    });
    const popup = new VaultService({
      store: new VaultStore({ kv, lock: createMutex() }),
      session: routed(racing, kv),
      settings: new KvSettingsStore(kv),
    });
    await popup.touch();
    expect(raced).toBe(true);
    expect(shared.data).toBeNull();
  });

  it("touch() still records activity on a live session, and the service worker's timer clears a voided one", async () => {
    const kv = new MemoryKV();
    const shared = new MemorySession();
    shared.data = { vk: "AAAA", lastActive: 1, epoch: 0 };
    const t = { now: 5000 };
    const svc = new VaultService({
      store: new VaultStore({ kv, lock: createMutex() }),
      session: routed(shared, kv),
      settings: new KvSettingsStore(kv),
      now: () => t.now,
    });
    await svc.touch();
    expect(shared.data!.lastActive).toBe(5000);
    expect(await svc.enforceAutoLock()).toBe(false); // live, not expired
    shared.epoch = 1; // a lock elsewhere voided it, and something wrote it back
    expect(await svc.enforceAutoLock()).toBe(true);
    expect(shared.data).toBeNull();
  });
});

// ---- GM2-12: write order (mutant C4) --------------------------------------------------------------------------------------

describe("GM2-12: the commit order", () => {
  it("the mirror generation and the keyring copy are written only after the pointer moved (a mirror ahead of an uncommitted save could be restored by a later double fault)", async () => {
    const w = world();
    await createProtected(w.svc());
    for (const run of [
      (s: VaultService) => w.add(s, "GitHub"),
      (s: VaultService) => s.rotateKey(STRONG, NO_PAGE),
      (s: VaultService) => s.changePassword(STRONG, STRONG2),
    ]) {
      const tr = traced(w);
      await run(w.svc(tr.kv, tr.mirror, tr.session));
      const commit = tr.log.indexOf("local:sk_active");
      expect(commit).toBeGreaterThan(0);
      expect(tr.log.indexOf("mirror:sk_mirror_gen")).toBeGreaterThan(commit);
      expect(tr.log.indexOf("local:sk_keyring")).toBeGreaterThan(commit);
      expect(tr.log.slice(0, commit).filter((x) => x.startsWith("mirror:"))).toEqual([]);
    }
  });
});

// ---- A4 review follow-up: the reviewer's probes that pin rules no package test did (A4R-13: R07, R08, R14) ----------------

describe("A4R-13: rules the A4 review found unpinned", () => {
  it("(R14) a same-key change whose cleanup fails at the keyring copy write: the next cleanup still replaces the copy's old wrap", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    let failCopy = 0; // the transact's own copy write is guarded; fail it and the cleanup's one
    const kv = wrap(w.kv, {
      set: async (i) => {
        if (KEYS.keyringCopy in i && failCopy < 2) {
          failCopy++;
          throw new Error("IO error");
        }
        return w.kv.set(i);
      },
    });
    await w.svc(kv).changePassword(STRONG, STRONG2); // succeeds; the cleanup stops at the copy
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    await w.svc().lock();
    await w.svc().unlockWithPassword(STRONG2); // the next cleanup
    const copy = w.kv.data.get(KEYS.keyringCopy) as { keyring: Keyring };
    expect(await opensWithPw(copy.keyring, STRONG)).toBe(false); // the old password no longer opens anything
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  async function broken(daily: boolean) {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    if (daily) await w.store().ensureDailySnapshot(); // a daily copy of the very last save (same save counter as r<seq>)
    const vk = await sessionVk(w);
    const act = await active(w);
    w.kv.data.set(KEYS.slot[ptrOf(w)], {
      ...act,
      envelope: await encryptVault(utf8("not a vault"), vk, {
        vaultId: act.keyring.vaultId,
        rev: act.envelope.rev + 1,
      }),
    });
    return { w, act };
  }
  const failing = (inner: KV, keys: string[]) =>
    wrap(inner, {
      get: async (k) => {
        if (k.length === 1 && keys.includes(k[0]!)) throw new Error("IO error: transient");
        return inner.get(k);
      },
    });

  it("(R07) the daily copy of the last save cannot be read; the rolling copy of the same save opens and is restored (an equal counter is the same save)", async () => {
    const { w } = await broken(true);
    const dailyKey = [...w.kv.data.keys()].find((k) => k.startsWith("sk_snap_d"))!;
    const v = await w.svc(failing(w.kv, [dailyKey])).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]);
  });

  it("(R08) an older copy's read throws first, the mirror generation's after; only a copy between them opens: the open fails (the newest unread counts)", async () => {
    const { w, act } = await broken(false);
    // the rolling copy of the last save is gone, so the best local copy is the other slot (one save older)
    w.kv.data.delete(KEYS.snap(`r${act.seq}`));
    w.kv.data.set(
      KEYS.snapIndex,
      (w.kv.data.get(KEYS.snapIndex) as { id: string }[]).filter((m) => m.id !== `r${act.seq}`),
    );
    const older = KEYS.snap(`r${act.seq - 2}`);
    expect(w.kv.data.has(older)).toBe(true);
    await expect(w.svc(failing(w.kv, [older]), failing(w.mirror, [KEYS.mirrorGen])).openView()).rejects.toThrow(
      "IO error",
    );
  });
});

// ---- A4R-4: a VkRecord written to its contract (one critical section under the vault lock) -------------------------------

/** Read, check that `current` is still the vault's key, re-encrypt and write: all under the vault lock, in one section. */
class LockedRecord implements VkRecord {
  readonly name = "locked record";
  gate: Promise<void> | null = null;
  onReached: (() => void) | null = null;
  constructor(
    readonly kv: MemoryKV,
    readonly key: string,
    readonly lock: <T>(fn: () => Promise<T>) => Promise<T>,
    readonly vaultKv: MemoryKV,
  ) {}
  reencrypt(current: Vk, held: readonly Vk[]): Promise<"absent" | "current" | "rewritten" | "unopenable"> {
    return this.lock(async () => {
      const ptr = this.vaultKv.data.get(KEYS.active) as "a" | "b";
      const g = await checkGeneration(this.vaultKv.data.get(KEYS.slot[ptr]));
      const env = this.kv.data.get(this.key) as EncryptedVault | undefined;
      if (!env) return "absent";
      if (env.vkId === current.id) return "current";
      if (!g || g.keyring.vkId !== current.id) return "unopenable"; // the key moved on: the newer change's cleanup moves it
      const k = held.find((h) => h.id === env.vkId);
      if (!k) return "unopenable";
      const next = await encryptVault(await decryptVault(env, k), current, { vaultId: env.vaultId, rev: env.rev });
      if (this.gate) {
        this.onReached?.();
        await this.gate;
      } // the other page tries to run here: it waits for the lock
      this.kv.data.set(this.key, next);
      return "rewritten";
    });
  }
}

describe("A4R-4: a record written to the VkRecord contract cannot be left under a superseded key", () => {
  it("page A's cleanup after its rotation (VK1 to VK2) and page B's rotation (VK2 to VK3) race: the record ends under VK3, with no marker left", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const vk1 = await sessionVk(w);
    const recs = new MemoryKV();
    recs.data.set("sk_prejoin", await encryptVault(utf8("prejoin"), vk1, { vaultId: "prejoin-vault-01", rev: 0 }));
    const lock = createMutex(); // webLock("sixkey-vault"): one lock for both pages' stores and the records
    const page = (session: SessionCache, rec: VkRecord) =>
      new VaultService({
        store: new VaultStore({ kv: w.kv, mirror: w.mirror, lock, now: () => w.t.now }),
        session,
        settings: w.settings,
        now: () => w.t.now,
        vkRecords: [rec],
      });
    const recA = new LockedRecord(recs, "sk_prejoin", lock, w.kv);
    let release!: () => void;
    recA.gate = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<void>((r) => {
      recA.onReached = r;
    });
    const sessA = new MemorySession();
    sessA.data = w.session.data;
    sessA.epoch = w.session.epoch;
    const a = page(sessA, recA).rotateKey(STRONG, NO_PAGE);
    await reached; // A's record step holds the lock, between its re-encryption and its write
    const sessB = new MemorySession();
    sessB.data = { ...sessA.data! };
    const b = page(sessB, new LockedRecord(recs, "sk_prejoin", lock, w.kv)).rotateKey(STRONG, NO_PAGE); // B waits for the lock
    release();
    await Promise.all([a, b]);
    const vk3 = await vkFromRaw(fromB64(sessB.data!.vk));
    expect((await active(w)).keyring.vkId).toBe(vk3.id);
    expect((recs.data.get("sk_prejoin") as EncryptedVault).vkId).toBe(vk3.id);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

// ---- C6-1: a new recovery code needs the master password (H3) ----------------------------------------------------------

describe("C6-1 (H3): making a new recovery code needs the master password, even unlocked", () => {
  async function unlockedWithLog() {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "Bank");
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    return { w, r1, log, s: w.svc(w.kv, w.mirror, w.session, { security: log }) };
  }
  const kinds = async (log: SecurityLog) => (await log.read()).entries.map((e) => e.kind).reverse(); // oldest first

  it("no password or a wrong one is refused and nothing changes; a wrong one is counted once; the empty field is a typo", async () => {
    const { w, r1, s, log } = await unlockedWithLog();
    const before = JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log"));
    let delivered = 0;
    await expect(
      s.newRecoveryCode("", {
        onCode: () => {
          delivered++;
        },
      }),
    ).rejects.toMatchObject({ code: "empty_password" });
    await expect(
      s.newRecoveryCode("attacker guess 77!", {
        onCode: () => {
          delivered++;
        },
      }),
    ).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(
      s.newRecoveryCode(r1, {
        onCode: () => {
          delivered++;
        },
      }),
    ).rejects.toMatchObject({ code: "wrong_secret" }); // the code is not the password
    expect(delivered).toBe(0);
    expect(JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log"))).toBe(before);
    expect(await kinds(log)).toEqual(["unlock_failed", "unlock_failed"]);
    expect(await opensWithCode((await active(w)).keyring, r1)).toBe(true); // the owner's code still works
  });

  it("the right password: the new code replaces the old one and is recorded; the review's bypass (no password, then a reset) is gone at its first step", async () => {
    const { w, r1, s, log } = await unlockedWithLog();
    const r2 = await codeOf((d) => s.newRecoveryCode(STRONG, d));
    expect(await opensWithCode((await active(w)).keyring, r2)).toBe(true);
    expect(await opensWithCode((await active(w)).keyring, r1)).toBe(false);
    expect(await kinds(log)).toEqual(["recovery_code_new"]);
    // C6-REVIEW's sequence: someone at the unlocked browser without the password gets no code to reset with
    const other = await unlockedWithLog();
    await expect(other.s.newRecoveryCode("", NO_PAGE)).rejects.toBeDefined();
    await other.s.lock();
    await expect(
      resetWithCode(other.s, "0000-0000-0000-0000-0000-0000-00VM", "attacker chosen password 77!"),
    ).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(other.s.verifyPassword(STRONG)).resolves.toBeUndefined(); // the owner's password still works
  });

  it("locked: refused (after the password check, so a guess is still counted), nothing written", async () => {
    const { w, s, log } = await unlockedWithLog();
    await s.lock();
    await expect(s.newRecoveryCode(STRONG, NO_PAGE)).rejects.toMatchObject({ code: "locked" });
    await expect(s.newRecoveryCode("attacker guess 77!", NO_PAGE)).rejects.toMatchObject({ code: "wrong_secret" });
    expect(await kinds(log)).toEqual(["unlock_failed"]);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("a Phase 0 device-key vault has no master password (not_protected): as for clearing the log and exporting, none is asked", async () => {
    const w = world();
    await legacyDeviceVault(w.store());
    const code = await codeOf((d) => w.svc().newRecoveryCode("", d));
    expect(await opensWithCode((await active(w)).keyring, code)).toBe(true);
  });
});
