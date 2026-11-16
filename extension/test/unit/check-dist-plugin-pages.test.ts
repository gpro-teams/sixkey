// scripts/plugin-pages.mjs, check-dist's rule on where the plugin platform's text and code can load (PLUGINS-W2A-NOTES.md
// §2; the W2a review's W2A-05), against small builds made up here, no real build needed: the three pages, a shared chunk,
// each kind of page's lazy plugin chunk and its text per language. The pristine one passes; each of the review's ways to
// break it (BP-1 to BP-3, and its mutant R16) and the rule's other cases fail with their line. m5-check-dist.test.ts
// holds a real build to the rule once (BP-3), so check-dist is known to call it. Wave 2b: the change list's text, which
// only the change list's own view (assets/plugin-changes-*.js) may name (PLUGINS-W2B-NOTES.md §2), and its ways to break.
// Since the plugin platform was removed the build has one kind, the autofill switch's (plugins); the made-up builds here
// keep the three kinds the platform had (KINDS), which still take the rule down every one of its branches.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PLUGIN_TEXT_KINDS, pluginPageProblems, POPUP_PAGES, SETTINGS_PAGE } from "../../scripts/plugin-pages.mjs";

const work = mkdtempSync(join(tmpdir(), "sixkey-plugin-pages-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const POPUP_TEXT = ["plugins-popup-locale-en-AAAA.js", "plugins-popup-locale-zh_CN-BBBB.js"];
const SETTINGS_TEXT = ["plugins-locale-en-CCCC.js", "plugins-locale-zh_CN-DDDD.js"];
const CHANGES_TEXT = ["plugins-changes-locale-en-EEEE.js", "plugins-changes-locale-zh_CN-FFFF.js"];
/** The three kinds the plugin platform had: the rule's every branch, `from` included. */
const KINDS = [
  { name: "plugins", pages: SETTINGS_PAGE, not: POPUP_PAGES },
  { name: "plugins-popup", pages: POPUP_PAGES, not: SETTINGS_PAGE },
  { name: "plugins-changes", pages: POPUP_PAGES, not: SETTINGS_PAGE, from: "plugin-changes-" },
];
const textsOf = new Map([
  ["plugins", SETTINGS_TEXT],
  ["plugins-popup", POPUP_TEXT],
  ["plugins-changes", CHANGES_TEXT],
]);
const page = (entry: string, preload = "") =>
  `<!doctype html><html><head><script type="module" crossorigin src="../assets/${entry}"></script>${
    preload ? `<link rel="modulepreload" crossorigin href="../assets/${preload}">` : ""
  }</head><body></body></html>`;
const loader = (names: string[]) =>
  `const t={${names.map((n, i) => `l${i}:()=>import("./${n}")`).join(",")}};export{t};`;
/** A build as the real one is laid out (pages, entry chunks, a shared chunk, lazy plugin chunks, their text). */
const PRISTINE: Record<string, string> = {
  "popup/index.html": page("popup-a1.js", "shared-d1.js"),
  "sidepanel/index.html": page("sidepanel-b1.js", "shared-d1.js"),
  "options/index.html": page("options-c1.js", "shared-d1.js"),
  "assets/shared-d1.js": `export const x=1;`,
  "assets/popup-a1.js": `import{x}from"./shared-d1.js";const m=()=>import("./Plugins-p1.js");`,
  "assets/sidepanel-b1.js": `import"./shared-d1.js";const m=()=>import("./Plugins-p1.js");`,
  "assets/options-c1.js": `import{x as y}from"./shared-d1.js";const m=()=>import("./Plugins-o1.js");`,
  "assets/Plugins-p1.js": `${loader(POPUP_TEXT)}const k="sk_plugins_overlay";chrome.runtime.connect("x");const v=()=>import("./plugin-changes-q1.js");`,
  "assets/Plugins-o1.js": `${loader(SETTINGS_TEXT)}const k="sk_plugins_overlay";`,
  "assets/plugin-changes-q1.js": loader(CHANGES_TEXT),
  ...Object.fromEntries(
    [...POPUP_TEXT, ...SETTINGS_TEXT, ...CHANGES_TEXT].map((n) => [
      `assets/${n}`,
      `export default {"pxMenu":"Plugins"};`,
    ]),
  ),
};
let n = 0;
/** The pristine build with `change` applied (a file's new text, or null to take it out), and the rule's problems. */
function problems(change: Record<string, string | null | ((t: string) => string)> = {}): string[] {
  const dir = join(work, `b${++n}`);
  const files = { ...PRISTINE };
  for (const [f, c] of Object.entries(change)) {
    if (c === null) delete files[f];
    else files[f] = typeof c === "function" ? c(files[f] ?? "") : c;
  }
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return pluginPageProblems(dir, textsOf, KINDS);
}

describe("scripts/plugin-pages.mjs: each kind of page reaches its own plugin text only (W2A-05)", () => {
  it("the build's kinds: the autofill switch's text, the settings page's alone", () => {
    expect(SETTINGS_PAGE).toEqual(["options/index.html"]);
    expect(POPUP_PAGES).toEqual(["popup/index.html", "sidepanel/index.html"]);
    expect(PLUGIN_TEXT_KINDS).toEqual([
      { name: "plugins", pages: ["options/index.html"], not: ["popup/index.html", "sidepanel/index.html"] },
    ]);
  });
  it("the pristine build: nothing to say", () => {
    expect(problems()).toEqual([]);
  });
  it("BP-1: the settings page's plugin chunk also imports the popup's text module", () => {
    expect(
      problems({
        "assets/popup-text-e1.js": loader(POPUP_TEXT),
        "assets/Plugins-o1.js": (t) => `${t}const pt=()=>import("./popup-text-e1.js");`,
      }),
    ).toEqual(POPUP_TEXT.map((x) => `options/index.html can load ${x}, another kind of page's plugin text`));
  });
  it("BP-2: the popup's plugin chunk also imports the settings page's text module (the popup and the side panel)", () => {
    expect(
      problems({
        "assets/text-f1.js": loader(SETTINGS_TEXT),
        "assets/Plugins-p1.js": (t) => `${t}const st=()=>import("./text-f1.js");`,
      }),
    ).toEqual(
      ["popup/index.html", "sidepanel/index.html"].flatMap((p) =>
        SETTINGS_TEXT.map((x) => `${p} can load ${x}, another kind of page's plugin text`),
      ),
    );
  });
  it("BP-3: the settings page's entry chunk names the popup's catalog file (a preload list, a string)", () => {
    expect(problems({ "assets/options-c1.js": (t) => `${t}const p=["${POPUP_TEXT[1]}"];` })).toEqual([
      `options/index.html can load ${POPUP_TEXT[1]}, another kind of page's plugin text`,
    ]);
  });
  it("its own text out of reach, or loaded statically: said, page by page", () => {
    expect(
      problems({
        "assets/Plugins-p1.js": `${loader(POPUP_TEXT.slice(0, 1))}const v=()=>import("./plugin-changes-q1.js");`,
      }),
    ).toEqual(
      ["popup/index.html", "sidepanel/index.html"].map(
        (p) => `${p} cannot load ${POPUP_TEXT[1]} (the plugins' entries)`,
      ),
    );
    expect(problems({ "assets/options-c1.js": (t) => `import"./${SETTINGS_TEXT[0]}";${t}` })).toEqual([
      `options/index.html loads ${SETTINGS_TEXT[0]} statically; the plugins' text loads with their lazy chunks`,
    ]);
    expect(problems({ "popup/index.html": page("popup-a1.js", POPUP_TEXT[0]) })).toEqual([
      `popup/index.html loads ${POPUP_TEXT[0]} statically; the plugins' text loads with their lazy chunks`,
    ]);
  });
  it("the platform's store or a port in a page's static graph: said for each page that loads it", () => {
    const all = ["popup/index.html", "sidepanel/index.html", "options/index.html"];
    expect(problems({ "assets/shared-d1.js": `export const x="sk_plugins_overlay";` })).toEqual(
      all.map((p) => `${p} loads the plugin platform statically (shared-d1.js); it loads lazily`),
    );
    expect(problems({ "assets/popup-a1.js": (t) => `${t}chrome.runtime.connect("x");` })).toEqual([
      "popup/index.html loads the plugin platform statically (popup-a1.js); it loads lazily",
    ]);
  });
  it("a page the build does not have is not looked at; another origin's script is not followed", () => {
    expect(problems({ "sidepanel/index.html": null })).toEqual([]);
    const remote = `<script type="module" src="https://example.com/assets/${POPUP_TEXT[0]}"></script>`;
    expect(problems({ "options/index.html": (t) => t.replace("</head>", `${remote}</head>`) })).toEqual([]);
    expect(readFileSync(join(work, `b${n}`, "options/index.html"), "utf8")).toContain("https://example.com/");
  });
  it("W2b: the change list's text named by a chunk that is not the change list's view", () => {
    expect(problems({ "assets/Plugins-p1.js": (t) => `${t}const c=()=>import("./${CHANGES_TEXT[0]}");` })).toEqual([
      `Plugins-p1.js names ${CHANGES_TEXT[0]}; only the view plugin-changes-*.js loads the plugins-changes text`,
    ]);
    // a chunk the settings page shares, too: so it can reach the change list's text as well
    expect(problems({ "assets/shared-d1.js": `export const x=["${CHANGES_TEXT[1]}"];` })).toEqual([
      `shared-d1.js names ${CHANGES_TEXT[1]}; only the view plugin-changes-*.js loads the plugins-changes text`,
      `options/index.html can load ${CHANGES_TEXT[1]}, another kind of page's plugin text`,
    ]);
  });
  it("W2b: the change list's view reached from the settings page, or with no view at all", () => {
    expect(problems({ "assets/Plugins-o1.js": (t) => `${t}const v=()=>import("./plugin-changes-q1.js");` })).toEqual(
      CHANGES_TEXT.map((x) => `options/index.html can load ${x}, another kind of page's plugin text`),
    );
    expect(
      problems({
        "assets/plugin-changes-q1.js": null,
        "assets/Plugins-p1.js": (t) => t.replace(`import("./plugin-changes-q1.js")`, `import("./other-r1.js")`),
        "assets/other-r1.js": loader(CHANGES_TEXT),
      }),
    ).toEqual([
      "no plugin-changes-*.js chunk: the view that loads the plugins-changes text",
      ...CHANGES_TEXT.map(
        (x) => `other-r1.js names ${x}; only the view plugin-changes-*.js loads the plugins-changes text`,
      ),
    ]);
  });
  it("W2b: the change list's view in a page's static graph", () => {
    expect(problems({ "popup/index.html": page("popup-a1.js", "plugin-changes-q1.js") })).toEqual([
      "popup/index.html loads plugin-changes-q1.js statically; the change list's view loads lazily",
    ]);
  });
});
