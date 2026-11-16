import { beforeAll, describe, expect, it } from "vitest";
import { CryptoError, fromB64, toB64, utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault } from "../../src/core/crypto/envelope";
import {
  changePassword,
  createKeyring,
  enableMasterPassword,
  listMethods,
  removeMethod,
  setPassword,
  setRecovery,
  unlockWithDevice,
  unlockWithPassword,
  unlockWithRecoveryCode,
  validateKeyring,
  type Keyring,
} from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";

const PW = "correct horse battery staple";

async function protectedKeyring() {
  const { keyring, vk } = await createKeyring();
  const r = await enableMasterPassword(keyring, vk, PW);
  return { initial: keyring, vk, keyring: r.keyring, code: r.recoveryCode };
}

describe("device-wrapped keyring (before a master password)", () => {
  it("opens with the device key and yields the same VK", async () => {
    const { keyring, vk } = await createKeyring();
    expect(listMethods(keyring)).toEqual(["device"]);
    const again = await unlockWithDevice(keyring);
    expect(again.id).toBe(vk.id);
    expect(Array.from(again.raw)).toEqual(Array.from(vk.raw));
  });
  it("survives a JSON round trip and passes validation", async () => {
    const { keyring } = await createKeyring();
    const back = validateKeyring(JSON.parse(JSON.stringify(keyring)));
    expect((await unlockWithDevice(back)).id).toBe(keyring.vkId);
  });
  it("cannot be unlocked with a password or recovery code it does not have", async () => {
    const { keyring } = await createKeyring();
    await expect(unlockWithPassword(keyring, PW)).rejects.toMatchObject({ code: "no_such_method" });
    await expect(unlockWithRecoveryCode(keyring, "0000-0000-0000-0000-0000-0000-00VM")).rejects.toMatchObject({
      code: "no_such_method",
    });
  });
});

describe("enabling the master password", () => {
  let ctx: Awaited<ReturnType<typeof protectedKeyring>>;
  beforeAll(async () => {
    ctx = await protectedKeyring();
  });

  it("removes the device wrap and the device key, adds password and recovery", () => {
    expect(listMethods(ctx.keyring).sort()).toEqual(["password", "recovery"]);
    expect(ctx.keyring.deviceKey).toBeUndefined();
    const json = JSON.stringify(ctx.keyring);
    expect(json).not.toContain(ctx.initial.deviceKey!);
    expect(json).not.toContain('"device"');
  });
  it("the old device-only keyring is the thing that must be purged: it still opens the same VK", async () => {
    // Documents why the storage layer has to delete old copies and rotate the VK (PLAN 5.3).
    expect((await unlockWithDevice(ctx.initial)).id).toBe(ctx.vk.id);
  });
  it("the device path no longer works on the new keyring", async () => {
    await expect(unlockWithDevice(ctx.keyring)).rejects.toMatchObject({ code: "no_such_method" });
  });
  it("opens with the password and with the recovery code", async () => {
    expect((await unlockWithPassword(ctx.keyring, PW)).id).toBe(ctx.vk.id);
    expect((await unlockWithRecoveryCode(ctx.keyring, ctx.code)).id).toBe(ctx.vk.id);
    expect((await unlockWithRecoveryCode(ctx.keyring, ctx.code.toLowerCase().replace(/-/g, " "))).id).toBe(ctx.vk.id);
  });
  it("a different but equivalent unicode form of the password works", async () => {
    const { keyring, vk } = await createKeyring();
    const r = await enableMasterPassword(keyring, vk, "ｐａｓｓ ｗｏｒｄ １２３");
    expect((await unlockWithPassword(r.keyring, "pass word 123")).id).toBe(vk.id);
  });
  it("wrong password and wrong recovery code fail the same way", async () => {
    await expect(unlockWithPassword(ctx.keyring, "wrong")).rejects.toMatchObject({ code: "unwrap_failed" });
    await expect(unlockWithRecoveryCode(ctx.keyring, "0000-0000-0000-0000-0000-0000-00VM")).rejects.toMatchObject({
      code: "unwrap_failed",
    });
  });
  it("malformed recovery input is reported as such, not as a wrong code", async () => {
    await expect(unlockWithRecoveryCode(ctx.keyring, "abc")).rejects.toMatchObject({ code: "recovery_length" });
  });
  it("an empty password is refused", async () => {
    const { keyring, vk } = await createKeyring();
    await expect(enableMasterPassword(keyring, vk, "")).rejects.toMatchObject({ code: "empty_password" });
  });
  it("refuses a VK from another keyring", async () => {
    const other = await createKeyring();
    await expect(setPassword(ctx.keyring, other.vk, PW)).rejects.toMatchObject({ code: "invalid_keyring" });
  });
});

describe("changing the password only re-wraps the VK", () => {
  it("keeps the vault ciphertext readable, retires the old password, keeps the recovery code", async () => {
    const { vk, keyring, code } = await protectedKeyring();
    const envelope = await encryptVault(utf8("my 2fa secrets"), vk, { vaultId: keyring.vaultId, rev: 1 });
    const unlocked = await unlockWithPassword(keyring, PW);
    const next = await changePassword(keyring, unlocked, "a brand new passphrase");

    // the envelope is untouched and still decrypts with the VK reached through the new password
    const vk2 = await unlockWithPassword(next, "a brand new passphrase");
    expect(new TextDecoder().decode(await decryptVault(envelope, vk2))).toBe("my 2fa secrets");
    await expect(unlockWithPassword(next, PW)).rejects.toMatchObject({ code: "unwrap_failed" });
    expect((await unlockWithRecoveryCode(next, code)).id).toBe(vk.id);

    const before = keyring.wraps.find((w) => w.method === "password")!;
    const after = next.wraps.find((w) => w.method === "password")!;
    expect(after.kdf).not.toEqual(before.kdf); // new salt
    expect(after.iv).not.toBe(before.iv);
    expect(next.vkId).toBe(keyring.vkId);
  });
  it("needs an existing password wrap", async () => {
    const { keyring, vk } = await createKeyring();
    await expect(changePassword(keyring, vk, "x")).rejects.toMatchObject({ code: "no_such_method" });
  });
});

describe("recovery code replacement", () => {
  it("a new code works and the old one stops working", async () => {
    const { keyring, vk, code } = await protectedKeyring();
    const r = await setRecovery(keyring, vk);
    expect(r.recoveryCode).not.toBe(code);
    expect((await unlockWithRecoveryCode(r.keyring, r.recoveryCode)).id).toBe(vk.id);
    await expect(unlockWithRecoveryCode(r.keyring, code)).rejects.toMatchObject({ code: "unwrap_failed" });
    expect(listMethods(r.keyring).filter((m) => m === "recovery")).toHaveLength(1);
  });
});

describe("tampering with a stored keyring", () => {
  let ctx: Awaited<ReturnType<typeof protectedKeyring>>;
  beforeAll(async () => {
    ctx = await protectedKeyring();
  });
  const edit = (k: Keyring, method: "password" | "recovery", f: (w: Keyring["wraps"][number]) => void): Keyring => {
    const c = structuredClone(k);
    f(c.wraps.find((w) => w.method === method)!);
    return c;
  };

  it("flipped wrapped bytes", async () => {
    const t = edit(ctx.keyring, "password", (w) => {
      const b = fromB64(w.wrapped);
      b[5]! ^= 1;
      w.wrapped = toB64(b);
    });
    await expect(unlockWithPassword(t, PW)).rejects.toMatchObject({ code: "unwrap_failed" });
  });
  it("changed iv", async () => {
    const t = edit(ctx.keyring, "recovery", (w) => {
      const b = fromB64(w.iv);
      b[0]! ^= 1;
      w.iv = toB64(b);
    });
    await expect(unlockWithRecoveryCode(t, ctx.code)).rejects.toMatchObject({ code: "unwrap_failed" });
  });
  it("a changed salt breaks the key (and so does a changed iteration count, via the AAD)", async () => {
    const salt = edit(ctx.keyring, "password", (w) => {
      w.kdf = { ...w.kdf!, salt: toB64(new Uint8Array(16).fill(7)) } as typeof w.kdf;
    });
    await expect(unlockWithPassword(salt, PW)).rejects.toMatchObject({ code: "unwrap_failed" });
    const iter = edit(ctx.keyring, "password", (w) => {
      w.kdf = { ...w.kdf!, iterations: 700_000 } as typeof w.kdf;
    });
    await expect(unlockWithPassword(iter, PW)).rejects.toMatchObject({ code: "unwrap_failed" });
  });
  it("a server that lowers the iteration count is refused before any work is done", async () => {
    const t = edit(ctx.keyring, "password", (w) => {
      w.kdf = { ...w.kdf!, iterations: 1000 } as typeof w.kdf;
    });
    await expect(unlockWithPassword(t, PW)).rejects.toMatchObject({ code: "invalid_kdf_params" });
    expect(() => validateKeyring(t)).toThrow(CryptoError);
  });
  it("a wrap copied into a different vault does not open", async () => {
    const other = await protectedKeyring();
    const moved: Keyring = { ...other.keyring, wraps: ctx.keyring.wraps, vkId: ctx.keyring.vkId };
    await expect(unlockWithPassword(moved, PW)).rejects.toMatchObject({ code: "unwrap_failed" });
  });
  it("a wrap relabelled with another method does not open", async () => {
    const t = edit(ctx.keyring, "recovery", (w) => {
      w.method = "password";
    });
    t.wraps = t.wraps.filter((w) => !(w.method === "password" && w.kdf?.name === "PBKDF2"));
    await expect(unlockWithPassword(t, PW)).rejects.toBeInstanceOf(CryptoError);
  });
});

describe("keyring validation and method removal", () => {
  it("rejects malformed keyrings", async () => {
    const { keyring } = await createKeyring();
    const bads: unknown[] = [
      null,
      {},
      { ...keyring, format: "x" },
      { ...keyring, v: 2 },
      { ...keyring, vaultId: "a|b" },
      { ...keyring, vkId: "nope" },
      { ...keyring, wraps: [] },
      { ...keyring, wraps: [{ ...keyring.wraps[0], vkId: "0000000000000000" }] },
      { ...keyring, wraps: [{ ...keyring.wraps[0], method: "magic" }] },
      { ...keyring, deviceKey: "AAAA" },
      { ...keyring, previous: null },
    ];
    for (const b of bads) expect(() => validateKeyring(b)).toThrow(CryptoError);
  });
  it("never removes the last way in", async () => {
    const { keyring } = await createKeyring();
    expect(() => removeMethod(keyring, "device")).toThrow(CryptoError);
  });
  it("removing the device wrap also deletes the device key", async () => {
    const { keyring, vk } = await createKeyring();
    const withPw = await setPassword(keyring, vk, PW);
    const next = removeMethod(withPw, "device");
    expect(next.deviceKey).toBeUndefined();
    expect(listMethods(next)).toEqual(["password"]);
  });
});
