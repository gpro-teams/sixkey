// Enrollment primitives (§3.2; enrolment v2, revision 27): commitment C, transcript T and its hash h, ECDH Z, K_enroll
// over Z and the pairing secret S, the 6-digit SAS and the two ciphertexts under K_enroll. There is no confirmation code
// any more: what proved the approver to the new device is now that only a key holding S opens the payload. The state
// machines in enroll-new-device.ts / enroll-approver.ts decide when each may be used. In T and the AADs byte fields are
// base64url; in request bodies they are standard base64.
import { bs, concat, randomBytes, sha256, toB64, utf8, type Random } from "../../crypto/bytes";
import { hkdfAesKey } from "../../crypto/kdf";
import { PAIRING_SECRET_BYTES } from "../../crypto/pairing-code";
import { vkFromRaw, type Vk } from "../../crypto/vk";
import { SYNC_CONSTANTS as C } from "./constants";
import { isSpkiP256, isUncompressedPoint } from "./device-key";
import { padDeviceName, unpadDeviceName } from "./device-name";
import {
  DEVICE_ID_RE,
  ID_RE,
  UUID_RE,
  b64,
  canonicalJsonStrict,
  isPlainObject,
  parseIntegerJson,
  toB64u,
} from "./encoding";
import { SyncCryptoError } from "./errors";
import { ENROLL_LABEL as LABEL, ENROLL_TAG as TAG } from "./enroll-labels";

export const NONCE_BYTES = 32;
export const CODE_SPACE = 10 ** C.SAS_DIGITS;
export { PAIRING_SECRET_BYTES };

function need(ok: boolean): void {
  if (!ok) throw new SyncCryptoError("invalid_argument", "bad enrollment value");
}

/** 'sixkey-enroll-commit|2|' devN '|' b64u(dpk_N) '|' b64u(epk_N) '|' b64u(n_N): all of N's contribution, fixed before it sees epk_A. */
export function commitInput(devN: string, dpkN: Uint8Array, epkN: Uint8Array, nN: Uint8Array): string {
  need(DEVICE_ID_RE.test(devN) && isSpkiP256(dpkN) && isUncompressedPoint(epkN) && nN.length === NONCE_BYTES);
  return `${TAG.enrollCommit}${devN}|${toB64u(dpkN)}|${toB64u(epkN)}|${toB64u(nN)}`;
}

export const commitment = (devN: string, dpkN: Uint8Array, epkN: Uint8Array, nN: Uint8Array): Promise<Uint8Array> =>
  sha256(utf8(commitInput(devN, dpkN, epkN, nN)));

export type TranscriptParts = {
  rid: string;
  devN: string;
  devA: string;
  dpkN: Uint8Array;
  epkN: Uint8Array;
  epkA: Uint8Array;
  nN: Uint8Array;
};

/** T = 'sixkey-enroll|2|' rid '|' devN '|' devA '|' b64u(dpk_N) '|' b64u(epk_N) '|' b64u(epk_A) '|' b64u(n_N). */
export function transcript(t: TranscriptParts): string {
  need(UUID_RE.test(t.rid) && DEVICE_ID_RE.test(t.devN) && DEVICE_ID_RE.test(t.devA) && isSpkiP256(t.dpkN));
  need(isUncompressedPoint(t.epkN) && isUncompressedPoint(t.epkA) && t.nN.length === NONCE_BYTES);
  return `${TAG.enroll}${t.rid}|${t.devN}|${t.devA}|${toB64u(t.dpkN)}|${toB64u(t.epkN)}|${toB64u(t.epkA)}|${toB64u(t.nN)}`;
}

export const transcriptHash = (t: TranscriptParts): Promise<Uint8Array> => sha256(utf8(transcript(t)));

/** Z = ECDH(own ephemeral private key, peer epk), 32 bytes. */
export async function sharedSecret(own: CryptoKey, peer: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, own, 256));
}

/**
 * K_enroll = HKDF(IKM = Z || S, salt = h, 'sixkey/v2/enroll-key'): non-extractable AES-256-GCM, used for one request
 * (§3.2 M3, M4). Z is the 32-byte ECDH secret, S the 16-byte pairing secret: a recording of the whole enrolment does not
 * give K to anyone who later solves ECDH, because S never travels. Z, S and the IKM are wiped, whatever happens.
 */
export async function enrollKey(z: Uint8Array, s: Uint8Array, h: Uint8Array): Promise<CryptoKey> {
  const ikm = concat(z, s);
  try {
    need(z.length === 32 && s.length === PAIRING_SECRET_BYTES && h.length === 32);
    return await hkdfAesKey(ikm, h, LABEL.enrollKey);
  } finally {
    ikm.fill(0);
    z.fill(0);
    s.fill(0);
  }
}

/** uint32be(SHA-256(tag || h)[0..4]) mod space, zero-padded. space is 10^6 except in the adversary tests (§8.1). */
export async function shortCode(tag: string, h: Uint8Array, space: number = CODE_SPACE): Promise<string> {
  need(h.length === 32 && Number.isSafeInteger(space) && space >= 2);
  const d = await sha256(utf8(tag), h);
  const u32 = new DataView(d.buffer, d.byteOffset, 4).getUint32(0, false);
  return String(u32 % space).padStart(String(space - 1).length, "0");
}

/** SAS: shown by N, typed on A (the approver's second check, independent of S). */
export const sasOf = (h: Uint8Array, space?: number): Promise<string> => shortCode(TAG.sas, h, space);

/** Typed or pasted digits ("123 456" and "123-456" are fine); null when it cannot be a code of this length. */
export function normalizeCode(input: string, space: number = CODE_SPACE): string | null {
  const s = typeof input === "string" ? input.replace(/[\s-]/g, "") : "";
  return new RegExp(`^[0-9]{${String(space - 1).length}}$`).test(s) ? s : null;
}

// ---- ciphertexts under K_enroll: standard base64 of iv(12) || ct || tag(16) (§3.2, N6) ----------------------------

const aadFor = (tag: string, h: Uint8Array) => utf8(`${tag}${toB64u(h)}`);

async function seal(key: CryptoKey, tag: string, h: Uint8Array, pt: Uint8Array, rng: Random): Promise<string> {
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(aadFor(tag, h)), tagLength: 128 },
      key,
      bs(pt),
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}

async function open(key: CryptoKey, tag: string, h: Uint8Array, wire: string): Promise<Uint8Array> {
  try {
    const w = b64(wire);
    if (w.length < 12 + 16) throw new Error("short");
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(w.subarray(0, 12)), additionalData: bs(aadFor(tag, h)), tagLength: 128 },
        key,
        bs(w.subarray(12)),
      ),
    );
  } catch {
    throw new SyncCryptoError("decrypt_failed");
  }
}

/** The reveal name_ct: the §2.4-checked name padded to 160 bytes, so the wire value is always 188 bytes (N5). */
export const sealRevealName = (
  key: CryptoKey,
  h: Uint8Array,
  name: string,
  rng: Random = randomBytes,
): Promise<string> => seal(key, TAG.enrollName, h, padDeviceName(name), rng);

/** The name the new device claims, checked again with the §2.4 rules before it is shown as "claims to be: …". */
export async function openRevealName(key: CryptoKey, h: Uint8Array, wire: string): Promise<string> {
  return unpadDeviceName(await open(key, TAG.enrollName, h, wire));
}

export const sealPayload = (key: CryptoKey, h: Uint8Array, text: string, rng: Random = randomBytes): Promise<string> =>
  seal(key, TAG.enrollPayload, h, utf8(text), rng);

export async function openPayload(key: CryptoKey, h: Uint8Array, wire: string): Promise<string> {
  const pt = await open(key, TAG.enrollPayload, h, wire);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(pt);
  } catch {
    throw new SyncCryptoError("invalid_payload", "not UTF-8");
  } finally {
    pt.fill(0); // holds the VK
  }
}

// ---- the payload P (§3.2 M5) --------------------------------------------------------------------------------------

export type EnrollPayload = { vaultId: string; vk: Vk; bundleRaw: string; approver: string; at: number };

/**
 * P = canonicalJson({format, v, vaultId, vk: b64(VK), bundle: <raw bundle text>, approver, at}). bundle is the text the
 * server stores, so nothing in P is re-serialized (N7); at is exact ms and never seen by the server.
 */
export function payloadText(p: { vaultId: string; vk: Vk; bundleRaw: string; approver: string; at: number }): string {
  need(
    ID_RE.test(p.vaultId) &&
      DEVICE_ID_RE.test(p.approver) &&
      typeof p.bundleRaw === "string" &&
      Number.isSafeInteger(p.at) &&
      p.at >= 0,
  );
  return canonicalJsonStrict({
    format: "sixkey-enroll-payload",
    v: 2,
    vaultId: p.vaultId,
    vk: toB64(p.vk.raw),
    bundle: p.bundleRaw,
    approver: p.approver,
    at: p.at,
  });
}

/** Members a later version adds are ignored: P is authenticated end to end and they mean nothing to this client. */
export async function parsePayloadText(text: string): Promise<EnrollPayload> {
  let o: unknown;
  try {
    o = parseIntegerJson(text);
  } catch {
    throw new SyncCryptoError("invalid_payload", "not integer-only JSON");
  }
  const bad = (): never => {
    throw new SyncCryptoError("invalid_payload", "bad payload");
  };
  if (!isPlainObject(o) || o.format !== "sixkey-enroll-payload" || o.v !== 2) return bad(); // v 2: enrolment v2 (§2.6)
  if (typeof o.vaultId !== "string" || !ID_RE.test(o.vaultId) || typeof o.bundle !== "string") bad();
  if (
    typeof o.approver !== "string" ||
    !DEVICE_ID_RE.test(o.approver) ||
    !Number.isSafeInteger(o.at) ||
    (o.at as number) < 0
  )
    bad();
  let raw: Uint8Array;
  try {
    raw = b64(o.vk, 32);
  } catch {
    return bad();
  }
  return {
    vaultId: o.vaultId as string,
    vk: await vkFromRaw(raw),
    bundleRaw: o.bundle as string,
    approver: o.approver as string,
    at: o.at as number,
  };
}
