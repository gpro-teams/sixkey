// The PIN's set-up, its policy and the gate's session record (src/core/crypto/pin.ts, pin-policy.ts; QUICK-UNLOCK §5.2,
// §5.4, §7.1; OWNER-DECISIONS/20, 2026-10-30): the policy's lengths and digits, and the PINs it says are weak (taken, not
// refused); sk_pin's known answer, checked with node:crypto, which shares no code with WebCrypto, every AAD field bound;
// sk_quick, the Touch ID / Windows Hello gate's alone (the PIN's half went: its record is pin-restart.ts's), its expiry's
// edges; and what a damaged or foreign record parses as.
import { createDecipheriv, hkdfSync, pbkdf2Sync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CryptoError, fromB64, toB64 } from "../../src/core/crypto/bytes";
import { PBKDF2_MIN_ITERATIONS, type Pbkdf2Params } from "../../src/core/crypto/kdf";
import {
  armDevice,
  derivePinKek,
  normalizePin,
  openPinRecord,
  parsePinRecord,
  parseQuick,
  PIN_CFG_LABEL,
  QUICK_CLOCK_SLACK_MS,
  QUICK_TRIES,
  QUICK_TTL_MS,
  quickLive,
  sealPinRecord,
  wrapsTag,
} from "../../src/core/crypto/pin";
import { checkPinPolicy } from "../../src/core/crypto/pin-policy";
import { vkFromRaw } from "../../src/core/crypto/vk";

const VAULT = "vault-0123456789ab";
const fixed = (n: number, byte: number) => () => new Uint8Array(n).fill(byte);
const counter = () => {
  let i = 0;
  return (n: number) => new Uint8Array(n).map(() => (i++ * 37 + 11) & 0xff);
};
const KDF: Pbkdf2Params = {
  name: "PBKDF2",
  hash: "SHA-256",
  iterations: PBKDF2_MIN_ITERATIONS,
  salt: toB64(new Uint8Array(16).fill(7)),
  v: 1,
};
const vkOf = (b: number) => vkFromRaw(new Uint8Array(32).fill(b));
/** A keyring's wraps tag (wrapsTag), as the service passes it. */
const WRAPS = wrapsTag({ wraps: [{ wrapped: "AAAA" }, { wrapped: "BBBB" }] });

/** AES-256-GCM open with node:crypto (ciphertext with its 16-byte tag at the end). */
function nodeOpen(key: Uint8Array, iv: Uint8Array, ct: Uint8Array, aad: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(ct.subarray(ct.length - 16)));
  return Buffer.concat([d.update(Buffer.from(ct.subarray(0, ct.length - 16))), d.final()]);
}

describe("the PIN policy (§5.4 step 4)", () => {
  it("4 to 8 digits; 3 and 9 are refused as the wrong format, as are letters, signs and other scripts' digits", () => {
    expect(checkPinPolicy("491")).toEqual({ ok: false, reason: "format" });
    expect(checkPinPolicy("4917")).toEqual({ ok: true, pin: "4917", weak: false });
    expect(checkPinPolicy("49170358")).toEqual({ ok: true, pin: "49170358", weak: false });
    expect(checkPinPolicy("491703581")).toEqual({ ok: false, reason: "format" });
    for (const x of ["49a7", "49-17", "+4917", "4 917", "", "٤٩١٧", "49.17", "491７x"])
      expect(checkPinPolicy(x).ok, JSON.stringify(x)).toBe(false);
  });
  it("full-width digits from a Chinese IME count as the same PIN, and white space around a paste is dropped", () => {
    expect(normalizePin("４９１７")).toBe("4917");
    expect(normalizePin("  491703\n")).toBe("491703");
    expect(checkPinPolicy("４９１７０３")).toEqual({ ok: true, pin: "491703", weak: false });
  });
  it("says, and takes (OWNER-DECISIONS/20, 2026-10-30): repeated digits, runs both ways (9 next to 0), repeated blocks, the common list", () => {
    for (const weak of [
      "0000",
      "11111111",
      "1234",
      "12345678",
      "4321",
      "987654",
      "7890",
      "8901",
      "0987",
      "1212",
      "6969",
      "123123",
      "520520",
      "12121212",
      "1004",
      "2580",
      "112233",
      "159753",
      "5201314",
    ])
      expect(checkPinPolicy(weak), weak).toEqual({ ok: true, pin: weak, weak: true });
    for (const fine of ["4917", "1357", "2468", "8462", "491703", "1100", "27182818"])
      expect(checkPinPolicy(fine), fine).toEqual({ ok: true, pin: fine, weak: false });
  });
});

describe("pinKek and sk_pin (§5.2)", () => {
  it("pinKek is PBKDF2-SHA256 of the NFKC PIN with the record's salt and iterations: node:crypto agrees", async () => {
    const kek = await derivePinKek("４９１７０３", KDF);
    expect(Buffer.from(kek).toString("hex")).toBe(
      pbkdf2Sync("491703", Buffer.from(fromB64(KDF.salt)), KDF.iterations, 32, "sha256").toString("hex"),
    );
    // parameters below the floor or above the ceiling are refused, as everywhere (kdf.ts)
    await expect(derivePinKek("491703", { ...KDF, iterations: 1000 })).rejects.toThrow(CryptoError);
    await expect(derivePinKek("491703", { ...KDF, iterations: 30_000_000 })).rejects.toThrow(CryptoError);
    await expect(derivePinKek("49a703", KDF)).rejects.toThrow(CryptoError);
  });
  it("known answer: sk_pin is AES-GCM under HKDF(VK, no salt, sixkey/v1/pin-cfg), AAD sixkey-pin|1|vault|vkId", async () => {
    const vk = await vkOf(3);
    const pinKek = new Uint8Array(32).fill(9);
    const rec = await sealPinRecord(vk, VAULT, pinKek, { digits: 6, kdf: KDF }, fixed(12, 5));
    expect(PIN_CFG_LABEL).toBe("sixkey/v1/pin-cfg");
    const key = new Uint8Array(hkdfSync("sha256", vk.raw, new Uint8Array(0), PIN_CFG_LABEL, 32));
    const plain = nodeOpen(key, fromB64(rec.iv), fromB64(rec.wrapped), `sixkey-pin|1|${VAULT}|${vk.id}`);
    expect(Buffer.from(plain).equals(Buffer.from(pinKek))).toBe(true);
    expect(rec).toMatchObject({ v: 1, vaultId: VAULT, vkId: vk.id, digits: 6, kdf: KDF, iv: toB64(fixed(12, 5)()) });
    expect(await openPinRecord(rec, vk)).toEqual(pinKek);
  });
  it("another vault key: unwrap_failed; a record its key's AES-GCM does not authenticate (another vault id, another key's id, a changed ciphertext): decrypt_failed, and only that; the key's own derivation failing: thrown as it is (review of PINONE r2, S-02)", async () => {
    const vk = await vkOf(3);
    const rec = await sealPinRecord(vk, VAULT, new Uint8Array(32).fill(9), { digits: 6, kdf: KDF }, counter());
    await expect(openPinRecord(rec, await vkOf(4))).rejects.toMatchObject({ code: "unwrap_failed" }); // not its key
    await expect(openPinRecord({ ...rec, vaultId: "vault-other-000000" }, vk)).rejects.toMatchObject({
      code: "decrypt_failed", // its AAD changed
    });
    const other = await vkOf(4);
    await expect(openPinRecord({ ...rec, vkId: other.id }, other)).rejects.toMatchObject({ code: "decrypt_failed" });
    const flipped = (rec.wrapped[0] === "A" ? "B" : "A") + rec.wrapped.slice(1);
    await expect(openPinRecord({ ...rec, wrapped: flipped }, vk)).rejects.toMatchObject({ code: "decrypt_failed" });
    // anything that is not the decryption's own refusal is not decrypt_failed: a value that does not decode, WebCrypto
    // failing for another reason (unwrap_failed); the key's own derivation failing, thrown as it is (not the record's)
    await expect(openPinRecord({ ...rec, wrapped: "%%%" }, vk)).rejects.toMatchObject({ code: "unwrap_failed" });
    const failure = new DOMException("no", "OperationError");
    const derive = vi.spyOn(crypto.subtle, "deriveKey").mockRejectedValueOnce(failure);
    try {
      await expect(openPinRecord(rec, vk)).rejects.toBe(failure);
    } finally {
      derive.mockRestore();
    }
    for (const thrown of [new DOMException("later", "NotSupportedError"), new TypeError("unexpected")]) {
      const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockRejectedValueOnce(thrown);
      try {
        await expect(openPinRecord(rec, vk), thrown.name).rejects.toMatchObject({ code: "unwrap_failed" });
      } finally {
        decrypt.mockRestore();
      }
    }
    expect(await openPinRecord(rec, vk)).toEqual(new Uint8Array(32).fill(9)); // and the record itself was fine
  });
});

describe('sk_quick: the gate\'s arming alone (§5.2, §5.4 "Gate unlock")', () => {
  async function armed(at = 1_700_000_000_000) {
    const vk = await vkOf(3);
    return { vk, q: armDevice(vk, VAULT, at, WRAPS) };
  }
  it("the gate's arming: the vault key as it is, for 12 hours; the PIN's tries are its record's (QUICK_TRIES)", async () => {
    const { vk, q } = await armed();
    expect(q).toEqual({
      v: 1,
      method: "device",
      vaultId: VAULT,
      vkId: vk.id,
      armedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + QUICK_TTL_MS,
      vk: toB64(vk.raw),
      wraps: "AAAA,BBBB",
    });
    expect(QUICK_TRIES).toBe(5);
    expect(QUICK_TTL_MS).toBe(12 * 3_600_000);
  });
  it("expiry: now = expiresAt still works, a millisecond later does not; a clock behind armedAt by more than a minute does not", async () => {
    const { q } = await armed(1_000_000_000_000);
    expect(quickLive(q, q.expiresAt)).toBe(true);
    expect(quickLive(q, q.expiresAt + 1)).toBe(false);
    expect(quickLive(q, q.armedAt)).toBe(true);
    expect(quickLive(q, q.armedAt - QUICK_CLOCK_SLACK_MS)).toBe(true);
    expect(quickLive(q, q.armedAt - QUICK_CLOCK_SLACK_MS - 1)).toBe(false);
    expect(quickLive({ ...q, expiresAt: q.armedAt + QUICK_TTL_MS + 1 }, q.armedAt)).toBe(false); // a longer window
  });
  it("parsing: a record round-trips; anything else (a PIN arming of before 2026-10-30, wrong version, sizes) is not one", async () => {
    const { q } = await armed();
    const vk = await vkOf(3);
    const pinKek = await derivePinKek("491703", KDF);
    const pin = await sealPinRecord(vk, VAULT, pinKek, { digits: 6, kdf: KDF }, counter());
    expect(parseQuick(structuredClone(q))).toEqual(q);
    expect(parsePinRecord(structuredClone(pin))).toEqual(pin);
    expect(parsePinRecord(undefined)).toBeNull();
    const oldPin = {
      ...q,
      method: "pin",
      triesLeft: 5,
      digits: 6,
      kdf: KDF,
      iv: toB64(new Uint8Array(12)),
      wrapped: toB64(new Uint8Array(48)),
    };
    for (const bad of [
      oldPin,
      { ...oldPin, gate: toB64(vk.raw) },
      { ...q, v: 2 },
      { ...q, method: "pin" },
      { ...q, vk: toB64(new Uint8Array(31)) },
      { ...q, armedAt: -1 },
      { ...q, vaultId: "x" },
      { ...q, wraps: "" },
      { ...q, wraps: undefined },
      { ...q, wraps: 7 },
      null,
      "sk_quick",
    ])
      expect(parseQuick(bad), JSON.stringify(bad)).toBeNull();
    for (const bad of [{ ...pin, v: 2 }, { ...pin, digits: 9 }, { ...pin, wrapped: toB64(new Uint8Array(40)) }, 7])
      expect(parsePinRecord(bad), JSON.stringify(bad)).toBe("damaged");
  });
});
