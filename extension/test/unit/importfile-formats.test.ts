// File import (IMPORT-FILE-NOTES.md §3): every format the reader recognises, read from synthetic files shaped like the
// apps' own, and what it must not do: open an encrypted export, take a Steam/mOTP/Yandex account for a TOTP, take a
// HOTP account for a TOTP, read a password column, echo a secret, or take unbounded time on adversarial input.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_ACCOUNTS,
  MAX_DEPTH,
  readImportText,
  readQrTexts,
  encryptedByName,
  type FileRead,
} from "../../src/core/import/file-formats";
import { planImport } from "../../src/core/import/importer";
import { encodeBase32 } from "../../src/core/totp/base32";
import {
  AEGIS_ENCRYPTED,
  aegisEntry,
  aegisPlain,
  andotp,
  andotpEntry,
  BITWARDEN_ENCRYPTED,
  BITWARDEN_PASSWORD,
  bitwarden,
  bitwardenItem,
  ENTE_ENCRYPTED,
  freeotpPlus,
  freeotpToken,
  K1,
  K2,
  K3,
  K4,
  key,
  link,
  migration,
  proton,
  PROTON_ENCRYPTED,
  raivoEntry,
  SAMPLE_LIST,
  TWOFAS_ENCRYPTED,
  twofas,
  twofasService,
} from "../helpers/import-fixtures";

type Accounts = Extract<FileRead, { kind: "accounts" }>;
function accounts(r: FileRead): Accounts {
  if (r.kind !== "accounts") throw new Error(`expected accounts, got ${r.kind}`);
  return r;
}
/** What the importer makes of the lines a file gave: issuer/label/type/params, in order. */
const added = (r: FileRead) =>
  planImport(accounts(r).lines.join("\n"), []).plan.add.map(
    (p) =>
      `${p.issuer}|${p.label}|${p.type}|${p.algorithm}|${p.digits}|${p.period}${p.counter !== undefined ? `|c${p.counter}` : ""}`,
  );
const secrets = (r: FileRead) => planImport(accounts(r).lines.join("\n"), []).plan.add.map((p) => p.secret);

describe("lists of otpauth:// links", () => {
  it("the owner's shape: ten links, one per line, all taken in order", () => {
    const r = accounts(readImportText(SAMPLE_LIST));
    expect(r.format).toBe("links");
    expect(r.lines).toHaveLength(10);
    expect(r.skipped).toEqual([]);
    expect(added(r)[0]).toBe("Service 1|user1@example.com|totp|SHA1|6|30");
    expect(added(r)[9]).toBe("Service 10|user10@example.com|totp|SHA1|6|30");
  });

  it("CRLF, CR, blank lines, comments, surrounding quotes, trailing commas and a JSON-ish frame are tolerated", () => {
    const text = [
      "# exported by some app",
      "// another comment",
      "",
      `"${link("A", "a", K1)}",`,
      `'${link("B", "b", K2)}';`,
      "[",
      `  ${link("C", "c", K3)},`,
      "]",
      `GitHub: ${link("D", "d", K4)}`,
    ].join("\r\n");
    const r = accounts(readImportText(text.replace("\r\n[", "\r[")));
    expect(added(r).map((a) => a.split("|")[0])).toEqual(["A", "B", "C", "D"]);
    expect(r.skipped).toEqual([]);
  });

  it("a mix of otpauth:// and otpauth-migration:// lines, and run-together links", () => {
    const m = migration([{ seed: 7, name: "Example:alice", issuer: "Example" }], { size: 1, index: 0, id: 42 });
    const r = accounts(readImportText(`${link("A", "a", K1)}${link("B", "b", K2)}\n${m}\n`));
    expect(r.lines).toHaveLength(3);
    expect(added(r)).toEqual(["A|a|totp|SHA1|6|30", "B|b|totp|SHA1|6|30", "Example|alice|totp|SHA1|6|30"]);
  });

  it("a link inside a table row is cut at the separator, so another column (a password) never joins it", () => {
    const r = accounts(readImportText(`${link("A", "a", K1)},Hunter2-Correct!Horse\nB|${link("B", "b", K2)}|pw2`));
    expect(added(r)).toEqual(["A|a|totp|SHA1|6|30", "B|b|totp|SHA1|6|30"]);
    expect(JSON.stringify(r)).not.toContain("Hunter2");
  });

  it("lines that cannot be read are reported by line number and name, never with their key", () => {
    const bad = `otpauth://totp/Bank:me?secret=NOT*BASE32&issuer=Bank`;
    const r = accounts(readImportText(`${link("A", "a", K1)}\nhello world\n${bad}\notpauth://totp/X?issuer=X`));
    expect(r.lines).toHaveLength(1);
    expect(r.skipped).toEqual([
      { at: 2, name: "", reason: "not_otpauth" },
      { at: 3, name: "Bank (me)", reason: "invalid_secret" },
      { at: 4, name: "X", reason: "missing_secret" },
    ]);
    expect(JSON.stringify(r.skipped)).not.toContain("NOT*BASE32");
  });

  it("Steam, mOTP and Yandex links are counted by kind and never taken; HOTP is kept as HOTP", () => {
    const text = [
      `otpauth://steam/Steam:me?secret=${K1}&issuer=Steam`,
      `otpauth://totp/Steam:you?secret=${K2}&issuer=Steam&encoder=steam`,
      `steam://${K3}`,
      `otpauth://motp/M:me?secret=${K3}`,
      `otpauth://yandex/Y:me?secret=${K3}`,
      `otpauth://hotp/Counter:bob?secret=${K4}&issuer=Counter&counter=7`,
    ].join("\n");
    const r = accounts(readImportText(text));
    expect(r.types).toEqual([
      { type: "Steam", n: 3 },
      { type: "mOTP", n: 1 },
      { type: "Yandex", n: 1 },
    ]);
    expect(added(r)).toEqual(["Counter|bob|hotp|SHA1|6|30|c7"]);
  });

  it("an unknown kind that does not read as a short name is reported as an unsupported type, not echoed", () => {
    const r = accounts(readImportText(`otpauth://${K1}${K1}/x?secret=${K2}`));
    expect(r.types).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["unsupported_type"]);
  });

  it("a Google Authenticator export link that cannot be read is reported", () => {
    const r = accounts(readImportText(`otpauth-migration://offline?data=%%%`));
    expect(r.skipped).toEqual([{ at: 1, name: "", reason: "malformed" }]);
  });

  it("an empty file, or one of comments only, holds nothing", () => {
    expect(readImportText("")).toEqual({ kind: "nothing" });
    expect(readImportText("\n\n# nothing here\n")).toEqual({ kind: "nothing" });
    expect(readImportText("just some notes\nabout nothing")).toEqual({ kind: "nothing" });
  });

  it("plain key lines go to the paste box's own rules (a key alone, or name|key)", () => {
    const r = accounts(readImportText(`GitHub|${K1}\n${K2}\n`));
    expect(r.format).toBe("plain");
    expect(planImport(r.lines.join("\n"), []).plan.add).toHaveLength(2);
  });
});

describe("JSON exports", () => {
  it("Aegis, unencrypted: TOTP and HOTP taken with their parameters, Steam/mOTP/Yandex counted, notes and icons ignored", () => {
    const r = accounts(
      readImportText(
        aegisPlain([
          aegisEntry({ name: "alice", issuer: "GitHub", secret: K1 }),
          aegisEntry({ name: "ops", issuer: "AWS", secret: K2, info: { algo: "SHA256", digits: 8, period: 60 } }),
          aegisEntry({ type: "hotp", name: "bob", issuer: "Counter", secret: K3, info: { counter: 12 } }),
          aegisEntry({ type: "steam", name: "me", issuer: "Steam", secret: K4, info: { digits: 5 } }),
          aegisEntry({ type: "motp", name: "m", issuer: "M", secret: K4, info: { pin: "1234", algo: "MD5" } }),
          aegisEntry({ type: "yandex", name: "y", issuer: "Y", secret: K4, info: { pin: "1234" } }),
        ]),
      ),
    );
    expect(r.format).toBe("aegis");
    expect(added(r)).toEqual([
      "GitHub|alice|totp|SHA1|6|30",
      "AWS|ops|totp|SHA256|8|60",
      "Counter|bob|hotp|SHA1|6|30|c12",
    ]);
    expect(r.types).toEqual([
      { type: "Steam", n: 1 },
      { type: "mOTP", n: 1 },
      { type: "Yandex", n: 1 },
    ]);
    expect(JSON.stringify(r)).not.toContain("never imported");
  });

  it("Aegis, encrypted, is recognised and not opened", () => {
    expect(readImportText(AEGIS_ENCRYPTED)).toEqual({ kind: "encrypted", app: "Aegis" });
  });

  it("2FAS, unencrypted: service name as issuer, otp.account as account, tokenType spelled in capitals", () => {
    const r = accounts(
      readImportText(
        twofas([
          twofasService({ name: "GitHub", account: "alice", secret: K1 }),
          twofasService({
            name: "Counter",
            account: "bob",
            secret: K2,
            otp: { tokenType: "HOTP", period: undefined, counter: 3 },
          }),
          twofasService({ name: "Steam", account: "me", secret: K3, otp: { tokenType: "STEAM" } }),
          twofasService({ name: "Old", account: "x", secret: K4, otp: { tokenType: null } }),
        ]),
      ),
    );
    expect(r.format).toBe("2fas");
    expect(added(r)).toEqual(["GitHub|alice|totp|SHA1|6|30", "Counter|bob|hotp|SHA1|6|30|c3", "Old|x|totp|SHA1|6|30"]);
    expect(r.types).toEqual([{ type: "Steam", n: 1 }]);
  });

  it("2FAS, encrypted (servicesEncrypted), is recognised and not opened", () => {
    expect(readImportText(TWOFAS_ENCRYPTED)).toEqual({ kind: "encrypted", app: "2FAS" });
  });

  it("andOTP, plain: a bare array; padding in the key is fine; STEAM and MOTP counted", () => {
    const r = accounts(
      readImportText(
        andotp([
          andotpEntry({ issuer: "GitHub", label: "alice", secret: `${K1}====` }),
          andotpEntry({ issuer: "Counter", label: "bob", secret: K2, type: "HOTP", extra: { counter: 9 } }),
          andotpEntry({ issuer: "Steam", label: "me", secret: K3, type: "STEAM" }),
          andotpEntry({ issuer: "M", label: "m", secret: K3, type: "MOTP" }),
        ]),
      ),
    );
    expect(r.format).toBe("andotp");
    expect(added(r)).toEqual(["GitHub|alice|totp|SHA1|6|30", "Counter|bob|hotp|SHA1|6|30|c9"]);
    expect(r.types).toEqual([
      { type: "Steam", n: 1 },
      { type: "mOTP", n: 1 },
    ]);
  });

  it("andOTP, encrypted (.json.aes, binary): named by its file name only", () => {
    expect(encryptedByName("otp_accounts_2026-10-20.json.aes")).toBe("andOTP");
    expect(encryptedByName("otp_accounts.json")).toBeNull();
  });

  it("Raivo (the JSON inside its ZIP): every value a string; 7 digits is reported, not taken", () => {
    const r = accounts(
      readImportText(
        JSON.stringify([
          raivoEntry({ issuer: "GitHub", account: "alice", secret: K1 }),
          raivoEntry({ issuer: "Odd", account: "x", secret: K2, digits: "7" }),
          raivoEntry({ issuer: "Counter", account: "bob", secret: K3, kind: "HOTP" }),
        ]),
      ),
    );
    expect(r.format).toBe("raivo");
    expect(added(r)).toEqual(["GitHub|alice|totp|SHA1|6|30", "Counter|bob|hotp|SHA1|6|30|c0"]);
    expect(r.skipped).toEqual([{ at: 2, name: "Odd (x)", reason: "unsupported_digits" }]);
  });

  it("Bitwarden, unencrypted JSON: only login.totp is read (a link, a bare key, or steam://), never the password", () => {
    const r = accounts(
      readImportText(
        bitwarden([
          bitwardenItem("GitHub", "alice", link("GitHub", "alice", K1)),
          bitwardenItem("Bank", "me", K2.toLowerCase()),
          bitwardenItem("Steam", "me", `steam://${K3}`),
          bitwardenItem("Mail", "me", null),
          { type: 2, name: "a secure note", notes: "nothing" },
        ]),
      ),
    );
    expect(r.format).toBe("bitwarden");
    expect(added(r)).toEqual(["GitHub|alice|totp|SHA1|6|30", "Bank|me|totp|SHA1|6|30"]);
    expect(r.types).toEqual([{ type: "Steam", n: 1 }]);
    expect(r.skipped).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("Hunter2");
  });

  it("Bitwarden, encrypted (account key or password protected), is recognised and not opened", () => {
    expect(readImportText(BITWARDEN_ENCRYPTED)).toEqual({ kind: "encrypted", app: "Bitwarden" });
    expect(readImportText(BITWARDEN_PASSWORD)).toEqual({ kind: "encrypted", app: "Bitwarden" });
  });

  it("FreeOTP+: the key as signed bytes; a Steam token (by its issuer) counted", () => {
    const bytes = Array.from({ length: 20 }, (_, i) => (i * 37 + 200) & 0xff);
    const r = accounts(
      readImportText(
        freeotpPlus([
          freeotpToken({ issuer: "GitHub", label: "alice", bytes }),
          freeotpToken({ issuer: "Counter", label: "bob", bytes, type: "HOTP", counter: 5 }),
          freeotpToken({ issuer: "Steam", label: "me", bytes }),
        ]),
      ),
    );
    expect(r.format).toBe("freeotp");
    expect(added(r)).toEqual(["GitHub|alice|totp|SHA1|6|30", "Counter|bob|hotp|SHA1|6|30|c5"]);
    expect(secrets(r)[0]).toBe(encodeBase32(Uint8Array.from(bytes))); // the bytes, not the signed list
    expect(r.types).toEqual([{ type: "Steam", n: 1 }]);
  });

  it("Proton Authenticator: content.uri links; Steam entries counted; the encrypted form recognised", () => {
    const r = accounts(
      readImportText(
        proton([
          { uri: link("GitHub", "alice", K1), name: "GitHub" },
          { uri: `steam://${K2}`, name: "Steam", type: "Steam" },
        ]),
      ),
    );
    expect(r.format).toBe("proton");
    expect(added(r)).toEqual(["GitHub|alice|totp|SHA1|6|30"]);
    expect(r.types).toEqual([{ type: "Steam", n: 1 }]);
    expect(readImportText(PROTON_ENCRYPTED)).toEqual({ kind: "encrypted", app: "Proton Authenticator" });
  });

  it("Ente Auth's encrypted export and an OpenPGP message are recognised and not opened", () => {
    expect(readImportText(ENTE_ENCRYPTED)).toEqual({ kind: "encrypted", app: "Ente Auth" });
    expect(readImportText("-----BEGIN PGP MESSAGE-----\n\nhQEMA\n-----END PGP MESSAGE-----\n")).toEqual({
      kind: "encrypted",
      app: "andOTP (OpenPGP)",
    });
  });

  it("a Sixkey backup is left to the Backup section", () => {
    expect(readImportText(JSON.stringify({ format: "sixkey-backup", v: 1, created: 1, ciphertext: "x" }))).toEqual({
      kind: "sixkey_backup",
    });
  });

  it("any other JSON: otpauth:// strings anywhere, and objects with a key-shaped secret", () => {
    const r = accounts(
      readImportText(
        JSON.stringify({
          app: "Something",
          vaults: [{ entries: [{ uri: link("A", "a", K1) }, { data: { otp: link("B", "b", K2) } }] }],
          extra: [{ secret: K3, issuer: "C", account: "c", digits: "8" }],
          config: { secret: "hunter2", apiKey: "x" }, // a password-like "secret" is not taken for a key
        }),
      ),
    );
    expect(r.format).toBe("json");
    expect(added(r).sort()).toEqual(["A|a|totp|SHA1|6|30", "B|b|totp|SHA1|6|30", "C|c|totp|SHA1|8|30"]);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("JSON with no accounts holds nothing; JSON that does not parse is read as text", () => {
    expect(readImportText(JSON.stringify({ hello: "world", list: [1, 2, 3] }))).toEqual({ kind: "nothing" });
    const r = accounts(readImportText(`[${link("A", "a", K1)}`)); // not JSON: a link list with a stray bracket
    expect(r.lines).toHaveLength(1);
  });
});

describe("CSV", () => {
  it("Bitwarden's CSV: only login_totp, name and login_username are read; the password column never", () => {
    const csv = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      `,1,login,GitHub,,,0,https://github.com,alice,Hunter2-Correct!Horse,${link("GitHub", "alice", K1)}`,
      `,,login,Bank,"a note, with a comma",,0,https://bank.example,me,Hunter2-Two,${K2}`,
      ",,login,Mail,,,0,https://mail.example,me,Hunter2-Three,",
      `,,note,Secure note,"multi`,
      `line",,0,,,,`,
    ].join("\r\n");
    const r = accounts(readImportText(csv));
    expect(r.format).toBe("csv");
    expect(added(r)).toEqual(["GitHub|alice|totp|SHA1|6|30", "Bank|me|totp|SHA1|6|30"]);
    expect(JSON.stringify(r)).not.toContain("Hunter2");
  });

  it("a generic CSV with issuer, account, secret, digits and period columns, and semicolons", () => {
    const csv = `Issuer;Account;Secret;Digits;Period\nAWS;root;${K1};8;60\nBad;x;not base32!;6;30\n`;
    const r = accounts(readImportText(csv));
    expect(added(r)).toEqual(["AWS|root|totp|SHA1|8|60"]);
    expect(r.skipped).toEqual([{ at: 3, name: "Bad (x)", reason: "invalid_secret" }]);
  });

  it("a CSV without a link or secret column is not read as CSV", () => {
    expect(readImportText("name,email\nalice,a@example.com\n")).toEqual({ kind: "nothing" });
  });
});

describe("QR codes read from an image", () => {
  it("each text is one code: links and export codes taken, anything else reported", () => {
    const m = migration([{ seed: 1, name: "a", issuer: "A" }], { size: 1, index: 0, id: 1 });
    const r = accounts(readQrTexts([link("A", "a", K1), m, "https://example.com/not-a-code"]));
    expect(r.lines).toHaveLength(2);
    expect(r.skipped).toEqual([{ at: 3, name: "", reason: "not_otpauth" }]);
  });
});

describe("bounded and never throwing", () => {
  it("nesting deeper than MAX_DEPTH is not parsed (a JSON bomb holds nothing)", () => {
    const bomb = "[".repeat(100_000) + "]".repeat(100_000);
    const t0 = performance.now();
    expect(readImportText(bomb)).toEqual({ kind: "nothing" });
    const ok = "[".repeat(MAX_DEPTH) + JSON.stringify(link("A", "a", K1)) + "]".repeat(MAX_DEPTH);
    expect(accounts(readImportText(ok)).lines).toHaveLength(1);
    // one level deeper is refused before it is parsed, even though the parser itself would cope with it
    const deeper = "[".repeat(MAX_DEPTH + 1) + JSON.stringify(link("A", "a", K1)) + "]".repeat(MAX_DEPTH + 1);
    expect(readImportText(deeper)).toEqual({ kind: "nothing" });
    // brackets inside strings do not count
    expect(
      accounts(readImportText(JSON.stringify([{ uri: link("A", "a", K1), note: "[".repeat(500) }]))).lines,
    ).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("100,000 lines of garbage are read in bounded time: plain lines over the cap are too large", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `garbage line ${i} otp`).join("\n");
    const t0 = performance.now();
    expect(readImportText(text)).toEqual({ kind: "too_large" });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("one link among 100,000 garbage lines: taken, the rest reported by number only, the report capped", () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `garbage line ${i}`);
    lines[50_000] = link("A", "a", K1);
    const t0 = performance.now();
    const r = accounts(readImportText(lines.join("\r\n")));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.lines).toHaveLength(1);
    expect(r.skipped).toHaveLength(MAX_ACCOUNTS);
    expect(r.skipped.every((s) => s.name === "" && s.reason === "not_otpauth")).toBe(true);
  });

  it("more lines than the cap, or more accounts than the vault holds, is too large", () => {
    expect(readImportText("\n".repeat(250_000) + link("A", "a", K1))).toEqual({ kind: "too_large" });
    const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => link("A", `a${i}`, key(i))).join("\n");
    expect(readImportText(many)).toEqual({ kind: "too_large" });
  });

  it("a huge single line is skipped unread", () => {
    const r = accounts(readImportText(`otpauth://totp/A?secret=${"A".repeat(400_000)}\n${link("B", "b", K2)}`));
    expect(r.lines).toHaveLength(1);
    expect(r.skipped).toEqual([{ at: 1, name: "", reason: "too_long" }]);
  });

  it("never throws on arbitrary text, JSON or bytes decoded as text", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 400 }),
          fc.json({ maxDepth: 6 }),
          fc
            .array(
              fc.constantFrom(
                "otpauth://",
                "totp/",
                "?secret=",
                K1,
                "&",
                "=",
                "%",
                "\n",
                ",",
                '"',
                "{",
                "[",
                "otpauth-migration://offline?data=",
              ),
              { maxLength: 40 },
            )
            .map((a) => a.join("")),
        ),
        (s) => {
          const r = readImportText(s);
          expect(["accounts", "encrypted", "sixkey_backup", "too_large", "nothing"]).toContain(r.kind);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("a secret is never echoed", () => {
  // The canary goes into secret fields only. Wherever it could leak (a reason, a name, a type, a skip record), it must
  // not appear; it may appear only inside the checked links themselves, which are the accounts.
  const CANARY = "CANARYCANARYCANARYQ";
  const BAD_CANARY = "CANARY*SECRET*1"; // not base32: always a failure, so it can only leak through a report
  const shapes = (s: string): string[] => [
    `otpauth://totp/A:a?secret=${s}&issuer=A`,
    `otpauth://totp/A:a?secret=${s}&issuer=A&digits=7`,
    `otpauth://totp/A:a?secret=${s}&issuer=A&algorithm=MD5`,
    `otpauth://hotp/A:a?secret=${s}&issuer=A`,
    aegisPlain([
      aegisEntry({ name: "a", issuer: "A", secret: s }),
      aegisEntry({ type: "steam", name: "s", issuer: "S", secret: s }),
    ]),
    twofas([twofasService({ name: "A", account: "a", secret: s, otp: { digits: 9 } })]),
    andotp([andotpEntry({ issuer: "A", label: "a", secret: s, extra: { period: -1 } })]),
    JSON.stringify([raivoEntry({ issuer: "A", account: "a", secret: s, digits: "5" })]),
    bitwarden([bitwardenItem("A", "a", s), bitwardenItem("B", "b", `otpauth://totp/B?secret=${s}&algorithm=MD4`)]),
    `issuer,account,secret,digits\nA,a,${s},7\n`,
    JSON.stringify({ deep: { deeper: [{ secret: s, issuer: "A", period: "x" }] } }),
  ];
  const reports = (r: FileRead) =>
    JSON.stringify(r.kind === "accounts" ? { skipped: r.skipped, types: r.types, format: r.format } : r);

  it("not in a skip record, a type or a verdict, for every shape and failure", () => {
    for (const s of [CANARY, BAD_CANARY, CANARY.toLowerCase()])
      for (const text of shapes(s)) {
        const r = readImportText(text);
        expect(reports(r), text.slice(0, 60)).not.toMatch(/CANARY/i);
      }
  });

  it("property: arbitrary names and parameters never carry a canary key into a report", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }).filter((s) => !/canary/i.test(s)),
        fc.string({ maxLength: 20 }).filter((s) => !/canary/i.test(s)),
        fc.constantFrom("6", "7", "8", "x", ""),
        fc.constantFrom("SHA1", "MD5", "SHA256", ""),
        fc.constantFrom("totp", "hotp", "steam", "weird", ""),
        (issuer, label, digits, algo, type) => {
          const text = JSON.stringify([{ secret: BAD_CANARY, issuer, label, digits, algorithm: algo, type }]);
          expect(reports(readImportText(text))).not.toMatch(/CANARY/i);
          const good = JSON.stringify([{ secret: CANARY, issuer, label, digits, algorithm: algo, type }]);
          expect(reports(readImportText(good))).not.toMatch(/CANARY/i);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---- review r2 (IMPORTFILE-REVIEW.md): the cases it found, as assertions ----------------------------------------------

/** What the paste box makes of the same text: the reference a file must equal. */
const pasted = (text: string) =>
  planImport(text, []).plan.add.map(
    (p) =>
      `${p.issuer}|${p.label}|${p.type}|${p.algorithm}|${p.digits}|${p.period}${p.counter !== undefined ? `|c${p.counter}` : ""}`,
  );

describe("B1/M1: a line that is a link is taken whole, as the paste box takes it; a link cut short is refused", () => {
  const q = (issuer: string) =>
    `otpauth://totp/bob%40example.com?secret=${K1}&issuer=${issuer}&digits=8&period=60&algorithm=SHA256`;

  it("an issuer with ' , ; | or a raw space keeps every parameter after it", () => {
    for (const issuer of [
      "Lowe's",
      "Acme,%20Inc",
      "A;B",
      "Ben%20&%20Jerry's".replace("&", "%26"),
      "Ben Jerry",
      "Pipe|Co",
    ]) {
      const line = q(issuer);
      const r = readImportText(`${line}\n`);
      const got = r.kind === "accounts" ? added(r) : [];
      const want = pasted(line);
      // the same as the paste box, and never 6 digits and 30 s
      expect(got, issuer).toEqual(want);
      for (const g of got) expect(g, issuer).toMatch(/\|SHA256\|8\|60$/);
    }
  });

  it("quoted and comma-ended list lines are the same as bare ones", () => {
    const line = q("Lowe's");
    for (const framed of [`"${line}",`, `'${line}';`, `\`${line}\``, `  ${line}  ,`])
      expect(added(readImportText(framed)), framed).toEqual(pasted(line));
  });

  it("a table cell after a whole-line link is cut off only when it does not carry on the query", () => {
    const r = accounts(readImportText(`${q("Acme")},Hunter2-Correct!Horse\n${q("Beta")}|note\n`));
    expect(added(r)).toEqual(["Acme|bob@example.com|totp|SHA256|8|60", "Beta|bob@example.com|totp|SHA256|8|60"]);
    expect(JSON.stringify(r)).not.toContain("Hunter2");
  });

  it("a link inside a sentence or row, cut where parameters follow, is refused, never imported with the defaults", () => {
    const r = accounts(
      readImportText(
        [
          `GitHub: otpauth://totp/A?secret=${K1}&issuer=Ben & Jerry's&digits=8&period=60`,
          `Name,otpauth://totp/B?secret=${K2}&issuer=B,Hunter2`,
          `<a href="otpauth://totp/C?secret=${K3}&amp;issuer=C&amp;digits=8">C</a>`,
        ].join("\n"),
      ),
    );
    expect(r.skipped).toEqual([{ at: 1, name: "Ben (A)", reason: "malformed" }]);
    expect(added(r)).toEqual(["B|B|totp|SHA1|6|30", "C|C|totp|SHA1|8|30"]);
  });

  it("Sixkey's own plain export round-trips through Choose file: names with ' & , | and every parameter", async () => {
    const { applyImport, exportOtpauthList } = await import("../../src/core/import/importer");
    const { emptyVault } = await import("../../src/core/vault/model");
    const { createClock } = await import("../../src/core/vault/hlc");
    const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
    const accts = [
      { issuer: "Lowe's", label: "bob@example.com", algorithm: "SHA1", digits: 6, period: 30 },
      { issuer: "Macy's", label: "o'brien", algorithm: "SHA256", digits: 8, period: 60 },
      { issuer: "Ben & Jerry's", label: "a, b; c | d", algorithm: "SHA512", digits: 8, period: 45 },
      { issuer: "", label: "no issuer: colon", algorithm: "SHA1", digits: 6, period: 30 },
    ] as const;
    const v = applyImport(
      emptyVault("vault-0123456789"),
      accts.map((a, i) => ({ type: "totp" as const, secret: key(200 + i), ...a })),
      clock,
    );
    const r = accounts(readImportText(exportOtpauthList(v)));
    expect(r.skipped).toEqual([]);
    expect(added(r)).toEqual(accts.map((a) => `${a.issuer}|${a.label}|totp|${a.algorithm}|${a.digits}|${a.period}`));
    expect(secrets(r)).toEqual(accts.map((_, i) => key(200 + i)));
  });
});

describe("M2: &amp; links, and web page exports", () => {
  it("&amp; (and &#38; &#x26;) between parameters is read as &", () => {
    const amp = `otpauth://totp/Acme:bob?secret=${K1}&amp;issuer=Acme&amp;digits=8&#38;period=60&#x26;algorithm=SHA256`;
    expect(added(readImportText(`${amp}\n`))).toEqual(["Acme|bob|totp|SHA256|8|60"]);
    expect(added(readImportText(`<p><a href="${amp}">Acme</a></p>`))).toEqual(["Acme|bob|totp|SHA256|8|60"]);
  });

  it("a web page export holds pictures only (Ente's, Raivo's): said so, not 'no accounts'", () => {
    const ente = `<!DOCTYPE html>\n<html><head><title>Ente Auth</title></head><body><table><tr><td><img src="data:image/png;base64,iVBORw0KGgo="></td></tr></table></body></html>`;
    expect(readImportText(ente)).toEqual({ kind: "html" });
    expect(readImportText(`<html lang="en"><body><img src="qr.png"></body></html>`)).toEqual({ kind: "html" });
  });
});

describe("M3: a parameter that is there but cannot be read refuses the entry", () => {
  it("true, [8], 1e400, an object, a list: refused as unreadable, never SHA1/6/30", () => {
    for (const info of [{ digits: true }, { digits: [8] }, { period: { s: 60 } }, { algo: ["SHA256"] }]) {
      const r = accounts(readImportText(aegisPlain([aegisEntry({ name: "a", issuer: "A", secret: K1, info })])));
      expect(r.lines, JSON.stringify(info)).toEqual([]);
      expect(r.skipped, JSON.stringify(info)).toEqual([{ at: 1, name: "A", reason: "malformed" }]);
    }
    const inf = accounts(readImportText(`[{"secret":"${K1}","issuer":"A","label":"a","digits":1e400}]`));
    expect(inf.skipped.map((x) => x.reason)).toEqual(["malformed"]);
  });

  it("null and absent take the format's default (2FAS writes algorithm: null for SHA-1)", () => {
    const r = accounts(
      readImportText(twofas([twofasService({ name: "A", account: "a", secret: K1, otp: { algorithm: null } })])),
    );
    expect(added(r)).toEqual(["A|a|totp|SHA1|6|30"]);
  });

  it("any other JSON: parameters in a sub-object are read from there; in two places that differ, or deeper, refused", () => {
    const one = accounts(
      readImportText(
        JSON.stringify([
          {
            id: 1,
            entry: { secret: K1, issuer: "A", label: "a", otp: { digits: 8, period: 60, algorithm: "SHA256" } },
          },
        ]),
      ),
    );
    expect(one.format).toBe("json");
    expect(added(one)).toEqual(["A|a|totp|SHA256|8|60"]);
    const clash = accounts(
      readImportText(JSON.stringify({ x: { secret: K1, issuer: "A", digits: 6, otp: { digits: 8 } } })),
    );
    expect(clash.skipped.map((x) => x.reason)).toEqual(["malformed"]);
    const deep = accounts(readImportText(JSON.stringify({ x: { secret: K1, issuer: "A", a: { b: { period: 60 } } } })));
    expect(deep.skipped.map((x) => x.reason)).toEqual(["malformed"]);
  });

  it("a 2FAS file without schemaVersion is still read as 2FAS, with its parameters", () => {
    const svc = twofasService({
      name: "Acme",
      account: "bob",
      secret: K1,
      otp: { digits: 8, period: 60, algorithm: "SHA256" },
    });
    const r = accounts(readImportText(JSON.stringify({ services: [svc], groups: [] })));
    expect(r.format).toBe("2fas");
    expect(added(r)).toEqual(["Acme|bob|totp|SHA256|8|60"]);
  });

  it("every format's own parameters reach the account (not only the defaults)", () => {
    expect(
      added(
        readImportText(
          twofas([
            twofasService({ name: "T", account: "t", secret: K1, otp: { period: 60, digits: 8, algorithm: "SHA256" } }),
          ]),
        ),
      ),
    ).toEqual(["T|t|totp|SHA256|8|60"]);
    expect(
      added(
        readImportText(
          JSON.stringify([
            { ...raivoEntry({ issuer: "R", account: "r", secret: K1 }), timer: "60", algorithm: "SHA512", digits: "8" },
          ]),
        ),
      ),
    ).toEqual(["R|r|totp|SHA512|8|60"]);
    const bytes = Array.from({ length: 20 }, (_, i) => i * 11);
    expect(
      added(
        readImportText(
          freeotpPlus([{ ...freeotpToken({ issuer: "F", label: "f", bytes }), algo: "SHA256", digits: 8, period: 60 }]),
        ),
      ),
    ).toEqual(["F|f|totp|SHA256|8|60"]);
    expect(
      added(
        readImportText(
          andotp([
            andotpEntry({ issuer: "N", label: "n", secret: K1, extra: { period: 60, digits: 8, algorithm: "SHA512" } }),
          ]),
        ),
      ),
    ).toEqual(["N|n|totp|SHA512|8|60"]);
  });
});

describe("M4: password-manager CSVs, by their TOTP column, never the website column", () => {
  const otp = link("Acme", "bob", K1);
  it("KeePassXC: TOTP holds a link; a row without a URL is read too", () => {
    const csv = `"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n"Root","Acme","bob","Hunter2-Correct!Horse","https://acme.example","","${otp}","0","",""\n"Root","NoUrl","al","Hunter2-Two","","","${link("NoUrl", "al", K2)}","0","",""\n"Root","Plain","x","Hunter2-Three","https://x.example","","","0","",""`;
    const r = accounts(readImportText(csv));
    expect(added(r)).toEqual(["Acme|bob|totp|SHA1|6|30", "NoUrl|al|totp|SHA1|6|30"]);
    expect(r.skipped).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("Hunter2");
  });
  it("LastPass: totp holds a bare key; name and username name it", () => {
    const csv = `url,username,password,totp,extra,name,grouping,fav\nhttps://acme.example,bob,Hunter2-Correct!Horse,${K1.toLowerCase()},,Acme,,0\nhttps://x.example,x,pw,,,X,,0\n`;
    expect(added(readImportText(csv))).toEqual(["Acme|bob|totp|SHA1|6|30"]);
  });
  it("Proton Pass: totp holds a link; the email names the account when the username is empty", () => {
    const csv = `name,url,email,username,password,note,totp,createTime,modifyTime,vault\nAcme,https://acme.example,bob@example.com,,Hunter2,,${link("Acme", "bob@example.com", K1)},1,1,Personal\n`;
    expect(added(readImportText(csv))).toEqual(["Acme|bob@example.com|totp|SHA1|6|30"]);
  });
  it("Dashlane: otpSecret holds a key or a link", () => {
    const csv = `username,username2,username3,title,password,note,url,category,otpSecret\nbob,,,Acme,Hunter2,,https://acme.example,,${K1}\nal,,,Beta,Hunter2,,https://b.example,,${link("Beta", "al", K2, "&digits=8").replace("&digits=6", "")}\n`;
    expect(added(readImportText(csv))).toEqual(["Acme|bob|totp|SHA1|6|30", "Beta|al|totp|SHA1|8|30"]);
  });
  it("1Password: the OTPAuth column, whose header names it", () => {
    const csv = `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nAcme,https://acme.example,bob,Hunter2,${otp},false,false,,\n`;
    expect(added(readImportText(csv))).toEqual(["Acme|bob|totp|SHA1|6|30"]);
  });
  it("a CSV secret that is no key is never echoed as the account's name", () => {
    const r = accounts(readImportText(`issuer,secret\nAcme,CANARY*NOT*BASE32\n,CANARY*TWO*X\n`));
    expect(r.skipped.map((x) => x.reason)).toEqual(["invalid_secret", "invalid_secret"]);
    expect(JSON.stringify(r)).not.toMatch(/CANARY/);
  });
});

describe("M5 and the bounds: no scan is quadratic", () => {
  it("a 5 MiB single line, and 300,000 closing brackets inside the line cap, take milliseconds", () => {
    const cases = [
      "x".repeat(5 * 1024 * 1024),
      `otpauth://totp/A?secret=${")".repeat(300_000)}a`,
      `see otpauth://totp/A?secret=${")".repeat(300_000)}a b`,
      `otpauth://totp/A?secret=${K1}${",".repeat(300_000)}a`,
      `${"otpauth:// ".repeat(25_000)}`,
      `x ${"&a".repeat(150_000)}`,
    ];
    for (const c of cases) {
      const t0 = performance.now();
      readImportText(c);
      expect(performance.now() - t0, c.slice(0, 30)).toBeLessThan(1000);
    }
  });
});

describe("minor findings", () => {
  it("a lone surrogate in a name neither throws nor breaks the account", () => {
    const r = accounts(readImportText(`[{"secret":"${K1}","issuer":"\\ud800A","label":"b\\udc00"}]`));
    expect(added(r)).toEqual(["�A|b�|totp|SHA1|6|30"]);
    expect(() => readImportText(`otpauth://totp/%ED%A0%80?secret=${K1}`)).not.toThrow();
  });
  it("Steam by its encoder parameter, however it is spelled", () => {
    for (const enc of ["steam", "%73team", "steam+", "STEAM"]) {
      const r = accounts(readImportText(`otpauth://totp/S:me?secret=${K1}&issuer=S&encoder=${enc}\n`));
      expect(r.types, enc).toEqual([{ type: "Steam", n: 1 }]);
      expect(r.lines, enc).toEqual([]);
    }
  });
  it("an Aegis motp:// line is counted as mOTP, not 'not a link'", () => {
    expect(accounts(readImportText(`motp://M:me?secret=${K1}&pin=1234\n`)).types).toEqual([{ type: "mOTP", n: 1 }]);
  });
});
