// The M2 crash matrices' machinery (test/fault/m2-crash-matrix.test.ts, m2-crash-double.test.ts; the style of
// gm2-crash-matrix.test.ts, extended with the review's lying disk and double fault, docs/audit/internal-reviews/M2-REVIEW.md Appendix C): one
// process for chrome.storage.local, the IndexedDB mirror, the IndexedDB identity and the session dies at write N of an
// operation, just before or just after the write lands, or the disk acknowledges write N and drops it ("lie", A4R-10)
// and the process goes on; then the browser restarts (session cleared, selfCheck), possibly dying again at write M of
// that restart's own selfCheck, open and unlock (the double fault), or does not; then the user unlocks.
// Operations: applyRemote; commitKeys for a same-VK adoption (a new recovery code), an R3 adoption of a rotation with the
// remote's data merged, a cloud restore over lost data, and this device's own published new recovery code and rotation
// (each with the keys M1 issued, §0.0i item 16; the two Published ones from docs/audit/internal-reviews/M2-REREVIEW.md); commitJoin in added
// mode, also over a profile that kept a vault from an earlier join.
// Invariants, at every point (every one is checked and recorded per row; `check` then fails the row):
//   - atomic: the vault is the state before or the state after (accounts and keyring), never a mix; some secret the user
//     holds opens it; a completed run gives the state after;
//   - the pins are never ahead of what is committed (§2.5 write order): if the identity names the new adopted digest, the
//     committed keyring is the new one;
//   - the pins are never behind it once settled (§0.0i item 17, M2R-1): whenever the new keys are committed, settlePins()
//     leaves the identity's adopted the new bundle's;
//   - the next round is a full pull (§4.1): whenever new keys or a join are committed, lastSynced is null;
//   - applyRemote: whenever the merge is committed, the state it replaced is a rolling snapshot (F11);
//   - the join: whenever it is committed in added mode, sk_prejoin's list holds the old vault under the cloud key; a vault
//     an earlier join kept there is never lost (as stored, or moved to the new key with the same plaintext), on a lying
//     disk too;
//   - the marker's promise, checked before anything cleans up: a copy with another keyring, or a snapshot under a previous
//     key or of another vault, means a cleanup is due ("full" when it is in this store); after the next open or unlock,
//     the old key's copies and the old records are gone (or kept on purpose: another vault's, by D9).
// A lying disk is the A4R-10 class: nothing re-reads most writes, so some promises cannot hold there. Those rows may break
// only the RESIDUAL ones below (never atomicity, a secret that opens, the open itself, the join's sk_prejoin, which is
// read back since M2R-14, or the pins after the settle: their IndexedDB write is read back since RR-7).
import { expect } from "vitest";
import { decryptVault, encryptVault } from "../../src/core/crypto/envelope";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { checkGeneration, checkKeyringCopy, checkSnapshot, KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { SyncFlows, type PreparedJoin } from "../../src/core/service/sync-flows";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { adoptedRecord, type KeyBundle } from "../../src/core/sync/crypto/keybundle";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { parsePrejoin, prejoinItems } from "../../src/core/sync/local/records";
import { createSyncPort } from "../../src/core/sync/local/port";
import { SyncLocal } from "../../src/core/sync/local/sync-local";
import { canonicalJson } from "../../src/core/vault/merge";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import { STRONG } from "./vaults";
import {
  adoptByUnlock,
  adoptSameVk,
  bundleFor,
  input,
  m2World,
  newCode,
  newIdentity,
  publishedOf,
  rotated,
  secretOf,
  steadyState,
  vaultWith,
} from "./m2-world";
import { TEST_KDF_ITERATIONS } from "./kdf";

export class Dead extends Error {
  constructor() {
    super("process died");
    this.name = "Dead";
  }
}
export type Mode = "before" | "after" | "lie";
class Proc {
  calls = 0;
  dead = false;
  constructor(
    public at = Infinity,
    public mode: Mode = "before",
  ) {}
  hit(): boolean {
    if (this.dead) throw new Dead();
    this.calls++;
    if (this.calls === this.at) {
      if (this.mode === "lie") return false; // acknowledged, never written; the process goes on
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

type Disk = { kv: MemoryKV; mirror: MemoryKV; idb: MemoryKV; session: MemorySession };
const t = { now: 1_700_000_000_000 };
const clone = (d: Disk): Disk => {
  const c = (m: MemoryKV) => {
    const n = new MemoryKV();
    for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
    return n;
  };
  const session = new MemorySession();
  session.data = d.session.data ? { ...d.session.data } : null;
  session.epoch = d.session.epoch;
  return { kv: c(d.kv), mirror: c(d.mirror), idb: c(d.idb), session };
};
/** The wiring of one context over (possibly dying) storage: the store, the light port, the service, the local side, the flows. */
function contextOver(
  d: Disk,
  kv: KV = d.kv,
  mirror: KV = d.mirror,
  idb: KV = d.idb,
  session: SessionCache = d.session,
) {
  const lock = createMutex();
  const port = createSyncPort({ local: kv, vaultLock: lock });
  const store = new VaultStore({
    kv,
    mirror,
    lock,
    now: () => t.now,
    beforeRecoveryWrite: () => port.clearLastSynced(),
  });
  const svc = new VaultService({
    store,
    session,
    settings: new KvSettingsStore(kv),
    now: () => t.now,
    vkRecords: port.records,
    sync: port,
    kdfIterations: TEST_KDF_ITERATIONS,
  });
  const local = new SyncLocal({ local: kv, identity: idb, vaultLock: lock, identityLock: createMutex() });
  return { store, svc, local, flows: new SyncFlows(svc, local) };
}
type Context = ReturnType<typeof contextOver>;
const dying = (d: Disk, p: Proc) =>
  contextOver(d, new ProcKV(d.kv, p), new ProcKV(d.mirror, p), new ProcKV(d.idb, p), new ProcSession(d.session, p));

type Before = { disk: Disk; names: string[]; keyring: Keyring; pw: string; code: string; vk: Vk };
/**
 * `earlier`: a vault an earlier join kept on sk_prejoin's list (stored as `item`, of `vaultId`, its plaintext `plain`):
 * it must be there in every row, as stored or moved to one of `vks` with the same plaintext.
 */
type Plan = {
  names: string[];
  keyring: Keyring;
  bundle?: KeyBundle;
  join?: "added" | "empty";
  snapshotOf?: string;
  pinned: boolean;
  earlier?: { item: unknown; vaultId: string; plain: Uint8Array; vks: Vk[] };
};
export type Op = {
  name: string;
  build: () => Promise<{
    before: Before;
    run: (c: Context, prep: unknown) => Promise<void>;
    prep?: (c: Context) => Promise<unknown>;
    plan: Plan;
    typed: { pw: string; code?: string } | null;
    lostBefore?: boolean;
  }>;
};

/** Enrolled, in sync at kver 3 (the local keyring is the bundle's, pinned with adopted = it), lastSynced set, the real copy. */
async function enrolledBase(names = ["GitHub", "AWS"]) {
  const w = m2World();
  const { recoveryCode } = await vaultWith(w, names, { syncOn: true });
  const st = await steadyState(w, 3);
  w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 5, head: "h", checksum: "c" } });
  await w.local().cfg.write(st.vk, {
    deviceId: st.identity.deviceId,
    apiOrigin: st.identity.apiOrigin,
    dsk: st.jwk,
    email: "me@example.com",
  }); // the real copy (§2.5)
  const g = await w.active();
  const facts = {
    maxSeenKver: 3,
    expectedVaultId: st.vaultId,
    adoptedAuth: st.bundle.auth,
    adoptedDigest: st.identity.adopted!.digest,
    pinnedVkId: st.vk.id,
  };
  return {
    w,
    st,
    facts,
    before: {
      disk: { kv: w.kv, mirror: w.mirror, idb: w.idb, session: w.session },
      names,
      keyring: g.keyring,
      pw: STRONG,
      code: recoveryCode,
      vk: st.vk,
    } as Before,
  };
}
const remoteWith = async (w: ReturnType<typeof m2World>, extra: string): Promise<Vault> => {
  const v = deserializeVault(await decryptVault((await w.active()).envelope, await w.sessionVk()));
  const c = createClock("bbbb", { now: () => t.now + 1000 });
  for (const e of v.entries) c.observe(e.hlc);
  return addEntry(v, input(extra, secretOf(extra)), c).vault;
};

export const OPS: Op[] = [
  {
    name: "applyRemote",
    build: async () => {
      const { w, before } = await enrolledBase();
      const remote = await remoteWith(w, "Remote");
      return {
        before,
        run: async (c) => {
          await c.flows.applyRemote(remote);
        },
        plan: {
          names: [...before.names, "Remote"],
          keyring: before.keyring,
          snapshotOf: (await w.active()).envelope.checksum,
          pinned: false,
        },
        typed: null,
      };
    },
  },
  {
    name: "commitKeys: same VK, a new recovery code (R2)",
    build: async () => {
      const { st, facts, before } = await enrolledBase();
      const r = await newCode(before.keyring, before.vk);
      const bundle = await bundleFor(before.vk, r.keyring, 8, st.bundle.auth);
      const keys = await adoptSameVk({ ...facts, bundle, vk: before.vk, local: before.keyring });
      return {
        before,
        run: async (c) => {
          await c.flows.commitKeys({ keys, record: "keys_adopted" });
        },
        plan: { names: before.names, keyring: bundle.keyring, bundle, pinned: true },
        typed: { pw: STRONG, code: r.recoveryCode },
      };
    },
  },
  {
    name: "commitKeys: another VK with the remote's data (R3)",
    build: async () => {
      const { w, facts, before } = await enrolledBase();
      const r = await rotated(before.keyring, before.vk);
      const bundle = await bundleFor(r.vk, r.keyring, 9);
      const remote = await remoteWith(w, "Remote");
      const keys = await adoptByUnlock({
        ...facts,
        secret: { password: STRONG },
        local: before.keyring,
        remote: bundle,
        needsPassword: true,
      });
      return {
        before,
        run: async (c) => {
          await c.flows.commitKeys({ keys, remote, record: "keys_adopted" });
        },
        plan: { names: [...before.names, "Remote"], keyring: bundle.keyring, bundle, pinned: true },
        typed: { pw: STRONG, code: r.recoveryCode },
      };
    },
  },
  {
    name: "commitKeys: cloud restore over lost data (§4.13)",
    build: async () => {
      const { w, st, facts, before } = await enrolledBase();
      const remote = deserializeVault(await decryptVault((await w.active()).envelope, before.vk));
      // the server holds a later key state of this account (a new recovery code made elsewhere)
      const r = await newCode(before.keyring, before.vk);
      const bundle = await bundleFor(before.vk, r.keyring, 7, st.bundle.auth);
      const keys = await adoptByUnlock({
        ...facts,
        secret: { password: STRONG },
        local: null,
        remote: bundle,
        needsPassword: false,
      });
      for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) w.kv.data.set(k, { torn: "x" });
      w.mirror.data.clear();
      for (const k of [...w.kv.data.keys()].filter((x) => x.startsWith("sk_snap_"))) w.kv.data.delete(k);
      w.session.data = null;
      return {
        before,
        run: async (c) => {
          await c.flows.commitKeys({ keys, remote, overLost: true });
        },
        plan: { names: before.names, keyring: bundle.keyring, bundle, pinned: true },
        typed: { pw: STRONG, code: r.recoveryCode },
        lostBefore: true,
      };
    },
  },
  {
    name: "commitKeys: Published, this device's own new recovery code (built_here)",
    build: async () => {
      const { st, before } = await enrolledBase();
      const r = await newCode(before.keyring, before.vk);
      const bundle = await bundleFor(before.vk, r.keyring, 4, st.bundle.auth);
      const keys = await publishedOf({
        server: st.bundle,
        local: before.keyring,
        vk: before.vk,
        op: "change_recovery",
        sent: bundle,
        sentVk: before.vk,
        sentSecret: { recoveryCode: r.recoveryCode },
      });
      return {
        before,
        run: async (c) => {
          await c.flows.commitKeys({ keys, record: "recovery_code_new" });
        },
        plan: { names: before.names, keyring: bundle.keyring, bundle, pinned: true },
        typed: { pw: STRONG, code: r.recoveryCode },
      };
    },
  },
  {
    name: "commitKeys: Published rotation (§3.8 P4)",
    build: async () => {
      const { st, before } = await enrolledBase();
      const r = await rotated(before.keyring, before.vk);
      const bundle = await bundleFor(r.vk, r.keyring, 4);
      const keys = await publishedOf({
        server: st.bundle,
        local: before.keyring,
        vk: before.vk,
        op: "rotate",
        sent: bundle,
        sentVk: r.vk,
        sentSecret: { recoveryCode: r.recoveryCode },
      });
      return {
        before,
        run: async (c) => {
          await c.flows.commitKeys({ keys, record: "key_rotated" });
        },
        plan: { names: before.names, keyring: bundle.keyring, bundle, pinned: true },
        typed: { pw: STRONG, code: r.recoveryCode },
      };
    },
  },
  {
    name: "commitJoin: added mode (this profile's own vault)",
    build: async () => {
      // a profile with its own vault, sync off; the new device identity made for the join (§3.2: pending, no pins yet)
      const w = m2World();
      const names = ["Mine1", "Mine2"];
      const { recoveryCode } = await vaultWith(w, names);
      await w.svc().openView();
      const g = await w.active();
      const before: Before = {
        disk: { kv: w.kv, mirror: w.mirror, idb: w.idb, session: w.session },
        names,
        keyring: g.keyring,
        pw: STRONG,
        code: recoveryCode,
        vk: await w.sessionVk(),
      };
      const { id, jwk } = await newIdentity();
      await w.local().identity.put(id);
      const cw = m2World();
      await vaultWith(cw, ["Cloud"]);
      const vk = await cw.sessionVk();
      const kr = (await cw.active()).keyring;
      const remote = deserializeVault(await decryptVault((await cw.active()).envelope, vk));
      const bundle = await bundleFor(vk, kr, 4);
      const device = { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" };
      return {
        before,
        prep: (c) => c.flows.prepareJoin({ bundle, vk, remote, device }),
        run: async (c, p) => {
          await c.flows.commitJoin(p as PreparedJoin);
        },
        plan: { names: ["Cloud", "Mine1", "Mine2"], keyring: bundle.keyring, bundle, join: "added", pinned: true },
        typed: { pw: STRONG },
      };
    },
  },
  {
    name: "commitJoin: added mode over a profile that kept a vault from an earlier join",
    build: async () => {
      // as above, and sk_prejoin already holds the vault an earlier join kept (a single record, as stored before the list),
      // under this profile's key (the earlier join's cloud key, which is this profile's since): appended to, never replaced
      const w = m2World();
      const names = ["Mine1", "Mine2"];
      const { recoveryCode } = await vaultWith(w, names);
      await w.svc().openView();
      const g = await w.active();
      const localVk = await w.sessionVk();
      const plain = new TextEncoder().encode('{"the":"earlier join\'s own vault"}');
      const item = {
        v: 1,
        at: 1,
        envelope: await encryptVault(plain, localVk, { vaultId: "earlier-vault-01", rev: 0 }),
      };
      w.kv.data.set(SYNC_KEYS.prejoin, structuredClone(item));
      const before: Before = {
        disk: { kv: w.kv, mirror: w.mirror, idb: w.idb, session: w.session },
        names,
        keyring: g.keyring,
        pw: STRONG,
        code: recoveryCode,
        vk: localVk,
      };
      const { id, jwk } = await newIdentity();
      await w.local().identity.put(id);
      const cw = m2World();
      await vaultWith(cw, ["Cloud"]);
      const vk = await cw.sessionVk();
      const kr = (await cw.active()).keyring;
      const remote = deserializeVault(await decryptVault((await cw.active()).envelope, vk));
      const bundle = await bundleFor(vk, kr, 4);
      const device = { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" };
      return {
        before,
        prep: (c) => c.flows.prepareJoin({ bundle, vk, remote, device }),
        run: async (c, p) => {
          await c.flows.commitJoin(p as PreparedJoin);
        },
        plan: {
          names: ["Cloud", "Mine1", "Mine2"],
          keyring: bundle.keyring,
          bundle,
          join: "added",
          pinned: true,
          earlier: { item, vaultId: "earlier-vault-01", plain, vks: [localVk, vk] },
        },
        typed: { pw: STRONG },
      };
    },
  },
];

/** sk_prejoin's entries as stored (records.ts prejoinItems), parsed. */
const keptOn = (d: Disk) =>
  (prejoinItems(d.kv.data.get(SYNC_KEYS.prejoin)) ?? []).map((x) => ({ raw: x, p: parsePrejoin(x) }));

async function activeGen(kv: MemoryKV): Promise<Generation | null> {
  const p = kv.data.get(KEYS.active);
  return p === "a" || p === "b" ? checkGeneration(kv.data.get(KEYS.slot[p])) : null;
}
const opensPw = (k: Keyring, pw: string) =>
  unlockWithPassword(k, pw).then(
    () => true,
    () => false,
  );
const opensCode = (k: Keyring, c: string) =>
  unlockWithRecoveryCode(k, c).then(
    () => true,
    () => false,
  );

/** What a lying disk may break (the A4R-10 residual), by the violation's first words. Everything else holds there too. */
export const LIE_RESIDUAL = [
  "a completed run did not commit", // the pointer write dropped: the run reports success, the old state stays (GM2-5's shape)
  "pins ahead of the commit", // the same: the pins written for a commit that is not there (D8's second direction)
  "lastSynced survived the commit", // the clearing write dropped
  "old material without a marker", // the marker write dropped
  "local old material, marker not full",
  "no snapshot of the state replaced", // ensureCurrentSnapshot's write dropped
  "after open:", // a cleanup rewrite dropped (a copy or a record still under the old key)
  "the marker outlived the cleanup",
  "load:", // a restore over lost data whose write was dropped: still lost
];

/** `rawBehind`: the commit landed and the identity as stored did not get its pins (the D8 window, which the settle closes). */
export type Row = {
  op: string;
  at: number;
  mode: Mode;
  restart: boolean | number;
  violations: string[];
  opError?: string;
  state?: "new" | "old";
  rawBehind?: boolean;
};

/**
 * Every crash point of `op` in `modes`, each with every restart variant in `restarts` (true: a browser restart; false:
 * none; a number n: a restart whose own selfCheck, open and unlock die at their write n). Returns the rows.
 */
export async function matrix(op: Op, modes: readonly Mode[], restarts: readonly (boolean | number)[]): Promise<Row[]> {
  const built = await op.build();
  const base = built.before.disk;
  // count an uninterrupted run
  const cd = clone(base);
  const pc = new Proc();
  const prepC = built.prep ? await built.prep(contextOver(cd)) : undefined;
  await built.run(dying(cd, pc), prepC);
  const total = pc.calls;
  expect(total).toBeGreaterThan(3);
  const after = built.plan;
  const rows: Row[] = [];
  for (let at = 1; at <= total + 1; at++) {
    for (const mode of modes) {
      if (at === total + 1 && mode !== "before") continue;
      for (const restart of restarts) {
        const d = clone(base);
        const p = new Proc(at, mode);
        const row: Row = { op: op.name, at, mode, restart, violations: [] };
        rows.push(row);
        const prep = built.prep ? await built.prep(contextOver(d)) : undefined;
        try {
          await built.run(dying(d, p), prep);
        } catch (e) {
          if (!(e instanceof Dead)) {
            if (mode !== "lie") throw e;
            row.opError = String(e).slice(0, 120); // a write the disk dropped that was read back: reported, nothing worse
          }
        }
        await checkRow(built, after, d, p, row, restart);
      }
    }
  }
  return rows;
}

async function checkRow(
  built: Awaited<ReturnType<Op["build"]>>,
  after: Plan,
  d: Disk,
  p: Proc,
  row: Row,
  restart: boolean | number,
): Promise<void> {
  const soft = (ok: boolean, what: string) => {
    if (!ok) row.violations.push(what);
    return ok;
  };
  if (restart !== false) {
    d.session = new MemorySession();
    if (typeof restart === "number") {
      // the double fault: the restart's own selfCheck and open die at their write number `restart`
      const p2 = new Proc(restart, "before");
      const c2 = dying(d, p2);
      try {
        await c2.store.selfCheck();
        const v = await c2.svc.openView();
        if (v.state === "locked") await c2.svc.unlockWithPassword(built.before.pw).catch(() => undefined);
      } catch (e) {
        if (!(e instanceof Dead)) soft(false, `restart: ${String(e).slice(0, 80)}`);
      }
      d.session = new MemorySession();
    }
    await contextOver(d).store.selfCheck();
  }
  const lr = await contextOver(d).store.load();
  if (lr.status !== "ok") {
    soft(!!built.lostBefore && (p.dead || row.mode === "lie") && lr.status === "lost", `load: ${lr.status}`); // the restore died before its commit
    return;
  }
  const g = lr.gen;
  const isNew = canonicalJson(g.keyring) === canonicalJson(after.keyring);
  const isOld = canonicalJson(g.keyring) === canonicalJson(built.before.keyring);
  soft(isNew || isOld, "a third keyring");
  if (!p.dead && row.mode !== "lie") soft(isNew, "a completed run did not commit");
  if (!p.dead && row.mode === "lie" && row.opError === undefined) soft(isNew, "a completed run did not commit");
  row.state = isNew ? "new" : "old";
  // some secret the user holds opens it
  const typed = built.typed;
  const opens =
    (await opensPw(g.keyring, built.before.pw)) ||
    (typed !== null &&
      ((await opensPw(g.keyring, typed.pw)) || (typed.code !== undefined && (await opensCode(g.keyring, typed.code)))));
  if (!soft(opens, "nothing the user holds opens it")) return;
  // the pins are never ahead of the commit (as stored, before anything settles them)
  const ctx0 = contextOver(d);
  const newDigest = after.bundle ? (await adoptedRecord(after.bundle)).digest : null;
  const raw = await ctx0.local.identity.get();
  const pinnedNew = (x: typeof raw) =>
    !!(after.pinned && newDigest && x && x !== "damaged" && x.adopted?.digest === newDigest);
  if (pinnedNew(raw)) soft(isNew, "pins ahead of the commit");
  if (after.pinned && newDigest && isNew && !isOld && raw && raw !== "damaged" && !pinnedNew(raw)) row.rawBehind = true;
  // ... and never behind it once settled (§0.0i item 17)
  const settled = await ctx0.local.settlePins();
  if (pinnedNew(settled)) soft(isNew, "pins ahead of the commit (settled)");
  if (after.pinned && newDigest && isNew && !isOld && settled && settled !== "damaged")
    soft(pinnedNew(settled), "pins behind after the settle");
  // a committed key change or join means a full pull next
  const st = d.kv.data.get(SYNC_KEYS.state) as { lastSynced: unknown } | undefined;
  if (after.pinned && isNew && !isOld) soft((st?.lastSynced ?? null) === null, "lastSynced survived the commit");
  // the join's local vault, on sk_prejoin's list, whenever the join is committed in added mode
  if (after.join === "added" && isNew)
    soft(
      keptOn(d).some((k) => k.p !== "damaged" && k.p.envelope.vaultId === built.before.keyring.vaultId),
      "no sk_prejoin",
    );
  // the vault an earlier join kept: there in every row (a lying disk included), as stored or moved with the same plaintext
  if (after.earlier) {
    const e = after.earlier;
    let found = false;
    for (const k of keptOn(d)) {
      if (k.p === "damaged" || k.p.envelope.vaultId !== e.vaultId) continue;
      if (canonicalJson(k.raw) === canonicalJson(e.item)) found = true;
      const env = k.p.envelope;
      const key = e.vks.find((v) => v.id === env.vkId);
      const plain = key ? await decryptVault(env, key).catch(() => null) : null;
      if (plain && plain.length === e.plain.length && plain.every((b, i) => b === e.plain[i])) found = true;
    }
    soft(found, "the earlier kept vault lost");
  }
  // the marker's promise, before anything cleans up: old material on disk means a cleanup is due ("full" if local)
  const left: string[] = [];
  const cur = canonicalJson(g.keyring);
  const prev = new Set(g.keyring.previous.map((x) => x.vkId));
  for (const [name, m] of [
    ["local", d.kv],
    ["mirror", d.mirror],
  ] as const) {
    for (const [k, x] of m.data) {
      if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen) {
        const y = await checkGeneration(x);
        if (y && canonicalJson(y.keyring) !== cur) left.push(`${name}:${k}`);
      } else if (k === KEYS.keyringCopy) {
        const y = checkKeyringCopy(x);
        if (y && canonicalJson(y.keyring) !== cur) left.push(`${name}:${k}`);
      } else if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex) {
        const r = await checkSnapshot(x);
        if (
          r &&
          r.envelope.vkId !== g.keyring.vkId &&
          (prev.has(r.envelope.vkId) || r.envelope.vaultId !== g.keyring.vaultId)
        )
          left.push(`${name}:${k}`);
      }
    }
  }
  if (left.length) {
    const lv = await contextOver(d).store.loadView();
    const due = lv.status === "ok" ? lv.cleanup : "n/a";
    soft(due !== "none", `old material without a marker: ${left.join(" ")}`);
    if (left.some((x) => x.startsWith("local:")))
      soft(due === "full", `local old material, marker not full: ${left.join(" ")}`);
  }
  // open the vault with what the user holds (the popup's open, or the lock screen)
  const ctx = contextOver(d);
  let v = await ctx.svc.openView();
  if (v.state === "locked") {
    const pw = (await opensPw(g.keyring, built.before.pw)) ? built.before.pw : typed!.pw;
    v = (await ctx.svc.unlockWithPassword(pw)).view;
  }
  if (!soft(v.state === "unlocked", `open: ${v.state}`) || v.state !== "unlocked") return;
  const names = aliveEntries(v.vault)
    .map((e) => e.issuer)
    .sort();
  const committedData = !isOld || canonicalJson(after.keyring) === canonicalJson(built.before.keyring);
  if (isNew && after.keyring !== built.before.keyring)
    soft(names.join() === [...after.names].sort().join(), `accounts ${names.join()}`);
  else if (!committedData) soft(names.join() === [...built.before.names].sort().join(), `accounts ${names.join()}`);
  else
    soft(
      [[...built.before.names].sort().join(), [...after.names].sort().join()].includes(names.join()),
      `accounts ${names.join()}`,
    );
  // applyRemote: a committed merge has the state it replaced as a rolling snapshot
  if (after.snapshotOf && names.length === after.names.length) {
    const snaps = await Promise.all(
      [...d.kv.data].filter(([k]) => k.startsWith("sk_snap_r")).map(([, x]) => checkSnapshot(x)),
    );
    soft(
      snaps.some((s) => s?.envelope.checksum === after.snapshotOf),
      "no snapshot of the state replaced",
    );
  }
  // after that open or unlock: nothing on disk under a key other than the active one, except another vault's (D9)
  const g2 = (await activeGen(d.kv))!;
  for (const [name, m] of [
    ["local", d.kv],
    ["mirror", d.mirror],
  ] as const) {
    for (const [k, x] of m.data) {
      if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen) {
        const y = await checkGeneration(x);
        if (y) soft(canonicalJson(y.keyring) === canonicalJson(g2.keyring), `after open: old keyring in ${name}:${k}`);
      } else if (k === KEYS.keyringCopy) {
        const y = checkKeyringCopy(x);
        if (y) soft(canonicalJson(y.keyring) === canonicalJson(g2.keyring), `after open: old keyring copy ${name}`);
      } else if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex) {
        const r = await checkSnapshot(x);
        if (r && r.envelope.vaultId === g2.keyring.vaultId)
          soft(r.envelope.vkId === g2.keyring.vkId, `after open: old-key snapshot ${name}:${k}`);
      }
    }
  }
  const cfg = d.kv.data.get(SYNC_KEYS.cfg) as { enc: { vkId: string } } | undefined;
  const records: [string, string][] = [
    ...(cfg ? [[SYNC_KEYS.cfg, cfg.enc.vkId] as [string, string]] : []),
    ...keptOn(d).flatMap((k): [string, string][] =>
      k.p === "damaged" ? [] : [[SYNC_KEYS.prejoin, k.p.envelope.vkId]],
    ),
  ];
  for (const [k, under] of records) {
    // a join that died after writing its records (§3.5 ④, and the new enrolment's sk_sync_cfg) and before its commit
    // leaves them under the cloud key, which this profile does not hold yet: kept on purpose (sk_prejoin is never
    // deleted by itself; the retried join, "joining not finished", writes both again)
    if (after.join && isOld && under === after.keyring.vkId) continue;
    // a vault an earlier join kept, under this profile's key from before the join: the join's cleanup moves it with that
    // key held in memory; a join that died after its commit and before that step leaves it there, kept as it was (the
    // residual §3.5 ⑥ accepts for the old vault's snapshots; docs/design/notes/M6-NOTES.md §13)
    if (after.earlier && isNew && under === built.before.vk.id) continue;
    soft(under === g2.keyring.vkId, `after open: ${k} under an old key`);
  }
  soft(!d.kv.data.has(KEYS.keyChange), "the marker outlived the cleanup");
}

/** Hard: no violation at all outside a lying disk; on a lying disk, only the residual ones (LIE_RESIDUAL). */
export function expectSound(rows: readonly Row[]): void {
  for (const r of rows) {
    const where = `${r.op} @${r.at} ${r.mode} restart=${r.restart}`;
    const bad =
      r.mode === "lie" ? r.violations.filter((v) => !LIE_RESIDUAL.some((x) => v.startsWith(x))) : r.violations;
    expect(bad, where).toEqual([]);
  }
}
