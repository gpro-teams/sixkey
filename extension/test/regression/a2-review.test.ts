// Regression tests from the review of PHASE0X-PLAN A2 (docs/audit/internal-reviews/A2-REVIEW.md). Each REPRO there showed a
// problem; here the same sequence asserts the fixed behaviour. P-1 is fixed both ways: FIXb (an I/O error at the commit)
// and FIXa2, the maintainer's decision "rely on the slot the pointer names; unfinished key changes are always rolled back",
// with its cost pinned too.
import { describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import { checkGeneration, checkSnapshot, KEYS, parseSnapshotIndex } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { createClock } from "../../src/core/vault/hlc";
import { createKeyring } from "../../src/core/crypto/keyring";
import { decryptVault, encryptVault } from "../../src/core/crypto/envelope";
import { fromB64, utf8 } from "../../src/core/crypto/bytes";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { deserializeVault, serializeVault } from "../../src/core/vault/validate";
import { tear } from "../helpers/faulty-kv";
import { createProtected, legacyDeviceVault, STRONG, NO_PAGE, codeOf, resetWithCode } from "../helpers/vaults";

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

function world() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const store = (k: KV = kv, m: KV = mirror) =>
    new VaultStore({ lock: createMutex(), kv: k, mirror: m, now: () => t.now });
  const svc = (k: KV = kv, m: KV = mirror) =>
    new VaultService({ store: store(k, m), session, settings, now: () => t.now });
  const add = async (s: VaultService, n: string) => {
    t.now += 60_000;
    await s.mutate((v, c) => addEntry(v, input(n), c).vault);
  };
  return { kv, mirror, session, t, settings, store, svc, add };
}

const wrap = (inner: KV, o: Partial<KV>): KV => ({
  get: (k) => inner.get(k),
  keys: () => inner.keys(),
  set: (i) => inner.set(i),
  remove: (k) => inner.remove(k),
  ...o,
});
/** The first write that moves the pointer fails without landing: an I/O error exactly at the commit point. */
const failPointerOnce = (inner: KV): KV => {
  let done = false;
  return wrap(inner, {
    set: async (i) => {
      if (!done && KEYS.active in i) {
        done = true;
        throw new Error("IO error at the commit");
      }
      return inner.set(i);
    },
  });
};
/** The n-th read that includes `key` throws (a transient I/O error). */
const failNthRead = (inner: KV, key: string, n: number): KV => {
  let c = 0;
  return wrap(inner, {
    get: async (k) => {
      if (k.includes(key) && ++c === n) throw new Error("IO error: transient");
      return inner.get(k);
    },
  });
};

const active = async (kv: MemoryKV) =>
  (await checkGeneration(kv.data.get(KEYS.slot[kv.data.get(KEYS.active) as "a" | "b"])))!;
const snapRecords = (m: MemoryKV) => [...m.data.keys()].filter((k) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex);

// ---- P-1: a key change that failed at the commit -------------------------------------------------------------------------

describe("P-1 (FIXb, FIXa2): a key change that fails at the commit stays failed, also after a browser restart (selfCheck)", () => {
  it("rotateKey: the saved recovery code still works and the vault is still under the old key", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const before = (await active(w.kv)).keyring.vkId;
    await expect(w.svc(failPointerOnce(w.kv)).rotateKey(STRONG, NO_PAGE)).rejects.toThrow("IO error at the commit");
    await w.store().selfCheck(); // chrome.runtime.onStartup / onInstalled
    expect((await active(w.kv)).keyring.vkId).toBe(before);
    await w.svc().lock();
    await w.svc().unlockWithRecoveryCode(r1);
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toEqual(["GitHub"]);
  });

  it("FIXb: a pointer write that lands and still reports an error (so FIXa2 cannot see it) leaves the old key active", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const before = (await active(w.kv)).keyring.vkId;
    let done = false;
    const landsThenThrows = wrap(w.kv, {
      set: async (i) => {
        await w.kv.set(i);
        if (!done && KEYS.active in i) {
          done = true;
          throw new Error("IO error after the write");
        }
      },
    });
    await expect(w.svc(landsThenThrows).rotateKey(STRONG, NO_PAGE)).rejects.toThrow("IO error after the write");
    expect((await active(w.kv)).keyring.vkId).toBe(before); // the pointer names the target, which holds the old state again
    await expect(unlockWithRecoveryCode((await active(w.kv)).keyring, r1)).resolves.toBeDefined();
  });

  it("the reset (prepareReset, commitReset): the old password and the saved recovery code still open the vault, and a retry works", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    await w.svc().lock();
    await expect(resetWithCode(w.svc(failPointerOnce(w.kv)), r1, STRONG2)).rejects.toThrow("IO error at the commit");
    await w.store().selfCheck();
    const k = (await active(w.kv)).keyring;
    await expect(unlockWithRecoveryCode(k, r1)).resolves.toBeDefined();
    await expect(unlockWithPassword(k, STRONG)).resolves.toBeDefined();
    await expect(unlockWithPassword(k, STRONG2)).rejects.toThrow();
    await expect(resetWithCode(w.svc(), r1, STRONG2)).resolves.toEqual(expect.any(String));
  });

  it("enableMasterPassword: still the device-key vault the user was told it is", async () => {
    const w = world();
    await legacyDeviceVault(w.store());
    await w.add(w.svc(), "GitHub");
    await expect(w.svc(failPointerOnce(w.kv)).enableMasterPassword(STRONG, NO_PAGE)).rejects.toThrow(
      "IO error at the commit",
    );
    await w.store().selfCheck();
    expect((await active(w.kv)).keyring.deviceKey).toBeDefined();
    expect(await w.svc().status()).toMatchObject({ state: "unlocked", passwordProtected: false });
  });

  it("the extra key-change marker that the failed attempt left costs one cleanup and nothing else", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const before = (await active(w.kv)).keyring.vkId;
    await expect(w.svc(failPointerOnce(w.kv)).rotateKey(STRONG, NO_PAGE)).rejects.toThrow();
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    expect((await w.svc().openView()).state).toBe("unlocked");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    await w.store().selfCheck();
    expect((await active(w.kv)).keyring.vkId).toBe(before);
    await expect(unlockWithRecoveryCode((await active(w.kv)).keyring, r1)).resolves.toBeDefined();
  });

  it("FIXb only for keyring changes: a decrypt fallback whose commit fails keeps the restored good copy in its slot", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const vk = await vkFromRaw(fromB64(w.session.data!.vk));
    const ptr = w.kv.data.get(KEYS.active) as "a" | "b";
    const act = (await checkGeneration(w.kv.data.get(KEYS.slot[ptr])))!;
    // the active copy passes its checksum but is not a vault: opening falls back and restores the good copy
    w.kv.data.set(KEYS.slot[ptr], {
      ...act,
      envelope: await encryptVault(utf8("not a vault"), vk, {
        vaultId: act.keyring.vaultId,
        rev: act.envelope.rev + 5,
      }),
    });
    await expect(w.svc(failPointerOnce(w.kv)).openView()).rejects.toThrow("IO error at the commit");
    const opens = async (s: "a" | "b") => {
      const g = await checkGeneration(w.kv.data.get(KEYS.slot[s]));
      try {
        return g ? aliveEntries(deserializeVault(await decryptVault(g.envelope, vk))).map((e) => e.issuer) : null;
      } catch {
        return null;
      }
    };
    expect(await opens(ptr === "a" ? "b" : "a")).toEqual(["GitHub"]); // the slot it was restoring into still holds it
    await w.store().selfCheck();
    const v = await w.svc().openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub"]);
  });

  // A process that dies at the commit write leaves the new slot on disk and verified: FIXb never runs. FIXa2 keeps the
  // slot the pointer names when the newer one carries another keyring, so the self-check rolls the change back.
  class Dead extends Error {}
  /** Dies at the first write that matches `at`, for every store at once (one process). */
  const dying = (at: (items: Record<string, unknown>) => boolean) => {
    let dead = false;
    return (inner: KV): KV => ({
      get: async (k) => {
        if (dead) throw new Dead();
        return inner.get(k);
      },
      keys: async () => {
        if (dead) throw new Dead();
        return inner.keys();
      },
      set: async (i) => {
        if (dead) throw new Dead();
        if (at(i)) {
          dead = true;
          throw new Dead();
        }
        return inner.set(i);
      },
      remove: async (k) => {
        if (dead) throw new Dead();
        return inner.remove(k);
      },
    });
  };
  async function diedAt(at: (items: Record<string, unknown>) => boolean) {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const before = (await active(w.kv)).keyring.vkId;
    const die = dying(at);
    await expect(w.svc(die(w.kv), die(w.mirror)).rotateKey(STRONG, NO_PAGE)).rejects.toBeInstanceOf(Dead);
    return { w, r1, before };
  }
  const atCommit = (i: Record<string, unknown>) => KEYS.active in i;
  const atSlotWrite = (i: Record<string, unknown>) => KEYS.slot.a in i || KEYS.slot.b in i;

  it("the process dies at the commit write: the old key is active, the rotated keyring waits in the other slot", async () => {
    const { w, r1, before } = await diedAt(atCommit);
    expect((await active(w.kv)).keyring.vkId).toBe(before); // what every load() sees: not committed
    await expect(unlockWithRecoveryCode((await active(w.kv)).keyring, r1)).resolves.toBeDefined();
    const other = await checkGeneration(w.kv.data.get(KEYS.slot[w.kv.data.get(KEYS.active) === "a" ? "b" : "a"]));
    expect(other!.keyring.vkId).not.toBe(before);
  });

  it("FIXa2: after that, a browser restart (selfCheck) keeps the old key: the saved recovery code still works, nothing is lost", async () => {
    const { w, r1, before } = await diedAt(atCommit);
    await w.store().selfCheck();
    expect((await active(w.kv)).keyring.vkId).toBe(before);
    await expect(unlockWithRecoveryCode((await active(w.kv)).keyring, r1)).resolves.toBeDefined();
    await w.svc().lock();
    await w.svc().unlockWithRecoveryCode(r1);
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toEqual(["GitHub"]);
    // and the next unlock's cleanup (the marker the rotation wrote) overwrites the unfinished slot
    await w.svc().lock();
    await w.svc().unlockWithPassword(STRONG);
    const other = await checkGeneration(w.kv.data.get(KEYS.slot[w.kv.data.get(KEYS.active) === "a" ? "b" : "a"]));
    expect(other!.keyring.vkId).toBe(before);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("a crash before the commit (at the slot write): nothing changed, before and after a browser restart", async () => {
    const { w, r1, before } = await diedAt(atSlotWrite);
    for (const restart of [false, true]) {
      if (restart) await w.store().selfCheck();
      expect((await active(w.kv)).keyring.vkId, `restart: ${restart}`).toBe(before);
      await expect(unlockWithRecoveryCode((await active(w.kv)).keyring, r1)).resolves.toBeDefined();
    }
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true); // the marker went down first: an extra one, cleared by the next cleanup
    expect((await w.svc().openView()).state).toBe("unlocked");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("an ordinary save (same keyring) that dies at the commit keeps the old rule: the self-check commits the newer slot", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const die = dying(atCommit);
    await expect(
      w.svc(die(w.kv), die(w.mirror)).mutate((v, c) => addEntry(v, input("AWS"), c).vault),
    ).rejects.toBeInstanceOf(Dead);
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toEqual(["GitHub"]); // the pointer: not yet
    await w.store().selfCheck();
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]); // highest save wins
  });

  /** A power loss that drops only the pointer write of the last save, after it reported success: the pointer goes back. */
  const losePointerWrite = (w: ReturnType<typeof world>) =>
    w.kv.data.set(KEYS.active, w.kv.data.get(KEYS.active) === "a" ? "b" : "a");

  // A4 (GM2-3): this test pinned the owner's cost for a reset whose cleanup had finished. A reset now runs the cleanup
  // (its old wrap in the other slot opened the data with the old password or code, P-5), which puts the new keyring in
  // both slots, so a lost pointer write rolls nothing back any more: strictly better. The cost itself is unchanged where
  // FIXa2 can still see a difference, a reset whose cleanup did not run, and the second test pins that (a same-key
  // case, so FIXa2 comparing key ids instead of keyrings, mutant X3, is still caught).
  it("a password reset whose cleanup finished, then a lost pointer write: nothing is rolled back; the new password and code work, the old ones do not", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    for (const n of ["GitHub", "AWS"]) await w.add(w.svc(), n);
    await w.svc().lock();
    const r2 = await resetWithCode(w.svc(), r1, STRONG2); // shown to the user: success
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false); // the cleanup finished
    losePointerWrite(w);
    await w.store().selfCheck(); // the next browser start
    const k = (await active(w.kv)).keyring;
    await expect(unlockWithPassword(k, STRONG2)).resolves.toBeDefined(); // the new password
    await expect(unlockWithRecoveryCode(k, r2)).resolves.toBeDefined(); // the code shown with it
    await expect(unlockWithPassword(k, STRONG)).rejects.toThrow(); // the old password no longer works
    await expect(unlockWithRecoveryCode(k, r1)).rejects.toThrow(); // nor the old code
    await w.svc().unlockWithPassword(STRONG2);
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]); // no account lost
  });

  it("the cost (owner's decision): a password reset the user saw succeed, whose cleanup had not run and whose pointer write the disk then lost, is rolled back; the old password and recovery code open the vault; nothing is lost", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    for (const n of ["GitHub", "AWS"]) await w.add(w.svc(), n);
    await w.svc().lock();
    // The cleanup fails on its first read of the slot that still holds the old keyring (logged, retried later). The reset
    // itself reads that slot twice before it commits, as the active one (once to prepare, once inside the transact).
    const oldSlot = KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"];
    const r2 = await resetWithCode(w.svc(failNthRead(w.kv, oldSlot, 3)), r1, STRONG2); // success
    await expect(
      unlockWithRecoveryCode((await checkGeneration(w.kv.data.get(oldSlot)))!.keyring, r1),
    ).resolves.toBeDefined(); // the old wrap is still there
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    losePointerWrite(w);
    await w.store().selfCheck(); // the next browser start
    const k = (await active(w.kv)).keyring;
    await expect(unlockWithPassword(k, STRONG)).resolves.toBeDefined(); // the old password
    await expect(unlockWithRecoveryCode(k, r1)).resolves.toBeDefined(); // the old recovery code
    await expect(unlockWithPassword(k, STRONG2)).rejects.toThrow(); // the new password no longer works
    await expect(unlockWithRecoveryCode(k, r2)).rejects.toThrow(); // nor the code shown with it
    await w.svc().lock();
    await w.svc().unlockWithPassword(STRONG);
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]); // no account lost
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });

  it("the cost, for a key rotation whose cleanup had not finished: rolled back to the old key; old password and code work; nothing is lost", async () => {
    const w = world();
    const { recoveryCode: r1 } = await createProtected(w.svc());
    for (const n of ["GitHub", "AWS"]) await w.add(w.svc(), n);
    const before = (await active(w.kv)).keyring.vkId;
    // The rotation succeeds and shows its code, but its cleanup fails on its first read, of the slot that still holds
    // the old key (logged, retried later). So that slot still holds it, and a lost pointer write points at it. (The
    // rotation itself reads that slot once, as the active one, before it commits.)
    const oldSlot = KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"];
    const r2 = await codeOf((d) => w.svc(failNthRead(w.kv, oldSlot, 2)).rotateKey(STRONG, d));
    expect((await checkGeneration(w.kv.data.get(oldSlot)))!.keyring.vkId).toBe(before);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    losePointerWrite(w);
    await w.store().selfCheck();
    expect((await active(w.kv)).keyring.vkId).toBe(before);
    await expect(unlockWithRecoveryCode((await active(w.kv)).keyring, r1)).resolves.toBeDefined();
    await expect(unlockWithRecoveryCode((await active(w.kv)).keyring, r2)).rejects.toThrow();
    await w.svc().lock();
    await w.svc().unlockWithPassword(STRONG); // the password itself did not change; the cleanup runs under the old key
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

// ---- P-2: a failed read of the snapshot index during a save --------------------------------------------------------------

describe("P-2: a read of the snapshot index that fails during a save costs no history", () => {
  it("the save succeeds without its snapshot; the index and every record are kept, also after a browser restart", async () => {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe", "Bank"]) await w.add(w.svc(), n);
    await new VaultStore({
      lock: createMutex(),
      kv: w.kv,
      mirror: w.mirror,
      now: () => w.t.now,
      dayKey: () => "2026-01-01",
    }).ensureDailySnapshot();
    const before = parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))
      .map((m) => m.id)
      .sort();
    expect(before.length).toBeGreaterThanOrEqual(5);
    await w.add(w.svc(failNthRead(w.kv, KEYS.snapIndex, 1)), "Mail");
    expect(aliveEntries((await w.svc().read()).vault).map((e) => e.issuer)).toContain("Mail");
    expect(
      parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))
        .map((m) => m.id)
        .sort(),
    ).toEqual(before);
    await w.store().selfCheck();
    expect(snapRecords(w.kv).length).toBe(before.length);
  });

  it("a lost or damaged index: the self-check lists the valid records again instead of deleting them, and removes only damaged ones", async () => {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    const ids = parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))
      .map((m) => m.id)
      .sort();
    w.kv.data.set(KEYS.snapIndex, "garbage");
    w.kv.data.set(KEYS.snap("rGHOST"), { v: 1 }); // damaged
    await w.store().selfCheck();
    expect(
      parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))
        .map((m) => m.id)
        .sort(),
    ).toEqual(ids);
    expect(w.kv.data.has(KEYS.snap("rGHOST"))).toBe(false);
  });
});

// ---- P-3 and P-7: purgeForever ------------------------------------------------------------------------------------------

describe("P-3 / P-7: purgeForever and the snapshots", () => {
  async function pendingKeyChange() {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe"]) await w.add(w.svc(), n);
    const preIdx = parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex));
    const preRecs = new Map(preIdx.map((m) => [m.id, structuredClone(w.kv.data.get(KEYS.snap(m.id)))]));
    await w.svc().rotateKey(STRONG, NO_PAGE);
    // the pre-rotation snapshots back under new ids, with the marker: a crash after the commit, before the cleanup
    const planted = preIdx.map((m) => ({ ...m, id: `${m.id}x` }));
    for (const m of planted) {
      const rec = structuredClone(preRecs.get(m.id.slice(0, -1))) as { meta: { id: string } };
      rec.meta.id = m.id;
      w.kv.data.set(KEYS.snap(m.id), rec);
    }
    w.kv.data.set(KEYS.snapIndex, [...parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)), ...planted]);
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await active(w.kv)).keyring.vkId, at: 1 });
    return { w, planted: planted.map((m) => m.id) };
  }

  it("P-7: old-key snapshots waiting for the cleanup are purged and moved to the current key, not dropped", async () => {
    const { w, planted } = await pendingKeyChange();
    const id = aliveEntries((await w.svc().read()).vault)[0]!.id;
    await w.svc().purgeForever([id], STRONG);
    const current = (await active(w.kv)).keyring.vkId;
    const idx = parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)).map((m) => m.id);
    expect(planted.every((x) => idx.includes(x))).toBe(true);
    for (const x of planted) expect((await checkSnapshot(w.kv.data.get(KEYS.snap(x))))!.envelope.vkId).toBe(current);
  });

  it("P-3: a read of the index that fails during purgeForever fails the purge; the index is kept, and a retry finishes", async () => {
    const w = world();
    await createProtected(w.svc());
    for (const n of ["GitHub", "AWS", "Stripe", "Bank"]) await w.add(w.svc(), n);
    const id = aliveEntries((await w.svc().read()).vault)[0]!.id;
    // read 1 of the index: the rolling snapshot of the purge's own save; read 2: the rewrite of every snapshot
    await expect(w.svc(failNthRead(w.kv, KEYS.snapIndex, 2)).purgeForever([id], STRONG)).rejects.toThrow(
      "IO error: transient",
    );
    const idx = parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex));
    expect(idx.length).toBeGreaterThanOrEqual(5);
    await w.store().selfCheck();
    expect(snapRecords(w.kv).length).toBe(idx.length);
    await w.svc().purgeForever([id], STRONG); // the retry
    const k = (await active(w.kv)).keyring;
    const vk = await unlockWithPassword(k, STRONG);
    const { decryptVault } = await import("../../src/core/crypto/envelope");
    const { deserializeVault } = await import("../../src/core/vault/validate");
    for (const m of parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))) {
      const v = deserializeVault(
        await decryptVault((await checkSnapshot(w.kv.data.get(KEYS.snap(m.id))))!.envelope, vk),
      );
      expect(v.entries.find((e) => e.id === id)?.secret ?? "", m.id).toBe("");
    }
  });
});

// ---- P-4: recover() and a read that throws ---------------------------------------------------------------------------------

describe("P-4: a read that throws during recovery is reported, not turned into 'lost'", () => {
  it("both slots and the keyring copy damaged, one transient mirror read error: an error to retry, then the vault", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    w.kv.data.set(KEYS.slot.a, "garbage");
    w.kv.data.set(KEYS.slot.b, "garbage");
    w.kv.data.delete(KEYS.keyringCopy);
    const flaky = failNthRead(w.mirror, KEYS.mirrorGen, 1);
    await expect(w.svc(w.kv, flaky).openView()).rejects.toThrow("IO error: transient"); // the popup: error screen with Retry
    expect(w.kv.data.get(KEYS.slot.a)).toBe("garbage"); // nothing was repaired over it
    const v = await w.svc(w.kv, flaky).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub"]);
  });

  it("when another source still opens the vault, a failing mirror does not stop the recovery", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    w.kv.data.set(KEYS.slot.a, "garbage");
    w.kv.data.set(KEYS.slot.b, "garbage");
    const broken = wrap(w.mirror, {
      get: async () => {
        throw new Error("Internal error opening backing store");
      },
    });
    const v = await w.svc(w.kv, broken).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["GitHub"]);
  });
});

// ---- P-6: a vault made over lost data ---------------------------------------------------------------------------------------

describe("P-6: after restoreBackup over lost data, the new vault keeps its snapshots from the first save on", () => {
  it("its save counter starts above the old snapshots, so they no longer take the places", async () => {
    const w = world();
    const { keyring, vk } = await createKeyring();
    const env = await encryptVault(serializeVault(emptyVault(keyring.vaultId)), vk, {
      vaultId: keyring.vaultId,
      rev: 40,
    });
    w.kv.data.set(KEYS.active, "a");
    w.kv.data.set(KEYS.slot.a, tear({ v: 1, seq: 41, keyring }));
    w.kv.data.set(KEYS.slot.b, "garbage");
    for (let s = 31; s <= 40; s++)
      w.kv.data.set(KEYS.snap(`r${s}`), { v: 1, meta: { id: `r${s}`, kind: "rolling", at: s, seq: s }, envelope: env });
    w.kv.data.set(
      KEYS.snapIndex,
      Array.from({ length: 10 }, (_, i) => ({ id: `r${31 + i}`, kind: "rolling", at: 31 + i, seq: 31 + i })),
    );
    const svc = w.svc();
    const backup = addEntry(
      emptyVault("vault-backup-01"),
      input("Bank"),
      createClock("bbbb", { now: () => w.t.now }),
    ).vault;
    await svc.restoreBackup(backup, await svc.prepareKeys(STRONG, { vaultId: "vault-backup-01" }));
    for (const n of ["A", "B", "C"]) await w.add(w.svc(), n); // the settings page goes on (read() never runs the cleanup)
    const newVk = (await active(w.kv)).keyring.vkId;
    expect((await active(w.kv)).seq).toBeGreaterThan(40);
    const ours: string[] = [];
    for (const m of parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))) {
      const r = await checkSnapshot(w.kv.data.get(KEYS.snap(m.id)));
      if (r?.envelope.vkId === newVk) ours.push(m.id);
    }
    expect(ours.length).toBe(4); // the restore and the three saves
  });
});

// ---- A2-1: a mirror that keeps failing ------------------------------------------------------------------------------------

describe("A2-1: with an IndexedDB mirror that keeps failing, opening stays cheap; the unlock retries the mirror", () => {
  it("after a key change: every open makes the normal 4 reads; the marker says only the mirror is left; once it works, an unlock clears it", async () => {
    const kv = new MemoryKV();
    const session = new MemorySession();
    const t = { now: 1_700_000_000_000 };
    let reads = 0;
    const counted: KV = {
      get: (k) => {
        reads++;
        return kv.get(k);
      },
      keys: () => {
        reads++;
        return kv.keys();
      },
      set: (i) => kv.set(i),
      remove: (k) => kv.remove(k),
    };
    const good = new MemoryKV();
    let broken = false;
    const fail = async () => {
      throw new Error("Internal error opening backing store");
    };
    const mirror: KV = {
      get: (k) => (broken ? fail() : good.get(k)),
      keys: () => (broken ? fail() : good.keys()),
      set: (i) => (broken ? fail() : good.set(i)),
      remove: (k) => (broken ? fail() : good.remove(k)),
    };
    const svc = () =>
      new VaultService({
        store: new VaultStore({ lock: createMutex(), kv: counted, mirror, now: () => t.now }),
        session,
        settings: new KvSettingsStore(counted),
        now: () => t.now,
      });
    await createProtected(svc());
    await svc().openView(); // the one-time check
    for (let i = 0; i < 12; i++) {
      t.now += 60_000;
      await svc().mutate((v, c) => addEntry(v, input(`A${i}`), c).vault);
    }
    broken = true;
    await svc().rotateKey(STRONG, NO_PAGE);
    const current = (await active(kv)).keyring.vkId;
    expect(kv.data.get(KEYS.keyChange)).toMatchObject({ v: 1, vkId: current, mirror: true });
    expect(kv.data.get(KEYS.storeVersion)).toEqual({ v: 2, vkId: current });
    for (let i = 0; i < 3; i++) {
      reads = 0;
      expect((await svc().openView()).state).toBe("unlocked");
      expect(reads).toBeLessThanOrEqual(4);
    }
    await svc().lock();
    await svc().unlockWithPassword(STRONG); // retries the mirror: still broken
    expect(kv.data.get(KEYS.keyChange)).toMatchObject({ mirror: true });
    broken = false;
    await svc().lock();
    await svc().unlockWithPassword(STRONG);
    expect(kv.data.has(KEYS.keyChange)).toBe(false);
    expect((await checkGeneration(good.data.get(KEYS.mirrorGen)))!.keyring.vkId).toBe(current);
  });

  it("an existing user whose IndexedDB is already broken at upgrade: the one-time check finishes for this store, and opens stay cheap", async () => {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    w.kv.data.delete(KEYS.storeVersion); // as written before A2
    const broken = wrap(w.mirror, {
      get: async () => {
        throw new Error("Internal error opening backing store");
      },
      keys: async () => {
        throw new Error("x");
      },
      set: async () => {
        throw new Error("x");
      },
    });
    expect((await w.svc(w.kv, broken).openView()).state).toBe("unlocked");
    const current = (await active(w.kv)).keyring.vkId;
    expect(w.kv.data.get(KEYS.storeVersion)).toEqual({ v: 2, vkId: current });
    expect(w.kv.data.get(KEYS.keyChange)).toMatchObject({ mirror: true });
    const r = await w.store(w.kv, broken).loadView();
    expect(r.status === "ok" && r.cleanup).toBe("mirror"); // an open does nothing more; an unlock retries
  });
});

// ---- A2-3: records from a newer version ----------------------------------------------------------------------------------

describe("A2-3: snapshot records in a newer format are never deleted", () => {
  async function downgraded() {
    const w = world();
    await createProtected(w.svc());
    await w.add(w.svc(), "GitHub");
    const idx = parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex));
    const rec = structuredClone(w.kv.data.get(KEYS.snap(idx[0]!.id))) as Record<string, unknown>;
    w.kv.data.set(KEYS.snap("r900"), {
      ...rec,
      v: 2,
      meta: { id: "r900", kind: "rolling", at: 900, seq: 900 },
      extra: "field a newer version added",
    });
    w.kv.data.set(KEYS.snapIndex, [...idx, { id: "r900", kind: "rolling", at: 900, seq: 900 }]);
    w.kv.data.set(KEYS.snap("r901"), { ...rec, v: 3, meta: { id: "r901", kind: "rolling", at: 901, seq: 901 } }); // and one no index lists
    w.kv.data.set(KEYS.storeVersion, { v: 3, vkId: "whatever-a-newer-version-writes" });
    return w;
  }

  it("after a downgrade, unlocking (no cleanup is started by a newer sk_store_v) keeps them, and sk_store_v is left alone", async () => {
    const w = await downgraded();
    await w.svc().lock();
    await w.svc().unlockWithPassword(STRONG);
    await w.svc().unlockWithPassword(STRONG);
    expect(w.kv.data.has(KEYS.snap("r900"))).toBe(true);
    expect(w.kv.data.has(KEYS.snap("r901"))).toBe(true);
    expect(w.kv.data.get(KEYS.storeVersion)).toEqual({ v: 3, vkId: "whatever-a-newer-version-writes" });
  });

  it("a key change made after the downgrade still cleans up, and still keeps them", async () => {
    const w = await downgraded();
    await w.svc().rotateKey(STRONG, NO_PAGE);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(w.kv.data.has(KEYS.snap("r900"))).toBe(true);
    expect(w.kv.data.has(KEYS.snap("r901"))).toBe(true);
    expect(parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)).map((m) => m.id)).toContain("r900");
    expect(w.kv.data.get(KEYS.storeVersion)).toEqual({ v: 3, vkId: "whatever-a-newer-version-writes" });
    await w.store().selfCheck(); // and the self-check's orphan pass leaves the unlisted one too
    expect(w.kv.data.has(KEYS.snap("r901"))).toBe(true);
  });
});
