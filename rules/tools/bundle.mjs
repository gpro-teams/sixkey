#!/usr/bin/env node
// Build the baseline bundle, rules/build/baseline.json, from the sources under rules/ (AF3-1b; docs/design/notes/
// AUTOFILL3-NOTES.md §2). Offline and deterministic: the same sources give the same bytes, with no clock, path or machine
// in them, so the committed bundle is reviewable as the change it is and `--check` can hold it to its sources.
//
//   node rules/tools/bundle.mjs            write rules/build/baseline.json
//   node rules/tools/bundle.mjs --check    fail when rules/build/baseline.json is not what the sources give (stale)
//   node rules/tools/bundle.mjs --report   also print what was taken and dropped, as JSON, and the names to look at
//   --root <dir>  the rules folder to read (default: the one this file is in); --out <file>  where to write or check
// Anything else (a word, another option, one of these twice) prints the usage and exits with 2.
//
// Needs Node 22.18 or later (it loads the extension's checker, a TypeScript file, through Node's type stripping), or
// `node --experimental-strip-types` on Node 22.6 to 22.17.
//
// What goes in, and nothing else:
//   - version.json: the bundle's version (a counter) and its date;
//   - sites/<id>.json: each site rule, checked by the extension's own checker (extension/src/core/rules/format.ts) with
//     its hosts claimed by no other file and each fixture present under fixtures/ (a name starting with "." is skipped:
//     .DS_Store and the like);
//   - upstream/: the alias groups and the appends, from the pinned upstream files only, each read checked against its
//     pin (upstream.mjs loadUpstream); a name that is not a host Sixkey would accept (not as the URL parser writes it, an
//     IP address, a single label, a shared suffix, a reserved name) is dropped, and the report lists it;
//   - upstream/exclude.json: hosts and groups to take out, never anything to add;
//   - the source address: extension/scripts/repo-url.mjs's template, filled with the version ("" until it is set).
// The result is checked again, whole, by the same checker as a baseline bundle before anything is written.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMAT,
  LICENSE,
  LICENSE_WITH_UPSTREAM,
  LIMITS,
  RESERVED_TLDS,
  SCHEMA,
  validate,
} from "../../extension/src/core/rules/format.ts";
import { canonicalHost, isIpHost } from "../../extension/src/core/match.ts";
import { isShared } from "../../extension/src/core/site-domains.ts";
import { rulesSource } from "../../extension/scripts/repo-url.mjs";
import { Refused, loadUpstream, parseJson, upstreamField } from "./upstream.mjs";

const CHECKS = { canonicalHost, isShared };
const refuse = (what, why) => {
  throw new Refused(`${what}: ${why}`);
};
const plain = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
/** A JSON file, parsed, with no key written twice (upstream.mjs parseJson). */
const json = (file, what) => {
  if (!existsSync(file)) return refuse(what, "missing");
  return parseJson(readFileSync(file, "utf8"), what);
};
const RESERVED = new RegExp(`\\.(?:${RESERVED_TLDS.join("|")})$`);
/** A host the checker accepts in a store build's bundle (format.ts host(), which checks the bundle again at the end). */
const acceptable = (h) =>
  typeof h === "string" &&
  canonicalHost(h) === h &&
  !isIpHost(h) &&
  h.includes(".") &&
  !isShared(h) &&
  !RESERVED.test(h);
const sorted = (a) => [...new Set(a)].sort();
/** An internationalised name: an xn-- label (as the URL parser writes one) or a character beyond ASCII (the review's N3). */
const idn = (h) => typeof h === "string" && (/(?:^|\.)xn--/i.test(h) || /[^\x00-\x7f]/.test(h));

/** version.json: exactly {version, created}. */
function readVersion(root) {
  const v = json(join(root, "version.json"), "version.json");
  if (!plain(v) || Object.keys(v).sort().join() !== "created,version")
    refuse("version.json", 'not exactly {"version", "created"}');
  if (!Number.isInteger(v.version) || v.version < LIMITS.version[0] || v.version > LIMITS.version[1])
    refuse("version.json", "version is not a counter from 1");
  if (typeof v.created !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.created))
    refuse("version.json", "created is not a date");
  return v;
}

/** exclude.json: exactly {hosts, groupsWith}, lists of hosts; each must take something out (else the list goes stale). */
function readExclude(root) {
  const e = json(join(root, "upstream", "exclude.json"), "upstream/exclude.json");
  if (!plain(e) || Object.keys(e).sort().join() !== "groupsWith,hosts")
    refuse(
      "upstream/exclude.json",
      'not exactly {"hosts": [...], "groupsWith": [...]}: it can only take hosts and groups out',
    );
  for (const k of ["hosts", "groupsWith"])
    if (!Array.isArray(e[k]) || !e[k].every((h) => typeof h === "string"))
      refuse("upstream/exclude.json", `${k} is not a list of hosts`);
  return { hosts: new Set(e.hosts), groupsWith: new Set(e.groupsWith) };
}

/** Apple's groups as the bundle writes them, minus the exclusions; what was dropped, and why. */
function aliasesOf(apple, exclude, used) {
  const groups = [];
  const dropped = { hosts: [], groups: [] };
  const keep = (list) =>
    sorted(
      list.filter((h) => {
        if (exclude.hosts.has(h)) return (used.add(h), false);
        if (!acceptable(h)) return (dropped.hosts.push(h), false);
        return true;
      }),
    );
  apple.forEach((e, i) => {
    const all = [...(e.shared ?? []), ...(e.from ?? []), ...(e.to ?? [])];
    const by = all.find((h) => exclude.groupsWith.has(h));
    if (by !== undefined) return (used.add(by), dropped.groups.push({ at: i, why: `excluded (${by})` }));
    if (e.shared) {
      const s = keep(e.shared);
      if (s.length < LIMITS.group[0]) return dropped.groups.push({ at: i, why: "fewer than 2 hosts left" });
      if (s.length > LIMITS.group[1]) return dropped.groups.push({ at: i, why: `more than ${LIMITS.group[1]} hosts` });
      groups.push({ s });
    } else {
      const f = keep(e.from);
      const t = keep(e.to);
      if (!f.length || !t.length) return dropped.groups.push({ at: i, why: "a side with no host left" });
      if (f.some((h) => t.includes(h))) return dropped.groups.push({ at: i, why: "a host on both sides" });
      if (f.length + t.length > LIMITS.group[1])
        return dropped.groups.push({ at: i, why: `more than ${LIMITS.group[1]} hosts` });
      groups.push({ f, t });
    }
  });
  groups.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return { groups, dropped };
}

/** The site rules: sites/<id>.json each, checked; its hosts claimed by no other file; its fixtures present. */
function sitesOf(root, today) {
  const dir = join(root, "sites");
  const rules = {};
  const hosts = {};
  const owner = new Map();
  if (!existsSync(dir)) return { rules, hosts };
  const names = readdirSync(dir).filter((n) => !n.startsWith(".")); // .DS_Store and the like
  for (const name of names.sort()) {
    const what = `sites/${name}`;
    if (!/^[a-z0-9-]{1,64}\.json$/.test(name)) refuse(what, "not <rule id>.json");
    const r = validate(json(join(dir, name), what), "rule", CHECKS, { today });
    if (!r.ok) refuse(what, r.error);
    const { id, hosts: hs, rule, fixtures } = r.value;
    if (`${id}.json` !== name) refuse(what, `its id is "${id}": the file must be ${id}.json`);
    for (const f of fixtures)
      if (!existsSync(join(root, "fixtures", f))) refuse(what, `fixture fixtures/${f} is missing`);
    for (const h of hs) {
      if (owner.has(h)) refuse(what, `${h} is already a host of sites/${owner.get(h)}`);
      owner.set(h, name);
    }
    rules[id] = {
      pages: rule.pages.map(({ path, field, segments, fill }) => ({ path, field, segments, fill })),
      ...(rule.sent ? { flags: ["sent"] } : {}),
      ...(rule.minLeft !== null ? { minLeft: rule.minLeft } : {}),
    };
    for (const h of hs) hosts[h] = id;
  }
  return {
    rules: Object.fromEntries(
      Object.keys(rules)
        .sort()
        .map((k) => [k, rules[k]]),
    ),
    hosts: Object.fromEntries(
      Object.keys(hosts)
        .sort()
        .map((k) => [k, hosts[k]]),
    ),
  };
}

/** The bundle and its report, from the sources under `root`. */
export function build(root, today = new Date().toISOString().slice(0, 10)) {
  const { version, created } = readVersion(root);
  const { entries, data } = loadUpstream(root);
  const exclude = readExclude(root);
  const used = new Set();
  const { groups, dropped } = aliasesOf(data.aliases, exclude, used);
  const appends = sorted(
    data.appends.filter((h) => {
      if (exclude.hosts.has(h)) return (used.add(h), false);
      if (!acceptable(h)) return (dropped.hosts.push(h), false);
      return true;
    }),
  );
  for (const h of [...exclude.hosts, ...exclude.groupsWith])
    if (!used.has(h)) refuse("upstream/exclude.json", `${h} takes nothing out`);
  const { rules, hosts } = sitesOf(root, today);
  const upstream = upstreamField(entries);
  const bundle = {
    format: FORMAT,
    kind: "baseline",
    schema: SCHEMA,
    version,
    created,
    license: upstream.length ? LICENSE_WITH_UPSTREAM : LICENSE,
    source: rulesSource(version),
    upstream,
    rules,
    hosts,
    aliases: groups,
    appends,
  };
  const checked = validate(bundle, "baseline", CHECKS);
  if (!checked.ok) refuse("the bundle", checked.error);
  const report = {
    version,
    rules: Object.keys(rules).length,
    hosts: Object.keys(hosts).length,
    aliases: groups.length,
    appends: appends.length,
    dropped: { hosts: sorted(dropped.hosts), groups: dropped.groups },
    // every upstream name with an xn-- label or a non-ASCII character, kept or dropped: a look-alike of a known site would
    // be one of them, and nothing else here can tell one from a real site (a maintainer reads this at every re-import)
    idn: sorted(
      [
        ...data.aliases.flatMap((e) => [...(e.shared ?? []), ...(e.from ?? []), ...(e.to ?? [])]),
        ...data.appends,
      ].filter(idn),
    ),
  };
  return { text: `${JSON.stringify(bundle, null, 2)}\n`, report };
}

const USAGE = "usage: node rules/tools/bundle.mjs [--check] [--report] [--root <dir>] [--out <file>]";
/** The command line: --root <dir>, --out <file>, --check, --report, each at most once; null for anything else. */
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" || a === "--out") {
      if (a in o || i + 1 === argv.length) return null;
      o[a] = argv[++i];
    } else if (a === "--check" || a === "--report") {
      if (a in o) return null;
      o[a] = true;
    } else return null;
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  if (!o) {
    console.error(USAGE);
    process.exit(2);
  }
  const root = resolve(o["--root"] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const out = resolve(o["--out"] ?? join(root, "build", "baseline.json"));
  const { text, report } = build(root);
  if (o["--report"]) console.log(JSON.stringify(report));
  if (o["--check"]) {
    const have = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (have !== text) {
      console.error(
        `bundle.mjs: ${out} is stale: it is not what the sources give. Run node rules/tools/bundle.mjs and commit it.`,
      );
      process.exit(1);
    }
    console.error(`bundle.mjs: ${out} is up to date`);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.error(`bundle.mjs: wrote ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Refused ? `bundle.mjs: ${e.message}` : e);
    process.exit(1);
  }
}
