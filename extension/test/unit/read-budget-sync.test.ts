// The read gates with sync on (M2), measured on the popup's real wiring like read-budget.test.ts, which keeps measuring
// sync off with its gates unchanged. With a sync configuration, the sync state, the device key's copy and sk_prejoin in
// storage.local (and the copy and sk_prejoin under the current key: the steady state):
//   - opening and unlocking read exactly what they read with sync off (none of M2's code is on those paths): at most 4
//     and 8, none of the mirror;
//   - the degraded unlock (IndexedDB failing after a key change) stays at its 10: the cleanup a mirror-only marker asks
//     for does not look at the two records again (the full cleanup before it moved them);
//   - the first open after applyRemote reads exactly what any open reads (applyRemote writes no marker, §0.0i item 2,
//     revision 12; it was a full cleanup, 29 reads, before);
//   - a local edit reads the sync state once (one get of sk_sync_cfg and sk_sync_state), with sync off too.
import { afterAll, describe, expect, it } from "vitest";
import { KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { SyncFlows } from "../../src/core/service/sync-flows";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { SyncLocal } from "../../src/core/sync/local/sync-local";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry, editEntry } from "../../src/core/vault/ops";
import { createRuntime } from "../../src/platform/runtime";
import { createPopupRuntime, type PopupRuntime } from "../../src/platform/runtime-base";
import { loadScreen, screenOf } from "../../src/popup/load";
import { utf8 } from "../../src/core/crypto/bytes";
import { decryptVault } from "../../src/core/crypto/envelope";
import { fromB64 } from "../../src/core/crypto/bytes";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { deserializeVault } from "../../src/core/vault/validate";
import { STRONG } from "../helpers/vaults";
import { adoptByUnlock, bundleFor, input, newIdentity, rotated, secretOf } from "../helpers/m2-world";

const BUDGET = { open: 4, unlock: 8, degradedUnlock: 10 } as const;

function countingArea() {
  const data = new Map<string, unknown>();
  const c = { gets: 0, keys: [] as string[][] };
  const area = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      c.gets++;
      c.keys.push(keys == null ? ["*"] : ks);
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
  return {
    data,
    c,
    area: area as unknown as chrome.storage.StorageArea,
    reset: () => {
      c.gets = 0;
      c.keys = [];
    },
  };
}
class CountingKV implements KV {
  readonly inner = new MemoryKV();
  reads = 0;
  broken = false;
  private fail() {
    return Promise.reject(new Error("Internal error opening backing store"));
  }
  get(keys: string[]) {
    this.reads++;
    return this.broken ? this.fail() : this.inner.get(keys);
  }
  keys() {
    this.reads++;
    return this.broken ? this.fail() : this.inner.keys();
  }
  set(items: Record<string, unknown>) {
    return this.broken ? this.fail() : this.inner.set(items);
  }
  remove(keys: string[]) {
    return this.broken ? this.fail() : this.inner.remove(keys);
  }
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const account = (i: number) => ({
  type: "totp" as const,
  issuer: `Issuer ${i}`,
  label: `user${i}@example.com`,
  secret: Array.from({ length: 32 }, (_, k) => B32[(i * 7 + k * 13) % 32]).join(""),
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

/** 100 accounts, 17 snapshots, as read-budget.test.ts; `sync`: the profile has sync's records in storage.local, under the current key. */
async function fixture(sync: boolean) {
  const local = countingArea();
  const session = countingArea();
  const mirror = new CountingKV();
  const rt = createRuntime({ local: local.area, session: session.area, mirror });
  await rt.service.create(await rt.service.prepareKeys(STRONG));
  await rt.service.mutate((v, c) => {
    let x = v;
    for (let i = 0; i < 100; i++) x = addEntry(x, account(i), c).vault;
    return x;
  });
  for (let i = 0; i < 8; i++)
    await rt.service.mutate((v, c) => editEntry(v, v.entries[i]!.id, { label: `edited ${i}` }, c));
  let day = 0;
  const daily = new VaultStore({
    lock: createMutex(),
    kv: rt.local,
    mirror,
    dayKey: () => `2026-01-${String(++day).padStart(2, "0")}`,
  });
  for (let i = 0; i < 7; i++) await daily.ensureDailySnapshot();
  const lock = createMutex();
  const syncLocal = new SyncLocal({ local: rt.local, identity: new MemoryKV(), vaultLock: lock });
  if (sync) {
    const vk = await vkFromRaw(fromB64((session.data.get("sk_session") as { vk: string }).vk));
    const { id, jwk } = await newIdentity({ state: "enrolled" });
    await syncLocal.identity.put(id);
    await syncLocal.cfg.write(vk, {
      deviceId: id.deviceId,
      apiOrigin: id.apiOrigin,
      dsk: jwk,
      email: "me@example.com",
    });
    await syncLocal.prejoin.writeInLock(vk, utf8("{}"), "old-vault-00001", 1);
    local.data.set(SYNC_KEYS.state, {
      v: 1,
      lastSynced: { version: 3, head: "h", checksum: "c" },
      serverOffsetMs: 1200,
    });
  }
  expect((await loadScreen(createRuntime({ local: local.area, session: session.area, mirror }))).k).toBe("main"); // the one-time check
  /** A new popup (its own runtime, with ServiceCore), counters at zero. */
  const popup = (): PopupRuntime => {
    local.reset();
    session.reset();
    mirror.reads = 0;
    return createPopupRuntime({ local: local.area, session: session.area, mirror });
  };
  return { local, session, mirror, rt, popup, syncLocal };
}
type F = Awaited<ReturnType<typeof fixture>>;
const reads = (f: F) => ({ reads: f.local.c.gets, keys: [...f.local.c.keys], mirror: f.mirror.reads });
async function open(f: F) {
  expect((await loadScreen(f.popup())).k).toBe("main");
  return reads(f);
}
async function unlock(f: F) {
  await f.rt.service.lock();
  const rt = f.popup();
  expect((await loadScreen(rt)).k).toBe("locked");
  expect(screenOf((await rt.service.unlockWithPassword(STRONG)).view).k).toBe("main");
  return reads(f);
}

const report: string[] = [];
afterAll(() => {
  if (report.length) console.log(`read budget with sync on (local reads):\n${report.join("\n")}`);
});

describe("the read gates with sync on", () => {
  it("opening and unlocking read exactly what they read with sync off (at most 4 and 8, no mirror read)", async () => {
    const off = await fixture(false);
    const on = await fixture(true);
    const [o0, o1] = [await open(off), await open(on)];
    const [u0, u1] = [await unlock(off), await unlock(on)];
    report.push(
      `  open: sync off ${o0.reads}, sync on ${o1.reads}; unlock (lock screen + unlock): sync off ${u0.reads}, sync on ${u1.reads}`,
    );
    expect(o1.keys).toEqual(o0.keys);
    expect(u1.keys).toEqual(u0.keys);
    expect(o1.reads).toBeLessThanOrEqual(BUDGET.open);
    expect(u1.reads).toBeLessThanOrEqual(BUDGET.unlock);
    expect([o1.mirror, u1.mirror]).toEqual([0, 0]);
  }, 120_000);

  it("IndexedDB failing for good after a key change, with sync's records present: the retrying unlock stays at 10 (records are not read again)", async () => {
    const f = await fixture(true);
    f.mirror.broken = true;
    // the key change with sync on: another device's rotation adopted (R3), committed through the sync flows (§0.0i item 16)
    const vk = await vkFromRaw(fromB64((f.session.data.get("sk_session") as { vk: string }).vk));
    const kr = (await f.rt.service.currentGeneration())!.keyring;
    const r = await rotated(kr, vk);
    const keys = await adoptByUnlock({
      secret: { password: STRONG },
      local: kr,
      remote: await bundleFor(r.vk, r.keyring, 2),
      pinnedVkId: null,
      maxSeenKver: 0,
      needsPassword: true,
      expectedVaultId: kr.vaultId,
      adoptedAuth: null,
      adoptedDigest: null,
    });
    await new SyncFlows(f.rt.service, f.syncLocal).commitKeys({ keys });
    expect(f.local.data.get(KEYS.keyChange)).toMatchObject({ mirror: true });
    expect((f.local.data.get(SYNC_KEYS.cfg) as { enc: { vkId: string } }).enc.vkId).toBe(
      f.local.data.get(KEYS.keyChange) && (f.local.data.get(KEYS.keyChange) as { vkId: string }).vkId,
    ); // moved by the full cleanup
    const o = await open(f);
    expect(o.reads).toBeLessThanOrEqual(BUDGET.open);
    const u = await unlock(f);
    report.push(`  degraded unlock (mirror failing, records present): ${u.reads}`);
    expect(u.reads).toBeLessThanOrEqual(BUDGET.degradedUnlock);
    expect(u.keys.flat()).not.toContain(SYNC_KEYS.cfg);
    expect(u.keys.flat()).not.toContain(SYNC_KEYS.prejoin);
  }, 120_000);

  it("the first open after applyRemote reads what any open reads: no marker, no cleanup (§0.0i item 2, revision 12)", async () => {
    const f = await fixture(true);
    const vk = await vkFromRaw(fromB64((f.session.data.get("sk_session") as { vk: string }).vk));
    const flows = new SyncFlows(f.rt.service, f.syncLocal);
    const ptr = f.local.data.get(KEYS.active) as "a" | "b";
    const mine: Vault = deserializeVault(
      await decryptVault((f.local.data.get(KEYS.slot[ptr]) as { envelope: never }).envelope, vk),
    );
    const c = createClock("bbbb", { now: () => Date.now() + 1000 });
    for (const e of mine.entries) c.observe(e.hlc);
    const normal = await open(f);
    expect((await flows.applyRemote(addEntry(mine, input("Remote", secretOf("Remote")), c).vault)).changed).toBe(true);
    expect(f.local.data.has(KEYS.keyChange)).toBe(false);
    const first = await open(f);
    report.push(`  first open after applyRemote: ${first.reads}`);
    expect(first.reads).toBeLessThanOrEqual(BUDGET.open);
    const slotless = (ks: string[][]) =>
      ks.map((k) => k.map((x) => (x === KEYS.slot.a || x === KEYS.slot.b ? "the active slot" : x)));
    expect(slotless(first.keys)).toEqual(slotless(normal.keys)); // the merge went to the other slot, which is active now
    const next = await open(f);
    expect(next.reads).toBeLessThanOrEqual(BUDGET.open);
    expect(
      aliveEntries((await loadScreen(f.popup()).then((s) => (s.k === "main" ? s : null)))!.vault).some(
        (e) => e.issuer === "Remote",
      ),
    ).toBe(true);
  }, 120_000);

  it("a local edit reads the sync state once (one get of sk_sync_cfg and sk_sync_state), with sync off too; with sync on the outbox writer (M5) reads it once more, after the commit", async () => {
    for (const sync of [false, true]) {
      const f = await fixture(sync);
      const rt = f.popup();
      await rt.service.mutate((v, cl) => addEntry(v, account(500), cl).vault);
      const ks = f.local.c.keys.filter((k) => k.includes(SYNC_KEYS.cfg) || k.includes(SYNC_KEYS.state));
      // §4.7 D2: the writer must read lastSynced inside the vault lock after the commit (a recovery write in the same
      // transact runs its hook after the edit's own read), so it cannot reuse the edit's earlier read of the sync state.
      expect(ks).toEqual(
        sync
          ? [
              [SYNC_KEYS.cfg, SYNC_KEYS.state],
              [SYNC_KEYS.state, SYNC_KEYS.cfg],
            ]
          : [[SYNC_KEYS.cfg, SYNC_KEYS.state]],
      );
      if (sync) {
        const writerRead = f.local.c.keys.findIndex((k) => k[0] === SYNC_KEYS.state && k[1] === SYNC_KEYS.cfg);
        const lastSlotRead = f.local.c.keys
          .map((k, i) => (k.includes(KEYS.slot.a) || k.includes(KEYS.slot.b) ? i : -1))
          .reduce((a, b) => Math.max(a, b), -1);
        expect(writerRead).toBeGreaterThan(lastSlotRead); // after the slot was written and read back: the commit's afterCommit
        expect(f.local.data.get(SYNC_KEYS.outbox)).toMatchObject({ v: 1, base: 3 }); // and it wrote the pushable outbox
      }
      report.push(
        `  one edit, sync ${sync ? "on" : "off"}: ${f.local.c.gets} local reads (of which ${sync ? 2 : 1} the sync state)`,
      );
    }
  }, 120_000);
});
