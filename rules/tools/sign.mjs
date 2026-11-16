#!/usr/bin/env node
// Sign a live bundle of the site rules (TOTP autofill Stage 3, AF3-U1; docs/design/notes/AUTOFILL3-NOTES.md §9): the
// offline signer, for the updater that a build's release gate lets in (extension/scripts/rules-update.mjs). The steps
// around it, from making the two keys to what to do when one is lost or stolen, are rules/SIGNING.md.
//
//   node rules/tools/sign.mjs sign --bundle <live.json> --key <private.pem> [--passphrase-stdin] [--days <n>]
//        [--baseline <n>] --out <dir>
//     with the private key in a PKCS#8 PEM file (encrypted or not): writes <dir>/manifest.json, the signed manifest, and
//     <dir>/bundle-<version>.json, the bundle byte for byte: the two files the server serves under /v1/.
//   node rules/tools/sign.mjs prepare --bundle <live.json> --public <public.pem> [--days <n>] [--baseline <n>] --out <dir>
//     for a key on a device (a hardware key): writes <dir>/manifest-body.txt, the manifest, and <dir>/to-sign.bin, the exact
//     bytes to sign with ECDSA P-256 over their SHA-256, and prints that SHA-256 for a device that signs a digest;
//   node rules/tools/sign.mjs assemble --bundle <live.json> --public <public.pem> --body <dir>/manifest-body.txt
//        --sig <file> --sig-format der|raw [--baseline <n>] --out <dir>
//     then makes the signed manifest from the device's signature, DER (ECDSA-Sig-Value) or raw (r‖s, 64 bytes), and
//     writes what `sign` writes;
//   node rules/tools/sign.mjs kid (--public <public.pem> | --key <private.pem> [--passphrase-stdin])
//     prints a key's entry for extension/scripts/rules-keys.mjs: its kid and its SubjectPublicKeyInfo in base64.
// Anything else (another word, an option it does not take, one twice, a missing value) prints the usage, exit code 2.
//
// It refuses, before anything is signed or written: a bundle with a JSON key written twice in any object (upstream.mjs
// repeatedKey, on the raw text: JSON.parse would keep the last one silently); a bundle the extension's checker refuses as
// a live bundle (format.ts validate(…, "live", …): no aliases, appends or upstream files, a source address); a bundle that
// is not ASCII or larger than 512 KiB; a key that is not P-256; and anything the extension would refuse in what it is
// about to sign (a version not above the baseline or over it by more than 1,000, a validity over 180 days), found by
// signing the same manifest with a throwaway key first and checking it as the extension does. After signing, before
// writing, it checks its own output with the extension's own code (src/core/rules/signed.ts checkSigned, the key pinned
// alone), so the signer and the extension cannot disagree on a valid signed manifest. It never overwrites a file and
// never uses the network.
//
// Validity: `--days`, 1 to 180, by default 120. 180 is what the extension accepts at most; 120 lets the bundles be
// signed again every 90 days (a quarterly habit) with 30 days to spare before clients stop using the last one and fall
// back to their built-in rules, and keeps a bundle found wrong but impossible to replace (the server lost) on clients
// four months at most, not six. The baseline is the version of the committed rules/build/baseline.json (what the newest
// release carries) unless `--baseline` says another (the oldest release still in use, to see that it accepts it too).
//
// Needs Node 22.18 or later (it loads the extension's checker, TypeScript files, through Node's type stripping), or
// `node --experimental-strip-types` on Node 22.6 to 22.17.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as ecdsaSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../extension/src/core/rules/format.ts";
import {
  BOUNDS,
  checkSigned,
  importPinned,
  kidOf,
  manifestText,
  MANIFEST_FORMAT,
  MANIFEST_SCHEMA,
  P256_SPKI_PREFIX,
  parseManifest,
  signedBytes,
  signedFile,
} from "../../extension/src/core/rules/signed.ts";
import { canonicalHost } from "../../extension/src/core/match.ts";
import { isShared } from "../../extension/src/core/site-domains.ts";
import { STORE_RULES_KEYS } from "../../extension/scripts/rules-keys.mjs";
import { Refused, parseJson, repeatedKey, sha256 } from "./upstream.mjs";

const CHECKER = { validate, checks: { canonicalHost, isShared } };
const DAY = 86_400_000;
export const DEFAULT_DAYS = 120;
const refuse = (what, why) => {
  throw new Refused(`${what}: ${why}`);
};

/** The bundle to sign, from its file's bytes: every check the extension makes on a live bundle, and a key written once. */
export function readBundle(bytes, what = "the bundle") {
  if (bytes.length > BOUNDS.bundle) refuse(what, `larger than ${BOUNDS.bundle} bytes`);
  const text = bytes.toString("latin1");
  if (!/^[\t\n\r\x20-\x7e]*$/.test(text)) refuse(what, "not ASCII text");
  const twice = repeatedKey(text);
  if (twice !== null) refuse(what, `the key ${JSON.stringify(twice.slice(0, 80))} is written twice in one object`);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse(what, "not JSON");
  }
  const v = validate(raw, "live", CHECKER.checks);
  if (!v.ok) refuse(what, `not a live bundle the extension accepts: ${v.error}`);
  return v.value;
}

/** The version of the committed baseline bundle (rules/build/baseline.json), checked as the extension reads it. */
export function committedBaseline(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  const file = join(root, "build", "baseline.json");
  if (!existsSync(file)) refuse("build/baseline.json", "missing: say --baseline <version>");
  const v = validate(parseJson(readFileSync(file, "utf8"), "build/baseline.json"), "baseline", CHECKER.checks);
  if (!v.ok) refuse("build/baseline.json", v.error);
  return v.value.version;
}

/** The manifest of `bundle` (its bytes and its checked value), created now (whole seconds) and valid for `days`. */
export function manifestOf(bytes, bundle, days, now, sha256) {
  const created = Math.floor(now / 1000) * 1000;
  return manifestText({
    format: MANIFEST_FORMAT,
    schema: MANIFEST_SCHEMA,
    version: bundle.version,
    created: new Date(created).toISOString().replace(".000Z", "Z"),
    expires: new Date(created + days * DAY).toISOString().replace(".000Z", "Z"),
    sha256,
    size: bytes.length,
    source: bundle.source,
    license: bundle.license,
  });
}

/** The extension's own check of a signed manifest and its bundle, with `spki` the one key pinned and no record. */
export async function selfCheck(file, bytes, spki, baseline, now = Date.now()) {
  const kid = await kidOf(new Uint8Array(spki));
  const pinned = await importPinned([{ kid, spki: Buffer.from(spki).toString("base64") }]);
  if (!pinned.ok) refuse("the key", pinned.error);
  return checkSigned(file, new Uint8Array(bytes), null, { now, baseline, pinned: pinned.value }, CHECKER);
}

/** Refuse `m` before the real key signs it, if the extension would refuse it whatever the key: a throwaway key's run. */
async function dryRun(m, bytes, baseline) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = spkiOf(publicKey, "a throwaway key");
  const sig = ecdsaSign("sha256", signedBytes(m), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const r = await selfCheck(signedFile(m, await kidOf(new Uint8Array(spki)), sig), bytes, spki, baseline);
  if (!r.ok) refuse("the extension would refuse this manifest", r.error);
}

/**
 * A P-256 key's SubjectPublicKeyInfo (DER), from a key object Node made, in the one form the extension pins: the point
 * uncompressed, 91 bytes, made from the key's x and y (signed.ts importPinned refuses any other). A public key file that
 * holds the compressed form gives the same bytes, so `kid`, `sign`, `prepare` and `assemble` name one key one way (the
 * AF3-U1 review's S2).
 */
function spkiOf(key, what) {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    refuse(what, "not a P-256 (prime256v1) key");
  const jwk = (key.type === "public" ? key : createPublicKey(key)).export({ format: "jwk" });
  const xy = [jwk.x, jwk.y].map((v) => Buffer.from(v, "base64url"));
  if (xy.some((b) => b.length !== 32)) refuse(what, "not a P-256 point");
  return Buffer.concat([Buffer.from(P256_SPKI_PREFIX, "hex"), ...xy]);
}

/** A public key file: PEM (BEGIN PUBLIC KEY) or its DER; its SubjectPublicKeyInfo. */
export function publicKeyOf(file) {
  const raw = readFileSync(file);
  const text = raw.toString("latin1");
  let key;
  try {
    if (text.includes("-----BEGIN PUBLIC KEY-----")) key = createPublicKey({ key: text, format: "pem" });
    else if (!text.includes("-----BEGIN")) key = createPublicKey({ key: raw, format: "der", type: "spki" });
  } catch {
    // refused below
  }
  if (!key) refuse(file, "not a public key (PEM: BEGIN PUBLIC KEY, or its DER)");
  return spkiOf(key, file);
}

/** The passphrase, from standard input: typed without echo at a terminal, else its first line as piped in. */
async function readPassphrase() {
  const input = process.stdin;
  if (!input.isTTY) {
    const parts = [];
    for await (const chunk of input) parts.push(chunk);
    return Buffer.concat(parts).toString("utf8").split(/\r?\n/)[0];
  }
  process.stderr.write("passphrase: ");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((done, fail) => {
    let s = [];
    const end = (err) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", on);
      process.stderr.write("\n");
      if (err) fail(err);
      else done(s.join(""));
    };
    const on = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return end();
        if (ch === "\u0003" || ch === "\u0004") return end(new Refused("passphrase: not given"));
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else s.push(ch);
      }
    };
    input.on("data", on);
  });
}

/** A private key file: PKCS#8 in PEM (BEGIN PRIVATE KEY, or BEGIN ENCRYPTED PRIVATE KEY with the passphrase). */
export async function privateKeyOf(file, passphraseStdin, passphrase) {
  const pem = readFileSync(file, "utf8");
  const encrypted = pem.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----");
  if (!encrypted && !pem.includes("-----BEGIN PRIVATE KEY-----"))
    refuse(
      file,
      "not a PKCS#8 private key in PEM (BEGIN PRIVATE KEY or BEGIN ENCRYPTED PRIVATE KEY); `openssl pkcs8 -topk8` converts one",
    );
  if (encrypted && !passphraseStdin && passphrase === undefined)
    refuse(file, "encrypted: give its passphrase with --passphrase-stdin");
  const pass = encrypted ? (passphrase ?? (await readPassphrase())) : undefined;
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem", ...(encrypted ? { passphrase: pass } : {}) });
  } catch {
    refuse(file, encrypted ? "cannot be opened with this passphrase" : "cannot be read");
  }
  spkiOf(key, file);
  return key;
}

/**
 * A DER ECDSA-Sig-Value (SEQUENCE of the INTEGERs r and s, as most devices and OpenSSL write a signature) as the 64 bytes
 * of r‖s the manifest carries (IEEE P1363). Strict DER: short lengths, minimal positive integers of 1 to 32 bytes of
 * value, nothing after.
 */
export function p1363FromDer(der) {
  const b = Uint8Array.from(der);
  let i = 0;
  const next = () => (i < b.length ? b[i++] : refuse("the signature", "not DER: it ends too soon"));
  if (next() !== 0x30) refuse("the signature", "not DER: no SEQUENCE");
  const len = next();
  if (len >= 0x80 || len !== b.length - 2) refuse("the signature", "not DER: the SEQUENCE's length");
  const integer = (name) => {
    if (next() !== 0x02) refuse("the signature", `not DER: no INTEGER ${name}`);
    const n = next();
    if (n < 1 || n > 33 || i + n > b.length) refuse("the signature", `not DER: the length of ${name}`);
    const v = b.subarray(i, i + n);
    i += n;
    if (v[0] & 0x80) refuse("the signature", `${name} is negative`);
    if (n > 1 && v[0] === 0 && !(v[1] & 0x80)) refuse("the signature", `${name} is not written in its shortest form`);
    const w = v[0] === 0 ? v.subarray(1) : v;
    if (w.length > 32) refuse("the signature", `${name} is longer than 32 bytes`);
    if (w.every((x) => x === 0)) refuse("the signature", `${name} is zero`);
    const out = new Uint8Array(32);
    out.set(w, 32 - w.length);
    return out;
  };
  const r = integer("r");
  const s = integer("s");
  if (i !== b.length) refuse("the signature", "not DER: bytes after the SEQUENCE");
  return Buffer.concat([r, s]);
}

/** Where `kid` sits in the store build's list, in words. */
function storePlace(kid) {
  const at = STORE_RULES_KEYS.findIndex((k) => k.kid === kid);
  return at === 0
    ? "the store build's first key (current)"
    : at === 1
      ? "the store build's second key (next: accepting what it signs retires the first on every client that fetches it)"
      : "not a key the store build pins (extension/scripts/rules-keys.mjs): only a build that pins it accepts what it signs";
}

/** Write the server's two files, after the self-check passed; never over a file that is there. */
async function writeSigned(out, file, bytes, spki, baseline, kid, how) {
  const r = await selfCheck(file, bytes, spki, baseline);
  if (!r.ok) refuse("the signed manifest failed the extension's own check", r.error);
  const v = r.value.manifest.version;
  const files = [join(out, "manifest.json"), join(out, `bundle-${v}.json`)];
  for (const f of files) if (existsSync(f)) refuse(f, "is there already: nothing is overwritten");
  mkdirSync(out, { recursive: true });
  writeFileSync(files[1], bytes, { flag: "wx" });
  writeFileSync(files[0], file, { flag: "wx" });
  const m = r.value.manifest;
  console.error(
    [
      `sign.mjs: ${how} version ${v} with key ${kid}, ${storePlace(kid)}`,
      `  created ${m.created}, expires ${m.expires}; bundle ${m.size} bytes, SHA-256 ${m.sha256}`,
      `  wrote ${files[1]} and ${files[0]}: publish the bundle first, then the manifest, under /v1/`,
    ].join("\n"),
  );
}

/** Read and check the bundle and the baseline; the bytes, the bundle and the baseline's version. */
function inputs(o) {
  const bytes = readFileSync(o["--bundle"]);
  const bundle = readBundle(bytes, o["--bundle"]);
  const given = o["--baseline"];
  if (given !== undefined && !/^\d+$/.test(given)) refuse("--baseline", "not a version (digits only)");
  const baseline = given !== undefined ? Number(given) : committedBaseline();
  if (!Number.isSafeInteger(baseline)) refuse("--baseline", "not a version");
  return { bytes, bundle, baseline };
}

const COMMANDS = {
  sign: { values: ["--bundle", "--key", "--days", "--baseline", "--out"], flags: ["--passphrase-stdin"] },
  prepare: { values: ["--bundle", "--public", "--days", "--baseline", "--out"], flags: [] },
  assemble: {
    values: ["--bundle", "--public", "--body", "--sig", "--sig-format", "--baseline", "--out"],
    flags: [],
  },
  kid: { values: ["--public", "--key"], flags: ["--passphrase-stdin"] },
};
const REQUIRED = {
  sign: ["--bundle", "--key", "--out"],
  prepare: ["--bundle", "--public", "--out"],
  assemble: ["--bundle", "--public", "--body", "--sig", "--sig-format", "--out"],
  kid: [],
};
const USAGE = [
  "usage: node rules/tools/sign.mjs sign --bundle <live.json> --key <private.pem> [--passphrase-stdin] [--days <n>] [--baseline <n>] --out <dir>",
  "       node rules/tools/sign.mjs prepare --bundle <live.json> --public <public.pem> [--days <n>] [--baseline <n>] --out <dir>",
  "       node rules/tools/sign.mjs assemble --bundle <live.json> --public <public.pem> --body <file> --sig <file> --sig-format der|raw [--baseline <n>] --out <dir>",
  "       node rules/tools/sign.mjs kid (--public <public.pem> | --key <private.pem> [--passphrase-stdin])",
].join("\n");

/** The command line: a command and its options, each at most once; null for anything else. */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, cmd ?? "")) return null;
  const { values, flags } = COMMANDS[cmd];
  const o = { cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a in o) return null;
    if (values.includes(a)) {
      if (i + 1 === rest.length || rest[i + 1].startsWith("--")) return null;
      o[a] = rest[++i];
    } else if (flags.includes(a)) o[a] = true;
    else return null;
  }
  if (!REQUIRED[cmd].every((k) => k in o)) return null;
  if (cmd === "kid" && "--public" in o === "--key" in o) return null;
  if (cmd === "kid" && "--public" in o && "--passphrase-stdin" in o) return null;
  if ("--sig-format" in o && !["der", "raw"].includes(o["--sig-format"])) return null;
  return o;
}

function daysOf(o) {
  const d = o["--days"] === undefined ? DEFAULT_DAYS : Number(o["--days"]);
  if (!/^\d+$/.test(String(o["--days"] ?? DEFAULT_DAYS)) || d < 1 || d * DAY > BOUNDS.validity)
    refuse("--days", `not a whole number of days from 1 to ${BOUNDS.validity / DAY}`);
  return d;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (!o) {
    console.error(USAGE);
    process.exit(2);
  }
  if (o.cmd === "kid") {
    const spki = o["--public"]
      ? publicKeyOf(o["--public"])
      : spkiOf(await privateKeyOf(o["--key"], o["--passphrase-stdin"] === true), o["--key"]);
    console.log(JSON.stringify({ kid: await kidOf(new Uint8Array(spki)), spki: spki.toString("base64") }));
    return;
  }
  const out = resolve(o["--out"]);
  if (o.cmd === "sign") {
    const days = daysOf(o);
    const { bytes, bundle, baseline } = inputs(o);
    const key = await privateKeyOf(o["--key"], o["--passphrase-stdin"] === true);
    const spki = spkiOf(key, o["--key"]);
    const m = manifestOf(bytes, bundle, days, Date.now(), sha256(bytes));
    await dryRun(m, bytes, baseline);
    const sig = ecdsaSign("sha256", signedBytes(m), { key, dsaEncoding: "ieee-p1363" });
    const kid = await kidOf(new Uint8Array(spki));
    await writeSigned(out, signedFile(m, kid, sig), bytes, spki, baseline, kid, "signed");
  } else if (o.cmd === "prepare") {
    const days = daysOf(o);
    const { bytes, bundle, baseline } = inputs(o);
    const spki = publicKeyOf(o["--public"]);
    const kid = await kidOf(new Uint8Array(spki));
    const m = manifestOf(bytes, bundle, days, Date.now(), sha256(bytes));
    await dryRun(m, bytes, baseline);
    const files = [join(out, "manifest-body.txt"), join(out, "to-sign.bin")];
    for (const f of files) if (existsSync(f)) refuse(f, "is there already: nothing is overwritten");
    mkdirSync(out, { recursive: true });
    writeFileSync(files[0], m, { flag: "wx" });
    writeFileSync(files[1], signedBytes(m), { flag: "wx" });
    console.error(
      [
        `sign.mjs: prepared version ${bundle.version} for key ${kid}, ${storePlace(kid)}`,
        `  sign ${files[1]} with ECDSA P-256 over its SHA-256: a mechanism that hashes the file itself (PKCS#11`,
        `  CKM_ECDSA_SHA256, openssl dgst -sha256 -sign, yubico-piv-tool with -H SHA256), or, for one that signs a digest`,
        `  given to it (PKCS#11 CKM_ECDSA, a PIV card's raw sign), this SHA-256 of the file: ${sha256(signedBytes(m))}`,
        `  then:`,
        `  node rules/tools/sign.mjs assemble --bundle ${o["--bundle"]} --public ${o["--public"]} --body ${files[0]} --sig <signature> --sig-format der|raw --out <dir>`,
      ].join("\n"),
    );
  } else {
    const { bytes, baseline } = inputs(o);
    const spki = publicKeyOf(o["--public"]);
    const m = readFileSync(o["--body"], "latin1");
    const pm = parseManifest(m);
    if (!pm.ok) refuse(o["--body"], pm.error);
    const raw = readFileSync(o["--sig"]);
    const sig = o["--sig-format"] === "raw" ? raw : p1363FromDer(raw);
    if (sig.length !== 64) refuse(o["--sig"], "a raw signature is r and s, 64 bytes");
    const kid = await kidOf(new Uint8Array(spki));
    await writeSigned(out, signedFile(m, kid, sig), bytes, spki, baseline, kid, "assembled the signature of");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Refused ? `sign.mjs: ${e.message}` : e);
    process.exit(1);
  });
}
