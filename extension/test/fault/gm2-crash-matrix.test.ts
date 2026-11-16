// The G-M2 review's crash matrix (docs/audit/internal-reviews/GM2-REVIEW.md, Appendix C), kept as a package test (GM2-12) and extended for A4.
// One process for local storage, the mirror and the session (the Proc model of keychange-marker.test.ts) dies at write N
// of an operation, just before or just after the write lands. Then either the browser restarts (session cleared,
// selfCheck) or it does not (a page died; the popup opens). Then the user unlocks with whatever they hold.
//
// Hard invariants, at every point (the test fails otherwise):
//   - every account is there; some credential the user holds opens what every load() sees;
//   - a completed run's password and code open it; A4 (GM2-1): so does a code the page was shown before the process
//     died (onCode, or confirmed before the commit), whatever happened after;
//   - after selfCheck, the pointer slot, the keyring copy and the mirror generation carry one keyring;
//   - the marker's promise (A4, GM2-3/GM2-4: by whole keyring, not by key id): anything on disk that a superseded secret
//     or another vault's key opens means a cleanup is due ("full" if it is in this store);
//   - after the next open or unlock: no device material, and the other slot carries the active keyring (P-5 and the
//     FIXa2 leftover, GM2-2), except where the vault is still a device-key vault that was never cleaned (below).
// Counted, not failed: "committed, code never shown" (the window GM2-1(b) shrinks). The rows go to $GM2_MATRIX_OUT.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { checkGeneration, checkKeyringCopy, checkSnapshot, KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type PreparedKeys, type PreparedReset } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { canonicalJson } from "../../src/core/vault/merge";
import { createProtected, deviceMaterial, legacyDeviceVault, STRONG } from "../helpers/vaults";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";

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
const NAMES = ["GitHub", "AWS", "Stripe"];

class Dead extends Error {
  constructor() {
    super("process died");
    this.name = "Dead";
  }
}
class Proc {
  calls = 0;
  dead = false;
  commits: number[] = [];
  constructor(
    public at = Infinity,
    public mode: "before" | "after" = "before",
  ) {}
  hit(items?: Record<string, unknown>): boolean {
    if (this.dead) throw new Dead();
    this.calls++;
    if (items && KEYS.active in items) this.commits.push(this.calls);
    if (this.calls === this.at) {
      this.dead = true;
      return this.mode === "after";
    }
    return true;
  }
}
class ProcKV implements KV {
  constructor(
    private inner: MemoryKV,
    private p: Proc,
  ) {}
  async get(k: string[]) {
    if (this.p.dead) throw new Dead();
    return this.inner.get(k);
  }
  async keys() {
    if (this.p.dead) throw new Dead();
    return this.inner.keys();
  }
  async set(items: Record<string, unknown>) {
    const land = this.p.hit(items);
    if (land) await this.inner.set(items);
    if (this.p.dead) throw new Dead();
  }
  async remove(keys: string[]) {
    const land = this.p.hit();
    if (land) await this.inner.remove(keys);
    if (this.p.dead) throw new Dead();
  }
}
class ProcSession implements SessionCache {
  constructor(
    private inner: MemorySession,
    private p: Proc,
  ) {}
  async get() {
    if (this.p.dead) throw new Dead();
    return this.inner.get();
  }
  async set(d: SessionData) {
    const land = this.p.hit();
    if (land) await this.inner.set(d);
    if (this.p.dead) throw new Dead();
  }
  async clear() {
    const land = this.p.hit();
    if (land) await this.inner.clear();
    if (this.p.dead) throw new Dead();
  }
  async lockEpoch() {
    return this.inner.lockEpoch();
  }
  async bumpLockEpoch() {
    return this.inner.bumpLockEpoch();
  }
  // the session quick unlock (QUICK-UNLOCK Stage 1): passed through, not a crash point; a dead process touches nothing
  async getQuick() {
    if (this.p.dead) throw new Dead();
    return this.inner.getQuick();
  }
  async setQuick(q: Parameters<SessionCache["setQuick"]>[0]) {
    if (this.p.dead) throw new Dead();
    return this.inner.setQuick(q);
  }
  async clearQuick() {
    if (this.p.dead) throw new Dead();
    return this.inner.clearQuick();
  }
}

const t = { now: 1_700_000_000_000 };
type World = { kv: MemoryKV; mirror: MemoryKV; session: MemorySession };
const storeOver = (kv: KV, mirror: KV, extra: { dayKey?: () => string } = {}) =>
  new VaultStore({ kv, mirror, lock: createMutex(), now: () => t.now, ...extra });
const svcOver = (w: World, kv: KV = w.kv, mirror: KV = w.mirror, session: SessionCache = w.session) =>
  new VaultService({
    store: storeOver(kv, mirror),
    session,
    settings: new KvSettingsStore(w.kv),
    now: () => t.now,
    kdfIterations: TEST_KDF_ITERATIONS,
  });
const clone = (w: World): World => {
  const c = (m: MemoryKV) => {
    const n = new MemoryKV();
    for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
    return n;
  };
  const session = new MemorySession();
  session.data = w.session.data ? { ...w.session.data } : null;
  session.epoch = w.session.epoch;
  return { kv: c(w.kv), mirror: c(w.mirror), session };
};
const daily = (w: World, day: string) => storeOver(w.kv, w.mirror, { dayKey: () => day }).ensureDailySnapshot();
const activeSlot = (kv: MemoryKV) => kv.data.get(KEYS.active) as "a" | "b";

type Base = {
  w: World;
  r1: string | null;
  pw: string | null;
  vault: Vault | null;
  keyring: Keyring | null;
  lost: boolean;
};
async function protectedBase(): Promise<Base> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
  const svc = svcOver(w);
  const { recoveryCode } = await createProtected(svc);
  for (const n of NAMES) {
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input(n), c).vault);
  }
  await daily(w, "2026-01-01");
  await svc.openView(); // the one-time check
  const g = (await checkGeneration(w.kv.data.get(KEYS.slot[activeSlot(w.kv)])))!;
  return { w, r1: recoveryCode, pw: STRONG, vault: (await svc.read()).vault, keyring: g.keyring, lost: false };
}
async function legacyBase(): Promise<Base> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
  await legacyDeviceVault(storeOver(w.kv, w.mirror));
  const svc = svcOver(w);
  for (const n of NAMES) {
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input(n), c).vault);
  }
  await daily(w, "2026-01-01");
  const g = (await checkGeneration(w.kv.data.get(KEYS.slot[activeSlot(w.kv)])))!;
  return { w, r1: null, pw: null, vault: (await svc.read()).vault, keyring: g.keyring, lost: false };
}
async function lostBase(): Promise<Base> {
  const b = await protectedBase();
  for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) b.w.kv.data.set(k, { torn: "x" });
  b.w.mirror.data.delete(KEYS.mirrorGen);
  b.w.session.data = null;
  expect((await svcOver(b.w).openView()).state).toBe("lost");
  return { ...b, lost: true };
}

/**
 * What reached the page: onCode sets `code` only while the process is alive. A process that has died runs no page code,
 * though in this model the service's JS goes on after a death (guarded() swallows it).
 */
type Shown = { code?: string; alive: () => boolean };
type Op = {
  name: string;
  base: () => Promise<Base>;
  /** Prepared outside the crashing process (writes nothing): keys for a restore, a reset the user then confirms. */
  prep?: (b: Base, svc: VaultService) => Promise<unknown>;
  run: (svc: VaultService, b: Base, prep: unknown, shown: Shown) => Promise<{ code?: string; pw?: string }>;
  /** The code was shown and confirmed before anything was written (A1's prepareKeys, A4's prepareReset). */
  confirmedBefore?: (prep: unknown) => string;
  /** What the user types during the operation (known whether or not it finished). */
  typed: string | null;
  /** Names expected after a completed run. */
  names: string[];
  lockFirst?: boolean;
};
const onCode = (shown: Shown) => ({
  onCode: (c: string) => {
    if (shown.alive()) shown.code = c;
  },
});
const OPS: Op[] = [
  {
    name: "enableMasterPassword",
    base: legacyBase,
    run: async (s, _b, _p, sh) => {
      await s.enableMasterPassword(STRONG, onCode(sh));
      return { ...(sh.code ? { code: sh.code } : {}), pw: STRONG };
    },
    typed: STRONG,
    names: NAMES,
  },
  {
    name: "rotateKey",
    base: protectedBase,
    run: async (s, _b, _p, sh) => {
      await s.rotateKey(STRONG, onCode(sh));
      return { ...(sh.code ? { code: sh.code } : {}), pw: STRONG };
    },
    typed: STRONG,
    names: NAMES,
  },
  {
    name: "changePassword",
    base: protectedBase,
    run: async (s) => {
      await s.changePassword(STRONG, STRONG2);
      return { pw: STRONG2 };
    },
    typed: STRONG2,
    names: NAMES,
  },
  {
    name: "reset in the settings tab (prepareReset, I saved it, commitReset)",
    base: protectedBase,
    lockFirst: true,
    prep: async (b, s) => s.prepareReset(b.r1!, STRONG2),
    run: async (s, _b, p) => {
      await s.commitReset(p as PreparedReset);
      return { code: (p as PreparedReset).recoveryCode, pw: STRONG2 };
    },
    confirmedBefore: (p) => (p as PreparedReset).recoveryCode,
    typed: STRONG2,
    names: NAMES,
  },
  {
    name: "newRecoveryCode",
    base: protectedBase,
    run: async (s, _b, _p, sh) => {
      await s.newRecoveryCode(STRONG, onCode(sh));
      return sh.code ? { code: sh.code } : {};
    },
    typed: null,
    names: NAMES,
  },
  {
    name: "purgeForever",
    base: protectedBase,
    run: async (s, b) => {
      await s.purgeForever([b.vault!.entries.find((e) => e.issuer === "AWS")!.id], STRONG);
      return {};
    },
    typed: null,
    names: ["GitHub", "Stripe"],
  },
  {
    name: "restoreBackup (over lost)",
    base: lostBase,
    prep: async (b, s) => s.prepareKeys(STRONG2, { vaultId: b.vault!.vaultId }),
    run: async (s, b, keys) => {
      await s.restoreBackup(b.vault!, keys as PreparedKeys);
      return { code: (keys as PreparedKeys).recoveryCode, pw: STRONG2 };
    },
    confirmedBefore: (keys) => (keys as PreparedKeys).recoveryCode,
    typed: STRONG2,
    names: NAMES,
  },
  {
    name: "startOver (over lost)",
    base: lostBase,
    prep: async (_b, s) => s.prepareKeys(STRONG2),
    run: async (s, _b, keys) => {
      await s.startOver(keys as PreparedKeys);
      return { code: (keys as PreparedKeys).recoveryCode, pw: STRONG2 };
    },
    confirmedBefore: (keys) => (keys as PreparedKeys).recoveryCode,
    typed: STRONG2,
    names: [],
  },
];

const pwMemo = new Map<string, boolean>();
async function opensWithPw(k: Keyring, pw: string): Promise<boolean> {
  const w = k.wraps.find((x) => x.method === "password");
  if (!w) return false;
  const key = canonicalJson(w) + pw;
  if (!pwMemo.has(key))
    pwMemo.set(
      key,
      await unlockWithPassword(k, pw).then(
        () => true,
        () => false,
      ),
    );
  return pwMemo.get(key)!;
}
const opensWithCode = (k: Keyring, c: string) =>
  unlockWithRecoveryCode(k, c).then(
    () => true,
    () => false,
  );

async function activeGen(kv: MemoryKV): Promise<Generation | null> {
  const p = kv.data.get(KEYS.active);
  return p === "a" || p === "b" ? checkGeneration(kv.data.get(KEYS.slot[p])) : null;
}

/**
 * What a finished cleanup would not leave, relative to the active generation: a slot, keyring copy or mirror generation
 * with another keyring (a superseded password or recovery wrap included: P-5), a snapshot under a previous key, a
 * snapshot of another vault under a key the keyring does not know, and device material next to a keyring without it.
 */
async function oldMaterial(w: World, g: Generation): Promise<string[]> {
  const out: string[] = [];
  const cur = canonicalJson(g.keyring);
  const prev = new Set(g.keyring.previous.map((p) => p.vkId));
  for (const [name, m] of [
    ["local", w.kv],
    ["mirror", w.mirror],
  ] as const) {
    for (const [k, v] of m.data) {
      if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen) {
        const x = await checkGeneration(v);
        if (x && canonicalJson(x.keyring) !== cur) out.push(`${name}:${k}`);
      } else if (k === KEYS.keyringCopy) {
        const x = checkKeyringCopy(v);
        if (x && canonicalJson(x.keyring) !== cur) out.push(`${name}:${k}`);
      } else if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex) {
        const r = await checkSnapshot(v);
        if (
          r &&
          r.envelope.vkId !== g.keyring.vkId &&
          (prev.has(r.envelope.vkId) || r.envelope.vaultId !== g.keyring.vaultId)
        )
          out.push(`${name}:${k}`);
      }
    }
  }
  if (!g.keyring.deviceKey)
    for (const [n, m] of [
      ["local", w.kv],
      ["mirror", w.mirror],
    ] as const)
      out.push(...deviceMaterial(m).map((x) => `${n}:${x}`));
  return out;
}

type Row = {
  op: string;
  at: number;
  mode: string;
  restart: boolean;
  died: boolean;
  outcome: string;
  opens: string[];
  names: string;
  triple: string;
  marker: string;
  leftover: boolean;
};
const rows: Row[] = [];
const NEVER_SHOWN = "COMMITTED, NEW CODE NEVER SHOWN";

describe.each(OPS.map((o) => [o.name, o] as const))("crash matrix: %s", (_n, op) => {
  it("every write, before and after it lands, with and without a browser restart", async () => {
    const base = await op.base();
    if (op.lockFirst) base.w.session.data = null;
    // count the writes of an uninterrupted run
    const count = clone(base.w);
    const pc = new Proc();
    const svcC = svcOver(
      count,
      new ProcKV(count.kv, pc),
      new ProcKV(count.mirror, pc),
      new ProcSession(count.session, pc),
    );
    const prepC = op.prep ? await op.prep(base, svcOver(count)) : undefined;
    await op.run(svcC, base, prepC, { alive: () => true });
    const total = pc.calls;
    rows.push({
      op: op.name,
      at: 0,
      mode: "count",
      restart: false,
      died: false,
      outcome: `writes=${total} commits@${pc.commits.join(",")}`,
      opens: [],
      names: "",
      triple: "",
      marker: "",
      leftover: false,
    });

    for (let at = 1; at <= total + 1; at++) {
      for (const mode of ["before", "after"] as const) {
        if (at === total + 1 && mode === "after") continue;
        for (const restart of [true, false]) {
          const w = clone(base.w);
          const p = new Proc(at, mode);
          const prep = op.prep ? await op.prep(base, svcOver(w)) : undefined;
          const shown: Shown = { alive: () => !p.dead };
          let result: { code?: string; pw?: string } | null = null;
          try {
            result = await op.run(
              svcOver(w, new ProcKV(w.kv, p), new ProcKV(w.mirror, p), new ProcSession(w.session, p)),
              base,
              prep,
              shown,
            );
          } catch (e) {
            if (!(e instanceof Dead)) throw e;
          }
          // A process that died showed only what reached the page before it died: the code handed over by onCode, or
          // one confirmed before the write. A return value after the death (guarded() let the function run on) counts not.
          const died = p.dead;
          if (died) result = null;
          const seen = result?.code ?? shown.code ?? (op.confirmedBefore ? op.confirmedBefore(prep) : undefined);
          if (restart) {
            w.session = new MemorySession();
            await storeOver(w.kv, w.mirror).selfCheck();
          }
          const where = `${op.name} @${at} ${mode} restart=${restart}`;
          // what every load() sees (a broken pointer slot goes down the recovery ladder, as the popup's open does)
          const lr = await storeOver(w.kv, w.mirror).load();
          const g = lr.status === "ok" ? lr.gen : null;
          const opens: string[] = [];
          let outcome: string;
          if (!g) {
            const st = (await svcOver(w).openView()).state;
            outcome = `no active generation (${st})`;
            if (op.name.includes("over lost")) expect(st, where).toBe("lost");
            else throw new Error(`${where}: no vault`);
          } else {
            if (g.keyring.deviceKey) opens.push("device");
            if (base.pw && (await opensWithPw(g.keyring, base.pw))) opens.push("old pw");
            if (op.typed && op.typed !== base.pw && (await opensWithPw(g.keyring, op.typed))) opens.push("typed pw");
            if (base.r1 && !base.lost && (await opensWithCode(g.keyring, base.r1))) opens.push("old code");
            if (seen && (await opensWithCode(g.keyring, seen))) opens.push("new code");
            const same = base.keyring && canonicalJson(g.keyring) === canonicalJson(base.keyring);
            if (!died) outcome = "completed";
            else if (same || op.name === "purgeForever") outcome = "rolled back / unchanged";
            else if (op.confirmedBefore) outcome = "landed (code confirmed before)";
            else if (seen) outcome = "committed, code shown";
            else if (op.name === "changePassword") outcome = "committed, not told";
            else outcome = base.r1 && !opens.includes("old code") ? `${NEVER_SHOWN}, OLD CODE DEAD` : NEVER_SHOWN;
            if (!died && result?.code) expect(opens, `${where}: a completed run's code opens`).toContain("new code");
            if (!died && result?.pw)
              expect(
                opens.includes("old pw") || opens.includes("typed pw"),
                `${where}: a completed run's password opens`,
              ).toBe(true);
            // A4 (GM2-1): a code the page was shown opens what is committed, whatever happened after it was shown.
            if (seen && !same && !(op.name === "purgeForever"))
              expect(opens, `${where}: the code shown opens the committed state`).toContain("new code");
            expect(opens.length, `${where}: some credential the user holds opens`).toBeGreaterThan(0);
          }
          // the marker promise, before anything cleans up
          let marker = "-";
          if (g) {
            const left = await oldMaterial(w, g);
            const r = await storeOver(w.kv, w.mirror).loadView();
            const due = r.status === "ok" ? r.cleanup : "n/a";
            marker = left.length ? `${left.length} old, cleanup ${due}` : `clean, cleanup ${due}`;
            if (left.some((x) => x.startsWith("local:"))) expect(due, `${where}: ${left.join(" ")}`).toBe("full");
            if (left.length) expect(due, `${where}: ${left.join(" ")}`).not.toBe("none");
          }
          // the triple, after a self-check
          let triple = "-";
          if (restart && g) {
            const c = checkKeyringCopy(w.kv.data.get(KEYS.keyringCopy));
            const m = await checkGeneration(w.mirror.data.get(KEYS.mirrorGen));
            const ok =
              c &&
              m &&
              canonicalJson(c.keyring) === canonicalJson(g.keyring) &&
              canonicalJson(m.keyring) === canonicalJson(g.keyring);
            triple = ok ? "ok" : "DIFFERS";
            expect(ok, `${where}: pointer slot / keyring copy / mirror`).toBe(true);
          }
          // every account, through whatever the user can open with; then the popup's cleanup runs
          let names = "";
          let leftover = false;
          if (g) {
            const s = svcOver(w);
            let v = await s.openView();
            if (v.state === "locked") {
              const pw = opens.includes("typed pw") ? op.typed! : base.pw!;
              v = (await s.unlockWithPassword(pw)).view;
            }
            if (v.state !== "unlocked") throw new Error(`${where}: ${v.state}`);
            names = aliveEntries(v.vault)
              .map((e) => e.issuer)
              .join(",");
            const expected =
              died && op.name === "purgeForever" ? null : died && outcome.startsWith("rolled") ? NAMES : op.names;
            if (expected) expect(names, where).toBe(expected.join(","));
            else expect([NAMES.join(","), op.names.join(",")], where).toContain(names);
            const g2 = (await activeGen(w.kv))!;
            const y = await checkGeneration(w.kv.data.get(KEYS.slot[activeSlot(w.kv) === "a" ? "b" : "a"]));
            leftover = !!y && canonicalJson(y.keyring) !== canonicalJson(g2.keyring);
            if (!g2.keyring.deviceKey)
              expect(deviceMaterial(w.kv, w.mirror), `${where}: device material after the cleanup`).toEqual([]);
            // P-5 closed and FIXa2's rejected keyring overwritten (GM2-2, GM2-3). The one exception: a device-key vault
            // whose upgrade never committed, seen without a restart (a device vault is not cleaned up on open, and only
            // selfCheck overwrites the rejected slot; its password keyring there holds no device key).
            if (leftover)
              expect(
                !restart && g2.keyring.deviceKey !== undefined,
                `${where}: the other slot still holds another keyring`,
              ).toBe(true);
          }
          rows.push({ op: op.name, at, mode, restart, died, outcome, opens, names, triple, marker, leftover });
        }
      }
    }
  }, 600_000);
});

describe("matrix summary", () => {
  it("writes the rows, and the window in which a committed code is never shown is only the commit's own writes (GM2-1(b))", () => {
    if (process.env.GM2_MATRIX_OUT) writeFileSync(process.env.GM2_MATRIX_OUT, JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
    // Never shown: died after the commit landed, before onCode. That is the pointer write landing (the commit) and the
    // guarded redundancy writes inside the transact (rolling snapshot, keyring copy, mirror generation) - at most 4 writes,
    // so at most 8 distinct crash points; the cleanup, the session and the log all come after the code is shown.
    for (const op of ["enableMasterPassword", "rotateKey", "newRecoveryCode"]) {
      const never = new Set(
        rows.filter((r) => r.op === op && r.outcome.startsWith(NEVER_SHOWN)).map((r) => `${r.at}${r.mode[0]}`),
      );
      expect(never.size, op).toBeGreaterThan(0); // the window exists (the matrix sees it) ...
      expect(never.size, op).toBeLessThanOrEqual(8); // ... and is the commit's own writes only
    }
    // the reset shows its code before anything is written: it is never committed unseen
    expect(
      rows.filter((r) => r.op.startsWith("reset in the settings tab") && r.outcome.startsWith(NEVER_SHOWN)),
    ).toEqual([]);
  });
});
