// THIRD-PARTY-NOTICES.md and the notices every build carries (scripts/notices.mjs, LICENSE.md). The committed file must
// be exactly what the script writes from the dependency trees, so a dependency change without `npm run notices` fails
// here; and both the file and the build's text must keep what the shipped data requires: the OpenSubtitles notice of
// @zxcvbn-ts/language-en verbatim, the EFF word list's own licence (its package labels it MIT), the fonts' licence text,
// and each word list's attribution and its licence's URI, which both licences accept in place of a copy of their text.
// check-dist checks the built THIRD-PARTY-NOTICES.txt again (test/unit/m5-check-dist-tamper.test.ts).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOTICES_MD,
  bundledData,
  devPackages,
  extensionNoticesText,
  noticesMarkdown,
  pins,
  pythonPackages,
  shippedPackages,
} from "../../scripts/notices.mjs";

const EXT = resolve(__dirname, "../..");
const SERVER = resolve(EXT, "../api/server");
const lock = JSON.parse(readFileSync(join(EXT, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string; dev?: boolean }>;
};
const pkg = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
const md = noticesMarkdown();
const txt = extensionNoticesText();
const shipped = shippedPackages();
const normalise = (t: string) =>
  t
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n*$/, "\n");

describe("THIRD-PARTY-NOTICES.md", () => {
  it("is exactly what scripts/notices.mjs writes (run `npm run notices` in extension/ after a dependency change)", () => {
    expect(readFileSync(NOTICES_MD, "utf8") === md, "THIRD-PARTY-NOTICES.md is out of date: npm run notices").toBe(
      true,
    );
  });

  it("lists every package of the lockfile that a build can contain, each with its licence files", () => {
    const runtime = Object.entries(lock.packages)
      .filter(([k, v]) => k.startsWith("node_modules/") && !v.dev)
      .map(([k, v]) => `${k.slice(k.lastIndexOf("node_modules/") + 13)} ${v.version}`)
      .sort();
    expect(shipped.map((p) => `${p.name} ${p.version}`).sort()).toEqual(runtime);
    for (const name of Object.keys(pkg.dependencies)) expect(runtime.some((r) => r.startsWith(`${name} `))).toBe(true);
    for (const p of shipped) {
      expect(p.texts.length, p.name).toBeGreaterThan(0);
      for (const t of p.texts) {
        expect(t.text.trim().length, `${p.name} ${t.file}`).toBeGreaterThan(0);
        expect(md).toContain(t.text);
        expect(txt).toContain(t.text);
      }
      expect(md).toContain(`#### \`${p.name}\` ${p.version}`);
      expect(txt).toContain(`\n  ${p.name} ${p.version}: `);
    }
  });

  it("reproduces the OpenSubtitles notice of @zxcvbn-ts/language-en verbatim, as it asks", () => {
    const notice = normalise(readFileSync(join(EXT, "node_modules/@zxcvbn-ts/language-en/NOTICE.md"), "utf8"));
    expect(notice).toContain("Any redistribution of this package must retain this notice.");
    expect(md).toContain(notice);
    expect(txt).toContain(notice);
  });

  it("gives the EFF word list its own licence and attribution, not the package's MIT", () => {
    const common = shipped.find((p) => p.name === "@zxcvbn-ts/language-common")!;
    const eff = common.data.find((d) => d.file === "src/diceware.json")!;
    expect(eff.licence).toBe("Creative Commons Attribution 3.0 United States (CC BY 3.0 US)");
    expect(eff.licenceUrl).toBe("https://creativecommons.org/licenses/by/3.0/us/legalcode");
    expect(eff.author).toMatch(/Electronic Frontier Foundation/);
    const list = JSON.parse(readFileSync(join(EXT, "node_modules/@zxcvbn-ts/language-common", eff.file), "utf8"));
    expect(list).toHaveLength(7776); // the size of the EFF's eff_large_wordlist.txt: the file is still that list
    // and what the attribution says of zxcvbn-ts's copy is what the file shows: words only (no dice numbers), no
    // hyphen left, and the list's alphabetical order broken in exactly three places: twice where a hyphen went (it sorts
    // before letters: drop-down before dropbox, t-shirt before tabasco) and once by a word that cannot sit there
    // (cheetah after yippee, before yodel), which was replaced
    expect(list.every((w: unknown) => typeof w === "string" && /^[a-z]+$/.test(w))).toBe(true);
    const breaks = list.flatMap((w: string, i: number) => (i > 0 && list[i - 1] > w ? [`${list[i - 1]} ${w}`] : []));
    expect(breaks).toEqual(["dropdown dropbox", "tshirt tabasco", "yippee cheetah"]);
    expect(list[list.indexOf("cheetah") + 1]).toBe("yodel");
    expect(eff.attribution).toMatch(/removes the hyphens from some words and replaces at least one word\.$/);
    const block = md.slice(md.indexOf("`src/diceware.json`"), md.indexOf("`src/passwords.json`"));
    expect(block).toContain(`Licence: ${eff.licence}`);
    expect(block).not.toMatch(/Licence: MIT/);
    expect(txt).toContain(`Licence: ${eff.licence}, ${eff.licenceUrl}`);
  });

  it("gives each word list the attribution its licence asks for, with the licence's URI (SPDX seeAlso)", () => {
    const WANT: Record<string, [string, string, string]> = {
      // data file: [package, the licence's URI, the attribution]
      "src/diceware.json": [
        "@zxcvbn-ts/language-common",
        "https://creativecommons.org/licenses/by/3.0/us/legalcode",
        "EFF's wordlist eff_large_wordlist.txt (https://www.eff.org/dice), by the Electronic Frontier Foundation (EFF), used under CC BY 3.0 US; zxcvbn-ts's copy drops the dice numbers, removes the hyphens from some words and replaces at least one word.",
      ],
      "src/commonWords.json": [
        "@zxcvbn-ts/language-en",
        "https://opendatacommons.org/licenses/by/1.0/",
        "Contains information from OpenSubtitles 2024, provided by Helsinki-NLP via OPUS (https://opus.nlpl.eu/datasets/OpenSubtitles), which is made available under the ODC Attribution License.",
      ],
    };
    const given = shipped.flatMap((p) => p.data.filter((d) => d.attribution).map((d) => [p.name, d]));
    expect(given.map(([p, d]) => `${p as string} ${(d as { file: string }).file}`).sort()).toEqual(
      Object.entries(WANT)
        .map(([f, [p]]) => `${p} ${f}`)
        .sort(),
    );
    for (const [file, [name, url, credit]] of Object.entries(WANT)) {
      const d = shipped.find((p) => p.name === name)!.data.find((x) => x.file === file)!;
      expect(d.licenceUrl, file).toBe(url);
      expect(d.attribution, file).toBe(credit);
      expect(md, file).toContain(`, <${url}>`);
      expect(md, file).toContain(`- Attribution: ${credit}`);
      expect(txt, file).toContain(`, ${url}\n`);
      expect(txt, file).toContain(`    Attribution: ${credit}\n`);
    }
    // the upstream notices of the OpenSubtitles data, intact (NOTICE.md and THIRD_PARTY_LICENSES.md of language-en)
    const en = shipped.find((p) => p.name === "@zxcvbn-ts/language-en")!;
    expect(en.texts.map((t) => t.file)).toEqual(expect.arrayContaining(["NOTICE.md", "THIRD_PARTY_LICENSES.md"]));
    for (const t of en.texts) expect(txt, t.file).toContain(t.text);
  });

  it("carries the full SIL Open Font License text of each bundled font", () => {
    for (const font of ["@fontsource/instrument-sans", "@fontsource/martian-mono"]) {
      const p = shipped.find((x) => x.name === font)!;
      expect(
        p.texts.some((t) => t.text.includes("SIL OPEN FONT LICENSE Version 1.1")),
        font,
      ).toBe(true);
    }
  });

  it("names every data file it describes, and each exists in its package", () => {
    for (const p of shipped)
      for (const d of p.data) {
        expect(existsSync(join(EXT, "node_modules", p.name, d.file)), `${p.name} ${d.file}`).toBe(true);
        expect(md).toContain(`#### \`${p.name}\`: \`${d.file}\``);
      }
  });

  it("covers exactly the server's pinned Python packages, with a licence each", () => {
    const py = pythonPackages();
    const names = (xs: { name: string; version: string }[]) => xs.map((x) => `${x.name}==${x.version}`).sort();
    expect(names(py.runtime)).toEqual(names(pins(join(SERVER, "requirements.txt"))));
    expect(names(py.dev)).toEqual(names(pins(join(SERVER, "requirements-dev.txt"))));
    for (const p of [...py.runtime, ...py.dev])
      expect(p.licence, p.name).toMatch(/^[A-Za-z0-9.+-]+( OR [A-Za-z0-9.+-]+)*$/);
    for (const p of py.runtime) expect(md).toContain(`| \`${p.name}\` | ${p.version} | ${p.licence} |`);
  });

  it("names the upstream data of the site rules' bundle, every file at its pinned commit, with Apple's notice verbatim", () => {
    // (TOTP autofill Stage 3, AF3-3a: every build carries rules/baseline.json, which holds Apple's groups and hosts)
    const bundle = JSON.parse(readFileSync(resolve(EXT, "../rules/build/baseline.json"), "utf8")) as {
      upstream: { path: string; commit: string }[];
    };
    const data = bundledData();
    expect(data.map((d) => d.source)).toEqual(["apple"]);
    const apple = data[0]!;
    const notice = normalise(readFileSync(resolve(EXT, "../rules/upstream/apple/LICENSE.md"), "utf8"));
    expect(notice).toMatch(/^Copyright 2020 - 2026 Apple Inc\.\n\nPermission is hereby granted/);
    expect(apple).toMatchObject({
      author: "Apple Inc.",
      licence: "MIT",
      licenceFile: "rules/upstream/apple/LICENSE.md",
    });
    expect(apple.text).toBe(notice);
    expect(apple.url).toBe("https://github.com/apple/password-manager-resources");
    expect(apple.files).toEqual(bundle.upstream.map((u) => ({ path: u.path, commit: u.commit })));
    expect(apple.files).toHaveLength(2);
    for (const text of [md, txt]) expect(text).toContain(notice);
    for (const f of apple.files) {
      expect(md).toContain(`\`${f.path}\` at commit \`${f.commit}\``);
      expect(txt).toContain(`${f.path} at commit ${f.commit}`);
    }
    expect(md).toContain("### Data in the site rules' bundle\n");
    expect(md).toContain("#### `apple`\n");
    expect(txt).toContain("\nData in the site rules' bundle (rules/baseline.json)\n");
    expect(txt).toContain("\n======== apple: rules/upstream/apple/LICENSE.md ========\n");
  });

  it("lists the build tools apart, and the build's notices hold only what ships", () => {
    for (const p of devPackages()) {
      expect(md).toContain(`| \`${p.name}\` | ${p.version} | ${p.licence} |`);
      expect(shipped.some((s) => s.name === p.name)).toBe(false);
    }
    expect(txt).not.toMatch(/fastapi|vitest|typescript/);
  });

  it("depends on no path of the machine that generated it", () => {
    for (const text of [md, txt]) {
      expect(text).not.toContain(EXT);
      expect(text).not.toMatch(/\/(?:Users|home|private\/var|var\/folders)\//);
    }
  });
});
