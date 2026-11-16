// §0.0i item 16 (M2R-4, Q3): the keys M2's commitKeys may write, as capabilities only M1 issues. An adoption verdict
// (evaluateSameVkBundle's or unlockWithSync's `adopt`) and a publish confirmation (presend.ts published()) are frozen and
// registered here with what they carry, like VerifiedServerBundle (F-09): a hand-built or copied object carries nothing,
// so R2 ("never on needs_new_password") and R3's checks hold by construction, and within one JS context (M1-19).
// Only bundle-eval.ts and presend.ts call issue() (test/unit/m2-source-rules.test.ts checks it). What a capability carries
// is M1's own copy, deep-frozen, taken when it was issued: changing the objects passed to M1 afterwards changes nothing
// (RR-2), and `base`, the local keyring M1 judged, binds it to that state (RR-1: commitKeys refuses it over any other).
import type { Keyring } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import type { KeyBundle } from "./keybundle";

/**
 * Why the keyring a commit writes stays openable by a secret the user holds (item 16's lock-out guard). commitKeys checks
 * the first two again inside its transact, against what is stored then.
 *   - same_password_wrap: R2, only the recovery wrap changed elsewhere; the bundle's password wrap is the local one, byte
 *     for byte;
 *   - adopted_back: GM2-5, the bundle is the one this device itself last committed (its digest is the identity's
 *     adopted.digest), after a local commit was lost. It counts as "built here": this device committed this very keyring,
 *     after its own guard, and nothing typed now could prove more;
 *   - opened: R3, R6 and the cloud restore, the secret the user typed opened bundle.keyring to this VK;
 *   - built_here: a publish (published()): the secret the keyring was built with opens it.
 */
export type CommitBasis = "same_password_wrap" | "adopted_back" | "opened" | "built_here";

/**
 * What a capability carries: the bundle, its VK, old VKs to hold for the cleanup, maxSeenKver once committed, and `base`:
 * the local keyring M1 judged it against (null when there was none: the cloud restore).
 */
export type KeysToCommit = Readonly<{
  bundle: KeyBundle;
  vk: Vk;
  held: readonly Vk[];
  maxSeenKver: number;
  basis: CommitBasis;
  base: Keyring | null;
}>;

const ISSUED = new WeakMap<object, KeysToCommit>();

/** A structured clone of `x`, frozen all the way down. */
function frozenCopy<X>(x: X): X {
  const freeze = (v: unknown): void => {
    if (typeof v !== "object" || v === null || Object.isFrozen(v)) return;
    Object.freeze(v);
    for (const w of Object.values(v)) freeze(w);
  };
  const c = structuredClone(x);
  freeze(c);
  return c;
}
/** A copy of a VK: its bytes are its own (a typed array cannot be frozen). */
const vkCopy = (v: Vk): Vk => Object.freeze({ raw: v.raw.slice(), id: v.id });

/** M1 only: `token` (the verdict object returned to the caller) frozen and registered as carrying a copy of `keys`. */
export function issue<T extends object>(token: T, keys: KeysToCommit): Readonly<T> {
  const t = Object.freeze(token);
  ISSUED.set(
    t,
    Object.freeze({
      bundle: frozenCopy(keys.bundle),
      vk: vkCopy(keys.vk),
      held: Object.freeze(keys.held.map(vkCopy)),
      maxSeenKver: keys.maxSeenKver,
      basis: keys.basis,
      base: keys.base ? frozenCopy(keys.base) : null,
    }),
  );
  return t;
}

/** The keys an M1 capability carries; null for anything M1 did not issue in this context. */
export function keysOf(token: unknown): KeysToCommit | null {
  return typeof token === "object" && token !== null ? (ISSUED.get(token) ?? null) : null;
}
