// What a plugin may put on Sixkey's screens, and how Sixkey draws it (from the removed plugin SDK's specification):
// plain text, protected terms, the shortcut grammar of `keys`, and the PNG icon's limits. Every rule here is applied by
// Sixkey to text a plugin supplied; Sixkey's own words never pass through it. No text, no browser calls.

/**
 * §2.3's plain text, the characters it refuses: C0 and C1 controls; bidirectional controls and marks (U+061C, U+200E,
 * U+200F, U+202A–U+202E, U+2066–U+2069); the default-ignorable characters (the soft hyphen, U+034F, U+115F, U+1160,
 * U+17B4, U+17B5, U+180B–U+180F, U+200B–U+200D, U+2060–U+206F, U+3164, the variation selectors U+FE00–U+FE0F, U+FEFF,
 * U+FFA0) and the astral ones a portable schema pattern cannot name (U+1BCA0–U+1BCA3, U+1D173–U+1D17A, the tags
 * U+E0000–U+E007F, the variation selectors U+E0100–U+E01EF); and a lone surrogate, half of a UTF-16 pair without the
 * other (in a `u` pattern, \ud800-\udfff matches only an unpaired half), which no JSON canonical form can hold (W1c r2,
 * F-1: it reached JCS through a real message and threw there).
 */
const NOT_PLAIN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ud800-\udfff\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
const NOT_PLAIN_ALL = new RegExp(NOT_PLAIN.source, "gu");

/**
 * Whether every string in `x` (its object keys too) is well-formed UTF-16: no lone surrogate anywhere (§2.3 item 1,
 * I-JSON). Chrome carries one through a message as it is (W1c review E8); JCS, which the grant store's tag and the
 * descriptor's comparisons use, refuses one. Walked with a stack of its own: a message's depth is the sender's choice.
 */
export function wellFormed(x: unknown): boolean {
  const LONE = /[\ud800-\udfff]/u;
  const stack: unknown[] = [x];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (LONE.test(v)) return false;
    } else if (typeof v === "object" && v !== null)
      for (const [k, w] of Object.entries(v)) {
        if (LONE.test(k)) return false;
        stack.push(w);
      }
  }
  return true;
}

/**
 * `s` with each lone surrogate replaced by U+FFFD, the replacement character (String.prototype.toWellFormed, which the
 * TypeScript library this build targets does not name): for Sixkey's own messages to a plugin, which must be well-formed
 * too (§2.3 item 1), when they carry text from the vault (P1's account names, wave 2a).
 */
export const toWellFormed = (s: string): string =>
  s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");

/** The length JSON Schema's minLength and maxLength count: code points. */
export const lengthOf = (s: string): number => Array.from(s).length;

/** Whether `s` is §2.3's plain text, `min` to `max` characters long. */
export function isPlainText(s: unknown, min: number, max: number): s is string {
  if (typeof s !== "string" || NOT_PLAIN.test(s)) return false;
  const n = lengthOf(s);
  return n >= min && n <= max;
}

/**
 * Text a plugin gave, as Sixkey draws it (§7.3 item 1): NFKC, then without the characters plain text refuses (NFKC can
 * bring some back, and a stored descriptor is read again whatever wrote it), spaces collapsed, and cut to `max`
 * characters. Drawn as text, never as markup: callers put it in a text node.
 */
export function displayText(s: string, max: number): string {
  const t = s.normalize("NFKC").replace(NOT_PLAIN_ALL, "").replace(/\s+/gu, " ").trim();
  return Array.from(t).slice(0, max).join("");
}

// ---- protected terms (§7.3 item 2) ---------------------------------------------------------------------------------

/**
 * Lookalikes of the Latin letters, from Unicode TR39's confusables data (confusables.txt, "MA" mappings), cut down to
 * what can stand for a letter of a protected term once NFKC has folded the compatibility forms (full-width letters,
 * mathematical alphanumerics, circled and superscript letters, ligatures): the Cyrillic, Greek, Armenian and Cherokee
 * letters, the Latin small capitals and IPA letters, and the digits 0 and 1. The SDK states this subset (§7.3 item 2);
 * what it misses is the residual "visual similarity that the skeleton misses" (§13). Each string: the target letter,
 * then the characters that map to it. Applied after lower-casing, so the lower-case forms are what count; a few
 * upper-case-only shapes follow their lower-case letter.
 */
const LOOKALIKES = [
  "aаɑαⲁꭺᴀ⍺",
  "bЬьƅᏏᖯʙ",
  "cсϲᴄⲥꮯⅽ",
  "dԁꓒᑯ",
  "eеҽℯ℮ꬲᴇεє",
  "gɡցᶃ",
  "hһհᏂɦ",
  "iіıɩιӏǀ׀ꙇⅰᎥ1|",
  "jјϳ",
  "kкκᴋⲕ",
  "lⅼℓ",
  "mмᴍ",
  "nոռɴпη",
  "oоοօσᴏⲟ০୦௦౦೦൦๐໐၀ჿ0",
  "pрρϱⲣᴘ",
  "qԛզ",
  "rгᴦʀꭇ",
  "sѕꜱꮪƽ",
  "tтτᴛ",
  "uυսᴜʋꭎ",
  "vνѵᴠⅴ",
  "wѡԝᴡɯ",
  "xхχҳⅹ",
  "yуүγʏ",
  "zᴢʐ",
];
const SKELETON = new Map<string, string>();
for (const row of LOOKALIKES) {
  const [target, ...others] = Array.from(row);
  for (const c of others) SKELETON.set(c, target!);
}

/**
 * The comparison form of a text: NFKC, without the characters plain text refuses (as displayText draws it: the Hangul
 * fillers are letters that show nothing, so "Six\u3164key" is drawn "Sixkey", W1a review r2 N1), lower case, marks
 * taken off (NFD), each lookalike replaced by its Latin letter, and then "i" and "l" (and 1, I, |, which TR39 maps to
 * "l") read as one letter, as they are hard to tell apart.
 */
function fold(s: string): string {
  return Array.from(
    s.normalize("NFKC").replace(NOT_PLAIN_ALL, "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""),
  )
    .map((c) => SKELETON.get(c) ?? c)
    .join("")
    .replace(/i/g, "l");
}
/** The words of a text's comparison form: the runs of letters and digits. */
const wordsOf = (s: string): string[] =>
  fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// One string, not a list of literals: a quoted word that is also a message key would be counted as the popup's text
// (scripts/catalog-keys.mjs rule 2). Each term in its comparison form, its words run together.
const PROTECTED = new Set(
  "sixkey|unlock|pin|passcode|master password|recovery code|recovery key".split("|").map((t) => wordsOf(t).join("")),
);
const LONGEST = Math.max(...[...PROTECTED].map((t) => t.length));
/**
 * For CJK text, which has no spaces between words: these anywhere in a stretch of the comparison form between two
 * separators (punctuation that ends a word, such as · / 、 ： or a bracket, and symbols), with its spaces, dashes and
 * underscores taken out (and their traditional forms; "pln" is PIN folded). So "解 锁" and "P1N 码" are refused, and
 * "了解 · 锁定" is not (r2 N7); "解·锁" is not either, its separator in plain sight.
 */
const PROTECTED_CJK = /主密[码碼]|解[锁鎖]|恢[复復]密[钥鑰]|恢[复復][码碼]|pln[码碼]/u;
const CJK_STRETCHES = /[\p{Po}\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{S}]+/u;

/**
 * Whether a plugin's title or name uses a protected term (§7.3 item 2): some run of consecutive words of its comparison
 * form, run together, is `sixkey`, `unlock`, `pin`, `passcode`, `master password`, `recovery code` or `recovery key`
 * (so however it is spaced or punctuated: "Six Key", "Six-Key", "S1x Key", "P I N"), or, for CJK, it contains 主密码,
 * 解锁, 恢复密钥, 恢复码 or PIN码 ("P1N 码" too). So "Pinterest", "Spinner" and "Unlocking tips" pass, and "Ѕіхkеу",
 * "P1N" and "Unlock vault" do not. A refused title is not drawn; a refused name is shown as the plugin's ID.
 */
export function usesProtectedTerm(s: string): boolean {
  for (const part of fold(s).split(CJK_STRETCHES))
    if (PROTECTED_CJK.test(part.replace(/[\s\p{Pd}\p{Pc}]+/gu, ""))) return true;
  const words = wordsOf(s);
  for (let i = 0; i < words.length; i++) {
    let run = "";
    for (let j = i; j < words.length && run.length < LONGEST; j++) {
      run += words[j];
      if (PROTECTED.has(run)) return true;
    }
  }
  return false;
}

// ---- keys: the plugin's own shortcuts (§5.1) -----------------------------------------------------------------------

/** `#/$defs/shortcut`: Chrome's suggested_key grammar, the media keys, or the macOS symbol form; at most 40 characters. */
const SHORTCUT =
  /^((((Ctrl|Alt|Shift|MacCtrl|Command|Search)\+){1,3}([A-Z0-9]|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right|F[1-9]|F1[0-2]))|MediaNextTrack|MediaPlayPause|MediaPrevTrack|MediaStop|([⌃⌥⇧⌘]{1,4}([A-Z0-9]|[,.]|Space|Home|End|PageUp|PageDown|Insert|Delete|Up|Down|Left|Right|F[1-9]|F1[0-2])))$/u;

/** Whether a `keys` value is a shortcut Sixkey may draw (as a key cap of its own, never inside a sentence). */
export const isShortcut = (s: unknown): s is string => typeof s === "string" && lengthOf(s) <= 40 && SHORTCUT.test(s);

// ---- icons (§7.2, §7.3 item 3) -------------------------------------------------------------------------------------

/** `#/$defs/icon`'s png: a base64 data URL, at most 11,000 characters. */
export const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Whether a PNG data URL may be drawn (§7.2): at most 8 KiB once decoded, a PNG whose first chunk is IHDR, at most
 * 64 × 64 pixels, 8 bits per channel (bit depth 8), not interlaced. Anything else is not drawn.
 */
export function pngDrawable(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 11_000 || !PNG_URL.test(url)) return false;
  let bin: string;
  try {
    bin = atob(url.slice(url.indexOf(",") + 1));
  } catch {
    return false;
  }
  if (bin.length > 8192 || bin.length < 33) return false;
  const b = (i: number) => bin.charCodeAt(i);
  if (PNG_SIGNATURE.some((v, i) => b(i) !== v)) return false;
  const u32 = (i: number) => ((b(i) << 24) | (b(i + 1) << 16) | (b(i + 2) << 8) | b(i + 3)) >>> 0;
  if (u32(8) !== 13 || bin.slice(12, 16) !== "IHDR") return false;
  const w = u32(16);
  const h = u32(20);
  const depth = b(24);
  const colour = b(25);
  const interlace = b(28);
  return w >= 1 && h >= 1 && w <= 64 && h <= 64 && depth === 8 && [0, 2, 3, 4, 6].includes(colour) && interlace === 0;
}
