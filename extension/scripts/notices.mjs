// Third-party notices, generated from the dependency trees (LICENSE.md links the result).
//   node scripts/notices.mjs --write                  write ../THIRD-PARTY-NOTICES.md (npm run notices)
//   node scripts/notices.mjs --check                  fail when that file differs from what --write would write
//                                                     (npm run notices:check; test/unit/notices.test.ts does the same)
//   node scripts/notices.mjs --verify-python <venv>   compare the Python licences in scripts/notices-data.mjs with the
//                                                     metadata of a virtual environment made from requirements-dev.txt
// scripts/build.mjs writes extensionNoticesText() into every build as THIRD-PARTY-NOTICES.txt, and check-dist checks it.
//
// The only inputs: package-lock.json (which packages, which versions, which can ship: every entry not marked dev), the
// installed packages' own licence and notice files (node_modules/; a version that differs from the lockfile stops the
// script), scripts/notices-data.mjs (what package metadata does not say), api/server/requirements*.txt, and the site
// rules' bundle with the upstream pins it names (../rules/build/baseline.json, ../rules/upstream/SOURCES.json and the
// licence files pinned there). The output depends on no clock, path or machine, so it is the same wherever it is
// generated.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUNDLED_DATA, DATA_NOTES, PACKAGE_NOTES, PYTHON_DEV, PYTHON_NOTES, PYTHON_RUNTIME } from "./notices-data.mjs";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(EXT, "..");
export const NOTICES_MD = resolve(REPO, "THIRD-PARTY-NOTICES.md");
const SERVER = resolve(REPO, "api/server");
const RULES = resolve(REPO, "rules");

// The files of a package that carry its licence or notices: LICENSE, LICENCE, COPYING, NOTICE, THIRD_PARTY_LICENSES,
// with any extension or suffix (LICENSE.md, LICENSE-MIT, NOTICE.md).
const LICENCE_FILE = /^(?:licen[cs]e|copying|notice|third[_-]party[_-]licen[cs]es)(?:[.-][\w.-]*)?$/i;

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1);
const nameOf = (key) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
/** Line endings and trailing spaces normalised, one final newline: nothing else of a text is changed. */
const normalise = (t) =>
  t
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n*$/, "\n");

function lockEntries() {
  const lock = JSON.parse(readFileSync(join(EXT, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages).filter(([key]) => key.startsWith("node_modules/"));
}

/** The npm packages a build can contain: every lockfile entry not marked dev, with its licence and notice files. */
export function shippedPackages() {
  return lockEntries()
    .filter(([, v]) => !v.dev)
    .map(([key, v]) => {
      const dir = join(EXT, key);
      const name = nameOf(key);
      const installed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      if (installed !== v.version)
        throw new Error(`notices: ${name} is installed at ${installed}, the lockfile says ${v.version}: run npm ci`);
      const files = readdirSync(dir)
        .filter((n) => LICENCE_FILE.test(n))
        .sort();
      if (!files.length) throw new Error(`notices: ${name} ${v.version} has no licence file`);
      const data = (DATA_NOTES[name] ?? []).map((d) => {
        if (!existsSync(join(dir, d.file)))
          throw new Error(`notices: ${name} has no ${d.file} (scripts/notices-data.mjs)`);
        return d;
      });
      return {
        name,
        version: v.version,
        licence: v.license ?? "none declared",
        note: PACKAGE_NOTES[name] ?? "",
        data,
        texts: files.map((file) => ({ file, text: normalise(readFileSync(join(dir, file), "utf8")) })),
      };
    })
    .sort(byName);
}

/**
 * The upstream data in the site rules' bundle (rules/build/baseline.json, its `upstream` field), by source: what it is
 * (notices-data.mjs BUNDLED_DATA), its address, its files at their pinned commits, its licence, and the text of the
 * licence file rules/upstream/SOURCES.json pins for it.
 */
export function bundledData() {
  const bundle = JSON.parse(readFileSync(join(RULES, "build/baseline.json"), "utf8"));
  const pins = JSON.parse(readFileSync(join(RULES, "upstream/SOURCES.json"), "utf8")).files;
  const bySource = new Map();
  for (const u of bundle.upstream ?? []) {
    const pin = pins.find((p) => p.id === u.id);
    if (!pin) throw new Error(`notices: the bundle's upstream ${u.id} is not pinned in rules/upstream/SOURCES.json`);
    const note = BUNDLED_DATA[pin.source];
    if (!note)
      throw new Error(
        `notices: no entry for the upstream source ${pin.source} (scripts/notices-data.mjs BUNDLED_DATA)`,
      );
    const licence = pins.find((p) => p.source === pin.source && p.use === "licence");
    if (!licence) throw new Error(`notices: the upstream source ${pin.source} has no pinned licence file`);
    if (!bySource.has(pin.source))
      bySource.set(pin.source, {
        source: pin.source,
        ...note,
        url: pin.url,
        licence: pin.license,
        files: [],
        licenceFile: `rules/upstream/${licence.vendored}`,
        text: normalise(readFileSync(join(RULES, "upstream", licence.vendored), "utf8")),
      });
    bySource.get(pin.source).files.push({ path: pin.path, commit: pin.commit });
  }
  return [...bySource.values()].sort((a, b) => (a.source < b.source ? -1 : 1));
}
/** The npm packages used only to build and test (the lockfile's dev entries; not every one installs on every OS). */
export function devPackages() {
  return lockEntries()
    .filter(([, v]) => v.dev)
    .map(([key, v]) => ({ name: nameOf(key), version: v.version, licence: v.license ?? "none declared" }))
    .sort(byName);
}

/** `name==version` pins of a requirements file, without its comments and -r includes. */
export function pins(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l && !l.startsWith("-"))
    .map((l) => {
      const m = /^([A-Za-z0-9._-]+)==([^\s;]+)$/.exec(l);
      if (!m) throw new Error(`notices: ${file}: not an exact pin: ${l}`);
      return { name: m[1], version: m[2] };
    });
}

/** The server's pinned Python packages with the licences of scripts/notices-data.mjs: both must name the same set. */
export function pythonPackages() {
  const tables = { runtime: PYTHON_RUNTIME, dev: PYTHON_DEV };
  const out = {
    runtime: pins(join(SERVER, "requirements.txt")),
    dev: pins(join(SERVER, "requirements-dev.txt")),
  };
  for (const kind of ["runtime", "dev"]) {
    const table = tables[kind];
    const pinned = new Set(out[kind].map((p) => p.name));
    const missing = [...pinned].filter((n) => !Object.hasOwn(table, n));
    const extra = Object.keys(table).filter((n) => !pinned.has(n));
    if (missing.length || extra.length)
      throw new Error(
        `notices: the ${kind} Python licences in scripts/notices-data.mjs do not match the pins` +
          (missing.length ? `; missing: ${missing.join(", ")}` : "") +
          (extra.length ? `; not pinned: ${extra.join(", ")}` : ""),
      );
    out[kind] = out[kind].map((p) => ({ ...p, licence: table[p.name], note: PYTHON_NOTES[p.name] ?? "" })).sort(byName);
  }
  return out;
}

const cell = (s) => String(s).replace(/\|/g, "\\|");
const fence = (text) => {
  let f = "````";
  while (text.includes(f)) f += "`";
  return `${f}text\n${text}${f}`;
};

function dataMarkdown(pkg, d) {
  const lines = [`#### \`${pkg.name}\`: \`${d.file}\``, "", `${d.what[0].toUpperCase()}${d.what.slice(1)}.`, ""];
  if (d.author) lines.push(`- Author: ${d.author}`);
  if (d.source) lines.push(`- Source: <${d.source}>`);
  if (d.licence) lines.push(`- Licence: ${d.licence}${d.licenceUrl ? `, <${d.licenceUrl}>` : ""}`);
  if (d.attribution) lines.push(`- Attribution: ${d.attribution}`);
  if (lines.at(-1) !== "") lines.push("");
  lines.push(d.note, "");
  return lines.join("\n");
}

/** THIRD-PARTY-NOTICES.md at the repository root. */
export function noticesMarkdown() {
  const shipped = shippedPackages();
  const bundled = bundledData();
  const py = pythonPackages();
  const out = [
    "# Third-party notices",
    "",
    "<!-- Generated by extension/scripts/notices.mjs (`npm run notices` in extension/). Do not edit by hand:",
    "     test/unit/notices.test.ts fails when this file differs from what the script writes. -->",
    "",
    "Sixkey's own licences are described in [LICENSE.md](LICENSE.md). This file lists the third-party software and data",
    "Sixkey uses, and reproduces the notices and licence texts they require. It is generated from the dependency trees:",
    "`extension/package-lock.json` and the installed packages' own files, `api/server/requirements.txt` and",
    "`requirements-dev.txt`, `extension/scripts/notices-data.mjs` for what package metadata does not say, and the site",
    "rules' bundle with the upstream pins it names (`rules/build/baseline.json`, `rules/upstream/SOURCES.json`). Licence",
    "texts are copied from each package's own files; only line endings and trailing spaces are normalised.",
    "",
    "## 1. In the extension",
    "",
    "These packages can be part of a build of the extension: the runtime dependencies in `extension/package-lock.json`",
    "and their own dependencies. Every build carries this section, as plain text, in `THIRD-PARTY-NOTICES.txt`.",
    "",
    "| Package | Version | Licence declared by the package | Notes |",
    "| --- | --- | --- | --- |",
    ...shipped.map((p) => `| \`${p.name}\` | ${p.version} | ${cell(p.licence)} | ${cell(p.note)} |`),
    "",
    "### Data with terms of its own",
    "",
    "Package metadata reports these packages under one licence. The data files below have their own terms, or no stated",
    "source, and the notices they require are given here.",
    "",
    ...shipped.flatMap((p) => p.data.map((d) => dataMarkdown(p, d))),
    "### Data in the site rules' bundle",
    "",
    "Every build carries the site rules' bundle as `rules/baseline.json` (the repository's `rules/build/baseline.json`,",
    "under AGPL-3.0-or-later and MIT: `rules/NOTICE`, and `rules/LICENSE.txt` in a build). It takes data from these",
    "upstream files, kept verbatim in the repository and pinned by commit and SHA-256 in `rules/upstream/SOURCES.json`.",
    "",
    ...bundled.flatMap((d) => [
      `#### \`${d.source}\``,
      "",
      `${d.what[0].toUpperCase()}${d.what.slice(1)}.`,
      "",
      `- Author: ${d.author}`,
      `- Source: <${d.url}>: ${d.files.map((f) => `\`${f.path}\` at commit \`${f.commit}\``).join(", ")}`,
      `- Licence: ${d.licence}`,
      "",
      `\`${d.licenceFile}\`:`,
      "",
      fence(d.text),
      "",
    ]),
    "### Licence and notice texts",
    "",
    ...shipped.flatMap((p) => [
      `#### \`${p.name}\` ${p.version}`,
      "",
      ...p.texts.flatMap((t) => [`\`${t.file}\`:`, "", fence(t.text), ""]),
    ]),
    "## 2. In the sync server",
    "",
    "The runtime dependencies pinned in `api/server/requirements.txt`, with the licences their packages declare. The",
    "server is not distributed in any form yet; a server image, once one is published, must carry these packages' licence",
    "texts as well.",
    "",
    "| Package | Version | Licence | Notes |",
    "| --- | --- | --- | --- |",
    ...py.runtime.map((p) => `| \`${p.name}\` | ${p.version} | ${cell(p.licence)} | ${cell(p.note)} |`),
    "",
    "## 3. Build and test tools (not distributed)",
    "",
    "Used to build, test and format Sixkey; none of them is part of a build of the extension or of the server. Some npm",
    "entries are platform-specific builds that install only on their own platform.",
    "",
    "| npm package | Version | Licence |",
    "| --- | --- | --- |",
    ...devPackages().map((p) => `| \`${p.name}\` | ${p.version} | ${cell(p.licence)} |`),
    "",
    "| Python package (`api/server/requirements-dev.txt`) | Version | Licence |",
    "| --- | --- | --- |",
    ...py.dev.map((p) => `| \`${p.name}\` | ${p.version} | ${cell(p.licence)} |`),
    "",
  ];
  return out.join("\n");
}

/** THIRD-PARTY-NOTICES.txt in every build of the extension: section 1 above, as plain text. */
export function extensionNoticesText() {
  const shipped = shippedPackages();
  const bundled = bundledData();
  const out = [
    "Sixkey browser extension: third-party notices",
    "",
    "This extension contains the third-party software and data listed below; their notices and licence texts follow.",
    "Sixkey's own licence is in LICENSE.txt (Mozilla Public License 2.0); the site rules' bundle, rules/baseline.json, is",
    "under AGPL-3.0-or-later and MIT (rules/LICENSE.txt).",
    "",
    "Packages",
    "",
    ...shipped.map((p) => `  ${p.name} ${p.version}: ${p.licence}${p.note ? `; ${p.note}` : ""}`),
    "",
    "Data with terms of its own",
    "",
    ...shipped.flatMap((p) =>
      p.data.flatMap((d) => [
        `  ${p.name}, ${d.file}: ${d.what}.`,
        ...(d.author ? [`    Author: ${d.author}`] : []),
        ...(d.source ? [`    Source: ${d.source}`] : []),
        ...(d.licence ? [`    Licence: ${d.licence}${d.licenceUrl ? `, ${d.licenceUrl}` : ""}`] : []),
        ...(d.attribution ? [`    Attribution: ${d.attribution}`] : []),
        `    ${d.note}`,
        "",
      ]),
    ),
    "Data in the site rules' bundle (rules/baseline.json)",
    "",
    ...bundled.flatMap((d) => [
      `  ${d.source}: ${d.what}.`,
      `    Author: ${d.author}`,
      `    Source: ${d.url}: ${d.files.map((f) => `${f.path} at commit ${f.commit}`).join(", ")}`,
      `    Licence: ${d.licence}`,
      "",
    ]),
    "Licence and notice texts",
    "",
    ...shipped.flatMap((p) =>
      p.texts.flatMap((t) => [`======== ${p.name} ${p.version}: ${t.file} ========`, "", t.text]),
    ),
    ...bundled.flatMap((d) => [`======== ${d.source}: ${d.licenceFile} ========`, "", d.text]),
  ];
  return out.join("\n");
}

// The installed metadata's licence, as SPDX: License-Expression when the wheel has one, else License or the classifier.
const LEGACY = { "Apache 2.0": "Apache-2.0", "MIT License": "MIT", "BSD License": "BSD-3-Clause" };
function verifyPython(venv) {
  const lib = join(venv, "lib");
  const site = readdirSync(lib)
    .filter((n) => /^python3\.\d+$/.test(n))
    .map((n) => join(lib, n, "site-packages"))
    .find(existsSync);
  if (!site) throw new Error(`notices: no lib/python3.*/site-packages in ${venv}`);
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
  const meta = new Map();
  for (const d of readdirSync(site).filter((n) => n.endsWith(".dist-info"))) {
    const text = readFileSync(join(site, d, "METADATA"), "utf8").split("\n\n")[0];
    const field = (k) => new RegExp(`^${k}: (.*)$`, "m").exec(text)?.[1]?.trim();
    const classifier = /^Classifier: License :: OSI Approved :: (.*)$/m.exec(text)?.[1]?.trim();
    const licence = field("License-Expression") ?? LEGACY[field("License")] ?? field("License") ?? LEGACY[classifier];
    meta.set(norm(field("Name")), { version: field("Version"), licence });
  }
  const py = pythonPackages();
  const problems = [];
  for (const p of [...py.runtime, ...py.dev]) {
    const m = meta.get(norm(p.name));
    if (!m) problems.push(`${p.name}: not installed`);
    else if (m.version !== p.version) problems.push(`${p.name}: installed ${m.version}, pinned ${p.version}`);
    else if (m.licence !== p.licence) problems.push(`${p.name}: the package says ${m.licence}, the table ${p.licence}`);
  }
  if (problems.length) {
    console.error(`notices: the Python licences differ from ${venv}:\n - ${problems.join("\n - ")}`);
    process.exit(1);
  }
  console.log(`notices: ${py.runtime.length + py.dev.length} Python packages match ${venv}`);
}

function main(args) {
  if (args[0] === "--write") {
    writeFileSync(NOTICES_MD, noticesMarkdown());
    console.log("notices: wrote THIRD-PARTY-NOTICES.md");
  } else if (args[0] === "--check") {
    const now = existsSync(NOTICES_MD) ? readFileSync(NOTICES_MD, "utf8") : "";
    if (now !== noticesMarkdown()) {
      console.error("notices: THIRD-PARTY-NOTICES.md is out of date: run npm run notices in extension/");
      process.exit(1);
    }
    console.log("notices: THIRD-PARTY-NOTICES.md is up to date");
  } else if (args[0] === "--verify-python" && args[1]) {
    verifyPython(resolve(args[1]));
  } else {
    console.error("usage: node scripts/notices.mjs --write | --check | --verify-python <venv>");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
