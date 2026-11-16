// The site rules' format, schema 1 (TOTP autofill Stage 3; docs/design/notes/AUTOFILL3-NOTES.md, AF3-1a): what a site rule
// file under rules/sites/ may say, and what a bundle of rules may hold, checked in full before anything reads it.
//
// Closed: an unknown field anywhere, a value of the wrong type, or a value out of its bounds rejects the whole object, never
// a part of it. Every field is a value that packaged code already knows what to do with: there are no expressions,
// conditions, sequences, waits, scripts or regular expressions, and the one string a page ever receives from here, a
// rule's `field`, is a CSS selector of a small grammar with no pseudo-classes (a query, never a program).
//
// Two kinds of bundle (the plan's M1):
//   baseline  the bundle built into each release: site rules, plus the alias groups and the "code after the password"
//             hosts imported from upstream files whose hashes are pinned (rules/upstream/SOURCES.json);
//   live      a bundle downloaded later (the updater, behind its build gate): site rules only, and all of them: it
//             replaces the baseline's rules and hosts whole (lookup.ts inEffect), so a rule that was wrong can be taken
//             out between releases. A live bundle that carries `aliases`, `appends` or `upstream` is rejected whole, so a
//             signed download can never make Sixkey say that a page and an account's site are the same sign-in; and it
//             must name where its source is (`source`, never empty).
//
// It imports nothing at run time (the plan's C10, N7): the two host checks it needs, match.ts canonicalHost and
// site-domains.ts isShared, are passed in, so the same file runs in the extension (built by Vite) and in rules/tools/ under
// Node's type stripping, which cannot resolve the extension's extensionless imports (test/unit/rules-contract.test.ts
// loads it that way). The JSON Schemas of contract/rules/1/ (CC0-1.0) describe the same format for other implementations;
// the same test holds them to SHAPE and LIMITS below. What a schema cannot say (canonical hosts, shared suffixes, a
// fixture under its own rule's folder, hosts pointing at rules) only this file checks.

/** The `format` of every bundle. */
export const FORMAT = "sixkey-rules";
/** The one schema version this code reads. A bundle of another version is rejected: new behaviour needs a release. */
export const SCHEMA = 1;
/** The licence of a bundle without upstream data, and of one with it (Apple's data is MIT: rules/upstream/). */
export const LICENSE = "AGPL-3.0-or-later";
export const LICENSE_WITH_UPSTREAM = "AGPL-3.0-or-later AND MIT";

/** The fields of each object, required and optional. Nothing else may appear. */
export const SHAPE = {
  siteRule: { required: ["id", "hosts", "pages", "verified", "fixtures"], optional: ["flags", "minLeft", "note"] },
  page: { required: ["path", "field", "segments", "fill"], optional: [] },
  bundleRule: { required: ["pages"], optional: ["flags", "minLeft"] },
  upstream: { required: ["id", "url", "commit", "path", "sha256", "license"], optional: [] },
  shared: { required: ["s"], optional: [] },
  oneWay: { required: ["f", "t"], optional: [] },
  baseline: {
    required: [
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
    ],
    optional: [],
  },
  live: {
    required: ["format", "kind", "schema", "version", "created", "license", "source", "rules", "hosts"],
    optional: [],
  },
} as const;

/** The bounds. Inclusive. */
export const LIMITS = {
  id: 64,
  hosts: [1, 16],
  host: 253,
  pages: [1, 8],
  path: 128,
  field: 200,
  compounds: 8,
  segments: [4, 8],
  minLeft: [5, 20],
  fixtures: [1, 8],
  fixtureName: 64,
  note: 280,
  version: [1, 2_147_483_647],
  source: 300,
  upstream: 16,
  upstreamId: 48,
  url: 200,
  upstreamPath: 200,
  rules: 5000,
  hostEntries: 20_000,
  aliases: 2000,
  group: [2, 64],
  appends: 1000,
} as const;

export const FILLS = ["auto", "chars", "paste"] as const;
export const FLAGS = ["sent"] as const;
/** The only inbound licence an upstream file may have (a new one needs a licence review and a schema change). */
export const UPSTREAM_LICENSES = ["MIT"] as const;
/** Names that never belong in a bundle a store build carries: the e2e build's test rules use them (allowReserved). */
export const RESERVED_TLDS = ["test", "example", "invalid", "localhost"] as const;

export type Fill = (typeof FILLS)[number];
export type Page = { path: string; field: string; segments: number; fill: Fill };
/** A rule as a bundle holds it, normalised: `sent` from `flags`, `minLeft` null when the rule has none. */
export type Rule = { pages: Page[]; sent: boolean; minLeft: number | null };
/** A rule file of rules/sites/, checked. */
export type SiteRule = { id: string; hosts: string[]; rule: Rule; verified: string; fixtures: string[] };
/** An alias group: `s`, every host the same sign-in; `f` → `t`, the `f` hosts' accounts offered on the `t` hosts only. */
export type AliasGroup = { s: string[] } | { f: string[]; t: string[] };
export type Upstream = { id: string; url: string; commit: string; path: string; sha256: string; license: "MIT" };
/** A bundle, checked. `rules` by id; `hosts` maps each exact host to its rule's id; `hostsOf` is the reverse. */
export type Bundle = {
  kind: "baseline" | "live";
  version: number;
  created: string;
  license: string;
  source: string;
  upstream: Upstream[];
  rules: Map<string, Rule>;
  hosts: Map<string, string>;
  hostsOf: Map<string, string[]>;
  aliases: AliasGroup[];
  appends: string[];
};
export type Kind = "rule" | "baseline" | "live";
/** match.ts canonicalHost and site-domains.ts isShared, passed in (see the header). */
export type HostChecks = { canonicalHost(s: string): string | null; isShared(d: string): boolean };
export type Options = {
  /** Accept hosts under RESERVED_TLDS (the e2e build's test rules). Default: refused. */
  allowReserved?: boolean;
  /** Today, YYYY-MM-DD, for a rule's `verified` (a test passes it). Default: the clock's date in UTC. */
  today?: string;
};
/** What a check says: the value, or the first reason it was refused (`where: why`). */
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

class Refused extends Error {}
function refuse(at: string, why: string): never {
  throw new Refused(`${at}: ${why}`);
}

/** A plain object, as JSON.parse makes it, with any fields. */
function plain(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) refuse(at, "not an object");
  if (Object.getPrototypeOf(v) !== Object.prototype) refuse(at, "not a plain object");
  return v as Record<string, unknown>;
}
/** A plain object with exactly the allowed fields. */
function object(
  v: unknown,
  at: string,
  shape: { readonly required: readonly string[]; readonly optional: readonly string[] },
) {
  const o = plain(v, at);
  for (const k of Object.keys(o))
    if (!shape.required.includes(k) && !shape.optional.includes(k)) refuse(at, `unknown field "${k.slice(0, 80)}"`);
  for (const k of shape.required) if (!Object.hasOwn(o, k)) refuse(at, `missing field "${k}"`);
  return o;
}
function text(v: unknown, at: string, max: number, re?: RegExp): string {
  if (typeof v !== "string") refuse(at, "not a string");
  if (v.length > max) refuse(at, `longer than ${max} characters`);
  if (re && !re.test(v)) refuse(at, "not in the allowed form");
  return v;
}
function int(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) refuse(at, "not an integer");
  if (v < min || v > max) refuse(at, `outside ${min} to ${max}`);
  return v;
}
function list(v: unknown, at: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) refuse(at, "not a list");
  if (v.length < min || v.length > max) refuse(at, `not ${min} to ${max} items`);
  return v;
}
function unique(items: readonly string[], at: string) {
  if (new Set(items).size !== items.length) refuse(at, "an item appears twice");
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function date(v: unknown, at: string): string {
  const d = text(v, at, 10, DATE);
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) refuse(at, "not a calendar date");
  return d;
}

/** The same test as match.ts isIpHost (repeated so this file imports nothing; rules-format.test checks they agree). */
const isIp = (h: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.startsWith("[");
const RESERVED = new RegExp(`\\.(?:${RESERVED_TLDS.join("|")})$`);
/** A host as the URL parser writes it, of two labels or more, not an IP address, not a shared suffix. */
function host(v: unknown, at: string, c: HostChecks, o: Options): string {
  const h = text(v, at, LIMITS.host);
  if (c.canonicalHost(h) !== h) refuse(at, `"${h}" is not a host name as the URL parser writes it`);
  if (isIp(h)) refuse(at, `"${h}" is an IP address`);
  if (!h.includes(".")) refuse(at, `"${h}" is a single label`);
  if (c.isShared(h)) refuse(at, `"${h}" is a shared suffix, or above one`);
  if (!o.allowReserved && RESERVED.test(h)) refuse(at, `"${h}" is a reserved name`);
  return h;
}

// The selector grammar: compound selectors joined by exactly one space (descendant) or " > " (child; "a>b" is refused).
// A compound is an optional type, then any of: at most one #id, .class, [name], [name="value"], [name^="value"],
// [name~="word"]. Ids and classes are CSS identifiers without escapes: an optional "-", then a letter or "_", then letters,
// digits, "_" and "-" (so #1a and .2fa, which a browser refuses, are refused here too; an id like ":r1:" is written
// [id=":r1:"], a class like "2fa-code" [class~="2fa-code"]). A value is printable ASCII without '"' or '\'; a word, the
// same without spaces, and not empty.
const TOKEN =
  /([a-z][a-z0-9-]*)|(#-?[A-Za-z_][A-Za-z0-9_-]*)|(\.-?[A-Za-z_][A-Za-z0-9_-]*)|(\[[a-z][a-z0-9_-]*(?:\^?="[ !#-\x5b\x5d-~]*"|~="[!#-\x5b\x5d-~]+")?\])|( > | )/y;
/** Whether `s` is a selector of the grammar above, of at most LIMITS.compounds compounds and LIMITS.field characters. */
export function selectorOk(s: unknown): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > LIMITS.field) return false;
  let compounds = 1;
  let simple = 0; // simple selectors in this compound (the type counts)
  let ids = 0;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m || m.index !== at) return false;
    if (m[5] !== undefined) {
      if (simple === 0) return false; // a combinator needs a compound before it
      if (++compounds > LIMITS.compounds) return false;
      simple = 0;
      ids = 0;
      continue;
    }
    if (m[1] !== undefined && simple > 0) return false; // a type only at the start of a compound
    if (m[2] !== undefined && ++ids > 1) return false;
    simple++;
  }
  return simple > 0; // not ending with a combinator
}

const ID = /^[a-z0-9-]{1,64}$/;
// A path as location.pathname gives it: printable ASCII without what a browser always percent-encodes there (space, " # <
// > ? \ ^ ` { }), and without "*", which a contributor could take for a wildcard (a path is a literal prefix).
const PATH = /^\/[!$-)+-;=@-\[\]_a-z|~]*$/;
/** An https address with a host of two labels or more, no user name or password, printable ASCII. */
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z0-9-]+(?::[0-9]{1,5})?(?:[/?#][\x21-\x7e]*)?$/;
function httpsAddress(s: string): boolean {
  if (!HTTPS.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.includes(".") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

function page(v: unknown, at: string): Page {
  const o = object(v, at, SHAPE.page);
  const path = text(o.path, `${at}.path`, LIMITS.path, PATH);
  const field = text(o.field, `${at}.field`, LIMITS.field);
  if (!selectorOk(field)) refuse(`${at}.field`, "not in the selector grammar");
  const segments = int(o.segments, `${at}.segments`, 0, LIMITS.segments[1]);
  if (segments !== 0 && segments < LIMITS.segments[0])
    refuse(`${at}.segments`, `neither 0 nor ${LIMITS.segments.join(" to ")}`);
  if (typeof o.fill !== "string" || !(FILLS as readonly string[]).includes(o.fill))
    refuse(`${at}.fill`, "not a strategy");
  const fill = o.fill as Fill;
  if (segments === 0 && fill !== "auto") refuse(`${at}.fill`, 'a single box takes only "auto"');
  return { path, field, segments, fill };
}

/** The parts a site rule file and a bundle's rule share: the pages, the flags, `minLeft`. */
function ruleBody(o: Record<string, unknown>, at: string, flagsMin: number): Rule {
  const pages = list(o.pages, `${at}.pages`, ...LIMITS.pages).map((p, i) => page(p, `${at}.pages[${i}]`));
  let sent = false;
  if (Object.hasOwn(o, "flags")) {
    const flags = list(o.flags, `${at}.flags`, flagsMin, FLAGS.length).map((f, i) => {
      if (typeof f !== "string" || !(FLAGS as readonly string[]).includes(f)) refuse(`${at}.flags[${i}]`, "not a flag");
      return f;
    });
    unique(flags, `${at}.flags`);
    sent = flags.includes("sent");
  }
  const minLeft = Object.hasOwn(o, "minLeft") ? int(o.minLeft, `${at}.minLeft`, ...LIMITS.minLeft) : null;
  return { pages, sent, minLeft };
}

function siteRule(v: unknown, c: HostChecks, opts: Options): SiteRule {
  const o = object(v, "rule", SHAPE.siteRule);
  const id = text(o.id, "rule.id", LIMITS.id, ID);
  const hosts = list(o.hosts, "rule.hosts", ...LIMITS.hosts).map((h, i) => host(h, `rule.hosts[${i}]`, c, opts));
  unique(hosts, "rule.hosts");
  const rule = ruleBody(o, "rule", 0);
  const verified = date(o.verified, "rule.verified");
  if (verified > (opts.today ?? new Date().toISOString().slice(0, 10))) refuse("rule.verified", "in the future");
  const name = new RegExp(`^${id}/[a-z0-9][a-z0-9._-]{0,${LIMITS.fixtureName - 6}}\\.html$`);
  const fixtures = list(o.fixtures, "rule.fixtures", ...LIMITS.fixtures).map((f, i) =>
    text(f, `rule.fixtures[${i}]`, LIMITS.id + 1 + LIMITS.fixtureName, name),
  );
  unique(fixtures, "rule.fixtures");
  if (Object.hasOwn(o, "note")) text(o.note, "rule.note", LIMITS.note, /^[\x20-\x7e]*$/);
  return { id, hosts, rule, verified, fixtures };
}

function upstreamEntry(v: unknown, at: string): Upstream {
  const o = object(v, at, SHAPE.upstream);
  const license = text(o.license, `${at}.license`, 16);
  if (!(UPSTREAM_LICENSES as readonly string[]).includes(license)) refuse(`${at}.license`, "not an accepted licence");
  const path = text(o.path, `${at}.path`, LIMITS.upstreamPath, /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/);
  if (path.split("/").some((p) => p === "." || p === "..")) refuse(`${at}.path`, "not a plain path");
  return {
    id: text(o.id, `${at}.id`, LIMITS.upstreamId, /^[a-z0-9-]+$/),
    url: text(o.url, `${at}.url`, LIMITS.url, /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9_.~-]+)*$/),
    commit: text(o.commit, `${at}.commit`, 40, /^[0-9a-f]{40}$/),
    path,
    sha256: text(o.sha256, `${at}.sha256`, 64, /^[0-9a-f]{64}$/),
    license: "MIT",
  };
}

function aliasGroup(v: unknown, at: string, c: HostChecks, opts: Options): AliasGroup {
  const shared = Object.hasOwn(plain(v, at), "s");
  const o = object(v, at, shared ? SHAPE.shared : SHAPE.oneWay);
  const hostsOf = (k: string, min: number) =>
    list(o[k], `${at}.${k}`, min, LIMITS.group[1]).map((h, i) => host(h, `${at}.${k}[${i}]`, c, opts));
  if (shared) {
    const s = hostsOf("s", LIMITS.group[0]);
    unique(s, at);
    return { s };
  }
  const f = hostsOf("f", 1);
  const t = hostsOf("t", 1);
  if (f.length + t.length > LIMITS.group[1]) refuse(at, `more than ${LIMITS.group[1]} hosts`);
  unique([...f, ...t], at);
  return { f, t };
}

function bundle(v: unknown, kind: "baseline" | "live", c: HostChecks, opts: Options): Bundle {
  if (kind === "live")
    for (const k of ["aliases", "appends", "upstream"])
      if (Object.hasOwn(plain(v, "bundle"), k))
        refuse("bundle", `a live bundle carries no "${k}": they ship with releases only`);
  const o = object(v, "bundle", kind === "live" ? SHAPE.live : SHAPE.baseline);
  if (o.format !== FORMAT) refuse("bundle.format", `not "${FORMAT}"`);
  if (o.kind !== kind) refuse("bundle.kind", `not "${kind}"`);
  if (o.schema !== SCHEMA) refuse("bundle.schema", `not ${SCHEMA}`);
  const version = int(o.version, "bundle.version", ...LIMITS.version);
  const created = date(o.created, "bundle.created");
  // where the source is: an https address of the repository at this version (its form is the forge's: scripts/repo-url.mjs
  // holds the template); empty only in a baseline of a build that names no repository, which a store package refuses
  const source = text(o.source, "bundle.source", LIMITS.source);
  if (source === "" ? kind === "live" : !httpsAddress(source))
    refuse(
      "bundle.source",
      kind === "live"
        ? "not an https address (a live bundle must name its source)"
        : "neither empty nor an https address",
    );
  const upstream =
    kind === "baseline"
      ? list(o.upstream, "bundle.upstream", 0, LIMITS.upstream).map((u, i) => upstreamEntry(u, `bundle.upstream[${i}]`))
      : [];
  unique(
    upstream.map((u) => u.id),
    "bundle.upstream",
  );
  const license = text(o.license, "bundle.license", 64);
  if (license !== (upstream.length ? LICENSE_WITH_UPSTREAM : LICENSE))
    refuse("bundle.license", `not "${upstream.length ? LICENSE_WITH_UPSTREAM : LICENSE}"`);

  const rawRules = plain(o.rules, "bundle.rules");
  const ids = Object.keys(rawRules);
  if (ids.length > LIMITS.rules) refuse("bundle.rules", `more than ${LIMITS.rules} rules`);
  const rules = new Map<string, Rule>();
  for (const id of ids) {
    if (!ID.test(id)) refuse("bundle.rules", `"${id.slice(0, 80)}" is not a rule id`);
    rules.set(id, ruleBody(object(rawRules[id], `bundle.rules.${id}`, SHAPE.bundleRule), `bundle.rules.${id}`, 1));
  }
  const rawHosts = plain(o.hosts, "bundle.hosts");
  const names = Object.keys(rawHosts);
  if (names.length > LIMITS.hostEntries) refuse("bundle.hosts", `more than ${LIMITS.hostEntries} hosts`);
  const hosts = new Map<string, string>();
  const hostsOf = new Map<string, string[]>();
  for (const name of names) {
    const h = host(name, `bundle.hosts["${name.slice(0, 80)}"]`, c, opts);
    const id = rawHosts[name];
    if (typeof id !== "string" || !rules.has(id)) refuse(`bundle.hosts["${h}"]`, "not the id of a rule in this bundle");
    const of = [...(hostsOf.get(id) ?? []), h];
    if (of.length > LIMITS.hosts[1]) refuse(`bundle.rules.${id}`, `more than ${LIMITS.hosts[1]} hosts`);
    hosts.set(h, id);
    hostsOf.set(id, of);
  }
  for (const id of ids) if (!hostsOf.has(id)) refuse(`bundle.rules.${id}`, "no host points at it");

  let aliases: AliasGroup[] = [];
  let appends: string[] = [];
  if (kind === "baseline") {
    aliases = list(o.aliases, "bundle.aliases", 0, LIMITS.aliases).map((g, i) =>
      aliasGroup(g, `bundle.aliases[${i}]`, c, opts),
    );
    appends = list(o.appends, "bundle.appends", 0, LIMITS.appends).map((h, i) =>
      host(h, `bundle.appends[${i}]`, c, opts),
    );
    unique(appends, "bundle.appends");
    if ((aliases.length || appends.length) && !upstream.length)
      refuse("bundle.upstream", "aliases and appends come from upstream files, and none is named");
  }
  return { kind, version, created, license, source, upstream, rules, hosts, hostsOf, aliases, appends };
}

/**
 * Check `raw` (a value JSON.parse returned) as a site rule file (`"rule"`) or a bundle of that kind. Never throws: the
 * answer is the checked value, or the first reason it was refused.
 */
export function validate(raw: unknown, kind: "rule", checks: HostChecks, opts?: Options): Checked<SiteRule>;
export function validate(raw: unknown, kind: "baseline" | "live", checks: HostChecks, opts?: Options): Checked<Bundle>;
export function validate(raw: unknown, kind: Kind, checks: HostChecks, opts: Options = {}): Checked<SiteRule | Bundle> {
  try {
    return { ok: true, value: kind === "rule" ? siteRule(raw, checks, opts) : bundle(raw, kind, checks, opts) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    return { ok: false, error: "not readable" };
  }
}
