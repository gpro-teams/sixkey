// The message-key collector (scripts/catalog-keys.mjs) on small projects written to a temporary folder. Each case
// checks the exact keys traced from catalog reads (`traced`), which the real tree's fallback (every mentioned key is
// kept) would hide, and the exact keys kept; the cases that must not build check the problem reported. Many keys here
// exist only as template text, a + concatenation, an identifier property or a module behind import(), so a collector
// that skips one of them loses a key and fails.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CatalogKeysError,
  collectKeys,
  tsOptions,
  type AllowEntry,
  type Collected,
} from "../../scripts/catalog-keys.mjs";

const OPTIONS = tsOptions(resolve(__dirname, "../../tsconfig.json")); // the real libs and types
const I18N = `let catalog: Record<string, { message: string }> = {};
export function use(c: Record<string, { message: string }>): void { catalog = c; }
export function t(key: string, ...subs: (string | number)[]): string { return (catalog[key]?.message ?? key) + subs.join(""); }
`;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Files = Record<string, string>;
function project(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-keys-"));
  dirs.push(dir);
  for (const [f, text] of Object.entries({ "i18n.ts": I18N, ...files })) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}
const entryOf = (files: Files) => (files["main.tsx"] !== undefined ? "main.tsx" : "main.ts");
function collect(files: Files, keys: string[], allow: AllowEntry[] = [], root = project(files)): Collected {
  return collectKeys({
    root,
    entries: [entryOf(files)],
    keys,
    catalogModule: "i18n.ts",
    allow,
    compilerOptions: OPTIONS,
  });
}
function problems(files: Files, keys: string[], allow: AllowEntry[] = []): string[] {
  try {
    collect(files, keys, allow);
  } catch (e) {
    if (e instanceof CatalogKeysError) return e.problems;
    throw e;
  }
  throw new Error("expected the collector to stop");
}
const sorted = (a: string[]) => [...a].sort();

describe("catalog-keys: tracing catalog reads", () => {
  it("literals, conditionals, ?? / || / && fallbacks, parentheses and constants; unused keys are dropped", () => {
    const keys = [
      "kLit",
      "kYes",
      "kNo",
      "kDefault",
      "kAnd",
      "kOr",
      "kConst",
      "kLet",
      "kParen",
      "kMentioned",
      "kUnused",
    ];
    const r = collect(
      {
        "main.ts": `import { t } from "./i18n";
const K = "kConst";
let L = "kLet";
export const note = "kMentioned";
export function show(c: boolean, r: string | undefined) {
  return [t("kLit"), t(c ? "kYes" : "kNo"), t(r ?? "kDefault"), t((c && "kAnd") || "kOr"), t(K), t(L), t((("kParen")) as string)];
}`,
      },
      keys,
    );
    expect(sorted(r.traced)).toEqual(
      sorted(["kLit", "kYes", "kNo", "kDefault", "kAnd", "kOr", "kConst", "kLet", "kParen"]),
    );
    expect(r.keys).toEqual(keys.filter((k) => k !== "kUnused")); // catalog order; the mention is kept as the fallback
    expect(r.lookups).toBe(1);
  });

  it("an errors.ts-shaped table: function returns, members, destructuring, a parameter fed by call sites, a template value", () => {
    const keys = [
      "kRead",
      "kNextRestore",
      "kUnknown",
      "kNextRetry",
      "kWhatA",
      "kNextA",
      "kDynX",
      "kDynY",
      "kSettings",
      "kAdvanced",
      "kBackup",
      "kKindFail",
      "kKindPlain",
      "kKindOther",
      "kDzz",
    ];
    const r = collect(
      {
        "main.ts": `import { t } from "./i18n";
type Entry = { what: string; next: string };
const READ: Entry = { what: "kRead", next: "kNextRestore" };
const UNKNOWN: Entry = { what: "kUnknown", next: "kNextRetry" };
const part = "D" + "yn";
const TABLE: Record<string, Entry> = { a_code: { what: "kWhatA", next: "kNextA" }, unreadable: READ, dynamic: { what: \`k\${part}\${String(1)}\`, next: "kNextA" } };
function entryOf(code: string): Entry {
  for (const k of [code]) if (Object.hasOwn(TABLE, k)) return TABLE[k]!;
  return UNKNOWN;
}
const place = (title: string) => \`\${t("kSettings")} › \${t(title)}\`;
const SUBS: Record<string, () => string> = { kNextRetry: () => place("kAdvanced"), kNextRestore: () => place("kBackup") };
export function describeError(e: string) {
  const { what, next } = entryOf(e);
  return { what: t(what), next: t(next, SUBS[next]?.() ?? "") };
}
const KIND_LABEL: Record<string, string> = { unlock_failed: "kKindFail", export_plain: "kKindPlain" };
export const kind = (k: string) => t(KIND_LABEL[k] ?? "kKindOther");`,
      },
      keys,
    );
    // k\${...}\${...} is the family k*: every key starting with k. The template is the only way kDynX/kDynY/kDzz are named.
    expect(sorted(r.traced)).toEqual(sorted(keys));
    expect(r.families.map((f) => f.pattern)).toEqual(["k*"]);
  });

  it("map / forEach callbacks over constant arrays take the right column; Object.keys / entries and for-in give names", () => {
    const keys = [
      "scan",
      "kOptScan",
      "kOptScanD",
      "kOptUp",
      "kOptUpD",
      "kProp1",
      "kProp2",
      "kVal1",
      "kVal2",
      "kIn1",
      "kIn2",
      "kName1",
    ];
    const r = collect(
      {
        "main.ts": `import { t } from "./i18n";
const OPTIONS = [["scan", "kOptScan", "kOptScanD"], ["upload", "kOptUp", "kOptUpD"]] as const;
export const render = () => OPTIONS.map(([id, a, b], i) => \`\${id}\${i}\${t(a)}\${t(b)}\`);
const LABELS = { kProp1: 1, kProp2: 2 };
export const names = () => Object.keys(LABELS).map((k) => t(k));
const MAP = { one: "kVal1", two: "kVal2" };
export const vals = () => Object.entries(MAP).forEach(([, key]) => t(key));
const IN = { kIn1: true, kIn2: true };
export function each() { for (const k in IN) t(k); }
const PEOPLE = [{ name: "kName1", age: 3 }];
export const people = () => PEOPLE.filter((p) => p.age > 1).map((p) => t(p.name));`,
      },
      keys,
    );
    expect(sorted(r.traced)).toEqual(sorted(keys.filter((k) => k !== "scan"))); // "scan" is the id column, never looked up
    expect(r.keys).toContain("scan"); // ... but it is mentioned, so it stays
  });

  it("a table written to after it is made: assignments, push, splice, Object.assign", () => {
    const keys = ["kindA", "kindB", "kindNone", "kPushed1", "kSpliced", "kAssigned", "kOther"];
    const r = collect(
      {
        "main.ts": `import { t } from "./i18n";
const LABELS: Record<string, string> = {};
for (const k of ["A", "B"]) LABELS[k] = \`kind\${k}\`;
export const lab = (k: string) => t(LABELS[k] ?? "kindNone");
const LIST: string[] = [];
LIST.push(\`kPushed\${1}\`);
LIST.splice(0, 0, \`kSpl\${"iced"}\`);
export const first = () => t(LIST[0]!);
const MORE = {};
Object.assign(MORE, { a: \`kAss\${"igned"}\` });
export const more = (k: string) => t((MORE as Record<string, string>)[k]!);`,
      },
      keys,
    );
    expect(sorted(r.traced)).toEqual(sorted(keys.filter((k) => k !== "kOther")));
  });

  it("parameters: a local helper, a function exported to another module, a default, JSX props of a component", () => {
    const keys = ["kJsx1", "kJsx2", "kJsx3", "kJsxSub", "kViaExport", "kFallback", "kTwice"];
    const r = collect(
      {
        "main.tsx": `import { t } from "./i18n";
import { label } from "./labels";
function Title({ k, sub }: { k: string; sub?: string }) { return <h1>{t(k)}{sub && t(sub)}</h1>; }
const twice = (key: string) => t(key) + t(key);
export const view = (c: boolean) => <div><Title k="kJsx1" /><Title k={c ? "kJsx2" : "kJsx3"} sub="kJsxSub" />{label("kViaExport")}{twice("kTwice")}</div>;`,
        "labels.ts": `import { t } from "./i18n";
export function label(key: string, fallback = "kFallback") { return t(key) || t(fallback); }`,
      },
      keys,
    );
    expect(sorted(r.traced)).toEqual(sorted(keys));
  });

  it.each([
    [
      "an object's method",
      `const o = { f(k: string) { return t(k); } };\nexport const a = (n: number) => o.f(\`kM\${n}\`);`,
    ],
    [
      "an object's arrow function",
      `const o = { f: (k: string) => t(k) };\nexport const a = (n: number) => o.f(\`kM\${n}\`);`,
    ],
    [
      "a method copied by a spread",
      `const base = { f(k: string) { return t(k); } };\nconst o = { ...base };\nexport const a = (n: number) => o.f(\`kM\${n}\`);`,
    ],
    [
      "a class method",
      `class C { f(k: string) { return t(k); } }\nexport const a = (n: number) => new C().f(\`kM\${n}\`);`,
    ],
  ])("parameters of %s: its calls through the object are its call sites", (_name, body) => {
    const r = collect({ "main.ts": `import { t } from "./i18n";\n${body}` }, ["kM1", "kM2", "kOther"]);
    expect(r.traced).toEqual(["kM1", "kM2"]);
  });

  it("template literals and + concatenations keep their whole family, and only it", () => {
    const keys = [
      "err",
      "errA",
      "errLong_2",
      "er",
      "xerrA",
      "alphaTitle",
      "Title",
      "betaTitle",
      "titleX",
      "cat",
      "cat1",
      "catX",
      "dog",
      "premid",
      "preAmidB",
      "prexmidy",
      "prmid",
      "pre",
      "mid",
    ];
    const r = collect(
      {
        "main.ts": `import { t } from "./i18n";
export const f = (code: string, kind: string, n: number) => [t(\`err\${code}\`), t(\`\${kind}Title\`), t("cat" + n), t(\`pre\${code}mid\${kind}\`)];`,
      },
      keys,
    );
    expect(sorted(r.traced)).toEqual(
      sorted([
        "err",
        "errA",
        "errLong_2",
        "alphaTitle",
        "Title",
        "betaTitle",
        "cat",
        "cat1",
        "catX",
        "premid",
        "preAmidB",
        "prexmidy",
      ]),
    );
    expect(r.keys).not.toContain("er");
    expect(r.keys).not.toContain("xerrA");
    expect(r.keys).not.toContain("titleX");
    expect(r.keys).not.toContain("prmid");
    expect(sorted(r.families.map((x) => x.pattern))).toEqual(sorted(["err*", "*Title", "cat*", "pre*mid*"]));
  });
});

describe("catalog-keys: modules", () => {
  it("follows lazy chunks (nested), shared modules, re-exports, renamed and namespace imports, side-effect imports; not import type", () => {
    const keys = [
      "kAlias",
      "kNs",
      "kReexport",
      "kWords",
      "kLazy",
      "kLazier",
      "kSide",
      "kShared",
      "kTypeOnly",
      "kLazyTpl1",
    ];
    const r = collect(
      {
        "main.ts": `import { t as tr } from "./i18n";
import * as I from "./i18n";
import { say, speak } from "./reexport";
import type { Shape } from "./types-only";
import "./side";
import { shared } from "./shared";
export const a = (s: Shape) => [tr("kAlias"), I.t("kNs"), say("kReexport"), speak(\`kWo\${"rds"}\`), shared(), s.a];
export const later = () => import("./lazy");`,
        "reexport.ts": `export { t as say } from "./i18n";
export { speak } from "./words";`,
        "words.ts": `import { t } from "./i18n";
export const speak = (k: string) => t(k);`, // reached only through the re-export
        "lazy.ts": `import { t } from "./i18n";
import { shared } from "./shared";
export const l = (n: number) => [t("kLazy"), t(\`kLazyTpl\${n}\`), shared(), import("./sub/lazier")];`,
        "sub/lazier.ts": `import { t } from "../i18n";
export const z = () => t("kLazier");`,
        "side.ts": `import { t } from "./i18n";
document.title = t("kSide");`,
        "shared.ts": `import { t } from "./i18n";
export const shared = () => t("kShared");`,
        "types-only.ts": `import { t } from "./i18n";
export type Shape = { a: string };
export const unused = () => t("kTypeOnly");`,
      },
      keys,
    );
    expect(r.modules).toEqual([
      "i18n.ts",
      "lazy.ts",
      "main.ts",
      "reexport.ts",
      "shared.ts",
      "side.ts",
      "sub/lazier.ts",
      "words.ts",
    ]);
    expect(sorted(r.traced)).toEqual(sorted(keys.filter((k) => k !== "kTypeOnly")));
    expect(r.keys).not.toContain("kTypeOnly");
  });

  it("keeps every mentioned key as the fallback: JSX text and attributes, identifier properties, enum members, imported JSON", () => {
    const keys = ["kEnum", "kIdentProp", "kAttr", "kJsxText", "kJson", "kJsonName", "kMethod", "kNot"];
    const r = collect(
      {
        "main.tsx": `import "./i18n";
import data from "./data.json";
enum Kinds { kEnum = 1 }
const o = { kIdentProp: 1, kMethod() { return 1; } };
export const v = () => [<b title="kAttr">kJsxText</b>, data, o, Kinds.kEnum];
// kNot is only in this comment`,
        "data.json": JSON.stringify({ kJsonName: ["kJson"] }),
      },
      keys,
    );
    expect(r.traced).toEqual([]);
    expect(r.keys).toEqual(keys.filter((k) => k !== "kNot"));
  });

  it("a function nothing in the page calls cannot run there, so its lookups need no key", () => {
    const r = collect(
      { "main.ts": `import { t } from "./i18n";\nexport const unused = (x: string, y: string) => t(x + y);` },
      ["kA"],
    );
    expect(r.traced).toEqual([]);
  });

  it("works it out afresh on every call: a key added to the source is there the next time", () => {
    const files: Files = { "main.ts": `import { t } from "./i18n";\nexport const a = () => t("kOld");` };
    const root = project(files);
    expect(collect(files, ["kOld", "kNew"], [], root).keys).toEqual(["kOld"]);
    writeFileSync(
      join(root, "main.ts"),
      `import { t } from "./i18n";\nexport const a = () => [t("kOld"), t(\`kN\${"ew"}\`)];`,
    );
    expect(collect(files, ["kOld", "kNew"], [], root).keys).toEqual(["kOld", "kNew"]);
  });
});

describe("catalog-keys: what it cannot follow stops it", () => {
  const keys = ["kA", "kB", "kFam1", "kFam2"];
  const main = (body: string) => ({ "main.ts": `import { t } from "./i18n";\n${body}` });
  it.each([
    ["t used as a value", `export const a = () => ["kA"].map(t);`, /t is used as a value/],
    ["t passed in an object", `export const o = { t };`, /t is used as a value/],
    ["a family that matches no key", `export const a = (x: string) => t(\`zz\${x}\`);`, /matches no message key/],
    [
      "a + of two unknowns",
      `const a = (x: string, y: string) => t(x + y);\nexport const b = () => a(String(Date.now()), String(Math.random()));`,
      /a \+ of values it cannot trace/,
    ],
    [
      "a template with no fixed text",
      `export const a = (x: string, y: string) => t(\`\${x}\${y}\`);`,
      /could be any key/,
    ],
    [
      "a string that is not a key",
      `export const a = () => t("notAKey");`,
      /"notAKey" reaches the catalog but is not a message key/,
    ],
    [
      "a value from storage",
      `export const a = () => t(localStorage.getItem("k") ?? "kA");`,
      /cannot tell which message keys localStorage\.getItem\("k"\) can hold/,
    ],
    ["a string method", `export const a = () => t("KA".toLowerCase());`, /a string built by \.toLowerCase\(\)/],
    [
      "a reassigned let",
      `let k = "kA";\nexport function s() { k = String(Date.now()); }\nexport const a = () => t(k);`,
      /k is reassigned/,
    ],
    [
      "a cycle",
      `function f(k: string, n: number): string { return n ? f(k, n - 1) : t(k); }\nexport const a = () => f("kA", 2);`,
      /depends on itself/,
    ],
    [
      "a callback to a function it does not know",
      `function run(f: (k: string) => string) { return f("kA"); }\nexport const a = () => run((k) => t(k));`,
      /a callback passed to run/,
    ],
    [
      "a method called through a typed object",
      `interface Api { f(k: string): string }\nconst o: Api = { f(k: string) { return t(k); } };\nexport const a = (n: number) => o.f(\`kM\${n}\`);`,
      /cannot see every use of f: main\.ts:4:\d+ may be it/,
    ],
    [
      "a method taken out by destructuring",
      `const o = { f(k: string) { return t(k); } };\nconst { f } = o;\nexport const a = (n: number) => f(\`kM\${n}\`);`,
      /f may be taken out of an object/,
    ],
    [
      "a use by a name in quotes",
      `function lab(k: string) { return t(k); }\nexport const a = (m: Record<string, (k: string) => string>) => [lab("kA"), m["lab"]!("kB")];`,
      /cannot see every use of lab/,
    ],
    [
      "a use the checker cannot resolve",
      `function lab(k: string) { return t(k); }\nexport const a = () => [lab("kA"), (globalThis as any).x.lab("kB")];`,
      /cannot see every use of lab/,
    ],
    [
      "a message from elsewhere",
      `chrome.runtime.onMessage.addListener((m: { key: string }) => { t(m.key); });`,
      /a callback passed to chrome\.runtime\.onMessage\.addListener/,
    ],
    [
      "an import() of a computed name",
      `export const a = (n: string) => import(n);`,
      /import\(\) of a computed specifier/,
    ],
  ])("%s", (_name, body, re) => {
    expect(problems(main(body), keys).join("\n")).toMatch(re);
  });

  it("a full catalog imported by page code", () => {
    const p = problems(
      { ...main(`export const c = () => import("./_locales/en/messages.json");`), "_locales/en/messages.json": "{}" },
      keys,
    );
    expect(p.join("\n")).toMatch(/imports the full catalog _locales\/en\/messages\.json/);
  });
  it("the catalog read in a way it cannot follow, or not there at all", () => {
    expect(
      problems(
        { ...main(`export const a = () => t("kA");`), "i18n.ts": I18N + "export const all = () => catalog;\n" },
        keys,
      ).join("\n"),
    ).toMatch(/the catalog is used in a way/);
    expect(
      problems(
        { ...main(`export const a = () => t("kA");`), "i18n.ts": I18N.replaceAll("catalog", "texts") },
        keys,
      ).join("\n"),
    ).toMatch(/no top-level variable catalog/);
  });
});

describe("catalog-keys: the allowlist", () => {
  const keys = ["kA", "kB", "kFam1", "kFam2", "kOther"];
  const files = {
    "main.ts": `import { t } from "./i18n";\nexport const a = () => t(localStorage.getItem("k") ?? "kA");`,
  };
  it("an entry for the exact expression adds its keys and families", () => {
    const r = collect(files, keys, [
      { file: "main.ts", code: `localStorage.getItem("k")`, keys: ["kB"], families: ["kFam*"], why: "test" },
    ]);
    expect(sorted(r.traced)).toEqual(["kA", "kB", "kFam1", "kFam2"]);
  });
  it("an entry that matches nothing, or names a key that does not exist, stops it", () => {
    expect(
      problems(files, keys, [
        { file: "main.ts", code: `localStorage.getItem("k")`, keys: ["kB"], why: "x" },
        { file: "main.ts", code: "nothing()", why: "stale" },
      ]).join("\n"),
    ).toMatch(/"nothing\(\)" matched nothing/);
    expect(
      problems(files, keys, [{ file: "main.ts", code: `localStorage.getItem("k")`, keys: ["kZ"], why: "x" }]).join(
        "\n",
      ),
    ).toMatch(/kZ is not a message key/);
  });
});

describe("catalog-keys: a release gate (rule 5, the in-page suggestion's)", () => {
  const files = {
    "main.tsx": `import { t } from "./i18n";
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;
const OTHER = Math.random() > 2;
function Line({ say }: { say: string }) { return say; }
export function view(n: number) {
  return [t("kAlways"), SUGGEST_UI && Line({ say: t("kGated") }), SUGGEST_UI && "kGatedMention", OTHER && t("kOther"), n > 1 && t("kCond")];
}`,
  };
  const keys = ["kAlways", "kGated", "kGatedMention", "kOther", "kCond"];
  it("the gate open (or not said): everything behind it is the page's", () => {
    const r = collect(files, keys);
    expect(sorted(r.keys)).toEqual(sorted(keys));
  });
  it("the gate closed: what only `SUGGEST_UI && ...` holds is not, and nothing else changes", () => {
    const r = collectKeys({
      root: project(files),
      entries: ["main.tsx"],
      keys,
      catalogModule: "i18n.ts",
      compilerOptions: OPTIONS,
      suggestUi: false,
    });
    expect(sorted(r.keys)).toEqual(sorted(["kAlways", "kOther", "kCond"]));
  });
  it("only a constant declared as the gate is read: another SUGGEST_UI skips nothing", () => {
    const other = {
      "main.tsx": files["main.tsx"]!.replace(
        'const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;',
        "const SUGGEST_UI = Math.random() > 0.5;",
      ),
    };
    const r = collectKeys({
      root: project(other),
      entries: ["main.tsx"],
      keys,
      catalogModule: "i18n.ts",
      compilerOptions: OPTIONS,
      suggestUi: false,
    });
    expect(sorted(r.keys)).toEqual(sorted(keys));
  });
});

describe("catalog-keys: parts of a page (rule 6)", () => {
  // A page whose core is main.tsx and whose part "sec" is sec.tsx, both using shared.tsx (the settings page's shape).
  const files: Files = {
    "main.tsx": `import { t } from "./i18n";
import { Section } from "./sec";
import { Title } from "./shared";
export const page = () => <div>{t("kCore")}<Title k="kCoreTitle" /><Section level={2} /></div>;`,
    "sec.tsx": `import { t } from "./i18n";
import { Title } from "./shared";
const line = (k: string) => t(k);
export function Section({ level }: { level: number }) { return <p>{t("kSec")}<Title k="kSecTitle" />{line("kSecLine")}{t(\`kLevel\${level}\`)}</p>; }`,
    "shared.tsx": `import { t } from "./i18n";
export function Title({ k }: { k: string }) { return <h2>{t(k)}</h2>; }`,
  };
  const keys = ["kCore", "kCoreTitle", "kSec", "kSecTitle", "kSecLine", "kLevel1", "kLevel2", "kOther"];
  const run = (fs: Files, o: { entries: string[]; stop?: string[]; part?: boolean }, root = project(fs)) =>
    collectKeys({ root, keys, catalogModule: "i18n.ts", compilerOptions: OPTIONS, ...o });

  it("stop: the core leaves the part's module out, with what only its calls pass to shared code", () => {
    const core = run(files, { entries: ["main.tsx"], stop: ["sec.tsx"] });
    expect(core.modules).not.toContain("sec.tsx");
    expect(sorted(core.traced)).toEqual(["kCore", "kCoreTitle"]);
    expect(sorted(core.keys)).toEqual(["kCore", "kCoreTitle"]);
    const whole = run(files, { entries: ["main.tsx"] }); // without it, everything is the page's
    expect(sorted(whole.keys)).toEqual(sorted(keys.filter((k) => k !== "kOther")));
  });

  it("part: its own calls into shared code are traced, and a template's family is kept", () => {
    const sec = run(files, { entries: ["sec.tsx"], part: true });
    expect(sorted(sec.traced)).toEqual(sorted(["kSec", "kSecTitle", "kSecLine", "kLevel1", "kLevel2"]));
  });

  it("part: a key the page passes into the part's exported component cannot be seen, so it fails", () => {
    const leaky: Files = {
      ...files,
      "sec.tsx": `import { t } from "./i18n";
export function Section({ title }: { title: string }) { return <p>{t(title)}</p>; }`,
    };
    let problems: string[] = [];
    try {
      run(leaky, { entries: ["sec.tsx"], part: true });
    } catch (e) {
      if (e instanceof CatalogKeysError) problems = e.problems;
      else throw e;
    }
    expect(problems.join("\n")).toMatch(
      /Section is exported by the part's entry sec\.tsx and drawn from outside the part/,
    );
    // without part mode the same graph quietly finds nothing to trace: the case rule 6 exists for
    expect(run(leaky, { entries: ["sec.tsx"] }).traced).toEqual([]);
  });

  it("part: the same for a function an entry exports as a member of an object", () => {
    const leaky: Files = {
      ...files,
      "sec.tsx": `import { t } from "./i18n";
export const views = { title(k: string) { return t(k); } };`,
    };
    expect(() => run(leaky, { entries: ["sec.tsx"], part: true })).toThrow(/title is exported by the part's entry/);
  });

  it("pageCatalogs: the page's own catalog files are text, not mentions", () => {
    const withCatalog: Files = {
      ...files,
      "main.tsx": `${files["main.tsx"]}\nexport const load = async () => (await import("./catalogs/core.json")).default;`,
      "catalogs/core.json": JSON.stringify({ kOther: { message: "x" } }),
    };
    const root = project(withCatalog);
    const mentioned = run(withCatalog, { entries: ["main.tsx"], stop: ["sec.tsx"] }, root);
    expect(mentioned.keys).toContain("kOther"); // any other JSON's strings are mentions (rule 2)
    const own = collectKeys({
      root,
      keys,
      catalogModule: "i18n.ts",
      compilerOptions: OPTIONS,
      entries: ["main.tsx"],
      stop: ["sec.tsx"],
      pageCatalogs: (f) => f.endsWith("/catalogs/core.json"),
    });
    expect(own.keys).not.toContain("kOther");
  });
});
