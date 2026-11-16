// RFC 4226 HOTP / RFC 6238 TOTP on top of WebCrypto HMAC. (A code window's arithmetic is time.ts's, re-exported here.)
import { totpCounter } from "./time";
export { secondsRemaining, totpCounter } from "./time";
export type Algorithm = "SHA1" | "SHA256" | "SHA512";
export type Digits = 6 | 8;

const HASH_NAME: Record<Algorithm, "SHA-1" | "SHA-256" | "SHA-512"> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

export type CodeOptions = { algorithm: Algorithm; digits: Digits };
export type TotpOptions = CodeOptions & { period: number };

/** Import once and reuse the key across periods; WebCrypto rejects an empty key. */
export async function importHmacKey(secret: Uint8Array, algorithm: Algorithm): Promise<CryptoKey> {
  if (secret.length === 0) throw new RangeError("empty secret");
  return crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: HASH_NAME[algorithm] }, false, [
    "sign",
  ]);
}

export async function hotp(
  secret: Uint8Array | CryptoKey,
  counter: number | bigint,
  opts: CodeOptions,
): Promise<string> {
  const c = typeof counter === "bigint" ? counter : BigInt(counter);
  if (c < 0n || c > 0xffffffffffffffffn) throw new RangeError("counter out of range");
  if (typeof counter === "number" && !Number.isSafeInteger(counter))
    throw new RangeError("counter must be a safe integer");
  const key = secret instanceof Uint8Array ? await importHmacKey(secret, opts.algorithm) : secret;
  const msg = new ArrayBuffer(8);
  new DataView(msg).setBigUint64(0, c); // 8 bytes, big endian
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1]! & 0x0f; // last byte of the MAC, not a fixed index
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** opts.digits).padStart(opts.digits, "0");
}

export function totp(secret: Uint8Array | CryptoKey, timeMs: number, opts: TotpOptions): Promise<string> {
  return hotp(secret, totpCounter(timeMs, opts.period), opts);
}
