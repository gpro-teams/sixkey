// PHASE0X-PLAN A2, ux-study §2.3: how much the popup reads from storage. These are HARD gates (counts are deterministic):
//   open, unlocked:                 at most 4 chrome.storage.local reads, at most 1.5x the active slot's size
//   unlock (lock screen + unlock):  at most 8 reads, at most 3x
//   the mirror (IndexedDB):         not read at all
//   chrome.storage.session:         not read more often than the old status() + read() path did
// and none of it may grow with the number of snapshots (2 against 17). One documented exception, measured on its own
// below and outside these gates: after an unlock (only then), once the first code is on screen, the popup's notice
// reads sk_security_log once (PHASE0X-PLAN C7, src/popup/notice.ts); the unlock's own reads do not change. Before A2 an open read 18 times, about 5x the slot,
// and an unlock 36 times, 13x. The runtime is the popup's real wiring (createPopupRuntime: ChromeLocalKV, ChromeSessionCache,
// RoutedSession, KvSettingsStore), over counting fake storage areas, and the call measured is the popup's own: loadScreen,
// then for an unlock what Locked does (unlockWithPassword, then the screen of the view it returns).
// Timing is not judged here; test/e2e/perf.spec.ts measures it and only warns.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { addEntry, editEntry } from "../../src/core/vault/ops";
import { aliveEntries } from "../../src/core/vault/model";
import { createRuntime, type Runtime } from "../../src/platform/runtime";
import { createPopupRuntime, type PopupRuntime } from "../../src/platform/runtime-base";
import { loadScreen, screenOf } from "../../src/popup/load";
import { ackNotice, readNotice } from "../../src/popup/notice";
import { SECURITY_LOG_KEY } from "../../src/core/service/security-log";
import { legacyDeviceVault, STRONG, NO_PAGE } from "../helpers/vaults";

const BUDGET = { open: { reads: 4, slots: 1.5 }, unlock: { reads: 8, slots: 3 } } as const;

/** A chrome.storage area in memory that counts reads (calls of get) and the bytes they return, as JSON. */
function countingArea() {
  const data = new Map<string, unknown>();
  const c = { gets: 0, bytes: 0, keys: [] as string[][] };
  const area = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out = Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      c.gets++;
      c.bytes += JSON.stringify(out).length;
      c.keys.push(keys == null ? ["*"] : ks);
      return out;
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
      c.bytes = 0;
      c.keys = [];
    },
  };
}

/** The mirror as a KV that counts every read (get and keys). `broken`: every call fails, as IndexedDB can for good. */
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ISSUERS = [
  "GitHub",
  "Google",
  "AWS",
  "Microsoft",
  "Dropbox",
  "Slack",
  "Cloudflare",
  "Stripe",
  "Binance",
  "Coinbase",
];
const account = (i: number) => ({
  type: "totp" as const,
  issuer: `${ISSUERS[i % ISSUERS.length]}${i >= ISSUERS.length ? ` ${Math.floor(i / ISSUERS.length)}` : ""}`,
  label: `user${i}@example.com`,
  secret: Array.from({ length: 32 }, (_, k) => B32[(i * 7 + k * 13 + (i >> 5)) % 32]).join(""),
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

/**
 * A password-protected vault with `accounts` accounts and `snapshots` snapshots (2: the first save and the accounts;
 * 17: the full 10 rolling + 7 daily), plus the mirror's daily copies, made through the runtime like the extension makes it.
 * It is left in its steady state: unlocked, with the one-time check done.
 */
async function fixture(accounts: number, snapshots: 2 | 17, kind: "password" | "device" = "password") {
  const local = countingArea();
  const session = countingArea();
  const mirror = new CountingKV();
  const rt = createRuntime({ local: local.area, session: session.area, mirror });
  if (kind === "password") await rt.service.create(await rt.service.prepareKeys(STRONG));
  else await legacyDeviceVault(rt.store);
  await rt.service.mutate((v, c) => {
    let x = v;
    for (let i = 0; i < accounts; i++) x = addEntry(x, account(i), c).vault;
    return x;
  });
  if (snapshots === 17) {
    for (let i = 0; i < 8; i++)
      await rt.service.mutate((v, c) => editEntry(v, v.entries[i % v.entries.length]!.id, { label: `edited ${i}` }, c));
    let day = 0;
    const daily = new VaultStore({
      lock: createMutex(),
      kv: rt.local,
      mirror,
      dayKey: () => `2026-01-${String(++day).padStart(2, "0")}`,
    });
    for (let i = 0; i < 7; i++) expect(await daily.ensureDailySnapshot()).toBe(true);
  }
  const snaps = [...local.data.keys()].filter((k) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex);
  expect(snaps).toHaveLength(snapshots);
  // The first open after the vault was made does the one-time check (no sk_store_v yet); from then on, the steady state.
  expect((await loadScreen(createRuntime({ local: local.area, session: session.area, mirror }))).k).toBe("main");
  if (kind === "password") expect(local.data.get(KEYS.storeVersion)).toMatchObject({ v: 2 });
  const slotBytes = () => JSON.stringify(local.data.get(KEYS.slot[local.data.get(KEYS.active) as "a" | "b"])).length;
  /** A new popup: a fresh runtime over the same storage, counters at zero (the popup's own, with ServiceCore). */
  const popup = (): PopupRuntime => {
    local.reset();
    session.reset();
    mirror.reads = 0;
    return createPopupRuntime({ local: local.area, session: session.area, mirror });
  };
  /** A new settings page, the same way: status() and read() are VaultService's (the reference path below). */
  const page = (): Runtime => {
    local.reset();
    session.reset();
    mirror.reads = 0;
    return createRuntime({ local: local.area, session: session.area, mirror });
  };
  return { local, session, mirror, rt, slotBytes, popup, page, accounts, snapshots };
}

type Count = { reads: number; slots: number; sessionReads: number; mirrorReads: number; keys: string[][] };
const count = (f: Fixture): Count => ({
  reads: f.local.c.gets,
  slots: +(f.local.c.bytes / f.slotBytes()).toFixed(2),
  sessionReads: f.session.c.gets,
  mirrorReads: f.mirror.reads,
  keys: f.local.c.keys,
});

/** Opening the popup on an unlocked vault, exactly as App does it. */
async function measureOpen(f: Fixture): Promise<Count> {
  const screen = await loadScreen(f.popup());
  expect(screen.k).toBe("main");
  if (screen.k === "main") expect(aliveEntries(screen.vault)).toHaveLength(f.accounts);
  return count(f);
}

/** The lock screen, then the password: what Locked does (it shows the screen of the view the unlock returns). */
async function measureUnlock(f: Fixture): Promise<Count> {
  await f.rt.service.lock();
  const rt = f.popup();
  expect((await loadScreen(rt)).k).toBe("locked");
  const screen = screenOf((await rt.service.unlockWithPassword(STRONG)).view);
  expect(screen.k).toBe("main");
  if (screen.k === "main") expect(aliveEntries(screen.vault)).toHaveLength(f.accounts);
  return count(f);
}

/** The path before A2 (status() then read(), still kept as the reference), for the session-read comparison and the log. */
async function measureOldOpen(f: Fixture): Promise<Count> {
  const rt = f.page();
  const st = await rt.service.status();
  expect(st.state).toBe("unlocked");
  await rt.service.read();
  await rt.service.lastBackupAt();
  return count(f);
}

const report: string[] = [];
afterAll(() => {
  if (report.length)
    console.log(`read budget (local reads / x active slot / session reads / mirror reads):\n${report.join("\n")}`);
});

describe.each([10, 100, 500])("%i accounts", (accounts) => {
  it("opening the popup: at most 4 local reads, at most 1.5x the slot, no mirror read; the same with 2 or 17 snapshots", async () => {
    const results: Record<number, Count> = {};
    for (const snapshots of [2, 17] as const) {
      const f = await fixture(accounts, snapshots);
      const open = await measureOpen(f);
      const old = await measureOldOpen(f);
      report.push(
        `  ${accounts} accounts, ${snapshots} snapshots, slot ${(f.slotBytes() / 1024).toFixed(1)} KB: open ${open.reads} / ${open.slots}x / ${open.sessionReads} / ${open.mirrorReads}   (status()+read(): ${old.reads} / ${old.slots}x / ${old.sessionReads})`,
      );
      expect(open.reads, JSON.stringify(open.keys)).toBeLessThanOrEqual(BUDGET.open.reads);
      expect(open.slots).toBeLessThanOrEqual(BUDGET.open.slots);
      expect(open.mirrorReads).toBe(0);
      expect(open.sessionReads).toBeLessThanOrEqual(old.sessionReads);
      results[snapshots] = open;
    }
    expect(results[17]!.reads).toBe(results[2]!.reads);
    expect(results[17]!.sessionReads).toBe(results[2]!.sessionReads);
  }, 60_000);

  it("unlocking (the lock screen, then the password): at most 8 local reads, at most 3x the slot, no mirror read; the same with 2 or 17 snapshots", async () => {
    const results: Record<number, Count> = {};
    for (const snapshots of [2, 17] as const) {
      const f = await fixture(accounts, snapshots);
      const unlock = await measureUnlock(f);
      report.push(
        `  ${accounts} accounts, ${snapshots} snapshots: lock screen + unlock ${unlock.reads} / ${unlock.slots}x / ${unlock.sessionReads} / ${unlock.mirrorReads}`,
      );
      expect(unlock.reads, JSON.stringify(unlock.keys)).toBeLessThanOrEqual(BUDGET.unlock.reads);
      expect(unlock.slots).toBeLessThanOrEqual(BUDGET.unlock.slots);
      expect(unlock.mirrorReads).toBe(0);
      // and the next open is the normal one
      const next = await measureOpen(f);
      expect(next.reads).toBeLessThanOrEqual(BUDGET.open.reads);
      results[snapshots] = unlock;
    }
    expect(results[17]!.reads).toBe(results[2]!.reads);
  }, 60_000);
});

describe("other states stay within the open budget", () => {
  it("a device-key vault from Phase 0 (no password): unlocked without a session, at most 4 reads", async () => {
    const f = await fixture(100, 17, "device");
    const open = await measureOpen(f);
    report.push(
      `  device-key vault, 100 accounts, 17 snapshots: open ${open.reads} / ${open.slots}x / ${open.sessionReads} / ${open.mirrorReads}`,
    );
    expect(open.reads).toBeLessThanOrEqual(BUDGET.open.reads);
    expect(open.slots).toBeLessThanOrEqual(BUDGET.open.slots);
    expect(open.mirrorReads).toBe(0);
  }, 60_000);

  it("the lock screen alone: at most 4 reads, one slot", async () => {
    const f = await fixture(100, 17);
    await f.rt.service.lock();
    expect((await loadScreen(f.popup())).k).toBe("locked");
    const c = count(f);
    expect(c.reads).toBeLessThanOrEqual(BUDGET.open.reads);
    expect(c.slots).toBeLessThanOrEqual(BUDGET.open.slots);
    expect(c.mirrorReads).toBe(0);
  }, 60_000);

  it("a key change (legacy -> password -> rotated) leaves the steady state: the next open and unlock are within budget", async () => {
    const f = await fixture(100, 17, "device");
    await f.rt.service.enableMasterPassword(STRONG, NO_PAGE);
    await f.rt.service.rotateKey(STRONG, NO_PAGE);
    expect(f.local.data.has(KEYS.keyChange)).toBe(false); // the cleanup after the change finished and cleared the marker
    expect((await measureOpen(f)).reads).toBeLessThanOrEqual(BUDGET.open.reads);
    const u = await measureUnlock(f);
    expect(u.reads).toBeLessThanOrEqual(BUDGET.unlock.reads);
    expect(u.slots).toBeLessThanOrEqual(BUDGET.unlock.slots);
  }, 60_000);

  it("IndexedDB failing for good after a key change: opening stays within the budget (only the unlock retries the mirror)", async () => {
    const f = await fixture(100, 17);
    f.mirror.broken = true;
    await f.rt.service.rotateKey(STRONG, NO_PAGE);
    expect(f.local.data.get(KEYS.keyChange)).toMatchObject({ mirror: true }); // this store clean, the mirror left
    for (let i = 0; i < 3; i++) {
      const open = await measureOpen(f);
      expect(open.reads, JSON.stringify(open.keys)).toBeLessThanOrEqual(BUDGET.open.reads);
      expect(open.slots).toBeLessThanOrEqual(BUDGET.open.slots);
      expect(open.mirrorReads).toBe(0);
    }
    const u = await measureUnlock(f);
    report.push(
      `  IndexedDB failing after a key change, 100 accounts: open within budget; lock screen + unlock (retrying the mirror) ${u.reads} / ${u.slots}x / ${u.sessionReads} / ${u.mirrorReads}`,
    );
    expect(u.reads).toBeLessThanOrEqual(BUDGET.unlock.reads + 2); // the retry reads the marker with the pointer, and the slot
  }, 60_000);

  it("an interrupted key change costs one full cleanup at the next open, then the budget holds again", async () => {
    const f = await fixture(100, 17);
    f.local.data.set(KEYS.keyChange, { v: 1, vkId: "0000000000000000", at: 1 }); // as left by a crash during a key change
    const first = await measureOpen(f);
    expect(first.reads).toBeGreaterThan(BUDGET.open.reads); // the cleanup looked at every copy, once
    expect(f.local.data.has(KEYS.keyChange)).toBe(false);
    expect((await measureOpen(f)).reads).toBeLessThanOrEqual(BUDGET.open.reads);
  }, 60_000);
});

describe("a local edit reads nothing of the server sync's (its client went: OWNER-DECISIONS/25, DV-0b)", () => {
  it("no get of its records, also in a profile that still holds them (a developer's, before the worker's cleanup)", async () => {
    const f = await fixture(10, 2);
    for (const [k, v] of Object.entries({ sk_sync_cfg: { v: 1 }, sk_sync_state: { v: 1, lastSynced: null } }))
      f.local.data.set(k, v);
    const rt = f.popup();
    await rt.service.mutate((v, cl) => addEntry(v, account(500), cl).vault);
    expect(f.local.c.keys.flat().filter((k) => k.startsWith("sk_sync_") || k === "sk_prejoin")).toEqual([]);
    report.push(`  one edit: ${f.local.c.gets} local reads (none of the server sync's records)`);
  }, 60_000);
});

describe("the backup in Chrome sync's two records: read with the settings, so the popup's pill reads nothing of its own", () => {
  // as the worker writes them when the backup is on (platform/csb-config.ts): a link that remembers its 16 slot ids, and
  // a state with every field, the most these two records are
  const cfg = {
    v: 1,
    on: true,
    opens: "both",
    declined: false,
    link: {
      v: 1,
      slot: "abcd1234",
      gen: "0123456789abcdef",
      seq: 41,
      sum: `${"A".repeat(42)}A=`,
      vaultId: "vaultid-0123456789abcdef",
      vkId: "fedcba9876543210",
      opens: "both",
      wraps: "pbkdf2:AAAAAAAAAAAAAAAA,recovery:BBBBBBBBBBBBBBBB",
      mine: Array.from({ length: 16 }, (_, i) => `slot${String(i).padStart(4, "0")}`),
    },
  };
  const st = {
    v: 1,
    lastOk: 1_900_000_000_000,
    err: null,
    errSince: null,
    pendingSince: null,
    retries: 0,
    lastRun: 1_900_000_000_000,
    bytes: 51_234,
    used: 61_000,
    others: { n: 1, bytes: 9_766, otherVaults: 0, latest: 1_899_000_000_000 },
    seen: true,
    unsafe: false,
  };
  it("an open and an unlock read what they read without them, in the same number of gets; the screen has both as stored", async () => {
    const f = await fixture(100, 2);
    const open = await measureOpen(f);
    const unlock = await measureUnlock(f); // (and unlocked again, as before it)
    f.local.data.set("sk_csb_cfg", structuredClone(cfg));
    f.local.data.set("sk_csb_state", structuredClone(st));
    const screen = await loadScreen(f.popup());
    const withOpen = count(f);
    expect(screen.k).toBe("main");
    if (screen.k === "main") expect(screen.also).toEqual({ sk_csb_cfg: cfg, sk_csb_state: st });
    expect(withOpen.reads).toBe(open.reads);
    expect(withOpen.reads).toBeLessThanOrEqual(BUDGET.open.reads);
    expect(withOpen.slots).toBeLessThanOrEqual(BUDGET.open.slots);
    // the one get that reads the settings reads them too, and no other get names them
    const named = withOpen.keys.filter((k) => k.includes("sk_csb_cfg") || k.includes("sk_csb_state"));
    expect(named).toHaveLength(1);
    expect(named[0]).toEqual(expect.arrayContaining(["sk_settings", "sk_last_backup", "sk_csb_cfg", "sk_csb_state"]));
    await f.rt.service.lock();
    const rt = f.popup();
    expect((await loadScreen(rt)).k).toBe("locked");
    const after = screenOf((await rt.service.unlockWithPassword(STRONG)).view);
    const withUnlock = count(f);
    expect(after.k).toBe("main");
    if (after.k === "main") expect(after.also).toEqual({ sk_csb_cfg: cfg, sk_csb_state: st });
    expect(withUnlock.reads).toBe(unlock.reads);
    expect(withUnlock.reads).toBeLessThanOrEqual(BUDGET.unlock.reads);
  }, 60_000);
});

describe("the security record's notice after an unlock (PHASE0X-PLAN C7): one read of its own, after the view", () => {
  // Not part of the unlock gate above, and not folded into its degraded allowance: the read comes after the unlock has
  // returned the view (the popup makes it once the first code is on screen), and perf.spec.ts allows it in "in all" only.
  for (const guesses of [0, 3]) {
    it(`${guesses} wrong passwords before it: the unlock reads exactly what it reads without the notice, then the notice adds one get of ${SECURITY_LOG_KEY} alone`, async () => {
      const f = await fixture(100, 17);
      const reference = await measureUnlock(f);
      const referenceKeys = [...reference.keys];
      await f.rt.service.lock();
      for (let i = 0; i < guesses; i++)
        await expect(f.rt.service.unlockWithPassword("not the password")).rejects.toThrow("wrong_secret");
      const rt = f.popup();
      expect((await loadScreen(rt)).k).toBe("locked");
      const screen = screenOf((await rt.service.unlockWithPassword(STRONG)).view);
      expect(screen.k).toBe("main");
      const unlock = { ...count(f), keys: [...f.local.c.keys] };
      expect(unlock.reads).toBe(reference.reads);
      expect(unlock.keys).toEqual(referenceKeys);
      expect(unlock.reads).toBeLessThanOrEqual(BUDGET.unlock.reads);

      const notice = await readNotice(rt);
      const after = count(f);
      expect(notice).toEqual(guesses ? { failed: guesses } : null);
      expect(after.reads).toBe(unlock.reads + 1);
      expect(after.keys.slice(0, unlock.reads)).toEqual(unlock.keys);
      expect(after.keys.at(-1)).toEqual([SECURITY_LOG_KEY]);
      expect(after.sessionReads).toBe(unlock.sessionReads);
      expect(after.mirrorReads).toBe(0);
      report.push(
        `  notice after an unlock (${guesses} wrong before): lock screen + unlock ${unlock.reads}, then the notice's read: ${after.reads}`,
      );

      // The ack, once the notice has been on screen: one more get and a set of the same key, and only with a count to take off.
      await ackNotice(rt, notice ?? { unreadable: true });
      const acked = count(f);
      expect(acked.reads).toBe(after.reads + (guesses ? 1 : 0));
      if (guesses) expect(acked.keys.at(-1)).toEqual([SECURITY_LOG_KEY]);
      expect(await readNotice(f.popup())).toBeNull();
    }, 60_000);
  }
});

describe("the gate measures the path the popup really takes", () => {
  it("no popup module asks the service for status() or read(): opening goes through loadScreen (openView) only", () => {
    const root = resolve(import.meta.dirname, "../../src/popup");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [],
      );
    const offenders = files(root).filter((f) => /\.service\.(status|read)\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    // and none reads the settings on its own: they come with the view (Main.tsx takes the display settings from it)
    expect(files(root).filter((f) => /\.service\.getSettings\(/.test(readFileSync(f, "utf8")))).toEqual([]);
    expect(readFileSync(join(root, "App.tsx"), "utf8")).toMatch(/loadScreen\(rt[,)]/); // (with the change count's mark)
    expect(readFileSync(join(root, "load.ts"), "utf8")).toMatch(/rt\.service\.openView\(\)/);
  });
});
