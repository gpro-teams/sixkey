export type Random = (n: number) => Uint8Array;

export const randomBytes: Random = (n) => crypto.getRandomValues(new Uint8Array(n));

export { CryptoError, type CryptoErrorCode } from "./crypto-error";
import { CryptoError } from "./crypto-error";

const enc = new TextEncoder();
export const utf8 = (s: string): Uint8Array => enc.encode(s);

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Strict standard base64 with padding. Throws CryptoError on anything else. */
export function fromB64(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s))
    throw new CryptoError("invalid_envelope", "bad base64");
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    throw new CryptoError("invalid_envelope", "bad base64");
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const bs = (b: Uint8Array): BufferSource => b as BufferSource;

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bs(concat(...parts))));
}
