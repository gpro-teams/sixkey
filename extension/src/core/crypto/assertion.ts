// The gate's assertion check (QUICK-UNLOCK §5.4 "Gate unlock" step 3; §5.10): a WebAuthn assertion is accepted only if
// Sixkey itself verifies that it answers our challenge, for our origin and RP ID, with the user present AND verified, and
// that the stored public key signed it. Pure functions over bytes, WebCrypto only; loaded lazily with the ceremony.
//
// What it protects against: a bug, an unexpected authenticator, an assertion without user verification (whatever the
// browser did). What it does not: anything that can read chrome.storage.session reads the parked key without any
// assertion (programs on this computer, the browser's developer tools); the gate's label says so (quickOnGate).
//
// The sign counter is not checked: synced passkeys (iCloud Keychain, Google Password Manager) always report 0, a check
// would need a write of chrome.storage.local at every unlock, and the gate guards only a key already in memory
// (docs/design/notes/PRF-NOTES.md).
//
// It imports nothing (a lazy chunk must not import the popup's main chunk's modules: SHAMIR-NOTES.md §7, PRF-NOTES.md).
const bs = (b: Uint8Array): BufferSource => b as BufferSource;
const sha256 = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bs(b)));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The flags byte of authenticator data (WebAuthn §6.1). */
export const UP = 0x01;
export const UV = 0x04;
export const BE = 0x08;
const AT = 0x40;

export type AuthData = {
  rpIdHash: Uint8Array;
  flags: number;
  /** The authenticator's AAGUID (attested credential data, at creation only), as 32 lowercase hex digits. */
  aaguid?: string;
};

/**
 * Authenticator data: rpIdHash (32) | flags (1) | signCount (4) | [AAGUID (16) | credential id length (2) | ...].
 * null when it is too short to be one.
 */
export function parseAuthData(b: Uint8Array): AuthData | null {
  if (b.length < 37) return null;
  const out: AuthData = { rpIdHash: b.slice(0, 32), flags: b[32]! };
  if (out.flags & AT && b.length >= 55)
    out.aaguid = Array.from(b.slice(37, 53), (x) => x.toString(16).padStart(2, "0")).join("");
  return out;
}

/** base64url without padding, as clientDataJSON writes the challenge. */
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * clientDataJSON as a ceremony of `type` for our `challenge` and `origin` must say it: that type, that challenge
 * (base64url), that origin, and not cross-origin (crossOrigin absent or false; Chrome writes false).
 */
export function clientDataOk(
  json: Uint8Array,
  want: { type: "webauthn.get" | "webauthn.create"; challenge: Uint8Array; origin: string },
): boolean {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    c = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)) as typeof c;
  } catch {
    return false;
  }
  return (
    typeof c === "object" &&
    c !== null &&
    c.type === want.type &&
    c.challenge === b64url(want.challenge) &&
    c.origin === want.origin &&
    (c.crossOrigin === undefined || c.crossOrigin === false)
  );
}

/** The RP ID hash for our RP ID: an extension page that sets no rp.id has its origin string as the RP ID (§1.6). */
export const rpIdOk = async (a: AuthData, rpId: string): Promise<boolean> => same(a.rpIdHash, await sha256(utf8(rpId)));

/**
 * A DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) as the raw r ‖ s (32 bytes each) that WebCrypto verifies.
 * Strict: short-form lengths only (a P-256 signature never needs more), each integer positive and at most 33 bytes
 * (one leading zero when its top bit is set), nothing after it. null for anything else.
 */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const out = new Uint8Array(64);
  let i = 2;
  for (const at of [0, 32]) {
    if (der[i] !== 0x02) return null;
    const n = der[i + 1]!;
    let v = der.slice(i + 2, i + 2 + n);
    if (n < 1 || n > 33 || v.length !== n || v[0]! & 0x80) return null;
    if (n > 1 && v[0] === 0 && !(v[1]! & 0x80)) return null; // a leading zero that is not needed: not DER
    if (n === 33) {
      if (v[0] !== 0) return null;
      v = v.slice(1);
    }
    out.set(v, at + 32 - v.length);
    i += 2 + n;
  }
  return i === der.length ? out : null;
}

/** The signature over authData ‖ SHA-256(clientDataJSON) with an SPKI public key: ES256 (-7) or RS256 (-257). */
export async function signatureOk(
  spki: Uint8Array,
  alg: number,
  authData: Uint8Array,
  clientDataJSON: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const hash = await sha256(clientDataJSON);
  const data = new Uint8Array(authData.length + hash.length);
  data.set(authData);
  data.set(hash, authData.length);
  try {
    if (alg === -7) {
      const raw = derToRaw(signature);
      if (!raw) return false;
      const key = await crypto.subtle.importKey("spki", bs(spki), { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bs(raw), bs(data));
    }
    if (alg === -257) {
      const key = await crypto.subtle.importKey(
        "spki",
        bs(spki),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bs(signature), bs(data));
    }
  } catch {
    return false; // a key that does not import (wrong curve or kind), a signature WebCrypto refuses
  }
  return false;
}

export type Assertion = { authData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array };

/**
 * The gate's check, every clause (QUICK-UNLOCK §5.4 step 3): the client data (webauthn.get, our challenge, our origin, not
 * cross-origin), the RP ID hash, the user present AND verified flags, and the signature with the stored key.
 * `rpId`: chrome-extension://<id>, which is also the origin.
 */
export async function gateAssertionOk(
  a: Assertion,
  key: { spki: Uint8Array; alg: number },
  want: { challenge: Uint8Array; origin: string; rpId: string },
): Promise<boolean> {
  const ad = parseAuthData(a.authData);
  return (
    ad !== null &&
    clientDataOk(a.clientDataJSON, { type: "webauthn.get", challenge: want.challenge, origin: want.origin }) &&
    (await rpIdOk(ad, want.rpId)) &&
    (ad.flags & UP) !== 0 &&
    (ad.flags & UV) !== 0 &&
    (await signatureOk(key.spki, key.alg, a.authData, a.clientDataJSON, a.signature))
  );
}
