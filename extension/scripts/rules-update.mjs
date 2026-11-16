// The release gate of the site rules' updater (TOTP autofill Stage 3, AF3-U1; docs/design/notes/AUTOFILL3-NOTES.md §9).
//
// With the gate open, a build may download signed site rules between releases: once a day at most, a manifest signed
// with a key the build pins (scripts/rules-keys.mjs) and the live bundle it names, from RULES_ORIGINS, checked by
// src/core/rules/signed.ts before anything is kept (the updater, src/platform/rules-live.ts, its read, rules-fetch.ts, and
// its switch in Settings, src/options/RulesUpdate.tsx: AF3-U2). The dev and e2e flavours carry it always, and the store
// (prod) flavour only when RULES_UPDATE_IN_STORE_BUILD is true.
//
// While the gate is false, a store build holds none of it: the updater's modules (src/core/rules/signed.ts, and AF3-U2's
// rules-fetch.ts and rules-live.ts) are kept out of the module graph by scripts/rules-guard.mjs, which fails a build
// whose graph holds one all the same, the code that reaches them is dead code behind the build's define, and
// scripts/check-dist.mjs looks for their marks in the built files (the manifest's format, the record's database, every
// rules origin, the switch's key, the two messages, the switch's words and chunks).
//
// Flipping it is one reviewed change (AF3-U3), made once the owner has set the rules origin and made the two signing keys
// (rules/SIGNING.md): this constant, the test that pins it (test/unit/rules-update-gate.test.ts), RULES_ORIGINS.prod,
// scripts/rules-keys.mjs's store list, the privacy notes and the store text, all in the same change. A prod build with the
// gate open and no origin (or a test, reserved or local one), or without exactly two pinned keys (or with a test key),
// refuses to build (updaterProblems).
// Nothing else can turn it on: no environment variable, command-line flag or define (the same test checks that this
// module is the only place the value comes from).
import { fileURLToPath } from "node:url";
import { rulesKeysOf, sameKey, TEST_RULES_KEYS } from "./rules-keys.mjs";

export const RULES_UPDATE_IN_STORE_BUILD = false;

/** Whether a build flavour ("prod", "dev", "e2e") carries the site rules' updater. */
export const rulesUpdateIn = (flavour) => (flavour === "prod" ? RULES_UPDATE_IN_STORE_BUILD : true);

/**
 * Where each flavour's updater reads the manifest (/v1/manifest.json) and the bundles (/v1/bundle-<version>.json). The
 * store build's is empty until the owner sets it (the plan's Q1; the recommendation is https://rules.sixkey.app). The dev
 * and e2e builds' is a fixture host the tests serve (a reserved name, which no real server can have).
 */
export const RULES_ORIGINS = { prod: "", dev: "https://rules.fix.test", e2e: "https://rules.fix.test" };

/**
 * The one path of the rules origin the updater reads (the manifest, /v1/manifest.json; a bundle, /v1/bundle-<version>.json:
 * src/platform/rules-live.ts), and the one source a build whose gate is open adds to its CSP's connect-src (scripts/
 * build.mjs; check-dist holds the CSP to exactly that). A client reads /v1/ while it reads schema 1 (the plan's §5.2).
 */
export const rulesPathOf = (origin) => `${origin}/v1/`;

/** An origin as a build may name it: https, a host of two labels or more in lower case, no port, path or user. */
const ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The hosts of the dev and e2e builds' rules origin, which a store build never names, whatever its own origin is (were it
 * set to one of them, the store build would name it, and check-dist says so: the AF3-U1 review's N2).
 */
export const testRulesHosts = (origins = RULES_ORIGINS) => [
  ...new Set([origins.dev, origins.e2e].filter(Boolean).map((o) => new URL(o).host)),
];

/** Reserved names (format.ts RESERVED_TLDS) and the local host, which a server on the internet cannot have. */
const RESERVED = /(?:^|\.)(?:test|example|invalid|localhost)$/;
/**
 * Whether `origin` (already of ORIGIN's form) can be the store build's: not a reserved name or the local host, not an IP
 * address (a host of digits and dots), and not the dev and e2e builds' origin (the AF3-U1 review's N2).
 */
export function storeOrigin(origin) {
  const host = new URL(origin).hostname;
  return (
    !RESERVED.test(host) && !/^[0-9.]+$/.test(host) && origin !== RULES_ORIGINS.dev && origin !== RULES_ORIGINS.e2e
  );
}

/**
 * Why a build of `flavour` with this gate open cannot be made, as sentences; none when it can. scripts/build.mjs stops on
 * any, before anything is built. The keys are checked by the extension's own code (signed.ts importPinned, loaded through
 * Vite as rules-package.mjs loads the reader): exactly two, current and next, each a P-256 public key whose kid is its
 * own; a store build's are no test key. `o` replaces the flavour's keys or origin (the tests).
 */
export async function updaterProblems(flavour, o = {}) {
  const keys = o.keys ?? rulesKeysOf(flavour);
  const origin = o.origin ?? RULES_ORIGINS[flavour];
  const problems = [];
  if (typeof origin !== "string" || !ORIGIN.test(origin))
    problems.push(
      `the ${flavour} build has no rules origin (scripts/rules-update.mjs RULES_ORIGINS): an https origin, no path`,
    );
  else if (flavour === "prod" && !storeOrigin(origin))
    problems.push(
      `the store build's rules origin ${origin} is a test or reserved name, an IP address, or the dev and e2e builds' origin: no store build could ever reach it`,
    );
  if (!Array.isArray(keys) || keys.length !== 2)
    problems.push(
      `the ${flavour} build pins ${Array.isArray(keys) ? keys.length : "no list of"} signing keys (scripts/rules-keys.mjs): it needs two, current and next (rules/SIGNING.md)`,
    );
  else {
    const { runnerImport } = await import("vite");
    const { module } = await runnerImport(fileURLToPath(new URL("../src/core/rules/signed.ts", import.meta.url)), {
      configFile: false,
      logLevel: "silent",
    });
    const pinned = await module.importPinned(keys);
    if (!pinned.ok) problems.push(`the ${flavour} build's signing keys (scripts/rules-keys.mjs): ${pinned.error}`);
    if (flavour === "prod")
      for (const k of keys)
        if (TEST_RULES_KEYS.some((t) => sameKey(t, k) || t.kid === k?.kid || t.spki === k?.spki))
          problems.push(`the store build pins a test key (${k.kid}): its private half is published with the tests`);
  }
  return problems;
}
