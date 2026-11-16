// TOTP autofill, Stage 1: what scripts/check-dist.mjs holds a build to for it (TOTP-AUTOFILL §12.4; docs/design/notes/AUTOFILL1-NOTES.md
// §2). A prod and an e2e build are made once; each pristine one passes, and each copy altered to break one rule fails with
// that rule's message. These are the check's own mutants, kept as tests.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eBaselineText } from "../../scripts/rules-package.mjs";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-autofill1-dist-"));
const built = { prod: join(work, "prod"), e2e: join(work, "e2e"), dev: join(work, "dev") };
type Flavour = keyof typeof built;
const flag = (f: Flavour) => (f === "prod" ? [] : [`--${f}`]);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));

function build(flavour: Flavour) {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", ...flag(flavour), "--out", built[flavour]], {
    cwd: EXT,
    encoding: "utf8",
    env,
  });
  if (r.status !== 0) throw new Error(`build ${flavour} failed:\n${r.stdout}\n${r.stderr}`);
}
function check(dir: string, flavour: Flavour): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", ...flag(flavour), "--dist", dir], {
    cwd: EXT,
    encoding: "utf8",
    env,
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
let n = 0;
function mutant(flavour: Flavour, alter: (dir: string) => void): { ok: boolean; out: string } {
  const dir = join(work, `m${++n}`);
  cpSync(built[flavour], dir, { recursive: true });
  alter(dir);
  try {
    return check(dir, flavour);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const editText = (dir: string, f: string, fn: (t: string) => string) =>
  writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
const editJson = (dir: string, f: string, fn: (j: Record<string, unknown>) => void) => {
  const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
  fn(j);
  writeFileSync(join(dir, f), JSON.stringify(j, null, 2));
};
const asset = (dir: string, re: RegExp) => `assets/${readdirSync(join(dir, "assets")).find((x) => re.test(x))!}`;
const popupChunk = (dir: string) => asset(dir, /^popup-(?!locale)[\w-]+\.js$/);
/**
 * The site rules' reader: the one script that reads the package file. AF3-3b's was the Fill chunk; since AF3-4 it is the
 * chunk the bundler splits off for the Fill chunk and the "same sign-in" chunk, which both load it.
 */
const readerChunk = (dir: string) =>
  `assets/${readdirSync(join(dir, "assets")).find((x) => x.endsWith(".js") && readFileSync(join(dir, "assets", x), "utf8").includes("fetch(chrome.runtime.getURL("))!}`;
const ENGINE = "inject/otp.js";

beforeAll(() => {
  build("prod");
  build("e2e");
  build("dev");
}, 240_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the pristine builds pass, and report the finder and the Fill text", () => {
  it("prod, e2e and dev", () => {
    for (const f of ["prod", "e2e", "dev"] as Flavour[]) {
      const r = check(built[f], f);
      expect(r.out).toContain(`check-dist (${f}) OK`);
      expect(r.out).toMatch(/code box finder inject\/otp\.js: \d+ B gz/);
      expect(r.out).toMatch(/Fill button text en: \d+ B gz/);
      expect(r.out).toMatch(
        /Fill button chunk: \d+ B gz, with the site rules' reader it loads \(\d+ B gz\): \d+ B \(limit 12288 B\)/,
      );
      expect(r.out).toMatch(/"same sign-in" chunk: \d+ B gz \(limit 2048 B\)/);
      expect(r.ok).toBe(true);
    }
  });
  it("the finder is one small classic script that sets __skOtp, and a prod build has nothing for the tests' hook", () => {
    const t = readFileSync(join(built.prod, ENGINE), "utf8");
    expect(t).toMatch(/^var __skOtp=/);
    // one script, not a bundle (round 3's visibility test made it about 12 KB; the budget that counts is check-dist's 8,192 B gzip)
    expect(t.length).toBeLessThan(16_000);
    for (const f of readdirSync(join(built.prod, "assets")).filter((x) => x.endsWith(".js")))
      expect(readFileSync(join(built.prod, "assets", f), "utf8"), f).not.toContain("__skFill");
    expect(readFileSync(join(built.prod, "sw.js"), "utf8")).not.toContain("__skFill");
    expect(readFileSync(join(built.e2e, "sw.js"), "utf8")).toContain("__skFill");
  });
});

describe("check-dist: the manifest for autofill", () => {
  const cases: [string, (j: Record<string, unknown>) => void, RegExp][] = [
    // optional since wave 1b of the plugin platform (MOD-PLATFORM §7.2 Option I item 3; PLUGINS-W1B-NOTES.md)
    [
      "scripting left out",
      (j) => void (j.optional_permissions = (j.optional_permissions as string[]).filter((p) => p !== "scripting")),
      /scripting must be an optional permission/,
    ],
    [
      "scripting required again",
      (j) => void (j.permissions as string[]).push("scripting"),
      /permissions must be exactly/,
    ],
    // Chrome 140 at least (OWNER-DECISIONS/14 OQ1 (a)): the storage gate's both areas accepted there
    ["Chrome 139 allowed", (j) => void (j.minimum_chrome_version = "139"), /minimum_chrome_version must be >= 140/],
    ["no minimum Chrome", (j) => delete j.minimum_chrome_version, /minimum_chrome_version must be >= 140/],
    [
      "a host permission at install",
      (j) => void (j.host_permissions = ["https://*/*"]),
      /must not have host_permissions|must be exactly/,
    ],
    // Stage 2 patch 2 declares https://*/* as optional (one site at a time: AUTOFILL2-NOTES §7); nothing broader
    ...(["<all_urls>", "*://*/*", "http://*/*", "https://*/*,http://*/*"] as const).map(
      (wide): [string, (j: Record<string, unknown>) => void, RegExp] => [
        `an optional host permission broader than https sites: ${wide}`,
        (j) =>
          void (j.optional_host_permissions = [
            ((j.optional_host_permissions ?? j.host_permissions) as string[])[0]!,
            ...wide.split(","),
          ]),
        /optional_host_permissions/,
      ],
    ),
    [
      "declarativeContent",
      (j) => void (j.permissions as string[]).push("declarativeContent"),
      /permissions must be exactly/,
    ],
    ["webNavigation", (j) => void (j.permissions as string[]).push("webNavigation"), /permissions must be exactly/],
    ["tabs", (j) => void (j.permissions as string[]).push("tabs"), /permissions must be exactly/],
    [
      "a content script",
      (j) => void (j.content_scripts = [{ matches: ["https://*/*"], js: ["inject/otp.js"] }]),
      /manifest key not allowed: content_scripts/,
    ],
    [
      "web_accessible_resources (the finder reachable by pages)",
      (j) => void (j.web_accessible_resources = [{ resources: ["inject/otp.js"], matches: ["<all_urls>"] }]),
      /manifest key not allowed: web_accessible_resources/,
    ],
    [
      "the fill command removed",
      (j) => delete (j.commands as Record<string, unknown>).fill,
      /commands must be exactly/,
    ],
    [
      "the fill command global",
      (j) => void ((j.commands as Record<string, { global?: boolean }>).fill!.global = true),
      /commands must be exactly/,
    ],
    [
      "the fill command on another key",
      (j) =>
        void ((j.commands as Record<string, { suggested_key: { default: string } }>).fill!.suggested_key.default =
          "Ctrl+Shift+F"),
      /commands must be exactly/,
    ],
    [
      "another command",
      (j) => void ((j.commands as Record<string, unknown>).fill2 = { suggested_key: { default: "Alt+Shift+G" } }),
      /commands must be exactly/,
    ],
  ];
  for (const flavour of ["prod", "e2e"] as const)
    for (const [what, alter, msg] of cases)
      it(`${flavour}: ${what} fails`, () => {
        const r = mutant(flavour, (d) => editJson(d, "manifest.json", alter));
        expect(r.ok).toBe(false);
        expect(r.out).toMatch(msg);
      });
  // AUTOFILL2 patch 2: the e2e build grants its two Stage 2 fixture hosts up front (its tests cannot answer Chrome's
  // prompt), and nothing else: Stage 1's fixture hosts must stay out of reach of anything but activeTab
  const hosts = (j: Record<string, unknown>) => j.host_permissions as string[];
  const e2eCases: [string, (j: Record<string, unknown>) => void][] = [
    ["a Stage 1 fixture host granted too", (j) => void hosts(j).push("https://tls.fix.test/*")],
    ["another Stage 1 fixture host granted too", (j) => void hosts(j).push("http://app.fix.test/*")],
    ["every https site granted", (j) => void hosts(j).push("https://*/*")],
    [
      "a granted fixture host left out",
      (j) => void (j.host_permissions = hosts(j).filter((h) => !/grantedtls/.test(h))),
    ],
  ];
  for (const [what, alter] of e2eCases)
    it(`e2e: ${what} fails`, () => {
      const r = mutant("e2e", (d) => editJson(d, "manifest.json", alter));
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/host_permissions must be exactly/);
    });
});

describe("check-dist: the registered content script (AUTOFILL2 patch 3)", () => {
  const SUGGEST = "inject/suggest.js";
  const reg = (to: string) => (d: string) => editText(d, "sw.js", (t) => t.replace(/runAt:\s*"document_idle"/, to));
  const cases: [string, (d: string) => void, RegExp][] = [
    ["the registration in the page's own world", reg('runAt:"document_idle",world:"MAIN"'), /the one object|MAIN/],
    [
      "the registration with matchOriginAsFallback",
      reg('runAt:"document_idle",matchOriginAsFallback:!0'),
      /the one object|matchOriginAsFallback/,
    ],
    ["the registration at document_start", reg('runAt:"document_start"'), /the one object/],
    [
      "a third file in the registration",
      (d) => editText(d, "sw.js", (t) => t.replace(/"inject\/suggest\.js"\s*\]/, '"inject/suggest.js","inject/x.js"]')),
      /js exactly/,
    ],
    [
      "a registration in the Fill chunk",
      (d) => editText(d, asset(d, /^Fill-[\w-]+\.js$/), (t) => `${t}\nchrome.scripting.updateContentScripts([]);`),
      /registered outside the worker/,
    ],
    [
      "fetch in the content script",
      (d) => editText(d, SUGGEST, (t) => `${t}\nfetch("/x");`),
      /the content script may not contain/,
    ],
    [
      "storage in the content script",
      (d) => editText(d, SUGGEST, (t) => `${t}\nchrome.storage.local.get(null);`),
      /may not contain|its one chrome API/,
    ],
    [
      "postMessage in the content script",
      (d) => editText(d, SUGGEST, (t) => `${t}\nwindow.postMessage(1,"*");`),
      /may not contain/,
    ],
    [
      "an attribute written to the page",
      (d) => editText(d, SUGGEST, (t) => `${t}\ndocument.body.setAttribute("x","1");`),
      /may not contain/,
    ],
    [
      "an event dispatched to the page",
      (d) => editText(d, SUGGEST, (t) => `${t}\ndocument.dispatchEvent(new Event("x"));`),
      /may not contain/,
    ],
    ["a global of its own", (d) => editText(d, SUGGEST, (t) => `var leak=1;\n${t}`), /not one function run at once/],
    [
      "a second message",
      (d) => editText(d, SUGGEST, (t) => t.replace("sk-af-cand", "sk-af-use")),
      // (e2e: the gate open, the suggestion's two)
      /its one message must be exactly|its two messages must be exactly/,
    ],
    [
      "another chrome API",
      (d) => editText(d, SUGGEST, (t) => `${t}\nchrome.runtime.connect();`),
      /may not contain|its one chrome API/,
    ],
    [
      "the content script missing",
      (d) => rmSync(join(d, SUGGEST)),
      /inject\/ must hold exactly|missing from the build/,
    ],
  ];
  for (const flavour of ["prod", "e2e"] as const)
    for (const [what, alter, msg] of cases)
      it(`${flavour}: ${what} fails`, () => {
        const r = mutant(flavour, alter);
        expect(r.ok).toBe(false);
        expect(r.out).toMatch(msg);
      });
  it("the pristine builds report the content script within its budget", () => {
    for (const f of ["prod", "e2e"] as const)
      expect(check(built[f], f).out).toMatch(/content script inject\/suggest\.js: \d+ B gz \(limit 6144 B\)/);
  });
});

describe("check-dist: the finder's file", () => {
  const cases: [string, (dir: string) => void, RegExp][] = [
    ["the file missing", (d) => rmSync(join(d, ENGINE)), /inject\/ must hold exactly|missing from the build/],
    [
      "a second file under inject/",
      (d) => writeFileSync(join(d, "inject/extra.js"), "var x=1;"),
      /inject\/ must hold exactly/,
    ],
    [
      "a content-script style import",
      (d) => editText(d, ENGINE, (t) => `import "./x.js";\n${t}`),
      /not the classic script|may not contain/,
    ],
    ["an export", (d) => editText(d, ENGINE, (t) => `${t}\nexport{};`), /may not contain/],
    [
      "no __skOtp",
      (d) => editText(d, ENGINE, (t) => t.replace("var __skOtp=", "var other=")),
      /not the classic script/,
    ],
    [
      "a chrome API",
      (d) => editText(d, ENGINE, (t) => `${t}\nchrome.runtime.sendMessage(1);`),
      /the finder may not contain/,
    ],
    [
      "a fetch",
      (d) => editText(d, ENGINE, (t) => `${t}\nfetch("https://x.test");`),
      /fetch|the finder may not contain/,
    ],
    [
      "a form submission",
      (d) => editText(d, ENGINE, (t) => `${t}\ndocument.forms[0].submit();`),
      /the finder may not contain/,
    ],
    ["a requestSubmit", (d) => editText(d, ENGINE, (t) => `${t}\nf.requestSubmit();`), /the finder may not contain/],
    ["a click", (d) => editText(d, ENGINE, (t) => `${t}\nb.click();`), /the finder may not contain/],
    [
      "a key event",
      (d) => editText(d, ENGINE, (t) => `${t}\nnew KeyboardEvent("keydown",{key:"Enter"});`),
      /the finder may not contain/,
    ],
    [
      "the clipboard",
      (d) => editText(d, ENGINE, (t) => `${t}\nnavigator.clipboard.writeText("1");`),
      /the finder may not contain/,
    ],
    [
      "storage",
      (d) => editText(d, ENGINE, (t) => `${t}\nlocalStorage.setItem("a","b");`),
      /the finder may not contain/,
    ],
    [
      "a message to the page",
      (d) => editText(d, ENGINE, (t) => `${t}\nwindow.postMessage(1,"*");`),
      /the finder may not contain/,
    ],
    ["dynamic code", (d) => editText(d, ENGINE, (t) => `${t}\neval("1");`), /the finder may not contain/],
    [
      "over its budget",
      (d) =>
        editText(
          d,
          ENGINE,
          (t) => `${t}\n/*${Array.from({ length: 12000 }, () => Math.random().toString(36).slice(2)).join("")}*/`,
        ),
      /over its budget/,
    ],
  ];
  for (const [what, alter, msg] of cases)
    it(`prod: ${what} fails`, () => {
      const r = mutant("prod", alter);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(msg);
    });
  it("e2e: the same rules hold (a chrome API in the finder fails)", () => {
    const r = mutant("e2e", (d) => editText(d, ENGINE, (t) => `${t}\nchrome.storage.local.get("x");`));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/the finder may not contain/);
  });
});

describe("check-dist: the three chrome.scripting calls, as built (the review's m-6)", () => {
  // (a minified name may hold "$": the worker's function was `$l` once the bundle grew, AUTOFILL2 patch 2)
  const FILL =
    /(scripting\.executeScript\(\{target:\{tabId(?::[\w$]+)?,)documentIds(:\[[\w$]+\.documentId\]\},func:[\w$]+,args:\[)/;
  const LOOK =
    /(scripting\.executeScript\(\{target:\{tabId(?::[\w$]+)?,allFrames:(?:!0|true)\},func:[\w$]+),args:\[([\w$]+)\]\}/;
  const files = (d: string) => ["sw.js", asset(d, /^Fill-[\w-]+\.js$/)];
  // the worker is built readable (spaces, tabs, line breaks), the chunk minified: both are read with the white space gone
  const squash = (t: string) => t.replace(/\s+/g, "");
  const alter = (re: RegExp, to: string) => (d: string) => {
    for (const f of files(d)) editText(d, f, (t) => squash(t).replace(re, to));
  };
  const cases: [string, (d: string) => void, RegExp][] = [
    [
      "the fill call to all frames",
      alter(FILL, "$1allFrames:!0,documentIds$2"),
      /the fill call must target one documentId/,
    ],
    [
      "the fill call by frame ID",
      alter(FILL, "$1frameIds$2"),
      /the fill call must target one documentId|must be one install/,
    ],
    [
      "the fill call in the page's own world",
      alter(
        /(scripting\.executeScript\(\{target:\{tabId:\w+,documentIds:\[\w+\.documentId\]\},)func/,
        '$1world:"MAIN",func',
      ),
      /names a world/,
    ],
    [
      "the look call in the page's own world",
      alter(
        /(scripting\.executeScript\(\{target:\{tabId(?::\w+)?,allFrames:(?:!0|true)\},)func/,
        '$1world:"MAIN",func',
      ),
      /names a world/,
    ],
    [
      // TOTP autofill Stage 3 (AF3-2): the look passes exactly one argument, the hint or null
      "the look call without its argument",
      alter(LOOK, "$1}"),
      /the look call must be allFrames with a function and exactly one argument/,
    ],
    [
      "the look call with a second argument (the account's name)",
      alter(LOOK, "$1,args:[$2,1]}"),
      /the look call must be allFrames with a function and exactly one argument/,
    ],
    [
      "the look call by frame ID",
      alter(
        /(scripting\.executeScript\(\{target:\{tabId(?::[\w$]+)?,)allFrames:(?:!0|true)(\},func:[\w$]+,args:\[[\w$]+\]\})/,
        "$1frameIds:[0]$2",
      ),
      /the look call must be allFrames with a function and exactly one argument/,
    ],
    [
      "the look call to one document",
      alter(
        /(scripting\.executeScript\(\{target:\{tabId(?::[\w$]+)?,)allFrames:(?:!0|true)(\},func:[\w$]+,args:\[[\w$]+\]\})/,
        "$1documentIds:[x]$2",
      ),
      /exactly five arguments|must be one install/,
    ],
    [
      "a sixth argument (the account's name)",
      alter(/(args:\[\w+,\w+\.origin,\w+\.domain,\w+\.top,\w+\.found\.t)\]/, "$1,1]"),
      /exactly five arguments/,
    ],
    [
      "only the code as the argument",
      alter(/args:\[\w+,\w+\.origin,\w+\.domain,\w+\.top,\w+\.found\.t\]/, "args:[1]"),
      /exactly five arguments/,
    ],
    [
      "a fourth executeScript call",
      (d) =>
        editText(
          d,
          "sw.js",
          (t) => `${t}\nchrome.scripting.executeScript({target:{tabId:1,allFrames:!0},func:()=>1});`,
        ),
      /expected the finder's 3 executeScript calls/,
    ],
    [
      "executeScript in the popup's code",
      (d) => editText(d, popupChunk(d), (t) => `${t}\nchrome.scripting.executeScript({target:{tabId:1},func:()=>1});`),
      /outside the worker and the Fill chunk/,
    ],
    [
      // (AUTOFILL2 patch 3 registers one content script: a second registration call is refused)
      "a second registered content script in the worker",
      (d) => editText(d, "sw.js", (t) => `${t}\nchrome.scripting.registerContentScripts([]);`),
      /exactly one registerContentScripts call/,
    ],
    [
      "insertCSS in the worker",
      (d) => editText(d, "sw.js", (t) => `${t}\nchrome.scripting.insertCSS({});`),
      /a style is injected/,
    ],
    ["console in the finder", (d) => editText(d, ENGINE, (t) => `${t}\nconsole.log(1);`), /the finder may not contain/],
  ];
  for (const flavour of ["prod", "e2e"] as const)
    for (const [what, fn, msg] of cases)
      it(`${flavour}: ${what} fails`, () => {
        const r = mutant(flavour, fn);
        expect(r.ok).toBe(false);
        expect(r.out).toMatch(msg);
      });
  it("the unaltered fill call matches the pattern these mutants alter (so none of them is a no-op)", () => {
    for (const f of ["sw.js", asset(built.prod, /^Fill-[\w-]+\.js$/)]) {
      const t = readFileSync(join(built.prod, f), "utf8").replace(/\s+/g, "");
      expect(t, f).toMatch(FILL);
      expect(t, f).toMatch(/scripting\.executeScript\(\{target:\{tabId(?::\w+)?,allFrames:(?:!0|true)\},func/);
      expect(t, f).toMatch(/args:\[\w+,\w+\.origin,\w+\.domain,\w+\.top,\w+\.found\.t\]/);
      expect(t, f).toMatch(LOOK);
    }
  });
});

describe("check-dist: no rule data in any script, and the Fill chunk and its text load lazily only", () => {
  // (TOTP autofill Stage 3, AF3-3a: the bundle's own data is the probe now, test/unit/rules-package.test.ts holds the rest)
  it("rule data inlined into a script fails, as the bundlers write it: backticks, indented lines, escaped JSON", () => {
    // the shapes Vite 8 gives an imported bundle (the AF3-3a review's probe builds): the pages' minifier, the worker's
    // library build (sw.js), a string of JSON; and the compact form, in a dev build's unminified worker too
    const group = ["chat.com", "chatgpt.com", "openai.com"];
    const cases: [string, Flavour, (d: string) => string, string][] = [
      ["a page chunk, minified", "prod", popupChunk, `;window.__r={s:[${group.map((h) => `\`${h}\``).join(",")}]};`],
      [
        "the worker, indented",
        "prod",
        () => "sw.js",
        `\nvar __r = { s: [\n\t\t\t"${group.join('",\n\t\t\t"')}"\n\t\t] };\n`,
      ],
      [
        "a string of JSON",
        "prod",
        popupChunk,
        `;JSON.parse("{\\"s\\":[${group.map((h) => `\\"${h}\\"`).join(",")}]}");`,
      ],
      ["compact, in the dev build's worker", "dev", () => "sw.js", `\n/*{"s":${JSON.stringify(group)}}*/`],
    ];
    for (const [what, f, file, added] of cases) {
      const r = mutant(f, (d) => editText(d, file(d), (t) => `${t}${added}`));
      expect(r.ok, what).toBe(false);
      expect(r.out, what).toMatch(/: rule data in a shipped file \(\["chat\.com","chatgpt\.com","openai\.com"\]\)/);
    }
  }, 120_000);
  it("the bundle's data in any other shipped file fails too: a copy as a page's asset, a page, a style, a source map, a JSON data: URL", () => {
    // what `new URL("../rules/…", import.meta.url)` leaves (the AF3-3a review's round 2): a page build copies the file into
    // assets/ (the build's guard refuses that too, m5-build-guard.test.ts), a library build writes it into the script
    const bundle = readFileSync(resolve(EXT, "../rules/build/baseline.json"));
    const list = `[${["chat.com", "chatgpt.com", "openai.com"].map((h) => `\`${h}\``).join(", ")}]`;
    const style = asset(built.prod, /\.css$/);
    const cases: [string, Flavour, (d: string) => void, RegExp[]][] = [
      [
        "a copy of the bundle in assets/",
        "prod",
        (d) => writeFileSync(join(d, "assets/baseline-C_sPtr1I.json"), bundle),
        [
          /assets\/baseline-C_sPtr1I\.json: a copy of the site rules' bundle outside rules\/ \(only rules\/baseline\.json may hold it\)/,
          /assets\/baseline-C_sPtr1I\.json: rule data in a shipped file/,
        ],
      ],
      [
        "a page",
        "prod",
        (d) => editText(d, "popup/index.html", (t) => `${t}<!-- ${list} -->`),
        [/popup\/index\.html: rule data in a shipped file/],
      ],
      [
        "a style",
        "prod",
        (d) => editText(d, style, (t) => `${t}\n/* ${list} */`),
        [new RegExp(`${style.replace(/[.]/g, "\\.")}: rule data in a shipped file`)],
      ],
      [
        "a source map of the dev build",
        "dev",
        (d) => editJson(d, asset(d, /\.js\.map$/), (j) => void (j.x = ["chat.com", "chatgpt.com", "openai.com"])),
        [/\.js\.map: rule data in a shipped file/],
      ],
      [
        "a JSON data: URL in the worker (a library build's form of the same import)",
        "prod",
        (d) => editText(d, "sw.js", (t) => `${t}\nvar __u = new URL("data:application/json;base64,e30=").href;\n`),
        [/sw\.js: a JSON data: URL in a script/],
      ],
    ];
    for (const [what, f, alter, msgs] of cases) {
      const r = mutant(f, alter);
      expect(r.ok, what).toBe(false);
      for (const m of msgs) expect(r.out, what).toMatch(m);
    }
  }, 120_000);
  it("the site rules are read by one lazy chunk, which the Fill and the same sign-in chunks load, once, with reserved names in the e2e build only (AF3-3b, C27, AF3-4)", () => {
    const fillChunk = readerChunk;
    for (const f of ["prod", "e2e"] as Flavour[]) {
      expect(fillChunk(built[f]), f).not.toMatch(/^assets\/(Fill|aliases)-/); // a chunk of its own, which both import
      const t = readFileSync(join(built[f], fillChunk(built[f])), "utf8");
      expect(t.match(/\bfetch\(chrome\.runtime\.getURL\(/g), f).toHaveLength(1);
      expect(t, f).toMatch(f === "e2e" ? /\ballowReserved:!0\b/ : /\ballowReserved:!1\b/);
      // the worker reads no package file (C27); with the site rules' updater's gate open (the e2e build), it checks a
      // downloaded bundle with the format's checker, reserved test hosts allowed (AF3-U2)
      const sw = readFileSync(join(built[f], "sw.js"), "utf8");
      expect(sw, f).not.toMatch(/rules\/baseline\.json/);
      if (f === "prod") expect(sw, f).not.toMatch(/allowReserved/);
      else expect(sw, f).toMatch(/\ballowReserved: !0\b/);
    }
    const read = 'fetch(chrome.runtime.getURL("rules/baseline.json"));';
    const cases: [string, Flavour, (d: string) => void, RegExp][] = [
      [
        "a read in the worker",
        "prod",
        (d) => editText(d, "sw.js", (t) => `${t}\n${read}`),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone; found in: .*sw\.js/,
      ],
      [
        "a read in the popup's counted chunk",
        "prod",
        (d) => editText(d, popupChunk(d), (t) => `${t}\n${read}`),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone/,
      ],
      [
        "the reader loaded by another lazy chunk too (the View menu's)",
        "prod",
        (d) => editText(d, asset(d, /^View-[\w-]+\.js$/), (t) => `import"./${readerChunk(d).slice(7)}";${t}`),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone; found in: assets\/[\w-]+\.js, loaded with: .*View-/,
      ],
      [
        "the reader no longer loaded by the same sign-in chunk",
        "prod",
        (d) =>
          editText(d, asset(d, /^aliases-[\w-]+\.js$/), (t) =>
            t.split(`./${readerChunk(d).slice(7)}`).join("./gone.js"),
          ),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone/,
      ],
      [
        "the reader in the popup's own scripts (imported by its counted chunk)",
        "prod",
        (d) => editText(d, popupChunk(d), (t) => `import"./${readerChunk(d).slice(7)}";${t}`),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone/,
      ],
      // AF3-4's review: S2 (T7), N1 (T5), N2 (T4)
      [
        "the format's checker in the counted boot chunk too (its list of reserved names appended)",
        "prod",
        (d) =>
          editText(
            d,
            asset(d, /^boot-[\w-]+\.js$/),
            (t) => `${t};var __r=[\`test\`,\`example\`,\`invalid\`,\`localhost\`];`,
          ),
        /the format's checker \(its list of reserved names, src\/core\/rules\/format\.ts\) must be in the site rules' reader alone; found in: .*boot-/,
      ],
      [
        // (the e2e build's worker has the checker too, its site rules' updater's: AF3-U2)
        "the checker's list moved out of the reader (into the worker)",
        "e2e",
        (d) => {
          editText(d, readerChunk(d), (t) => t.replace("[`test`,`example`,`invalid`,`localhost`]", "[]"));
          editText(d, "sw.js", (t) => `${t};var __r=["test","example","invalid","localhost"];`);
        },
        /the format's checker .* must be in the site rules' reader and in sw\.js \(the updater's\); found in: sw\.js/,
      ],
      [
        "the reader loaded by the offscreen document's own page",
        "prod",
        (d) =>
          editText(d, "offscreen/index.html", (t) =>
            t.replace("</head>", `<script type="module" src="../${readerChunk(d)}"></script></head>`),
          ),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone; .*and with a page's own scripts/,
      ],
      [
        "the reader loaded by import() from the counted boot chunk",
        "prod",
        (d) => editText(d, asset(d, /^boot-[\w-]+\.js$/), (t) => `${t};import("./${readerChunk(d).slice(7)}");`),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone; .*by import\(\) in: assets\/boot-/,
      ],
      // round 2's r2-a: whatever path comes before the file's name, and a query or fragment after it (T13, T14)
      [
        "the reader loaded by import() through another path (../assets/)",
        "prod",
        (d) => editText(d, asset(d, /^boot-[\w-]+\.js$/), (t) => `${t};import("../${readerChunk(d)}");`),
        /by import\(\) in: assets\/boot-/,
      ],
      [
        "the reader loaded by import() with a query",
        "prod",
        (d) => editText(d, asset(d, /^boot-[\w-]+\.js$/), (t) => `${t};import(\`./${readerChunk(d).slice(7)}?x\`);`),
        /by import\(\) in: assets\/boot-/,
      ],
      [
        "the reader loaded by import() from the root, with a fragment",
        "prod",
        (d) => editText(d, asset(d, /^View-[\w-]+\.js$/), (t) => `${t};import('/${readerChunk(d)}#h');`),
        /by import\(\) in: assets\/View-/,
      ],
      [
        "a second read in the reader chunk",
        "prod",
        (d) => editText(d, fillChunk(d), (t) => `${t}\n${read}`),
        /a fetch of a package file that is not the one read of rules\/baseline\.json/,
      ],
      [
        "no read at all",
        "e2e",
        (d) =>
          editText(d, fillChunk(d), (t) =>
            t.replace("fetch(chrome.runtime.getURL(", "Promise.reject(chrome.runtime.getURL("),
          ),
        /must be in one lazy chunk, loaded with the Fill chunk and the "same sign-in" chunk alone; found in: nothing/,
      ],
      [
        "reserved names accepted in a store build",
        "prod",
        (d) => editText(d, fillChunk(d), (t) => t.replace("allowReserved:!1", "allowReserved:!0")),
        /a prod build's reader must refuse them/,
      ],
      [
        "reserved names refused in the e2e build",
        "e2e",
        (d) => editText(d, fillChunk(d), (t) => t.replace("allowReserved:!0", "allowReserved:!1")),
        /the e2e build's reader must accept them/,
      ],
      [
        "the define not replaced",
        "prod",
        (d) => editText(d, fillChunk(d), (t) => `${t}\nvar x=typeof __SK_RULES_TEST_HOSTS__;`),
        /__SK_RULES_TEST_HOSTS__ left in the build/,
      ],
    ];
    for (const [what, f, alter, msg] of cases) {
      const r = mutant(f, alter);
      expect(r.ok, what).toBe(false);
      expect(r.out, what).toMatch(msg);
    }
  }, 180_000);
  it('"localhost" in a store build: only the format\'s list of reserved names is let through, nowhere else in its chunk', () => {
    const fillChunk = readerChunk; // the format's checker is the reader's (AF3-4: a chunk of its own)
    const LIST = "[`test`,`example`,`invalid`,`localhost`]";
    expect(readFileSync(join(built.prod, fillChunk(built.prod)), "utf8")).toContain(LIST);
    expect(check(built.prod, "prod").ok).toBe(true); // the list alone passes
    const cases: [string, (t: string) => string][] = [
      ["a dev address in the same chunk", (t) => `${t}\nvar o="ws://localhost:8787";`],
      ["the word beside the list", (t) => t.replace(LIST, `${LIST},localhost`)],
      ["another list with the word", (t) => t.replace(LIST, "[`test`,`localhost`]")],
      ["the list changed", (t) => t.replace(LIST, "[`test`,`example`,`invalid`,`localhost`,`local`]")],
    ];
    for (const [what, alter] of cases) {
      const r = mutant("prod", (d) => editText(d, fillChunk(d), alter));
      expect(r.ok, what).toBe(false);
      // in the reader's chunk, where the format's checker is (AF3-4: no longer the Fill chunk)
      expect(r.out, what).toMatch(new RegExp(`${readerChunk(built.prod)}: dev marker in a prod build: localhost`));
    }
  }, 120_000);
  it("a bundle that is not JSON fails with its reason, and the other checks still report", () => {
    const r = mutant("prod", (d) => writeFileSync(join(d, "rules/baseline.json"), "{"));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/rules\/baseline\.json is not a baseline bundle the extension accepts: not JSON/);
    expect(r.out).toMatch(/check-dist \(prod\) FAILED/);
    expect(r.out).not.toMatch(/SyntaxError|at file:/);
  });
  it("rules/ in a build holds the bundle and its licence, and nothing else", () => {
    const extra = mutant("prod", (d) => writeFileSync(join(d, "rules/other.json"), "{}"));
    expect(extra.ok).toBe(false);
    expect(extra.out).toMatch(/rules\/ in a build holds exactly rules\/LICENSE\.txt and rules\/baseline\.json/);
    const nested = mutant("prod", (d) => {
      mkdirSync(join(d, "rules/sites"));
      writeFileSync(join(d, "rules/sites/a.json"), "{}");
    });
    expect(nested.ok).toBe(false);
    expect(nested.out).toMatch(/rules\/ in a build holds exactly/);
    const none = mutant("prod", (d) => rmSync(join(d, "rules"), { recursive: true }));
    expect(none.ok).toBe(false);
    expect(none.out).toMatch(/found nothing/);
  });
  it("the bundle is the repository's byte for byte, in bundle.mjs's form, read as the extension reads it; its licence as built", async () => {
    const B = "rules/baseline.json";
    const cases: [string, (d: string) => void, RegExp][] = [
      [
        "a byte changed",
        (d) => editText(d, B, (t) => t.replace('"x.com"', '"y.com"')),
        /not the repository's rules\/build\/baseline\.json/,
      ],
      [
        "written compact",
        (d) => editText(d, B, (t) => JSON.stringify(JSON.parse(t))),
        /not in the form rules\/tools\/bundle\.mjs writes/,
      ],
      [
        "a key written twice",
        (d) => editText(d, B, (t) => t.replace('"kind": "baseline",', '"kind": "live",\n  "kind": "baseline",')),
        /not in the form/,
      ],
      [
        "a live bundle",
        (d) => editText(d, B, (t) => t.replace('"kind": "baseline"', '"kind": "live"')),
        /not a baseline bundle the extension accepts/,
      ],
      [
        "its licence file changed",
        (d) => editText(d, "rules/LICENSE.txt", (t) => t.replace("Apple Inc.", "someone")),
        /rules\/LICENSE\.txt is not rules\/NOTICE and then the AGPL-3\.0 text/,
      ],
      [
        "the manifest making it web-accessible",
        (d) =>
          editJson(
            d,
            "manifest.json",
            (j) =>
              void (j.web_accessible_resources = [{ resources: ["rules/baseline.json"], matches: ["<all_urls>"] }]),
          ),
        /manifest\.json names rules\//,
      ],
    ];
    for (const [what, alter, msg] of cases) {
      const r = mutant("prod", alter);
      expect(r.ok, what).toBe(false);
      expect(r.out, what).toMatch(msg);
    }
    expect(check(built.prod, "prod").out).toMatch(
      /site rules' bundle rules\/baseline\.json: \d+ B gz \(limit 65536 B\)/,
    );
    const committed = readFileSync(resolve(EXT, "../rules/build/baseline.json"), "utf8");
    for (const f of ["prod", "dev"] as Flavour[])
      expect(readFileSync(join(built[f], "rules/baseline.json"), "utf8"), f).toBe(committed);
    // the e2e build's: with its own test rules (AF3-3b), and check-dist holds it to exactly that
    const e2e = await e2eBaselineText(committed);
    expect(readFileSync(join(built.e2e, "rules/baseline.json"), "utf8")).toBe(e2e);
    expect(e2e).not.toBe(committed);
    for (const [what, alter, msg] of [
      [
        "the committed bundle alone",
        (d: string) => writeFileSync(join(d, "rules/baseline.json"), committed),
        /rules\/baseline\.json is not the repository's rules\/build\/baseline\.json with the e2e build's test rules, byte for byte/,
      ],
      [
        "a test rule changed",
        (d: string) => editText(d, "rules/baseline.json", (t) => t.replace('"#code-box"', '"#other-box"')),
        /with the e2e build's test rules, byte for byte/,
      ],
    ] as const) {
      const r = mutant("e2e", alter);
      expect(r.ok, what).toBe(false);
      expect(r.out, what).toMatch(msg);
    }
    // and a store build's bundle with a test rule in it: refused by the store build's reader (reserved names)
    const withTest = mutant("prod", (d) => writeFileSync(join(d, "rules/baseline.json"), e2e));
    expect(withTest.ok).toBe(false);
    expect(withTest.out).toMatch(
      /rules\/baseline\.json is not a baseline bundle the extension accepts: .*reserved name/,
    );
  }, 180_000);
  it("a bundle over its budget fails, gzipped (64 KB) and raw (the reader's 1 MiB), though in form and readable", () => {
    // names no compressor can shorten (a fixed seed): 400 groups of 32, about 330 KB raw, and about 90 KB gzipped
    let seed = 7;
    const letter = () => String.fromCharCode(97 + (((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % 26));
    const name = () => `${Array.from({ length: 12 }, letter).join("")}.com`;
    const big = mutant("prod", (d) =>
      editText(d, "rules/baseline.json", (t) => {
        const b = JSON.parse(t);
        for (let i = 0; i < 400; i++) b.aliases.push({ s: Array.from({ length: 32 }, name) });
        return `${JSON.stringify(b, null, 2)}\n`;
      }),
    );
    expect(big.ok).toBe(false);
    expect(big.out).toMatch(/rules\/baseline\.json is \d+ B gz, over its budget of 65536 B/);
    expect(big.out).not.toMatch(/not a baseline bundle the extension accepts|not in the form/); // only its size
    const huge = mutant("prod", (d) =>
      editText(d, "rules/baseline.json", (t) => `${t.replace(/\n$/, "")}${" ".repeat(1024 * 1024)}\n`),
    );
    expect(huge.ok).toBe(false);
    expect(huge.out).toMatch(
      /rules\/baseline\.json is not a baseline bundle the extension accepts: larger than 1048576 bytes/,
    );
  }, 120_000);
  it("the Fill chunk imported statically by the popup fails", () => {
    const r = mutant("prod", (d) =>
      editText(d, popupChunk(d), (t) => `import"./${asset(d, /^Fill-[\w-]+\.js$/).slice(7)}";${t}`),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/popup\/index\.html loads Fill-.* statically/);
  });
  it("the Fill text imported statically by the side panel fails", () => {
    const r = mutant("prod", (d) =>
      editText(
        d,
        asset(d, /^sidepanel-(?!locale)[\w-]+\.js$/),
        (t) => `import"./${asset(d, /^autofill-locale-en-[\w-]+\.js$/).slice(7)}";${t}`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/sidepanel\/index\.html loads autofill-locale-en-.* statically/);
  });
  it("the settings page reaching the Fill chunk fails", () => {
    const r = mutant("prod", (d) =>
      editText(
        d,
        asset(d, /^options-(?!locale)[\w-]+\.js$/),
        (t) => `${t}\n/* ${asset(d, /^Fill-[\w-]+\.js$/).slice(7)} */`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/the settings page can load Fill-/);
  });
  it("a Fill chunk over its limit, gzipped (12 KB), fails in a store and an e2e build (AF3-3b's review)", () => {
    // letters no compressor can shorten (a fixed seed): 9,000 of them, about 5.5 KB gzipped, over the chunk's headroom
    let seed = 11;
    const letter = () => String.fromCharCode(97 + (((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % 26));
    const pad = Array.from({ length: 9000 }, letter).join("");
    for (const f of ["prod", "e2e"] as Flavour[]) {
      const pristine = check(built[f], f).out.match(
        /Fill button chunk: \d+ B gz, with the site rules' reader it loads \(\d+ B gz\): (\d+) B/,
      );
      expect(Number(pristine?.[1]), f).toBeLessThan(12288);
      // the pad in the Fill chunk, or in the reader it loads: the two are held together (AF3-4)
      for (const at of [(d: string) => asset(d, /^Fill-[\w-]+\.js$/), readerChunk]) {
        const r = mutant(f, (d) => editText(d, at(d), (t) => `${t}\n/* ${pad} */\n`));
        expect(r.ok, f).toBe(false);
        expect(r.out, f).toMatch(
          /assets\/Fill-[\w-]+\.js: the Fill button chunk with the site rules' reader it loads is \d+ B gz, over its limit of 12288 B/,
        );
      }
    }
  });
  it('the "same sign-in" chunk (AF3-4): lazy only, one, within 2 KB gz', () => {
    let seed = 5;
    const letter = () => String.fromCharCode(97 + (((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % 26));
    const pad = Array.from({ length: 4000 }, letter).join("");
    const cases: [string, (d: string) => void, RegExp][] = [
      [
        "over its limit",
        (d) => editText(d, asset(d, /^aliases-[\w-]+\.js$/), (t) => `${t}\n/* ${pad} */\n`),
        /assets\/aliases-[\w-]+\.js: the "same sign-in" chunk is \d+ B gz, over its limit of 2048 B/,
      ],
      [
        "missing",
        (d) => rmSync(join(d, asset(d, /^aliases-[\w-]+\.js$/))),
        /expected one "same sign-in" chunk assets\/aliases-\*\.js, found 0/,
      ],
      [
        "imported statically by the side panel",
        (d) =>
          editText(
            d,
            asset(d, /^sidepanel-(?!locale)[\w-]+\.js$/),
            (t) => `import"./${asset(d, /^aliases-[\w-]+\.js$/).slice(7)}";${t}`,
          ),
        /sidepanel\/index\.html loads aliases-.* statically/,
      ],
    ];
    for (const [what, alter, msg] of cases) {
      const r = mutant("prod", alter);
      expect(r.ok, what).toBe(false);
      expect(r.out, what).toMatch(msg);
    }
  });
  it("a missing Fill chunk, a missing Fill text, one over its limit, or one that differs from the generated catalog fails", () => {
    let r = mutant("prod", (d) => rmSync(join(d, asset(d, /^Fill-[\w-]+\.js$/))));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/expected one Fill button chunk/);
    r = mutant("prod", (d) => rmSync(join(d, asset(d, /^autofill-locale-zh_CN-[\w-]+\.js$/))));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/expected one Fill text chunk/);
    r = mutant("prod", (d) =>
      editText(d, asset(d, /^autofill-locale-en-[\w-]+\.js$/), (t) =>
        t.replace(
          "export{",
          `var pad=\`${Array.from({ length: 6000 }, () => Math.random().toString(36).slice(2)).join("")}\`;export{`,
        ),
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/over its limit/);
    r = mutant("prod", (d) =>
      editText(d, asset(d, /^autofill-locale-zh_CN-[\w-]+\.js$/), (t) => t.replace("afFill:", "afFillX:")),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/differs from catalogs\/autofill-zh_CN\.json/);
  });
  it("the tests' hook named in a prod build fails", () => {
    const r = mutant("prod", (d) => editText(d, "sw.js", (t) => `${t}\nglobalThis.__skFill=1;`));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/dev marker in a prod build: __skFill/);
  });
});

describe("check-dist: the in-page suggestion's release gate, both ways (AUTOFILL2 patch 4a; scripts/suggest-ui.mjs)", () => {
  // Every mark check-dist holds the gate to (its `marks` table), each with a same-length stand-in that keeps the script
  // valid. A mark dropped from check-dist, or left out here, fails the first case (the 4a-r2 review's S-1).
  const MARKS: Record<string, string> = {
    "sk-af-open": "sk-af-xpen", // the click's message
    "[0-9A-F]{32}": "[0-9A-F]{31}", // request v2's document
    sk_sug_shown: "sk_sug_xhown", // the worker's records
    "fill-page-go": "fill-page-xo", // the Fill strip's line for a page's request
    pinLength: "pinLengtx", // the lock screen's line
    afSugGo: "afSugGx", // the Fill strip's text
    lastPress: "lastPresx", // the surface's input delay (a property, renamed everywhere alike)
  };
  const scriptsOf = (dir: string): string[] => [
    "sw.js",
    ...readdirSync(join(dir, "assets"))
      .filter((n) => n.endsWith(".js"))
      .map((n) => `assets/${n}`),
  ];

  it("its marks are check-dist's, every one", () => {
    const src = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
    const table = src.slice(src.indexOf("  const marks = {"), src.indexOf("  };", src.indexOf("  const marks = {")));
    const keys = [...table.matchAll(/^ {4}(?:"([^"]+)"|([A-Za-z_]\w*)): \[/gm)].map((m) => m[1] ?? m[2]);
    expect(keys.sort()).toEqual(Object.keys(MARKS).sort());
  });

  it("the pristine builds say where the gate is: out of the store build, in the e2e build, each mark where it belongs", () => {
    expect(check(built.prod, "prod").out).toContain(
      "in-page suggestion: out (release gate SUGGEST_UI_IN_STORE_BUILD = false)",
    );
    expect(check(built.e2e, "e2e").out).toContain("in-page suggestion: in");
    for (const mark of Object.keys(MARKS)) {
      const named = (dir: string) => scriptsOf(dir).some((f) => readFileSync(join(dir, f), "utf8").includes(mark));
      expect(named(built.prod), `${mark}: in no script of the store build`).toBe(false);
      expect(named(built.e2e), `${mark}: in a script of the e2e build`).toBe(true);
    }
  });

  it("a store build that names any mark fails, for each mark: the gate closed, what it lets in is not there", () => {
    const r = mutant("prod", (d) =>
      editText(d, "sw.js", (t) => `${t}\n;globalThis.x=${JSON.stringify(Object.keys(MARKS))};`),
    );
    expect(r.ok).toBe(false);
    for (const mark of Object.keys(MARKS))
      expect(r.out, mark).toContain(
        `sw.js: names \`${mark}\` in a build whose release gate keeps the in-page suggestion out`,
      );
  });

  it("an e2e build that lacks any mark fails, for each mark: the gate open, each part is where it belongs", () => {
    const r = mutant("e2e", (d) => {
      for (const f of scriptsOf(d))
        editText(d, f, (t) => Object.entries(MARKS).reduce((x, [mark, stand]) => x.replaceAll(mark, stand), t));
    });
    expect(r.ok).toBe(false);
    for (const mark of Object.keys(MARKS))
      expect(r.out, mark).toContain(`names \`${mark}\` in a build whose release gate lets the in-page suggestion in`);
  });
});

describe("check-dist: the content script with the in-page suggestion's release gate open (AUTOFILL2 patch 4b)", () => {
  const SUGGEST = "inject/suggest.js";
  const add = (code: string) => (d: string) => editText(d, SUGGEST, (t) => `${t}\n${code}`);
  const cases: [string, (d: string) => void, RegExp][] = [
    ["a third message", add('chrome.runtime.sendMessage({type:"sk-af-x"});'), /its two messages must be exactly/],
    [
      "a message of another shape",
      (d) => editText(d, SUGGEST, (t) => t.replace(/(["'`])sk-af-open\1/, '"sk-af-open",tab:1')),
      /its two messages must be exactly/,
    ],
    ["storage", add("chrome.storage.local.get(null);"), /the content script may not contain/],
    ["a timer", add("setTimeout(()=>0,1);"), /the content script may not contain/],
    ["innerHTML", add('document.body.innerHTML="";'), /the content script may not contain/],
    ["textContent", add('document.body.textContent="";'), /the content script may not contain/],
    ["an attribute set", add('document.body.setAttribute("x","1");'), /the content script may not contain/],
    ["a style written", add('document.body.style.color="red";'), /the content script may not contain/],
    ["a focus", add("document.body.focus();"), /the content script may not contain/],
    ["a click", add("document.body.click();"), /the content script may not contain/],
    ["postMessage", add('window.postMessage(1,"*");'), /the content script may not contain/],
    ["fetch", add('fetch("/x");'), /the content script may not contain/],
    ["the console", add("console.log(1);"), /the content script may not contain/],
    [
      "a second chrome API",
      add("chrome.tabs.query({});"),
      /its chrome APIs must be runtime.sendMessage and i18n.getMessage/,
    ],
    [
      "a named font family before the generic one (a page's @font-face could take it)",
      (d) => editText(d, SUGGEST, (t) => t.replace("system-ui,sans-serif", '"PingFang SC",system-ui,sans-serif')),
      /its one font must be the generic system-ui,sans-serif/,
    ],
    [
      "a named font family alone",
      (d) => editText(d, SUGGEST, (t) => t.replace("system-ui,sans-serif", "Arial")),
      /its one font must be the generic system-ui,sans-serif/,
    ],
  ];
  for (const [what, alter, msg] of cases)
    it(`e2e: ${what} fails`, () => {
      const r = mutant("e2e", alter);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(msg);
    });
  it("the e2e build carries the record of its decisions; the dev build (the gate open too) may not", () => {
    expect(readFileSync(join(built.e2e, SUGGEST), "utf8")).toContain("__skSugLog");
    expect(check(built.dev, "dev").ok).toBe(true);
    const r = mutant("dev", add("globalThis.__skSugLog=1;"));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/the record of the suggestion's decisions \(__skSugLog\) is the e2e build's alone/);
    const s = mutant("e2e", (d) => editText(d, SUGGEST, (t) => t.replaceAll("__skSugLog", "__skSugLoq")));
    expect(s.ok).toBe(false);
    expect(s.out).toMatch(/is the e2e build's alone/);
  });
  it("the store build's content script stays patch 3's: none of the suggestion is in it", () => {
    const t = readFileSync(join(built.prod, SUGGEST), "utf8");
    for (const mark of ["sk-af-open", "attachShadow", "IntersectionObserver", "afSugFill", "system-ui"])
      expect(t, mark).not.toContain(mark);
  });
});
