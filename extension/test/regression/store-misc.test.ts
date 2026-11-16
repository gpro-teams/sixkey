// Review: storage edge cases not covered by test/fault.
import { describe, expect, it } from "vitest";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { KEYS } from "../../src/core/storage/format";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { createDiagLogger } from "../../src/platform/diag";
import { makeWorld } from "../helpers/world";
import { STRONG } from "../helpers/vaults";

describe("a fresh install", () => {
  it("stays 'empty' (welcome screen) after the user changes a setting on the options page before creating a vault", async () => {
    const kv = new MemoryKV();
    const settings = new KvSettingsStore(kv);
    const svc = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv, mirror: new MemoryKV() }),
      session: new MemorySession(),
      settings,
    });
    expect((await svc.status()).state).toBe("empty");
    // Options page, Security > Auto-lock is rendered even with no vault (Security.tsx AutoLock); changing it writes sk_settings.
    await svc.updateSettings({ autoLock: { mode: "session" }, lockOnScreenLock: true });
    // Actual: hasAnyData() counts any "sk_" key, so the popup now shows "We could not read your saved accounts" and
    // offers only "restore from backup"; the options page offers "Start over" behind typing DELETE.
    expect((await svc.status()).state).toBe("empty");
  });
  it("the same for a diagnostics log line written before the vault exists", async () => {
    const kv = new MemoryKV();
    const diag = createDiagLogger(kv);
    diag("mirror unreadable", new Error("x"));
    await new Promise((r) => setTimeout(r, 10));
    const svc = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv }),
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
    });
    expect((await svc.status()).state).toBe("empty");
  });
});

/** A store whose get() fails once for one key (a transient read error), then works again. */
class FlakyGetKV implements KV {
  failures = 0;
  constructor(
    readonly inner: MemoryKV,
    private failKey: string,
    private times = 1,
  ) {}
  async get(keys: string[]) {
    if (keys.includes(this.failKey) && this.failures < this.times) {
      this.failures++;
      throw new Error("IO error: transient");
    }
    return this.inner.get(keys);
  }
  set(i: Record<string, unknown>) {
    return this.inner.set(i);
  }
  remove(k: string[]) {
    return this.inner.remove(k);
  }
  keys() {
    return this.inner.keys();
  }
}

describe("a transient read error", () => {
  it("on the newest slot does not destroy the newest committed state", async () => {
    const w = await makeWorld();
    const mem = new MemoryKV();
    let now = 1_700_000_000_000;
    const s = new VaultStore({ lock: createMutex(), kv: mem, now: () => (now += 1000) });
    await s.transact(async () => ({ envelope: await w.state(1), keyring: w.keyring })); // slot a
    await s.transact(async () => ({ envelope: await w.state(2), keyring: w.keyring })); // slot b, pointer b
    expect(mem.data.get(KEYS.active)).toBe("b");

    // Browser start: the service worker's onStartup runs selfCheck(); one read of slot b fails once.
    const flaky = new FlakyGetKV(mem, KEYS.slot.b, 1);
    // The failed read is reported (the service worker's routine catches it and tries again on its next wake-up) ...
    await expect(
      new VaultStore({ lock: createMutex(), kv: flaky, now: () => (now += 1000) }).selfCheck(),
    ).rejects.toThrow("transient");
    // ... and, crucially, nothing was repaired or overwritten on its account.
    const r = await new VaultStore({ lock: createMutex(), kv: mem, now: () => (now += 1000) }).load();
    expect(r.status === "ok" && r.gen.envelope.checksum).toBe((await w.state(2)).checksum);
    await expect(
      new VaultStore({ lock: createMutex(), kv: flaky, now: () => (now += 1000) }).selfCheck(),
    ).resolves.toMatchObject({ status: "ok" }); // and the retry works
  });
});

describe("first-run races (check outside the write lock)", () => {
  it("'Restore from backup' on the options page and 'Start' in the popup at the same time: the restored accounts survive", async () => {
    const { addEntry } = await import("../../src/core/vault/ops");
    const { createClock } = await import("../../src/core/vault/hlc");
    const { emptyVault, aliveEntries } = await import("../../src/core/vault/model");
    const kv = new MemoryKV();
    const settings = new KvSettingsStore(kv);
    const lock = createMutex(); // navigator.locks gives every context the same lock; model that
    const session = new MemorySession(); // and chrome.storage.session one session: the winner is unlocked, so read() below works
    const make = () => new VaultService({ store: new VaultStore({ kv, lock }), session, settings });
    const backup = addEntry(
      emptyVault("vault-backup-01"),
      {
        type: "totp",
        issuer: "Bank",
        label: "me",
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
      createClock("aaaa"),
    ).vault;
    // Each page has its password and recovery code ready (prepared, nothing written) before either one writes.
    const [forRestore, forCreate] = await Promise.all([
      make().prepareKeys(STRONG, { vaultId: "vault-backup-01" }),
      make().prepareKeys(STRONG),
    ]);
    const results = await Promise.allSettled([make().restoreBackup(backup, forRestore), make().create(forCreate)]);
    const v = (await make().read()).vault;
    // Whichever call got the lock first wins; the other is refused. Neither may replace the other's vault.
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "bad_state" });
    const restoreWon = results[0]!.status === "fulfilled";
    expect(aliveEntries(v).map((e) => e.issuer)).toEqual(restoreWon ? ["Bank"] : []);
  });
  it("unreadable data: 'Restore' on one page and 'Start over' on another at the same time never erase the restored accounts", async () => {
    const { addEntry } = await import("../../src/core/vault/ops");
    const { createClock } = await import("../../src/core/vault/hlc");
    const { emptyVault, aliveEntries } = await import("../../src/core/vault/model");
    for (const order of ["restore first", "start over first"] as const) {
      const kv = new MemoryKV();
      kv.data.set(KEYS.active, "a");
      kv.data.set(KEYS.slot.a, "garbage"); // lost: unreadable, nothing to recover from
      const settings = new KvSettingsStore(kv);
      const lock = createMutex();
      const session = new MemorySession();
      const make = () => new VaultService({ store: new VaultStore({ kv, lock }), session, settings });
      expect((await make().status()).state).toBe("lost");
      const backup = addEntry(
        emptyVault("vault-backup-01"),
        {
          type: "totp",
          issuer: "Bank",
          label: "me",
          secret: "JBSWY3DPEHPK3PXP",
          algorithm: "SHA1",
          digits: 6,
          period: 30,
        },
        createClock("aaaa"),
      ).vault;
      const [forRestore, forStartOver] = await Promise.all([
        make().prepareKeys(STRONG, { vaultId: "vault-backup-01" }),
        make().prepareKeys(STRONG),
      ]);
      // Both pages saw "lost" before either wrote. Before the fix, start over's write did not look at what was there
      // inside the lock, so a restore that landed first was overwritten with an empty vault.
      const calls = [() => make().restoreBackup(backup, forRestore), () => make().startOver(forStartOver)];
      if (order === "start over first") calls.reverse();
      const results = await Promise.allSettled(calls.map((c) => c()));
      expect(
        results.map((r) => r.status),
        order,
      ).toEqual(["fulfilled", "rejected"]);
      expect((results[1] as PromiseRejectedResult).reason, order).toMatchObject({ code: "bad_state" });
      const v = (await make().read()).vault;
      expect(
        aliveEntries(v).map((e) => e.issuer),
        order,
      ).toEqual(order === "restore first" ? ["Bank"] : []);
    }
  });
});
