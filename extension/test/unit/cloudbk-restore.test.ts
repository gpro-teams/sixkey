// Restoring from the cloud backup (CLOUDBK patch 1; src/core/cloud/restore.ts): one secret, every file it opens, merged
// by vault with the merge sync uses, so the forks the write rule makes come back as one vault and nothing is lost; and a
// keyring that never takes back a secret another computer replaced (review r2: CB-02, CB-03, CB-06, CB-09, CB-12).
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fromB64, sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import {
  changePassword,
  openWithPassword,
  rekey,
  setRecovery,
  unlockWithRecoveryCode,
  type Keyring,
} from "../../src/core/crypto/keyring";
import { makeCloudBackup, type CloudBackup } from "../../src/core/cloud/format";
import { openCloudBackups, type CloudCandidate, type CloudSecret } from "../../src/core/cloud/restore";
import type { Generation } from "../../src/core/storage/format";
import { createClock, parseHlc } from "../../src/core/vault/hlc";
import { canonicalJson, mergeVaults } from "../../src/core/vault/merge";
import { aliveEntries, isAlive, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";
import { account, candidate, PASSWORD, protectedKeys, seal, T0, vaultOf, type Keys } from "../helpers/cloud";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";

const DEVICE = "restored1";
const OPTS = { now: T0 + 3_600_000, device: DEVICE };
const NEW_PASSWORD = "a-new-master-password-77";

let a: Keys; // the vault's keys
let c: Keys; // another vault's, with the same master password
let base: Vault; // GitHub and AWS, on device A
let laterA: Vault; // A deleted AWS since
let forkB: Vault; // B (restored from `base`) added GitLab
let fA: CloudBackup;
let fB: CloudBackup;
let fBase: CloudBackup;
let other: CloudBackup; // vault c: Dropbox

const issuers = (v: Vault) =>
  aliveEntries(v)
    .map((e) => e.issuer)
    .sort();
const backup = async (keys: Keys, v: Vault, seq: number, opens: "both" | "recovery" = "both") =>
  makeCloudBackup(await seal(keys, v, seq, T0 + seq), opens, "test");
/** A file of vault `keys` sealed under another keyring of the same vault key. */
const backupWith = async (keys: Keys, keyring: Keyring, v: Vault, seq: number) =>
  makeCloudBackup(await seal({ ...keys, keyring }, v, seq, T0 + seq), "both", "test");

beforeAll(async () => {
  a = await protectedKeys();
  c = await protectedKeys();
  const clockA = createClock("deviceaa", { now: () => T0 });
  base = vaultOf(
    a.keyring.vaultId,
    [account("GitHub", "JBSWY3DPEHPK3PXP"), account("AWS", "GEZDGNBVGY3TQOJQ")],
    clockA,
  );
  const aws = base.entries.find((e) => e.issuer === "AWS")!;
  laterA = deleteEntry(base, aws.id, createClock("deviceaa", { now: () => T0 + 2_000 }));
  forkB = addEntry(
    base,
    account("GitLab", "MFRGGZDFMZTWQ2LK"),
    createClock("devicebb", { now: () => T0 + 1_000 }),
  ).vault;
  fBase = await backup(a, base, 3);
  fA = await backup(a, laterA, 4);
  fB = await backup(a, forkB, 2);
  other = await backup(c, vaultOf(c.keyring.vaultId, [account("Dropbox", "KRSXG5CTMVRXEZLU")]), 5);
});

afterEach(() => vi.restoreAllMocks());

/** openCloudBackups, with "opened nothing" as an assertion (so a test fails on an assertion, not on a throw). */
async function restore(...args: Parameters<typeof openCloudBackups>) {
  const r = await openCloudBackups(...args);
  expect(r, "the secret opened nothing").not.toBeNull();
  return r!;
}
/** The vault key id a secret gets from a keyring, or the error's code. */
async function keyOf(keyring: Keyring, secret: CloudSecret): Promise<string> {
  try {
    if ("password" in secret) return (await openWithPassword(keyring, secret.password)).vk.id;
    return (await unlockWithRecoveryCode(keyring, secret.recoveryKey)).id;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

const pbkdf2Calls = () => {
  const spy = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
  return () => spy.mock.calls.filter(([alg]) => (alg as { name?: string }).name === "PBKDF2").length;
};

describe("one file", () => {
  it("opens with the master password: the same vault, the same keys, and the spelling that opened it", async () => {
    const r = (await restore([candidate("fBase", fBase)], { password: PASSWORD }, OPTS))!;
    expect(canonicalJson(r.vault)).toBe(canonicalJson(base));
    expect(r.keyring).toEqual(a.keyring);
    expect(r.vk.id).toBe(a.vk.id);
    expect(r.base.id).toBe("fBase");
    expect(r.merged).toEqual(["fBase"]);
    expect(r.password).toBe(PASSWORD);
    expect(r).toMatchObject({ skipped: [], outdated: false, needsPassword: false, olderKeys: 0 });
  });

  it("opens with the recovery key, a file for both and a recovery-only one alike; the master password goes on", async () => {
    const onlyRecovery = await backup(a, base, 3, "recovery");
    const r = (await restore(
      [candidate("both", fBase, T0), candidate("rec", onlyRecovery, T0 + 1)],
      { recoveryKey: a.recoveryCode },
      OPTS,
    ))!;
    expect(r.merged).toEqual(["rec", "both"]);
    expect(issuers(r.vault)).toEqual(["AWS", "GitHub"]);
    expect(r.password).toBeUndefined();
    // the copy's master password goes on (the owner's report of 2026-11-18): its wrap is kept beside the recovery wrap
    expect(r.needsPassword).toBe(false);
    expect(r.keepsPassword).toBe(true);
    expect(r.keyring.wraps.map((w) => w.method).sort()).toEqual(["password", "recovery"]);
    expect(await keyOf(r.keyring, { password: PASSWORD })).toBe(a.vk.id);
    // a copy with no password wrap at all: a new master password must be set
    const r2 = (await restore([candidate("rec", onlyRecovery, T0 + 1)], { recoveryKey: a.recoveryCode }, OPTS))!;
    expect(r2.needsPassword).toBe(true);
    expect(r2.keepsPassword).toBe(false);
    expect(r2.keyring.wraps.map((w) => w.method)).toEqual(["recovery"]);
  });

  it("a password does not open a recovery-only file alone: nothing opened is null", async () => {
    const onlyRecovery = await backup(a, base, 3, "recovery");
    expect(await openCloudBackups([candidate("rec", onlyRecovery)], { password: PASSWORD }, OPTS)).toBeNull();
  });

  it("a wrong password or recovery key opens nothing; an empty password or a malformed key is the secret's mistake", async () => {
    expect(await openCloudBackups([candidate("x", fBase)], { password: "not the password 1" }, OPTS)).toBeNull();
    // another keyring's recovery key: well formed, and it opens nothing here
    expect(await openCloudBackups([candidate("x", fBase)], { recoveryKey: c.recoveryCode }, OPTS)).toBeNull();
    await expect(openCloudBackups([candidate("x", fBase)], { password: "" }, OPTS)).rejects.toMatchObject({
      code: "empty_password",
    });
    await expect(openCloudBackups([candidate("x", fBase)], { recoveryKey: "ABC" }, OPTS)).rejects.toMatchObject({
      code: "recovery_length",
    });
  });
});

describe("several files of one vault", () => {
  it("merges forks: every device's accounts, and a later deletion beats an older file", async () => {
    const r = (await restore(
      [candidate("fB", fB, T0 + 10), candidate("fA", fA, T0 + 20), candidate("fBase", fBase, T0 + 5)],
      { password: PASSWORD },
      OPTS,
    ))!;
    expect(r.merged).toEqual(["fA", "fB", "fBase"]);
    expect(issuers(r.vault)).toEqual(["GitHub", "GitLab"]); // AWS was deleted on A after the copy B and fBase hold
    expect(canonicalJson(r.vault)).toBe(canonicalJson(mergeVaults(mergeVaults(laterA, forkB), base)));
  });

  it("opens a wrap that several files share once (one key derivation for one keyring)", async () => {
    const count = pbkdf2Calls();
    const r = await restore(
      [candidate("fA", fA, 3), candidate("fB", fB, 2), candidate("fBase", fBase, 1)],
      { password: PASSWORD },
      OPTS,
    );
    expect(r.merged).toHaveLength(3);
    expect(count()).toBe(1);
  });

  it("opens a fork whose wrap the password no longer fits with the vault key in hand (CB-06)", async () => {
    const changed = await changePassword(a.keyring, a.vk, NEW_PASSWORD, { iterations: TEST_KDF_ITERATIONS });
    const newFile = await backupWith(a, changed, laterA, 9); // A changed its password since
    const r = (await restore(
      [candidate("new", newFile, T0 + 50), candidate("oldFork", fB, T0 + 10)], // B's fork: the old password's wrap
      { password: NEW_PASSWORD },
      OPTS,
    ))!;
    expect(r.skipped).toEqual([]);
    expect(r.merged).toEqual(["new", "oldFork"]);
    expect(issuers(r.vault)).toEqual(["GitHub", "GitLab"]); // GitLab is only in the old fork
  });

  it("clamps every file's timestamps, not only the newest's (CB-12)", async () => {
    const far = T0 + 400 * 86_400_000;
    const future = addEntry(
      base,
      account("Future", "ONSWG4TFORXXEZLU"),
      createClock("devicecc", { now: () => far }),
    ).vault;
    const r = (await restore(
      [candidate("newest", fA, T0 + 90), candidate("older", await backup(a, future, 9), T0 + 10)],
      { password: PASSWORD },
      OPTS,
    ))!;
    const e = r.vault.entries.find((x) => x.issuer === "Future")!;
    expect(isAlive(e)).toBe(true);
    expect(parseHlc(e.hlc)!.wall).toBeLessThanOrEqual(OPTS.now + 86_400_000);
  });

  it("skips a file whose keys open but whose data does not, or is another vault's, or a later schema's", async () => {
    // the header's revision changed with a checksum that fits: the store's checks pass, the authenticated data does not
    const g = await seal(a, base, 3);
    const swapped: Generation = { ...g, envelope: { ...g.envelope, rev: g.envelope.rev + 1 } };
    const e = swapped.envelope;
    e.checksum = toB64(
      await sha256(utf8(`sixkey-vault|1|${e.vaultId}|${e.vkId}|${e.rev}`), fromB64(e.iv), fromB64(e.ciphertext)),
    );
    const notMine = vaultOf(c.keyring.vaultId, [account("Elsewhere", "MZXW6YTBOJUWU23M")]);
    const foreign: Generation = {
      ...g,
      envelope: await encryptVault(serializeVault(notMine), a.vk, { vaultId: a.keyring.vaultId, rev: 3 }),
    };
    const later = utf8(JSON.stringify({ schemaVersion: 2, vaultId: a.keyring.vaultId, entries: [] }));
    const newer: Generation = {
      ...g,
      envelope: await encryptVault(later, a.vk, { vaultId: a.keyring.vaultId, rev: 3 }),
    };
    const files: CloudCandidate[] = [
      candidate("swapped", await makeCloudBackup(swapped, "both", "t"), T0 + 4),
      candidate("foreign", await makeCloudBackup(foreign, "both", "t"), T0 + 3),
      candidate("newer", await makeCloudBackup(newer, "both", "t"), T0 + 2),
      candidate("good", fBase, T0 + 1),
    ];
    const r = (await restore(files, { password: PASSWORD }, OPTS))!;
    expect(r.merged).toEqual(["good"]);
    expect(r.skipped).toEqual([
      { id: "swapped", why: "damaged" },
      { id: "foreign", why: "damaged" },
      { id: "newer", why: "newer" },
    ]);
  });
});

describe("several vaults (CB-02)", () => {
  it("merges each vault first, so an account deleted in a vault's newer fork stays deleted whichever vault is newest", async () => {
    for (const times of [
      { fA: T0 + 30, other: T0 + 20, fBase: T0 + 5 }, // vault a newest
      { fA: T0 + 20, other: T0 + 30, fBase: T0 + 5 }, // vault c newest
    ]) {
      const r = (await restore(
        [candidate("fA", fA, times.fA), candidate("other", other, times.other), candidate("fBase", fBase, times.fBase)],
        { password: PASSWORD },
        OPTS,
      ))!;
      expect(issuers(r.vault), JSON.stringify(times)).toEqual(["Dropbox", "GitHub"]); // AWS stays deleted
    }
  });

  it("the newest file's vault is the base; another vault's live accounts come as new entries, skipping those there", async () => {
    const theirs = vaultOf(c.keyring.vaultId, [
      account("Dropbox", "KRSXG5CTMVRXEZLU"),
      account("GitHub", "JBSWY3DPEHPK3PXP"),
    ]);
    const r = (await restore(
      [candidate("mine", fBase, T0 + 9), candidate("other", await backup(c, theirs, 5), T0 + 1)],
      { password: PASSWORD },
      OPTS,
    ))!;
    expect(r.vault.vaultId).toBe(a.keyring.vaultId);
    expect(issuers(r.vault)).toEqual(["AWS", "Dropbox", "GitHub"]);
    const dropbox = r.vault.entries.find((e) => e.issuer === "Dropbox")!;
    expect(theirs.entries.some((e) => e.id === dropbox.id)).toBe(false); // a new entry, with a new id
    expect(parseHlc(dropbox.hlc)!.device).toBe(DEVICE);
  });

  it("does not bring back as new an account that sits in the base vault's trash (CB-12)", async () => {
    const theirs = vaultOf(c.keyring.vaultId, [account("AWS", "GEZDGNBVGY3TQOJQ")]); // AWS alive in vault c
    const r = (await restore(
      [candidate("mine", fA, T0 + 9), candidate("other", await backup(c, theirs, 5), T0 + 1)], // AWS in a's trash
      { password: PASSWORD },
      OPTS,
    ))!;
    expect(issuers(r.vault)).toEqual(["GitHub"]);
    expect(r.vault.entries.filter((e) => e.issuer === "AWS")).toHaveLength(1);
  });
});

describe("the restored keyring (CB-03)", () => {
  it("a password restore takes the recovery key renewed on another computer, never the one it retired", async () => {
    const v = vaultOf(a.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]);
    const renewed = await setRecovery(a.keyring, a.vk, { now: () => T0 + 100_000 }); // computer A: a new recovery key
    const fileA = await backupWith(a, renewed.keyring, v, 5);
    const fileB = await backup(a, v, 3); // computer B: still the old keyring
    const r = (await restore(
      [candidate("A", fileA, T0 + 10), candidate("B", fileB, T0 + 20)], // B written last
      { password: PASSWORD },
      OPTS,
    ))!;
    expect(r.base.id).toBe("B");
    expect(r.outdated).toBe(false);
    expect(await keyOf(r.keyring, { recoveryKey: renewed.recoveryCode })).toBe(a.vk.id);
    expect(await keyOf(r.keyring, { recoveryKey: a.recoveryCode })).toBe("unwrap_failed");
    expect(await keyOf(r.keyring, { password: PASSWORD })).toBe(a.vk.id);
  });

  it("a recovery-key restore keeps the newest password wrap: the password changed elsewhere goes on, the old one opens nothing", async () => {
    const v = vaultOf(a.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]);
    const changed = await changePassword(a.keyring, a.vk, NEW_PASSWORD, {
      iterations: TEST_KDF_ITERATIONS,
      now: () => T0 + 100_000,
    });
    const fileA = await backupWith(a, changed, v, 5);
    const fileB = await backup(a, v, 3);
    const r = (await restore(
      [candidate("A", fileA, T0 + 10), candidate("B", fileB, T0 + 20)],
      { recoveryKey: a.recoveryCode },
      OPTS,
    ))!;
    expect(r.needsPassword).toBe(false);
    expect(r.keepsPassword).toBe(true);
    expect(r.keyring.wraps.map((w) => w.method).sort()).toEqual(["password", "recovery"]);
    expect(await keyOf(r.keyring, { password: PASSWORD })).toBe("unwrap_failed");
    expect(await keyOf(r.keyring, { password: NEW_PASSWORD })).toBe(a.vk.id);
  });

  it("a password older than another computer's restores, says so, and the restored keyring keeps it (R2-04)", async () => {
    const changed = await changePassword(a.keyring, a.vk, NEW_PASSWORD, {
      iterations: TEST_KDF_ITERATIONS,
      now: () => T0 + 100_000,
    });
    const fileA = await backupWith(a, changed, laterA, 9); // the newest file, under the new password only
    const r = (await restore(
      [candidate("A", fileA, T0 + 50), candidate("B", fB, T0 + 10)], // B: the old password's wrap
      { password: PASSWORD },
      OPTS,
    ))!;
    // the old password found the key in B's file; the key opened A's newer file too
    expect(r.merged).toEqual(["A", "B"]);
    expect(issuers(r.vault)).toEqual(["GitHub", "GitLab"]);
    // a password dated later exists: said, and the page offers a new one (patch 5); the user is never locked out
    expect(r.outdated).toBe(true);
    expect(r.password).toBe(PASSWORD);
    expect(await keyOf(r.keyring, { password: PASSWORD })).toBe(a.vk.id);
    expect(await keyOf(r.keyring, { password: NEW_PASSWORD })).toBe("unwrap_failed");
    expect(r.keyring.wraps.map((w) => w.method).sort()).toEqual(["password", "recovery"]);
  });

  it("a computer whose clock ran ahead cannot lock a password restore out: the typed password's wrap is kept", async () => {
    const v = vaultOf(a.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]);
    // the old password and recovery key, written by a computer whose clock was a day ahead
    const ahead: Keyring = { ...a.keyring, wraps: a.keyring.wraps.map((w) => ({ ...w, createdAt: T0 + 86_400_000 })) };
    const changed = await changePassword(a.keyring, a.vk, NEW_PASSWORD, {
      iterations: TEST_KDF_ITERATIONS,
      now: () => T0 + 1_000,
    });
    const r = (await restore(
      [
        candidate("new", await backupWith(a, changed, v, 5), T0 + 20),
        candidate("old", await backupWith(a, ahead, v, 3), T0 + 10),
      ],
      { password: NEW_PASSWORD },
      OPTS,
    ))!;
    expect(r.outdated).toBe(true); // a password wrap dated later exists, so the page says so
    expect(await keyOf(r.keyring, { password: NEW_PASSWORD })).toBe(a.vk.id); // the one typed opens what was restored
    expect(await keyOf(r.keyring, { password: PASSWORD })).toBe("unwrap_failed");
    expect(r.password).toBe(NEW_PASSWORD);
  });

  it("takes the newest key, not the key of the file Drive changed last, and never a wrap of another key (R2-03)", async () => {
    // A rotated the vault key (VK2) and then changed its password; B, sync off, kept the old key (VK1), renewed its
    // recovery key in between, and wrote last
    const r1 = await rekey(a.keyring, a.vk, PASSWORD, { iterations: TEST_KDF_ITERATIONS, now: () => T0 + 1_000 });
    const vk2 = await changePassword(r1.keyring, r1.vk, PASSWORD, {
      iterations: TEST_KDF_ITERATIONS,
      now: () => T0 + 3_000,
    });
    const envelope = await encryptVault(serializeVault(laterA), r1.vk, { vaultId: vk2.vaultId, rev: 8 });
    const fileA = await makeCloudBackup({ v: 1, seq: 8, savedAt: T0 + 8, envelope, keyring: vk2 }, "both", "t");
    const renewed = await setRecovery(a.keyring, a.vk, { now: () => T0 + 2_000 });
    const fileB = await backupWith(a, renewed.keyring, base, 3);
    const r = (await restore(
      [candidate("A", fileA, T0), candidate("B", fileB, T0 + 50)],
      { password: PASSWORD },
      OPTS,
    ))!;
    expect(r.merged).toEqual(["B", "A"]);
    expect(r.base.id).toBe("A");
    expect(r.vk.id).toBe(r1.vk.id);
    expect(r.olderKeys).toBe(1); // B's key: the page says another backup is under an older key
    expect(r.keyring.vkId).toBe(r1.vk.id);
    expect(r.keyring.previous).toEqual([]);
    expect(r.keyring.wraps.every((w) => w.vkId === r1.vk.id)).toBe(true);
    expect(await keyOf(r.keyring, { password: PASSWORD })).toBe(r1.vk.id);
    expect(await keyOf(r.keyring, { recoveryKey: r1.recoveryCode })).toBe(r1.vk.id);
    expect(await keyOf(r.keyring, { recoveryKey: renewed.recoveryCode })).not.toBe(a.vk.id);
    expect(issuers(r.vault)).toEqual(["GitHub"]); // both merged: AWS was deleted in A's newer data
  });

  it("never lands on a key another file names as retired, though the computer that kept it changed its password later (S4)", async () => {
    const v = vaultOf(a.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]);
    // A rotated (VK2, which names VK1 as retired); B kept VK1 and changed its password afterwards: B's wraps are newer
    const rot = await rekey(a.keyring, a.vk, PASSWORD, { iterations: TEST_KDF_ITERATIONS, now: () => T0 + 1_000 });
    const env2 = await encryptVault(serializeVault(v), rot.vk, { vaultId: a.keyring.vaultId, rev: 7 });
    const fileA = await makeCloudBackup(
      { v: 1, seq: 7, savedAt: T0 + 7, envelope: env2, keyring: rot.keyring },
      "both",
      "t",
    );
    expect(fileA.retired).toEqual([a.vk.id]);
    const bKeyring = await changePassword(a.keyring, a.vk, PASSWORD, {
      iterations: TEST_KDF_ITERATIONS,
      now: () => T0 + 2_000,
    });
    const fileB = await backupWith(a, bKeyring, v, 3);
    for (const times of [
      [T0 + 10, T0 + 20],
      [T0 + 20, T0 + 10],
    ]) {
      const r = await restore(
        [candidate("A", fileA, times[0]), candidate("B", fileB, times[1])],
        { password: PASSWORD },
        OPTS,
      );
      expect(r.vk.id, String(times)).toBe(rot.vk.id);
      expect(r.base.id).toBe("A");
      expect(r.olderKeys).toBe(1);
      expect(r.merged.sort()).toEqual(["A", "B"]);
    }
  });

  it("with sync off, the computer that kept the retired key wrote last: the restore still lands on the rotated key", async () => {
    const v = vaultOf(a.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]);
    const rot = await rekey(a.keyring, a.vk, PASSWORD, { iterations: TEST_KDF_ITERATIONS, now: () => T0 + 5_000 });
    const env2 = await encryptVault(serializeVault(v), rot.vk, { vaultId: a.keyring.vaultId, rev: 7 });
    const fileA = await makeCloudBackup(
      { v: 1, seq: 7, savedAt: T0 + 7, envelope: env2, keyring: rot.keyring },
      "both",
      "t",
    );
    const fileB = await backup(a, v, 3); // B: the retired key, written last
    const r = (await restore(
      [candidate("A", fileA, T0 + 10), candidate("B", fileB, T0 + 20)],
      { password: PASSWORD },
      OPTS,
    ))!;
    expect(r.merged.sort()).toEqual(["A", "B"]);
    expect(r.vk.id).toBe(rot.vk.id);
    expect(r.base.id).toBe("A");
    expect(r.olderKeys).toBe(1);
    expect(r.outdated).toBe(false);
  });
});

describe("the work a restore does (CB-09)", () => {
  it("derives within its budget, and skips a file past it as 'limit'", async () => {
    const d = await protectedKeys();
    const e = await protectedKeys();
    const files = [
      candidate("one", await backup(d, vaultOf(d.keyring.vaultId, [account("One", "JBSWY3DPEHPK3PXP")]), 1), T0 + 3),
      candidate("two", await backup(e, vaultOf(e.keyring.vaultId, [account("Two", "GEZDGNBVGY3TQOJQ")]), 1), T0 + 2),
    ];
    const count = pbkdf2Calls();
    const r = (await restore(files, { password: PASSWORD }, { ...OPTS, budget: TEST_KDF_ITERATIONS }))!;
    expect(count()).toBe(1);
    expect(r.merged).toEqual(["one"]);
    expect(r.skipped).toEqual([{ id: "two", why: "limit" }]);
    const all = (await restore(files, { password: PASSWORD }, OPTS))!;
    expect(all.merged).toEqual(["one", "two"]);
  });

  it("counts a generated-shape password's second spelling in the budget", async () => {
    const words = await protectedKeys("amber-basket-cactus-dolphin-ember");
    const file = [candidate("w", await backup(words, vaultOf(words.keyring.vaultId, []), 1))];
    const typed = { password: "Amber Basket Cactus Dolphin Ember" }; // tried as typed, then in its generator spelling
    const count = pbkdf2Calls();
    const short = await openCloudBackups(file, typed, { ...OPTS, budget: 2 * TEST_KDF_ITERATIONS - 1 });
    expect(short).toBeNull();
    expect(count()).toBe(0);
    const r = await restore(file, typed, { ...OPTS, budget: 2 * TEST_KDF_ITERATIONS });
    expect(count()).toBe(2);
    expect(r.password).toBe("amber-basket-cactus-dolphin-ember");
  });
});

describe("properties", () => {
  it("Drive's times decide the base, never the content: the same files give the same vault in any order", async () => {
    const files = [fA, fB, fBase];
    const want = canonicalJson(mergeVaults(mergeVaults(laterA, forkB), base));
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 3, maxLength: 3 }), async (times) => {
        const r = (await restore(
          files.map((f, i) => candidate(`f${i}`, f, T0 + times[i]!)),
          { recoveryKey: a.recoveryCode },
          OPTS,
        ))!;
        expect(canonicalJson(r.vault)).toBe(want);
        expect(r.merged.sort()).toEqual(["f0", "f1", "f2"]);
      }),
      { numRuns: 30 },
    );
  });

  it("two vaults: whichever file is newest, an account deleted in its vault's merge stays deleted, and every live one is there", async () => {
    const theirs = vaultOf(c.keyring.vaultId, [
      account("Dropbox", "KRSXG5CTMVRXEZLU"),
      account("Slack", "ORSXG5DJNZTSA3DP"),
    ]);
    const dropbox = theirs.entries.find((x) => x.issuer === "Dropbox")!;
    const theirsLater = deleteEntry(theirs, dropbox.id, createClock("deviceoo", { now: () => T0 + 5_000 }));
    const files = [fA, fB, fBase, await backup(c, theirs, 2), await backup(c, theirsLater, 3)];
    const merged = new Map([
      [a.keyring.vaultId, mergeVaults(mergeVaults(laterA, forkB), base)],
      [c.keyring.vaultId, mergeVaults(theirs, theirsLater)],
    ]);
    const live = [...merged.values()].flatMap((v) => aliveEntries(v).map((e) => e.issuer)).sort();
    expect(live).toEqual(["GitHub", "GitLab", "Slack"]); // AWS and Dropbox were deleted in their vaults' newer forks
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 5, maxLength: 5 }), async (times) => {
        const r = (await restore(
          files.map((f, i) => candidate(`f${i}`, f, T0 + times[i]!)),
          { password: PASSWORD },
          OPTS,
        ))!;
        expect(issuers(r.vault)).toEqual(live);
        const baseVault = r.base.backup.generation.keyring.vaultId;
        expect(r.vault.vaultId).toBe(baseVault);
        // the base vault's own entries are exactly its files' merge, its trash included
        for (const e of merged.get(baseVault)!.entries) expect(r.vault.entries.find((x) => x.id === e.id)).toEqual(e);
      }),
      { numRuns: 12 },
    );
  });
});
