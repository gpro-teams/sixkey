// The site rules' format (src/core/rules/format.ts; docs/design/notes/AUTOFILL3-NOTES.md, AF3-1a): a site rule file and the
// two kinds of bundle, checked closed. Every rejection here is of the whole object: an unknown field anywhere, a value of
// the wrong type, a value out of bounds, a host that is not one, a selector outside the grammar, and (the plan's M1) a
// live bundle that carries aliases, appends or upstream data.
import { describe, expect, it } from "vitest";
import { canonicalHost, isIpHost } from "../../src/core/match";
import { isShared } from "../../src/core/site-domains";
import { FILLS, LIMITS, selectorOk, validate, type Bundle, type SiteRule } from "../../src/core/rules/format";

const C = { canonicalHost, isShared };
const TODAY = "2026-11-04";
/** JSON as the tests change it. */
type J = Record<string, any>;

const RULE: J = {
  id: "example-login",
  hosts: ["login.example.com", "www.example.com"],
  pages: [
    { path: "/2fa", field: "input#otp", segments: 0, fill: "auto" },
    { path: "/verify", field: "div.code > input", segments: 6, fill: "chars" },
  ],
  verified: "2026-11-01",
  fixtures: ["example-login/one-box.html", "example-login/six-boxes.html"],
};
// The two Apple entries are real ones (apple/password-manager-resources, quirks/shared-credentials.json at e6a7cf40).
const BASELINE: J = {
  format: "sixkey-rules",
  kind: "baseline",
  schema: 1,
  version: 3,
  created: "2026-11-04",
  license: "AGPL-3.0-or-later AND MIT",
  source: "",
  upstream: [
    {
      id: "apple-shared-credentials",
      url: "https://github.com/apple/password-manager-resources",
      commit: "e6a7cf40fe91aa8897b1be07b0ab416332c31488",
      path: "quirks/shared-credentials.json",
      sha256: "0".repeat(64),
      license: "MIT",
    },
  ],
  rules: {
    "example-login": {
      pages: [{ path: "/2fa", field: "input#otp", segments: 0, fill: "auto" }],
      flags: ["sent"],
      minLeft: 8,
    },
  },
  hosts: { "login.example.com": "example-login", "www.example.com": "example-login" },
  aliases: [{ f: ["twitter.com"], t: ["x.com"] }, { s: ["chat.com", "chatgpt.com", "openai.com"] }],
  appends: ["auth.redhat.com", "etrade.com", "usaa.com"],
};
const LIVE: J = (() => {
  const { upstream: _u, aliases: _a, appends: _p, ...rest } = structuredClone(BASELINE);
  return {
    ...rest,
    kind: "live",
    license: "AGPL-3.0-or-later",
    source: "https://example.org/sixkey/tree/rules-v3/rules",
  };
})();

const rule = (f?: (r: J) => void, today = TODAY) => {
  const r = structuredClone(RULE);
  f?.(r);
  return validate(r, "rule", C, { today });
};
const bundle = (base: J, kind: "baseline" | "live", f?: (b: J) => void, opts = {}) => {
  const b = structuredClone(base);
  f?.(b);
  return validate(b, kind, C, opts);
};
const refused = (r: { ok: boolean; error?: string }, why?: RegExp) => {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  if (why) expect((r as { error: string }).error).toMatch(why);
};

describe("a site rule file", () => {
  it("is read in full and normalised (flags to `sent`, no minLeft to null)", () => {
    const r = rule();
    expect(r.ok).toBe(true);
    const v = (r as { value: SiteRule }).value;
    expect(v.id).toBe("example-login");
    expect(v.hosts).toEqual(["login.example.com", "www.example.com"]);
    expect(v.rule).toEqual({ pages: RULE.pages, sent: false, minLeft: null });
    expect(v.fixtures).toEqual(RULE.fixtures);
    expect((rule((r) => (r.flags = ["sent"])) as { value: SiteRule }).value.rule.sent).toBe(true);
    expect((rule((r) => (r.flags = [])) as { value: SiteRule }).value.rule.sent).toBe(false);
    expect((rule((r) => (r.minLeft = 20)) as { value: SiteRule }).value.rule.minLeft).toBe(20);
    expect(rule((r) => (r.note = "Checked on the account page, step 2.")).ok).toBe(true);
  });

  it("refuses an unknown field at every level, and a missing one", () => {
    refused(
      rule((r) => (r.extra = 1)),
      /^rule: unknown field "extra"$/,
    );
    refused(
      rule((r) => (r.pages[1].wait = 500)),
      /^rule\.pages\[1\]: unknown field "wait"$/,
    );
    // a site rule has no alias field (M1: aliases come only from pinned upstream files)
    refused(
      rule((r) => (r.aliases = [{ s: ["a.com", "b.com"] }])),
      /unknown field "aliases"/,
    );
    refused(
      rule((r) => (r.twoFactorPage = true)),
      /unknown field/,
    );
    for (const k of ["id", "hosts", "pages", "verified", "fixtures"])
      refused(
        rule((r) => delete r[k]),
        new RegExp(`missing field "${k}"`),
      );
    for (const k of ["path", "field", "segments", "fill"])
      refused(
        rule((r) => delete r.pages[0][k]),
        new RegExp(`missing field "${k}"`),
      );
    // JSON.parse makes "__proto__" an own field: it is an unknown one like any other
    // an unknown field's name is cut to 80 characters in the reason (the review's N1)
    const long = rule((r) => (r["k".repeat(1_000_000)] = 1));
    refused(long, /unknown field "k{80}"$/);
    expect((long as { error: string }).error.length).toBeLessThan(120);
    const proto = JSON.parse(JSON.stringify(RULE).replace(/^\{/, '{"__proto__":{"x":1},'));
    refused(validate(proto, "rule", C, { today: TODAY }), /unknown field "__proto__"/);
  });

  it("refuses a value of the wrong type in every field", () => {
    const wrong: unknown[] = [null, true, 1.5, "x", [], {}, 3];
    // the values that are right for a field (an id or a selector may be "x", a note too; flags may be empty)
    const right: Record<string, unknown[]> = { id: ["x"], field: ["x"], note: ["x"], flags: [[]] };
    const fields: [string, (r: J, v: unknown) => void][] = [
      ["id", (r, v) => (r.id = v)],
      ["hosts", (r, v) => (r.hosts = v)],
      ["hosts[0]", (r, v) => (r.hosts[0] = v)],
      ["pages", (r, v) => (r.pages = v)],
      ["pages[0]", (r, v) => (r.pages[0] = v)],
      ["path", (r, v) => (r.pages[0].path = v)],
      ["field", (r, v) => (r.pages[0].field = v)],
      ["segments", (r, v) => (r.pages[0].segments = v)],
      ["fill", (r, v) => (r.pages[0].fill = v)],
      ["flags", (r, v) => (r.flags = v)],
      ["minLeft", (r, v) => (r.minLeft = v)],
      ["verified", (r, v) => (r.verified = v)],
      ["fixtures", (r, v) => (r.fixtures = v)],
      ["note", (r, v) => (r.note = v)],
    ];
    for (const [name, set] of fields)
      for (const v of wrong) {
        if ((right[name] ?? []).some((ok) => JSON.stringify(ok) === JSON.stringify(v))) continue;
        refused(rule((r) => set(r, v)));
      }
    // the whole file must be a plain object
    for (const v of [null, [], "x", 1, new Map(), Object.create(null) as object, new (class R {})()])
      refused(validate(v, "rule", C, { today: TODAY }));
    // the right fields on an object that is not a plain one are still refused
    refused(validate(Object.assign(new (class R {})(), structuredClone(RULE)), "rule", C, { today: TODAY }), /plain/);
    refused(
      validate(Object.assign(Object.create(null) as object, structuredClone(RULE)), "rule", C, { today: TODAY }),
      /plain/,
    );
  });

  it("holds every bound", () => {
    refused(rule((r) => (r.hosts = [])));
    refused(rule((r) => (r.hosts = Array.from({ length: 17 }, (_, i) => `h${i}.example.com`))));
    expect(rule((r) => (r.hosts = Array.from({ length: 16 }, (_, i) => `h${i}.example.com`))).ok).toBe(true);
    refused(
      rule((r) => (r.hosts = ["a.example.com", "a.example.com"])),
      /appears twice/,
    );
    refused(rule((r) => (r.pages = [])));
    refused(rule((r) => (r.pages = Array.from({ length: 9 }, () => RULE.pages[0]))));
    expect(rule((r) => (r.pages = Array.from({ length: 8 }, () => RULE.pages[0]))).ok).toBe(true);
    for (const p of ["", "2fa", "/2fa?step=2", "/2fa#x", "/two fa", "/x".padEnd(129, "x"), "/é"])
      refused(rule((r) => (r.pages[0].path = p)));
    expect(rule((r) => (r.pages[0].path = "/".padEnd(128, "x"))).ok).toBe(true);
    expect(rule((r) => (r.pages[0].path = "/")).ok).toBe(true);
    expect(rule((r) => (r.pages[0].path = "/a%20b/c;d=1,e+f@g$h&i'j(k)l!m|n~o_p[q]r:s")).ok).toBe(true);
    // what a pathname never holds raw (a browser percent-encodes it), and "*", which is no wildcard (the review's N3)
    for (const c of ['"', "#", "?", "<", ">", "`", "{", "}", "\\", "^", "*", " "])
      refused(
        rule((r) => (r.pages[0].path = `/a${c}b`)),
        /allowed form/,
      );
    for (const s of [-1, 1, 2, 3, 9, 0.5]) refused(rule((r) => (r.pages[1].segments = s)));
    for (const s of [4, 5, 6, 7, 8]) expect(rule((r) => (r.pages[1].segments = s)).ok).toBe(true);
    for (const f of FILLS) expect(rule((r) => (r.pages[1].fill = f)).ok).toBe(true);
    refused(rule((r) => (r.pages[1].fill = "insert-text")));
    // one box takes "auto" only (the strategies are for groups)
    refused(
      rule((r) => (r.pages[0].fill = "chars")),
      /single box/,
    );
    refused(
      rule((r) => (r.pages[0].fill = "paste")),
      /single box/,
    );
    refused(rule((r) => (r.flags = ["sent", "sent"])));
    refused(rule((r) => (r.flags = ["no-auto"])));
    for (const m of [4, 21, 5.5]) refused(rule((r) => (r.minLeft = m)));
    for (const m of [5, 20]) expect(rule((r) => (r.minLeft = m)).ok).toBe(true);
    for (const id of ["", "Example", "example_login", "x".repeat(65), "a b"]) refused(rule((r) => (r.id = id)));
    expect(rule((r) => ((r.id = "x".repeat(64)), (r.fixtures = [`${"x".repeat(64)}/a.html`]))).ok).toBe(true);
    refused(rule((r) => (r.note = "x".repeat(281))));
    refused(rule((r) => (r.note = "中文")));
  });

  it("holds `verified` to a real date, not after today", () => {
    for (const d of ["2026-02-30", "2026-13-01", "2026-1-1", "20261101", "2026-11-04T00:00:00Z"])
      refused(rule((r) => (r.verified = d)));
    expect(rule((r) => (r.verified = TODAY)).ok).toBe(true);
    refused(
      rule((r) => (r.verified = "2026-11-05")),
      /in the future/,
    );
    expect(rule((r) => (r.verified = "2026-11-05"), "2026-11-05").ok).toBe(true);
  });

  it("holds each fixture to the rule's own folder, an .html name, at most 8, each once", () => {
    for (const f of [
      "other/one.html",
      "example-login/../one.html",
      "example-login/sub/one.html",
      "example-login/one.htm",
      "example-login/One.html",
      "example-login/.html",
      "/example-login/one.html",
      `example-login/${"a".repeat(60)}.html`,
    ])
      refused(rule((r) => (r.fixtures = [f])));
    refused(rule((r) => (r.fixtures = [])));
    refused(rule((r) => (r.fixtures = Array.from({ length: 9 }, (_, i) => `example-login/p${i}.html`))));
    refused(
      rule((r) => (r.fixtures = ["example-login/a.html", "example-login/a.html"])),
      /appears twice/,
    );
  });
});

describe("hosts", () => {
  it("are host names as the URL parser writes them: no capitals, trailing dot, port, scheme, path or wildcard", () => {
    for (const h of [
      "Example.com",
      "example.com.",
      "example.com:443",
      "https://example.com",
      "example.com/x",
      "*.example.com",
      "exa mple.com",
      "bücher.de",
      "",
    ])
      refused(
        rule((r) => (r.hosts = [h])),
        /not a host name|not in the allowed form|longer/,
      );
    expect(rule((r) => (r.hosts = ["xn--bcher-kva.de"])).ok).toBe(true);
  });
  it("are never an IP address, a single label or a shared suffix (or above one)", () => {
    for (const h of ["1.2.3.4", "[::1]"]) {
      expect(isIpHost(h) && canonicalHost(h) === h).toBe(true); // the checker's own IP test agrees with match.ts here
      refused(
        rule((r) => (r.hosts = [h])),
        /IP address/,
      );
    }
    refused(
      rule((r) => (r.hosts = ["localhost"])),
      /single label/,
    );
    for (const h of ["github.io", "co.uk", "com.cn", "vercel.app", "amazonaws.com"])
      refused(
        rule((r) => (r.hosts = [h])),
        /shared suffix/,
      );
    expect(rule((r) => (r.hosts = ["someone.github.io", "bbc.co.uk"])).ok).toBe(true);
  });
  it("refuse the reserved names unless the build asks for them (the e2e build's test rules)", () => {
    for (const h of ["app.fix.test", "a.example", "b.invalid", "c.localhost"]) {
      refused(
        rule((r) => (r.hosts = [h])),
        /reserved/,
      );
      const r = structuredClone(RULE);
      r.hosts = [h];
      expect(validate(r, "rule", C, { today: TODAY, allowReserved: true }).ok).toBe(true);
    }
    expect(rule((r) => (r.hosts = ["example.com", "test.com"])).ok).toBe(true);
  });
});

describe("the selector grammar", () => {
  const OK = [
    "input",
    "input#otp",
    "#otp",
    ".otp-input",
    "input.a.b",
    "input[name]",
    'input[name="otp"]',
    'input[autocomplete="one-time-code"]',
    '[data-testid^="otp-"]',
    'input[id=":r1:"]',
    'input[placeholder="Enter the 6-digit code"]',
    'input[aria-label="Code > digits, then Enter"]',
    'input[name=""]',
    '[class~="otp"]',
    '[class~="2fa-code"]',
    ".-otp",
    "#_a",
    "input.otp-2fa",
    "input#-x1",
    "div.code > input",
    'form#mfa input[inputmode="numeric"]',
    "#A_b-9",
    "a b c d e f g h",
    "a > b > c",
  ];
  const BAD = [
    "",
    " input",
    "input ",
    "input  input",
    "input >input",
    "input> input",
    "input:focus",
    "#otp:focus",
    ":has(input)",
    "input:not(.x)",
    "input::before",
    "a, b",
    "a,b",
    "*",
    "input *",
    "a ~ b",
    "a + b",
    "#a#b",
    "#1a",
    ".2fa",
    ".-1",
    "#-",
    "#--x",
    "a>b",
    "a >b",
    "a> b",
    '[name~=""]',
    '[name~="a b"]',
    "input#a.b#c",
    "INPUT",
    "1abc",
    "input.b input2.c#",
    "[Name]",
    "[name=otp]",
    '[name$="x"]',
    '[name*="x"]',
    '[name|="x"]',
    "[name='otp']",
    'input[name="a\\"b"]',
    'input[name="a\\\\b"]',
    "#\\31 23",
    ".a\\:b",
    'input[name="ü"]',
    'input[name="a\tb"]',
    "a b c d e f g h i",
    `input[name="${"x".repeat(200)}"]`,
    'input[name="otp"',
    "input]",
    "div.code >",
    "> input",
  ];
  it("takes queries of the grammar", () => {
    for (const s of OK) expect(selectorOk(s), s).toBe(true);
  });
  it("refuses everything else: pseudo-classes, lists, other combinators, two ids, escapes, unquoted values", () => {
    for (const s of BAD) expect(selectorOk(s), s).toBe(false);
    for (const s of [null, 1, ["input"], undefined]) expect(selectorOk(s)).toBe(false);
  });
  it("is what a rule's `field` must be", () => {
    for (const s of BAD.slice(1))
      refused(
        rule((r) => (r.pages[0].field = s)),
        /selector grammar|longer/,
      );
    expect(selectorOk("x".repeat(LIMITS.field))).toBe(true);
    expect(selectorOk("x".repeat(LIMITS.field + 1))).toBe(false);
  });
});

describe("a baseline bundle", () => {
  it("is read in full: rules by id, each host to its rule, the reverse, aliases, appends, upstream", () => {
    const r = bundle(BASELINE, "baseline");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const b = (r as { value: Bundle }).value;
    expect(b.kind).toBe("baseline");
    expect(b.rules.get("example-login")).toEqual({
      pages: BASELINE.rules["example-login"].pages,
      sent: true,
      minLeft: 8,
    });
    expect([...b.hosts]).toEqual([
      ["login.example.com", "example-login"],
      ["www.example.com", "example-login"],
    ]);
    expect(b.hostsOf.get("example-login")).toEqual(["login.example.com", "www.example.com"]);
    expect(b.aliases).toEqual(BASELINE.aliases);
    expect(b.appends).toEqual(BASELINE.appends);
    expect(b.upstream).toEqual(BASELINE.upstream);
  });

  it("refuses an unknown field at every level", () => {
    const at: [string, (b: J) => void][] = [
      ["bundle", (b) => (b.extra = 1)],
      ["bundle.rules.example-login", (b) => (b.rules["example-login"].extra = 1)],
      ["bundle.rules.example-login.pages[0]", (b) => (b.rules["example-login"].pages[0].extra = 1)],
      ["bundle.upstream[0]", (b) => (b.upstream[0].extra = 1)],
      ["bundle.aliases[0]", (b) => (b.aliases[0].extra = 1)],
      ["bundle.aliases[1]", (b) => (b.aliases[1].extra = 1)],
      // a rule in a bundle keeps no source-only field
      ["bundle.rules.example-login", (b) => (b.rules["example-login"].verified = "2026-11-01")],
      ["bundle.rules.example-login", (b) => (b.rules["example-login"].hosts = ["x.com"])],
    ];
    for (const [where, f] of at)
      refused(bundle(BASELINE, "baseline", f), new RegExp(`^${where.replace(/[.[\]]/g, "\\$&")}: unknown field`));
    refused(
      bundle(BASELINE, "baseline", (b) => (b.aliases[0] = { s: ["a.com", "b.com"], f: ["c.com"] })),
      /unknown field "f"/,
    );
    for (const k of [
      "format",
      "kind",
      "schema",
      "version",
      "created",
      "license",
      "source",
      "upstream",
      "rules",
      "hosts",
      "aliases",
      "appends",
    ])
      refused(
        bundle(BASELINE, "baseline", (b) => delete b[k]),
        new RegExp(`missing field "${k}"`),
      );
  });

  it("refuses a value of the wrong type", () => {
    for (const v of [null, true, 1.5, "x", [], {}]) {
      for (const k of ["version", "created", "license", "source", "upstream", "rules", "hosts", "aliases", "appends"]) {
        if ((k === "rules" || k === "hosts") && typeof v === "object" && v !== null && !Array.isArray(v)) continue; // {} is an empty map
        if ((k === "upstream" || k === "aliases" || k === "appends") && Array.isArray(v)) continue;
        refused(
          bundle(BASELINE, "baseline", (b) => (b[k] = v)),
          undefined,
        );
      }
      refused(bundle(BASELINE, "baseline", (b) => (b.hosts["login.example.com"] = v)));
      refused(bundle(BASELINE, "baseline", (b) => (b.rules["example-login"] = v)));
    }
  });

  it("holds its header: format, kind, schema, version, created, licence, source", () => {
    refused(
      bundle(BASELINE, "baseline", (b) => (b.format = "sixkey-rule")),
      /format/,
    );
    refused(
      bundle(BASELINE, "baseline", (b) => (b.schema = 2)),
      /schema/,
    );
    refused(
      bundle(BASELINE, "baseline", (b) => (b.kind = "live")),
      /kind/,
    );
    for (const v of [0, -1, 2_147_483_648, Number.MAX_SAFE_INTEGER, 1.5, "3"])
      refused(
        bundle(BASELINE, "baseline", (b) => (b.version = v)),
        /version/,
      );
    for (const v of [1, 2_147_483_647]) expect(bundle(BASELINE, "baseline", (b) => (b.version = v)).ok).toBe(true);
    refused(
      bundle(BASELINE, "baseline", (b) => (b.created = "2026-02-30")),
      /calendar date/,
    );
    // the licence follows the upstream list: MIT joins when Apple's data is in
    refused(
      bundle(BASELINE, "baseline", (b) => (b.license = "AGPL-3.0-or-later")),
      /license/,
    );
    const own = (b: J) => {
      b.upstream = [];
      b.aliases = [];
      b.appends = [];
    };
    expect(bundle(BASELINE, "baseline", (b) => (own(b), (b.license = "AGPL-3.0-or-later"))).ok).toBe(true);
    refused(
      bundle(BASELINE, "baseline", (b) => (own(b), (b.license = "AGPL-3.0-or-later AND MIT"))),
      /license/,
    );
    // the source: empty (a build that names no repository), or an https address in any forge's form (the r2 recheck's
    // R4-5: the tag's place in the address is the template's business, scripts/repo-url.mjs)
    for (const src of [
      "https://github.com/viewtech/sixkey/tree/rules-v3/rules",
      "https://gitlab.com/viewtech/sixkey/-/tree/rules-v3/rules",
      "https://codeberg.org/viewtech/sixkey/src/tag/rules-v3/rules",
      "https://sixkey.app/source/rules-v3.tar.gz",
    ])
      expect(bundle(BASELINE, "baseline", (b) => (b.source = src)).ok, src).toBe(true);
    for (const s of [
      "http://github.com/viewtech/sixkey/tree/rules-v3/rules",
      "https://git hub.com/tree/rules-v3/rules",
      "ftp://example.org/x",
      "github.com/viewtech/sixkey",
      // an address with a host (the review's N6)
      "https://x",
      "https:///",
      "https://example",
      "https://user@example.org/x",
      "https://user:pw@example.org/x",
      "https://example.org:99999/x",
      "https://exa_mple.org/x",
      `https://${"a".repeat(300)}.com`,
      "https://example.org/é",
    ])
      refused(
        bundle(BASELINE, "baseline", (b) => (b.source = s)),
        /source/,
      );
  });

  it("holds hosts and rules to each other: every host to a rule of this bundle, every rule from a host, 16 hosts at most", () => {
    for (const id of ["missing", "constructor", "__proto__", "toString", "hasOwnProperty"])
      refused(
        bundle(BASELINE, "baseline", (b) => (b.hosts["login.example.com"] = id)),
        /not the id of a rule/,
      );
    refused(
      bundle(BASELINE, "baseline", (b) => (b.rules.orphan = b.rules["example-login"])),
      /no host points at it/,
    );
    const many = (n: number) => (b: J) => {
      b.hosts = Object.fromEntries(Array.from({ length: n }, (_, i) => [`h${i}.example.com`, "example-login"]));
    };
    expect(bundle(BASELINE, "baseline", many(16)).ok).toBe(true);
    refused(bundle(BASELINE, "baseline", many(17)), /more than 16 hosts/);
    for (const id of ["Bad", "a b", "x".repeat(65)])
      refused(
        bundle(
          BASELINE,
          "baseline",
          (b) => ((b.rules[id] = b.rules["example-login"]), (b.hosts["z.example.com"] = id)),
        ),
        /rule id/,
      );
    for (const h of ["github.io", "1.2.3.4", "Example.com", "app.fix.test"])
      refused(bundle(BASELINE, "baseline", (b) => (b.hosts[h] = "example-login")));
    expect(
      bundle(BASELINE, "baseline", (b) => (b.hosts["app.fix.test"] = "example-login"), { allowReserved: true }).ok,
    ).toBe(true);
    refused(
      bundle(BASELINE, "baseline", (b) => (b.rules["example-login"].flags = [])),
      /flags/,
    );
  });

  it("holds the alias groups: hosts, sizes, no host twice, and only with an upstream file named", () => {
    const g = (x: unknown) => (b: J) => (b.aliases = [x]);
    refused(bundle(BASELINE, "baseline", g({ s: ["a.com"] })));
    refused(bundle(BASELINE, "baseline", g({ s: Array.from({ length: 65 }, (_, i) => `h${i}.com`) })));
    expect(bundle(BASELINE, "baseline", g({ s: Array.from({ length: 64 }, (_, i) => `h${i}.com`) })).ok).toBe(true);
    refused(bundle(BASELINE, "baseline", g({ s: ["a.com", "a.com"] })), /twice/);
    refused(bundle(BASELINE, "baseline", g({ f: [], t: ["x.com"] })));
    refused(bundle(BASELINE, "baseline", g({ f: ["twitter.com"], t: [] })));
    refused(bundle(BASELINE, "baseline", g({ f: ["a.com"], t: ["a.com"] })), /twice/);
    refused(
      bundle(
        BASELINE,
        "baseline",
        g({
          f: Array.from({ length: 40 }, (_, i) => `f${i}.com`),
          t: Array.from({ length: 25 }, (_, i) => `t${i}.com`),
        }),
      ),
      /more than 64/,
    );
    refused(bundle(BASELINE, "baseline", g({ f: ["twitter.com"] })), /missing field "t"/);
    for (const h of ["github.io", "1.2.3.4", "X.com", "com"])
      refused(bundle(BASELINE, "baseline", g({ s: ["a.com", h] })));
    refused(
      bundle(BASELINE, "baseline", (b) => ((b.upstream = []), (b.license = "AGPL-3.0-or-later"))),
      /upstream/,
    );
    refused(
      bundle(BASELINE, "baseline", (b) => ((b.upstream = []), (b.aliases = []), (b.license = "AGPL-3.0-or-later"))),
      /upstream/,
    ); // appends still there
  });

  it("holds the appends and the upstream entries", () => {
    refused(
      bundle(BASELINE, "baseline", (b) => (b.appends = ["etrade.com", "etrade.com"])),
      /twice/,
    );
    refused(
      bundle(BASELINE, "baseline", (b) => (b.appends = ["co.uk"])),
      /shared/,
    );
    const u = (f: (x: J) => void) => (b: J) => f(b.upstream[0]);
    for (const [k, v] of [
      ["license", "Apache-2.0"],
      ["license", "mit"],
      ["commit", "e6a7cf40"],
      ["commit", "E6A7CF40FE91AA8897B1BE07B0AB416332C31488"],
      ["sha256", "0".repeat(63)],
      ["path", "../quirks/x.json"],
      ["path", "/quirks/x.json"],
      ["path", "quirks/./x.json"],
      ["url", "http://github.com/apple/x"],
      ["url", "https://github.com/apple/x?y"],
      ["id", "Apple"],
    ] as const)
      refused(
        bundle(
          BASELINE,
          "baseline",
          u((x) => (x[k] = v)),
        ),
        new RegExp(k),
      );
    refused(
      bundle(BASELINE, "baseline", (b) => b.upstream.push(structuredClone(b.upstream[0]))),
      /twice/,
    );
  });
});

describe("a live bundle (the plan's M1)", () => {
  it("holds site rules only, and is read like a baseline's", () => {
    const r = bundle(LIVE, "live");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const b = (r as { value: Bundle }).value;
    expect(b.kind).toBe("live");
    expect(b.aliases).toEqual([]);
    expect(b.appends).toEqual([]);
    expect(b.upstream).toEqual([]);
    expect(b.rules.get("example-login")?.minLeft).toBe(8);
  });
  it("is refused whole if it carries aliases, appends or upstream, even empty ones", () => {
    for (const k of ["aliases", "appends", "upstream"])
      for (const v of [BASELINE[k], []])
        refused(
          bundle(LIVE, "live", (b) => (b[k] = v)),
          new RegExp(`^bundle: a live bundle carries no "${k}"`),
        );
  });
  it("names where its source is: never empty (the r2 recheck's R4-5)", () => {
    refused(
      bundle(LIVE, "live", (b) => (b.source = "")),
      /must name its source/,
    );
    refused(
      bundle(LIVE, "live", (b) => (b.source = "http://example.org/x")),
      /source/,
    );
  });
  it("is never read as a baseline, and a baseline never as a live bundle", () => {
    refused(bundle(LIVE, "baseline"), /missing field|kind/);
    refused(bundle(BASELINE, "live"), /carries no/);
    refused(
      bundle(LIVE, "live", (b) => (b.kind = "baseline")),
      /kind/,
    );
    refused(
      bundle(LIVE, "live", (b) => (b.license = "AGPL-3.0-or-later AND MIT")),
      /license/,
    );
  });
});
