// The site rules in a Sixkey build (TOTP autofill Stage 3, AF3-3a; docs/design/notes/AUTOFILL3-NOTES.md §4): the two files
// every build carries under rules/, how they are made from the repository's rules/ folder, what check-dist looks for, and
// the store package's source gate. Used by scripts/build.mjs (which writes them), scripts/check-dist.mjs (which holds a
// build to them) and scripts/package.mjs (the gate):
//   rules/baseline.json  the repository's rules/build/baseline.json, byte for byte; a build is refused unless it is in the
//                        form rules/tools/bundle.mjs writes and the extension's own reader accepts it
//                        (src/core/rules/baseline.ts parseBaseline, the function platform/package-data.ts uses);
//   rules/LICENSE.txt    rules/NOTICE (what the licences cover, Apple's MIT notice), then the AGPL-3.0 text;
// and the build's own LICENSE.txt starts with one line naming them. The bundle is data the extension reads, never code:
// the build refuses any module under the repository's rules/ folder (build.mjs rulesDataGuard), and check-dist looks for
// its host lists in every built script (dataProbes, normalised).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES_SOURCE, rulesSource } from "./repo-url.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository's rules/ folder, beside extension/ (as ../LICENSES is). */
export const RULES_DIR = resolve(EXT, "../rules");
export const BASELINE_SOURCE = resolve(RULES_DIR, "build/baseline.json");
/** The files under rules/ in a build: these and nothing else. */
export const PACKAGED_BASELINE = "rules/baseline.json";
export const PACKAGED_LICENCE = "rules/LICENSE.txt";
/**
 * The first line of the build's LICENSE.txt, before the MPL-2.0 text. It names the third-party parts too: the build also
 * carries fonts (OFL-1.1, which must not be distributed under another licence), word lists (CC BY) and MIT code, each under
 * its own licence (THIRD-PARTY-NOTICES.txt), so "everything else" is only what is left.
 */
export const LICENCE_LINE =
  "The files under rules/ are under AGPL-3.0-or-later and MIT: see rules/LICENSE.txt. The third-party software and data " +
  "listed in THIRD-PARTY-NOTICES.txt keep their own licences. Everything else: the Mozilla Public License 2.0, below.";

/**
 * A file the build needs from beside extension/ (`what`, its path from the repository's root): its text, or an error that
 * says what is missing and what to do, before anything is built.
 */
const need = (p, what, more = "") => {
  try {
    return readFileSync(p, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    throw new Error(
      `${what} is missing: build Sixkey in the repository, where extension/ sits beside ${what.split("/")[0]}/${more}`,
    );
  }
};
/** The build's LICENSE.txt: the line above, a blank line, then the repository's LICENSES/MPL-2.0.txt. */
export const extensionLicenceText = () =>
  `${LICENCE_LINE}\n\n${need(resolve(EXT, "../LICENSES/MPL-2.0.txt"), "LICENSES/MPL-2.0.txt")}`;
/** rules/LICENSE.txt: rules/NOTICE, a rule of = signs, then the repository's LICENSES/AGPL-3.0-or-later.txt. */
export const rulesLicenceText = () =>
  `${need(resolve(RULES_DIR, "NOTICE"), "rules/NOTICE")}\n${"=".repeat(80)}\n\n${need(
    resolve(EXT, "../LICENSES/AGPL-3.0-or-later.txt"),
    "LICENSES/AGPL-3.0-or-later.txt",
  )}`;

/**
 * The committed bundle (or `raw`, the text of the file named `what`), as a build may carry it: its text and the bundle the
 * extension's reader makes of it. Throws, with the reason, when it is missing, the reader refuses it or it is not in
 * bundle.mjs's form (two-space JSON, one final newline: a key written twice, or a hand edit, does not survive that
 * comparison).
 */
export async function checkedBaseline(raw, what = "rules/build/baseline.json", o = {}) {
  const t =
    raw ?? need(BASELINE_SOURCE, "rules/build/baseline.json", ", or make the bundle (node rules/tools/bundle.mjs)");
  const { runnerImport } = await import("vite");
  const { module } = await runnerImport(resolve(EXT, "src/core/rules/baseline.ts"), {
    configFile: false,
    logLevel: "silent",
  });
  const read = module.parseBaseline(t, { allowReserved: o.allowReserved === true });
  if (!read.ok) throw new Error(`${what} is not a baseline bundle the extension accepts: ${read.error}`);
  if (`${JSON.stringify(JSON.parse(t), null, 2)}\n` !== t)
    throw new Error(`${what} is not in the form rules/tools/bundle.mjs writes: run node rules/tools/bundle.mjs`);
  return { text: t, bundle: read.value, maxBytes: module.BASELINE_MAX_BYTES };
}

/**
 * The e2e build's own test rules (TOTP autofill Stage 3, AF3-3b): site rule files and their synthetic pages, laid out as
 * rules/ is (sites/<id>.json, fixtures/<id>/*.html; a page says where it is served with <meta name="sixkey-path">), on the
 * fixture hosts its tests serve (`.test` names, which only that build's reader accepts). No other build carries them.
 * And (AF3-5) appends.json: `{"hosts": [...], "note": "..."}`, the fixture hosts whose sign-in wants the code typed right
 * after the password, added to the bundle's appends, which in every other build are Apple's alone (bundle.mjs reads them
 * from upstream/ only). A test host there is the e2e build's baseline's, as Apple's are the store build's: a live bundle
 * carries no appends in any build (format.ts refuses one that does). Likewise (AF3-4) aliases.json: `{"groups": [...],
 * "note": "..."}`, "same sign-in" groups of fixture hosts in the bundle's form (`{"s": [...]}` or `{"f": [...], "t":
 * [...]}`), added to Apple's groups.
 */
export const E2E_RULES_DIR = resolve(EXT, "test/fixtures/rules");
/** One of the extension's TypeScript modules, loaded through Vite's runnerImport (as checkedBaseline loads the reader). */
const load = async (file) => {
  const { runnerImport } = await import("vite");
  return (await runnerImport(resolve(EXT, file), { configFile: false, logLevel: "silent" })).module;
};
/**
 * The e2e build's bundle: `raw` (the committed one) with the test rules of E2E_RULES_DIR added, each checked as a site rule
 * by the format's checker (reserved names allowed), its fixtures present, its hosts claimed by no other rule, with its
 * appends.json's hosts added to the appends (none of them already there) and its aliases.json's groups to the alias groups
 * (none of them already there); written as bundle.mjs writes a bundle (a rule as `{pages, flags?, minLeft?}`, rules,
 * hosts, appends and groups sorted), and checked whole as a baseline bundle (reserved names allowed). Throws, saying why.
 */
export async function e2eBaselineText(raw, dir = E2E_RULES_DIR) {
  const { validate } = await load("src/core/rules/format.ts");
  const { canonicalHost } = await load("src/core/match.ts");
  const { isShared } = await load("src/core/site-domains.ts");
  if (!existsSync(resolve(dir, "sites")))
    throw new Error(
      `the e2e build's test rules are missing (${resolve(dir, "sites")}): the e2e build is made from the extension's own tree, test/fixtures/rules/ included`,
    );
  const b = JSON.parse(raw);
  const rules = { ...b.rules };
  const hosts = { ...b.hosts };
  for (const name of readdirSync(resolve(dir, "sites"))
    .filter((n) => !n.startsWith("."))
    .sort()) {
    const what = `the e2e build's test rule ${name}`;
    const r = validate(
      JSON.parse(readFileSync(resolve(dir, "sites", name), "utf8")),
      "rule",
      {
        canonicalHost,
        isShared,
      },
      { allowReserved: true },
    );
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
    const { id, hosts: hs, rule, fixtures } = r.value;
    if (`${id}.json` !== name || Object.hasOwn(rules, id))
      throw new Error(`${what}: not named after its id, or its id taken`);
    for (const f of fixtures)
      if (!existsSync(resolve(dir, "fixtures", f))) throw new Error(`${what}: fixture fixtures/${f} is missing`);
    for (const h of hs) {
      if (Object.hasOwn(hosts, h)) throw new Error(`${what}: ${h} is already a host of the rule ${hosts[h]}`);
      hosts[h] = id;
    }
    rules[id] = {
      pages: rule.pages.map(({ path, field, segments, fill }) => ({ path, field, segments, fill })),
      ...(rule.sent ? { flags: ["sent"] } : {}),
      ...(rule.minLeft !== null ? { minLeft: rule.minLeft } : {}),
    };
  }
  const sorted = (o) =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    );
  const appends = [...b.appends, ...e2eAppends(dir, b.appends)].sort();
  const key = (g) => JSON.stringify(g);
  const aliases = [...b.aliases, ...e2eAliases(dir, b.aliases.map(key))].sort((x, y) => (key(x) < key(y) ? -1 : 1));
  const out = { ...b, rules: sorted(rules), hosts: sorted(hosts), aliases, appends };
  const whole = validate(out, "baseline", { canonicalHost, isShared }, { allowReserved: true });
  if (!whole.ok) throw new Error(`the e2e build's bundle: ${whole.error}`);
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** appends.json's hosts (see E2E_RULES_DIR): an object of exactly `hosts` (one or more) and `note`; none in `have`. */
function e2eAppends(dir, have) {
  const file = resolve(dir, "appends.json");
  const what = "the e2e build's test appends (appends.json)";
  if (!existsSync(file)) throw new Error(`${what} are missing (${file})`);
  const a = JSON.parse(readFileSync(file, "utf8"));
  const plain = typeof a === "object" && a !== null && !Array.isArray(a);
  if (
    !plain ||
    Object.keys(a).sort().join() !== "hosts,note" ||
    typeof a.note !== "string" ||
    !Array.isArray(a.hosts) ||
    a.hosts.length === 0
  )
    throw new Error(`${what}: {"hosts": [one or more], "note": "..."}, and nothing else`);
  for (const h of a.hosts)
    if (have.includes(h) || a.hosts.indexOf(h) !== a.hosts.lastIndexOf(h))
      throw new Error(`${what}: ${h} is there twice, or already one of the bundle's`);
  return a.hosts;
}

/** aliases.json's groups (see E2E_RULES_DIR): an object of exactly `groups` (one or more) and `note`; none in `have`. */
function e2eAliases(dir, have) {
  const file = resolve(dir, "aliases.json");
  const what = "the e2e build's test alias groups (aliases.json)";
  if (!existsSync(file)) throw new Error(`${what} are missing (${file})`);
  const a = JSON.parse(readFileSync(file, "utf8"));
  const plain = typeof a === "object" && a !== null && !Array.isArray(a);
  if (
    !plain ||
    Object.keys(a).sort().join() !== "groups,note" ||
    typeof a.note !== "string" ||
    !Array.isArray(a.groups) ||
    a.groups.length === 0
  )
    throw new Error(`${what}: {"groups": [one or more], "note": "..."}, and nothing else`);
  const keys = a.groups.map((g) => JSON.stringify(g));
  for (const k of keys)
    if (have.includes(k) || keys.indexOf(k) !== keys.lastIndexOf(k))
      throw new Error(`${what}: ${k} is there twice, or already one of the bundle's`);
  return a.groups;
}

/**
 * A script's text as check-dist compares it with the probes: every quote one kind (a backtick or a single quote becomes
 * "), a quote's escaping backslash dropped, and no white space at all. The bundlers write the same list in different
 * ways (the pages' minifier as [`a.com`,`b.com`], the worker's library build over indented lines with double quotes, a
 * string of JSON with \"), and all of them read alike here.
 */
export const normalised = (code) => code.replace(/[`']/g, '"').replace(/\\"/g, '"').replace(/\s+/g, "");

/**
 * What only the bundle's data would put into a script, normalised as above: each list of two hosts or more as the
 * bundle writes it (each alias group's lists, the appends). The bundle's keys and its rules' selectors are no probes:
 * other code may well have an `aliases` key, or a selector a rule also uses. The build's guard keeps the bundle's files
 * out of every module graph; this is the second look, at what was built.
 */
export function dataProbes(raw) {
  const b = JSON.parse(raw);
  const lists = [...(b.aliases ?? []).flatMap((g) => [g.s, g.f, g.t]), b.appends].filter(
    (l) => Array.isArray(l) && l.length > 1,
  );
  return [...new Set(lists.map((l) => normalised(JSON.stringify(l))))];
}

/**
 * Why the store package may not carry the rules as they are (null: it may). The bundle's `source` says where the rules'
 * source is (AGPL-3.0); it is empty while REPO_URL in scripts/repo-url.mjs is empty, as it was before the repository
 * was public, and a store package must not carry such a bundle (the plan's §3.6, S4), nor one whose `source` is not the
 * address REPO_URL gives for its version (built before the address was set, or for another), nor one when that address
 * is not one the bundle's source can be made of. Dev, e2e and local builds, and the ID draft, are unaffected. `raw`:
 * the committed bundle's text unless given.
 */
export function sourceGate(raw, template = RULES_SOURCE) {
  if (template === "")
    return (
      "the site rules' bundle names no source: REPO_URL in scripts/repo-url.mjs is empty until the repository is public, " +
      "and a store package must say where the source of its AGPL rules is. Set REPO_URL (and RULES_AT_TAG for the " +
      "forge), rebuild the bundle (node ../rules/tools/bundle.mjs) and commit it (rules/README.md, " +
      '"Releasing a bundle").'
    );
  let b;
  try {
    b = JSON.parse(raw ?? readFileSync(BASELINE_SOURCE, "utf8"));
  } catch {
    return "rules/build/baseline.json is missing or not JSON: rebuild it (node ../rules/tools/bundle.mjs).";
  }
  let want;
  try {
    want = rulesSource(b?.version, template);
  } catch (e) {
    return e.message;
  }
  if (b?.source !== want)
    return (
      `rules/build/baseline.json's source is ${JSON.stringify(b?.source)}, not ${want}: rebuild it ` +
      "(node ../rules/tools/bundle.mjs) and commit it."
    );
  return null;
}
