// otpauth:// labels whose issuer prefix is in another case than the issuer parameter, where lower case has another
// length ("İ", U+0130, is one code unit and lower-cases to two, "i" and U+0307) or the text has astral characters (two
// code units each). The prefix is compared and cut on the label itself (src/core/totp/otpauth.ts issuerPrefixed), so no
// cut ever falls in the middle of a surrogate pair: what is read is well formed, and exporting it, encodeURIComponent
// included, never throws. The import report's name of a link it skips is cut the same way, and clipped by code point
// (src/core/import/file-formats.ts nameOfLink).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readImportText } from "../../src/core/import/file-formats";
import { applyImport, exportOtpauthList } from "../../src/core/import/importer";
import { parseOtpauth, parseOtpauthList, serializeOtpauth, type OtpParams } from "../../src/core/totp/otpauth";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";

const S = "JBSWY3DPEHPK3PXP";
const enc = encodeURIComponent;
const uri = (label: string, issuer: string) => `otpauth://totp/${enc(label)}?secret=${S}&issuer=${enc(issuer)}`;
const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
/** A lone surrogate: a high one not followed by a low one, or a low one not after a high one. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const DOTTED = "İ"; // İ, one code unit
const DOTTED_LOWER = "i̇"; // its lower case, two code units

function read(u: string) {
  const r = parseOtpauth(u);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}: ${u}`);
  return r;
}
/** The one-line export of a vault holding `p` alone, read back. */
function exported(p: OtpParams): OtpParams {
  const v = applyImport(emptyVault("vault-0123456789"), [p], clock);
  const lines = parseOtpauthList(exportOtpauthList(v));
  expect(lines).toHaveLength(1);
  const r = lines[0]!.result;
  if (!r.ok) throw new Error(`the export did not read back: ${r.error}`);
  return r.value;
}

describe("otpauth: an issuer prefix whose lower case has another length", () => {
  it("a label the issuer's lower case is longer in: no lone surrogate, the account whole, no warning", () => {
    // the issuer "i" + U+0307 (two units) and the label's prefix "İ" (one): the old cut, at the issuer's length, fell
    // inside the emoji and left its low surrogate alone
    const r = read(uri(`${DOTTED}:\u{1F600}`, DOTTED_LOWER));
    expect(r.value.issuer).toBe(DOTTED_LOWER);
    expect(r.value.label).toBe("\u{1F600}");
    expect(r.warnings).toEqual([]);
    expect(LONE.test(r.value.label)).toBe(false);
  });

  it("a label the issuer's lower case is shorter in: the account keeps none of the prefix", () => {
    // the issuer "İ" (one unit) and the prefix "i" + U+0307 (two): the old cut left ":bob"
    const r = read(uri(`${DOTTED_LOWER}:bob`, DOTTED));
    expect(r.value.issuer).toBe(DOTTED);
    expect(r.value.label).toBe("bob");
    expect(r.warnings).toEqual([]);
  });

  it("ß and SS are other names (no case folding): the parameter wins, the label kept whole, with the warning", () => {
    const r = read(uri("STRASSE:bob", "Straße"));
    expect(r.value.issuer).toBe("Straße");
    expect(r.value.label).toBe("STRASSE:bob");
    expect(r.warnings).toContain("issuer_mismatch");
    expect(read(uri("straße:bob", "STRAßE")).value).toMatchObject({ issuer: "STRAßE", label: "bob" });
  });

  it("a final sigma: the prefix in capitals matches the issuer in small letters", () => {
    expect(read(uri("ΟΔΟΣ:bob", "οδος")).value).toMatchObject({ issuer: "οδος", label: "bob" });
  });

  it("astral characters in the issuer and the account: cut just after the issuer's colon", () => {
    expect(read(uri("\u{1F600}Bank:bob", "\u{1F600}BANK")).value).toMatchObject({
      issuer: "\u{1F600}BANK",
      label: "bob",
    });
    expect(read(uri("a\u{1D518}:b\u{1F600}c", "A\u{1D518}")).value).toMatchObject({
      issuer: "A\u{1D518}",
      label: "b\u{1F600}c",
    });
  });

  it("a prefix that only starts with the issuer is not cut at the issuer's length", () => {
    // "Git" and "GitHub": the first three letters match, but the label's colon is further on
    const r = read(uri("GitHub:alice", "Git"));
    expect(r.value).toMatchObject({ issuer: "Git", label: "GitHub:alice" });
    expect(r.warnings).toContain("issuer_mismatch");
  });

  it("an issuer with a colon in it, in another case", () => {
    expect(read(uri("x:Y:bob", "X:y")).value).toMatchObject({ issuer: "X:y", label: "bob" });
  });

  it("each of these entries exports (encodeURIComponent included) and reads back the same", () => {
    for (const [label, issuer] of [
      [`${DOTTED}:\u{1F600}`, DOTTED_LOWER],
      [`${DOTTED_LOWER}:bob`, DOTTED],
      ["STRASSE:bob", "Straße"],
      ["\u{1F600}Bank:bob", "\u{1F600}BANK"],
      ["a\u{1D518}:b\u{1F600}c", "A\u{1D518}"],
    ] as const) {
      const { value } = read(uri(label, issuer));
      expect(() => serializeOtpauth(value), `${label} / ${issuer}`).not.toThrow();
      expect(exported(value), `${label} / ${issuer}`).toEqual(value);
    }
  });
});

describe("otpauth: any label and issuer of case-changing and astral characters", () => {
  // the characters whose case or width tripped the old cut, with the colon and a few plain ones
  const piece = fc.constantFrom(
    DOTTED,
    "i",
    "I",
    "̇",
    ":",
    "ß",
    "ẞ",
    "S",
    "s",
    "Σ",
    "σ",
    "ς",
    "\u{1F600}",
    "\u{1D518}",
    "\u{10400}", // Deseret capital long I (astral, with an astral lower case)
    "a",
    "B",
    " ",
  );
  const text = fc.array(piece, { maxLength: 8 }).map((a) => a.join(""));

  it("reads well formed text, or the prefix whole; exporting it never throws and reads back the same", () => {
    fc.assert(
      fc.property(text, text, text, (prefix, account, issuer) => {
        const r = parseOtpauth(uri(`${prefix}:${account}`, issuer));
        if (!r.ok) return; // (an issuer or a label of spaces alone may leave nothing to read; not this test's)
        expect(LONE.test(r.value.issuer)).toBe(false);
        expect(LONE.test(r.value.label)).toBe(false);
        expect(() => serializeOtpauth(r.value)).not.toThrow();
        expect(exported(r.value)).toEqual(r.value);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("the import report's name of a link it skips (file-formats.ts nameOfLink)", () => {
  /** The name the report gives the one line of `text` it skips. */
  function skippedName(text: string): string {
    const r = readImportText(text);
    if (r.kind !== "accounts" || r.skipped.length !== 1) throw new Error(`expected one skipped line: ${text}`);
    return r.skipped[0]!.name;
  }
  // a secret that is not base32: the link is skipped, and named from its label and issuer alone
  const bad = (label: string, issuer?: string) =>
    `otpauth://totp/${enc(label)}?secret=1${issuer === undefined ? "" : `&issuer=${enc(issuer)}`}`;

  it("an issuer whose lower case has another length: no cut inside the label's emoji, no lone surrogate", () => {
    const name = skippedName(bad(`${DOTTED}:😀`, DOTTED_LOWER));
    expect(LONE.test(name)).toBe(false);
    expect(name).toBe(`${DOTTED_LOWER} (${DOTTED}:😀)`); // not taken as the issuer's prefix: the label whole
  });

  it("the issuer's prefix in another case of the same length, or holding a colon, is cut as before", () => {
    expect(skippedName(bad("GITHUB:alice", "GitHub"))).toBe("GitHub (alice)");
    expect(skippedName(bad("a:b:alice", "a:b"))).toBe("a:b (alice)");
    expect(skippedName(bad("𝔘ser:😀", "𝔘SER"))).toBe("𝔘SER (😀)");
    expect(skippedName(bad("Git:alice", "GitHub"))).toBe("GitHub (Git:alice)");
  });

  it("a long name is clipped by code point: 63 of them and an ellipsis, never half of a pair", () => {
    const name = skippedName(bad("😀".repeat(70)));
    expect(LONE.test(name)).toBe(false);
    expect([...name]).toHaveLength(64);
    expect(name).toBe("😀".repeat(63) + "…");
    expect(skippedName(bad("a".repeat(64)))).toBe("a".repeat(64)); // 64 is not clipped
    expect(skippedName(bad("a".repeat(65)))).toBe("a".repeat(63) + "…");
  });
});
