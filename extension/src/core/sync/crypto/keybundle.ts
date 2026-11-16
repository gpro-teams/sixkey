// KeyBundle (§2.3): the cloud copy of the keyring, versioned by kver and MACed with a VK subkey. It travels and is
// stored as raw JSON text; receivers parse it generically and keep members they do not know.
import { bs, fromB64, randomBytes, sha256, toB64, utf8, type Random } from "../../crypto/bytes";
import { assertKdfParams, newPbkdf2Params, type Pbkdf2Params } from "../../crypto/kdf";
import { validateKeyring, type Keyring, type WrappedKey } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import { SYNC_CONSTANTS as C } from "./constants";
import {
  DEVICE_ID_RE,
  ID_RE,
  b64,
  bytesEqual,
  canonicalJsonStrict,
  floorToHour,
  isHourAligned,
  isPlainObject,
  parseIntegerJson,
} from "./encoding";
import { SyncCryptoError } from "./errors";
import { TAG } from "./labels";
import { bundleMacKey, hmacSha256 } from "./subkeys";

export type BundleAuth = { kdf: Pbkdf2Params };

export type KeyBundle = {
  format: "sixkey-keybundle";
  v: 1;
  vaultId: string;
  kver: number; // 1..2^53-1; every publish takes publishKver(server kver, maxSeenKver) (§3.9 R1)
  keyring: Keyring; // sync form: wraps exactly {password, recovery}, no deviceKey, previous <= 64
  auth: BundleAuth; // salt and iterations of pw_auth (§3.14), not the password wrap's salt
  by: string; // deviceId of the writer
  at: number; // floored to the UTC hour
  mac: string; // base64 HMAC-SHA256(K_mac, 'sixkey-keybundle|1|' + canonicalJson(the rest))
};

/**
 * "read": what a client accepts from the server. "upload": also what the server enforces, which clients check on their own
 * output before sending: every time a whole UTC hour (§2.3, N16; clients do not check this on read) and an auth salt
 * that is not the password wrap's.
 */
export type BundleCheckMode = "read" | "upload";

export const wrapOf = (kr: Keyring, method: "password" | "recovery"): WrappedKey | undefined =>
  kr.wraps.find((w) => w.method === method);

function bad(m: string): never {
  throw new SyncCryptoError("invalid_bundle", m);
}

/** The keyless rules of §2.3 / §3.13. Throws SyncCryptoError; returns the same object, unknown members included. */
export function checkBundleShape(x: unknown, mode: BundleCheckMode): KeyBundle {
  if (!isPlainObject(x)) return bad("not an object");
  if (x.format !== "sixkey-keybundle" || x.v !== 1) bad("unsupported format");
  if (typeof x.vaultId !== "string" || !ID_RE.test(x.vaultId)) bad("bad vaultId");
  if (!Number.isSafeInteger(x.kver) || (x.kver as number) < 1) bad("bad kver");
  let kr: Keyring;
  try {
    kr = validateKeyring(x.keyring); // Phase 0 shape: ids, iv/wrapped lengths, kdf bounds, previous <= 64
  } catch {
    return bad("bad keyring");
  }
  if (kr.vaultId !== x.vaultId) bad("vaultId differs from the keyring's");
  if (Object.hasOwn(kr, "deviceKey")) bad("a device key is present");
  const pw = wrapOf(kr, "password");
  const rec = wrapOf(kr, "recovery");
  if (kr.wraps.length !== 2 || !pw || !rec) return bad("wraps must be exactly password and recovery");
  if (pw.kdf?.name !== "PBKDF2" || rec.kdf?.name !== "HKDF") bad("wrap kdf");
  if (!isPlainObject(x.auth)) return bad("bad auth");
  const authKdf = x.auth.kdf;
  try {
    assertKdfParams(authKdf);
  } catch {
    return bad("bad auth kdf");
  }
  if (authKdf.name !== "PBKDF2") bad("auth kdf must be PBKDF2");
  if (typeof x.by !== "string" || !DEVICE_ID_RE.test(x.by)) bad("bad by");
  const times: unknown[] = [x.at, ...kr.wraps.map((w) => w.createdAt), ...kr.previous.map((p) => p.createdAt)];
  if (!times.every((t) => Number.isSafeInteger(t) && (t as number) >= 0)) bad("bad time");
  if (typeof x.mac !== "string" || fromB64Len(x.mac) !== 32) bad("bad mac");
  if (mode === "upload") {
    if (!times.every(isHourAligned)) throw new SyncCryptoError("unaligned_time");
    if (bytesEqual(b64(authKdf.salt), b64(pw.kdf!.salt))) bad("auth salt equals the password wrap salt");
  }
  return x as unknown as KeyBundle;
}

function fromB64Len(s: string): number {
  try {
    return fromB64(s).length;
  } catch {
    return -1;
  }
}

/** The bundle's raw text from the server or the enrollment payload: integer-only JSON (N20), then the read rules. */
export function parseBundleText(raw: string): KeyBundle {
  return checkBundleShape(parseIntegerJson(raw), "read");
}

const KNOWN = {
  bundle: ["format", "v", "vaultId", "kver", "keyring", "auth", "by", "at", "mac"],
  auth: ["kdf"],
  PBKDF2: ["name", "hash", "iterations", "salt", "v"],
  HKDF: ["name", "hash", "salt", "v"],
  keyring: ["format", "v", "vaultId", "vkId", "wraps", "previous"],
  wrap: ["method", "vkId", "kdf", "iv", "wrapped", "createdAt"],
  previous: ["vkId", "iv", "wrapped", "createdAt"],
};
const onlyKnown = (o: object, known: string[]): boolean => Object.keys(o).every((k) => known.includes(k));

/**
 * §2.3: a bundle with members this client does not know still verifies and may be adopted (the MAC covers them), but no
 * key operation may be built on it, since rebuilding would drop them. Checked at every level, not just the top.
 */
export function bundleHasUnknownFields(b: KeyBundle): boolean {
  const kr = b.keyring;
  const kdfOk = (k: { name: string } | undefined) => !k || onlyKnown(k, KNOWN[k.name === "PBKDF2" ? "PBKDF2" : "HKDF"]);
  return !(
    onlyKnown(b, KNOWN.bundle) &&
    onlyKnown(b.auth, KNOWN.auth) &&
    kdfOk(b.auth.kdf) &&
    onlyKnown(kr, KNOWN.keyring) &&
    kr.wraps.every((w) => onlyKnown(w, KNOWN.wrap) && kdfOk(w.kdf)) &&
    kr.previous.every((p) => onlyKnown(p, KNOWN.previous))
  );
}

/** 'sixkey-keybundle|1|' + canonicalJson of every member except mac, unknown ones included. */
export function bundleMacInput(b: object): string {
  const { mac: _mac, ...rest } = b as Record<string, unknown>;
  return TAG.keybundle + canonicalJsonStrict(rest);
}

export async function bundleMac(vk: Vk, b: object): Promise<string> {
  return toB64(await hmacSha256(await bundleMacKey(vk), bundleMacInput(b)));
}

/** False for any problem: wrong VK for this keyring, malformed mac, or a MAC that does not verify. */
export async function verifyBundleMac(vk: Vk, b: KeyBundle): Promise<boolean> {
  try {
    if (b.keyring.vkId !== vk.id) return false;
    const mac = fromB64(b.mac);
    if (mac.length !== 32) return false;
    return await crypto.subtle.verify("HMAC", await bundleMacKey(vk), bs(mac), bs(utf8(bundleMacInput(b))));
  } catch {
    return false;
  }
}

export type BundleFields = {
  vaultId: string;
  kver: number;
  keyring: Keyring;
  auth: BundleAuth;
  by: string;
  now: number;
};

/**
 * Build and MAC a bundle for upload. The keyring's times must already be whole hours (truncateKeyringTimes, before the
 * keyring is stored locally, so "adopted" can be judged by content). `raw` is the text to send; reuse it unchanged for
 * retries, because the server's idempotency compares the text (§3.6.0).
 */
export async function sealBundle(vk: Vk, f: BundleFields): Promise<{ bundle: KeyBundle; raw: string }> {
  if (f.keyring.vkId !== vk.id) throw new SyncCryptoError("invalid_argument", "the MAC key must be the keyring's VK");
  const unsigned = {
    format: "sixkey-keybundle",
    v: 1,
    vaultId: f.vaultId,
    kver: f.kver,
    keyring: f.keyring,
    auth: f.auth,
    by: f.by,
    at: floorToHour(f.now),
  } as const;
  const bundle: KeyBundle = { ...unsigned, mac: await bundleMac(vk, unsigned) };
  checkBundleShape(bundle, "upload");
  return { bundle, raw: JSON.stringify(bundle) };
}

/**
 * §3.9 R1 (N27, F-01): min(max(server kver, maxSeenKver) + 1, server kver + KVER_MAX_JUMP), the most the server accepts
 * (if_kver < kver <= if_kver + KVER_MAX_JUMP). After a very deep rollback a repair still publishes; it takes several to
 * pass the highest maxSeenKver. A result that is not a safe integer throws kver_overflow instead of being published.
 */
export function publishKver(serverKver: number, maxSeenKver: number): number {
  for (const n of [serverKver, maxSeenKver])
    if (!Number.isSafeInteger(n) || n < 0) throw new SyncCryptoError("invalid_argument", "bad kver");
  const next = Math.min(Math.max(serverKver, maxSeenKver) + 1, serverKver + C.KVER_MAX_JUMP);
  if (!Number.isSafeInteger(next)) throw new SyncCryptoError("kver_overflow");
  return next;
}

/** §3.8 P1: the cap on the previous list (its own module: the vault service needs it without the rest of this file). */
export { capPrevious } from "./cap-previous";

export type AdoptedRecord = { digest: string; auth: BundleAuth };

/**
 * §2.5 adopted {digest, auth}: what M2 stores next to maxSeenKver when a bundle is adopted or published. The digest,
 * SHA-256(canonicalJson({keyring, auth})), stands in for the local keyring when that is lost (F-06); auth is the
 * reference for "auth changes only with the password wrap" (F-07). Compute it only with this function.
 */
export async function adoptedRecord(b: KeyBundle): Promise<AdoptedRecord> {
  return { digest: toB64(await sha256(utf8(canonicalJsonStrict({ keyring: b.keyring, auth: b.auth })))), auth: b.auth };
}

/**
 * A bundle received with the VK that opens it (§3.2 M7 inside P, §3.3 step 4 from the recovery enrollment): read-mode
 * shape, then the VK is the keyring's, the vault is the expected one, and the MAC verifies. Throws invalid_bundle,
 * wrong_vault or bad_mac.
 */
export async function verifyReceivedBundle(raw: string, vk: Vk, expectedVaultId: string): Promise<KeyBundle> {
  const b = parseBundleText(raw);
  if (b.keyring.vkId !== vk.id) throw new SyncCryptoError("invalid_bundle", "keyring under another VK");
  if (b.vaultId !== expectedVaultId) throw new SyncCryptoError("wrong_vault");
  if (!(await verifyBundleMac(vk, b))) throw new SyncCryptoError("bad_mac");
  return b;
}

/** "Adopted" is judged by content: canonicalJson of the two keyrings (§3.9, P2). */
export const sameKeyring = (a: Keyring, b: Keyring): boolean => canonicalJsonStrict(a) === canonicalJsonStrict(b);

export const sameWrap = (a: WrappedKey | undefined, b: WrappedKey | undefined): boolean =>
  a !== undefined && b !== undefined && canonicalJsonStrict(a) === canonicalJsonStrict(b);

/** Two wraps hold the same key material: equal iv and wrapped bytes. */
export const sameWrapBytes = (a: WrappedKey | undefined, b: WrappedKey | undefined): boolean =>
  a !== undefined && b !== undefined && bytesEqual(b64(a.iv), b64(b.iv)) && bytesEqual(b64(a.wrapped), b64(b.wrapped));

export type RequiredVerifiers = { recoveryVerifier: boolean; passwordVerifier: boolean };

/**
 * P4 (§2.3), the server's keyless consistency rule, applied before sending PUT /v1/keys or a rotate: the recovery wrap
 * changes exactly when the request carries a new recovery_verifier; the password wrap changes exactly when auth.kdf
 * changes, and exactly then the request carries a new password_verifier. Throws when `next` breaks the second rule
 * (the server would answer 422), otherwise says which verifiers the request must carry.
 */
export function requiredVerifiers(server: KeyBundle, next: KeyBundle): RequiredVerifiers {
  const recoveryChanged = !sameWrapBytes(wrapOf(server.keyring, "recovery"), wrapOf(next.keyring, "recovery"));
  const passwordChanged = !sameWrapBytes(wrapOf(server.keyring, "password"), wrapOf(next.keyring, "password"));
  const authChanged = canonicalJsonStrict(server.auth.kdf) !== canonicalJsonStrict(next.auth.kdf);
  if (passwordChanged && !authChanged)
    throw new SyncCryptoError("invalid_bundle", "a new password wrap needs a new auth.kdf");
  if (authChanged && !passwordChanged)
    throw new SyncCryptoError("invalid_bundle", "auth.kdf changed without the password wrap");
  return { recoveryVerifier: recoveryChanged, passwordVerifier: passwordChanged };
}

/** T1: every createdAt floored to the hour. They are in no AAD, so every wrap still opens. Member order is kept. */
export function truncateKeyringTimes(kr: Keyring): Keyring {
  return {
    ...kr,
    wraps: kr.wraps.map((w) => ({ ...w, createdAt: floorToHour(w.createdAt) })),
    previous: kr.previous.map((p) => ({ ...p, createdAt: floorToHour(p.createdAt) })),
  };
}

/** Fresh auth.kdf for a new password wrap (P4: auth changes exactly when the password wrap does), never the wrap's salt. */
export function newBundleAuth(passwordWrapSalt: string, rng: Random = randomBytes): BundleAuth {
  const wrapSalt = b64(passwordWrapSalt);
  for (let i = 0; i < 3; i++) {
    const kdf = newPbkdf2Params(rng);
    if (!bytesEqual(b64(kdf.salt), wrapSalt)) return { kdf };
  }
  throw new SyncCryptoError("invalid_argument", "rng repeats");
}
