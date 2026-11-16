// File import, revision 3 (IMPORT-FILE-NOTES.md §10): every way a link comes in goes through the same checks, at run
// time, not only by the source's shape. The entry points: the paste box (planSettings' text), a text file
// (readImportText), a QR image and the camera (readQrTexts, which AddAccounts.tsx applies to the camera's codes), and
// a link inside an unknown JSON file. For each hostile link, each entry point must do the same thing.
import { describe, expect, it } from "vitest";
import { readImportText, readQrTexts, type FileRead } from "../../src/core/import/file-formats";
import { offerDelete, planSettings } from "../../src/core/import/file-plan";
import { applyImport } from "../../src/core/import/importer";
import { parseOtpauth } from "../../src/core/totp/otpauth";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { K1, K2, K3, K4, link } from "../helpers/import-fixtures";

const lines = (r: FileRead) => (r.kind === "accounts" ? r.lines : []);
const show = (p: ReturnType<typeof planSettings>) =>
  p.add.map((a) => `${a.issuer}|${a.label}|${a.type}|${a.algorithm}|${a.digits}|${a.period}|${a.secret}`);
const ENTRY_POINTS: [string, (text: string) => ReturnType<typeof planSettings>][] = [
  ["paste box", (t) => planSettings(t, [], [])],
  ["text file", (t) => planSettings("", lines(readImportText(`${t}\n`)), [])],
  ["QR image and camera", (t) => planSettings("", lines(readQrTexts([t])), [])],
  ["link in unknown JSON", (t) => planSettings("", lines(readImportText(JSON.stringify({ list: [t] }))), [])],
];
const each = (text: string) => ENTRY_POINTS.map(([name, run]) => [name, show(run(text))] as const);

describe("one validation path for every entry point", () => {
  it("N3: a Steam link written as TOTP (encoder=steam, %73team) is never taken, wherever it comes from", () => {
    for (const enc of ["steam", "%73team", "steam+"])
      for (const [name, got] of each(`otpauth://totp/Steam:bob?secret=${K1}&issuer=Steam&encoder=${enc}`))
        expect(got, `${name} ${enc}`).toEqual([]);
  });

  it("N1: a word after the link never joins its secret (KWORK), wherever it comes from", () => {
    // refused, or (a tab ends a column of a file's row) taken with exactly its own key: never with the word in it
    for (const tail of [" work", " MyPassword", "\tMyPassword"])
      for (const text of [`otpauth://totp/A?secret=${K1}${tail}`, `otpauth://totp/A?issuer=X&secret=${K1}${tail}`])
        for (const [name, got] of each(text)) {
          for (const g of got) expect(g, `${name}: ${JSON.stringify(tail)}`).toMatch(new RegExp(`\\|${K1}$`));
          if (tail.startsWith(" ")) expect(got, `${name}: ${JSON.stringify(tail)}`).toEqual([]);
        }
    // a space a real link writes in its key (%20, +) is no word after it
    for (const [name, got] of each(`otpauth://totp/A:a?secret=${K1.slice(0, 4)}%20${K1.slice(4)}&issuer=A`))
      expect(got, name).toEqual([`A|a|totp|SHA1|6|30|${K1}`]);
  });

  it("N5 and M2: &amp;, however many times escaped, keeps every parameter, wherever it comes from", () => {
    for (const amp of ["&amp;", "&amp;amp;", "&#38;", "&amp;#38;"]) {
      const text = `otpauth://totp/Acme:bob?secret=${K1}${amp}issuer=Acme${amp}digits=8${amp}period=60`;
      for (const [name, got] of each(text)) expect(got, `${name} ${amp}`).toEqual([`Acme|bob|totp|SHA1|8|60|${K1}`]);
    }
    const html = `<p>otpauth://totp/Acme:bob?secret=${K1}&amp;amp;issuer=Acme&amp;amp;digits=8</p>`;
    expect(show(planSettings("", lines(readImportText(html)), []))).toEqual([`Acme|bob|totp|SHA1|8|30|${K1}`]);
  });
});

describe("N2: links joined on one line are every one read", () => {
  it("by , ; | and with quotes: both accounts, with clean names", () => {
    for (const sep of [",", ", ", ";", " | ", "|", "\t"]) {
      const text = `${link("A", "a", K1)}${sep}${link("B", "b", K2)}`;
      expect(show(planSettings("", lines(readImportText(text)), [])), JSON.stringify(sep)).toEqual([
        `A|a|totp|SHA1|6|30|${K1}`,
        `B|b|totp|SHA1|6|30|${K2}`,
      ]);
    }
    const quoted = `"${link("A", "a", K1)}", "${link("B", "b", K2)}",`;
    expect(show(planSettings("", lines(readImportText(quoted)), []))).toEqual([
      `A|a|totp|SHA1|6|30|${K1}`,
      `B|b|totp|SHA1|6|30|${K2}`,
    ]);
  });

  it("a link after another column of the row is read too, never dropped", () => {
    const r = readImportText(`${link("A", "a", K1)},a note,${link("B", "b", K2)}\n`);
    expect(show(planSettings("", lines(r), []))).toEqual([`A|a|totp|SHA1|6|30|${K1}`, `B|b|totp|SHA1|6|30|${K2}`]);
  });

  it("and the delete prompt counts what was not imported", () => {
    const r = readImportText(`${link("A", "a", K1)},otpauth://steam/S:me?secret=${K2}\n`);
    if (r.kind !== "accounts") throw new Error(r.kind);
    const f = { lines: r.lines, refused: r.skipped.length + r.types.reduce((n, k) => n + k.n, 0) };
    expect(offerDelete([f], planSettings("", f.lines, []).add)).toMatchObject([{ left: 1, hotp: 0 }]);
  });
});

describe("N4: an unknown JSON file's parameters come from the entry or a sub-object named for them only", () => {
  const read = (v: unknown) => readImportText(JSON.stringify(v));
  const reasons = (r: FileRead) => (r.kind === "accounts" ? r.skipped.map((x) => x.reason) : [r.kind]);
  it("a timer of something else is no period: refused, never taken (in a list of accounts, or anywhere)", () => {
    const shapes = [
      { secret: K1, issuer: "A", sync: { interval: 300 } },
      { secret: K1, issuer: "A", wizard: { step: 3 } },
      { secret: K1, issuer: "A", digits: 8, stats: { period: 7 } },
      { secret: K1, issuer: "A", deep: { otp: { period: 60 } } },
    ];
    for (const v of [...shapes.map((x) => [x]), ...shapes.map((x) => ({ app: "x", accounts: { a: x } }))]) {
      expect(lines(read(v)), JSON.stringify(v)).toEqual([]);
      expect(reasons(read(v)), JSON.stringify(v)).toEqual(["malformed"]);
    }
  });
  it("a sub-object named for the parameters is read; an unrelated `type` neither refuses nor names a kind", () => {
    for (const home of ["otp", "totp", "info", "params", "parameters", "token"])
      for (const wrap of [(x: object) => [x], (x: object) => ({ app: "x", accounts: { a: x } })]) {
        const r = read(
          wrap({ secret: K1, issuer: "A", label: "a", [home]: { digits: 8, period: 60, algorithm: "SHA256" } }),
        );
        expect(show(planSettings("", lines(r), [])), home).toEqual([`A|a|totp|SHA256|8|60|${K1}`]);
      }
    const icon = read([{ secret: K1, issuer: "A", label: "a", icon: { type: "png", size: 3 } }]);
    expect(show(planSettings("", lines(icon), []))).toEqual([`A|a|totp|SHA1|6|30|${K1}`]);
  });
  it("a period outside 10 to 300 seconds is no TOTP period in a file of no known format", () => {
    const any = (x: object) => ({ app: "x", accounts: { a: x } });
    expect(reasons(read(any({ secret: K1, issuer: "A", period: 600 })))).toEqual(["malformed"]);
    expect(reasons(read(any({ secret: K1, issuer: "A", otp: { period: 5 } })))).toEqual(["malformed"]);
    expect(lines(read(any({ secret: K1, issuer: "A", period: 60 })))).toHaveLength(1);
    // a list of accounts (andOTP, Raivo) keeps the period its app let the user set
    expect(lines(read([{ secret: K1, issuer: "A", period: 600 }]))).toHaveLength(1);
  });
});

describe("the review's mutation gaps", () => {
  const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
  it("X04: a plain key line the importer refuses is counted as not imported", () => {
    const r = readImportText(`${K1}\n${K2}\nABCDEFG\n`); // two keys, and one too short for a key
    if (r.kind !== "accounts") throw new Error(r.kind);
    expect(r.format).toBe("plain");
    const f = { lines: r.lines, refused: 0 };
    const p = planSettings("", f.lines, []);
    expect(p.add).toHaveLength(2);
    expect(offerDelete([f], p.add)).toMatchObject([{ left: 1 }]);
  });
  it("X05: a CSV whose link column has a name no list knows is read by its cells", () => {
    for (const col of ["Link", "QR", "Code"]) {
      const r = readImportText(`Name,${col},Note\nAcme,${link("Acme", "bob", K1)},hello\n`);
      expect(show(planSettings("", lines(r), [])), col).toEqual([`Acme|bob|totp|SHA1|6|30|${K1}`]);
      // read as a CSV: its header is a header, not a line reported as "not a link"
      expect(r.kind === "accounts" && [r.format, r.skipped], col).toEqual(["csv", []]);
    }
  });
  it("X18: the prompt's HOTP count is of the HOTP accounts added, not of the file's", () => {
    const h1 = `otpauth://hotp/C:one?secret=${K3}&issuer=C&counter=1`;
    const h2 = `otpauth://hotp/C:two?secret=${K4}&issuer=C&counter=2`;
    const r = readImportText(`${h1}\n${h2}\n`);
    if (r.kind !== "accounts") throw new Error(r.kind);
    const one = parseOtpauth(h1);
    if (!one.ok) throw new Error();
    const v = applyImport(emptyVault("vault-0123456789"), [one.value], clock); // the first is already in the vault
    const p = planSettings("", r.lines, v.entries);
    expect(p.add).toHaveLength(1);
    expect(offerDelete([{ lines: r.lines, refused: 0 }], p.add)).toMatchObject([{ hotp: 1, left: 0 }]);
  });
  it("X02: a link at the end of a sentence loses the sentence's full stop, not the account", () => {
    const r = readImportText(`See otpauth://totp/A:a?issuer=A&secret=${K1}.\n`);
    expect(show(planSettings("", lines(r), []))).toEqual([`A|a|totp|SHA1|6|30|${K1}`]);
  });
});
