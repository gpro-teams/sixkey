#!/usr/bin/env node
// A maintainer's worklist (AF3-1b; the plan's C7; docs/design/notes/AUTOFILL3-NOTES.md §2): the sites 2fa.directory lists
// as taking authenticator codes that have no site rule yet, so a maintainer knows which real sign-in pages to check.
// It prints to the terminal and writes nothing: nothing of 2fa.directory goes into rules/, a bundle or Sixkey.
//
//   node rules/tools/worklist.mjs --from <file>   read a copy of https://api.2fa.directory/v4/totp.json you saved
//   node rules/tools/worklist.mjs --fetch         GET that address (the network: by hand only; nothing else is sent)
//   --root <dir>  the rules folder whose built bundle names the hosts that have a rule (default: this one)
// With neither, or with anything else, it says how to run it and stops (exit 2): it never reaches the network unless asked.
// It prints only names of lower-case letters, digits, dots and hyphens: nothing a terminal would read as a command.
//
// 2fa.directory's data is MIT-licensed, with the request "Data sourced from 2FA Directory by 2factorauth" wherever it is
// shown; this tool says so on every run.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCapped } from "./upstream.mjs";

const URL_V4 = "https://api.2fa.directory/v4/totp.json";
const ATTRIBUTION = "Data sourced from 2FA Directory by 2factorauth (https://2fa.directory/), MIT licence";
const MAX_BYTES = 16 * 1024 * 1024;
const USAGE =
  "usage: node rules/tools/worklist.mjs --from <saved totp.json> | --fetch (the network, by hand only)  [--root <dir>]";

/** 2fa.directory's v4 shape: an object of domain → {methods: [...], ...}; the domains, sorted. */
export function domainsOf(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("not the v4 totp.json shape (an object of domains)");
  const out = [];
  for (const [d, e] of Object.entries(v)) {
    // the name quoted as JSON writes it: a control character in it reaches the terminal escaped
    if (typeof e !== "object" || e === null || !Array.isArray(e.methods))
      throw new Error(`${JSON.stringify(d.slice(0, 80))}: not the v4 shape (no methods list)`);
    if (/^[a-z0-9.-]{1,253}$/.test(d) && d.includes(".")) out.push(d);
  }
  return out.sort();
}

/** The hosts that have a rule, from the built bundle (none when there is no bundle yet). */
export function ruled(root) {
  const file = join(root, "build", "baseline.json");
  if (!existsSync(file)) return new Set();
  return new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")).hosts ?? {}));
}

/** The command line: exactly one of --from <file> and --fetch, and --root <dir> at most once; null for anything else. */
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" || a === "--from") {
      if (a in o || i + 1 === argv.length) return null;
      o[a] = argv[++i];
    } else if (a === "--fetch" && !(a in o)) o[a] = true;
    else return null;
  }
  const saved = "--from" in o;
  const online = "--fetch" in o;
  return saved !== online ? o : null; // one of the two, never both
}

async function main(argv) {
  const o = parseArgs(argv);
  if (!o) {
    console.error(USAGE);
    process.exit(2);
  }
  const root = resolve(o["--root"] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  let text;
  if (o["--from"] !== undefined) text = readFileSync(o["--from"], "utf8");
  else if (o["--fetch"]) {
    const res = await fetch(URL_V4, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${URL_V4}: HTTP ${res.status}`);
    text = (await readCapped(res, MAX_BYTES, URL_V4)).toString("utf8");
  }
  const have = ruled(root);
  const todo = domainsOf(JSON.parse(text)).filter((d) => !have.has(d) && !have.has(`www.${d}`));
  console.error(`worklist.mjs: ${todo.length} sites without a rule. ${ATTRIBUTION}. Nothing is written.`);
  for (const d of todo) console.log(d);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(`worklist.mjs: ${e.message}`);
    process.exit(1);
  });
