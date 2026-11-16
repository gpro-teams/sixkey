// PHASE0X-PLAN A3 (H6): the security log lives in the same chrome.storage.local as the vault and the key-change marker
// (sk_keychange), so a write of it that dies must not hurt either. The process model of test/fault/keychange-marker.test.ts:
// ONE process for local storage (vault, marker and log), the mirror and the session, dying at write N, just before or
// just after it lands; plus a torn write of the log itself. For every operation that records something:
//   1. The log write is a write of the log's key alone, after the commit (never inside a transact), and before the
//      key-change cleanup. (A4, docs/audit/internal-reviews/A4-REVIEW.md A4R-2: it was the operation's last write, after the cleanup; then a page
//      closed during the cleanup, with the new code already on screen, left the change unrecorded for good. A3-5 noted
//      that "last" was a property this test imposed, not one the protocol needs.)
//   2. At every crash point: the marker keeps its promise (anything old on disk means a cleanup is due), and the log
//      reads (as empty, if the write tore it) and holds the operation's entry only if that write landed.
//   3. After a restart, through the popup's path only (openView, unlock): every account is there, and the cleanup leaves
//      nothing old and no marker.
import { describe, expect, it } from "vitest";
import { checkGeneration, checkKeyringCopy, checkSnapshot, KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { SECURITY_LOG_KEY, SecurityLog, type SecurityKind } from "../../src/core/service/security-log";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { aliveEntries } from "../../src/core/vault/model";
import { createProtected, deviceMaterial, legacyDeviceVault, STRONG, NO_PAGE } from "../helpers/vaults";
import { tear } from "../helpers/faulty-kv";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";

const STRONG2 = "granite-river-compass-31";
const GUESS = "orchid-tram-velvet-77";
const NAMES = ["GitHub", "AWS", "Stripe"];
const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

// ---- the process model ---------------------------------------------------------------------------------------------------

class Dead extends Error {
  constructor() {
    super("process died");
    this.name = "Dead";
  }
}
type Mode = "before" | "after" | "torn";
class Proc {
  calls = 0;
  dead = false;
  constructor(
    public at = Infinity,
    public mode: Mode = "before",
  ) {}
  /** Whether this write lands (and how). Throws once the process is dead. */
  hit(): "land" | "skip" | "tear" {
    if (this.dead) throw new Dead();
    this.calls++;
    if (this.calls !== this.at) return "land";
    this.dead = true;
    return this.mode === "before" ? "skip" : this.mode === "after" ? "land" : "tear";
  }
}
/** One write as the probe saw it: its number in the process, which store, which keys. */
type Traced = { n: number; store: string; keys: string[] };
class ProcKV implements KV {
  constructor(
    private inner: MemoryKV,
    private p: Proc,
    private trace?: { store: string; out: Traced[] },
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
    const how = this.p.hit();
    this.trace?.out.push({ n: this.p.calls, store: this.trace.store, keys: Object.keys(items) });
    if (how === "land") await this.inner.set(items);
    if (how === "tear") {
      const [k0, v0] = Object.entries(items)[0]!;
      await this.inner.set({ ...items, [k0]: tear(v0) });
    }
    if (this.p.dead) throw new Dead();
  }
  async remove(keys: string[]) {
    const how = this.p.hit();
    this.trace?.out.push({ n: this.p.calls, store: this.trace.store, keys: keys.map((k) => `-${k}`) });
    if (how !== "skip") await this.inner.remove(keys);
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
    const how = this.p.hit();
    if (how !== "skip") await this.inner.set(d);
    if (this.p.dead) throw new Dead();
  }
  async clear() {
    const how = this.p.hit();
    if (how !== "skip") await this.inner.clear();
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

// ---- worlds --------------------------------------------------------------------------------------------------------------

const t = { now: 1_700_000_000_000 };
type World = { kv: MemoryKV; mirror: MemoryKV; session: MemorySession; code: string };
const svcOver = (w: World, kv: KV = w.kv, mirror: KV = w.mirror, session: SessionCache = w.session, logged = true) =>
  new VaultService({
    store: new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }),
    session,
    settings: new KvSettingsStore(w.kv),
    now: () => t.now,
    kdfIterations: TEST_KDF_ITERATIONS,
    ...(logged ? { security: new SecurityLog({ kv, now: () => t.now }) } : {}),
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
  return { kv: c(w.kv), mirror: c(w.mirror), session, code: w.code };
};
async function fill(w: World) {
  const svc = svcOver(w);
  for (const n of NAMES) {
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input(n), c).vault);
  }
  await new VaultStore({
    lock: createMutex(),
    kv: w.kv,
    mirror: w.mirror,
    now: () => t.now,
    dayKey: () => "2026-01-01",
  }).ensureDailySnapshot();
  expect((await svc.openView()).state).toBe("unlocked"); // the one-time check: the steady state
}
/** A password vault in its steady state, unlocked, with snapshots in both stores, and an empty security log. */
async function protectedWorld(): Promise<World> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession(), code: "" };
  w.code = (await createProtected(svcOver(w))).recoveryCode;
  await fill(w);
  return w;
}
async function lockedWorld(): Promise<World> {
  const w = await protectedWorld();
  await svcOver(w).lock();
  return w;
}
async function legacyWorld(): Promise<World> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession(), code: "" };
  await legacyDeviceVault(new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now }));
  await fill(w);
  return w;
}

// ---- what is on disk -----------------------------------------------------------------------------------------------------

/** The generation the pointer names, as it is on disk (no repair). */
async function activeOnDisk(kv: MemoryKV): Promise<Generation> {
  const g = await checkGeneration(kv.data.get(KEYS.slot[kv.data.get(KEYS.active) as "a" | "b"]));
  if (!g) throw new Error("no readable active generation");
  return g;
}
/** Copies a finished key change would not leave (as in keychange-marker.test.ts): another key, a stray device key, damage. */
async function oldMaterial(w: World): Promise<string[]> {
  const active = await activeOnDisk(w.kv);
  const out: string[] = [];
  const old = (k: { vkId: string; deviceKey?: string }) =>
    k.vkId !== active.keyring.vkId || (k.deviceKey !== undefined && active.keyring.deviceKey === undefined);
  const previous = new Set(active.keyring.previous.map((p) => p.vkId));
  for (const [name, m] of [
    ["local", w.kv],
    ["mirror", w.mirror],
  ] as const) {
    for (const [k, v] of m.data) {
      if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen) {
        const g = await checkGeneration(v);
        if (!g || old(g.keyring)) out.push(`${name}:${k}`);
      } else if (k === KEYS.keyringCopy) {
        const c = checkKeyringCopy(v);
        if (!c || old(c.keyring)) out.push(`${name}:${k}`);
      } else if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex) {
        const rec = await checkSnapshot(v);
        if (!rec || previous.has(rec.envelope.vkId)) out.push(`${name}:${k}`);
      }
    }
  }
  if (!active.keyring.deviceKey)
    out.push(...deviceMaterial(w.kv).map((x) => `local:${x}`), ...deviceMaterial(w.mirror).map((x) => `mirror:${x}`));
  return out;
}
async function cleanupDue(w: World): Promise<string> {
  const r = await new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now }).loadView();
  if (r.status !== "ok") throw new Error(r.status);
  return r.cleanup;
}
/** The popup after a restart: open; if locked, unlock with whichever password the committed state has. */
async function popupAfterRestart(w: World): Promise<string[]> {
  const svc = svcOver(w);
  let v = await svc.openView();
  if (v.state === "locked")
    v = (await svc.unlockWithPassword(STRONG).catch(() => svc.unlockWithPassword(STRONG2))).view;
  if (v.state !== "unlocked") throw new Error(v.state);
  return aliveEntries(v.vault).map((e) => e.issuer);
}
const logKinds = async (w: World) => (await new SecurityLog({ kv: w.kv }).read()).entries.map((e) => e.kind);

// ---- the operations ------------------------------------------------------------------------------------------------------

/** `writes`: at least this many writes in all (local, mirror, session), so the crash loop below stays meaningful. */
type Op = {
  name: string;
  world: () => Promise<World>;
  run: (s: VaultService, w: World) => Promise<unknown>;
  kind: SecurityKind;
  writes: number;
};
const OPS: Op[] = [
  {
    name: "rotating the key",
    world: protectedWorld,
    run: (s) => s.rotateKey(STRONG, NO_PAGE),
    kind: "key_rotated",
    writes: 15,
  },
  {
    name: "turning on the master password (Phase 0 vault)",
    world: legacyWorld,
    run: (s) => s.enableMasterPassword(STRONG, NO_PAGE),
    kind: "password_enabled",
    writes: 15,
  },
  {
    name: "changing the password",
    world: protectedWorld,
    run: (s) => s.changePassword(STRONG, STRONG2),
    kind: "password_changed",
    writes: 5,
  },
  // A4 (A4R-1, A4R-5): the reset is two steps, prepareReset (the code is accepted: recovery_used, nothing of the vault
  // written) and commitReset (password_reset). Each step is a row; the commit's is prepared by a page with no log first.
  {
    name: "accepting the recovery code for a reset (prepareReset)",
    world: lockedWorld,
    run: (s, w) => s.prepareReset(w.code, STRONG2),
    kind: "recovery_used",
    writes: 1,
  },
  {
    name: "resetting the password with the recovery code (commitReset)",
    world: lockedWorld,
    run: async (s, w) =>
      s.commitReset(await svcOver(w, w.kv, w.mirror, w.session, false).prepareReset(w.code, STRONG2)),
    kind: "password_reset",
    writes: 5,
  },
  {
    name: "a new recovery code",
    world: protectedWorld,
    run: (s) => s.newRecoveryCode(STRONG, NO_PAGE),
    kind: "recovery_code_new",
    writes: 4,
  },
  {
    name: "unlocking with the recovery code",
    world: lockedWorld,
    run: (s, w) => s.unlockWithRecoveryCode(w.code),
    kind: "recovery_used",
    writes: 2,
  },
  {
    name: "a wrong password at the lock screen",
    world: lockedWorld,
    run: (s) => s.unlockWithPassword(GUESS).catch(wrong),
    kind: "unlock_failed",
    writes: 1,
  },
  {
    name: "a wrong password for a key rotation",
    world: protectedWorld,
    run: (s) => s.rotateKey(GUESS, NO_PAGE).catch(wrong),
    kind: "unlock_failed",
    writes: 1,
  },
  {
    name: "a wrong recovery code for a reset",
    world: lockedWorld,
    run: (s) => s.prepareReset("0000-0000-0000-0000-0000-0000-00VM", STRONG2).catch(wrong),
    kind: "recovery_failed",
    writes: 1,
  },
  {
    name: "a wrong password before an export",
    world: protectedWorld,
    run: (s) => s.verifyPassword(GUESS).catch(wrong),
    kind: "unlock_failed",
    writes: 1,
  },
  { name: "an export", world: protectedWorld, run: (s) => s.recordExport("plain"), kind: "export_plain", writes: 1 },
  {
    name: "clearing the log with the master password",
    world: lockedWorld,
    run: (s) => s.clearSecurityLog(STRONG),
    kind: "log_cleared",
    writes: 1,
  },
];
/** The expected refusal of a wrong secret; a Dead goes on. */
function wrong(e: unknown): void {
  if ((e as { code?: string }).code !== "wrong_secret") throw e;
}

describe.each(OPS.map((o) => [o.name, o] as const))(
  "%s: the security log's write, and a crash at any write",
  (_name, op) => {
    it("writes the log alone, after the commit and before the cleanup; at every crash point the marker's promise holds, the log reads, and a restart cleans up", async () => {
      const base = await op.world();
      expect(base.kv.data.has(SECURITY_LOG_KEY)).toBe(false);

      // 1. the uninterrupted run, traced (local storage and the mirror; the session is not storage)
      const probe = clone(base);
      const pp = new Proc();
      const trace: Traced[] = [];
      await op.run(
        svcOver(
          probe,
          new ProcKV(probe.kv, pp, { store: "local", out: trace }),
          new ProcKV(probe.mirror, pp, { store: "mirror", out: trace }),
          new ProcSession(probe.session, pp),
        ),
        probe,
      );
      const logWrites = trace.filter((x) => x.keys.includes(SECURITY_LOG_KEY));
      expect(logWrites).toHaveLength(1);
      const logWrite = logWrites[0]!;
      expect(logWrite).toMatchObject({ store: "local", keys: [SECURITY_LOG_KEY] }); // nothing written with it
      // after the commit, never inside a transact: no pointer write after it ...
      const at = trace.indexOf(logWrite);
      const commit = trace.findIndex((x) => x.keys.includes(KEYS.active));
      if (commit >= 0) expect(at).toBeGreaterThan(commit);
      expect(trace.slice(at + 1).some((x) => x.keys.includes(KEYS.active))).toBe(false);
      // ... and before the cleanup that follows a key change (A4R-2): the marker goes only after it
      const markerGone = trace.findIndex((x) => x.keys.includes(`-${KEYS.keyChange}`));
      if (markerGone >= 0) expect(at).toBeLessThan(markerGone);
      expect(await logKinds(probe)).toEqual([op.kind]);
      expect(probe.kv.data.has(KEYS.keyChange)).toBe(false);
      const total = pp.calls;
      expect(total).toBeGreaterThanOrEqual(op.writes);

      const problems: string[] = [];
      for (let at = 1; at <= total; at++) {
        // a torn write is modelled for the log's own write only (the vault's slots are verified by reading them back)
        for (const mode of at === logWrite.n
          ? (["before", "after", "torn"] as const)
          : (["before", "after"] as const)) {
          const where = `crash ${mode} write ${at}/${total}`;
          const w = clone(base);
          const p = new Proc(at, mode);
          const kvBefore = JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY));
          await op
            .run(svcOver(w, new ProcKV(w.kv, p), new ProcKV(w.mirror, p), new ProcSession(w.session, p)), w)
            .catch((e) => {
              if (!(e instanceof Dead)) throw e;
            });
          expect(p.dead, where).toBe(true);

          // 2. at the moment of the crash: the marker's promise, and a log that reads
          const left = await oldMaterial(w);
          const due = await cleanupDue(w);
          if (left.some((x) => x.startsWith("local:")) && due !== "full")
            problems.push(`${where}: old material in this store but cleanup "${due}": ${left.join(", ")}`);
          if (left.length && due === "none")
            problems.push(`${where}: old material but no cleanup due: ${left.join(", ")}`);
          const kinds = await logKinds(w);
          const landedLogWrite = JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY)) !== kvBefore;
          if (kinds.length > 1 || (kinds.length === 1 && kinds[0] !== op.kind))
            problems.push(`${where}: log holds ${kinds.join(", ")}`);
          if (mode === "torn" && landedLogWrite && kinds.length !== 0)
            problems.push(`${where}: a torn log did not read as empty`);
          if (mode === "after" && landedLogWrite && kinds.length !== 1)
            problems.push(`${where}: the log write landed but its entry is missing`);

          // 3. restart, the popup's path only
          const names = await popupAfterRestart(w).catch((e) => {
            problems.push(`${where}: restart failed: ${String(e)}`);
            return null;
          });
          if (names === null) continue;
          if (names.join() !== NAMES.join()) problems.push(`${where}: accounts after restart: ${names.join(", ")}`);
          const after = await oldMaterial(w);
          if ((await activeOnDisk(w.kv)).keyring.deviceKey === undefined) {
            if (after.length) problems.push(`${where}: after the restart still on disk: ${after.join(", ")}`);
            if (w.kv.data.has(KEYS.keyChange)) problems.push(`${where}: marker still set after the restart`);
          }
          // and the log keeps working: the next entry is added
          await new SecurityLog({ kv: w.kv }).append("export_encrypted");
          if ((await logKinds(w))[0] !== "export_encrypted")
            problems.push(`${where}: the log took no new entry after the crash`);
        }
      }
      expect(problems).toEqual([]);
    }, 120_000);
  },
);
