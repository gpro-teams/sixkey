// Review: turning on the master password is not crash-safe with respect to "no device key left on disk",
// and a failure after the commit loses the recovery code.
import { describe, expect, it } from "vitest";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { KEYS } from "../../src/core/storage/format";
import { legacyDeviceVault, NO_PAGE, codeOf } from "../helpers/vaults";

const STRONG = "tulip-orbit-lantern-84";
const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

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
async function world() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const settings = new KvSettingsStore(kv);
  const svc = new VaultService({
    store: new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }),
    session,
    settings,
    now: () => t.now,
  });
  await legacyDeviceVault(new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now })); // enable is the upgrade path for a Phase 0 device-key vault
  for (const n of ["GitHub", "AWS", "Stripe"]) {
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input(n), c).vault);
  }
  const deviceKey = (await svc.currentGeneration())!.keyring.deviceKey!;
  return { kv, mirror, session, settings, deviceKey };
}
const where = (m: MemoryKV, needle: string) =>
  [...m.data.entries()].filter(([, v]) => JSON.stringify(v).includes(needle)).map(([k]) => k);

describe("enableMasterPassword interrupted at any write", () => {
  it("never leaves the device key on disk once the user is told the password is on (session alive after the crash)", async () => {
    // count the writes of one enable
    const probe = await world();
    const pp = new Proc();
    await new VaultService({
      store: new VaultStore({
        lock: createMutex(),
        kv: new ProcKV(probe.kv, pp),
        mirror: new ProcKV(probe.mirror, pp),
        now: () => t.now,
      }),
      session: new ProcSession(probe.session, pp),
      settings: probe.settings,
      now: () => t.now,
    }).enableMasterPassword(STRONG, NO_PAGE);
    const total = pp.calls;
    expect(total).toBeGreaterThan(5);

    const residue: string[] = [];
    for (let at = 1; at <= total; at++) {
      for (const mode of ["before", "after"] as const) {
        const w = await world();
        const p = new Proc(at, mode);
        const svc = new VaultService({
          store: new VaultStore({
            lock: createMutex(),
            kv: new ProcKV(w.kv, p),
            mirror: new ProcKV(w.mirror, p),
            now: () => t.now,
          }),
          session: new ProcSession(w.session, p),
          settings: w.settings,
          now: () => t.now,
        });
        await svc.enableMasterPassword(STRONG, NO_PAGE).catch((e) => {
          if (!(e instanceof Dead)) throw e;
        });

        // "Restart" the page: chrome.storage.session survives a popup/options close, so a live session is still there.
        const store = new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now });
        const again = new VaultService({ store, session: w.session, settings: w.settings, now: () => t.now });
        const st = await again.status();
        if (st.state !== "unlocked" || !st.passwordProtected) continue; // the user still sees "no password": nothing was promised
        await again.read(); // popup open
        await store.ensureDailySnapshot(); // service worker wake-up: routine(false); selfCheck runs only onStartup/onInstalled
        const left = [
          ...where(w.kv, w.deviceKey).map((k) => `local:${k}`),
          ...where(w.mirror, w.deviceKey).map((k) => `mirror:${k}`),
        ];
        if (left.length) residue.push(`crash ${mode} write ${at}/${total}: device key still in ${left.join(", ")}`);
      }
    }
    expect(residue).toEqual([]);
  });
});

describe("a failure after the commit", () => {
  it("a mirror (IndexedDB) that rejects writes makes enableMasterPassword throw after the password is already on; the recovery code is lost", async () => {
    const kv = new MemoryKV();
    const mirror = new MemoryKV();
    const session = new MemorySession();
    const settings = new KvSettingsStore(kv);
    const svc = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }),
      session,
      settings,
      now: () => t.now,
    });
    await legacyDeviceVault(new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }));
    await svc.mutate((v, c) => addEntry(v, input("GitHub"), c).vault);
    // a daily snapshot exists in the mirror, as after any SW wake-up
    await new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }).ensureDailySnapshot();
    mirror.set = async () => {
      throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
    };

    let code: string | null = null;
    let error: unknown = null;
    try {
      code = await codeOf((d) => svc.enableMasterPassword(STRONG, d));
    } catch (e) {
      error = e;
    }
    const st = await svc.status();
    // What the user sees (Security.tsx): an error, no recovery code box. What is on disk: password protection is ON.
    expect({ threw: error !== null, protectedNow: st.state === "unlocked" && st.passwordProtected }).toEqual({
      threw: false,
      protectedNow: true,
    });
    expect(code).not.toBeNull();
  });
});

void KEYS;
