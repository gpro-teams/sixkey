// Review: attempts to break header/AAD binding and KDF-parameter handling. These are expected to PASS (invariants held).
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, isEnvelopeIntact } from "../../src/core/crypto/envelope";
import {
  createKeyring,
  enableMasterPassword,
  unlockWithPassword,
  unlockWithRecoveryCode,
  validateKeyring,
} from "../../src/core/crypto/keyring";
import { PBKDF2_MAX_ITERATIONS } from "../../src/core/crypto/kdf";
import { createBackup, openBackup } from "../../src/core/backup/backup";
import { emptyVault } from "../../src/core/vault/model";

const PW = "tulip-orbit-lantern-84";

describe("vault envelope", () => {
  it("every header field is bound: changing vaultId, vkId, rev, iv or ciphertext fails decryption", async () => {
    const { keyring, vk } = await createKeyring();
    const env = await encryptVault(utf8("hello"), vk, { vaultId: keyring.vaultId, rev: 7 });
    const variants: Record<string, unknown>[] = [
      { ...env, vaultId: "AAAAAAAAAAAAAAAAAAAAAA" },
      { ...env, rev: 8 },
      { ...env, rev: 6 },
      { ...env, vkId: "0123456789abcdef" },
      { ...env, iv: "AAAAAAAAAAAAAAAA" },
      { ...env, ciphertext: env.ciphertext.slice(0, -4) + "AAA=" },
      { ...env, formatVersion: 2 },
      { ...env, cipher: "AES-128-GCM" },
    ];
    for (const v of variants) await expect(decryptVault(v, vk)).rejects.toBeDefined();
    // a recomputed checksum does not help (the checksum has no key)
    for (const v of variants) expect(await isEnvelopeIntact(v)).toBe(false);
  });
});

describe("wrapped keys", () => {
  it("iterations, salt, method, vkId and vaultId of a password wrap are all bound", async () => {
    const { keyring, vk } = await createKeyring();
    const { keyring: kr } = await enableMasterPassword(keyring, vk, PW);
    const pw = kr.wraps.find((w) => w.method === "password")!;
    const mutate = (f: (w: any) => void) => {
      const c = structuredClone(kr) as any;
      f(c.wraps.find((w: any) => w.method === "password"));
      return c;
    };
    const tries = [
      mutate((w) => {
        w.kdf.iterations = (pw.kdf as any).iterations + 1;
      }),
      mutate((w) => {
        w.kdf.salt = "AAAAAAAAAAAAAAAAAAAAAA==";
      }),
      mutate((w) => {
        w.method = "recovery";
      }),
    ];
    for (const k of tries) {
      await expect((async () => unlockWithPassword(validateKeyring(k), PW))()).rejects.toBeDefined();
      await expect(
        (async () => unlockWithRecoveryCode(validateKeyring(k), "0000-0000-0000-0000-0000-0000-0000"))(),
      ).rejects.toBeDefined();
    }
    const otherVault = { ...structuredClone(kr), vaultId: "BBBBBBBBBBBBBBBBBBBBBB" };
    await expect(unlockWithPassword(otherVault, PW)).rejects.toMatchObject({ code: "unwrap_failed" });
  });
  it("stored iteration counts below 600k or above 20M are refused before any work (no downgrade, bounded DoS)", async () => {
    const { keyring, vk } = await createKeyring();
    const { keyring: kr } = await enableMasterPassword(keyring, vk, PW);
    for (const it of [1, 599_999, PBKDF2_MAX_ITERATIONS + 1, 1e12, 600_000.5, Number.NaN]) {
      const c = structuredClone(kr) as any;
      c.wraps.find((w: any) => w.method === "password").kdf.iterations = it;
      const t0 = Date.now();
      await expect((async () => unlockWithPassword(validateKeyring(c), PW))()).rejects.toMatchObject({
        code: "invalid_kdf_params",
      });
      expect(Date.now() - t0).toBeLessThan(50);
    }
  });
});

describe("backup file", () => {
  it("created and the KDF parameters are bound; a downgraded iteration count is refused; it holds no key material", async () => {
    const { keyring } = await createKeyring();
    const f = await createBackup(emptyVault(keyring.vaultId), PW);
    const s = JSON.stringify(f);
    expect(s).not.toContain(keyring.deviceKey!);
    expect(s).not.toContain("wraps");
    for (const v of [
      { ...f, created: f.created + 1 },
      { ...f, kdf: { ...f.kdf, iterations: f.kdf.iterations + 1 } },
      { ...f, kdf: { ...f.kdf, salt: "AAAAAAAAAAAAAAAAAAAAAA==" } },
    ]) {
      await expect(openBackup(v, PW)).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
    }
    await expect(openBackup({ ...f, kdf: { ...f.kdf, iterations: 1000 } }, PW)).rejects.toMatchObject({
      code: "invalid_file",
    });
    await expect(openBackup(f, PW)).resolves.toBeDefined();
  });
});
