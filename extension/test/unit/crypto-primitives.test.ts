import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, pbkdf2Sync } from "node:crypto";
import { CryptoError, fromB64, toB64, utf8 } from "../../src/core/crypto/bytes";
import {
  PBKDF2_MIN_ITERATIONS,
  assertKdfParams,
  hkdfBits,
  newPbkdf2Params,
  normalizePassword,
  pbkdf2Bits,
} from "../../src/core/crypto/kdf";
import {
  formatRecoveryCode,
  generateRecoveryCode,
  normalizeRecoveryInput,
  parseRecoveryCode,
} from "../../src/core/crypto/recovery-code";
import {
  decryptVault,
  encryptVault,
  isEnvelopeIntact,
  validateEnvelope,
  type EncryptedVault,
} from "../../src/core/crypto/envelope";
import { generateVk, vkFromRaw } from "../../src/core/crypto/vk";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seqRng = (start = 1) => {
  let n = start;
  return (len: number) => Uint8Array.from({ length: len }, () => (n++ * 37) & 0xff);
};
const VAULT_ID = "vault-0123456789";

describe("known answers against node:crypto", () => {
  it("PBKDF2-HMAC-SHA256, RFC 7914 section 11 vector", async () => {
    const out = await pbkdf2Bits(utf8("passwd"), utf8("salt"), 1, 512);
    expect(hex(out)).toBe(
      "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
    );
  });
  it("PBKDF2 at 600k iterations matches node", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(hex(await pbkdf2Bits(utf8("pässword"), salt, 600_000, 256))).toBe(
      pbkdf2Sync("pässword", salt, 600_000, 32, "sha256").toString("hex"),
    );
  });
  it("HKDF-SHA256 matches node", async () => {
    const ikm = Uint8Array.from({ length: 32 }, (_, i) => i * 3);
    const salt = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
    expect(hex(await hkdfBits(ikm, salt, "sixkey/test", 256))).toBe(
      Buffer.from(hkdfSync("sha256", ikm, salt, "sixkey/test", 32)).toString("hex"),
    );
  });
  it("our envelope decrypts with an independent AES-256-GCM implementation", async () => {
    const vk = await vkFromRaw(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const env = await encryptVault(utf8("hello vault"), vk, { vaultId: VAULT_ID, rev: 7 });
    const key = Buffer.from(hkdfSync("sha256", vk.raw, new Uint8Array(0), "sixkey/v1/vault-enc", 32));
    const ct = Buffer.from(fromB64(env.ciphertext));
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(fromB64(env.iv)));
    d.setAAD(Buffer.from(`sixkey-vault|1|${VAULT_ID}|${vk.id}|7`));
    d.setAuthTag(ct.subarray(ct.length - 16));
    expect(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString()).toBe("hello vault");
    const expectedChecksum = createHash("sha256")
      .update(`sixkey-vault|1|${VAULT_ID}|${vk.id}|7`)
      .update(fromB64(env.iv))
      .update(ct)
      .digest("base64");
    expect(env.checksum).toBe(expectedChecksum);
  });
  it("an envelope made by node:crypto decrypts with ours", async () => {
    const vk = await vkFromRaw(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
    const key = Buffer.from(hkdfSync("sha256", vk.raw, new Uint8Array(0), "sixkey/v1/vault-enc", 32));
    const iv = Buffer.alloc(12, 9);
    const aad = `sixkey-vault|1|${VAULT_ID}|${vk.id}|3`;
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update("from node"), c.final(), c.getAuthTag()]);
    const env: EncryptedVault = {
      format: "sixkey-vault",
      formatVersion: 1,
      cipher: "AES-256-GCM",
      vaultId: VAULT_ID,
      vkId: vk.id,
      rev: 3,
      iv: iv.toString("base64"),
      ciphertext: ct.toString("base64"),
      checksum: createHash("sha256").update(aad).update(iv).update(ct).digest("base64"),
    };
    expect(await isEnvelopeIntact(env)).toBe(true);
    expect(new TextDecoder().decode(await decryptVault(env, vk))).toBe("from node");
  });
});

describe("encrypted vault envelope", () => {
  it("round-trips arbitrary payloads", async () => {
    const vk = await generateVk();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4000 }), fc.nat(1_000_000), async (data, rev) => {
        const env = await encryptVault(data, vk, { vaultId: VAULT_ID, rev });
        expect(await isEnvelopeIntact(env)).toBe(true);
        expect(Array.from(await decryptVault(env, vk))).toEqual(Array.from(data));
      }),
      { numRuns: 60 },
    );
  });
  it("uses a fresh IV every time", async () => {
    const vk = await generateVk();
    const a = await encryptVault(utf8("same"), vk, { vaultId: VAULT_ID, rev: 1 });
    const b = await encryptVault(utf8("same"), vk, { vaultId: VAULT_ID, rev: 1 });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
  it("the checksum is not a function of the plaintext", async () => {
    const vk = await generateVk();
    const a = await encryptVault(utf8("same"), vk, { vaultId: VAULT_ID, rev: 1 });
    const b = await encryptVault(utf8("same"), vk, { vaultId: VAULT_ID, rev: 1 });
    expect(a.checksum).not.toBe(b.checksum);
    expect(a.checksum).not.toBe(
      toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8("same") as BufferSource))),
    );
  });
  it("fails with the wrong key", async () => {
    const env = await encryptVault(utf8("x"), await generateVk(), { vaultId: VAULT_ID, rev: 1 });
    await expect(decryptVault(env, await generateVk())).rejects.toMatchObject({ code: "decrypt_failed" });
  });
  it("any single flipped ciphertext bit fails GCM authentication", async () => {
    const vk = await generateVk();
    const env = await encryptVault(utf8("a vault with some content"), vk, { vaultId: VAULT_ID, rev: 1 });
    const ct = fromB64(env.ciphertext);
    await fc.assert(
      fc.asyncProperty(fc.nat(ct.length * 8 - 1), async (bit) => {
        const t = ct.slice();
        t[bit >> 3]! ^= 1 << (bit & 7);
        await expect(decryptVault({ ...env, ciphertext: toB64(t) }, vk)).rejects.toBeInstanceOf(CryptoError);
      }),
      { numRuns: 80 },
    );
  });
  it("header fields are authenticated: rev, vaultId, iv", async () => {
    const vk = await generateVk();
    const env = await encryptVault(utf8("x"), vk, { vaultId: VAULT_ID, rev: 5 });
    await expect(decryptVault({ ...env, rev: 4 }, vk)).rejects.toMatchObject({ code: "decrypt_failed" });
    await expect(decryptVault({ ...env, vaultId: "other-vault-id" }, vk)).rejects.toMatchObject({
      code: "decrypt_failed",
    });
    const iv = fromB64(env.iv);
    iv[0]! ^= 1;
    await expect(decryptVault({ ...env, iv: toB64(iv) }, vk)).rejects.toMatchObject({ code: "decrypt_failed" });
  });
  it("checksum detects damage without any key", async () => {
    const env = await encryptVault(utf8("x"), await generateVk(), { vaultId: VAULT_ID, rev: 1 });
    expect(await isEnvelopeIntact(env)).toBe(true);
    const ct = fromB64(env.ciphertext);
    ct[3]! ^= 0x10;
    expect(await isEnvelopeIntact({ ...env, ciphertext: toB64(ct) })).toBe(false);
    expect(await isEnvelopeIntact({ ...env, rev: 2 })).toBe(false);
    expect(await isEnvelopeIntact({ ...env, checksum: toB64(new Uint8Array(32)) })).toBe(false);
  });
  it("rejects malformed envelopes", async () => {
    const env = await encryptVault(utf8("x"), await generateVk(), { vaultId: VAULT_ID, rev: 1 });
    const bads: unknown[] = [
      null,
      "x",
      {},
      { ...env, format: "other" },
      { ...env, formatVersion: 2 },
      { ...env, cipher: "AES-128-GCM" },
      { ...env, vaultId: "a|b" },
      { ...env, vkId: "zz" },
      { ...env, rev: -1 },
      { ...env, rev: 1.5 },
      { ...env, iv: toB64(new Uint8Array(11)) },
      { ...env, ciphertext: toB64(new Uint8Array(8)) },
      { ...env, ciphertext: "not base64!" },
      { ...env, checksum: "AAAA" },
    ];
    for (const b of bads) {
      expect(() => validateEnvelope(b)).toThrow(CryptoError);
      expect(await isEnvelopeIntact(b)).toBe(false);
    }
  });
});

describe("recovery code", () => {
  it("has 128 bits of secret and the documented shape", async () => {
    const c = await generateRecoveryCode();
    expect(c.secret).toHaveLength(16);
    expect(c.text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  });
  it("all-zero secret gives a pinned code", async () => {
    expect(await formatRecoveryCode(new Uint8Array(16))).toBe("0000-0000-0000-0000-0000-0000-00VM");
  });
  it("round-trips any 16 bytes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 16, maxLength: 16 }), async (s) => {
        expect(Array.from(await parseRecoveryCode(await formatRecoveryCode(s)))).toEqual(Array.from(s));
      }),
      { numRuns: 200 },
    );
  });
  it("accepts lowercase, spaces, missing hyphens and O/I/L look-alikes", async () => {
    const c = await generateRecoveryCode(seqRng());
    const sloppy = c.text.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(Array.from(await parseRecoveryCode(sloppy))).toEqual(Array.from(c.secret));
    expect(normalizeRecoveryInput(" ab-cd ")).toBe("ABCD");
  });
  it("reports length, character and checksum problems separately", async () => {
    const c = await generateRecoveryCode(seqRng());
    await expect(parseRecoveryCode(c.text.slice(0, -1))).rejects.toMatchObject({ code: "recovery_length" });
    await expect(parseRecoveryCode(c.text + "0")).rejects.toMatchObject({ code: "recovery_length" });
    await expect(parseRecoveryCode("U" + c.text.replace(/-/g, "").slice(1))).rejects.toMatchObject({
      code: "recovery_char",
    });
    await expect(parseRecoveryCode("")).rejects.toMatchObject({ code: "recovery_length" });
  });
  it("catches nearly all single-symbol typos", async () => {
    const c = await generateRecoveryCode(seqRng(5));
    const plain = c.text.replace(/-/g, "");
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let undetected = 0;
    let tried = 0;
    for (let i = 0; i < plain.length; i++) {
      for (const ch of A) {
        if (ch === plain[i]) continue;
        tried++;
        try {
          await parseRecoveryCode(plain.slice(0, i) + ch + plain.slice(i + 1));
          undetected++;
        } catch {
          /* detected */
        }
      }
    }
    expect(tried).toBe(28 * 31);
    expect(undetected / tried).toBeLessThan(0.002); // 12 check bits: about 1 in 4096 slips through
  });
});

describe("kdf parameters", () => {
  it("new parameters are valid and use a fresh 16 byte salt", () => {
    const a = newPbkdf2Params();
    const b = newPbkdf2Params();
    expect(fromB64(a.salt)).toHaveLength(16);
    expect(a.salt).not.toBe(b.salt);
    expect(() => assertKdfParams(a)).not.toThrow();
  });
  it("refuses weakened or absurd stored parameters", () => {
    const good = newPbkdf2Params();
    const bads = [
      { ...good, iterations: PBKDF2_MIN_ITERATIONS - 1 },
      { ...good, iterations: 1 },
      { ...good, iterations: 1e9 },
      { ...good, iterations: 600000.5 },
      { ...good, salt: toB64(new Uint8Array(8)) },
      { ...good, hash: "SHA-1" },
      { ...good, name: "scrypt" },
      { ...good, v: 2 },
      null,
      "x",
    ];
    for (const b of bads) expect(() => assertKdfParams(b)).toThrow(CryptoError);
  });
  it("passwords are NFKC-normalised, and empty ones refused", () => {
    expect(normalizePassword("ｐａｓｓ１２３")).toBe("pass123");
    expect(normalizePassword("é")).toBe("é");
    expect(() => normalizePassword("")).toThrow(CryptoError);
  });
});
