// AF3-4t (docs/design/notes/BUDGET-NOTES.md §9): what the popup and the side panel never draw is kept out of the files they
// count. The settings page's chips and code box (src/options/base.css), the Add view's choices (src/popup/main/add.css,
// loaded with its lazy chunk) and the settings page's own icons (src/options/icons.tsx). In the sources: each moved rule
// and icon in one place only, and drawn only where it now lives. In a real store build: none of them in a counted file,
// each where it now lives, the Add view's stylesheet loaded with its chunk before the chunk runs; and check-dist refuses a
// copy of the build that brings one back, or loses one (as sidepanel-check-dist.test.ts does for its rules).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { VNode } from "preact";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Icon as SettingsIcon, type IconName } from "../../src/options/icons";
import { Icon as SharedIcon } from "../../src/ui/icons";
import { selectorsOf } from "../../scripts/css-selectors.mjs";

const EXT = resolve(__dirname, "../..");
const SRC = resolve(EXT, "src");
const read = (p: string) => readFileSync(resolve(EXT, p), "utf8");
const work = mkdtempSync(join(tmpdir(), "sixkey-budget4t-check-dist-"));
const built = join(work, "prod");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));

/**
 * The selectors of a stylesheet's rules (one per entry of a list), written as the minifier writes them: check-dist's own
 * reader (scripts/css-selectors.mjs), so the two read a stylesheet alike (AF3-4t's review; done with AF3-4).
 */
const selectors = selectorsOf;
const SETTINGS_RULES = selectors(read("src/options/base.css"));
const ADD_RULES = selectors(read("src/popup/main/add.css"));
const ICONS = [
  ...(/const OWN = \{([\s\S]*?)\} as const;/.exec(read("src/options/icons.tsx"))?.[1] ?? "").matchAll(
    /^\s*(\w+):\s*"([^"]+)",?$/gm,
  ),
].map((m) => ({ name: m[1]!, d: m[2]! }));

const files: { path: string; text: string }[] = [];
(function walk(dir: string) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(n))
      files.push({ path: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
  }
})(SRC);
/** The words of every class attribute of a module (its text, or the words of the expression it is made of). */
function classWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bclass(?:Name)?=(?:"([^"]*)"|\{)/g)) {
    let body = m[1];
    if (body === undefined) {
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      for (; i < text.length && depth; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
      body = text.slice(start, i - 1);
    }
    for (const w of body.split(/[^A-Za-z0-9_-]+/)) if (w) out.add(w);
  }
  return out;
}
/** The modules that draw `cls` (a class attribute names it), or the stylesheets that have a rule for it. */
const naming = (cls: string, ext: RegExp) =>
  files
    .filter((f) =>
      ext.test(f.path) && f.path.endsWith(".css")
        ? new RegExp(`\\.${cls}(?![\\w-])`).test(f.text.replace(/\/\*[\s\S]*?\*\//g, ""))
        : ext.test(f.path) && classWords(f.text).has(cls),
    )
    .map((f) => f.path);

describe("the sources: each moved rule and icon in one place, drawn only where it now lives", () => {
  it("the settings page's chips and code box: in src/options/base.css alone, imported right after ../ui/styles.css", () => {
    expect(SETTINGS_RULES).toEqual([
      ".chip",
      ".chip:empty",
      ".chip:before",
      ".chip.ok",
      ".chip.warn",
      ".chip.bad",
      ".code-box",
      ".code-box:after",
      ".code-box i",
    ]);
    for (const f of ["ui/styles.css", "popup/popup.css", "sidepanel/panel.css"])
      for (const sel of selectors(read(`src/${f}`))) expect(SETTINGS_RULES, `${f}: ${sel}`).not.toContain(sel);
    // the classes are named by the settings page's modules and stylesheets only (dchips, the edit dialog's, is another)
    for (const cls of ["chip", "code-box"]) {
      const users = naming(cls, /\.tsx?$/);
      expect(users.length, cls).toBeGreaterThan(0);
      expect(
        users.filter((u) => !u.startsWith("options/")),
        cls,
      ).toEqual([]);
      expect(
        naming(cls, /\.css$/).filter((u) => !u.startsWith("options/")),
        cls,
      ).toEqual([]);
    }
    expect(read("src/options/main.tsx")).toMatch(
      /import "\.\.\/ui\/styles\.css";\nimport "\.\/base\.css";\nimport "\.\/options\.css";/,
    );
  });
  it("the Add view's choices: in its own add.css, which AddMenu.tsx alone imports and nothing else draws", () => {
    const own = ADD_RULES.filter((s) => /^\.(opts?|oi|ot|chev|opts-foot)\b/.test(s));
    expect(own).toEqual([
      ".opts",
      ".opt",
      ".opt:hover",
      ".opt:hover .chev",
      ".oi",
      ".opt.primary .oi",
      ".ot",
      ".ot b",
      ".ot small",
      ".chev",
      ".opts-foot",
      ".opts-foot .ic",
    ]);
    for (const f of ["ui/styles.css", "popup/popup.css", "sidepanel/panel.css"])
      for (const sel of selectors(read(`src/${f}`))) expect(ADD_RULES, `${f}: ${sel}`).not.toContain(sel);
    for (const cls of ["opt", "oi", "ot", "chev", "opts-foot"])
      expect(naming(cls, /\.tsx?$/), cls).toEqual(["popup/main/AddMenu.tsx"]);
    // the side panel's own rule places the view's list (`order`), which the view's rules do not set
    expect(naming("opts", /\.tsx?$/)).toEqual(["popup/main/AddMenu.tsx"]);
    expect(read("src/popup/main/add.css")).not.toMatch(/\border\s*:/);
    expect(files.filter((f) => /import "\.\/add\.css"/.test(f.text)).map((f) => f.path)).toEqual([
      "popup/main/AddMenu.tsx",
    ]);
    // and the dead rule is gone: no screen of the popup draws a code box
    expect(read("src/popup/popup.css")).not.toMatch(/code-box/);
  });
  it("the settings page's own icons: in src/options/icons.tsx alone, drawn only by the settings page", () => {
    expect(ICONS.map((i) => i.name)).toEqual(["link", "file", "moon", "dice", "enter", "pulse", "archive", "sync"]);
    const shared = read("src/ui/icons.tsx");
    for (const { name, d } of ICONS) {
      expect(shared, name).not.toContain(d);
      expect(shared, name).not.toMatch(new RegExp(`^\\s+${name}:`, "m"));
    }
    // every module of the settings page takes Icon from its own table; no other module does
    const importing = (target: string) =>
      files
        .filter((f) =>
          [...f.text.matchAll(/from "(\.{1,2}\/[^"]+)"/g)].some(
            (m) => posix.join(posix.dirname(f.path), m[1]!) === target,
          ),
        )
        .map((f) => f.path);
    // exactly the settings page's modules that draw one (not vacuous: there are many)
    const drawers = files
      .filter((f) => f.path.startsWith("options/") && f.path !== "options/icons.tsx" && /<Icon\b/.test(f.text))
      .map((f) => f.path);
    expect(drawers.length).toBeGreaterThan(15);
    expect([...importing("options/icons")].sort()).toEqual([...drawers].sort());
    expect(importing("options/icons").filter((p) => !p.startsWith("options/"))).toEqual([]);
    expect(importing("ui/icons").filter((p) => p.startsWith("options/"))).toEqual(["options/icons.tsx"]);
    // a moved name in a module outside the settings page could only be another thing than an icon: none draws one
    for (const { name } of ICONS)
      for (const f of files.filter((x) => /\.tsx$/.test(x.path) && !x.path.startsWith("options/")))
        expect(f.text, `${f.path}: ${name}`).not.toMatch(new RegExp(`<Icon[^>]*name="${name}"`));
  });
});

describe("the selector reader (scripts/css-selectors.mjs): check-dist's and these tests'", () => {
  it("each entry of a list on its own, as the minifier writes it; comments and at-rules' heads are no selectors", () => {
    expect(
      selectorsOf(
        "/* .x{} */.a, .b > .c::before{color:red}:is(.d, .e) .f{}@media (max-width: 9px){.g  .h{}}.i::first-line{}",
      ),
    ).toEqual([".a", ".b>.c:before", ":is(.d, .e) .f", ".g .h", ".i:first-line"]);
  });
  it("a keyframes block's steps are no selectors: from, to, percentages, alone or in a list", () => {
    expect(
      selectorsOf(
        "@keyframes k{from{opacity:0}50%{opacity:.5}to{opacity:1}}@keyframes j{0%,100%{x:0}12.5%{x:1}}.after{}",
      ),
    ).toEqual([".after"]);
    // as the minifier writes an animation beside a rule of the same page: only the rule is one
    expect(selectorsOf(".chip{a:b}@keyframes pulse{0%{a:b}to{a:c}}.chip.ok{a:b}")).toEqual([".chip", ".chip.ok"]);
    // a class or element whose name merely starts so is a selector
    expect(selectorsOf(".from{}.to-do{}tofu{}")).toEqual([".from", ".to-do", "tofu"]);
  });
});

describe("the settings page's Icon", () => {
  type Props = Record<string, unknown> & { children?: VNode<Record<string, unknown>> };
  /** What the shared Icon draws for `props`: its svg's stroke and its one path's data. */
  const drawn = (props: Props) => {
    const svg = SharedIcon(props as never) as VNode<Props>;
    return { stroke: svg.props["stroke-width"], d: svg.props.children!.props.d, cls: svg.props.class };
  };
  it("draws its own icons by their path, the shared ones by name, both with the shared Icon on the same pen", () => {
    for (const { name, d } of ICONS) {
      const v = SettingsIcon({ name: name as IconName, size: 18, class: "x" }) as VNode<Props>;
      expect(v.type, name).toBe(SharedIcon);
      expect(v.props, name).toMatchObject({ d, size: 18, class: "x" });
      expect(v.props.name, name).toBeUndefined();
      expect(drawn(v.props), name).toEqual({ stroke: 1.75, d, cls: "ic x" });
    }
    const lock = SettingsIcon({ name: "lock" }) as VNode<Props>;
    expect(lock.type).toBe(SharedIcon);
    expect(lock.props).toMatchObject({ name: "lock" });
    expect(lock.props.d).toBeUndefined();
    expect(drawn(lock.props).d).toMatch(/^M6\.5 10\.5h11/);
    // the heavier pen of the dot glyphs is the shared table's, by name, as before
    expect(drawn({ name: "more" }).stroke).toBe(3);
    expect(drawn({ name: "lock" }).stroke).toBe(1.75);
  });
});

/** Every local script and stylesheet a page's HTML names: what check-dist counts for the popup and the side panel. */
const counted = (dir: string, page: string) => {
  const html = join(dir, page);
  return [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
    (m) => resolve(dirname(html), m[1]!),
  );
};
function check(dir: string) {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", "--dist", dir], { cwd: EXT, encoding: "utf8", env });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
let n = 0;
function mutant(alter: (dir: string) => void) {
  const dir = join(work, `m${++n}`);
  cpSync(built, dir, { recursive: true });
  alter(dir);
  try {
    return check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const edit = (f: string, fn: (t: string) => string) => writeFileSync(f, fn(readFileSync(f, "utf8")));
const asset = (dir: string, re: RegExp) =>
  join(
    dir,
    "assets",
    readdirSync(join(dir, "assets")).find((x) => re.test(x))!,
  );

beforeAll(() => {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", "--out", built], { cwd: EXT, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("a real store build", () => {
  it("none of them in a file the popup or the side panel counts; each where it now lives", () => {
    const mine = new Set([...counted(built, "popup/index.html"), ...counted(built, "sidepanel/index.html")]);
    const cssOut = [...mine].filter((f) => f.endsWith(".css")).flatMap((f) => selectors(readFileSync(f, "utf8")));
    for (const sel of [...SETTINGS_RULES, ...ADD_RULES]) expect(cssOut, sel).not.toContain(sel);
    for (const f of [...mine].filter((x) => x.endsWith(".js")))
      for (const { name, d } of ICONS) expect(readFileSync(f, "utf8").includes(d), `${name} in ${f}`).toBe(false);
    // the settings page's stylesheets hold its rules, the Add view's stylesheet its own
    const options = counted(built, "options/index.html");
    const optionsCss = options.filter((f) => f.endsWith(".css")).flatMap((f) => selectors(readFileSync(f, "utf8")));
    for (const sel of SETTINGS_RULES) expect(optionsCss, sel).toContain(sel);
    const addCss = selectors(readFileSync(asset(built, /^AddMenu-[\w-]+\.css$/), "utf8"));
    for (const sel of ADD_RULES) expect(addCss, sel).toContain(sel);
    // and the settings page's scripts its icons
    const optionsJs = readdirSync(join(built, "assets"))
      .filter((x) => x.endsWith(".js"))
      .map((x) => readFileSync(join(built, "assets", x), "utf8"))
      .filter((t) => ICONS.every(({ d }) => t.includes(d)));
    expect(optionsJs.length).toBeGreaterThan(0);
  });
  it("the Add view's stylesheet is loaded with its chunk, before the chunk runs (no frame without its styles)", () => {
    // the bundler's preload: import() of the view goes through the helper with the view's stylesheet among its files
    const boot = readFileSync(asset(built, /^boot-[\w-]+\.js$/), "utf8");
    const deps = JSON.parse(/m\.f=(\[[^\]]*\])/.exec(boot)![1]!.replace(/'/g, '"')) as string[];
    const call = /\(\)=>import\(`\.\/(AddMenu-[\w-]+\.js)`\),__vite__mapDeps\(\[([\d,]+)\]\)/.exec(boot);
    expect(call).not.toBeNull();
    const named = call![2]!.split(",").map((i) => deps[Number(i)]);
    expect(named).toContain(`./${call![1]}`);
    expect(named.filter((x) => /^\.\/AddMenu-[\w-]+\.css$/.test(x!))).toHaveLength(1);
    // the helper appends a stylesheet link and waits for its load before it runs the import
    const helper = readdirSync(join(built, "assets"))
      .filter((x) => x.endsWith(".js"))
      .map((x) => readFileSync(join(built, "assets", x), "utf8"))
      .find((t) => t.includes("Unable to preload CSS for"))!;
    // (the minifier's names aside): a stylesheet link appended, a promise that waits for its load, the import run after
    expect(helper).toMatch(/\.rel=\w+\?`stylesheet`:/);
    expect(helper).toMatch(
      /return new Promise\(\((\w),(\w)\)=>\{(\w)\.addEventListener\(`load`,\1\),\3\.addEventListener\(`error`/,
    );
    expect(helper).toMatch(
      /return (\w)\.then\((\w)=>\{for\(let (\w) of \2\|\|\[\]\)\3\.status===`rejected`&&(\w)\(\3\.reason\);return (\w)\(\)\.catch\(\4\)\}\)/,
    );
  });
  it("check-dist passes the build and says what it kept out", () => {
    const r = check(built);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(
      new RegExp(
        `kept out of the popup's and the side panel's counted files: ${new Set([...SETTINGS_RULES, ...ADD_RULES]).size} rules \\(src/options/base\\.css, src/popup/main/add\\.css\\), 8 icons \\(src/options/icons\\.tsx\\)`,
      ),
    );
  });
  for (const [what, alter, msg] of [
    [
      "a settings rule back in the stylesheet both pages share",
      (d: string) => edit(asset(d, /^shortcut-[\w-]+\.css$/), (t) => `${t}.chip{color:red}`),
      /the rule \.chip of src\/options\/base\.css in a stylesheet the popup or the side panel counts/,
    ],
    [
      "the code box's mark back in the popup's own stylesheet",
      (d: string) => edit(asset(d, /^boot-[\w-]+\.css$/), (t) => `${t}.code-box:after{content:""}`),
      /the rule \.code-box:after of src\/options\/base\.css in a stylesheet/,
    ],
    [
      "an Add view rule back in the side panel's own stylesheet",
      (d: string) => edit(asset(d, /^sidepanel-[\w-]+\.css$/), (t) => `${t}.opt:hover .chev{color:red}`),
      /the rule \.opt:hover \.chev of src\/popup\/main\/add\.css in a stylesheet/,
    ],
    [
      "a settings icon back in the script both pages share",
      (d: string) => edit(asset(d, /^shortcut-[\w-]+\.js$/), (t) => `${t}\nvar __i=${JSON.stringify(ICONS[2]!.d)};`),
      /the settings page's icon moon in a script the popup or the side panel counts/,
    ],
    [
      "a settings rule lost from every shipped stylesheet",
      (d: string) => {
        for (const x of readdirSync(join(d, "assets")).filter((f) => f.endsWith(".css")))
          edit(join(d, "assets", x), (t) => t.replace(/\.chip\.warn\{[^}]*\}/g, ""));
      },
      /the rule \.chip\.warn of src\/options\/base\.css is in no stylesheet the build ships outside the counted ones/,
    ],
  ] as const)
    it(`fails: ${what}`, () => {
      const r = mutant(alter);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(msg);
    });
});
