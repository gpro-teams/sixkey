// The device signing key (DSK, ECDSA P-256, §2.5) and the two public-key encodings of enrollment (§2.2): dpk is
// always SPKI DER and epk always the 65-byte uncompressed point. WebCrypto also accepts compressed points, so both
// formats are checked explicitly before import; import then checks that the point is on the curve.
import { bs, randomBytes, type Random } from "../../crypto/bytes";
import { bytesEqual, toB64u } from "./encoding";
import { SyncCryptoError } from "./errors";

const SPKI_P256_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** 16 random bytes, base64url: 22 characters (§2.5). */
export const newDeviceId = (rng: Random = randomBytes): string => toB64u(rng(16));

export const isSpkiP256 = (spki: Uint8Array): boolean =>
  spki.length === 91 && bytesEqual(spki.subarray(0, 26), SPKI_P256_PREFIX) && spki[26] === 0x04;
export const isUncompressedPoint = (raw: Uint8Array): boolean => raw.length === 65 && raw[0] === 0x04;

/** A dpk from the server or a body: the exact P-256 SPKI layout, then a successful import (on the curve). */
export async function importDpk(spki: Uint8Array): Promise<CryptoKey> {
  if (!isSpkiP256(spki)) throw new SyncCryptoError("invalid_key", "dpk is not P-256 SPKI with an uncompressed point");
  try {
    return await crypto.subtle.importKey("spki", bs(spki), ECDSA, true, ["verify"]);
  } catch {
    throw new SyncCryptoError("invalid_key", "dpk is not on the curve");
  }
}

/** An epk from the server: 65 bytes 0x04 || x || y, then a successful import (on the curve, x and y below p). */
export async function importEpk(raw: Uint8Array): Promise<CryptoKey> {
  if (!isUncompressedPoint(raw)) throw new SyncCryptoError("invalid_key", "epk is not a 65-byte uncompressed point");
  try {
    return await crypto.subtle.importKey("raw", bs(raw), ECDH, true, []);
  } catch {
    throw new SyncCryptoError("invalid_key", "epk is not on the curve");
  }
}

export type DeviceKey = {
  privateKey: CryptoKey; // non-extractable: what signs every request
  spki: Uint8Array; // dpk / sig_pubkey
  jwk: JsonWebKey; // the private key, for the VK-encrypted copy only (§2.5 S5); drop it once that is written
};

/**
 * §2.5 generation flow: generated extractable once so its JWK can go into the VK-encrypted copy, and re-imported
 * non-extractable for signing. Writing the copy and the IndexedDB record is the storage layer's job.
 */
export async function generateDeviceKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: await importDeviceKey(jwk), spki, jwk };
}

/** Non-extractable signing key from the JWK (identity restored from the copy, §2.5). */
export async function importDeviceKey(jwk: JsonWebKey): Promise<CryptoKey> {
  try {
    const { kty, crv, x, y, d } = jwk;
    return await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, ECDSA, false, ["sign"]);
  } catch {
    throw new SyncCryptoError("invalid_key", "not a P-256 private JWK");
  }
}

export type Ephemeral = { privateKey: CryptoKey; raw: Uint8Array };

/** A fresh ephemeral ECDH pair for one enrollment; the private key is non-extractable and dropped when the request ends. */
export async function generateEphemeral(): Promise<Ephemeral> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, raw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}
