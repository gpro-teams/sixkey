// File import (IMPORT-FILE-NOTES.md §6): the Add account plan over the paste box and the files read. Duplicates come
// from dedupe.ts (key bytes, the live accounts only) and the OTP parameters; a Steam link in the box is never a TOTP;
// and only a file that brought in an added account is offered for deletion, never after nothing was added.
import { describe, expect, it } from "vitest";
import { accountKey, cleanBox, offerDelete, planSettings } from "../../src/core/import/file-plan";
import { readImportText } from "../../src/core/import/file-formats";
import { applyImport } from "../../src/core/import/importer";
import { decodeBase32, encodeBase32 } from "../../src/core/totp/base32";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, type Vault } from "../../src/core/vault/model";
import { deleteEntry } from "../../src/core/vault/ops";
import { parseOtpauth } from "../../src/core/totp/otpauth";
import { K1, K2, K3, link, migration, SAMPLE_LIST } from "../helpers/import-fixtures";

const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
const vaultWith = (...uris: string[]): Vault =>
  applyImport(
    emptyVault("vault-0123456789"),
    uris.map((u) => {
      const r = parseOtpauth(u);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    }),
    clock,
  );
const linesOf = (text: string) => {
  const r = readImportText(text);
  if (r.kind !== "accounts") throw new Error(r.kind);
  return r.lines;
};
const names = (p: ReturnType<typeof planSettings>) => p.add.map((a) => `${a.issuer}/${a.label}`);

describe("planSettings", () => {
  it("the box first, then each file's lines; all ten of the owner-shaped file", () => {
    const p = planSettings(link("Box", "me", K1), linesOf(SAMPLE_LIST), []);
    expect(p.add).toHaveLength(11);
    expect(names(p)[0]).toBe("Box/me");
  });

  it("an account already in the vault is a duplicate even when its key is written differently", () => {
    const v = vaultWith(link("GitHub", "alice", K1));
    const spaced = K1.toLowerCase()
      .replace(/(.{4})/g, "$1 ")
      .trim();
    const p = planSettings(
      "",
      [link("GitHub", "alice", encodeURIComponent(spaced)), link("GitHub", "other", K1)],
      v.entries,
    );
    expect(p.add).toEqual([]);
    expect(p.duplicates).toHaveLength(2); // the same key under the same issuer, whatever the account's name
  });

  it("the same key with other OTP parameters gives other codes: it is not a duplicate", () => {
    const v = vaultWith(link("GitHub", "alice", K1));
    const p = planSettings("", [link("GitHub", "alice", K1, "&digits=8").replace("&digits=6", "")], v.entries);
    expect(p.add.map((a) => a.digits)).toEqual([8]);
    expect(p.duplicates).toEqual([]);
  });

  it("an account in the trash does not count", () => {
    const v0 = vaultWith(link("GitHub", "alice", K1));
    const v = deleteEntry(v0, aliveEntries(v0)[0]!.id, clock);
    expect(planSettings("", [link("GitHub", "alice", K1)], v.entries).add).toHaveLength(1);
  });

  it("a key repeated in one import under the same issuer is taken once when its codes are the same", () => {
    const p = planSettings(
      link("A", "a", K1),
      [
        link("A", "other", K1.toLowerCase()), // same key, same issuer, same codes: a duplicate
        link("A", "a", K1, "&period=60").replace("&period=30", ""), // other codes: kept
        link("B", "b", K1), // another issuer: kept, as the paste box always did
      ],
      [],
    );
    expect(names(p)).toEqual(["A/a", "B/b", "A/a"]); // the one with other codes comes back after the others
    expect(p.add.map((a) => a.period)).toEqual([30, 30, 60]);
    expect(p.duplicates).toHaveLength(1);
  });

  it("a Steam link written as TOTP with encoder=steam, pasted in the box, is an unsupported type, on its own line", () => {
    for (const enc of ["steam", "Steam", "%73team", "steam+", "%53TEAM%20"]) {
      const steam = `otpauth://totp/Steam:me?secret=${K2}&issuer=Steam&encoder=${enc}`;
      expect(cleanBox(steam), enc).toBe(steam.replace("otpauth://totp/", "otpauth://steam/"));
      const p = planSettings(`${link("A", "a", K1)}\n${steam}`, [], []);
      expect(names(p), enc).toEqual(["A/a"]);
      expect(p.failed, enc).toEqual([{ index: 1, reason: "unsupported_type" }]);
    }
    const steam = `otpauth://totp/Steam:me?secret=${K2}&encoder=steam`;
    expect(cleanBox(`${link("A", "a", K1)}${steam}`)).toBe(`${link("A", "a", K1)}${cleanBox(steam)}`); // run together
    expect(cleanBox(link("A", "a", K1, "&encoder=steamish"))).toBe(link("A", "a", K1, "&encoder=steamish"));
  });

  it("&amp; in a pasted link (a web page's, an e-mail's) is read as &, so no parameter is lost", () => {
    const amp = `otpauth://totp/Acme:bob?secret=${K1}&amp;issuer=Acme&amp;digits=8&#38;period=60&#x26;algorithm=SHA256`;
    const p = planSettings(`plain line\n${amp}`, [], []);
    expect(p.add.map((a) => `${a.issuer}|${a.label}|${a.algorithm}|${a.digits}|${a.period}`)).toEqual([
      "Acme|bob|SHA256|8|60",
    ]);
    expect(p.failed.map((f) => f.index)).toEqual([0]); // the plain line keeps its number
  });

  it("an export code that says it has 2^31 codes is refused at once, never looped over", () => {
    const over = migration([{ seed: 1, name: "a", issuer: "A" }], { size: 1001, index: 0, id: 9 });
    expect(planSettings(over, [], []).failed).toEqual([{ index: 0, reason: "malformed" }]); // a missing bound fails here
    const huge = migration([{ seed: 1, name: "a", issuer: "A" }], { size: 2 ** 31 - 1, index: 0, id: 9 });
    const t0 = performance.now();
    const p = planSettings(huge, [], []);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(p.add).toEqual([]);
    expect(p.incomplete).toEqual([]);
    expect(p.failed).toEqual([{ index: 0, reason: "malformed" }]);
  });

  it("5,000 file lines against a vault of 5,000 accounts are planned quickly (it runs on every keystroke)", () => {
    const uris = Array.from({ length: 5000 }, (_, i) =>
      link(`S${i}`, `u${i}`, encodeBase32(Uint8Array.from([i >> 8, i & 255, 7, 7, 7, 7, 7, 7, 7, 7]))),
    );
    const v = vaultWith(...uris);
    const t0 = performance.now();
    const p = planSettings("", uris, v.entries);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(p.add).toEqual([]);
    expect(p.duplicates).toHaveLength(5000);
  });

  it("HOTP stays HOTP, with its counter, and is noted", () => {
    const p = planSettings(`otpauth://hotp/C:b?secret=${K3}&issuer=C&counter=4`, [], []);
    expect(p.add.map((a) => [a.type, a.counter])).toEqual([["hotp", 4]]);
    expect(p.warnings.hotp).toBe(1);
  });
});

describe("offerDelete: which files the delete prompt names, and what deleting them would lose", () => {
  const a = { id: 1, lines: linesOf(`${link("A", "a", K1)}\n`), refused: 0 };
  const b = { id: 2, lines: linesOf(`${link("B", "b", K2)}\n`), refused: 0 };
  const empty = { id: 3, lines: [] as string[], refused: 0 };
  const ids = (o: ReturnType<typeof offerDelete<{ id: number; lines: string[]; refused: number }>>) =>
    o.map((x) => x.source.id);

  it("only files that brought in at least one added account", () => {
    const p = planSettings("", [...a.lines, ...b.lines], vaultWith(link("B", "b", K2)).entries);
    expect(p.add).toHaveLength(1); // B was a duplicate
    expect(ids(offerDelete([a, b, empty], p.add))).toEqual([1]);
  });

  it("nothing when nothing was added", () => {
    expect(offerDelete([a, b], [])).toEqual([]);
  });

  it("an account typed in the box with the file's key under another name does not make the file count", () => {
    const typed = parseOtpauth(link("Typed", "x", K1));
    if (!typed.ok) throw new Error();
    expect(offerDelete([a], [typed.value])).toEqual([]);
  });

  it("a file whose Steam or unreadable entries were not imported says how many; its HOTP accounts are counted", () => {
    const text = [
      link("A", "a", K1),
      `otpauth://steam/Steam:me?secret=${K2}`,
      "otpauth://totp/Broken:me?secret=*&issuer=Broken",
      `otpauth://hotp/C:b?secret=${K3}&issuer=C&counter=4`,
    ].join("\n");
    const r = readImportText(text);
    if (r.kind !== "accounts") throw new Error(r.kind);
    const f = { id: 7, lines: r.lines, refused: r.skipped.length + r.types.reduce((n, k) => n + k.n, 0) };
    const p = planSettings("", f.lines, []);
    expect(offerDelete([f], p.add)).toEqual([{ source: f, left: 2, hotp: 1 }]);
    // its accounts already in the vault are not lost: a file of duplicates and nothing else is not offered at all
    expect(offerDelete([f], [])).toEqual([]);
  });

  it("accountKey compares the key's bytes, the folded names and the parameters", () => {
    const p1 = parseOtpauth(link("GitHub", "Alice", K1));
    const p2 = parseOtpauth(link("github", "alice ", encodeBase32(decodeBase32(K1)).toLowerCase()));
    const p3 = parseOtpauth(link("GitHub", "Alice", K1, "&digits=8").replace("&digits=6", ""));
    if (!p1.ok || !p2.ok || !p3.ok) throw new Error();
    expect(accountKey(p1.value)).toBe(accountKey(p2.value));
    expect(accountKey(p1.value)).not.toBe(accountKey(p3.value));
  });
});
