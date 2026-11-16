// Password strength for the master password and the backup password. Loaded only on the options page.
// zxcvbn-ts is a pattern and dictionary aware estimator, not crypto, so it does not break the "WebCrypto only" rule.
//
// The two generators below draw from crypto.getRandomValues, so their strength is not estimated but known: every output
// is one of exactly N^k equally likely strings. measure() reports that known value for the exact strings they produced in
// this page (and zxcvbn's estimate for anything else, an edited one included), because zxcvbn misjudges both kinds: about
// 63 bits for the 79.3-bit characters, and for the 64.6-bit words anywhere from about 50 to over 90
// (docs/design/notes/PASSWORD-SETUP-NOTES.md §2). The bar is the same either way: the floor and MIN_BITS.
//
// The master password is the user's own since OWNER-DECISIONS/15 (2026-10-22; docs/design/notes/OWN-PASSWORD-NOTES.md):
// for it, MIN_BITS is a warning the user can pass ("Use anyway", masterAccepts), never the floor, which still holds.
// Backup files and the sync key operations keep MIN_BITS as their bar (`ok`).
import { PBKDF2_PASSWORD_WRAP_ITERATIONS } from "../core/crypto/kdf";
import { checkPasswordPolicy, MIN_PASSWORD_LENGTH } from "../core/crypto/password-policy";

export const MIN_BITS = 50; // PLAN §5.1; for the master password a warning since OWNER-DECISIONS/15

let ready: Promise<(pw: string) => number> | null = null;

function load(): Promise<(pw: string) => number> {
  ready ??= (async () => {
    const [core, common, en] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-en"),
    ]);
    const zx = new core.ZxcvbnFactory({
      translations: en.translations,
      graphs: common.adjacencyGraphs,
      dictionary: { ...common.dictionary, ...en.dictionary },
    });
    return (pw: string) => Math.log2(Math.max(1, zx.check(pw).guesses));
  })();
  return ready;
}

/** `generated`: the bits are the generator's known entropy, not zxcvbn's estimate. */
export type Strength = { bits: number; ok: boolean; floorOk: boolean; generated: boolean };

/**
 * The master password's hard minimum of guesses (OWNER-DECISIONS/15 item 1, what "not a common password" means): fewer
 * than 10⁶ zxcvbn guesses (about 20 bits; `Password1234` is about 14, a few seconds on one graphics card at 2M) is
 * refused outright, "Use anyway" or not. The page enforces it; the service cannot (it runs in the service worker too,
 * which cannot load zxcvbn's chunks), so its floor stays checkPasswordPolicy alone.
 */
export const MIN_GUESS_BITS = Math.log2(1e6);

/**
 * Whether a page may set this master password (OWNER-DECISIONS/15). The service's floor always holds (12 characters, not
 * repetitive or a sequence, not on its short list: checkPasswordPolicy, which the service checks again), and so does
 * MIN_GUESS_BITS. Below MIN_BITS only with `anyway`: the user pressed "Use anyway" under the warning for this very value
 * (the pages pass `anyway === pw`). The only acceptance rule for a master password; backup files and the sync key
 * operations use `ok`.
 */
export function masterAccepts(s: Strength | null, anyway: boolean): boolean {
  return s !== null && s.floorOk && s.bits >= MIN_GUESS_BITS && (s.ok || anyway);
}

/**
 * One RTX 5090 runs about 1.1 × 10¹⁰ PBKDF2-HMAC-SHA256 iterations a second (hashcat mode 10900, 11,157.2 kH/s at 999
 * iterations: docs/design/proposals/RECOVERY-SECRET-AND-CHROME-SYNC-STUDY.md §1.2). The warning's figure, for one card.
 */
export const GPU_ITERATIONS_PER_SECOND = 1.1e10;

/**
 * How long one such card takes to try 2^bits guesses at a wrap of `iterations` (by default the count a new master-password
 * wrap gets). zxcvbn's bits are log2 of its guess count, the guesses a smart attacker needs, so this is not halved.
 */
export function offlineSeconds(bits: number, iterations = PBKDF2_PASSWORD_WRAP_ITERATIONS): number {
  return (2 ** bits * iterations) / GPU_ITERATIONS_PER_SECOND;
}

export type RoughTime = { unit: "second" | "minute" | "hour" | "day" | "month" | "year"; count: number };
const UNIT_S: [RoughTime["unit"], number, number][] = [
  // the unit, its seconds, and the largest count shown in it before the next unit takes over
  ["second", 1, 90],
  ["minute", 60, 90],
  ["hour", 3_600, 48],
  ["day", 86_400, 60],
  ["month", 2_629_800, 24],
  ["year", 31_557_600, Infinity],
];
/** A duration as people say it: whole units, at least 1, the larger ones to two significant figures. Pure. */
export function roughTime(seconds: number): RoughTime {
  for (const [unit, size, max] of UNIT_S) {
    const n = seconds / size;
    if (n < max + 0.5) {
      const whole = Math.max(1, Math.round(n));
      const digits = Math.floor(Math.log10(whole)) + 1;
      const step = digits > 2 ? 10 ** (digits - 2) : 1;
      return { unit, count: Math.round(whole / step) * step };
    }
  }
  return { unit: "year", count: Infinity }; // not reached: the last unit takes everything
}

// The strings this page's generators produced, with the entropy each was drawn with. Only the generators below write
// here, so no caller can claim a bit count for a password; measure() reads it for an exact match only. It holds a password
// only while a field shows it: PasswordFields forgets one when it is replaced, edited, emptied, unmounted, on a lock and
// when the page goes away (forgetGenerated). MADE_MAX is a backstop above the most fields a page shows at once (4).
const made = new Map<string, number>();
const MADE_MAX = 4;
function remember(pw: string, bits: number): void {
  made.delete(pw);
  made.set(pw, bits);
  while (made.size > MADE_MAX) made.delete(made.keys().next().value!);
}

/**
 * Forget one generated password, or (no argument) all of them: they are estimated like any other string from then on.
 * Forgetting can only lower what measure() says, never raise it.
 */
export function forgetGenerated(value?: string): void {
  if (value === undefined) made.clear();
  else made.delete(value);
}

/**
 * How many draws a generator makes before it gives up. A working source needs more than one only about once in a
 * million draws (uniformIndex) or once in 5e9 outputs (the floor); a broken one (all zeros, a constant) fails here,
 * visibly, instead of hanging the page.
 */
export const MAX_DRAWS = 1000;

export async function measure(password: string): Promise<Strength> {
  if (!password) return { bits: 0, ok: false, floorOk: false, generated: false };
  const floorOk = checkPasswordPolicy(password).ok;
  const known = made.get(password); // the exact string only: an edited one is estimated like any other
  const bits = known ?? (await load())(password.normalize("NFKC").slice(0, 128));
  return { bits, floorOk, ok: floorOk && bits >= MIN_BITS, generated: known !== undefined };
}

/**
 * A uniformly random integer in [0, n), from crypto.getRandomValues. Rejection sampling: a 32-bit draw at or above the
 * largest multiple of n is thrown away and drawn again, so every result is exactly as likely (`b % n` alone would favour
 * the small ones). For the sizes used here a draw is rejected less than once in a million.
 */
export function uniformIndex(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError(`uniformIndex: bad range ${n}`);
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  for (let i = 0; i < MAX_DRAWS; i++) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
  throw new Error("uniformIndex: the random source keeps answering out of range");
}

export type Generated = { value: string; bits: number; kind: "chars" | "words"; count: number };

/** 31 letters and digits, without the look-alikes I, L, O, 0 and 1. */
export const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CHAR_COUNT = 16;
/** 16 × log2(31) ≈ 79.3 bits. */
export const CHAR_BITS = CHAR_COUNT * Math.log2(CHARS.length);

/**
 * 16 uniformly random symbols from CHARS (79.3 bits), in groups of four so it is easy to copy and type. An output the
 * service's floor would refuse (fewer than six different symbols) is drawn again; such outputs are a vanishing share of
 * all 31^16, so the entropy stays 79.3 bits to many decimal places.
 */
export function suggestPassword(): Generated {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const s = Array.from({ length: CHAR_COUNT }, () => CHARS[uniformIndex(CHARS.length)]).join("");
    const value = s.match(/.{4}/g)!.join("-");
    if (!checkPasswordPolicy(value).ok) continue;
    remember(value, CHAR_BITS);
    return { value, bits: CHAR_BITS, kind: "chars", count: CHAR_COUNT };
  }
  throw new Error("suggestPassword: every draw failed the floor (a broken random source)");
}

export const WORD_COUNT = 5;
let wordList: Promise<readonly string[]> | null = null;

/**
 * The word list: the EFF large wordlist as packaged by zxcvbn-ts (7,776 words, lower case a-z: its four hyphenated words
 * joined), which the options page already ships inside @zxcvbn-ts/language-common as its "diceware-common" dictionary
 * (OWNER-DECISIONS/05: kept, with its notice, scripts/notices-data.mjs). The same
 * lazy chunk measure() loads, so no new bytes. Checked before use: the entropy claim needs distinct words, and the "-"
 * separator needs words without one.
 */
function words(): Promise<readonly string[]> {
  wordList ??= import("@zxcvbn-ts/language-common")
    .then((m) => {
      const list = m.dictionary["diceware-common"];
      if (!Array.isArray(list) || list.length < 2 || new Set(list).size !== list.length)
        throw new Error("passphrase word list: missing or has repeats");
      if (!list.every((w) => /^[a-z]+$/.test(w))) throw new Error("passphrase word list: unexpected characters");
      return list;
    })
    .catch((e: unknown) => {
      wordList = null; // a chunk that failed to load may load on the next click
      throw e;
    });
  return wordList;
}

/**
 * WORD_COUNT uniformly random words from the list, joined by "-": WORD_COUNT × log2(list size) bits (5 × log2 7776 ≈
 * 64.6). Refuses to make one below MIN_BITS. An output the service's floor would refuse is drawn again, as above.
 */
export async function suggestPassphrase(): Promise<Generated> {
  const list = await words();
  const bits = WORD_COUNT * Math.log2(list.length);
  if (bits < MIN_BITS) throw new Error("passphrase: the word list is too small for the minimum strength");
  for (let i = 0; i < MAX_DRAWS; i++) {
    const value = Array.from({ length: WORD_COUNT }, () => list[uniformIndex(list.length)]).join("-");
    if (!checkPasswordPolicy(value).ok) continue;
    remember(value, bits);
    return { value, bits, kind: "words", count: WORD_COUNT };
  }
  throw new Error("suggestPassphrase: every draw failed the floor (a broken random source)");
}

/** What the strength line under a new password shows: lit bars (0-10), tone, and which message. Pure, for the tests. */
export type MeterView = {
  on: number;
  tone: "" | "good" | "fair" | "weak";
  msg:
    | { key: "strengthHint"; subs: [number] }
    | { key: "strengthHintOwn"; subs: [number, number] }
    | { key: "strengthOk"; subs: [] }
    | { key: "strengthGenerated"; subs: [number] }
    | { key: "strengthLow"; subs: [number, number, number] }
    | { key: "strengthLowOwn"; subs: [number, number] }
    | { key: "strengthShort"; subs: [number] }
    | { key: "strengthCommon"; subs: [] }
    | { key: "strengthFloor"; subs: [] };
  /** Offer "Use a generated password instead" next to the message. */
  offer: boolean;
  /**
   * The master password only: past the floor and MIN_GUESS_BITS and below MIN_BITS, so the warning and its "Use anyway"
   * are shown.
   */
  warn: boolean;
};

/**
 * `own`: the master password (OWNER-DECISIONS/15), where MIN_BITS is a warning: below it but past the floor and
 * MIN_GUESS_BITS the line says so and `warn` is set; refused, the line says why (too short, too predictable, or too
 * easy to guess). Otherwise (backup files, the sync key operations) MIN_BITS is the bar, as before, and `warn` is never
 * set.
 */
export function meterView(value: string, s: Strength | null, own = false): MeterView {
  if (!value || !s)
    return {
      on: 0,
      tone: "",
      msg: own
        ? { key: "strengthHintOwn", subs: [MIN_PASSWORD_LENGTH, MIN_BITS] }
        : { key: "strengthHint", subs: [MIN_BITS] },
      offer: false,
      warn: false,
    };
  // Every bar lit exactly when the password reaches the bar; short of that, never all ten (with "Use anyway" too).
  if (s.ok)
    return {
      on: 10,
      tone: "good",
      msg: s.generated ? { key: "strengthGenerated", subs: [Math.floor(s.bits)] } : { key: "strengthOk", subs: [] },
      offer: false,
      warn: false,
    };
  const pct = Math.min(100, (s.bits / MIN_BITS) * 100);
  const on = Math.min(9, Math.floor(pct / 10));
  const tone = pct >= 60 ? "fair" : "weak";
  const have = Math.floor(s.bits);
  if (own) {
    if (s.floorOk && s.bits >= MIN_GUESS_BITS)
      return { on, tone, msg: { key: "strengthLowOwn", subs: [have, MIN_BITS] }, offer: true, warn: true };
    if (s.floorOk) return { on, tone, msg: { key: "strengthCommon", subs: [] }, offer: true, warn: false };
    const short = checkPasswordPolicy(value).reasons.includes("too_short");
    const msg: MeterView["msg"] = short
      ? { key: "strengthShort", subs: [MIN_PASSWORD_LENGTH] }
      : { key: "strengthFloor", subs: [] };
    return { on, tone, msg, offer: true, warn: false };
  }
  // Enough estimated bits but refused by the floor (a keyboard run or a repeat in an otherwise long password).
  if (s.bits >= MIN_BITS) return { on, tone, msg: { key: "strengthFloor", subs: [] }, offer: true, warn: false };
  return { on, tone, msg: { key: "strengthLow", subs: [have, MIN_BITS, MIN_BITS - have] }, offer: true, warn: false };
}
