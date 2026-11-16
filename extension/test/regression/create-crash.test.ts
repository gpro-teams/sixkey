// Regression (PHASE0X-PLAN A1, SYNC-DESIGN H1): making a vault, from nothing, from a backup or over unreadable data,
// interrupted at any write. After a restart only two outcomes are allowed:
//   - nothing was made (the welcome screen again, or the same unreadable data), or
//   - a vault that both the master password and the recovery code the user was shown can open, already carrying the
//     first-run answer (H5).
// And at no moment is there a device key or a device wrap anywhere on disk. The process model is enable-crash's.
import { describe, expect, it } from "vitest";
import { KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type PreparedKeys } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { allStored, deviceMaterial, STRONG } from "../helpers/vaults";

class Dead extends Error {
  constructor() {
    super("process died");
    this.name = "Dead";
  }
}

/** One "process": every write to any store (local, mirror, session) counts; at write N the process dies for all of them. */
class Proc {
  calls = 0;
  dead = false;
  constructor(
    public at = Infinity,
    public mode: "before" | "after" = "before",
  ) {}
  hit(): boolean {
    // returns true if this write should land
    if (this.dead) throw new Dead();
    this.calls++;
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
    const land = this.p.hit();
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
const BACKUP_ID = "backup-vault-id-1";
const backup = addEntry(
  emptyVault(BACKUP_ID),
  {
    type: "totp",
    issuer: "Bank",
    label: "me",
    secret: "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  },
  createClock("bbbb", { now: () => t.now }),
).vault;

type Scenario = {
  name: string;
  lost: boolean; // starts from unreadable data (no key material in it) instead of a fresh install
  prepare: (svc: VaultService) => Promise<PreparedKeys>;
  run: (svc: VaultService, keys: PreparedKeys) => Promise<void>;
  entries: number;
};
const SCENARIOS: Scenario[] = [
  {
    name: "create ('shared' answer)",
    lost: false,
    prepare: (s) => s.prepareKeys(STRONG),
    run: (s, k) => s.create(k, { preset: "shared" }),
    entries: 0,
  },
  {
    name: "restore a backup on a fresh install",
    lost: false,
    prepare: (s) => s.prepareKeys(STRONG, { vaultId: BACKUP_ID }),
    run: (s, k) => s.restoreBackup(backup, k, { preset: "shared" }),
    entries: 1,
  },
  {
    name: "restore a backup over unreadable data",
    lost: true,
    prepare: (s) => s.prepareKeys(STRONG, { vaultId: BACKUP_ID }),
    run: (s, k) => s.restoreBackup(backup, k, { preset: "shared" }),
    entries: 1,
  },
  {
    name: "start over",
    lost: true,
    prepare: (s) => s.prepareKeys(STRONG),
    run: (s, k) => s.startOver(k, { preset: "shared" }),
    entries: 0,
  },
];

function world(lost: boolean) {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  if (lost) {
    kv.data.set(KEYS.active, "a");
    kv.data.set(KEYS.slot.a, "garbage");
    kv.data.set(KEYS.slot.b, { torn: "half a write" });
  }
  return { kv, mirror, session: new MemorySession() };
}

function inProc(w: ReturnType<typeof world>, p: Proc) {
  const kv = new ProcKV(w.kv, p);
  return new VaultService({
    store: new VaultStore({ lock: createMutex(), kv, mirror: new ProcKV(w.mirror, p), now: () => t.now }),
    session: new ProcSession(w.session, p),
    settings: new KvSettingsStore(kv),
    now: () => t.now,
  });
}

/** How many writes one uninterrupted run makes; and that preparing the keys made none. */
async function writesOf(s: Scenario): Promise<number> {
  const w = world(s.lost);
  const p = new Proc();
  const svc = inProc(w, p);
  const keys = await s.prepare(svc);
  expect(p.calls).toBe(0);
  await s.run(svc, keys);
  return p.calls;
}
const TOTALS = await Promise.all(SCENARIOS.map(writesOf));

describe.each(SCENARIOS.map((s, i) => [s.name, s, TOTALS[i]!] as const))(
  "%s, interrupted at any write",
  (_name, s, total) => {
    it("makes several writes, all counted", () => {
      expect(total).toBeGreaterThanOrEqual(6); // settings, slot, pointer, snapshot, keyring copy, mirror, session
    });
    const points = Array.from({ length: total }, (_, k) => k + 1).flatMap((at) =>
      (["before", "after"] as const).map((mode) => [at, mode] as const),
    );
    it.each(points)("write %i, dying %s it lands", async (at, mode) => {
      const w = world(s.lost);
      const p = new Proc(at, mode);
      const svc = inProc(w, p);
      const keys = await s.prepare(svc);
      await s.run(svc, keys).catch((e) => {
        if (!(e instanceof Dead)) throw e;
      });
      expect(p.dead).toBe(true);
      // on disk at the moment of the crash
      expect(deviceMaterial(w.kv, w.mirror)).toEqual([]);
      expect(allStored(w.kv) + allStored(w.mirror)).not.toContain("deviceKey");

      // Restart: the page is gone, and with it any key it held in memory. The browser may have restarted too.
      const store = new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now });
      await store.selfCheck(); // service worker onStartup
      const settings = new KvSettingsStore(w.kv);
      const again = new VaultService({ store, session: new MemorySession(), settings, now: () => t.now });
      const st = await again.status();
      if (st.state === "empty" || st.state === "lost") {
        expect(st.state).toBe(s.lost ? "lost" : "empty"); // nothing was made
      } else {
        expect(st.state).toBe("locked"); // never "unlocked" by itself: there is no device key to open it with
        expect((await settings.get()).autoLock).toEqual({ mode: "always" }); // the answer is never missing from a vault that exists
        await expect(again.unlockWithPassword("not the password at all")).rejects.toMatchObject({
          code: "wrong_secret",
        });
        await again.unlockWithPassword(STRONG);
        expect(aliveEntries((await again.read()).vault)).toHaveLength(s.entries);
        await again.lock();
        await again.unlockWithRecoveryCode(keys.recoveryCode);
        expect(aliveEntries((await again.read()).vault)).toHaveLength(s.entries);
        expect((await again.currentGeneration())!.keyring.vaultId).toBe(keys.vaultId);
      }
      await store.ensureDailySnapshot();
      expect(deviceMaterial(w.kv, w.mirror)).toEqual([]);
    });
  },
);
