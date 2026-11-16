// The 28-symbol codes: 128 random bits + 12 check bits = 140 bits = 28 Crockford base32 symbols, shown as 7 groups of 4.
// The check bits only catch typos; the secret is the 128 random bits. They are the first 12 bits of
// SHA-256(tag || secret), and the tag says which kind of code it is:
//   - the recovery code: the empty tag (Phase 0: every recovery code already given out reads as before);
//   - the pairing code of the approval join (SYNC-DESIGN §3.2 MUST 10, revision 27): its own tag (pairing-code.ts).
// So a recovery code typed where the pairing code belongs, or the other way round, fails its check bits (all but about
// 1 in 4096). Both read the same way: any case, spaces, hyphens; O as 0 and I/L as 1 (Crockford). This module is the
// codec of both (formatCode, parseCode); pairing-code.ts only names the pairing kind, so that the popup, which reads
// recovery codes but never pairs a device, does not carry it.
import { CryptoError, randomBytes, sha256, utf8, type Random } from "./bytes";
import { CROCKFORD as ALPHABET, normalizeCrockford } from "./crockford";
const SYMBOLS = 28;
const SECRET_BYTES = 16;

async function checkBits(secret: Uint8Array, tag: string): Promise<bigint> {
  const h = await sha256(utf8(tag), secret);
  return (BigInt(h[0]!) << 4n) | BigInt(h[1]! >> 4); // first 12 bits
}

function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** A code's text from its secret; `tag` is the kind's check-bit tag ("" for the recovery code). */
export async function formatCode(secret: Uint8Array, tag: string): Promise<string> {
  if (secret.length !== SECRET_BYTES) throw new RangeError("a code secret must be 16 bytes");
  let n = (toBigInt(secret) << 12n) | (await checkBits(secret, tag));
  let s = "";
  for (let i = 0; i < SYMBOLS; i++) {
    s = ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s.match(/.{4}/g)!.join("-");
}

/** The secret from what was typed; `kind` names the errors (recovery_length, pairing_checksum, ...). */
export async function parseCode(input: string, tag: string, kind: "recovery" | "pairing"): Promise<Uint8Array> {
  const s = normalizeRecoveryInput(input);
  if (s.length !== SYMBOLS) throw new CryptoError(`${kind}_length`);
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new CryptoError(`${kind}_char`);
    n = (n << 5n) | BigInt(v);
  }
  const check = n & 0xfffn;
  const secretBig = n >> 12n;
  const secret = new Uint8Array(SECRET_BYTES);
  let t = secretBig;
  for (let i = SECRET_BYTES - 1; i >= 0; i--) {
    secret[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  if ((await checkBits(secret, tag)) !== check) {
    secret.fill(0); // a typo of a secret is a few bits away from it: not left behind either
    throw new CryptoError(`${kind}_checksum`);
  }
  return secret;
}

export type RecoveryCode = { secret: Uint8Array; text: string };

export async function generateRecoveryCode(rng: Random = randomBytes): Promise<RecoveryCode> {
  const secret = rng(SECRET_BYTES);
  return { secret, text: await formatRecoveryCode(secret) };
}

export const formatRecoveryCode = (secret: Uint8Array): Promise<string> => formatCode(secret, "");

/** Accepts full-width forms (NFKC), any case, spaces, hyphens; reads O as 0 and I/L as 1 (Crockford; crockford.ts). */
export function normalizeRecoveryInput(input: string): string {
  return normalizeCrockford(input);
}

/** recovery_length, recovery_char or recovery_checksum (a typo, or a pairing code typed here). */
export const parseRecoveryCode = (input: string): Promise<Uint8Array> => parseCode(input, "", "recovery");
