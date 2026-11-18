// Keyring: the vault key (VK) wrapped under one or more key-encryption keys (KEKs).
// Changing the master password only re-wraps the VK; the vault ciphertext is untouched (PLAN §5.1).
// All functions are pure over their inputs and return a new keyring.
import { CryptoError, bs, fromB64, randomBytes, toB64, utf8, type Random } from "./bytes";
import {
  assertKdfParams,
  deriveKekFromPassword,
  hkdfAesKey,
  newHkdfParams,
  newPbkdf2Params,
  type KdfParams,
} from "./kdf";
import { passwordCandidates } from "./password-candidates";
import { generateRecoveryCode, parseRecoveryCode } from "./recovery-code";
import { generateVk, vkFromRaw, type Vk } from "./vk";

// (A fourth value, "webauthn-prf", was reserved here until the device unlock came: its wraps live in sk_prf, outside the
// keyring, which stays exactly password + recovery (YUBIKEY-DESIGN D12; YR-24 removed the value, QUICK-UNLOCK Stage 2).)
export type WrapMethod = "device" | "password" | "recovery";

export type WrappedKey = {
  method: WrapMethod;
  vkId: string;
  kdf?: KdfParams; // present in every wrap validateKeyring accepts
  iv: string;
  wrapped: string; // base64 AES-GCM(KEK, VK bytes)
  createdAt: number;
};

/** Earlier VKs, wrapped by the current one, so old versions stay readable after a rotation. Filled by VK rotation (task 8). */
export type PreviousVk = { vkId: string; iv: string; wrapped: string; createdAt: number };

export type Keyring = {
  format: "sixkey-keyring";
  v: 1;
  vaultId: string;
  vkId: string;
  wraps: WrappedKey[];
  deviceKey?: string; // base64 32 bytes; stored with the data, so it only guards against casual reads
  previous: PreviousVk[];
};

export type Ctx = { now?: () => number; rng?: Random; vaultId?: string };

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX_RE = /^[0-9a-f]{16}$/;
const METHODS: WrapMethod[] = ["device", "password", "recovery"];

function kdfDescriptor(kdf: KdfParams | undefined): string {
  if (!kdf) return "none";
  return kdf.name === "PBKDF2" ? `PBKDF2-SHA256:${kdf.iterations}:${kdf.salt}` : `HKDF-SHA256:${kdf.salt}`;
}

/** Binds method, key id, vault id and KDF parameters, so none of them can be swapped without breaking the unwrap. */
function wrapAad(method: WrapMethod, vkId: string, vaultId: string, kdf: KdfParams | undefined): Uint8Array {
  return utf8(`sixkey-wrap|1|${method}|${vkId}|${vaultId}|${kdfDescriptor(kdf)}`);
}

async function wrapVk(
  vk: Vk,
  kek: CryptoKey,
  method: WrapMethod,
  kdf: KdfParams | undefined,
  vaultId: string,
  ctx: Ctx,
): Promise<WrappedKey> {
  const rng = ctx.rng ?? randomBytes;
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(wrapAad(method, vk.id, vaultId, kdf)), tagLength: 128 },
      kek,
      bs(vk.raw),
    ),
  );
  const w: WrappedKey = { method, vkId: vk.id, iv: toB64(iv), wrapped: toB64(ct), createdAt: (ctx.now ?? Date.now)() };
  if (kdf) w.kdf = kdf;
  return w;
}

async function unwrapVk(w: WrappedKey, kek: CryptoKey, vaultId: string): Promise<Vk> {
  try {
    const raw = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bs(fromB64(w.iv)),
          additionalData: bs(wrapAad(w.method, w.vkId, vaultId, w.kdf)),
          tagLength: 128,
        },
        kek,
        bs(fromB64(w.wrapped)),
      ),
    );
    const vk = await vkFromRaw(raw);
    if (vk.id !== w.vkId) throw new Error("id mismatch");
    return vk;
  } catch {
    // Wrong password, wrong code, tampering and corruption are deliberately indistinguishable.
    throw new CryptoError("unwrap_failed");
  }
}

function find(keyring: Keyring, method: WrapMethod): WrappedKey {
  const w = keyring.wraps.find((x) => x.method === method);
  if (!w) throw new CryptoError("no_such_method", method);
  return w;
}

function requireKdf(w: WrappedKey): KdfParams {
  assertKdfParams(w.kdf);
  return w.kdf;
}

function sameVk(keyring: Keyring, vk: Vk): void {
  if (keyring.vkId !== vk.id) throw new CryptoError("invalid_keyring", "vk does not belong to this keyring");
}

function without(keyring: Keyring, ...methods: WrapMethod[]): WrappedKey[] {
  return keyring.wraps.filter((w) => !methods.includes(w.method));
}

export function newVaultId(rng: Random = randomBytes): string {
  return toB64(rng(16)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function listMethods(keyring: Keyring): WrapMethod[] {
  return keyring.wraps.map((w) => w.method);
}

export function validateKeyring(x: unknown): Keyring {
  const bad = (m: string): never => {
    throw new CryptoError("invalid_keyring", m);
  };
  if (typeof x !== "object" || x === null) return bad("not an object");
  const o = x as Record<string, unknown>;
  if (o.format !== "sixkey-keyring" || o.v !== 1) return bad("unsupported format");
  if (typeof o.vaultId !== "string" || !ID_RE.test(o.vaultId)) return bad("bad vaultId");
  if (typeof o.vkId !== "string" || !HEX_RE.test(o.vkId)) return bad("bad vkId");
  if (!Array.isArray(o.wraps) || o.wraps.length === 0) return bad("no wrapped keys");
  for (const w of o.wraps as Record<string, unknown>[]) {
    if (!w || typeof w !== "object" || !METHODS.includes(w.method as WrapMethod) || w.vkId !== o.vkId)
      return bad("bad wrapped key");
    if (
      typeof w.iv !== "string" ||
      fromB64(w.iv).length !== 12 ||
      typeof w.wrapped !== "string" ||
      fromB64(w.wrapped).length !== 48
    )
      return bad("bad wrapped key bytes");
    assertKdfParams(w.kdf);
  }
  if (o.deviceKey !== undefined && (typeof o.deviceKey !== "string" || fromB64(o.deviceKey).length !== 32))
    return bad("bad device key");
  if (!Array.isArray(o.previous) || o.previous.length > 64) return bad("previous must be an array");
  for (const p of o.previous as Record<string, unknown>[]) {
    if (
      !p ||
      typeof p.vkId !== "string" ||
      !HEX_RE.test(p.vkId) ||
      typeof p.iv !== "string" ||
      fromB64(p.iv).length !== 12 ||
      typeof p.wrapped !== "string" ||
      fromB64(p.wrapped).length !== 48
    )
      return bad("bad previous key");
  }
  return o as unknown as Keyring;
}

/** New vault: random VK, wrapped by a random device key until the user sets a master password. */
export async function createKeyring(ctx: Ctx = {}): Promise<{ keyring: Keyring; vk: Vk }> {
  const rng = ctx.rng ?? randomBytes;
  const vaultId = ctx.vaultId ?? newVaultId(rng);
  if (!ID_RE.test(vaultId)) throw new CryptoError("invalid_keyring", "bad vaultId");
  const vk = await generateVk(rng);
  const deviceKey = rng(32);
  const kdf = newHkdfParams(rng);
  const kek = await hkdfAesKey(deviceKey, fromB64(kdf.salt), "sixkey/v1/kek-device");
  const keyring: Keyring = {
    format: "sixkey-keyring",
    v: 1,
    vaultId,
    vkId: vk.id,
    wraps: [await wrapVk(vk, kek, "device", kdf, vaultId, ctx)],
    deviceKey: toB64(deviceKey),
    previous: [],
  };
  return { keyring, vk };
}

export async function unlockWithDevice(keyring: Keyring): Promise<Vk> {
  const w = find(keyring, "device");
  if (!keyring.deviceKey) throw new CryptoError("no_such_method", "device key removed");
  const kdf = requireKdf(w);
  if (kdf.name !== "HKDF") throw new CryptoError("invalid_kdf_params");
  return unwrapVk(
    w,
    await hkdfAesKey(fromB64(keyring.deviceKey), fromB64(kdf.salt), "sixkey/v1/kek-device"),
    keyring.vaultId,
  );
}

/**
 * The password exactly as given (NFKC aside): the contract's reading (test/unit/contract-vectors.test.ts). The server
 * sync's engine checked with this one; its client is gone (DV-0b). The local prompts use openWithPassword.
 */
export async function unlockWithPassword(keyring: Keyring, password: string): Promise<Vk> {
  const w = find(keyring, "password");
  return unwrapVk(w, await deriveKekFromPassword(password, requireKdf(w)), keyring.vaultId);
}

/**
 * The master password as a person types it back (password-candidates.ts; PASSWORD-SETUP-NOTES §7): `typed` as given,
 * then, only when it has a generated shape and is not already the generator's spelling, that spelling once. Returns the
 * vault key and the spelling that opened it. Whatever is derived from the password after the check (a rotation's new
 * wrap) must use that spelling, never `typed`: then the stored password is exactly what
 * it would be had the person typed it exactly, and a loose spelling can never become the stored password.
 * At most two key derivations; failing both is one failure (the second one's unwrap_failed, recorded once by the
 * caller). Only a wrong key moves on to the second: an empty password, a missing wrap or bad parameters throw at once.
 * The local prompts (the service, the PIN box) use this (the server sync's engine, removed in DV-0b, kept
 * unlockWithPassword: docs/design/notes/PASSWORD-SETUP-NOTES.md §7.5).
 */
export async function openWithPassword(keyring: Keyring, typed: string): Promise<{ vk: Vk; password: string }> {
  const w = find(keyring, "password");
  const kdf = requireKdf(w);
  const [first, second] = passwordCandidates(typed);
  try {
    return { vk: await unwrapVk(w, await deriveKekFromPassword(first, kdf), keyring.vaultId), password: first };
  } catch (e) {
    if (second === undefined || !(e instanceof CryptoError && e.code === "unwrap_failed")) throw e;
  }
  return { vk: await unwrapVk(w, await deriveKekFromPassword(second, kdf), keyring.vaultId), password: second };
}

export async function unlockWithRecoveryCode(keyring: Keyring, code: string): Promise<Vk> {
  const w = find(keyring, "recovery");
  const kdf = requireKdf(w);
  if (kdf.name !== "HKDF") throw new CryptoError("invalid_kdf_params");
  const secret = await parseRecoveryCode(code);
  return unwrapVk(w, await hkdfAesKey(secret, fromB64(kdf.salt), "sixkey/v1/kek-recovery"), keyring.vaultId);
}

/** Add or replace the master-password wrap. A fresh salt is used every time. */
export async function setPassword(
  keyring: Keyring,
  vk: Vk,
  password: string,
  ctx: Ctx & { iterations?: number } = {},
): Promise<Keyring> {
  sameVk(keyring, vk);
  const kdf = newPbkdf2Params(ctx.rng ?? randomBytes, ctx.iterations);
  const kek = await deriveKekFromPassword(password, kdf);
  return {
    ...keyring,
    wraps: [...without(keyring, "password"), await wrapVk(vk, kek, "password", kdf, keyring.vaultId, ctx)],
  };
}

/** Add or replace the recovery wrap. The previous code stops working. Returns the new code to show once. */
export async function setRecovery(
  keyring: Keyring,
  vk: Vk,
  ctx: Ctx = {},
): Promise<{ keyring: Keyring; recoveryCode: string }> {
  sameVk(keyring, vk);
  const rng = ctx.rng ?? randomBytes;
  const code = await generateRecoveryCode(rng);
  const kdf = newHkdfParams(rng);
  const kek = await hkdfAesKey(code.secret, fromB64(kdf.salt), "sixkey/v1/kek-recovery");
  return {
    keyring: {
      ...keyring,
      wraps: [...without(keyring, "recovery"), await wrapVk(vk, kek, "recovery", kdf, keyring.vaultId, ctx)],
    },
    recoveryCode: code.text,
  };
}

/**
 * Turn on the master password: password + recovery wraps are added and the device wrap and device key are removed
 * in one step. Older copies of the keyring (snapshots, mirror) must be purged by the storage layer, and the VK
 * rotated, or they can still open the vault (PLAN §5.3).
 */
export async function enableMasterPassword(
  keyring: Keyring,
  vk: Vk,
  password: string,
  ctx: Ctx & { iterations?: number } = {},
): Promise<{ keyring: Keyring; recoveryCode: string }> {
  const withPassword = await setPassword(keyring, vk, password, ctx);
  const withRecovery = await setRecovery(withPassword, vk, ctx);
  const { deviceKey: _drop, ...rest } = withRecovery.keyring;
  return {
    keyring: { ...rest, wraps: without(withRecovery.keyring, "device") },
    recoveryCode: withRecovery.recoveryCode,
  };
}

/** Change the password; requires an unlocked VK. Only the password wrap changes. */
export async function changePassword(
  keyring: Keyring,
  vk: Vk,
  newPassword: string,
  ctx: Ctx & { iterations?: number } = {},
): Promise<Keyring> {
  find(keyring, "password");
  return setPassword(keyring, vk, newPassword, ctx);
}

export function removeMethod(keyring: Keyring, method: WrapMethod): Keyring {
  const wraps = without(keyring, method);
  if (wraps.length === 0) throw new CryptoError("invalid_keyring", "cannot remove the last way to unlock");
  const next: Keyring = { ...keyring, wraps };
  if (method === "device") delete next.deviceKey;
  return next;
}

// ---- previous VKs (kept so older copies stay readable after a key rotation) -------------------------------------

const NO_SALT = new Uint8Array(0);
const prevAad = (vaultId: string, newVkId: string, oldVkId: string) =>
  utf8(`sixkey-prev|1|${vaultId}|${newVkId}|${oldVkId}`);

/** Record the retired VK inside the keyring, wrapped by the new one. Only someone who can open the new VK can read it. */
export async function retirePreviousVk(keyring: Keyring, oldVk: Vk, newVk: Vk, ctx: Ctx = {}): Promise<Keyring> {
  sameVk(keyring, newVk);
  const rng = ctx.rng ?? randomBytes;
  const kek = await hkdfAesKey(newVk.raw, NO_SALT, "sixkey/v1/kek-previous");
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(prevAad(keyring.vaultId, newVk.id, oldVk.id)), tagLength: 128 },
      kek,
      bs(oldVk.raw),
    ),
  );
  const rec: PreviousVk = { vkId: oldVk.id, iv: toB64(iv), wrapped: toB64(ct), createdAt: (ctx.now ?? Date.now)() };
  return { ...keyring, previous: [...keyring.previous.filter((p) => p.vkId !== oldVk.id), rec] };
}

export async function unwrapPreviousVks(keyring: Keyring, vk: Vk): Promise<Vk[]> {
  sameVk(keyring, vk);
  const kek = await hkdfAesKey(vk.raw, NO_SALT, "sixkey/v1/kek-previous");
  const out: Vk[] = [];
  for (const p of keyring.previous) {
    try {
      const raw = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bs(fromB64(p.iv)),
            additionalData: bs(prevAad(keyring.vaultId, vk.id, p.vkId)),
            tagLength: 128,
          },
          kek,
          bs(fromB64(p.wrapped)),
        ),
      );
      const old = await vkFromRaw(raw);
      if (old.id === p.vkId) out.push(old);
    } catch {
      /* an unreadable entry is skipped; it only matters for very old copies */
    }
  }
  return out;
}

/**
 * Fresh keyring for a new VK: same vault, no device key, password + recovery wraps, and the old VK retired inside it.
 * Used when turning on the master password and when rotating the key.
 */
export async function rekey(
  keyring: Keyring,
  oldVk: Vk,
  password: string,
  ctx: Ctx & { iterations?: number } = {},
): Promise<{ keyring: Keyring; vk: Vk; recoveryCode: string }> {
  sameVk(keyring, oldVk);
  const rng = ctx.rng ?? randomBytes;
  const older = await unwrapPreviousVks(keyring, oldVk); // retired earlier, wrapped by oldVk: re-wrap under the new key
  const vk = await generateVk(rng);
  const base: Keyring = {
    format: "sixkey-keyring",
    v: 1,
    vaultId: keyring.vaultId,
    vkId: vk.id,
    wraps: [],
    previous: [],
  };
  const withPassword = await setPassword(base, vk, password, ctx);
  const withRecovery = await setRecovery(withPassword, vk, ctx);
  let out = withRecovery.keyring;
  for (const o of [...older, oldVk]) out = await retirePreviousVk(out, o, vk, ctx);
  return { keyring: out, vk, recoveryCode: withRecovery.recoveryCode };
}
