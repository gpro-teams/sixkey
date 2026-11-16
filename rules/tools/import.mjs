#!/usr/bin/env node
// The upstream files under rules/upstream/ (AF3-1b; docs/design/notes/AUTOFILL3-NOTES.md §2): check them, or fetch a new
// copy of one source at one commit.
//
//   node rules/tools/import.mjs [verify]               verify (the default, offline): every pinned file present, its
//                                                     bytes hashing to its pin, its shape its source's; else it refuses
//   node rules/tools/import.mjs fetch <source> <commit>
//                                                     a maintainer's step, and the only use of the network in rules/: GET
//                                                     each listed file of <source> (upstream.mjs SOURCES) at <commit> from
//                                                     the source's raw address, check its shape, and only when every
//                                                     file has passed, write them under upstream/ and pin them in
//                                                     SOURCES.json; then verify. Nothing else is sent. The result is a
//                                                     change to review like any other: the diff of the upstream files
//                                                     is what a reviewer reads, then bundle.mjs --report
//   --root <dir>  the rules folder (default: the one this file is in)
// Anything else (another command, a word too many or too few, another option) prints the usage and exits with 2.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, Refused, SOURCES, loadUpstream, parseJson, readCapped, readUse, sha256 } from "./upstream.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const USAGE = "usage: node rules/tools/import.mjs [verify] | fetch <source> <commit>  [--root <dir>]";

/** One file at one commit: GET only, no credentials, no redirects, a time limit, and at most MAX_BYTES as they arrive. */
async function download(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Refused(`${url}: ${e?.cause?.message ?? e?.message ?? e}`); // a redirect is refused here
  }
  if (!res.ok) throw new Refused(`${url}: HTTP ${res.status}`);
  return readCapped(res, MAX_BYTES, url);
}

async function fetchSource(root, source, commit) {
  const s = Object.hasOwn(SOURCES, source) ? SOURCES[source] : undefined;
  if (!s) throw new Refused(`no source "${source}" (known: ${Object.keys(SOURCES).join(", ")})`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Refused("the commit must be 40 hex digits (a full commit id)");
  const file = join(root, "upstream", "SOURCES.json");
  const pins = parseJson(readFileSync(file, "utf8"), "upstream/SOURCES.json");
  if (!pins || typeof pins !== "object" || !Array.isArray(pins.files))
    throw new Refused('upstream/SOURCES.json: not {"files": [...]}');
  // every file is downloaded and its shape checked before the first is written: any failure leaves upstream/ as it was
  const got = [];
  for (const f of s.files) {
    const bytes = await download(`${s.raw}/${commit}/${f.path}`);
    readUse(bytes, f.use, `${source} ${f.path} at ${commit}`);
    got.push({ f, bytes });
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const { f, bytes } of got) {
    const path = join(root, "upstream", f.vendored);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const pin = {
      id: f.id,
      source,
      url: s.url,
      commit,
      path: f.path,
      vendored: f.vendored,
      use: f.use,
      sha256: sha256(bytes),
      license: s.license,
      fetched: today,
    };
    const i = pins.files.findIndex((p) => p.id === f.id);
    if (i === -1) pins.files.push(pin);
    else pins.files[i] = pin;
  }
  pins.files.sort((a, b) => FILES.findIndex((f) => f.id === a.id) - FILES.findIndex((f) => f.id === b.id));
  writeFileSync(file, `${JSON.stringify(pins, null, 2)}\n`);
  console.error(
    `import.mjs: ${source} at ${commit}: ${got.length} files written and pinned; review the diff, then run bundle.mjs --report`,
  );
  // the review's N4: a raw address serves any commit of the fork network under the parent's name
  console.error(
    `import.mjs: check that ${commit} is on ${s.url}'s own history, not a fork's (GitHub serves a fork's commits ` +
      `under the parent's address too): in a clone of ${s.url}, git merge-base --is-ancestor ${commit} origin/main`,
  );
}

/** The command line: `[verify]` or `fetch <source> <commit>`, and `--root <dir>` at most once; null for anything else. */
export function parseArgs(argv) {
  const words = [];
  let root;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      if (root !== undefined || i + 1 === argv.length) return null;
      root = argv[++i];
    } else if (argv[i].startsWith("-")) return null;
    else words.push(argv[i]);
  }
  const [cmd = "verify", ...rest] = words;
  if (cmd === "verify" && rest.length === 0) return { cmd, root };
  if (cmd === "fetch" && rest.length === 2) return { cmd, root, source: rest[0], commit: rest[1] };
  return null;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (!a) {
    console.error(USAGE);
    process.exit(2);
  }
  const root = resolve(a.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (a.cmd === "fetch") await fetchSource(root, a.source, a.commit);
  const { entries } = loadUpstream(root);
  console.error(`import.mjs: ${entries.length} upstream files present, matching their pins and their shapes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Refused ? `import.mjs: ${e.message}` : e);
    process.exit(1);
  });
