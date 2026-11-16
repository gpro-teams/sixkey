// H7: plain text key lines (a bare key, or name|key with any other columns) through the normal importer.
// Only the key and the name may survive: other columns (passwords, emails, notes) must not reach the plan or the vault.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyImport, MAX_COLUMNS, MIN_TEXT_KEY, planImport, type ImportOptions } from "../../src/core/import/importer";
import { encodeBase32 } from "../../src/core/totp/base32";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { parseVault, serializeVault } from "../../src/core/vault/validate";

const S1 = "JBSWY3DPEHPK3PXP"; // 16 characters, the minimum
const S2 = "GEZDGNBVGY3TQOJQ";
const S3 = "MFRGGZDFMZTWQ2LK";
const S4 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // 32 characters
const PW = "Hunter2-Correct!Horse"; // stands for every column that is neither the key nor the name
const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });

const plan = (text: string, opts: ImportOptions = {}, existing = emptyVault("vault-0123456789").entries) =>
  planImport(text, existing, [], opts).plan;
const names = (p: ReturnType<typeof plan>) => p.add.map((a) => `${a.issuer}/${a.label}`);
const reasons = (p: ReturnType<typeof plan>) => p.failed.map((f) => `${f.index}:${f.reason}`);
/** The text the vault would hold after these accounts are added: exactly what is encrypted, read back the way the store reads it. */
function savedText(p: ReturnType<typeof plan>): string {
  const bytes = serializeVault(applyImport(emptyVault("vault-0123456789"), p.add, clock));
  const text = new TextDecoder().decode(bytes);
  parseVault(JSON.parse(text)); // what is written must load back
  return text;
}

describe("bare keys, one per line", () => {
  it("a key alone becomes an unnamed account with the usual settings, marked as coming from text", () => {
    const p = plan(S4);
    expect(p.add).toEqual([
      { type: "totp", issuer: "", label: "", secret: S4, algorithm: "SHA1", digits: 6, period: 30 },
    ]);
    expect(p.fromText).toEqual([0]);
    expect(p.table).toBeNull();
    expect(p.failed).toEqual([]);
  });
  it("is case-insensitive and stores the canonical upper-case form", () => {
    expect(plan(S1.toLowerCase()).add[0]!.secret).toBe(S1);
  });
  it("accepts keys printed in groups of four, with plain or full-width spaces", () => {
    expect(plan("jbsw y3dp ehpk 3pxp").add[0]!.secret).toBe(S1);
    expect(plan("JBSW　Y3DP　EHPK　3PXP").add[0]!.secret).toBe(S1);
    expect(plan("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ").add[0]!.secret).toBe(S4);
    expect(plan("GEZD GNBV GY3T QOJQ G").add[0]!.secret).toBe("GEZDGNBVGY3TQOJQG"); // a shorter last group
  });
  it("accepts hyphens, '=' padding and full-width letters", () => {
    expect(plan("JBSW-Y3DP-EHPK-3PXP").add[0]!.secret).toBe(S1);
    expect(plan(`${S3}====`).add[0]!.secret).toBe(S3);
    expect(plan("ＪＢＳＷＹ３ＤＰＥＨＰＫ３ＰＸＰ").add[0]!.secret).toBe(S1);
  });
  it(`needs at least ${MIN_TEXT_KEY} characters: one fewer is "not a key"`, () => {
    expect(MIN_TEXT_KEY).toBe(16);
    expect(plan(S1).add).toHaveLength(1);
    const p = plan(S1.slice(0, 15));
    expect(p.add).toEqual([]);
    expect(reasons(p)).toEqual(["0:not_key"]);
  });
  it("a word that happens to be base32 is too short to count (GitHub, a name pasted alone)", () => {
    expect(reasons(plan("GitHub"))).toEqual(["0:not_key"]);
  });
  it("ordinary text is not read as a key, even when all its letters are base32", () => {
    const p = plan(["garbage line", "hello world this is me", "JBSWY Y3DPE HPK3P XP"].join("\n"));
    expect(p.add).toEqual([]);
    expect(reasons(p)).toEqual(["0:not_otpauth", "1:not_otpauth", "2:not_otpauth"]);
  });
  it("characters outside base32 make it not a key, and the text is never echoed", () => {
    const bad = "JBSWY3DPEHPK3PX0"; // 0 is not base32
    const p = plan(`${bad}\nhunter2!`);
    expect(reasons(p)).toEqual(["0:not_otpauth", "1:not_otpauth"]);
    expect(JSON.stringify(p)).not.toContain(bad);
    expect(JSON.stringify(p)).not.toContain("hunter2");
  });
  it("lines of only separators or spaces are not keys", () => {
    expect(reasons(plan("|||\n｜ ｜"))).toEqual(["0:not_otpauth", "1:not_otpauth"]);
  });
});

describe("name|key lines", () => {
  it("name|key: the name becomes the issuer, so it can match the site", () => {
    const p = plan(`GitHub|${S1}\nAWS|${S2}`);
    expect(names(p)).toEqual(["GitHub/", "AWS/"]);
    expect(p.add.map((a) => a.secret)).toEqual([S1, S2]);
    expect(p.table).toMatchObject({ lines: 2, keyColumn: 1, nameColumn: 0, auto: true, pending: 0 });
    expect(p.fromText).toEqual([0, 1]);
  });
  it("Issuer:account in the name splits like an otpauth label", () => {
    expect(names(plan(`GitHub:alice@example.com|${S1}`))).toEqual(["GitHub/alice@example.com"]);
  });
  it("key|name works too: the key column is found, and the name is the other column", () => {
    const p = plan(`${S1}|GitHub\n${S2}|AWS`);
    expect(p.table).toMatchObject({ keyColumn: 0, nameColumn: 1 });
    expect(names(p)).toEqual(["GitHub/", "AWS/"]);
  });
  it("leading and trailing separators, spaces around cells, and a grouped key are all fine", () => {
    const p = plan(`|GitHub|${S1}|\n  AWS  |  GEZD GNBV GY3T QOJQ  `);
    expect(names(p)).toEqual(["GitHub/", "AWS/"]);
    expect(p.add.map((a) => a.secret)).toEqual([S1, S2]);
    expect(p.table!.columns).toHaveLength(2);
  });
  it("accepts the full-width separator ｜ that Chinese input methods type", () => {
    const p = plan(`阿里云｜${S1}`);
    expect(names(p)).toEqual(["阿里云/"]);
    expect(p.add[0]!.secret).toBe(S1);
  });
  it("CRLF line endings and blank lines; line numbers count the lines that have text", () => {
    const p = plan(`GitHub|${S1}\r\n\r\nAWS|short\r\nCorp|${S3}\r\n`, { keyColumn: 1 });
    expect(names(p)).toEqual(["GitHub/", "Corp/"]);
    expect(reasons(p)).toEqual(["1:not_key"]);
  });
  it("an empty name column gives an unnamed account; an empty middle column keeps the positions", () => {
    expect(names(plan(`|${S1}\n|${S2}`))).toEqual(["/", "/"]); // an empty first cell: no name
    const p = plan(`GitHub||${S1}\nAWS||${S2}`);
    expect(p.table).toMatchObject({ keyColumn: 2, nameColumn: 0 });
    expect(names(p)).toEqual(["GitHub/", "AWS/"]);
  });
});

describe("three or more columns: only the key and the name are kept", () => {
  it("name|key|password: the password reaches neither the plan nor the saved vault", () => {
    const p = plan(`GitHub|${S1}|${PW}\nAWS|${S2}|${PW}x`);
    expect(names(p)).toEqual(["GitHub/", "AWS/"]);
    const plan_ = JSON.stringify(p);
    const saved = savedText(p);
    // Positive control: what must be kept is there, so the absence below is not vacuous.
    for (const s of [plan_, saved]) {
      expect(s).toContain("GitHub");
      expect(s).toContain(S1);
      expect(s).toContain(S2);
      expect(s).not.toContain("Hunter2");
      expect(s).not.toContain("Correct!Horse");
    }
  });
  it("login|password|key (the key last) is found automatically, and the password is dropped", () => {
    const p = plan(`alice@example.com|${PW}|${S1}\nbob@example.com|${PW}|${S2}`);
    expect(p.table).toMatchObject({ keyColumn: 2, nameColumn: 0, auto: true });
    expect(names(p)).toEqual(["alice@example.com/", "bob@example.com/"]);
    expect(JSON.stringify(p)).not.toContain(PW);
    expect(savedText(p)).not.toContain(PW);
  });
  it("four columns (login|password|mail password|key)", () => {
    const p = plan(`alice|${PW}|mailpw-ALICE-2024|${S1}\nbob|${PW}|mailpw-BOB-2024|${S2}`);
    expect(p.table).toMatchObject({ keyColumn: 3, nameColumn: 0 });
    expect(names(p)).toEqual(["alice/", "bob/"]);
    const all = JSON.stringify(p) + savedText(p);
    expect(all).not.toContain(PW);
    expect(all).not.toContain("mailpw");
  });
  it("columns are described by position, length and how often they look like a key, never by content", () => {
    const p = plan(`GitHub|${S1}|${PW}\nAWS|${S4}|abc`);
    expect(p.table!.columns).toEqual([
      { index: 0, minLength: 3, maxLength: 6, keyLike: 0 },
      { index: 1, minLength: 16, maxLength: 32, keyLike: 2 },
      { index: 2, minLength: 3, maxLength: PW.length, keyLike: 0 },
    ]);
    expect(JSON.stringify(p.table)).not.toMatch(/GitHub|AWS|Hunter|abc/);
  });
  it("when two columns both read as keys in every line, nothing is guessed: the lines wait for a choice", () => {
    const text = `${S1}|${S2}|GitHub\n${S3}|${S4}|AWS`;
    const p = plan(text);
    expect(p.table).toMatchObject({ keyColumn: null, auto: false, pending: 2 });
    expect(p.add).toEqual([]);
    expect(p.failed).toEqual([]); // held back, not failed
    const chosen = plan(text, { keyColumn: 1, nameColumn: 2 });
    expect(chosen.table).toMatchObject({ keyColumn: 1, nameColumn: 2, auto: false, pending: 0 });
    expect(names(chosen)).toEqual(["GitHub/", "AWS/"]);
    expect(chosen.add.map((a) => a.secret)).toEqual([S2, S4]);
    expect(JSON.stringify(chosen) + savedText(chosen)).not.toContain(S1);
    // Choosing only the key column: the default name column holds keys, so the accounts get no name rather than a secret.
    const keyOnly = plan(text, { keyColumn: 1 });
    expect(keyOnly.table!.nameColumn).toBeNull();
    expect(names(keyOnly)).toEqual(["/", "/"]);
    expect(JSON.stringify(keyOnly) + savedText(keyOnly)).not.toContain(S1);
  });
  it("a header line stops the automatic choice; choosing the column adds the rest and reports the header", () => {
    const text = `name|secret|password\nGitHub|${S1}|${PW}\nAWS|${S2}|${PW}`;
    expect(plan(text).table).toMatchObject({ keyColumn: null, pending: 3 });
    const p = plan(text, { keyColumn: 1 });
    expect(names(p)).toEqual(["GitHub/", "AWS/"]);
    expect(reasons(p)).toEqual(["0:not_key"]);
    expect(JSON.stringify(p)).not.toContain(PW);
  });
  it("a chosen key column that is empty or not base32 in some line fails that line only, without echoing it", () => {
    const p = plan(`GitHub|${S1}\nAWS|\nCorp|n0t-a-k3y!-${PW}`, { keyColumn: 1 });
    expect(names(p)).toEqual(["GitHub/"]);
    expect(reasons(p)).toEqual(["1:missing_secret", "2:invalid_secret"]);
    expect(JSON.stringify(p)).not.toContain("n0t-a-k3y");
  });
  it("a line shorter than the chosen key column has no key", () => {
    const p = plan(`a|b|${S1}\nc|${S2}`, { keyColumn: 2 });
    expect(names(p)).toEqual(["a/"]);
    expect(reasons(p)).toEqual(["1:missing_secret"]);
  });
  it("out-of-range or non-integer column choices are ignored", () => {
    for (const keyColumn of [-1, 2, 99, 1.5, Number.NaN]) {
      expect(plan(`GitHub|${S1}`, { keyColumn }).table).toMatchObject({ keyColumn: 1, auto: true });
    }
  });
  it("the name column can be switched off, moved, but not set to the key column", () => {
    const text = `GitHub|${S1}|alice`;
    expect(names(plan(text, { nameColumn: null }))).toEqual(["/"]);
    expect(names(plan(text, { nameColumn: 2 }))).toEqual(["alice/"]);
    expect(plan(text, { nameColumn: 1 }).table!.nameColumn).toBe(0);
  });
  it("key|password: switching the name off keeps the password out entirely", () => {
    const p = plan(`${S1}|${PW}`);
    expect(p.table).toMatchObject({ keyColumn: 0, nameColumn: 1 }); // the default rule would name the account after column 2
    const off = plan(`${S1}|${PW}`, { nameColumn: null });
    expect(JSON.stringify(off) + savedText(off)).not.toContain(PW);
    expect(savedText(off)).toContain(S1);
  });
  it(`a line with more than ${MAX_COLUMNS} columns is not read as a table`, () => {
    const wide = [...Array.from({ length: MAX_COLUMNS }, (_, i) => `c${i}`), S1].join("|");
    const p = plan(`${wide}\nGitHub|${S2}`);
    expect(reasons(p)).toEqual(["0:malformed"]);
    expect(names(p)).toEqual(["GitHub/"]);
    expect(p.table!.lines).toBe(1);
    expect(p.table!.columns).toHaveLength(2);
  });
});

describe("mixed input, duplicates and limits", () => {
  it("links, bare keys, name|key lines and junk mix; order and line numbers are kept", () => {
    const text = [
      `otpauth://totp/AWS:root?secret=${S2}&issuer=AWS`,
      `GitHub|${S1}|${PW}`,
      "garbage line",
      S3,
      `otpauth://totp/x`,
      `Corp|${S4}|${PW}`,
    ].join("\n");
    const p = plan(text);
    expect(names(p)).toEqual(["AWS/root", "GitHub/", "/", "Corp/"]);
    expect(p.fromText).toEqual([1, 2, 3]);
    expect(reasons(p)).toEqual(["2:not_otpauth", "4:missing_secret"]);
    expect(p.table).toMatchObject({ lines: 2, keyColumn: 1 });
    expect(JSON.stringify(p)).not.toContain(PW);
  });
  it("a Google Authenticator export link next to name|key lines", () => {
    const GA = "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC";
    const p = plan(`GitHub|${S2}\n${GA}`);
    expect(names(p)).toEqual(["GitHub/", "Example/alice@google.com"]);
    expect(p.fromText).toEqual([0]);
  });
  it("the same key twice in the text is added once; fromText still points at the right accounts", () => {
    const p = plan(`${S1}\n${S1}\nGitHub|${S2}\nGitHub|${S2}`);
    expect(names(p)).toEqual(["/", "GitHub/"]);
    expect(p.duplicates).toHaveLength(2);
    expect(p.fromText).toEqual([0, 1]);
  });
  it("an account already in the vault (same key and name) is a duplicate; the same key under another name is not", () => {
    const vault = addEntry(
      emptyVault("vault-0123456789"),
      { type: "totp", issuer: "GitHub", label: "", secret: S1, algorithm: "SHA1", digits: 6, period: 30 },
      clock,
    ).vault;
    const p = plan(`github|${S1}\nGitLab|${S1}`, {}, vault.entries);
    expect(names(p)).toEqual(["GitLab/"]);
    expect(p.duplicates.map((d) => d.issuer)).toEqual(["github"]);
    expect(p.fromText).toEqual([0]);
  });
  it("a name longer than the vault allows, or a key longer than it allows, is reported, not saved", () => {
    const longKey = encodeBase32(new Uint8Array(330)); // 528 base32 characters, over the 512 limit
    const p = plan(`${"N!".repeat(129)}|${S1}\nOk|${S2}\nBig|${longKey}`); // a 258-character name
    expect(names(p)).toEqual(["Ok/"]);
    expect(reasons(p)).toEqual(["0:too_long", "2:too_long"]);
    expect(JSON.stringify(p)).not.toContain(longKey);
    expect(() => savedText(p)).not.toThrow();
  });
  it("2,000 name|key|password lines are read in one pass and every password is dropped", () => {
    const keys = Array.from({ length: 2000 }, (_, i) =>
      encodeBase32(new Uint8Array([i >> 8, i & 255, 1, 2, 3, 4, 5, 6, 7, 8])),
    );
    const text = keys.map((k, i) => `acct${i}|${k}|pw-${i}-${PW}`).join("\n");
    const started = Date.now();
    const p = plan(text);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.add).toHaveLength(2000);
    expect(p.table).toMatchObject({ lines: 2000, keyColumn: 1, pending: 0 });
    const saved = savedText(p);
    expect(aliveEntries(parseVault(JSON.parse(saved)))).toHaveLength(2000);
    expect(JSON.stringify(p) + saved).not.toContain("Correct!Horse");
  });
  it("failures carry only a position and a reason", () => {
    const p = plan(`GitHub|${S1}\nAWS|bad!key|${PW}\n${S1.slice(0, 10)}`, { keyColumn: 1 });
    for (const f of p.failed) expect(Object.keys(f).sort()).toEqual(["index", "reason"]);
    expect(JSON.stringify(p.failed)).not.toMatch(/AWS|bad|JBSW|Hunter/);
  });
});

describe("property: no column other than the key and the name ever survives", () => {
  const base32 = fc.uint8Array({ minLength: 10, maxLength: 40 }).map((b) => encodeBase32(b));
  const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .@_-]{0,20}$/).map((s) => s.trim() || "acct");
  // Every other column is marked with "#~", which cannot occur in a base32 key or in a generated name.
  const other = fc.string({ minLength: 1, maxLength: 24 }).map((s) => `#~${s.replace(/[|｜\r\n]/g, "")}~#`);
  const layout = fc.constantFrom("name|key|x", "x|name|key", "name|x|key", "name|key|x|x", "x|x|name|key");

  it("for random layouts, names, keys and passwords: plan and saved vault hold names and keys, never the other columns", () => {
    fc.assert(
      fc.property(
        layout,
        fc.array(fc.tuple(name, base32, other, other), { minLength: 1, maxLength: 12 }),
        (shape, rows) => {
          const cols = shape.split("|");
          const keyColumn = cols.indexOf("key");
          const nameColumn = cols.indexOf("name");
          const lines = rows.map(([n, k, o1, o2]) => {
            const others = [o1, o2];
            return cols.map((c) => (c === "key" ? k : c === "name" ? n : others.shift()!)).join("|");
          });
          const p = plan(lines.join("\n"), { keyColumn, nameColumn });
          const text = JSON.stringify(p) + savedText(p);
          expect(text).not.toContain("#~");
          expect(text).not.toContain("~#");
          for (const [n, k] of rows) {
            expect(text).toContain(k);
            expect(text).toContain(n);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
