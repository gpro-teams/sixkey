// A generated password typed back loosely (docs/design/notes/PASSWORD-SETUP-NOTES.md §7): without its hyphens, in lower
// case, with spaces instead of hyphens. Stateless and bounded: what was typed is always tried first, exactly as typed,
// and only when it has one of the two shapes the generators make (src/ui/strength.ts) is the generator's own spelling of
// it tried once more. Nothing is stored for it, and nothing that sets a password uses it: a new password is stored
// exactly as it was given.
//
// Why this costs no strength: the vault opens for one stored string. An attacker still has to find that string among
// all 31^16 (or 7,776^5) the generator could have drawn; accepting a few spellings of it at a prompt multiplies the
// inputs that open the vault, not the secrets that do (each typed string maps to at most one other candidate, so one
// attempt tests at most two secrets, at the cost of two key derivations). Someone with a copy of the profile runs the key
// derivation offline and is not affected at all.
//
// Pure, with no imports: the popup's lock screen loads it. The alphabet is the generator's (src/ui/strength.ts CHARS;
// test/unit/password-entry.test.ts holds the two equal), restated rather than imported, which would bring the
// settings page's estimator into the popup.

/** The character generator's 31 symbols: A-Z without I, L and O, then 2-9. */
export const GEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** The two generated shapes, as the input hint names them (src/core/service/pw-format.ts). */
export type PasswordFormat = "gen16-v1" | "gen5words-v1";

const SYMBOLS = /^[A-HJKMNP-Z2-9]{16}$/i; // GEN_ALPHABET, either case (the test checks it is the same set)
/** Any character that is not one of GEN_ALPHABET's, in either case (the grouped input leaves these out). */
export const NOT_GEN_SYMBOL = /[^A-HJKMNP-Z2-9]/gi;
const WORD = /^[A-Za-z]{3,9}$/; // the word list's words: a-z, 3 to 9 letters (the test checks every one)

/**
 * `typed` as the 16-symbol shape reads it: NFKC, then white space and "-" taken out, nothing else changed. The one
 * reading of a code, for this check and for the grouped input (src/ui/PasswordGroups.tsx), so the two take and refuse
 * the same: anything left that is not a symbol (a lookalike dash, a zero-width character) fails both.
 */
export const compactCode = (typed: string) => typed.normalize("NFKC").replace(/[\s-]+/g, "");

/**
 * The generator's spelling of `typed` when it has a generated shape, else null. NFKC first, as the key derivation does
 * (src/core/crypto/kdf.ts), so a full-width spelling from an IME counts too.
 *   - gen5words-v1: exactly 5 words of 3 to 9 ASCII letters, separated by runs of white space, "_" or "-". The spelling
 *     is lower case joined by "-". No word list is consulted (the popup carries none): any 5 such words have the shape.
 *   - gen16-v1: once white space and "-" are taken out, exactly 16 symbols of GEN_ALPHABET in either case. The spelling
 *     is upper case in four groups of four joined by "-": AAAA-BBBB-CCCC-DDDD.
 * When both fit (5 short words without I, L or O, 16 letters in all), the words win: the 16 symbols' own spelling has
 * 4 groups, so it is never 5 words, and this way every spelling, of either kind, is its own (a test checks both kinds).
 * There is never more than one spelling.
 */
export function generatedForm(typed: string): { format: PasswordFormat; canonical: string } | null {
  const t = typed.normalize("NFKC");
  const words = t.trim().split(/[\s_-]+/);
  if (words.length === 5 && words.every((w) => WORD.test(w)))
    return { format: "gen5words-v1", canonical: words.join("-").toLowerCase() };
  const compact = compactCode(t);
  if (SYMBOLS.test(compact)) return { format: "gen16-v1", canonical: compact.toUpperCase().match(/.{4}/g)!.join("-") };
  return null;
}

/**
 * What a check of a typed password tries, in order: `typed` itself, then its generator spelling when it has one that
 * differs from it. Never more than two, so a wrong password costs at most one key derivation more, and only when it has
 * a generated shape. The caller counts the whole attempt as one.
 */
export function passwordCandidates(typed: string): [string] | [string, string] {
  const g = generatedForm(typed);
  return g !== null && g.canonical !== typed.normalize("NFKC") ? [typed, g.canonical] : [typed];
}
