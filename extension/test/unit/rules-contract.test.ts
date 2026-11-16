// The rules format as a contract (AF3-1a; docs/design/notes/AUTOFILL3-NOTES.md):
//   - format.ts and lookup.ts load in plain Node through its type stripping (the plan's C10, N7): they import nothing at
//     run time, so rules/tools/ can use the very checker the extension uses;
//   - the JSON Schemas of contract/rules/1/ say what format.ts's SHAPE and LIMITS say: the same fields, required and
//     optional, closed everywhere, the same enums and bounds, and a selector pattern that agrees with selectorOk;
//   - REUSE.toml gives those schemas CC0-1.0 (contract data, OWNER-DECISIONS/01) and LICENSE.md says so.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalHost } from "../../src/core/match";
import { isShared } from "../../src/core/site-domains";
import { annotationOf, annotations } from "../helpers/reuse-toml";
import {
  FILLS,
  FLAGS,
  LICENSE,
  LICENSE_WITH_UPSTREAM,
  LIMITS,
  SHAPE,
  selectorOk,
  UPSTREAM_LICENSES,
  validate,
} from "../../src/core/rules/format";

const EXT = resolve(import.meta.dirname, "../..");
const REPO = resolve(EXT, "..");
const SRC = resolve(EXT, "src/core/rules");
const read = (p: string) => readFileSync(p, "utf8");
type S = Record<string, any>;
const schema = (name: string): S => JSON.parse(read(resolve(REPO, `contract/rules/1/${name}.schema.json`)));
const SCHEMAS = { "site-rule": schema("site-rule"), baseline: schema("baseline"), live: schema("live") };

describe("Node loads the checker as it is (type stripping, no build)", () => {
  it("format.ts and lookup.ts import nothing at run time; alias.ts only match.ts", () => {
    const runtime = (f: string) =>
      read(resolve(SRC, f))
        .split("\n")
        .filter((l) => /^\s*import\b/.test(l) && !/^\s*import type\b/.test(l));
    expect(runtime("format.ts")).toEqual([]);
    expect(runtime("lookup.ts")).toEqual([]);
    expect(runtime("alias.ts")).toEqual(['import { isIpHost, matchTier, usableDomain } from "../match";']);
    for (const f of ["format.ts", "lookup.ts", "alias.ts"])
      expect(read(resolve(SRC, f))).not.toMatch(/\brequire\(|\bimport\(/);
  });
  it("and checks a bundle there with match.ts and site-domains.ts, as rules/tools/ will", () => {
    const url = (p: string) => pathToFileURL(resolve(EXT, p)).href;
    const script = `
      const { validate } = await import(${JSON.stringify(url("src/core/rules/format.ts"))});
      const { ruleFor, hintOf } = await import(${JSON.stringify(url("src/core/rules/lookup.ts"))});
      const { canonicalHost } = await import(${JSON.stringify(url("src/core/match.ts"))});
      const { isShared } = await import(${JSON.stringify(url("src/core/site-domains.ts"))});
      const raw = { format: "sixkey-rules", kind: "live", schema: 1, version: 2, created: "2026-11-04",
        license: "AGPL-3.0-or-later", source: "https://example.org/sixkey/tree/rules-v2/rules", rules: { a: { pages: [{ path: "/", field: "input#otp", segments: 0, fill: "auto" }] } },
        hosts: { "login.example.com": "a" } };
      const c = { canonicalHost, isShared };
      const ok = validate(raw, "live", c);
      const shared = validate({ ...raw, hosts: { "github.io": "a" } }, "live", c);
      const aliases = validate({ ...raw, aliases: [] }, "live", c);
      console.log(JSON.stringify({ ok: ok.ok, hint: ok.ok ? hintOf(ruleFor("login.example.com", ok.value)) : null,
        shared: shared.ok ? "" : shared.error, aliases: aliases.ok ? "" : aliases.error }));`;
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      hint: { d: ["login.example.com"], p: [{ at: "/", sel: "input#otp", n: 0, how: 0 }], sent: false },
      shared: 'bundle.hosts["github.io"]: "github.io" is a shared suffix, or above one',
      aliases: 'bundle: a live bundle carries no "aliases": they ship with releases only',
    });
  });
});

/** Every subschema of a document, depth first. */
function* walk(s: unknown): Generator<S> {
  if (!s || typeof s !== "object") return;
  if (Array.isArray(s)) {
    for (const x of s) yield* walk(x);
    return;
  }
  yield s as S;
  for (const v of Object.values(s)) yield* walk(v);
}
const fields = (s: S) => ({ required: [...(s.required ?? [])].sort(), all: Object.keys(s.properties ?? {}).sort() });
const shapeOf = (k: keyof typeof SHAPE) => ({
  required: [...SHAPE[k].required].sort(),
  all: [...SHAPE[k].required, ...SHAPE[k].optional].sort(),
});
const bounds = (s: S) => [s.minItems ?? s.minimum, s.maxItems ?? s.maximum];

describe("the JSON Schemas say what the checker says", () => {
  it("2020-12, their own ids, and closed everywhere: every object with properties allows nothing else", () => {
    for (const [name, s] of Object.entries(SCHEMAS)) {
      expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(s.$id).toBe(`urn:sixkey:rules:1:${name}`);
      for (const sub of walk(s))
        if (sub.properties && sub.type === "object")
          expect(sub.additionalProperties, `${name}: ${Object.keys(sub.properties)}`).toBe(false);
    }
  });
  it("the same fields, required and optional", () => {
    const site = SCHEMAS["site-rule"];
    expect(fields(site)).toEqual(shapeOf("siteRule"));
    for (const s of [site, SCHEMAS.baseline, SCHEMAS.live]) expect(fields(s.$defs.page)).toEqual(shapeOf("page"));
    for (const s of [SCHEMAS.baseline, SCHEMAS.live]) expect(fields(s.$defs.rule)).toEqual(shapeOf("bundleRule"));
    expect(fields(SCHEMAS.baseline)).toEqual(shapeOf("baseline"));
    expect(fields(SCHEMAS.baseline.$defs.upstream)).toEqual(shapeOf("upstream"));
    expect(fields(SCHEMAS.baseline.$defs.shared)).toEqual(shapeOf("shared"));
    expect(fields(SCHEMAS.baseline.$defs.oneWay)).toEqual(shapeOf("oneWay"));
    expect(fields(SCHEMAS.live)).toEqual(shapeOf("live"));
    // M1: a live bundle has no field for aliases, appends or upstream, and no definition of them
    for (const k of ["aliases", "appends", "upstream"]) expect(SCHEMAS.live.properties[k]).toBeUndefined();
    for (const k of ["shared", "oneWay", "upstream"]) expect(SCHEMAS.live.$defs[k]).toBeUndefined();
  });
  it("the same enums and constants", () => {
    for (const s of Object.values(SCHEMAS)) {
      expect(s.$defs.page.properties.fill.enum).toEqual([...FILLS]);
      expect(s.$defs.id.pattern).toBe(`^[a-z0-9-]{1,${LIMITS.id}}$`);
    }
    expect(SCHEMAS["site-rule"].properties.flags.items.enum).toEqual([...FLAGS]);
    expect(SCHEMAS.baseline.$defs.rule.properties.flags.items.enum).toEqual([...FLAGS]);
    expect(SCHEMAS.baseline.$defs.upstream.properties.license.enum).toEqual([...UPSTREAM_LICENSES]);
    expect(SCHEMAS.baseline.properties.license.enum).toEqual([LICENSE, LICENSE_WITH_UPSTREAM]);
    expect(SCHEMAS.live.properties.license.const).toBe(LICENSE);
    for (const s of [SCHEMAS.baseline, SCHEMAS.live]) {
      expect(s.properties.format.const).toBe("sixkey-rules");
      expect(s.properties.schema.const).toBe(1);
    }
    expect(SCHEMAS.baseline.properties.kind.const).toBe("baseline");
    expect(SCHEMAS.live.properties.kind.const).toBe("live");
    // one box takes "auto" only
    expect(SCHEMAS["site-rule"].$defs.page.if.properties.segments.const).toBe(0);
    expect(SCHEMAS["site-rule"].$defs.page.then.properties.fill.const).toBe("auto");
  });
  it("the same bounds", () => {
    const site = SCHEMAS["site-rule"];
    expect(bounds(site.properties.hosts)).toEqual([...LIMITS.hosts]);
    expect(bounds(site.properties.pages)).toEqual([...LIMITS.pages]);
    expect(bounds(site.properties.fixtures)).toEqual([...LIMITS.fixtures]);
    expect(bounds(site.properties.minLeft)).toEqual([...LIMITS.minLeft]);
    expect(site.properties.note.maxLength).toBe(LIMITS.note);
    for (const s of Object.values(SCHEMAS)) {
      const p = s.$defs.page.properties;
      expect(p.path.maxLength).toBe(LIMITS.path);
      expect(s.$defs.selector.maxLength).toBe(LIMITS.field);
      expect(s.$defs.host.maxLength).toBe(LIMITS.host);
      expect(p.segments.anyOf).toEqual([{ const: 0 }, { minimum: LIMITS.segments[0], maximum: LIMITS.segments[1] }]);
    }
    for (const s of [SCHEMAS.baseline, SCHEMAS.live]) {
      expect(bounds(s.properties.version)).toEqual([...LIMITS.version]);
      expect(s.properties.source.maxLength).toBe(LIMITS.source);
      expect(s.properties.rules.maxProperties).toBe(LIMITS.rules);
      expect(s.properties.hosts.maxProperties).toBe(LIMITS.hostEntries);
      expect(bounds(s.$defs.rule.properties.pages)).toEqual([...LIMITS.pages]);
      expect(bounds(s.$defs.rule.properties.minLeft)).toEqual([...LIMITS.minLeft]);
    }
    const b = SCHEMAS.baseline;
    expect(b.properties.upstream.maxItems).toBe(LIMITS.upstream);
    expect(b.properties.aliases.maxItems).toBe(LIMITS.aliases);
    expect(b.properties.appends.maxItems).toBe(LIMITS.appends);
    expect(bounds(b.$defs.shared.properties.s)).toEqual([...LIMITS.group]);
    expect(b.$defs.upstream.properties.id.maxLength).toBe(LIMITS.upstreamId);
    expect(b.$defs.upstream.properties.url.maxLength).toBe(LIMITS.url);
    expect(b.$defs.upstream.properties.path.maxLength).toBe(LIMITS.upstreamPath);
  });
  it("the selector pattern agrees with selectorOk, except the one rule a pattern cannot hold (one #id per compound)", () => {
    const re = new RegExp(SCHEMAS["site-rule"].$defs.selector.pattern, "u");
    for (const s of Object.values(SCHEMAS))
      expect(s.$defs.selector.pattern).toBe(SCHEMAS["site-rule"].$defs.selector.pattern);
    const samples = [
      "input#otp",
      'input[id=":r1:"]',
      "div.code > input",
      'input[aria-label="Code > digits, then Enter"]',
      "a b c d e f g h",
      "a b c d e f g h i",
      '[class~="2fa-code"]',
      '[name~="a b"]',
      "#1a",
      ".2fa",
      ".-otp",
      "a>b",
      "input:focus",
      "a, b",
      "a ~ b",
      "[name=otp]",
      '[name$="x"]',
      "INPUT",
      " input",
      "input >input",
      'input[name="ü"]',
      ".a\\:b",
    ];
    for (const s of samples) expect(re.test(s), s).toBe(selectorOk(s));
    expect(re.test("#a#b")).toBe(true);
    expect(selectorOk("#a#b")).toBe(false);
  });
});

describe("every pattern of the schemas says what the checker says (the review's S1)", () => {
  const C = { canonicalHost, isShared };
  /** The schema's verdict on a string: its pattern (as ECMAScript reads it, with the u flag) and its lengths. */
  const bySchema = (sub: S, v: string) =>
    (sub.maxLength === undefined || v.length <= sub.maxLength) &&
    (sub.minLength === undefined || v.length >= sub.minLength) &&
    new RegExp(sub.pattern, "u").test(v);
  const RULE = () => ({
    id: "a-rule",
    hosts: ["login.example.com"],
    pages: [{ path: "/", field: "input", segments: 0, fill: "auto" }],
    verified: "2026-11-01",
    fixtures: ["a-rule/a.html"],
  });
  const BUNDLE = (kind: "baseline" | "live"): S => ({
    format: "sixkey-rules",
    kind,
    schema: 1,
    version: 3,
    created: "2026-11-01",
    license: "AGPL-3.0-or-later",
    source: "https://example.org/sixkey/tree/rules-v3/rules",
    ...(kind === "baseline" ? { upstream: [], aliases: [], appends: [] } : {}),
    rules: { r: { pages: [{ path: "/", field: "input", segments: 0, fill: "auto" }] } },
    hosts: { "login.example.com": "r" },
  });
  const UPSTREAM = () => ({
    id: "apple-shared-credentials",
    url: "https://github.com/apple/password-manager-resources",
    commit: "e6a7cf40fe91aa8897b1be07b0ab416332c31488",
    path: "quirks/shared-credentials.json",
    sha256: "0".repeat(64),
    license: "MIT",
  });
  const withUpstream = (f: (u: S) => void) => {
    const b = BUNDLE("baseline");
    const u = UPSTREAM();
    f(u);
    b.upstream = [u];
    b.license = "AGPL-3.0-or-later AND MIT";
    return validate(b, "baseline", C).ok;
  };
  type Case = {
    field: string;
    /** The subschema in each document that has the field. */
    subs: [string, S][];
    samples: string[];
    /** The checker's verdict, per document (site-rule, baseline, live). */
    judge: (doc: string, v: string) => boolean;
    /** Samples the schema accepts and only the checker can refuse (canonical form, shared suffixes, calendar...). */
    stricter?: string[];
  };
  const docs = Object.entries(SCHEMAS);
  const each = (f: (s: S) => S) => docs.map(([n, s]) => [n, f(s)] as [string, S]);
  const asRule = (f: (r: S) => void) => {
    const r = RULE() as S;
    f(r);
    return validate(r, "rule", C, { today: "2026-11-04" }).ok;
  };
  const asBundle = (doc: string, f: (b: S) => void) => {
    const kind = doc === "live" ? "live" : "baseline";
    const b = BUNDLE(kind);
    f(b);
    return validate(b, kind, C).ok;
  };
  const CASES: Case[] = [
    {
      field: "page.path",
      subs: each((s) => s.$defs.page.properties.path),
      samples: [
        "/",
        "/2fa",
        "/a%20b/c;d=1,e+f@g$h&i'j(k)l!m|n~o_p[q]r:s",
        "/a/*",
        '/a"b',
        "/a#b",
        "/a?b",
        "/a<b",
        "/a>b",
        "/a`b",
        "/a{b",
        "/a}b",
        "/a\\b",
        "/a^b",
        "/a b",
        "/é",
        "/a\tb",
        "2fa",
        "",
        `/${"x".repeat(127)}`,
        `/${"x".repeat(128)}`,
      ],
      judge: (doc, v) =>
        doc === "site-rule"
          ? asRule((r) => (r.pages[0].path = v))
          : asBundle(doc, (b) => (b.rules.r.pages[0].path = v)),
    },
    {
      field: "host",
      subs: each((s) => s.$defs.host),
      samples: [
        "login.example.com",
        "xn--bcher-kva.de",
        "a_b.example.com",
        "x.s3.amazonaws.com",
        "Example.com",
        "example.com.",
        "-a.com",
        "a-.com",
        "a..com",
        "localhost",
        "bücher.de",
        "exa mple.com",
        `${"x".repeat(64)}.com`,
        "1.2.3.4",
        "github.io",
        "co.uk",
        "a.test",
        "xn--a.com",
      ],
      stricter: ["1.2.3.4", "github.io", "co.uk", "a.test", "xn--a.com"],
      judge: (doc, v) =>
        doc === "site-rule" ? asRule((r) => (r.hosts = [v])) : asBundle(doc, (b) => (b.hosts = { [v]: "r" })),
    },
    {
      field: "date",
      subs: each((s) => s.$defs.date),
      samples: [
        "2026-11-01",
        "2024-02-29",
        "2026-02-30",
        "2026-13-01",
        "2026-1-1",
        "20261101",
        "",
        "2026-11-01T00:00:00Z",
      ],
      stricter: ["2026-02-30", "2026-13-01"],
      judge: (doc, v) =>
        doc === "site-rule" ? asRule((r) => (r.verified = v)) : asBundle(doc, (b) => (b.created = v)),
    },
    {
      field: "id",
      subs: each((s) => s.$defs.id),
      samples: ["r", "a-rule", "x".repeat(64), "x".repeat(65), "A", "a_b", "a b", ""],
      judge: (doc, v) =>
        doc === "site-rule"
          ? asRule((r) => ((r.id = v), (r.fixtures = [`${v}/a.html`])))
          : asBundle(doc, (b) => ((b.rules = { [v]: b.rules.r }), (b.hosts = { "login.example.com": v }))),
    },
    {
      field: "source",
      subs: [
        ["baseline", SCHEMAS.baseline.properties.source],
        ["live", SCHEMAS.live.properties.source],
      ],
      samples: [
        "",
        "https://example.org",
        "https://example.org/a/b",
        "https://github.com/o/sixkey/tree/rules-v3/rules",
        "https://EXAMPLE.org/x",
        "https://example.org:8443/x",
        "https://example.org?x",
        "https://example.org#x",
        "https://x",
        "https:///",
        "https://example",
        "https://user@example.org/",
        "http://example.org",
        "https://exa mple.org",
        "https://exa_mple.org",
        "ftp://example.org",
        "https://example.org:99999/x",
      ],
      stricter: ["https://example.org:99999/x"],
      judge: (doc, v) => asBundle(doc, (b) => (b.source = v)),
    },
    {
      field: "fixtures[]",
      subs: [["site-rule", SCHEMAS["site-rule"].properties.fixtures.items]],
      samples: [
        "a-rule/a.html",
        "a-rule/one-box.html",
        "a-rule/A.html",
        "a-rule/.a.html",
        "a-rule/a.htm",
        "a-rule/sub/a.html",
        "a-rule/../a.html",
        "/a-rule/a.html",
        `a-rule/${"a".repeat(59)}.html`,
        "b-rule/a.html",
      ],
      stricter: ["b-rule/a.html"],
      judge: (_, v) => asRule((r) => (r.fixtures = [v])),
    },
    {
      field: "note",
      subs: [["site-rule", SCHEMAS["site-rule"].properties.note]],
      samples: ["Checked on the sign-in page.", "", "中文", "a\tb", "x".repeat(280), "x".repeat(281)],
      judge: (_, v) => asRule((r) => (r.note = v)),
    },
    ...(
      [
        ["id", ["apple-shared-credentials", "a", "Apple", "a_b", "x".repeat(48), "x".repeat(49)]],
        [
          "url",
          [
            "https://github.com/apple/password-manager-resources",
            "https://github.com/a/b?c",
            "http://github.com/a",
            "https://GitHub.com/a",
            "https://github.com/a b",
          ],
        ],
        [
          "commit",
          ["e6a7cf40fe91aa8897b1be07b0ab416332c31488", "e6a7cf40", "E6A7CF40FE91AA8897B1BE07B0AB416332C31488", ""],
        ],
        [
          "path",
          [
            "quirks/shared-credentials.json",
            "LICENSE.md",
            "quirks/../x.json",
            "/quirks/x.json",
            "quirks/./x.json",
            "quirks//x.json",
            "quirks/x y.json",
          ],
        ],
        ["sha256", ["0".repeat(64), "0".repeat(63), "G".repeat(64)]],
      ] as [string, string[]][]
    ).map(([k, samples]): Case => ({
      field: `upstream.${k}`,
      subs: [["baseline", SCHEMAS.baseline.$defs.upstream.properties[k]]],
      samples,
      stricter: k === "path" ? ["quirks/../x.json", "quirks/./x.json"] : [],
      judge: (_, v) => withUpstream((u) => (u[k] = v)),
    })),
  ];
  for (const c of CASES)
    it(`${c.field}: the schema and the checker agree on every sample (the checker stricter only where listed)`, () => {
      for (const [doc, sub] of c.subs) {
        expect(sub, `${doc} ${c.field}`).toBeDefined();
        for (const v of c.samples) {
          const s = bySchema(sub, v);
          const k = c.judge(doc, v);
          if (c.stricter?.includes(v)) expect([doc, v, s, k]).toEqual([doc, v, true, false]);
          else expect([doc, v, s]).toEqual([doc, v, k]);
        }
      }
    });
  it("the page's if/then (one box takes auto only) in all three schemas, as the checker holds it", () => {
    for (const [doc, s] of docs) {
      expect(s.$defs.page.if, doc).toEqual({ properties: { segments: { const: 0 } } });
      expect(s.$defs.page.then, doc).toEqual({ properties: { fill: { const: "auto" } } });
      expect(s.$defs.page.properties.fill.enum, doc).toEqual([...FILLS]);
    }
    for (const fill of FILLS)
      for (const segments of [0, 6]) {
        const want = segments !== 0 || fill === "auto";
        expect(
          asRule((r) => (r.pages[0] = { path: "/", field: "input", segments, fill })),
          `${segments} ${fill}`,
        ).toBe(want);
        expect(asBundle("baseline", (b) => (b.rules.r.pages[0] = { path: "/", field: "input", segments, fill }))).toBe(
          want,
        );
        expect(asBundle("live", (b) => (b.rules.r.pages[0] = { path: "/", field: "input", segments, fill }))).toBe(
          want,
        );
      }
  });
  it("the same host, date, id, path and selector patterns in all three documents", () => {
    for (const k of ["host", "date", "id", "selector"])
      for (const [doc, s] of docs)
        expect(s.$defs[k].pattern, `${doc} ${k}`).toBe(SCHEMAS["site-rule"].$defs[k].pattern);
    for (const [doc, s] of docs)
      expect(s.$defs.page.properties.path.pattern, doc).toBe(SCHEMAS["site-rule"].$defs.page.properties.path.pattern);
  });
});

describe("their licence", () => {
  /** The licence REUSE gives a path: the last entry that matches it, REUSE's globs read as reuse-tool reads them. */
  const entries = annotations(REPO);
  const licenceOf = (p: string) => annotationOf(entries, p)?.id;
  it("REUSE.toml gives each schema CC0-1.0, as the other contract data", () => {
    for (const name of Object.keys(SCHEMAS)) expect(licenceOf(`contract/rules/1/${name}.schema.json`)).toBe("CC0-1.0");
    expect(licenceOf("contract/vectors/kdf.json")).toBe("CC0-1.0");
    // the checker is the extension's code, MPL-2.0
    for (const f of ["format.ts", "lookup.ts", "alias.ts"])
      expect(licenceOf(`extension/src/core/rules/${f}`)).toBe("MPL-2.0");
  });
  it("LICENSE.md, the readable map, says so", () => {
    const row = read(resolve(REPO, "LICENSE.md"))
      .split("\n")
      .find((l) => l.startsWith("| Contract data"));
    expect(row).toContain("`contract/rules/1/`");
    expect(row).toContain("site rules");
    expect(row).toContain("CC0");
  });
});
