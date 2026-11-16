// Recovery code shares (docs/design/proposals/ADVANCED-RECOVERY-AND-TIERS.md §3; docs/design/notes/SHAMIR-NOTES.md):
// the 128-bit recovery code secret R split into n shares, any t of which rebuild it. Shares are only another way to
// obtain R: the keyring, the recovery wrap, sync and the contract do not change, and nothing about a share set is stored.
//
// The arithmetic is SLIP-39's secret sharing for one group (SatoshiLabs SLIP-0039; the reference is
// trezor/python-shamir-mnemonic, shamir.py `_split_secret`, `_recover_secret`, `_interpolate`), byte for byte:
//   - bytewise Shamir over GF(2^8) with the Rijndael polynomial x^8 + x^4 + x^3 + x + 1, by Lagrange interpolation;
//   - for a threshold t >= 2: t - 2 random shares at x = 0 .. t - 3, a digest share at x = 254, equal to
//     HMAC-SHA256(key = r, msg = R)[0..4] || r with r random (n - 4 bytes for an n-byte secret), and R at x = 255; the
//     other member shares at x = t - 2 .. count - 1 by interpolation (random bytes drawn in exactly that order);
//   - recovery interpolates at 255 and 254, and the digest must check out (a wrong combination passes with 2^-32).
// What differs from SLIP-39: no Feistel layer (R is uniformly random, so a public permutation of it adds nothing), no
// groups, and the text below instead of SLIP-39's words (§3.4: a Sixkey share must not look like a wallet backup).
// test/unit/shares-slip39.test.ts runs this against SLIP-39's official vectors at the level of the shares and the digest.
//
// Implementation rules (§3.3, from the reference and the audit history of other libraries):
//   - random shares and the digest's random part come from the caller's Random (crypto.getRandomValues), used uniformly:
//     nothing is rejected (no "non-zero leading coefficient" rule, which would itself leak a little about R);
//   - no table indexed by secret bytes: multiplication is shift-and-XOR with masks, inversion is a^254; the work depends
//     only on public values (how many shares, how long). JavaScript gives no constant-time guarantee, so this is
//     "algorithmically constant-time";
//   - a set is refused before any arithmetic unless it is exactly t shares of one set (version, kind, set id, threshold)
//     with distinct x; the digest is compared in constant time; intermediate buffers are zeroed (best effort).
//
// Text: Sixkey share v1, 180 bits = 36 Crockford base32 symbols, shown as 9 groups of 4:
//   4 bits version (1) | 4 bits kind (0: recovery code share; 1 is reserved for an heir share) | 16 bits set id (random,
//   the same in every share of a set) | 4 bits threshold - 1 | 4 bits member index x | 128 bits share value |
//   20 bits check: CRC-20 with the generator x^20 + 0xFD2A9 (0x1FD2A9, a primitive polynomial), over "sixkey-share|1|"
//   then the first 20 bytes above (the tag's bytes are the register's start), most significant bit first.
// What the check guarantees (test/unit/shares-crypto.test.ts proves each over random shares, and the syndromes for all of
// them): the 36 symbols are exactly the 180 bits, the check exactly the last 4 symbols, so a change confined to 4
// consecutive symbols is a burst of at most 20 bits, which a degree-20 CRC with a constant term always detects: every
// single-symbol substitution and every swap of two neighbours; and with this generator the 1,116 single-symbol errors
// (36 places x 31 values) have 1,116 distinct non-zero syndromes, so every two substitutions anywhere are detected too.
// Anything else passes with about 2^-20, and then the digest stops it (2^-32). The recovery code's own check (12 bits of
// SHA-256, recovery-code.ts) is unchanged: Phase 0's codes are already given out.
// Read as the recovery code is (any case; spaces, hyphens and underscores ignored; O as 0, I and L as 1). The length
// differs from the recovery code's and the pairing code's (28 symbols), so no Sixkey code is ever accepted in another's
// field; the tag separates the domains besides. A check that fails is a typo (share_checksum); a share whose check holds
// but whose version or kind this reader does not know was made by a newer Sixkey (share_newer). A later version of the
// same length keeps v1's check over its first 20 bytes, so that a v1 reader says "newer" for it rather than "typo".
//
// Imports: only the two leaf modules below (and WebCrypto). The popup's share entry loads this module lazily, and a lazy
// chunk that imports a module of the popup's main chunk (bytes.ts, recovery-code.ts) splits that chunk in two, which cost
// the counted bundle about 500 B (SHAMIR-NOTES.md §7); so the few helpers it needs are here, and the recovery code's
// own text is made by the caller's formatter (recoveryCodeFromShares).
import { CROCKFORD as ALPHABET, normalizeCrockford } from "./crockford";
import { CryptoError } from "./crypto-error";

type Random = (n: number) => Uint8Array;
const randomBytes: Random = (n) => crypto.getRandomValues(new Uint8Array(n));
const bs = (b: Uint8Array): BufferSource => b as BufferSource;
export const SHARE_TAG = "sixkey-share|1|";
export const SHARE_SYMBOLS = 36;
export const SHARE_VERSION = 1;
/** The kind of a recovery code share; 1 (an heir share, §4.3) and the rest are reserved. */
export const KIND_RECOVERY = 0;
/** SLIP-39's MAX_SHARE_COUNT: the member index is 4 bits. */
export const MAX_SHARES = 16;
export const DIGEST_INDEX = 254;
export const SECRET_INDEX = 255;
export const DIGEST_BYTES = 4;
/** The recovery code secret's length: the only secret Sixkey shares. */
export const SHARED_SECRET_BYTES = 16;
const HEADER_BYTES = 4;
const CHECK_BITS = 20n;

/** One point of the sharing polynomial: SLIP-39's RawShare (x, data). */
export type RawShare = { x: number; data: Uint8Array };

// ---- GF(2^8) ---------------------------------------------------------------------------------------------------

/**
 * a·b in GF(2^8) mod x^8 + x^4 + x^3 + x + 1 (0x11B), by shift-and-XOR. Eight fixed rounds whose steps are chosen by
 * masks, not branches or tables, so the work does not depend on the values.
 */
export function gfMul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    p ^= -(b & 1) & a; // a when b's low bit is set
    const carry = -((a >> 7) & 1); // all ones when a's top bit is set
    a = ((a << 1) ^ (carry & 0x1b)) & 0xff;
    b >>= 1;
  }
  return p & 0xff;
}

/** a^-1 in GF(2^8) as a^254 (a fixed chain of squarings and products); 0 maps to 0. */
export function gfInv(a: number): number {
  // 254 = 0b11111110: square-and-multiply from the top bit, always the same 13 operations
  let r = a;
  for (let i = 0; i < 6; i++) r = gfMul(gfMul(r, r), a); // a^3, a^7, ..., a^127
  return gfMul(r, r); // a^254
}

/**
 * f(x) for the polynomial through `points` (SLIP-39 `_interpolate`): distinct x, values of one length. When x is one of
 * the points', that point's value (a copy). The Lagrange weights depend on the x coordinates only, which are public.
 */
export function interpolate(points: readonly RawShare[], x: number): Uint8Array {
  if (points.length === 0) throw new CryptoError("shares_count");
  const xs = new Set(points.map((p) => p.x));
  if (xs.size !== points.length) throw new CryptoError("shares_duplicate");
  const len = points[0]!.data.length;
  if (points.some((p) => p.data.length !== len)) throw new CryptoError("shares_mixed");
  const at = points.find((p) => p.x === x);
  if (at) return Uint8Array.from(at.data);
  const out = new Uint8Array(len);
  for (const p of points) {
    let num = 1;
    let den = 1;
    for (const q of points) {
      if (q === p) continue;
      num = gfMul(num, x ^ q.x);
      den = gfMul(den, p.x ^ q.x);
    }
    const w = gfMul(num, gfInv(den)); // the Lagrange basis polynomial of p, at x
    for (let k = 0; k < len; k++) out[k]! ^= gfMul(w, p.data[k]!);
  }
  return out;
}

// ---- the digest and SLIP-39's split and recovery ------------------------------------------------------------------

/** SLIP-39 `_create_digest`: HMAC-SHA256 with key `r` over `secret`, its first 4 bytes. */
export async function digestOf(r: Uint8Array, secret: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bs(r), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bs(secret))).slice(0, DIGEST_BYTES);
}

function equalCt(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/**
 * SLIP-39 `_split_secret(threshold, share_count, shared_secret)`: the member shares at x = 0 .. count - 1, drawing from
 * `rng` exactly as the reference draws from RANDOM_BYTES (t - 2 values of the secret's length, then one of its length
 * minus 4). With t = 1 every share is the secret (SLIP-39 allows it; Sixkey's sets never use it, see makeShareSet).
 */
export async function splitSecret(
  threshold: number,
  count: number,
  secret: Uint8Array,
  rng: Random = randomBytes,
): Promise<RawShare[]> {
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError("threshold must be a positive integer");
  if (!Number.isInteger(count) || threshold > count) throw new RangeError("threshold must not exceed the count");
  if (count > MAX_SHARES) throw new RangeError(`at most ${MAX_SHARES} shares`);
  if (secret.length < SHARED_SECRET_BYTES || secret.length % 2 !== 0)
    throw new RangeError("the secret must be at least 16 bytes, an even number");
  if (threshold === 1) return Array.from({ length: count }, (_, x) => ({ x, data: Uint8Array.from(secret) }));
  const shares: RawShare[] = [];
  for (let x = 0; x < threshold - 2; x++) shares.push({ x, data: take(rng, secret.length) });
  const r = take(rng, secret.length - DIGEST_BYTES);
  const digestShare = new Uint8Array(secret.length);
  digestShare.set(await digestOf(r, secret), 0);
  digestShare.set(r, DIGEST_BYTES);
  r.fill(0);
  const base = [...shares, { x: DIGEST_INDEX, data: digestShare }, { x: SECRET_INDEX, data: secret }];
  for (let x = threshold - 2; x < count; x++) shares.push({ x, data: interpolate(base, x) });
  digestShare.fill(0);
  return shares;
}

/** A copy of n fresh random bytes (the caller's buffer is not kept, so zeroing ours never touches it). */
function take(rng: Random, n: number): Uint8Array {
  const b = rng(n);
  if (!(b instanceof Uint8Array) || b.length !== n) throw new RangeError("random bytes");
  return Uint8Array.from(b);
}

/**
 * SLIP-39 `_recover_secret(threshold, shares)`: the secret at x = 255, after the digest at x = 254 checks out
 * (shares_digest otherwise: a wrong combination, or a typo the check bits missed). With t = 1, the one share's value.
 */
export async function recoverSecret(threshold: number, shares: readonly RawShare[]): Promise<Uint8Array> {
  if (threshold === 1) return Uint8Array.from(shares[0]!.data);
  const secret = interpolate(shares, SECRET_INDEX);
  const digestShare = interpolate(shares, DIGEST_INDEX);
  const ok = equalCt(digestShare.subarray(0, DIGEST_BYTES), await digestOf(digestShare.subarray(DIGEST_BYTES), secret));
  digestShare.fill(0);
  if (!ok) {
    secret.fill(0);
    throw new CryptoError("shares_digest");
  }
  return secret;
}

// ---- Sixkey share v1: the text --------------------------------------------------------------------------------

/** One share as read from its text. `index` is the member index x (0-based; the page shows x + 1). */
export type Share = { setId: number; threshold: number; index: number; value: Uint8Array };

/** The check's generator without its x^20 term (x^20 + 0xFD2A9: primitive; see the header for what it guarantees). */
export const CRC_POLY = 0xfd2a9;
/** One byte into the CRC-20 register, most significant bit first; masks, not branches, on the bits. */
function crcByte(r: number, byte: number): number {
  for (let k = 7; k >= 0; k--) {
    const fb = ((r >>> 19) ^ (byte >>> k)) & 1;
    r = ((r << 1) & 0xfffff) ^ (-fb & CRC_POLY);
  }
  return r;
}
/** The register after the tag: where every share's check starts. */
const TAG_STATE = Array.from(new TextEncoder().encode(SHARE_TAG)).reduce(crcByte, 0);
/** The 20 check bits of a share's first 20 bytes. */
export function checkOf(head: Uint8Array): number {
  let r = TAG_STATE;
  for (const b of head) r = crcByte(r, b);
  return r;
}

/** A share's text: 36 symbols in 9 groups of 4, joined by hyphens. */
export async function formatShare(s: Share): Promise<string> {
  if (!Number.isInteger(s.setId) || s.setId < 0 || s.setId > 0xffff) throw new RangeError("set id: 16 bits");
  if (!Number.isInteger(s.threshold) || s.threshold < 1 || s.threshold > MAX_SHARES) throw new RangeError("threshold");
  if (!Number.isInteger(s.index) || s.index < 0 || s.index >= MAX_SHARES) throw new RangeError("member index");
  if (s.value.length !== SHARED_SECRET_BYTES) throw new RangeError("a share value is 16 bytes");
  const head = new Uint8Array(HEADER_BYTES + SHARED_SECRET_BYTES);
  head[0] = (SHARE_VERSION << 4) | KIND_RECOVERY;
  head[1] = s.setId >> 8;
  head[2] = s.setId & 0xff;
  head[3] = ((s.threshold - 1) << 4) | s.index;
  head.set(s.value, HEADER_BYTES);
  let n = (toBigInt(head) << CHECK_BITS) | BigInt(checkOf(head));
  head.fill(0);
  let out = "";
  for (let i = 0; i < SHARE_SYMBOLS; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out.match(/.{4}/g)!.join("-");
}

function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * A share from what was typed: share_length or share_char (not 36 symbols of the alphabet once read the Crockford way:
 * a recovery code or a pairing code typed here is share_length), share_checksum (a typo the check bits caught), or
 * share_newer (the check holds, but the version or kind is not v1's recovery share). The error carries no input.
 */
export async function parseShare(input: string): Promise<Share> {
  const s = normalizeCrockford(input);
  if (s.length !== SHARE_SYMBOLS) throw new CryptoError("share_length");
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new CryptoError("share_char");
    n = (n << 5n) | BigInt(v);
  }
  const check = Number(n & ((1n << CHECK_BITS) - 1n));
  let t = n >> CHECK_BITS;
  const head = new Uint8Array(HEADER_BYTES + SHARED_SECRET_BYTES);
  for (let i = head.length - 1; i >= 0; i--) {
    head[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  if (checkOf(head) !== check) {
    head.fill(0); // a typo of a share is a few bits away from it: not left behind either
    throw new CryptoError("share_checksum");
  }
  if (head[0]! >> 4 !== SHARE_VERSION || (head[0]! & 0x0f) !== KIND_RECOVERY) {
    head.fill(0);
    throw new CryptoError("share_newer");
  }
  const share: Share = {
    setId: (head[1]! << 8) | head[2]!,
    threshold: (head[3]! >> 4) + 1,
    index: head[3]! & 0x0f,
    value: head.slice(HEADER_BYTES),
  };
  head.fill(0);
  return share;
}

/** The set id as the page and the printed share show it: four hexadecimal digits, "7F2A". */
export const setIdText = (setId: number): string => setId.toString(16).toUpperCase().padStart(4, "0");

// ---- sets ------------------------------------------------------------------------------------------------------

/** A new set: its id, threshold, count, and each member's text (index = member index). */
export type ShareSet = { setId: number; threshold: number; count: number; shares: string[] };

/**
 * Split a 16-byte secret into `count` shares, any `threshold` of which rebuild it: 2 <= threshold <= count <= 16 (a
 * threshold of 1 would make every share the secret itself). The set id is drawn first, then SLIP-39's split. The
 * secret is not kept; the raw values are zeroed once written out.
 */
export async function makeShareSet(
  secret: Uint8Array,
  threshold: number,
  count: number,
  rng: Random = randomBytes,
): Promise<ShareSet> {
  if (secret.length !== SHARED_SECRET_BYTES) throw new RangeError("the shared secret is the 16-byte recovery secret");
  if (!Number.isInteger(threshold) || threshold < 2) throw new RangeError("a share set needs a threshold of 2 or more");
  const id = take(rng, 2);
  const setId = (id[0]! << 8) | id[1]!;
  const raw = await splitSecret(threshold, count, secret, rng);
  const shares: string[] = [];
  for (const r of raw) {
    shares.push(await formatShare({ setId, threshold, index: r.x, value: r.data }));
    r.data.fill(0);
  }
  return { setId, threshold, count, shares };
}

/**
 * The secret from exactly one set's threshold of shares, refused before any arithmetic otherwise: shares_mixed (shares
 * of different sets: another set id or threshold), shares_duplicate (the same member twice), shares_count (not exactly
 * the threshold, or a threshold below 2); then shares_digest if they do not fit together. The caller zeroes the result.
 */
export async function combineShares(shares: readonly Share[]): Promise<Uint8Array> {
  if (shares.length === 0) throw new CryptoError("shares_count");
  const { setId, threshold } = shares[0]!;
  if (shares.some((s) => s.setId !== setId || s.threshold !== threshold)) throw new CryptoError("shares_mixed");
  if (new Set(shares.map((s) => s.index)).size !== shares.length) throw new CryptoError("shares_duplicate");
  if (threshold < 2 || shares.length !== threshold) throw new CryptoError("shares_count");
  return recoverSecret(
    threshold,
    shares.map((s) => ({ x: s.index, data: s.value })),
  );
}

/**
 * The recovery code's text rebuilt from typed shares (parseShare, combineShares, then `toCode`: recovery-code.ts
 * formatRecoveryCode, passed by the caller); R and the parsed values are zeroed, whatever happens.
 */
export async function recoveryCodeFromShares(
  texts: readonly string[],
  toCode: (secret: Uint8Array) => Promise<string>,
): Promise<string> {
  const parsed: Share[] = [];
  let secret: Uint8Array | null = null;
  try {
    for (const t of texts) parsed.push(await parseShare(t));
    secret = await combineShares(parsed);
    return await toCode(secret);
  } finally {
    for (const p of parsed) p.value.fill(0);
    secret?.fill(0);
  }
}
