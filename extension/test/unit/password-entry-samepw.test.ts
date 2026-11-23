// The subset export's guard (HYPHEN review B1; the reviewer's test, adopted): the file password, which goes to someone
// else, must not be any string the master-password prompts accept for the master password typed above it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createKeyring, openWithPassword, setPassword } from "../../src/core/crypto/keyring";
import { GEN_ALPHABET } from "../../src/core/crypto/password-candidates";
import { sameMasterPassword } from "../../src/options/Backup";

const GEN = "JDXT-NBSG-6JQG-XBTV";
const WORDS = "acorn-banjo-canyon-dwelling-eagle";

describe("sameMasterPassword: the subset file's password against the master password typed above it", () => {
  it("every spelling the prompts accept for the master password is the same password", () => {
    for (const [a, b] of [
      ["jdxt nbsg 6jqg xbtv", GEN],
      ["jdxtnbsg6jqgxbtv", GEN],
      ["JDXTNBSG6JQGXBTV", "jdxt-nbsg-6jqg-xbtv"],
      ["ＪＤＸＴ－ＮＢＳＧ－６ＪＱＧ－ＸＢＴＶ", GEN], // full width (the shipped NFKC case, kept)
      ["Acorn Banjo Canyon Dwelling Eagle", WORDS],
      ["acorn_banjo_canyon_dwelling_eagle", "ACORN BANJO CANYON DWELLING EAGLE"],
      ["tulip-orbit-lantern-84", "tulip-orbit-lantern-84"],
      ["ｔｕｌｉｐ-orbit-lantern-84", "tulip-orbit-lantern-84"],
    ])
      expect(sameMasterPassword(a!, b!), `${a} / ${b}`).toBe(true);
  });

  it("different passwords stay different (a user's own is compared exactly, as its prompts take it)", () => {
    for (const [a, b] of [
      ["JDXT-NBSG-6JQG-XBTW", GEN],
      ["Tulip-Orbit-Lantern-84", "tulip-orbit-lantern-84"],
      ["tulip orbit lantern 84", "tulip-orbit-lantern-84"],
      ["acorn banjo canyon dwelling", "acorn-banjo-canyon-dwelling"], // 4 words: no generated shape, compared exactly
    ])
      expect(sameMasterPassword(a!, b!), `${a} / ${b}`).toBe(false);
  });

  it("complete for the tolerance: whatever opens a vault whose password the user just typed is flagged", async () => {
    // P is the stored password; M the master typed for the export (opens P); S the file password. If S opens P, the
    // guard must say "same". Checked against the real check (openWithPassword) on one keyring per style.
    for (const stored of [GEN, WORDS]) {
      const { keyring, vk } = await createKeyring();
      const kr = await setPassword(keyring, vk, stored);
      const spellings =
        stored === GEN
          ? ["jdxtnbsg6jqgxbtv", "JDXT NBSG 6JQG XBTV", " jdxt-NBSG 6jqg-xbtv ", GEN]
          : ["Acorn Banjo Canyon Dwelling Eagle", "acorn_banjo canyon-dwelling EAGLE", WORDS];
      for (const m of spellings)
        for (const s of spellings) {
          expect((await openWithPassword(kr, s)).vk.id).toBe(vk.id); // s opens the vault...
          expect(sameMasterPassword(s, m), `${s} / ${m}`).toBe(true); // ...so it is refused as the file's password
        }
    }
  });

  it("property: any two loose spellings of one generated code are the same password", () => {
    const sym = fc.constantFrom(...GEN_ALPHABET.split(""));
    fc.assert(
      fc.property(
        fc.array(sym, { minLength: 16, maxLength: 16 }),
        fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
        fc.array(fc.constantFrom("", " ", "-", "  ", "\t"), { minLength: 16, maxLength: 16 }),
        (code, lower, seps) => {
          const canonical = code.join("").replace(/.{4}(?=.)/g, "$&-");
          const loose = code.map((c, i) => (lower[i] ? c.toLowerCase() : c) + seps[i]).join("");
          expect(sameMasterPassword(loose, canonical)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("the page uses it, not a bare NFKC comparison", () => {
    const s = readFileSync(join(__dirname, "../../src/options/Backup.tsx"), "utf8");
    expect(s).toMatch(/const samePw = asks && subPw !== "" && sameMasterPassword\(subPw, masterPw\.subset\);/);
    expect(s).not.toMatch(/subPw\.normalize\("NFKC"\) === masterPw\.subset\.normalize\("NFKC"\)/);
  });
});
