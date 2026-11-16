// Review: wall-clock dependence. Snapshot retention and recovery order by savedAt; HLC stamps from a clock that was
// far ahead; clampVault on stamps from such a clock.
import { describe, expect, it } from "vitest";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { KEYS } from "../../src/core/storage/format";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { aliveEntries, isAlive, type Entry } from "../../src/core/vault/model";
import { addEntry, clampVault, deleteEntry } from "../../src/core/vault/ops";
import { makeWorld } from "../helpers/world";
import { tear } from "../helpers/faulty-kv";
import { createProtected } from "../helpers/vaults";

const YEAR = 365 * 86_400_000;
const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

describe("snapshots after the system clock goes back", () => {
  it("new rolling snapshots are kept, and losing both slots restores the newest saved state", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const clock = { now: Date.UTC(2027, 0, 1) }; // the clock was wrong (a year ahead) for a while
    const s = new VaultStore({ lock: createMutex(), kv: mem, now: () => clock.now });
    for (let n = 1; n <= 10; n++) {
      clock.now += 60_000;
      await s.transact(async () => ({ envelope: await w.state(n), keyring: w.keyring }));
    }
    clock.now -= YEAR; // automatic time is switched on: the clock jumps back to the real date
    for (let n = 11; n <= 13; n++) {
      clock.now += 60_000;
      await s.transact(async () => ({ envelope: await w.state(n), keyring: w.keyring }));
    }

    const ids = (await s.snapshots()).map((m) => m.id);
    expect.soft(ids).toContain("r13"); // the latest change has a snapshot

    // both slots damaged (the case snapshots exist for)
    mem.data.set(KEYS.slot.a, tear(mem.data.get(KEYS.slot.a)));
    mem.data.set(KEYS.slot.b, tear(mem.data.get(KEYS.slot.b)));
    const r = await new VaultStore({ lock: createMutex(), kv: mem, now: () => clock.now }).load();
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(13)).checksum);
  });
  it("even with an up-to-date IndexedDB mirror, recovery prefers a stale snapshot stamped in the future", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    const mirror = new MemoryKV();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const s = new VaultStore({ lock: createMutex(), kv: mem, mirror, now: () => clock.now });
    for (let n = 1; n <= 3; n++) {
      clock.now += 60_000;
      await s.transact(async () => ({ envelope: await w.state(n), keyring: w.keyring }));
    }
    clock.now -= YEAR;
    for (let n = 4; n <= 6; n++) {
      clock.now += 60_000;
      await s.transact(async () => ({ envelope: await w.state(n), keyring: w.keyring }));
    }
    expect((mirror.data.get(KEYS.mirrorGen) as { envelope: { checksum: string } }).envelope.checksum).toBe(
      (await w.state(6)).checksum,
    );
    mem.data.set(KEYS.slot.a, tear(mem.data.get(KEYS.slot.a)));
    mem.data.set(KEYS.slot.b, tear(mem.data.get(KEYS.slot.b)));
    const r = await new VaultStore({ lock: createMutex(), kv: mem, mirror, now: () => clock.now }).load();
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(6)).checksum);
  });
});

describe("HLC stamps written while the clock was more than 24h ahead", () => {
  async function svcAt(clock: { now: number }) {
    const kv = new MemoryKV();
    const settings = new KvSettingsStore(kv);
    const session = new MemorySession(); // one session for every instance, as chrome.storage.session is: a password vault stays unlocked
    const make = () =>
      new VaultService({
        store: new VaultStore({ lock: createMutex(), kv, now: () => clock.now }),
        session,
        settings,
        now: () => clock.now,
      });
    return { make, kv };
  }
  it("an account added then cannot be deleted after the clock is corrected", async () => {
    const real = Date.UTC(2026, 9, 15);
    const clock = { now: real + 30 * 86_400_000 }; // clock 30 days fast
    const { make } = await svcAt(clock);
    const svc = make();
    await createProtected(svc);
    await svc.mutate((v, c) => addEntry(v, input("GitHub"), c, { now: () => clock.now }).vault);
    clock.now = real; // fixed
    const id = (await svc.read()).vault.entries[0]!.id;
    await svc.mutate((v, c) => deleteEntry(v, id, c)); // what the popup's Delete does
    expect(aliveEntries((await make().read()).vault)).toHaveLength(0);
  });
});

describe("clampVault keeps the order of an entry's own registers", () => {
  const base = (hlc: string, dhlc: string): Entry => ({
    id: "entry-000001",
    createdAt: 1,
    type: "totp",
    issuer: "X",
    label: "x",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    hlc,
    order: "V",
    phlc: hlc,
    deleted: true,
    dhlc,
  });
  const now = Date.UTC(2026, 9, 15);
  const f = (ms: number, c: number, d: string) =>
    `${String(ms).padStart(13, "0")}.${c.toString(16).padStart(4, "0")}.${d}`;
  it("a deleted entry (delete after edit, same device, both far ahead) stays deleted", () => {
    const e = base(f(now + 10 * 86_400_000, 5, "aaaa"), f(now + 20 * 86_400_000, 0, "aaaa"));
    expect(isAlive(e)).toBe(false);
    const c = clampVault({ schemaVersion: 1, vaultId: "vault-000001", entries: [e] }, now).entries[0]!;
    expect(isAlive(c)).toBe(false);
  });
  it("a live entry (edit after delete, merged from two devices, both far ahead) stays alive", () => {
    const e = base(f(now + 20 * 86_400_000, 0, "aaaa"), f(now + 10 * 86_400_000, 0, "zzzz"));
    expect(isAlive(e)).toBe(true);
    const c = clampVault({ schemaVersion: 1, vaultId: "vault-000001", entries: [e] }, now).entries[0]!;
    expect(isAlive(c)).toBe(true); // otherwise it lands in the trash and is purged 30 days later
  });
});
