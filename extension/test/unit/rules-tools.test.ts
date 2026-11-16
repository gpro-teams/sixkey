// The site rules' folder and its tools (rules/; docs/design/notes/AUTOFILL3-NOTES.md §2, AF3-1b), run as a maintainer
// runs them (Node, type stripping) on copies of rules/ in a temporary folder, never on the network:
//   - the committed bundle is what the sources give, byte for byte, and passes the extension's own checker;
//   - the upstream files are refused on a hash that is not their pin's, on a shape that is not their source's, and on a
//     pin for a file the tools do not know; alias groups come from them only (the plan's M1), and the exclusion list can
//     only take out;
//   - site rules are checked, their hosts claimed once, their fixtures present;
//   - the worklist reads 2fa.directory only to print, and nothing reaches the network unless asked;
//   - import.mjs fetch, against a fake upstream on this machine: every file checked before the first is written, no
//     redirect followed, a size cap counted as the bytes arrive, the pins written (the AF3-1b review's S2);
//   - each tool takes only its own command line, and refuses anything else (the review's S1, N1);
//   - REUSE.toml and LICENSE.md say what each part of rules/ is under.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalHost } from "../../src/core/match";
import { isShared } from "../../src/core/site-domains";
import { validate } from "../../src/core/rules/format";
import { REPO_URL, RULES_AT_TAG, RULES_SOURCE, rulesSource } from "../../scripts/repo-url.mjs";
import { annotationOf, annotations, reuseGlob } from "../helpers/reuse-toml";

const REPO = resolve(import.meta.dirname, "../../..");
const RULES = join(REPO, "rules");
const C = { canonicalHost, isShared };
const read = (p: string) => readFileSync(p, "utf8");
type J = Record<string, any>;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
/** A copy of rules/ to change. */
function copy(): string {
  const d = mkdtempSync(join(tmpdir(), "sixkey-rules-"));
  made.push(d);
  cpSync(RULES, d, { recursive: true });
  return d;
}
/** A tool of rules/tools/, as a maintainer runs it. */
function tool(script: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", join(RULES, "tools", script), ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}
const bundle = (root: string, ...args: string[]) => tool("bundle.mjs", "--root", root, ...args);
/** Change an upstream file of a copy and pin its new hash, so only its shape (not its hash) is what is tested. */
function repin(root: string, vendored: string, text: string) {
  writeFileSync(join(root, "upstream", vendored), text);
  const file = join(root, "upstream", "SOURCES.json");
  const pins = JSON.parse(read(file));
  for (const p of pins.files) if (p.vendored === vendored) p.sha256 = sha(text);
  writeFileSync(file, JSON.stringify(pins, null, 2) + "\n");
}
const APPLE = "apple/shared-credentials.json";
const built = (root: string) => JSON.parse(read(join(root, "build", "baseline.json")));
const out = (root: string, ...args: string[]) => {
  const target = join(root, "out.json");
  const r = bundle(root, "--out", target, ...args);
  return { r, b: r.status === 0 ? (JSON.parse(read(target)) as J) : null };
};
const sorted = (a: string[]) => [...a].sort();
/** Every host of every alias group of a bundle. */
const aliasHosts = (b: J) =>
  new Set((b.aliases as J[]).flatMap((g) => [...(g.s ?? []), ...(g.f ?? []), ...(g.t ?? [])]));

describe("the committed bundle", () => {
  it("is what the sources give (--check), and passes the extension's checker as a baseline", () => {
    const r = tool("bundle.mjs", "--check");
    expect(r.status, r.stderr).toBe(0);
    const raw = built(RULES);
    const v = validate(raw, "baseline", C);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(raw).toMatchObject({
      format: "sixkey-rules",
      kind: "baseline",
      schema: 1,
      license: "AGPL-3.0-or-later AND MIT",
    });
    expect(raw.source).toBe(rulesSource(raw.version));
    expect(raw.version).toBe(JSON.parse(read(join(RULES, "version.json"))).version);
    // its upstream field names the pinned data files, not the licence text
    const pins = JSON.parse(read(join(RULES, "upstream", "SOURCES.json"))).files as J[];
    expect(raw.upstream).toEqual(
      pins
        .filter((p) => p.use !== "licence")
        .map(({ id, url, commit, path, sha256, license }) => ({ id, url, commit, path, sha256, license })),
    );
    expect(raw.aliases).toHaveLength(131);
    expect(raw.appends).toEqual(["auth.redhat.com", "etrade.com", "usaa.com"]);
    expect(raw.rules).toEqual({});
  });
  it("is deterministic: the same sources give the same bytes, again and again", () => {
    const d = copy();
    const a = bundle(d, "--out", join(d, "a.json"));
    const b = bundle(d, "--out", join(d, "b.json"));
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    expect(read(join(d, "a.json"))).toBe(read(join(d, "b.json")));
    expect(read(join(d, "a.json"))).toBe(read(join(RULES, "build", "baseline.json")));
  });
  it("--check fails when it is stale: another version, or a byte of it changed", () => {
    const d = copy();
    writeFileSync(join(d, "version.json"), '{ "version": 2, "created": "2026-11-04" }\n');
    const r = bundle(d, "--check");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is stale/);
    const e = copy();
    const f = join(e, "build", "baseline.json");
    writeFileSync(f, read(f).replace('"x.com"', '"x.org"'));
    expect(bundle(e, "--check").status).toBe(1);
    expect(bundle(copy(), "--check").status).toBe(0);
    // white space is a difference too: the committed file is the bytes the sources give, not a JSON value like them
    for (const edit of [(t: string) => `${t}\n`, (t: string) => ` ${t}`, (t: string) => t.replace(/\n$/, "")]) {
      const w = copy();
      const g = join(w, "build", "baseline.json");
      writeFileSync(g, edit(read(g)));
      expect(bundle(w, "--check").status).toBe(1);
    }
  });
  it("takes Apple's groups as they are: one way stays one way, hosts and groups sorted, nothing dropped today", () => {
    const raw = built(RULES);
    expect(raw.aliases).toContainEqual({ f: ["twitter.com"], t: ["x.com"] });
    expect(raw.aliases).toContainEqual({ s: ["chat.com", "chatgpt.com", "openai.com"] });
    expect(raw.aliases).toContainEqual({ f: ["www.vistaprint.ca"], t: ["account.vistaprint.com"] });
    for (const g of raw.aliases as J[])
      for (const k of ["s", "f", "t"]) if (g[k]) expect(g[k]).toEqual([...g[k]].sort());
    const keys = (raw.aliases as J[]).map((g) => JSON.stringify(g));
    expect(keys).toEqual([...keys].sort());
    // every host of the bundle is a host of Apple's file, in the same place
    const apple = JSON.parse(read(join(RULES, "upstream", APPLE))) as J[];
    const all = new Set(apple.flatMap((e) => [...(e.shared ?? []), ...(e.from ?? []), ...(e.to ?? [])]));
    for (const h of aliasHosts(raw)) expect(all.has(h), h).toBe(true);
    const r = tool("bundle.mjs", "--check", "--report");
    expect(JSON.parse(r.stdout)).toEqual({
      version: raw.version,
      rules: 0,
      hosts: 0,
      aliases: 131,
      appends: 3,
      dropped: { hosts: [], groups: [] },
      idn: [],
    });
  });
});

describe("the upstream files", () => {
  it("are present, match their pins and their source's shape (import.mjs verify, the default)", () => {
    const r = tool("import.mjs");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/3 upstream files present/);
    for (const p of JSON.parse(read(join(RULES, "upstream", "SOURCES.json"))).files as J[]) {
      expect(sha(readFileSync(join(RULES, "upstream", p.vendored))), p.vendored).toBe(p.sha256);
      expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
  it("are refused on any byte that is not their pin's, by import.mjs and by the bundler", () => {
    for (const vendored of [APPLE, "apple/websites-that-append-2fa-to-password.json", "apple/LICENSE.md"]) {
      const d = copy();
      const f = join(d, "upstream", vendored);
      writeFileSync(f, read(f) + " ");
      const i = tool("import.mjs", "--root", d);
      expect(i.status, vendored).toBe(1);
      expect(i.stderr).toMatch(/hash mismatch/);
      expect(bundle(d, "--out", join(d, "o.json")).stderr).toMatch(/hash mismatch/);
    }
  });
  it("are refused on a shape that is not their source's, even when pinned", () => {
    const cases: [string, string][] = [
      [APPLE, JSON.stringify([{ shared: ["a.com", "b.com"], note: "x" }])],
      [APPLE, JSON.stringify([{ from: ["a.com"], to: ["b.com"], fromDomainsAreObsoleted: "yes" }])],
      [APPLE, JSON.stringify([{ from: ["a.com"] }])],
      [APPLE, JSON.stringify([{ shared: [] }])],
      [APPLE, JSON.stringify({ shared: ["a.com", "b.com"] })],
      [APPLE, "not json"],
      ["apple/websites-that-append-2fa-to-password.json", JSON.stringify({ hosts: ["a.com"] })],
      ["apple/LICENSE.md", "All rights reserved.\n"],
    ];
    for (const [vendored, text] of cases) {
      const d = copy();
      repin(d, vendored, text);
      const i = tool("import.mjs", "--root", d);
      expect(i.status, text).toBe(1);
      expect(i.stderr, text).toMatch(/unknown upstream shape|not the MIT notice/);
      expect(bundle(d, "--out", join(d, "o.json")).status, text).toBe(1);
    }
  });
  it("can be pinned only as the tools list them: no other file, no other place, none missing", () => {
    const change = (f: (pins: J) => void) => {
      const d = copy();
      const file = join(d, "upstream", "SOURCES.json");
      const pins = JSON.parse(read(file));
      f(pins);
      writeFileSync(file, JSON.stringify(pins));
      return tool("import.mjs", "--root", d);
    };
    expect(
      change((p) => p.files.push({ ...p.files[0], id: "apple-other", path: "quirks/x.json", vendored: "apple/x.json" }))
        .stderr,
    ).toMatch(/not a file of a known source/);
    expect(change((p) => (p.files[0].vendored = "apple/LICENSE.md")).stderr).toMatch(/vendored is not/);
    expect(change((p) => (p.files[0].path = "quirks/password-rules.json")).stderr).toMatch(/path is not/);
    expect(change((p) => (p.files[0].url = "https://github.com/someone/fork")).stderr).toMatch(/source's address/);
    expect(change((p) => (p.files[0].license = "AGPL-3.0-only")).stderr).toMatch(/source's licence/);
    expect(change((p) => (p.files[0].commit = "main")).stderr).toMatch(/40 hex digits/);
    expect(change((p) => (p.files[0].fetched = "2026-11-4")).stderr).toMatch(/fetched is not a date/);
    expect(change((p) => (p.files[0].sha256 = "0".repeat(63))).stderr).toMatch(/sha256 is not 64 hex digits/);
    expect(change((p) => p.files.pop()).stderr).toMatch(/no pin for "apple-license"/);
    expect(change((p) => (p.files[0].extra = 1)).stderr).toMatch(/not exactly/);
    expect(change((p) => p.files.push(p.files[0])).stderr).toMatch(/twice/);
  });
  it("drop a host Sixkey would not accept, and say so (a shared suffix, an IP address, a name not in the URL parser's form)", () => {
    const d = copy();
    const apple = JSON.parse(read(join(RULES, "upstream", APPLE))) as J[];
    apple.push(
      { shared: ["github.io", "1.2.3.4", "Example-A.com", "example-b.com", "example-c.com"] },
      { shared: ["co.uk", "example-d.com"] },
    );
    repin(d, APPLE, JSON.stringify(apple, null, 4) + "\n");
    const r = bundle(d, "--out", join(d, "o.json"), "--report");
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.dropped.hosts).toEqual(["1.2.3.4", "Example-A.com", "co.uk", "github.io"]);
    expect(report.dropped.groups).toEqual([{ at: 132, why: "fewer than 2 hosts left" }]);
    const b = JSON.parse(read(join(d, "o.json")));
    expect(b.aliases).toContainEqual({ s: ["example-b.com", "example-c.com"] });
    for (const h of ["github.io", "1.2.3.4", "co.uk", "example-d.com"]) expect(aliasHosts(b).has(h), h).toBe(false);
  });
  it("drop a group of more than 64 hosts and a group with a host on both sides, and say so (the review's S3)", () => {
    const d = copy();
    const apple = JSON.parse(read(join(RULES, "upstream", APPLE))) as J[];
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}.com`);
    apple.push(
      { shared: many("big-shared-", 65) },
      { from: ["both-x.com", "from-x.com"], to: ["both-x.com", "to-x.com"] },
      { from: many("big-from-", 33), to: many("big-to-", 32) },
      { shared: many("ok-shared-", 64) },
    );
    repin(d, APPLE, JSON.stringify(apple, null, 4) + "\n");
    const r = bundle(d, "--out", join(d, "o.json"), "--report");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).dropped).toEqual({
      hosts: [],
      groups: [
        { at: 131, why: "more than 64 hosts" },
        { at: 132, why: "a host on both sides" },
        { at: 133, why: "more than 64 hosts" },
      ],
    });
    const b = JSON.parse(read(join(d, "o.json")));
    expect(b.aliases).toHaveLength(132); // Apple's 131 and the group of exactly 64
    expect(b.aliases).toContainEqual({ s: sorted(many("ok-shared-", 64)) });
    for (const h of ["big-shared-0.com", "both-x.com", "from-x.com", "to-x.com", "big-from-0.com", "big-to-0.com"])
      expect(aliasHosts(b).has(h), h).toBe(false);
  });
  it("are refused whole when only the final check of the bundle can see what is wrong: 2,001 groups (the review's S3)", () => {
    const d = copy();
    const groups = Array.from({ length: 2001 - 131 }, (_, i) => ({ shared: [`g${i}-a.com`, `g${i}-b.com`] }));
    repin(d, APPLE, JSON.stringify([...(JSON.parse(read(join(RULES, "upstream", APPLE))) as J[]), ...groups]));
    const target = join(d, "o.json");
    const r = bundle(d, "--out", target);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bundle\.mjs: the bundle: bundle\.aliases.*2000/);
    expect(existsSync(target)).toBe(false); // nothing written
    // 2,000 are a bundle
    repin(d, APPLE, JSON.stringify([...(JSON.parse(read(join(RULES, "upstream", APPLE))) as J[]), ...groups.slice(1)]));
    expect(bundle(d, "--out", target).status).toBe(0);
  });
  it("--report lists every internationalised name for a maintainer to look at: xn-- labels kept, non-ASCII dropped (N3)", () => {
    const d = copy();
    const apple = JSON.parse(read(join(RULES, "upstream", APPLE))) as J[];
    apple.push(
      { shared: ["xn--pypal-4ve.com", "paypal.com"] },
      { from: ["\u043f\u0440\u0438\u043c\u0435\u0440.com"], to: ["example-z.com"] },
    );
    repin(d, APPLE, JSON.stringify(apple));
    const r = bundle(d, "--out", join(d, "o.json"), "--report");
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.idn).toEqual(["xn--pypal-4ve.com", "\u043f\u0440\u0438\u043c\u0435\u0440.com"]);
    expect(report.dropped.hosts).toEqual(["\u043f\u0440\u0438\u043c\u0435\u0440.com"]);
    // the look-alike is in the bundle: only a person can tell it from a real site, so the report names it
    expect(aliasHosts(JSON.parse(read(join(d, "o.json")))).has("xn--pypal-4ve.com")).toBe(true);
  });
});

describe("a key written twice (the AF3-1a review's N4: JSON.parse keeps the last one, nothing after it can see it)", () => {
  it("is refused in a site rule, version.json, exclude.json, SOURCES.json and Apple's files", () => {
    const fails = (d: string, why: RegExp) => {
      const r = bundle(d, "--out", join(d, "o.json"));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(why);
    };
    const rule = copy();
    mkdirSync(join(rule, "sites"), { recursive: true });
    mkdirSync(join(rule, "fixtures", "demo-login"), { recursive: true });
    writeFileSync(join(rule, "fixtures", "demo-login", "a.html"), "<!doctype html>\n");
    writeFileSync(
      join(rule, "sites", "demo-login.json"),
      '{"id":"demo-login","hosts":["login.demo-site.com"],"pages":[{"path":"/","field":"input","segments":0,"fill":"auto"}],' +
        '"verified":"2026-11-01","fixtures":["demo-login/a.html"],"hosts":["www.demo-site.com"]}',
    );
    fails(rule, /sites\/demo-login\.json: the key "hosts" is written twice/);
    const version = copy();
    writeFileSync(join(version, "version.json"), '{ "version": 1, "created": "2026-11-04", "version": 2 }');
    fails(version, /version\.json: the key "version" is written twice/);
    const exclude = copy();
    writeFileSync(
      join(exclude, "upstream", "exclude.json"),
      '{ "hosts": ["twitter.com"], "groupsWith": [], "hosts": [] }',
    );
    fails(exclude, /exclude\.json: the key "hosts" is written twice/);
    const pins = copy();
    const file = join(pins, "upstream", "SOURCES.json");
    writeFileSync(file, read(file).replace('"license": "MIT",', '"license": "MIT", "license": "MIT",'));
    fails(pins, /SOURCES\.json: the key "license" is written twice/);
    // Apple's file, pinned again so only the repeated key is wrong: a group whose first "shared" would be lost
    const apple = copy();
    repin(apple, APPLE, '[{"shared": ["paypal.com", "paypa1-login.com"], "shared": ["a-site.com", "b-site.com"]}]\n');
    fails(apple, /shared-credentials\.json: the key "shared" is written twice/);
    const i = tool("import.mjs", "--root", apple);
    expect(i.status).toBe(1);
    expect(i.stderr).toMatch(/written twice/);
  });
  it("is the same key however it is written: keys are compared as JSON reads them, not as text (the review's S3)", () => {
    // "\u0073hared" is "shared": JSON.parse keeps the second group only
    const d = copy();
    repin(d, APPLE, '[{"shared": ["paypal.com", "paypa1-login.com"], "\\u0073hared": ["a-site.com", "b-site.com"]}]\n');
    const r = bundle(d, "--out", join(d, "o.json"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/shared-credentials\.json: the key "shared" is written twice/);
    expect(tool("import.mjs", "--root", d).stderr).toMatch(/the key "shared" is written twice/);
    const v = copy();
    writeFileSync(join(v, "version.json"), '{ "version": 1, "created": "2026-11-04", "\\u0076ersion": 2 }');
    expect(bundle(v, "--out", join(v, "o.json")).stderr).toMatch(/version\.json: the key "version" is written twice/);
  });
  it("is not confused by keys in strings, escapes or other objects", () => {
    const d = copy();
    mkdirSync(join(d, "sites"), { recursive: true });
    mkdirSync(join(d, "fixtures", "demo-login"), { recursive: true });
    writeFileSync(join(d, "fixtures", "demo-login", "a.html"), "<!doctype html>\n");
    writeFileSync(
      join(d, "sites", "demo-login.json"),
      JSON.stringify({
        id: "demo-login",
        hosts: ["login.demo-site.com"],
        pages: [
          { path: "/a", field: 'input[name="hosts"]', segments: 0, fill: "auto" },
          { path: "/b", field: 'input[aria-label="id: hosts, id"]', segments: 0, fill: "auto" },
        ],
        verified: "2026-11-01",
        fixtures: ["demo-login/a.html"],
        note: 'a note that says "hosts": twice, "hosts": and \\"id\\"',
      }),
    );
    const r = bundle(d, "--out", join(d, "o.json"));
    expect(r.status, r.stderr).toBe(0);
    // a value that is the same string as a later key is a value (the review's N7)
    writeFileSync(
      join(d, "sites", "demo-login.json"),
      '{"id":"demo-login","note":"hosts","hosts":["login.demo-site.com"],"pages":[{"path":"/","field":"input",' +
        '"segments":0,"fill":"auto"}],"verified":"2026-11-01","fixtures":["demo-login/a.html"]}',
    );
    const again = bundle(d, "--out", join(d, "o.json"));
    expect(again.status, again.stderr).toBe(0);
  });
});

describe("the exclusion list", () => {
  const exclude = (root: string, e: unknown) =>
    writeFileSync(join(root, "upstream", "exclude.json"), JSON.stringify(e));
  it("takes hosts and whole groups out, and nothing it takes out comes back", () => {
    const d = copy();
    exclude(d, { hosts: ["twitter.com", "openai.com"], groupsWith: ["proton.me"] });
    const { r, b } = out(d);
    expect(r.status, r.stderr).toBe(0);
    const hosts = aliasHosts(b!);
    for (const h of ["twitter.com", "x.com", "openai.com", "proton.me", "protonvpn.com"])
      expect(hosts.has(h), h).toBe(false);
    expect(b!.aliases).toContainEqual({ s: ["chat.com", "chatgpt.com"] });
    expect(b!.aliases).toHaveLength(129); // the twitter group lost its only f host, the proton group went whole
    // it only removes: every host left is one of the bundle without exclusions, in the same group's place
    const full = built(RULES);
    for (const h of hosts) expect(aliasHosts(full).has(h), h).toBe(true);
  });
  it("takes appends out too", () => {
    const d = copy();
    exclude(d, { hosts: ["usaa.com"], groupsWith: [] });
    expect(out(d).b!.appends).toEqual(["auth.redhat.com", "etrade.com"]);
  });
  it("can say nothing but hosts and groupsWith, and each entry must take something out", () => {
    for (const e of [
      { hosts: [], groupsWith: [], add: [{ s: ["paypal.com", "paypa1-login.com"] }] },
      { hosts: [] },
      [],
      { hosts: "x.com", groupsWith: [] },
    ]) {
      const d = copy();
      exclude(d, e);
      const r = bundle(d, "--out", join(d, "o.json"));
      expect(r.status, JSON.stringify(e)).toBe(1);
      expect(r.stderr).toMatch(/exclude\.json/);
    }
    const d = copy();
    exclude(d, { hosts: ["no-such-host.example.com"], groupsWith: [] });
    expect(bundle(d, "--out", join(d, "o.json")).stderr).toMatch(/takes nothing out/);
  });
});

describe("site rules", () => {
  const RULE = {
    id: "demo-login",
    hosts: ["login.demo-site.com", "www.demo-site.com"],
    pages: [{ path: "/2fa", field: "input#otp", segments: 0, fill: "auto" }],
    flags: ["sent"],
    minLeft: 8,
    verified: "2026-11-01",
    fixtures: ["demo-login/one-box.html"],
  };
  const site = (root: string, name: string, rule: J, fixture = true) => {
    mkdirSync(join(root, "sites"), { recursive: true });
    writeFileSync(join(root, "sites", name), JSON.stringify(rule));
    if (!fixture) return;
    mkdirSync(join(root, "fixtures", "demo-login"), { recursive: true });
    writeFileSync(join(root, "fixtures", "demo-login", "one-box.html"), "<!doctype html><input id=otp>\n");
  };
  it("are checked by the extension's checker and bundled: their pages, flags and minLeft, each host to its rule", () => {
    const d = copy();
    site(d, "demo-login.json", RULE);
    const { r, b } = out(d);
    expect(r.status, r.stderr).toBe(0);
    expect(b!.rules).toEqual({ "demo-login": { pages: RULE.pages, flags: ["sent"], minLeft: 8 } });
    expect(b!.hosts).toEqual({ "login.demo-site.com": "demo-login", "www.demo-site.com": "demo-login" });
    expect(validate(b, "baseline", C).ok).toBe(true);
  });
  it("are refused when the checker refuses them, when the file is not named after the id, when a fixture is missing", () => {
    const fails = (name: string, rule: J, fixture = true) => {
      const d = copy();
      site(d, name, rule, fixture);
      const r = bundle(d, "--out", join(d, "o.json"));
      expect(r.status, name).toBe(1);
      return r.stderr;
    };
    expect(fails("demo-login.json", { ...RULE, wait: 500 })).toMatch(/unknown field "wait"/);
    expect(fails("other.json", RULE)).toMatch(/must be demo-login\.json/);
    expect(fails("Demo.json", RULE)).toMatch(/not <rule id>\.json/);
    expect(fails("demo-login.json", RULE, false)).toMatch(/fixture fixtures\/demo-login\/one-box\.html is missing/);
    expect(fails("demo-login.json", { ...RULE, hosts: ["github.io"] })).toMatch(/shared suffix/);
  });
  it("skip a name starting with a dot in sites/ (.DS_Store, which Finder makes), and refuse any other stray file (N2)", () => {
    const d = copy();
    site(d, "demo-login.json", RULE);
    writeFileSync(join(d, "sites", ".DS_Store"), Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]));
    mkdirSync(join(d, "sites", ".git-keep"));
    const { r, b } = out(d);
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(b!.rules)).toEqual(["demo-login"]);
    writeFileSync(join(d, "sites", "notes.txt"), "x");
    expect(bundle(d, "--out", join(d, "o.json")).stderr).toMatch(/sites\/notes\.txt: not <rule id>\.json/);
  });
  it("claim each host once across all files", () => {
    const d = copy();
    site(d, "demo-login.json", RULE);
    writeFileSync(
      join(d, "sites", "demo-two.json"),
      JSON.stringify({ ...RULE, id: "demo-two", hosts: ["www.demo-site.com"], fixtures: ["demo-two/a.html"] }),
    );
    mkdirSync(join(d, "fixtures", "demo-two"), { recursive: true });
    writeFileSync(join(d, "fixtures", "demo-two", "a.html"), "<!doctype html>\n");
    const r = bundle(d, "--out", join(d, "o.json"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/www\.demo-site\.com is already a host of sites\/demo-login\.json/);
  });
});

describe("the worklist (2fa.directory, a maintainer's list, never stored)", () => {
  it("without --from or --fetch says how to run it and stops, before any network", () => {
    const r = tool("worklist.mjs");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });
  it("lists the sites that have no rule, says where the data is from, and writes nothing", () => {
    const d = copy();
    const RULE = {
      format: "sixkey-rules", kind: "baseline", schema: 1, version: 1, created: "2026-11-04", license: "AGPL-3.0-or-later", source: "",
      upstream: [], rules: { b: { pages: [{ path: "/", field: "input", segments: 0, fill: "auto" }] } }, hosts: { "b-site.com": "b" }, aliases: [], appends: [],
    }; // prettier-ignore
    writeFileSync(join(d, "build", "baseline.json"), JSON.stringify(RULE));
    const saved = mkdtempSync(join(tmpdir(), "sixkey-2fa-"));
    made.push(saved);
    const v4 = join(saved, "totp.json");
    writeFileSync(
      v4,
      JSON.stringify({
        "a-site.com": { methods: ["totp"] },
        "b-site.com": { methods: ["totp", "sms"] },
        "c-site.com": { methods: ["totp"], documentation: "https://c-site.com/2fa" },
      }),
    );
    const before = listing(d);
    const r = tool("worklist.mjs", "--root", d, "--from", v4);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("a-site.com\nc-site.com\n");
    expect(r.stderr).toMatch(/Data sourced from 2FA Directory by 2factorauth/);
    expect(listing(d)).toEqual(before);
    writeFileSync(v4, JSON.stringify(["a-site.com"]));
    expect(tool("worklist.mjs", "--root", d, "--from", v4).status).toBe(1);
  });
  it("prints only names a terminal reads as text, and quotes what it refuses (the review's N7)", () => {
    const saved = mkdtempSync(join(tmpdir(), "sixkey-2fa-"));
    made.push(saved);
    const v4 = join(saved, "totp.json");
    const names = [
      "a-site.com",
      "UPPER-site.com",
      "evil\u001b[2J.com",
      "no-dot",
      "a site.com",
      "b_site.com",
      "c\u00e9.com",
    ];
    writeFileSync(v4, JSON.stringify(Object.fromEntries(names.map((n) => [n, { methods: ["totp"] }]))));
    const r = tool("worklist.mjs", "--root", copy(), "--from", v4);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("a-site.com\n");
    writeFileSync(v4, JSON.stringify({ "evil\u001b[2J.com": {} }));
    const bad = tool("worklist.mjs", "--root", copy(), "--from", v4);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('"evil\\u001b[2J.com": not the v4 shape');
    expect(bad.stderr).not.toContain("\u001b");
  });
  it("takes exactly one of --from and --fetch, and refuses anything else before any network", () => {
    for (const args of [
      ["--from"],
      ["--from", "x", "--fetch"],
      ["--fetch", "--fetch"],
      ["--bogus"],
      ["list"],
      ["-fetch"],
    ]) {
      const r = tool("worklist.mjs", ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/usage: node rules\/tools\/worklist\.mjs/);
      expect(r.stdout).toBe("");
    }
  });
  it("only import.mjs fetch and worklist.mjs --fetch can reach the network", () => {
    const src = (f: string) => read(join(RULES, "tools", f)).replace(/\/\/.*$/gm, "");
    expect(src("upstream.mjs")).not.toMatch(/\bfetch\b|https?\.request|node:https?|node:net/);
    expect(src("bundle.mjs")).not.toMatch(/\bfetch\b|https?\.request|node:https?|node:net/);
    expect(src("import.mjs").match(/\bfetch\(/g)).toHaveLength(1); // download(), called by fetchSource() only
    expect(src("import.mjs")).toMatch(/if \(a\.cmd === "fetch"\) await fetchSource\(/);
    expect(src("worklist.mjs").match(/\bfetch\(/g)).toHaveLength(1);
    expect(src("worklist.mjs")).toMatch(/else if \(o\["--fetch"\]\) \{\n\s*const res = await fetch\(/);
  });
});
describe("the tools' command lines: their own words only, anything else refused with the usage (the review's S1, N1)", () => {
  it("import.mjs: verify (the default) or fetch <source> <commit>; the first word is read without --root too", () => {
    expect(tool("import.mjs").status).toBe(0);
    expect(tool("import.mjs", "verify").status).toBe(0);
    for (const args of [
      ["fetch"],
      ["fetch", "apple"],
      ["fetch", "apple", "0".repeat(40), "extra"],
      ["bogus"],
      ["verify", "extra"],
      ["--bogus"],
      ["-v"],
      ["--root"],
      ["--root", RULES, "--root", RULES],
    ]) {
      const r = tool("import.mjs", ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/usage: node rules\/tools\/import\.mjs \[verify\] \| fetch <source> <commit>/);
    }
    // README's command, as written (no --root): its words reach fetch, which refuses here before anything is read or sent
    const nosuch = tool("import.mjs", "fetch", "nosuch", "0".repeat(40));
    expect(nosuch.status).toBe(1);
    expect(nosuch.stderr).toMatch(/import\.mjs: no source "nosuch" \(known: apple\)/);
    expect(tool("import.mjs", "fetch", "__proto__", "0".repeat(40)).stderr).toMatch(/no source "__proto__"/);
    expect(tool("import.mjs", "fetch", "apple", "main").stderr).toMatch(/the commit must be 40 hex digits/);
  });
  it("bundle.mjs: --check, --report, --root <dir>, --out <file>, each once; a word such as check writes nothing", () => {
    const d = copy();
    const target = join(d, "o.json");
    for (const args of [
      ["check"],
      ["-check"],
      ["--check", "--check"],
      ["--out"],
      ["--bogus"],
      ["--out", target, "x"],
    ]) {
      const r = bundle(d, "--out", target, ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/usage: node rules\/tools\/bundle\.mjs/);
      expect(existsSync(target), args.join(" ")).toBe(false);
    }
    expect(tool("bundle.mjs", "--root", d, "--root", d, "--check").status).toBe(2);
    expect(bundle(d, "--check", "--report").status).toBe(0);
  });
});

describe("import.mjs fetch, against a fake upstream on this machine (the review's S2; no network)", () => {
  const COMMIT = "c0ffee".padEnd(40, "0");
  const PREFIX = `/apple/password-manager-resources/${COMMIT}/`;
  const PATHS = {
    aliases: `${PREFIX}quirks/shared-credentials.json`,
    appends: `${PREFIX}quirks/websites-that-append-2fa-to-password.json`,
    licence: `${PREFIX}LICENSE.md`,
  };
  /** Valid upstream files, other than the vendored ones (so their new pins show). */
  const valid = () => {
    const apple = JSON.parse(read(join(RULES, "upstream", APPLE))) as J[];
    return {
      [PATHS.aliases]: JSON.stringify([...apple, { shared: ["new-site-a.com", "new-site-b.com"] }], null, 4) + "\n",
      [PATHS.appends]: JSON.stringify(["auth.redhat.com", "etrade.com", "usaa.com", "new-bank.com"], null, 4) + "\n",
      [PATHS.licence]: read(join(RULES, "upstream", "apple", "LICENSE.md")),
    } as Record<string, Served>;
  };
  type Served = string | { redirect: string } | { stream: number };
  const dir = mkdtempSync(join(tmpdir(), "sixkey-fake-upstream-"));
  made.push(dir);
  // preloaded into the tool: its requests go to the fake upstream instead of raw.githubusercontent.com, made by the real
  // fetch with the tool's own options (so a redirect is refused or followed as it would be), and each is logged
  const STUB = join(dir, "to-fake-upstream.mjs");
  writeFileSync(
    STUB,
    `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const u = new URL(url);
  appendFileSync(process.env.SIXKEY_FAKE_LOG, JSON.stringify({ url: u.href, method: init.method ?? "GET",
    credentials: init.credentials ?? null, redirect: init.redirect ?? null, signal: init.signal instanceof AbortSignal }) + "\\n");
  if (u.origin !== "https://raw.githubusercontent.com") return Promise.reject(new Error("not the upstream's address"));
  return real(process.env.SIXKEY_FAKE_UPSTREAM + u.pathname, init);
};
`,
  );
  /** The fake upstream: `served` by path, 404 for any other; each request with the bytes sent for it. */
  async function upstream(served: Record<string, Served>) {
    const requests: { path: string; method: string; sent: number }[] = [];
    const server = createServer((req, res) => {
      const r = { path: req.url ?? "", method: req.method ?? "", sent: 0 };
      requests.push(r);
      const s = served[r.path];
      if (s === undefined) return void res.writeHead(404).end();
      if (typeof s === "string") return void res.writeHead(200, { "content-type": "text/plain" }).end(s);
      if ("redirect" in s) return void res.writeHead(302, { location: s.redirect }).end();
      // `stream` bytes in chunks, with no Content-Length: only counting as they arrive can stop it
      let closed = false;
      res.on("close", () => (closed = true));
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const more = () => {
        while (!closed && r.sent < s.stream) {
          r.sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", more);
        }
        if (!closed) res.end();
      };
      more();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, requests, close: () => new Promise<void>((ok) => server.close(() => ok())) };
  }
  /** import.mjs with the stub, run asynchronously (the fake upstream answers from this process). */
  function run(base: string, log: string, ...args: string[]) {
    return new Promise<{ status: number | null; stderr: string }>((ok) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--import",
          pathToFileURL(STUB).href,
          join(RULES, "tools", "import.mjs"),
          ...args,
        ],
        {
          env: { ...process.env, SIXKEY_FAKE_UPSTREAM: base, SIXKEY_FAKE_LOG: log },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (b) => (stderr += b));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("close", (status) => (clearTimeout(timer), ok({ status, stderr })));
    });
  }
  /** One fetch into a fresh copy: the result, the requests the server saw, the options the tool used, the copy before and after. */
  async function fetchInto(served: Record<string, Served>, commit = COMMIT) {
    const d = copy();
    const log = join(dir, `log-${made.length}-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(log, "");
    const up = await upstream(served);
    const before = listing(d);
    try {
      const r = await run(up.base, log, "fetch", "apple", commit, "--root", d);
      const sent = read(log)
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as J);
      return { d, r, requests: up.requests, sent, before, after: listing(d) };
    } finally {
      await up.close();
    }
  }
  it("writes the files exactly as served, pins each by commit and SHA-256, then verifies; GET only, no credentials, no redirects", async () => {
    const served = valid();
    const day0 = new Date().toISOString().slice(0, 10);
    const { d, r, requests, sent } = await fetchInto(served);
    const day1 = new Date().toISOString().slice(0, 10);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/apple at c0ffee0+: 3 files written and pinned/);
    expect(r.stderr).toMatch(/3 upstream files present, matching their pins/);
    // N4: the commit's history is the maintainer's to check, and the tool says how
    expect(r.stderr).toMatch(/own history, not a fork's/);
    expect(r.stderr).toContain(`git merge-base --is-ancestor ${COMMIT} origin/main`);
    const old = JSON.parse(read(join(RULES, "upstream", "SOURCES.json"))).files as J[];
    const pins = JSON.parse(read(join(d, "upstream", "SOURCES.json"))).files as J[];
    expect(pins.map((p) => p.id)).toEqual(old.map((p) => p.id));
    for (const [use, path] of Object.entries(PATHS)) {
      const pin = pins.find((p) => p.use === use)!;
      const text = served[path] as string;
      expect(read(join(d, "upstream", pin.vendored)), use).toBe(text);
      expect(pin.sha256, use).toBe(sha(text));
      expect(pin.commit, use).toBe(COMMIT);
      expect([day0, day1], use).toContain(pin.fetched);
      const was = old.find((p) => p.use === use)!;
      for (const k of ["id", "source", "url", "path", "vendored", "use", "license"])
        expect(pin[k], `${use} ${k}`).toBe(was[k]);
    }
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual(Object.values(PATHS).map((p) => `GET ${p}`));
    expect(sent).toEqual(
      Object.values(PATHS).map((p) => ({
        url: `https://raw.githubusercontent.com${p}`,
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: true,
      })),
    );
    // then, as README says: the report shows the new group, and the committed bundle is stale until it is rebuilt
    const report = bundle(d, "--out", join(d, "o.json"), "--report");
    expect(JSON.parse(report.stdout).aliases).toBe(132);
    expect(bundle(d, "--check").status).toBe(1);
  });
  it("follows no redirect: the file is refused, its target never asked for, nothing written", async () => {
    const served = valid();
    served["/elsewhere.json"] = served[PATHS.aliases]!;
    served[PATHS.aliases] = { redirect: "/elsewhere.json" };
    const { r, requests, before, after } = await fetchInto(served);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /import\.mjs: https:\/\/raw\.githubusercontent\.com\/.*shared-credentials\.json: .*redirect/,
    );
    expect(requests.map((q) => q.path)).toEqual([PATHS.aliases]);
    expect(after).toEqual(before);
  });
  it("checks each file's shape before anything is written: a bad first file stops it there, a bad last one writes nothing", async () => {
    const first = valid();
    first[PATHS.aliases] = JSON.stringify({ shared: ["a-site.com", "b-site.com"] });
    const a = await fetchInto(first);
    expect(a.r.status).toBe(1);
    expect(a.r.stderr).toMatch(/unknown upstream shape/);
    expect(a.requests).toHaveLength(1);
    expect(a.after).toEqual(a.before);
    const last = valid();
    last[PATHS.licence] = "All rights reserved.\n";
    const b = await fetchInto(last);
    expect(b.r.status).toBe(1);
    expect(b.r.stderr).toMatch(/not the MIT notice/);
    expect(b.requests).toHaveLength(3);
    expect(b.after).toEqual(b.before);
    const twice = valid();
    twice[PATHS.appends] = '{"x": 1, "x": 2}';
    const c = await fetchInto(twice);
    expect(c.r.status).toBe(1);
    expect(c.r.stderr).toMatch(/written twice/);
    expect(c.after).toEqual(c.before);
  });
  it("writes nothing when a file is missing upstream (HTTP 404)", async () => {
    const served = valid();
    delete served[PATHS.appends];
    const { r, before, after } = await fetchInto(served);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/HTTP 404/);
    expect(after).toEqual(before);
  });
  it("stops reading at 2 MiB, counting as the bytes arrive (the review's N5), and by Content-Length when it says more", async () => {
    const streamed = valid();
    streamed[PATHS.aliases] = { stream: 64 * 1024 * 1024 };
    const a = await fetchInto(streamed);
    expect(a.r.status).toBe(1);
    expect(a.r.stderr).toMatch(/larger than 2097152 bytes/);
    expect(a.after).toEqual(a.before);
    // the server stopped long before its 64 MiB: the tool hung up after 2 MiB and what the connection's buffers held
    expect(a.requests[0]!.sent).toBeLessThan(16 * 1024 * 1024);
    const declared = valid();
    declared[PATHS.aliases] = " ".repeat(2 * 1024 * 1024 + 1);
    const b = await fetchInto(declared);
    expect(b.r.status).toBe(1);
    expect(b.r.stderr).toMatch(/larger than 2097152 bytes/);
    expect(b.after).toEqual(b.before);
  });
  it("asks for nothing, and writes nothing, on a commit that is not a full commit id", async () => {
    for (const commit of ["main", "C0FFEE".padEnd(40, "0"), "c0ffee"]) {
      const { r, requests, sent, before, after } = await fetchInto(valid(), commit);
      expect(r.status, commit).toBe(1);
      expect(r.stderr).toMatch(/40 hex digits/);
      expect(requests).toEqual([]);
      expect(sent).toEqual([]);
      expect(after).toEqual(before);
    }
  });
});

/** Every file under `dir`, with its size and hash. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${relative(dir, p)} ${sha(readFileSync(p))}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe("the repository's address (scripts/repo-url.mjs)", () => {
  it("is the public repository, so a bundle's source is its rules folder at the version's tag", () => {
    expect(REPO_URL).toBe("https://github.com/gpro-teams/sixkey");
    expect(RULES_SOURCE).toBe("https://github.com/gpro-teams/sixkey/tree/rules-v{version}/rules");
    expect(rulesSource(3)).toBe("https://github.com/gpro-teams/sixkey/tree/rules-v3/rules");
    // with no address, as before the repository was public, the source is empty
    expect(rulesSource(3, "")).toBe("");
  });
  it("names one repository: RULES_SOURCE is made from REPO_URL, never written on its own (the review's N9)", () => {
    expect(RULES_SOURCE).toBe(REPO_URL === "" ? "" : `${REPO_URL}${RULES_AT_TAG}`);
    const text = read(join(REPO, "extension", "scripts", "repo-url.mjs"));
    expect(text).toMatch(/^export const RULES_SOURCE = REPO_URL === "" \? "" : `\$\{REPO_URL\}\$\{RULES_AT_TAG\}`;$/m);
    expect(text.match(/^export const RULES_SOURCE\b/gm)).toHaveLength(1);
    // what it gives once REPO_URL is set: GitHub's form of the tag's folder
    expect(RULES_AT_TAG).toMatch(/^\/[\x21-\x7e]*\{version\}[\x21-\x7e]*$/);
    expect(rulesSource(3, `https://github.com/o/sixkey${RULES_AT_TAG}`)).toBe(
      "https://github.com/o/sixkey/tree/rules-v3/rules",
    );
  });
  it("fills the template's {version}, in any forge's form, and refuses a template that is not an https address with one", () => {
    expect(rulesSource(3, "https://github.com/o/sixkey/tree/rules-v{version}/rules")).toBe(
      "https://github.com/o/sixkey/tree/rules-v3/rules",
    );
    expect(rulesSource(12, "https://codeberg.org/o/sixkey/src/tag/rules-v{version}/rules")).toBe(
      "https://codeberg.org/o/sixkey/src/tag/rules-v12/rules",
    );
    for (const t of [
      "http://github.com/o/s/tree/rules-v{version}/rules",
      "https://github.com/o/s/tree/main/rules",
      "github.com/{version}",
    ])
      expect(() => rulesSource(3, t), t).toThrow(/RULES_SOURCE/);
  });
});

describe("the licences of rules/", () => {
  const entries = annotations(REPO);
  /** The annotation REUSE gives a path: the last entry that matches it, its globs read as reuse-tool reads them. */
  const entryOf = (p: string) => annotationOf(entries, p);
  it("REUSE's globs as the specification and reuse-tool read them: \"**/\" also matches no folder at all (the review's N6)", () => {
    const cases: [string, string, boolean][] = [
      ["extension/**/*.md", "extension/README.md", true],
      ["extension/**/*.md", "extension/docs/a/b.md", true],
      ["rules/**/*.md", "rules/README.md", true],
      ["**/*.md", "README.md", true],
      ["**/*.md", "a/b/c.md", true],
      ["*.md", "README.md", true],
      ["*.md", "docs/README.md", false],
      ["rules/**", "rules/upstream/apple/LICENSE.md", true],
      ["rules/**", "rulesx/a", false],
      ["rules/build/**", "rules/baseline.json", false],
      ["extension/**/*.md", "extension/a.mdx", false],
      ["contract/rules/1/**", "contract/rules/1/live.schema.json", true],
      ["\\*.md", "*.md", true],
      ["\\*.md", "a.md", false],
    ];
    for (const [g, p, hit] of cases) expect(reuseGlob(g).test(p), `${g} ${p}`).toBe(hit);
  });
  it("REUSE.toml: the rules AGPL, their documents CC-BY, the bundle AGPL and MIT with both copyright lines, Apple's files MIT", () => {
    const want: [string, string][] = [
      ["rules/sites/demo-login.json", "AGPL-3.0-or-later"],
      ["rules/fixtures/demo-login/one-box.html", "AGPL-3.0-or-later"],
      ["rules/tools/bundle.mjs", "AGPL-3.0-or-later"],
      ["rules/NOTICE", "AGPL-3.0-or-later"],
      ["rules/version.json", "AGPL-3.0-or-later"],
      ["rules/upstream/SOURCES.json", "AGPL-3.0-or-later"],
      ["rules/upstream/exclude.json", "AGPL-3.0-or-later"],
      ["rules/README.md", "CC-BY-4.0"],
      ["rules/CONTRIBUTING.md", "CC-BY-4.0"],
      // a document at the top of a component folder: "extension/**/*.md" matches it, so it is CC-BY (the review's §3)
      ["extension/README.md", "CC-BY-4.0"],
      ["api/server/README.md", "CC-BY-4.0"],
      ["extension/src/core/rules/format.ts", "MPL-2.0"],
      ["rules/build/baseline.json", "AGPL-3.0-or-later AND MIT"],
      ["rules/upstream/apple/shared-credentials.json", "MIT"],
      ["rules/upstream/apple/LICENSE.md", "MIT"],
      ["extension/scripts/repo-url.mjs", "MPL-2.0"],
    ];
    for (const [p, id] of want) expect(entryOf(p)?.id, p).toBe(id);
    expect(entryOf("rules/build/baseline.json")!.text).toContain(
      '["2026 VIEW TECH LTD and Sixkey contributors", "2020 - 2026 Apple Inc."]',
    );
    expect(entryOf("rules/upstream/apple/LICENSE.md")!.text).toContain(
      'SPDX-FileCopyrightText = "2020 - 2026 Apple Inc."',
    );
    // every file now under rules/ is one of these
    for (const f of listing(RULES).map((l) => `rules/${l.split(" ")[0]}`))
      expect(["AGPL-3.0-or-later", "CC-BY-4.0", "AGPL-3.0-or-later AND MIT", "MIT"], f).toContain(entryOf(f)?.id);
  });
  it("NOTICE carries Apple's notice, Prettier leaves the pinned and generated files alone, LICENSE.md lists the parts", () => {
    const notice = read(join(RULES, "NOTICE")).replace(/\s+/g, " ");
    const mit = read(join(RULES, "upstream", "apple", "LICENSE.md"))
      .replace(/\s+/g, " ")
      .trim();
    expect(notice).toContain(mit);
    const ignore = read(join(REPO, ".prettierignore")).split("\n");
    expect(ignore).toContain("rules/build/");
    expect(ignore).toContain("rules/upstream/");
    const licence = read(join(REPO, "LICENSE.md"));
    for (const p of ["rules/", "rules/build/", "rules/upstream/apple/"])
      expect(licence).toMatch(new RegExp(`\\| \`${p}\` +\\|`));
  });
});
