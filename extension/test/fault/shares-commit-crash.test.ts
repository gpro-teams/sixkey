// Recovery code shares (docs/design/notes/SHAMIR-NOTES.md §4): the commit of "replace" (confirmShares) interrupted at
// every write, just before or just after it lands (the Proc model of test/regression/enable-crash.test.ts: one process
// for local storage, the mirror and the session). After a restart, whatever the crash point:
//   - the master password opens the vault, with every account;
//   - exactly one of the two recovery codes opens it, the old one or the shares' one, never neither (no order of writes
//     leaves a vault that no root opens);
//   - the old code is the one in force unless the commit's save landed;
//   - the shares reminder, in the same storage and written before the save (the review's N7), is there whenever the
//     commit is: no lost write keeps the commit and drops it. A reminder left by a commit that did not land is never
//     silent: a check of the switch's shares after the restart says that switch may not have completed.
import { describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { recoveryCodeFromShares } from "../../src/core/crypto/shares";
import { formatRecoveryCode } from "../../src/core/crypto/recovery-code";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { SECURITY_LOG_KEY, SecurityLog } from "../../src/core/service/security-log";
import { readNotice } from "../../src/popup/notice";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { aliveEntries } from "../../src/core/vault/model";
import { createProtected, STRONG } from "../helpers/vaults";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";
/** The recovery code rebuilt from share texts, as the pages and the service do it. */
const rebuild = (texts: readonly string[]) => recoveryCodeFromShares(texts, formatRecoveryCode);

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
  constructor(
    public at = Infinity,
    public mode: "before" | "after" = "before",
  ) {}
  hit(): boolean {
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
const service = (kv: KV, mirror: KV, session: SessionCache, settings: KvSettingsStore, security?: SecurityLog) =>
  new VaultService({
    store: new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }),
    session,
    settings,
    security,
    now: () => t.now,
    kdfIterations: TEST_KDF_ITERATIONS,
  });
/** The security record over `kv`: the same storage as the vault's (chrome.storage.local). */
const record = (kv: KV) => new SecurityLog({ kv, now: () => t.now });

/** A vault with three accounts and a prepared 2-of-3 "replace" set; the old code, and the shares asked for. */
async function world() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const settings = new KvSettingsStore(kv);
  const svc = service(kv, mirror, session, settings, record(kv));
  const { recoveryCode } = await createProtected(svc);
  for (const n of NAMES) {
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input(n), c).vault);
  }
  const prepared = await svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
  const typed = prepared.test.map((i) => prepared.shares[i]!);
  return { kv, mirror, session, settings, prepared, typed, old: recoveryCode, neu: await rebuild(typed) };
}
const opens = async (k: Keyring, code: string) => (await unlockWithRecoveryCode(k, code).catch(() => null)) !== null;

describe("confirmShares (replace) interrupted at any write", () => {
  it("after a restart the password opens every account, and exactly one recovery code opens the vault", async () => {
    const probe = await world();
    const pp = new Proc();
    const ppKv = new ProcKV(probe.kv, pp);
    await service(
      ppKv,
      new ProcKV(probe.mirror, pp),
      new ProcSession(probe.session, pp),
      probe.settings,
      record(ppKv),
    ).confirmShares(probe.prepared, probe.typed);
    const total = pp.calls;
    expect(total).toBeGreaterThan(3);

    const bad: string[] = [];
    let landedNew = 0;
    let keptOld = 0;
    let toldOld = 0;
    for (let at = 1; at <= total; at++) {
      for (const mode of ["before", "after"] as const) {
        const w = await world();
        const p = new Proc(at, mode);
        const pKv = new ProcKV(w.kv, p);
        await service(pKv, new ProcKV(w.mirror, p), new ProcSession(w.session, p), w.settings, record(pKv))
          .confirmShares(w.prepared, w.typed)
          .catch((e) => {
            if (!(e instanceof Dead)) throw e;
          });
        // a restart: a new service over what was written; the browser's session memory is gone
        const security = record(w.kv);
        const again = service(w.kv, w.mirror, new MemorySession(), w.settings, security);
        const reminded = Boolean((w.kv.data.get(SECURITY_LOG_KEY) as { remind?: unknown } | undefined)?.remind);
        await again.browserStarted();
        const st = await again.status();
        const where = `crash ${mode} write ${at}/${total}`;
        if (st.state !== "locked") {
          bad.push(`${where}: ${st.state}`);
          continue;
        }
        await again.unlockWithPassword(STRONG);
        const names = aliveEntries((await again.read()).vault).map((e) => e.issuer);
        if (names.join() !== NAMES.join()) bad.push(`${where}: accounts ${names.join()}`);
        const k = (await again.currentGeneration())!.keyring;
        if ((await unlockWithPassword(k, STRONG)).id !== k.vkId) bad.push(`${where}: the password`);
        const [o, n] = [await opens(k, w.old), await opens(k, w.neu)];
        if (o === n) bad.push(`${where}: old ${o}, new ${n}`);
        if (n) landedNew++;
        else keptOld++;
        // the commit kept, the reminder kept, and the popup shows it after this unlock
        if (n && !reminded) bad.push(`${where}: committed without its reminder`);
        if (n && (await readNotice({ security }).catch(() => null)) === null) bad.push(`${where}: no notice`);
        // a reminder of a commit that did not land: a check of the switch's shares says so
        if (!n && reminded) {
          toldOld++;
          if ((await again.checkRecoveryCode(w.neu, w.prepared.setId)) !== "stale_after_switch")
            bad.push(`${where}: not told`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(landedNew).toBeGreaterThan(0); // both outcomes happen across the crash points
    expect(keptOld).toBeGreaterThan(0);
    expect(toldOld).toBeGreaterThan(0); // and the reminder of a switch that was lost
  });
});
