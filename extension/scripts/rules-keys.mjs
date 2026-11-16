// The keys whose signatures a build accepts on the site rules' live bundles (TOTP autofill Stage 3, AF3-U1;
// docs/design/notes/AUTOFILL3-NOTES.md §9; rules/SIGNING.md, the steps to make and keep them). The one place they are
// written down, as STORE_ID is in store-id.mjs. Only a build whose updater's gate is open (scripts/rules-update.mjs) uses
// them: scripts/build.mjs carries them into the worker's updater as this list writes them (a define, AF3-U2), and nothing
// in the extension's src/ imports this module (it reads node:crypto).
//
// Each key is {kid, spki}: its SubjectPublicKeyInfo (DER) in base64, and its key id, the hex of the first 16 bytes of the
// SHA-256 of that SPKI (`node rules/tools/sign.mjs kid --public <file>` prints both). Two keys, in order: `current`, which
// signs the bundles, then `next`, kept sealed apart and used only to take over from `current` (when it is lost or stolen,
// or at a planned change). A client that accepts a bundle signed by `next` retires `current` for good (signed.ts).
//
// The store list moves forward only, and only at a release: a release's list is the previous release's, [its second key,
// a new key], or, to recover from a lost or stolen `next`, two new keys; never one key twice, and never a key that an
// earlier release pinned and a later one dropped (keyOrderProblem). A test holds it to the last release's list
// (`store`) and to every key a release has pinned (`ever`), both in test/fixtures/rules-keys/released.json, which each
// release updates (test/unit/rules-update-gate.test.ts).
// It is empty until the two keys are made (the plan's Q1, AF3-U3); a prod build with the gate open refuses to build
// without exactly two (rules-update.mjs updaterProblems).
//
// The dev and e2e builds pin two test keys instead, whose private halves are published with the tests
// (test/fixtures/rules-keys/test-only-*.pem), so the tests can sign bundles; check-dist refuses them in a store build.
import { createPublicKey } from "node:crypto";

export const STORE_RULES_KEYS = [];

/** TEST ONLY: the public halves of test/fixtures/rules-keys/test-only-current.pem and test-only-next.pem. */
export const TEST_RULES_KEYS = [
  {
    kid: "a76b29053630095d7c1f6c53053a11e7",
    spki: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKAG8EqJFHpeLb4evo8NCfRKLyGNFgZs99jZh1qdgNuR6O9Z4O9tLiaPt++67BS7tEq1jfDFblKPhZsnU2tq/7A==",
  },
  {
    kid: "074e6ac6c2a8b4e38356cd0567250a41",
    spki: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcbierMhKLrGzFJBlKwxaLhfKhK2Cc+eofHgOIrYMjr4KSBABrIi4YzpgZVB4HgvxAEJ/h/xPowcRqxT9sc+g8Q==",
  },
];

/** The keys a build flavour ("prod", "dev", "e2e") pins, in order. */
export const rulesKeysOf = (flavour) => (flavour === "prod" ? STORE_RULES_KEYS : TEST_RULES_KEYS);

/**
 * A key's point, x‖y in hex, whatever form its SPKI is written in (compressed or not), or null when `spki` is no P-256
 * public key. The keys of the lists below are compared by it (the AF3-U1 review's S2): one key, one identity.
 */
export function pointOf(k) {
  try {
    const jwk = createPublicKey({ key: Buffer.from(k.spki, "base64"), format: "der", type: "spki" }).export({
      format: "jwk",
    });
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") return null;
    return Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("hex");
  } catch {
    return null;
  }
}
/** Whether two entries are one key: the same point, or (for entries that are no key) the same kid and spki. */
export function sameKey(a, b) {
  const p = pointOf(a);
  return (p !== null && p === pointOf(b)) || (a?.kid === b?.kid && a?.spki === b?.spki);
}
/** Whether `k` is in `list`: the same key, or an entry with its kid or its spki. */
const inList = (k, list) => list.some((p) => sameKey(p, k) || p?.kid === k?.kid || p?.spki === k?.spki);
const named = (k) => (typeof k?.kid === "string" ? k.kid : JSON.stringify(k));

/**
 * Why `next`, a release's list, may not follow `previous`, the last release's, given `ever`, every key a release has
 * pinned (test/fixtures/rules-keys/released.json); null when it may. Keys are compared as keys (pointOf), whatever
 * their SPKI's spelling. Never the same key twice; never a key back that an earlier release pinned and the last one did
 * not (a client forgets a retired key once no release pins it, so it must never come back: the review's S3). Then the
 * list may stay as it was, or, when the previous one was empty, take its first keys. Otherwise it is two keys, and
 * either moves forward one step (its first key is the previous list's second, its second a new key: a planned change, or
 * `current` lost or stolen), or is two new keys (`next` lost or stolen, or both keys: the maintainers' C32). Anything
 * else is refused: a key moved back in the order, the previous first key kept, the list emptied.
 */
export function keyOrderProblem(previous, next, ever = []) {
  if (!Array.isArray(previous) || !Array.isArray(next) || !Array.isArray(ever)) return "a list of keys is not a list";
  for (const [i, k] of next.entries())
    if (next.slice(i + 1).some((o) => sameKey(k, o))) return `the same key twice: ${named(k)}`;
  for (const k of next)
    if (!inList(k, previous) && inList(k, ever))
      return `${named(k)} was pinned by an earlier release and dropped since: a key never comes back`;
  if (previous.length === next.length && previous.every((k, i) => sameKey(k, next[i]))) return null;
  if (previous.length === 0) return null;
  if (next.length !== 2)
    return `a changed list is two keys, not ${next.length} (to stop updates, close the gate and keep the list)`;
  if (!inList(next[0], previous) && !inList(next[1], previous)) return null;
  if (!sameKey(next[0], previous[1]))
    return `the first key must be the previous list's second (${named(previous[1])}), not ${named(next[0])}, or both keys new`;
  if (inList(next[1], previous)) return `the second key must be new: ${named(next[1])} was in the previous list`;
  return null;
}
