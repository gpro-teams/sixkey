// The site rules' updater in scripts/check-dist.mjs (TOTP autofill Stage 3, AF3-U1 and AF3-U2; docs/design/notes/
// AUTOFILL3-NOTES.md §9, §10; the plan's §4.6, S7, S9, R5): a prod build (the gate closed) and an e2e build (the gate
// open) are made once; each pristine one passes, and copies altered to break one rule fail with that rule's message, or
// pass where the rule does not hold for that build. These are the check's own mutants, kept as tests.
//   - gate closed: no shipped file names the signed manifest's format, the record's database, a rules origin, the
//     switch's key, the updater's two messages or the switch's words, and no switch chunk is there (AF3-U2);
//   - gate open (AF3-U2): each mark where it belongs and nowhere else (the database, the manifest's format, the switch's
//     key and the origin in the worker; `sk-af-rule` in the worker and the Fill chunk; `sk-af-rules-status` in the worker
//     and the switch's chunk), the switch's chunk loaded by the settings page alone and its text the generated file; the
//     CSP with exactly the rules path; the worker's one more fetch; the format's checker in the reader and the worker,
//     with the e2e build's reserved test hosts in both;
//   - every build: the database's name in the worker's script alone, never in a page's;
//   - the worker's size: the e2e build's limit has the updater's room (RULES_UPDATER_GZ), the store build's never does,
//     whatever its gate (scripts/sw-budget.mjs; the maintainers' C33);
//   - a store build: no test signing key (its kid, its SPKI in base64 or base64url, its point in hex or base64url, a line
//     of its private PEM), whatever the gate.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_RULES_KEYS } from "../../scripts/rules-keys.mjs";
import { RULES_UPDATER_GZ, SW_BUDGET_GZ, swBudgetOf } from "../../scripts/sw-budget.mjs";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-rules-update-dist-"));
const built = { prod: join(work, "prod"), e2e: join(work, "e2e") };
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
/**
 * Put `text` into the shipped file `f`, changing nothing else: a comment in a script or a style, a comment after a page's
 * markup, the manifest's description.
 */
const append = (f: string, text: string) => (dir: string) => {
  const t = readFileSync(join(dir, f), "utf8");
  if (f === "manifest.json") {
    const j = JSON.parse(t);
    j.description = `${j.description} ${text}`;
    writeFileSync(join(dir, f), JSON.stringify(j, null, 2));
  } else writeFileSync(join(dir, f), f.endsWith(".html") ? `${t}\n<!-- ${text} -->\n` : `${t}\n/* ${text} */\n`);
};
const asset = (dir: string, re: RegExp) => `assets/${readdirSync(join(dir, "assets")).find((x) => re.test(x))!}`;
/** The Fill chunk, the page chunk that asks the worker for a live bundle's rule (AF3-U2). */
const fill = (f: Flavour) => asset(built[f], /^Fill-[\w-]+\.js$/);
/** The popup's and the side panel's shared counted chunk, a page chunk the updater has nothing in. */
const boot = (f: Flavour) => asset(built[f], /^boot-[\w-]+\.js$/);
/** Replace every `from` in the file `f` by `to` (the file must hold it). */
const swap = (f: string, from: string | RegExp, to: string) => (dir: string) => {
  const t = readFileSync(join(dir, f), "utf8");
  const next = typeof from === "string" ? t.split(from).join(to) : t.replace(from, to);
  if (next === t) throw new Error(`${f} does not hold ${from}`);
  writeFileSync(join(dir, f), next);
};
/** Append incompressible text to the worker until its gzip size is over `limit`. */
const overWorker = (limit: number) => (dir: string) => {
  let t = readFileSync(join(dir, "sw.js"), "utf8");
  while (gzipSync(t).length <= limit) t += `\n/* ${randomBytes(1500).toString("base64")} */`;
  writeFileSync(join(dir, "sw.js"), t);
};
const css = (f: Flavour) => asset(built[f], /\.css$/);

beforeAll(() => {
  build("prod");
  build("e2e");
}, 240_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the pristine builds pass, and say where the updater is", () => {
  it("prod: out; e2e: in", () => {
    const p = check(built.prod, "prod");
    expect(p.out).toContain("site rules' updater: out (release gate RULES_UPDATE_IN_STORE_BUILD = false)");
    expect(p.ok, p.out).toBe(true);
    const e = check(built.e2e, "e2e");
    expect(e.out).toContain("site rules' updater: in (release gate RULES_UPDATE_IN_STORE_BUILD = false)");
    expect(e.ok, e.out).toBe(true);
  });
});

describe("gate closed (the store build): none of the updater's marks in any shipped file", () => {
  const closed = (file: string, mark: string) =>
    new RegExp(
      `${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: names \`${mark.replace(/\./g, "\\.")}\` in a build whose release gate keeps the site rules' updater out \\(scripts/rules-update\\.mjs\\)`,
    );
  for (const mark of ["sixkey-rules-manifest", "sixkey-rules-live", "rules.fix.test"])
    it(`${mark}: in the worker, the Fill chunk, a style sheet, the manifest, a page's HTML`, () => {
      // (the manifest and the pages: the review's N1; a gate-open build's CSP names the rules origin there, AF3-U2)
      for (const f of ["sw.js", fill("prod"), css("prod"), "manifest.json", "options/index.html"]) {
        const r = mutant("prod", append(f, mark));
        expect(r.ok, `${mark} in ${f}`).toBe(false);
        expect(r.out).toMatch(closed(f, mark));
      }
    });
  it("the same marks in the e2e build (gate open): in the worker, allowed; the rules origin's bare host anywhere (it is a test rule's host too)", () => {
    for (const mark of ["sixkey-rules-manifest", "sixkey-rules-live", "rules.fix.test"]) {
      const r = mutant("e2e", append("sw.js", mark));
      expect(r.ok, `${mark} in sw.js: ${r.out}`).toBe(true);
    }
    expect(mutant("e2e", append(fill("e2e"), "rules.fix.test")).ok).toBe(true);
  });
  // AF3-U2's marks
  for (const mark of [
    "sk_rules_switch",
    "sk-af-rule",
    "sk-af-rules-status",
    "Get the latest site rules",
    "网站规则：自带，版本",
  ])
    it(`${mark}: in the worker, the Fill chunk, the manifest, a page's HTML`, () => {
      const named = mark === "sk-af-rules-status" ? "sk-af-rule" : mark; // the one mark covers both messages
      for (const f of ["sw.js", fill("prod"), "manifest.json", "options/index.html"]) {
        const r = mutant("prod", append(f, mark));
        expect(r.ok, `${mark} in ${f}`).toBe(false);
        expect(r.out).toMatch(closed(f, named));
      }
    });
  it("the switch's chunk or its text chunk, by name", () => {
    for (const n of ["RulesUpdate-AbCd1234.js", "rules-update-locale-en-AbCd1234.js"]) {
      const r = mutant("prod", (dir) => writeFileSync(join(dir, "assets", n), "export{};\n"));
      expect(r.ok, n).toBe(false);
      expect(r.out).toContain(
        `assets/${n}: the site rules' updater's switch in a build whose release gate keeps the updater out`,
      );
    }
  });
});

describe("gate open (the e2e build): each mark where it belongs, and nowhere else (AF3-U2)", () => {
  const belongs = (file: string, mark: string) =>
    new RegExp(`${file.replace(/[.\-]/g, "\\$&")}: names \`${mark}\`, which belongs to `);
  it("the manifest's format, the database, the switch's key, the origin: in a page's chunk, refused", () => {
    for (const mark of ["sixkey-rules-manifest", "sk_rules_switch", "https://rules.fix.test"]) {
      const r = mutant("e2e", append(boot("e2e"), mark));
      expect(r.ok, mark).toBe(false);
      expect(r.out, mark).toMatch(belongs(boot("e2e"), mark));
    }
  });
  it("the two messages: `sk-af-rule` in the worker and the Fill chunk only, `sk-af-rules-status` in the worker and the switch's chunk only", () => {
    const sw = asset(built.e2e, /^RulesUpdate-[\w-]+\.js$/);
    for (const [mark, f] of [
      ["sk-af-rule", boot("e2e")],
      ["sk-af-rule", sw],
      ["sk-af-rules-status", fill("e2e")],
      ["sk-af-rules-status", boot("e2e")],
    ] as const) {
      const r = mutant("e2e", append(f, `"${mark}"`));
      expect(r.ok, `${mark} in ${f}`).toBe(false);
      expect(r.out, `${mark} in ${f}`).toMatch(belongs(f, mark));
    }
  });
  it("each mark missing where it must be: refused", () => {
    for (const [f, from, to, mark] of [
      ["sw.js", "sk_rules_switch", "sk_rules_swatch", "sk_rules_switch"],
      ["sw.js", "sixkey-rules-manifest", "sixkey-rules-manefist", "sixkey-rules-manifest"],
      ["sw.js", "https://rules.fix.test", "https://rulez.fix.test", "https://rules.fix.test"],
      [fill("e2e"), "sk-af-rule`", "sk-af-ruel`", "sk-af-rule"],
      ["sw.js", '"sk-af-rules-status"', '"sk-af-rules-statsu"', "sk-af-rules-status"],
    ] as const) {
      const r = mutant("e2e", swap(f, from, to));
      expect(r.ok, `${mark} gone from ${f}`).toBe(false);
      expect(r.out, `${mark} gone from ${f}`).toContain(`names \`${mark}\` (the site rules' updater)`);
    }
  });
  it("the switch's chunk: loaded by the settings page alone; its text: exactly the generated file, loaded by the switch alone", () => {
    const chunk = asset(built.e2e, /^RulesUpdate-[\w-]+\.js$/);
    const name = chunk.slice("assets/".length);
    const r1 = mutant("e2e", append(boot("e2e"), `import("./${name}")`));
    expect(r1.ok).toBe(false);
    expect(r1.out).toContain(
      `${boot("e2e")}: loads the site rules' switch (${chunk}), which the settings page alone loads`,
    );
    const text = asset(built.e2e, /^rules-update-locale-en-[\w-]+\.js$/);
    const r2 = mutant("e2e", swap(text, "Get the latest site rules", "Get the newest site rules"));
    expect(r2.ok).toBe(false);
    expect(r2.out).toContain(`${text.slice("assets/".length)} differs from catalogs/rules-en.json`);
    const r3 = mutant("e2e", (dir) => unlinkSync(join(dir, text)));
    expect(r3.ok).toBe(false);
    expect(r3.out).toContain("locale en: expected one site rules' switch text chunk");
    const r4 = mutant("e2e", append(fill("e2e"), text.slice("assets/".length)));
    expect(r4.ok).toBe(false);
    expect(r4.out).toContain(`loads the site rules' switch text (${text}), which the switch's chunk alone loads`);
    const r5 = mutant("e2e", (dir) => unlinkSync(join(dir, chunk)));
    expect(r5.ok).toBe(false);
    expect(r5.out).toContain("expected one site rules' switch chunk assets/RulesUpdate-*.js, found 0");
  });
  it("the switch's four rules, each alone (round 2, the review's MY5): loaded with a page; loaded by no settings script; its text over its budget; a text key of the full catalog", () => {
    const chunk = asset(built.e2e, /^RulesUpdate-[\w-]+\.js$/);
    const name = chunk.slice("assets/".length);
    const text = asset(built.e2e, /^rules-update-locale-en-[\w-]+\.js$/);
    // with a page: the popup's page loads it as a script of its own
    const r1 = mutant("e2e", (dir) => {
      const f = join(dir, "popup/index.html");
      writeFileSync(
        f,
        readFileSync(f, "utf8").replace("</head>", `<script type="module" src="../${chunk}"></script></head>`),
      );
    });
    expect(r1.ok).toBe(false);
    expect(r1.out).toContain(`${chunk}: the switch's chunk is loaded with a page`);
    // by no script of the settings page: its name gone from every script that names it
    const r2 = mutant("e2e", (dir) => {
      for (const f of readdirSync(join(dir, "assets")).filter((n) => n.endsWith(".js") && n !== name)) {
        const t = readFileSync(join(dir, "assets", f), "utf8");
        if (t.includes(name)) writeFileSync(join(dir, "assets", f), t.split(name).join("RulesUpdate-gone.js"));
      }
    });
    expect(r2.ok).toBe(false);
    expect(r2.out).toContain(`${chunk}: no script of the settings page loads the switch's chunk`);
    // its text over 2,048 B gz (a comment no compressor shortens; the catalog it exports is the same)
    const r3 = mutant("e2e", (dir) => {
      const f = join(dir, text);
      writeFileSync(f, `${readFileSync(f, "utf8")}\n/* ${randomBytes(3000).toString("base64")} */\n`);
    });
    expect(r3.ok).toBe(false);
    expect(r3.out).toMatch(/site rules' switch text en is \d+ B gz, over its limit of 2048 B/);
    expect(r3.out).not.toContain("differs from catalogs/rules-en.json");
    // one of its keys a key of the full catalog too
    const r4 = mutant("e2e", (dir) => {
      const f = join(dir, "_locales/en/messages.json");
      const m = JSON.parse(readFileSync(f, "utf8"));
      m.ruTitle = { message: "Get the latest site rules" };
      writeFileSync(f, JSON.stringify(m, null, 2));
    });
    expect(r4.ok).toBe(false);
    expect(r4.out).toContain("site rules' switch text en: ruTitle is also a key of the full catalog");
  });
  it("the CSP: exactly the rules origin's /v1/ path more; without it, or with more, refused", () => {
    const csp = (to: (c: string) => string) => (dir: string) => {
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      m.content_security_policy.extension_pages = to(m.content_security_policy.extension_pages);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
    };
    expect(readFileSync(join(built.e2e, "manifest.json"), "utf8")).toContain("connect-src https://rules.fix.test/v1/;");
    for (const [what, to] of [
      ["without the path", (c: string) => c.replace(" https://rules.fix.test/v1/", "")],
      ["the whole origin", (c: string) => c.replace("https://rules.fix.test/v1/", "https://rules.fix.test")],
      [
        "another path too",
        (c: string) => c.replace("https://rules.fix.test/v1/", "https://rules.fix.test/v1/ https://rules.fix.test/v2/"),
      ],
    ] as const) {
      const r = mutant("e2e", csp(to));
      expect(r.ok, what).toBe(false);
      expect(r.out, what).toContain("unexpected extension_pages CSP");
    }
  });
  it("the worker's fetch: the updater's, no second (the server sync's transport went with its client: DV-0b)", () => {
    const r = mutant("e2e", append("sw.js", "fetch"));
    expect(r.ok).toBe(false);
    expect(r.out).toContain("sw.js: `fetch` appears 2 times; only sw.js may use it, 1 times (the site rules' updater)");
  });
  it("the format's checker: in the reader and the worker; the e2e build's reserved test hosts accepted in both", () => {
    const list = /\[\s*"test",\s*"example",\s*"invalid",\s*"localhost"\s*\]/;
    const r1 = mutant("e2e", swap("sw.js", list, '["test", "example", "invalid", "localhozt"]'));
    expect(r1.ok).toBe(false);
    expect(r1.out).toContain("must be in the site rules' reader and in sw.js (the updater's); found in:");
    const r2 = mutant("e2e", append(boot("e2e"), '["test","example","invalid","localhost"]'));
    expect(r2.ok).toBe(false);
    expect(r2.out).toContain("must be in the site rules' reader and in sw.js (the updater's); found in:");
    const r3 = mutant("e2e", swap("sw.js", /allowReserved: !0/, "allowReserved: !1"));
    expect(r3.ok).toBe(false);
    expect(r3.out).toContain(
      "the e2e build's reader must accept them (its test rules), and its worker (the updater's)",
    );
  });
  it("the worker's URLs: the rules origin's in the worker alone", () => {
    const r = mutant("e2e", append(fill("e2e"), "https://rules.fix.test/v1/manifest.json"));
    expect(r.ok).toBe(false);
    expect(r.out).toContain(
      `${fill("e2e")}: URL in shipped code that is not one it may hold: https://rules.fix.test/v1/manifest.json`,
    );
  });
});

describe("the worker's size: the e2e build has the updater's room, the store build never (the maintainers' C33)", () => {
  it("the limits, by flavour, from one module that reads no release gate", () => {
    expect(SW_BUDGET_GZ).toBe(106_496);
    expect(RULES_UPDATER_GZ).toBe(9_216);
    expect(swBudgetOf("prod")).toBe(106_496);
    expect(swBudgetOf("e2e")).toBe(115_712);
    expect(swBudgetOf("dev")).toBe(115_712); // not held in a dev build (unminified)
    const src = readFileSync(join(EXT, "scripts/sw-budget.mjs"), "utf8");
    expect(src).not.toMatch(/^import /m); // no gate, no flavour's config: the store build's limit cannot follow a gate
    const check = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
    expect(check).toMatch(/const SW_BUDGET_GZ = swBudgetOf\(flavour\);/);
    expect(check).not.toMatch(/swBudgetOf\([^)]*RULES_UPDATE/);
  });
  it("the store build's worker one byte over 106,496 B gz: refused; the e2e build's over 106,496 passes, over 115,712 is refused", () => {
    const p = mutant("prod", overWorker(106_496));
    expect(p.ok).toBe(false);
    expect(p.out).toMatch(/sw\.js: \d+ B gz, over the worker's budget of 106496 B/);
    const e = check(built.e2e, "e2e");
    expect(e.out).toMatch(
      /service worker sw\.js: (\d+) B gz \(limit 115712 B, the site rules' updater's 9216 B included\)/,
    );
    expect(e.ok, e.out).toBe(true);
    // over the store build's budget: the e2e build's passes (since the plugin platform's worker code went, its own
    // worker is under it, so it is padded there)
    const mid = mutant("e2e", overWorker(106_496));
    expect(mid.out).toMatch(/service worker sw\.js: (\d+) B gz \(limit 115712 B/);
    expect(+/service worker sw\.js: (\d+) B gz/.exec(mid.out)![1]!).toBeGreaterThan(106_496);
    expect(mid.ok, mid.out).toBe(true);
    const over = mutant("e2e", overWorker(115_712));
    expect(over.ok).toBe(false);
    expect(over.out).toMatch(/sw\.js: \d+ B gz, over the worker's budget of 115712 B/);
  });
});

describe("every build: the database's name in the worker alone", () => {
  it("in a page's chunk: refused, gate open or closed", () => {
    const page = /: names the site rules' database `sixkey-rules-live`: the worker alone opens it, never a page/;
    for (const f of ["e2e", "prod"] as Flavour[]) {
      const r = mutant(f, append(fill(f), "sixkey-rules-live"));
      expect(r.ok, f).toBe(false);
      expect(r.out).toMatch(new RegExp(`${fill(f).replace(/[.\\-]/g, "\\$&")}${page.source}`));
    }
    // a style sheet is no script: only the gate's rule sees it there
    expect(mutant("e2e", append(css("e2e"), "sixkey-rules-live")).ok).toBe(true);
  });
});

describe("a store build: no test signing key, whatever the gate", () => {
  for (const [i, k] of TEST_RULES_KEYS.entries())
    it(`test key ${i + 1}: its kid, its SPKI and its point in any of five spellings, in a script or the manifest`, () => {
      const der = Buffer.from(k.spki, "base64");
      const [x, y] = [der.subarray(27, 59), der.subarray(59, 91)];
      const xy = der.subarray(27, 91);
      for (const [what, mark, f] of [
        ["kid", k.kid, "sw.js"],
        ["spki", k.spki, fill("prod")],
        ["spki base64url", der.toString("base64url"), "manifest.json"],
        // its point, as a JWK or a hex dump would carry it (the review's N11)
        ["x‖y hex", xy.toString("hex"), "sw.js"],
        ["x‖y base64url", xy.toString("base64url"), fill("prod")],
        ["x base64url", x.toString("base64url"), "sw.js"],
        ["y base64url", y.toString("base64url"), "manifest.json"],
        ["y hex", y.toString("hex"), fill("prod")],
      ] as const) {
        const r = mutant("prod", append(f, mark));
        expect(r.ok, `${what} in ${f}`).toBe(false);
        expect(r.out).toMatch(
          new RegExp(
            `${f.replace(/[.\\-]/g, "\\$&")}: holds the site rules' test signing key ${k.kid} \\(TEST_RULES_KEYS\\) in a store build`,
          ),
        );
      }
      // the e2e build pins them: allowed there
      expect(mutant("e2e", append("sw.js", k.spki)).ok).toBe(true);
    });
  it("a line of a test key's private PEM, where the test fixtures are there (the review's N11)", () => {
    const pem = readFileSync(join(EXT, "test/fixtures/rules-keys/test-only-next.pem"), "utf8");
    const lines = pem.split("\n").filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const r = mutant("prod", append(fill("prod"), line));
      expect(r.ok).toBe(false);
      expect(r.out).toContain("holds a line of the site rules' test signing keys' private PEM in a store build");
    }
    expect(mutant("e2e", append(fill("e2e"), lines[0]!)).ok).toBe(true);
  });
});
