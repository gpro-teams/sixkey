// Signed live bundles for the site rules' updater's tests (TOTP autofill Stage 3, AF3-U2): its unit tests
// (test/unit/rules-live.test.ts) and the browser's (test/e2e/rules-update.spec.ts). A bundle and its signed manifest are
// made as rules/tools/sign.mjs makes them (the manifest's one text, the signed bytes, r‖s in base64url), with signed.ts's
// own functions, and signed with WebCrypto: a key of the test's own (newKey), or one of the two published test keys
// (testKey: test/fixtures/rules-keys/, whose public halves the dev and e2e builds pin). sign.mjs itself refuses hosts under
// the reserved names, which the e2e build's bundles use (AF3-U1's §9.8), so the e2e tests sign here.
import { createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { kidOf, manifestText, signedBytes, signedFile, type Manifest } from "../../src/core/rules/signed";

export const DAY_MS = 86_400_000;
export const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** A signing key: its kid and SPKI as a build pins them, and the private half. */
export type Key = { kid: string; spki: string; priv: CryptoKey };
/** The entry a build's list holds for `k` (scripts/rules-keys.mjs). */
export const pinnedOf = (k: Key) => ({ kid: k.kid, spki: k.spki });

export async function newKey(): Promise<Key> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  return { kid: await kidOf(spki), spki: b64(spki), priv: kp.privateKey };
}

/** One of the published test keys ("current" or "next"), which the dev and e2e builds pin, in that order. */
export async function testKey(which: "current" | "next"): Promise<Key> {
  const pem = readFileSync(
    resolve(import.meta.dirname, `../fixtures/rules-keys/test-only-${which}.pem`),
    "utf8",
  ).replace(/^[\s\S]*?(?=-----BEGIN)/, "");
  const der = createPrivateKey(pem).export({ type: "pkcs8", format: "der" });
  const priv = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const spki = new Uint8Array(createPublicKey(pem).export({ type: "spki", format: "der" }));
  return { kid: await kidOf(spki), spki: b64(spki), priv };
}

type J = Record<string, unknown>;
/** A live bundle of `version` with these rules and hosts (`over` changes or adds fields). */
export function liveBundle(
  version: number,
  rules: Record<string, J> = { a: { pages: [{ path: "/2fa", field: "input#otp", segments: 0, fill: "auto" }] } },
  hosts: Record<string, string> = { "login.example.com": "a" },
  over: J = {},
): J {
  return {
    format: "sixkey-rules",
    kind: "live",
    schema: 1,
    version,
    created: "2026-11-04",
    license: "AGPL-3.0-or-later",
    source: `https://example.org/sixkey/tree/rules-v${version}/rules`,
    rules,
    hosts,
    ...over,
  };
}
/** A bundle's bytes as the server sends them (indented JSON and a line end, as the bundler writes a bundle). */
export const bundleBytes = (b: J): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`${JSON.stringify(b, null, 2)}\n`);

/**
 * The signed manifest for `bytes` (the bundle `b`), by `key`: made `now`, valid `days` (120), `over` changing fields of
 * the manifest, `kid` another key's id to claim.
 */
export async function signedManifest(
  key: Key,
  bytes: Uint8Array,
  b: J,
  o: { now: number; days?: number; over?: Partial<Manifest>; kid?: string },
): Promise<string> {
  const m = manifestText({
    format: "sixkey-rules-manifest",
    schema: 1,
    version: b.version as number,
    created: iso(o.now),
    expires: iso(o.now + (o.days ?? 120) * DAY_MS),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    source: b.source as string,
    license: b.license as string,
    ...o.over,
  });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.priv, signedBytes(m)));
  return signedFile(m, o.kid ?? key.kid, sig);
}
