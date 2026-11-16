// The upstream files of the site rules (rules/upstream/; docs/design/notes/AUTOFILL3-NOTES.md §2): which sources and
// files there may be, the pins in SOURCES.json, the checks every use of them starts with, and what a bundle takes from
// them. Shared by import.mjs (which writes them) and bundle.mjs (which reads them).
//
// The rules, all of them:
//   - the sources and their files are listed here, in code: SOURCES.json pins each listed file (the commit it came from,
//     its SHA-256, when it was fetched) and can name no other file, so a pin cannot point the bundler somewhere else;
//   - every read checks the vendored file's bytes against its pin and refuses on any difference (`hash`), and checks its
//     shape exactly as its source defines it (Apple's own schema: quirks/schemas/), refusing any other (`shape`);
//   - alias groups and the "code after the password" hosts come from these files only (the plan's M1): there is no other
//     way into a bundle for them, and the exclusion list (exclude.json) can only take groups and hosts out.
//   - a JSON key written twice is refused in every file the tools read (`repeatedKey`): JSON.parse keeps the last one
//     silently, and neither the extension's checker nor a JSON Schema can see it afterwards (the AF3-1a review's N4).
// Nothing here uses the network: fetching is import.mjs's `fetch`, run by hand.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A reason to stop, with the file it is about. */
export class Refused extends Error {}
const refuse = (what, why) => {
  throw new Refused(`${what}: ${why}`);
};

/** The sources this corpus may import from, and their files. A new source or file is a change to this table, reviewed. */
export const SOURCES = {
  apple: {
    url: "https://github.com/apple/password-manager-resources",
    raw: "https://raw.githubusercontent.com/apple/password-manager-resources",
    license: "MIT",
    files: [
      {
        id: "apple-shared-credentials",
        path: "quirks/shared-credentials.json",
        vendored: "apple/shared-credentials.json",
        use: "aliases",
      },
      {
        id: "apple-append-2fa",
        path: "quirks/websites-that-append-2fa-to-password.json",
        vendored: "apple/websites-that-append-2fa-to-password.json",
        use: "appends",
      },
      { id: "apple-license", path: "LICENSE.md", vendored: "apple/LICENSE.md", use: "licence" },
    ],
  },
};
/** Every file of every source, with its source's name. */
export const FILES = Object.entries(SOURCES).flatMap(([source, s]) => s.files.map((f) => ({ ...f, source })));

const plain = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const sameKeys = (o, keys) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && [...keys].sort().every((x, i) => x === k[i]);
};
const strings = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");

/** Apple's shared-credentials.json: objects of exactly {shared} or {from, to} (with an optional boolean fromDomainsAreObsoleted). */
function appleGroups(v, what) {
  if (!Array.isArray(v)) refuse(what, "unknown upstream shape: not a list");
  v.forEach((e, i) => {
    const at = `${what}[${i}]`;
    if (!plain(e)) refuse(at, "unknown upstream shape: not an object");
    if (sameKeys(e, ["shared"])) {
      if (!strings(e.shared)) refuse(at, "unknown upstream shape: shared is not a list of names");
    } else if (sameKeys(e, ["from", "to"]) || sameKeys(e, ["from", "to", "fromDomainsAreObsoleted"])) {
      if (!strings(e.from) || !strings(e.to)) refuse(at, "unknown upstream shape: from or to is not a list of names");
      if ("fromDomainsAreObsoleted" in e && typeof e.fromDomainsAreObsoleted !== "boolean")
        refuse(at, "unknown upstream shape: fromDomainsAreObsoleted is not a boolean");
    } else refuse(at, `unknown upstream shape: fields ${JSON.stringify(Object.keys(e))}`);
  });
  return v;
}
/** Apple's websites-that-append-2fa-to-password.json: a list of names. */
function appleHosts(v, what) {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    refuse(what, "unknown upstream shape: not a list of names");
  return v;
}
/** The licence text: Apple's MIT notice. */
function mitText(text, what) {
  if (!text.includes("Permission is hereby granted, free of charge") || !/Copyright [^\n]*Apple Inc\./.test(text))
    refuse(what, "not the MIT notice of Apple's files");
  return text;
}

/**
 * The first key that some object of the JSON `text` has twice, or null. It reads the text as JSON does (strings with their
 * escapes, nesting), but only to find keys: whether the text is JSON at all is JSON.parse's to say.
 */
export function repeatedKey(text) {
  const open = []; // per open object: its keys so far, and whether a key comes next; null for an array
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = open.at(-1);
      if (top && top.next) {
        let key;
        try {
          key = JSON.parse(text.slice(i, j + 1));
        } catch {
          return null;
        }
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.next = false;
      }
      i = j;
    } else if (c === "{") open.push({ keys: new Set(), next: true });
    else if (c === "[") open.push(null);
    else if (c === "}" || c === "]") open.pop();
    else if (c === "," && open.at(-1)) open.at(-1).next = true;
  }
  return null;
}

/**
 * The body of a response the caller has already asked for, refused as soon as more than `max` bytes have arrived (or at
 * once, when its Content-Length says more): a server cannot make a tool hold more than `max` bytes (the review's N5).
 */
export async function readCapped(res, max, what) {
  if (Number(res.headers.get("content-length")) > max) refuse(what, `larger than ${max} bytes`);
  const parts = [];
  let n = 0;
  if (res.body)
    for await (const chunk of res.body) {
      n += chunk.length;
      if (n > max) refuse(what, `larger than ${max} bytes`); // leaving the loop cancels the rest of the body
      parts.push(chunk);
    }
  return Buffer.concat(parts);
}

/** A JSON file's text, parsed, with no key written twice in any object; `what` names it in a refusal. */
export function parseJson(text, what, bad = "not JSON") {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    refuse(what, bad);
  }
  const twice = repeatedKey(text);
  if (twice !== null) refuse(what, `the key ${JSON.stringify(twice.slice(0, 80))} is written twice in one object`);
  return v;
}

/** The shape check of a file's bytes for its use; the parsed value (or the text, for a licence). */
export function readUse(bytes, use, what) {
  const text = bytes.toString("utf8");
  if (use === "licence") return mitText(text, what);
  const v = parseJson(text, what, "unknown upstream shape: not JSON");
  return use === "aliases" ? appleGroups(v, what) : appleHosts(v, what);
}

const SOURCE_FIELDS = ["id", "source", "url", "commit", "path", "vendored", "use", "sha256", "license", "fetched"];
/**
 * SOURCES.json, checked against the table above and against the vendored files: one entry for each listed file and no
 * other, each with exactly its fields, its pin's form, and bytes that hash to its pin and have its use's shape.
 * Returns the entries (in the table's order) and the parsed data by use.
 */
export function loadUpstream(root) {
  const dir = join(root, "upstream");
  const file = join(dir, "SOURCES.json");
  if (!existsSync(file)) refuse("upstream/SOURCES.json", "missing");
  const pins = parseJson(readFileSync(file, "utf8"), "upstream/SOURCES.json");
  if (!plain(pins) || !sameKeys(pins, ["files"]) || !Array.isArray(pins.files))
    refuse("upstream/SOURCES.json", 'not {"files": [...]}');
  const byId = new Map();
  for (const p of pins.files) {
    if (!plain(p) || !sameKeys(p, SOURCE_FIELDS))
      refuse("upstream/SOURCES.json", `an entry is not exactly ${SOURCE_FIELDS.join(", ")}`);
    if (byId.has(p.id)) refuse("upstream/SOURCES.json", `"${p.id}" twice`);
    byId.set(p.id, p);
  }
  const entries = [];
  const data = { aliases: [], appends: [] };
  for (const f of FILES) {
    const p = byId.get(f.id);
    if (!p) refuse("upstream/SOURCES.json", `no pin for "${f.id}"`);
    byId.delete(f.id);
    const what = `upstream/${f.vendored}`;
    for (const k of ["source", "path", "vendored", "use"])
      if (p[k] !== f[k]) refuse("upstream/SOURCES.json", `"${f.id}": ${k} is not ${JSON.stringify(f[k])}`);
    if (p.url !== SOURCES[f.source].url) refuse("upstream/SOURCES.json", `"${f.id}": not the source's address`);
    if (p.license !== SOURCES[f.source].license) refuse("upstream/SOURCES.json", `"${f.id}": not the source's licence`);
    if (typeof p.commit !== "string" || !/^[0-9a-f]{40}$/.test(p.commit))
      refuse("upstream/SOURCES.json", `"${f.id}": commit is not 40 hex digits`);
    if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256))
      refuse("upstream/SOURCES.json", `"${f.id}": sha256 is not 64 hex digits`);
    if (typeof p.fetched !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.fetched))
      refuse("upstream/SOURCES.json", `"${f.id}": fetched is not a date`);
    const path = join(dir, f.vendored);
    if (!existsSync(path)) refuse(what, "missing");
    const bytes = readFileSync(path);
    const got = sha256(bytes);
    if (got !== p.sha256) refuse(what, `hash mismatch: the file's SHA-256 is ${got}, its pin says ${p.sha256}`);
    const value = readUse(bytes, f.use, what);
    if (f.use !== "licence") data[f.use].push(...value);
    entries.push(p);
  }
  for (const id of byId.keys()) refuse("upstream/SOURCES.json", `"${id}" is not a file of a known source`);
  return { entries, data };
}

/** What a bundle names of its upstream data (its `upstream` field): the data files, not the licence. */
export const upstreamField = (entries) =>
  entries
    .filter((p) => p.use !== "licence")
    .map(({ id, url, commit, path, sha256: sha, license }) => ({ id, url, commit, path, sha256: sha, license }));
