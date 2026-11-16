// The service's two calls for the cloud backup's pages (CLOUDBK patch 5; src/core/service/service.ts): the keys of a
// vault restored from the cloud (the restored keyring and vault key as they are, a new master password for a recovery
// restore, never a keyring with no password), written by restoreBackup and opened with what was typed; and this vault's
// earlier backup files opened with the keys held here, for a page to merge before the worker deletes them.
import { beforeAll, describe, expect, it } from "vitest";
import { openWithPassword, removeMethod } from "../../src/core/crypto/keyring";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { aliveEntries } from "../../src/core/vault/model";
import { account, PASSWORD, protectedKeys, seal, vaultOf, type Keys } from "../helpers/cloud";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";

const T0 = 1_900_000_000_000;
const NEW_PASSWORD = "lantern-orchid-basalt-77";
function service() {
  const kv = new MemoryKV();
  const svc = new VaultService({
    store: new VaultStore({ lock: createMutex(), kv, now: () => T0 }),
    session: new MemorySession(),
    settings: new KvSettingsStore(kv),
    now: () => T0,
    kdfIterations: TEST_KDF_ITERATIONS,
  });
  return { kv, svc };
}

let keys: Keys;
let other: Keys;
beforeAll(async () => {
  keys = await protectedKeys();
  other = await protectedKeys();
});
const vault = (k: Keys, ...names: string[]) =>
  vaultOf(
    k.keyring.vaultId,
    names.map((n, i) => account(n, `JBSWY3DPEHPK3PX${"ABCDEFGHIJ"[i]}`)),
  );

describe("the keys of a restore from the cloud (prepareRestoredKeys)", () => {
  it("a password restore keeps the keyring as restored: the typed password and the recovery key open the vault", async () => {
    const { svc } = service();
    const k = await svc.prepareRestoredKeys(keys.keyring, keys.vk, { typed: PASSWORD });
    expect(k.recoveryCode).toBe(""); // no new recovery key
    await svc.restoreBackup(vault(keys, "GitHub"), k, {});
    const gen = (await svc.currentGeneration())!;
    expect(gen.keyring.wraps).toEqual(keys.keyring.wraps);
    expect((await openWithPassword(gen.keyring, PASSWORD)).vk.id).toBe(keys.vk.id);
    expect(aliveEntries((await svc.read()).vault).map((e) => e.issuer)).toEqual(["GitHub"]);
  });

  it("a recovery restore is the reset: the new master password opens it, the recovery wrap stays, no new code", async () => {
    const { svc } = service();
    const onlyRecovery = removeMethod(keys.keyring, "password");
    const k = await svc.prepareRestoredKeys(onlyRecovery, keys.vk, { newPassword: NEW_PASSWORD });
    expect(k.recoveryCode).toBe("");
    await svc.restoreBackup(vault(keys, "GitHub"), k, {});
    const gen = (await svc.currentGeneration())!;
    expect((await openWithPassword(gen.keyring, NEW_PASSWORD)).vk.id).toBe(keys.vk.id);
    expect(gen.keyring.wraps.find((w) => w.method === "recovery")).toEqual(
      keys.keyring.wraps.find((w) => w.method === "recovery"),
    );
  });

  it("refused: a keyring with no password and none given, a vault key not the keyring's, a new password below the floor", async () => {
    const { svc } = service();
    const onlyRecovery = removeMethod(keys.keyring, "password");
    await expect(svc.prepareRestoredKeys(onlyRecovery, keys.vk, { typed: PASSWORD })).rejects.toMatchObject({
      code: "bad_state",
    });
    await expect(svc.prepareRestoredKeys(keys.keyring, other.vk, { typed: PASSWORD })).rejects.toMatchObject({
      code: "bad_state",
    });
    await expect(svc.prepareRestoredKeys(onlyRecovery, keys.vk, { newPassword: "1234" })).rejects.toThrow();
  });
});

describe("this vault's earlier files, opened for a merge (openOwnGenerations)", () => {
  it("opens this vault's generations under the key held here; another vault's, or one that does not read, is null", async () => {
    const { svc } = service();
    const k = await svc.prepareRestoredKeys(keys.keyring, keys.vk, { typed: PASSWORD });
    await svc.restoreBackup(vault(keys, "GitHub"), k, {});
    const mine = await seal(keys, vault(keys, "GitLab"), 4);
    const theirs = await seal(other, vault(other, "Gitea"), 4);
    const broken = { ...mine, envelope: { ...mine.envelope, ciphertext: mine.envelope.ciphertext.slice(4) + "AAAA" } };
    // one whose keyring names another vault, though its envelope opens with the key held here: not this vault's
    const named = { ...mine, keyring: { ...mine.keyring, vaultId: other.keyring.vaultId } };
    const out = await svc.openOwnGenerations([mine, theirs, broken, named]);
    expect(out[0] && aliveEntries(out[0]).map((e) => e.issuer)).toEqual(["GitLab"]);
    expect(out.slice(1)).toEqual([null, null, null]);
  });

  it("needs the vault: none here is refused", async () => {
    const { svc } = service();
    await expect(svc.openOwnGenerations([])).rejects.toMatchObject({ code: "bad_state" });
  });
});
