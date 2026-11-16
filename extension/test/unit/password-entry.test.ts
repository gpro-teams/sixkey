// A generated password typed back loosely (docs/design/notes/PASSWORD-SETUP-NOTES.md §7, §8), the pure parts: the
// candidates (the typed string, then at most one generator spelling), the keyring's one check that uses them, a backup
// file's password, and the grouped input's editing steps (src/ui/PasswordGroups.tsx, drawn by the settings page's prompts
// and the popup's lock screen). The service, the hint and the prompts: password-entry-service.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup, openBackup } from "../../src/core/backup/backup";
import { CryptoError } from "../../src/core/crypto/bytes";
import * as kdf from "../../src/core/crypto/kdf";
import { createKeyring, openWithPassword, setPassword, unlockWithPassword } from "../../src/core/crypto/keyring";
import {
  GEN_ALPHABET,
  generatedForm,
  NOT_GEN_SYMBOL,
  passwordCandidates,
} from "../../src/core/crypto/password-candidates";
import { emptyVault } from "../../src/core/vault/model";
import { hintReader } from "../../src/options/MasterField";
import { arrowAt, backspaceAt, codeSymbols, pasteInto, typedInto, valueOf } from "../../src/ui/PasswordGroups";
import { CHARS, suggestPassword } from "../../src/ui/strength";

const GEN = "JDXT-NBSG-6JQG-XBTV";
const WORDS = "acorn-banjo-canyon-dwelling-eagle";
const src = (f: string) => readFileSync(join(__dirname, "../../src", f), "utf8");
/** The source without its comments, for rules about the code. */
const code = (f: string) =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
afterEach(() => vi.restoreAllMocks());

describe("passwordCandidates: the typed string first, then at most one generator spelling", () => {
  it("16 symbols: hyphens, spaces and case do not matter; the spelling is AAAA-BBBB-CCCC-DDDD", () => {
    for (const typed of [
      "JDXTNBSG6JQGXBTV", // no hyphens
      "jdxtnbsg6jqgxbtv", // lower case
      "jdxt-nbsg-6jqg-xbtv",
      "Jdxt-Nbsg-6jqg-Xbtv",
      "JDXT NBSG 6JQG XBTV", // spaces for hyphens
      "  JDXT  nbsg-6JQG\txbtv ", // extra white space, mixed separators
      "JDX-TNB-SG6-JQG-XBTV", // hyphens in other places
      "J D X T N B S G 6 J Q G X B T V",
      "ＪＤＸＴＮＢＳＧ６ＪＱＧＸＢＴＶ", // full width (an IME): NFKC, as the key derivation does
    ])
      expect(passwordCandidates(typed), typed).toEqual([typed, GEN]);
    expect(passwordCandidates(GEN)).toEqual([GEN]); // already the spelling: one derivation, as before
    expect(passwordCandidates("ＪＤＸＴ－ＮＢＳＧ－６ＪＱＧ－ＸＢＴＶ")).toHaveLength(1); // NFKC of it is the spelling
  });

  it("5 words: spaces, underscores and capitals do not matter; the spelling is lower case joined by '-'", () => {
    for (const typed of [
      "acorn banjo canyon dwelling eagle",
      "Acorn Banjo Canyon Dwelling Eagle",
      "ACORN-BANJO-CANYON-DWELLING-EAGLE",
      "acorn_banjo_canyon_dwelling_eagle",
      "  acorn   banjo canyon\tdwelling eagle ",
      "acorn-banjo canyon_dwelling Eagle",
    ])
      expect(passwordCandidates(typed), typed).toEqual([typed, WORDS]);
    expect(passwordCandidates(WORDS)).toEqual([WORDS]);
    // 5 short words without I, L or O, 16 letters in all, fit both shapes: a passphrase is its own spelling, and a code
    // of 16 symbols (4 groups) never reads as 5 words
    expect(generatedForm("abc-def-ghj-kmn-pqrs")).toEqual({
      format: "gen5words-v1",
      canonical: "abc-def-ghj-kmn-pqrs",
    });
    expect(passwordCandidates("ABC DEF GHJ KMN PQRS")).toEqual(["ABC DEF GHJ KMN PQRS", "abc-def-ghj-kmn-pqrs"]);
    expect(generatedForm("ABCD-EFGH-JKMN-PQRS")).toEqual({ format: "gen16-v1", canonical: "ABCD-EFGH-JKMN-PQRS" });
  });

  it("anything else is tried exactly as typed, and only that", () => {
    for (const typed of [
      "JDXT-NBSG-6JQG-XBT", // 15 symbols
      "JDXT-NBSG-6JQG-XBTVA", // 17
      "JDXT-NBSG-6JQG-XBT1", // 1 is not in the alphabet
      "JDXT-NBSG-6JQG-XBTO", // nor O
      "JDXT-NBSG-6JQG-XBTI", // nor I
      "JDXT-NBSG-6JQG-XBTL", // nor L
      "JDXT-NBSG-6JQG-XBT0", // nor 0
      "JDXT.NBSG.6JQG.XBTV", // another separator
      "JDXT_NBSG_6JQG_XBTV", // underscores are the words' separator only, and these are 4 "words"
      "JDXT-NBSG-6JQG-XBT!",
      "acorn banjo canyon dwelling", // 4 words
      "acorn banjo canyon dwelling eagle fig", // 6
      "acorn banjo canyon dwelling eagle1",
      "acorn banjo canyon dwelling ea", // a word shorter than the list's
      "acorn banjo canyon dwelling eaglesnest", // longer than the list's
      "café banjo canyon dwelling eagle", // not a-z
      "acorn.banjo.canyon.dwelling.eagle",
      "Q7m#Xv9!pL2@rT5$kB8w",
      "correct horse battery staple",
      "tulip-orbit-lantern-84",
      "Tulip-Orbit-Lantern-84",
      "",
      " ",
    ])
      expect(passwordCandidates(typed), JSON.stringify(typed)).toEqual([typed]);
  });

  it("a user's own password that merely has the shape gets the one variant after itself, never instead of it", () => {
    // 16 lower-case letters, none of them I, L or O: the generator's shape, so its spelling is tried second
    expect(passwordCandidates("supersecretpassw")).toEqual(["supersecretpassw", "SUPE-RSEC-RETP-ASSW"]);
    expect(passwordCandidates("my dog has big ears")).toEqual(["my dog has big ears"]); // "my": 2 letters
    expect(passwordCandidates("Purple Monkey Dish Washer Fan")).toEqual([
      "Purple Monkey Dish Washer Fan",
      "purple-monkey-dish-washer-fan",
    ]);
  });

  it("for any string: the typed one first and unchanged, at most one more, which is a fixed point", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.stringMatching(/^[ a-zA-Z0-9_\t-]{0,40}$/),
          fc
            .array(fc.constantFrom(..."ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdkmn -_ IL0O1".split("")), { maxLength: 24 })
            .map((a) => a.join("")),
        ),
        (typed) => {
          const c = passwordCandidates(typed);
          expect(c.length).toBeLessThanOrEqual(2);
          expect(c[0]).toBe(typed);
          if (c.length === 2) {
            const g = generatedForm(c[1]!);
            expect(g?.canonical).toBe(c[1]);
            expect(c[1]).not.toBe(typed.normalize("NFKC"));
            expect(passwordCandidates(c[1]!)).toEqual([c[1]]);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("the alphabet is the generator's, and the patterns accept exactly it, in either case, and nothing else", () => {
    expect(GEN_ALPHABET).toBe(CHARS);
    const ok = new Set([...GEN_ALPHABET, ...GEN_ALPHABET.toLowerCase()]);
    for (let u = 0; u <= 0xffff; u++) {
      const c = String.fromCharCode(u);
      expect(c.replace(NOT_GEN_SYMBOL, "") === c, `U+${u.toString(16)}`).toBe(ok.has(c));
      if (ok.has(c) !== (generatedForm(c.repeat(16))?.format === "gen16-v1") && c.normalize("NFKC") === c)
        throw new Error(`gen16 shape and alphabet disagree at U+${u.toString(16)}`);
    }
    // every generated password has the shape and is its own spelling
    for (let i = 0; i < 200; i++) {
      const v = suggestPassword().value;
      expect(generatedForm(v)).toEqual({ format: "gen16-v1", canonical: v });
    }
  });

  it("every word of the list the passphrases come from has the word shape (a-z, 3 to 9 letters)", async () => {
    const list = (await import("@zxcvbn-ts/language-common")).dictionary["diceware-common"] as string[];
    expect(list).toHaveLength(7776);
    for (let i = 0; i + 5 <= list.length; i += 5) {
      const five = list.slice(i, i + 5);
      expect(generatedForm(five.join("-"))).toEqual({ format: "gen5words-v1", canonical: five.join("-") });
      expect(passwordCandidates(five.join(" "))).toEqual([five.join(" "), five.join("-")]);
    }
  });

  it("the module is pure (the popup loads it) and is told nothing but the typed string", () => {
    const s = code("core/crypto/password-candidates.ts");
    expect(s).not.toMatch(/^import /m);
    expect(s).toMatch(/export function passwordCandidates\(typed: string\)/); // no hint, no keyring, no state
    expect(s).not.toMatch(/pw-format|PW_FORMAT|sk_pw_format|localStorage|chrome\./);
  });
});

describe("openWithPassword: the keyring's check of a typed master password", () => {
  const derivations = () => vi.spyOn(kdf, "deriveKekFromPassword");
  async function keyringFor(pw: string) {
    const { keyring, vk } = await createKeyring();
    return { keyring: await setPassword(keyring, vk, pw), vk };
  }

  it("as typed first; the generator spelling once, only for a generated shape; the spelling that opened is returned", async () => {
    const { keyring, vk } = await keyringFor(GEN);
    const spy = derivations();
    expect(await openWithPassword(keyring, GEN)).toMatchObject({ password: GEN, vk: { id: vk.id } });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    expect(await openWithPassword(keyring, "jdxt nbsg 6jqg xbtv")).toMatchObject({ password: GEN, vk: { id: vk.id } });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["jdxt nbsg 6jqg xbtv", GEN]);
    spy.mockClear();
    // wrong: of the shape, two derivations and one failure; already the spelling, one; another shape, one
    for (const [typed, n] of [
      ["jdxtnbsg6jqgxbtw", 2],
      ["JDXT-NBSG-6JQG-XBTW", 1],
      ["not the password", 1],
    ] as const) {
      await expect(openWithPassword(keyring, typed)).rejects.toMatchObject({ code: "unwrap_failed" });
      expect(spy, typed).toHaveBeenCalledTimes(n);
      spy.mockClear();
    }
    // nothing typed is a typo: no second try
    await expect(openWithPassword(keyring, "")).rejects.toMatchObject({ code: "empty_password" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a user-chosen password opens only as itself: neither a loose spelling of it nor its 'spelling' does", async () => {
    const own = await keyringFor("supersecretpassw");
    const spy = derivations();
    expect((await openWithPassword(own.keyring, "supersecretpassw")).password).toBe("supersecretpassw");
    expect(spy).toHaveBeenCalledTimes(1); // as typed first: the user's own spelling costs nothing more
    spy.mockRestore();
    await expect(openWithPassword(own.keyring, "SUPE-RSEC-RETP-ASSW")).rejects.toBeInstanceOf(CryptoError);
    await expect(openWithPassword(own.keyring, "Supersecretpassw")).rejects.toBeInstanceOf(CryptoError);
    const tulip = await keyringFor("tulip-orbit-lantern-84");
    await expect(openWithPassword(tulip.keyring, "Tulip Orbit Lantern 84")).rejects.toBeInstanceOf(CryptoError);
    // a stored spelling that is itself loose (a user typed it so) is not "corrected" away
    const loose = await keyringFor("jdxtnbsg6jqgxbtv");
    expect((await openWithPassword(loose.keyring, "jdxtnbsg6jqgxbtv")).password).toBe("jdxtnbsg6jqgxbtv");
    await expect(openWithPassword(loose.keyring, GEN)).rejects.toBeInstanceOf(CryptoError);
  });

  it("the words: spaces and capitals open the hyphenated passphrase", async () => {
    const { keyring } = await keyringFor(WORDS);
    expect((await openWithPassword(keyring, "Acorn Banjo Canyon Dwelling Eagle")).password).toBe(WORDS);
    await expect(unlockWithPassword(keyring, "Acorn Banjo Canyon Dwelling Eagle")).rejects.toBeInstanceOf(CryptoError);
  });

  it("only a wrong key moves on to the second spelling: a keyring without a password wrap throws at once", async () => {
    const { keyring } = await createKeyring();
    const spy = derivations();
    await expect(openWithPassword(keyring, "jdxtnbsg6jqgxbtv")).rejects.toMatchObject({ code: "no_such_method" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("a backup file's password", () => {
  it("opens without its hyphens, in lower case or with spaces; at most one derivation more; the file is unchanged", async () => {
    const v = emptyVault("vault-id-0123456789");
    const file = await createBackup(v, GEN);
    const before = JSON.stringify(file);
    const spy = vi.spyOn(kdf, "deriveKekFromPassword");
    for (const typed of ["jdxtnbsg6jqgxbtv", "JDXT NBSG 6JQG XBTV", GEN])
      expect((await openBackup(file, typed)).vault.vaultId, typed).toBe(v.vaultId);
    expect(spy).toHaveBeenCalledTimes(2 + 2 + 1);
    spy.mockClear();
    await expect(openBackup(file, "jdxtnbsg6jqgxbtw")).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    await expect(openBackup(file, "something else")).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(openBackup(file, "")).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
    expect(JSON.stringify(file)).toBe(before);
    expect(Object.keys(file).sort()).toEqual(["app", "ciphertext", "created", "format", "iv", "kdf", "v"]); // no hint
    const words = await createBackup(v, WORDS);
    expect((await openBackup(words, "acorn banjo canyon dwelling eagle")).vault.vaultId).toBe(v.vaultId);
    // a damaged file is still the one answer, whatever was typed
    const bad = { ...file, ciphertext: file.ciphertext.replace(/^./, (c) => (c === "A" ? "B" : "A")) };
    await expect(openBackup(bad, "jdxtnbsg6jqgxbtv")).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
  });
});

describe("the grouped input's editing steps (src/ui/PasswordGroups.tsx)", () => {
  /** Type `keys` one at a time into whatever box the caret is in, as a person would (a refused key: nothing). */
  function typeAll(keys: string, start = { code: "", at: 0 }) {
    let s = start;
    for (const ch of keys) {
      const box = Math.min(3, s.at >> 2);
      const inBox = s.code.slice(4 * box, 4 * box + 4);
      const off = s.at - 4 * box;
      s = typedInto(s.code, box, inBox.slice(0, off) + ch + inBox.slice(off), off + 1) ?? s;
    }
    return s;
  }

  it("typing: capitals, the caret moving on as each box fills, the hyphens never typed, the value the spelling", () => {
    const r = typeAll("jdxtnbsg6jqgxbtv");
    expect(r).toEqual({ code: "JDXTNBSG6JQGXBTV", at: 16 });
    expect(valueOf(r.code)).toBe(GEN);
    expect(typeAll("jdxt").at >> 2).toBe(1); // after four, the caret is in the second box
    expect(valueOf("JDXTNB")).toBe("JDXT-NB");
    expect(valueOf("")).toBe("");
    // typed hyphens and spaces are separators, left out as the plain field's check leaves them out; a symbol the
    // generator never makes, or another dash, is refused (the key does nothing)
    expect(typeAll("jd-x t1IlO0\u2013\u200bxx")).toEqual({ code: "JDXTXX", at: 6 });
    expect(typedInto("JD", 0, "JD1", 3)).toBeNull();
    expect(typedInto("JD", 0, "JD\u2010", 3)).toBeNull();
    // a 17th symbol is refused, not pushed in with the last one dropped
    expect(typeAll("x", { code: "JDXTNBSG6JQGXBTV", at: 16 })).toEqual({ code: "JDXTNBSG6JQGXBTV", at: 16 });
    expect(typedInto("JDXTNBSG6JQGXBTV", 1, "NBXSG", 3)).toBeNull();
  });

  it("a whole code pasted, with or without hyphens or spaces, in either case, is the code, into any box; a part goes in at the caret", () => {
    const whole = { code: "JDXTNBSG6JQGXBTV", at: 16 };
    for (const pasted of [
      GEN,
      "jdxtnbsg6jqgxbtv",
      "JDXT NBSG 6JQG XBTV",
      " jdxt-nbsg-6jqg-xbtv\n",
      "ｊｄｘｔ ｎｂｓｇ ６ｊｑｇ ｘｂｔｖ",
    ])
      for (const [held, i] of [
        ["", 0],
        ["AB", 0],
        ["JDXTNB", 1],
        ["ZZZZZZZZZZZZZZZZ", 3],
      ] as const)
        expect(pasteInto(held, i, held.slice(4 * i, 4 * i + 4), 0, 0, pasted), `${pasted} into ${held}`).toEqual(whole);
    // a part lands at the caret (or over the selection), the rest moving on
    expect(pasteInto("JDXTNB", 1, "NB", 2, 2, "sg")).toEqual({ code: "JDXTNBSG", at: 8 });
    expect(pasteInto("JDXTNBSG", 1, "NBSG", 1, 3, "ZZ")).toEqual({ code: "JDXTNZZG", at: 7 });
    expect(pasteInto("JDXT", 1, "", 0, 0, "nb-s")).toEqual({ code: "JDXTNBS", at: 7 });
    // a password manager sets the first box to the whole code: all four fill, whatever they held
    for (const held of ["", "AB", "JDXTNBSG", "ZZZZZZZZZZZZZZZZ"])
      expect(typedInto(held, 0, GEN, GEN.length), held).toEqual(whole);
  });

  it("refused as the plain field's check refuses it: other dashes, zero-width characters, more than 16, anything else", () => {
    for (const bad of [
      GEN.replace(/-/g, "\u2010"),
      GEN.replace(/-/g, "\u2011"),
      GEN.replace(/-/g, "\u2013"),
      GEN.replace(/-/g, "\u2212"),
      GEN.replace(/-/g, "\u200b"),
      GEN.replace(/-/g, "\u200d"),
      GEN + "-EXTRA", // more than 16: not the first 16 of it
      `Password: ${GEN}`,
      "1lO0-IIII-LLLL-OOOO",
    ]) {
      expect(generatedForm(bad), bad).toBeNull(); // what the plain field's check makes of it
      expect(codeSymbols(bad), bad).toBe(bad === GEN + "-EXTRA" ? "JDXTNBSG6JQGXBTVEXTRA" : null);
      for (const [held, i] of [
        ["", 0],
        ["JDXTNB", 1],
      ] as const)
        expect(pasteInto(held, i, held.slice(4 * i), 0, 0, bad), bad).toBeNull();
      expect(typedInto("", 0, bad, bad.length), bad).toBeNull(); // nor filled in by a password manager
    }
    // a part that makes more than 16 in all
    expect(pasteInto("JDXTNBSG6JQG", 3, "", 0, 0, "XBTVA")).toBeNull();
    expect(pasteInto("JDXTNBSG6JQG", 3, "", 0, 0, "XBTV")).toEqual({ code: "JDXTNBSG6JQGXBTV", at: 16 });
    // and what both take: white space of every kind, ASCII hyphens, full-width forms, either case
    for (const ok of [GEN.toLowerCase(), GEN.replace(/-/g, "\u00a0"), GEN.replace(/-/g, "\t"), "\ufeff" + GEN]) {
      expect(generatedForm(ok)?.canonical, JSON.stringify(ok)).toBe(GEN);
      expect(codeSymbols(ok), JSON.stringify(ok)).toBe("JDXTNBSG6JQGXBTV");
    }
  });

  it("an edit inside a box moves the symbols after it, as one field would", () => {
    // delete the S of NBSG: the rest moves back by one
    expect(typedInto("JDXTNBSG6JQG", 1, "NBG", 2)).toEqual({ code: "JDXTNBG6JQG", at: 6 });
    // typed into a later, empty box while an earlier one is not full: it goes on at the end
    expect(typedInto("JD", 3, "x", 1)).toEqual({ code: "JDX", at: 3 });
  });

  it("Backspace at the start of a box deletes the symbol before it; at the very start there is none", () => {
    expect(backspaceAt("JDXTNB", 1)).toEqual({ code: "JDXNB", at: 3 });
    expect(backspaceAt("JDXTNBSG6", 2)).toEqual({ code: "JDXTNBS6", at: 7 });
    expect(backspaceAt("JD", 3)).toEqual({ code: "J", at: 1 }); // an empty later box: the last symbol
    expect(backspaceAt("JDXT", 0)).toBeNull();
    expect(backspaceAt("", 2)).toBeNull();
  });

  it("the arrows at a box's edge go on into the box beside, as in one field; inside a box they are the browser's", () => {
    // left at the start of a box: before the last symbol of the box before
    expect(arrowAt("JDXTNB", 1, true, 0)).toEqual({ code: "JDXTNB", at: 3 });
    expect(arrowAt("JDXTNBSG", 2, true, 0)).toEqual({ code: "JDXTNBSG", at: 7 }); // an empty box, the caret in it
    // right at the end of a full box: after the first symbol of the next (the end of a full box and the start of the
    // next are one place in one field), or its start when it is empty
    expect(arrowAt("JDXTNB", 0, false, 4)).toEqual({ code: "JDXTNB", at: 5 });
    expect(arrowAt("JDXTNBSG", 1, false, 4)).toEqual({ code: "JDXTNBSG", at: 8 });
    expect(arrowAt("JDXTNBSG6", 1, false, 4)).toEqual({ code: "JDXTNBSG6", at: 9 });
    // nowhere to go, or inside the box: the browser moves the caret (or nothing does)
    expect(arrowAt("JDXT", 0, true, 0)).toBeNull();
    expect(arrowAt("JDXTNBSG6JQGXBTV", 3, false, 4)).toBeNull();
    expect(arrowAt("JDXTNB", 1, false, 2)).toBeNull(); // the end of a part-filled box is the end of the code
    for (const c of [1, 2, 3]) {
      expect(arrowAt("JDXTNBSG", 1, true, c)).toBeNull();
      expect(arrowAt("JDXTNBSG", 1, false, c)).toBeNull();
    }
    // the code itself never changes
    expect(arrowAt(GEN.replace(/-/g, ""), 2, true, 0)!.code).toBe(GEN.replace(/-/g, ""));
  });

  it("the keys: Backspace at a box's start, and only the bare arrows (with Shift, Alt, Ctrl or Cmd: the browser's)", () => {
    const s = code("ui/PasswordGroups.tsx");
    expect(s).toMatch(/if \(e\.isComposing \|\| at !== el\.selectionEnd\) return;/); // composing, or a selection
    expect(s).toMatch(/e\.key === "Backspace"\s*\?\s*at\s*\?\s*null\s*:\s*backspaceAt\(code, i\)/);
    expect(s).toMatch(
      /\(left \|\| e\.key === "ArrowRight"\) && !\(e\.shiftKey \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey\)/,
    );
  });

  it("codeSymbols(): the plain field's reading (compactCode), capitals, and null for anything but symbols", () => {
    expect(codeSymbols("ｊｄｘｔ- ")).toBe("JDXT");
    expect(codeSymbols(GEN.toLowerCase())).toBe("JDXTNBSG6JQGXBTV");
    expect(codeSymbols("jdxt-1")).toBeNull();
    expect(codeSymbols("ß")).toBeNull();
    // the one reading, shared: no second copy of the separator rule in the component
    const g = code("ui/PasswordGroups.tsx");
    expect(g).toMatch(/import \{ compactCode, NOT_GEN_SYMBOL \} from "\.\.\/core\/crypto\/password-candidates";/);
    expect(g).not.toMatch(/normalize\(|\\s/);
    expect(code("core/crypto/password-candidates.ts")).toMatch(/const compact = compactCode\(t\);/);
  });

  it("an input method composing is left alone: no edit while it composes, its text taken at compositionend", () => {
    const g = code("ui/PasswordGroups.tsx");
    expect(g).toMatch(/if \(!\(e as unknown as InputEvent\)\.isComposing\) edit\(e\.currentTarget, i\);/);
    // lower case, or Preact would listen for "CompositionEnd", which Chrome never fires (it has no oncompositionend)
    expect(g).toMatch(
      /\{\.\.\.\{ oncompositionend: \(e: CompositionEvent\) => edit\(e\.currentTarget as HTMLInputElement, i\) \}\}/,
    );
  });

  it("what the browser keeps: masked unless shown, autocomplete off always, no storage, cleared on pagehide and a lock", () => {
    const s = src("ui/PasswordGroups.tsx");
    expect(s).toMatch(/type=\{shown \? "text" : "password"\}/);
    expect(s).toMatch(/autocomplete="off"/);
    expect(s).not.toMatch(/autocomplete=\{/); // never anything else, shown or not
    expect(s).toMatch(/autocapitalize="off"/);
    expect(s).toMatch(/spellcheck=\{false\}/);
    expect(s).toMatch(/addEventListener\("pagehide", drop\)/);
    expect(s).toMatch(/LOCK_EPOCH_KEY in c\) drop\(\)/);
    expect(s).toMatch(/const \[shown, setShown\] = useState\(false\);/); // masked to begin with
    expect(s).toMatch(/if \(!p\.value\) setShown\(false\);/); // and again whenever emptied
    expect(s).toMatch(/\{p\.showable !== false && \(\s*<button/); // no Show where the page says so (the popup)
    expect(s.match(/setShown\(/g)).toHaveLength(2); // nothing else turns it on
    expect(s).toMatch(/p\.onValue\(valueOf\(r\.code\)\);/); // the spelling with its hyphens, never the bare symbols
    for (const f of ["ui/PasswordGroups.tsx", "options/MasterField.tsx", "popup/screens/Locked.tsx"])
      expect(src(f), f).not.toMatch(/localStorage|sessionStorage|indexedDB|\.set\(\{|\.storage\.local/);
    // one component for both pages: the settings page's copy is gone, and nothing else draws boxes of its own
    expect(() => src("options/PasswordGroups.tsx")).toThrow();
  });
});

describe("the settings page's hint reader (src/options/MasterField.tsx hintReader)", () => {
  /** A read function whose answers the test hands out in any order. */
  function scripted() {
    const pending: ((h: "gen16-v1" | "gen5words-v1" | null) => void)[] = [];
    const fail: ((e: unknown) => void)[] = [];
    const read = () =>
      new Promise<"gen16-v1" | "gen5words-v1" | null>((res, rej) => {
        pending.push(res);
        fail.push(rej);
      });
    return { read, pending, fail };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("the fields of one render read once, and all get the answer", async () => {
    const r = scripted();
    const reader = hintReader(r.read);
    const seen: unknown[] = [];
    reader.watch((h) => seen.push(["a", h]));
    reader.watch((h) => seen.push(["b", h]));
    expect(r.pending).toHaveLength(1);
    r.pending[0]!("gen16-v1");
    await tick();
    expect(seen).toEqual([
      ["a", "gen16-v1"],
      ["b", "gen16-v1"],
    ]);
    expect(reader.latest()).toBe("gen16-v1");
  });

  it("reads out of order: only the newest one's answer is applied (review m2)", async () => {
    const r = scripted();
    const reader = hintReader(r.read);
    const seen: unknown[] = [];
    reader.watch((h) => seen.push(h));
    reader.refresh(true); // the record changed while the first read was under way
    expect(r.pending).toHaveLength(2);
    r.pending[1]!(null); // the newer answer first...
    await tick();
    r.pending[0]!("gen16-v1"); // ...then the older one, late
    await tick();
    expect(seen).toEqual([null]);
    expect(reader.latest()).toBeNull();
  });

  it("a read that fails leaves the last answer, and the next field reads again", async () => {
    const r = scripted();
    const reader = hintReader(r.read);
    const off = reader.watch(() => undefined);
    r.fail[0]!(new Error("no"));
    await tick();
    expect(reader.latest()).toBeNull();
    off();
    reader.watch(() => undefined);
    expect(r.pending).toHaveLength(2);
  });

  it("the field follows the hint only while it is empty; the grouped boxes are one named group", () => {
    const m = src("options/MasterField.tsx");
    expect(m).toMatch(/if \(!p\.value\) setFormat\(hint\);/);
    expect(m).toMatch(/labelledBy=\{`\$\{p\.id\}-label`\}/);
    const g = src("ui/PasswordGroups.tsx");
    expect(g).toMatch(/role="group" aria-labelledby=\{p\.labelledBy\}/);
    expect(g).toMatch(/aria-controls=\{ids\.join\(" "\)\}/);
  });
});
