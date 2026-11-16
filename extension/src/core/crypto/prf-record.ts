// sk_prf, the device unlock's record (QUICK-UNLOCK §5.2, Stage 2; YUBIKEY-DESIGN §1.2.1 with `kind`, `mode`, `synced`):
// this browser profile's Touch ID / Windows Hello credentials, in chrome.storage.local. Pure functions over the stored
// value; no crypto and no storage here (the wrap's crypto is prf.ts, a lazy chunk; the one writer is
// src/core/service/prf-store.ts). The popup reads it with its first get (loadView's `also`), so this module is small.
//
// What each credential can open, decided once at enrolment by what the authenticator returned (never by the OS):
//   - mode "prf": the verification get() returned a PRF result (`results.first`). `wrap` is the vault key under
//     KEK = HKDF-SHA256(PRF output, ∅, "sixkey/v1/kek-prf"), AAD "sixkey-prf|1|{vaultId}|{vkId}|{credId}" (prf.ts). It
//     opens Sixkey after a browser restart too, while the master password was typed in the last 14 days (Q3). A copy of
//     the profile holds the credential id, the salt and the wrap: nothing without the authenticator and its user
//     verification. A synced passkey (BE set) is "prf" only when the user ticked the opt-in (Q2); its holder's account
//     plus a copy of the profile can then open Sixkey (`synced`, said in the list).
//   - mode "gate": no PRF result (the Chrome-profile Touch ID has none), or a synced passkey without the opt-in. It holds
//     no key material at all: only the public key, to check that an assertion really carried user verification before
//     the session quick unlock (sk_quick: the gate's half) hands over the key it parked in memory, and a MAC of it under
//     the vault key (prf.ts gateMac: checked by the lazy gate unlock), so a credential planted in the profile's storage
//     is refused. The MAC names the vault key it was made under: after a key change the gate is paused ("turn back on").
// Not vault data (store.ts hasAnyData), never mirrored, synced, backed up or exported; turning sync off keeps it.
import type { Keyring } from "./keyring";

/** At most this many credentials per profile (YUBIKEY-DESIGN §1.2.1). */
export const PRF_MAX_CREDS = 10;
/** The persistent device unlock asks for the master password this often (Q3; YUBIKEY D17). A reminder, not a control (YR-14). */
export const PRF_PASSWORD_MS = 14 * 86_400_000;
/** A lastPasswordAt this far ahead of the clock is refused too (the clock was moved back: YUBIKEY §1.2.3). */
export const PRF_AHEAD_MS = 86_400_000;

export type PrfWrap = { vkId: string; iv: string; wrapped: string };
/** A gate credential's MAC (prf.ts gateMac) and the id of the vault key it was made under. */
export type PrfMac = { vkId: string; tag: string };
export type PrfCred = {
  /** The credential id, base64url (as WebAuthn's `id`). */
  id: string;
  /** "platform": Touch ID, Windows Hello, a passkey provider. "security-key" is Stage 4's and is never used here. */
  kind: "platform" | "security-key";
  mode: "prf" | "gate";
  /** Shown in the list: at most 40 code points. */
  name: string;
  /** The BE flag at enrolment: a passkey that syncs (iCloud Keychain, Google Password Manager, a password manager). */
  synced: boolean;
  /** Where the passkey lives, from its AAGUID (what the authenticator returned), for the removal text; absent: unknown. */
  provider?: "icloud" | "google" | "chrome" | "windows";
  createdAt: number;
  /** mode "prf": the 32 random bytes this credential's PRF is evaluated at, base64. */
  salt?: string;
  /** mode "prf": the vault key under the PRF's KEK; null after a key change ("turn back on", YUBIKEY D13). */
  wrap?: PrfWrap | null;
  /** mode "gate": the SPKI public key (getPublicKey()), base64, and its algorithm: -7 ES256, -257 RS256. */
  publicKey?: string;
  alg?: -7 | -257;
  /** mode "gate": its MAC under the vault key; absent or under another key: paused until "turn back on". */
  mac?: PrfMac;
};
export type PrfRecord = {
  v: 1;
  vaultId: string;
  creds: PrfCred[];
  /** When the master password last unlocked this profile (or was typed to enrol): the 14 days count from it. */
  lastPasswordAt?: number;
};

/**
 * sk_prf's shape, as the popup's main chunk reads it: the record, null when there is none, "damaged" when it is not even
 * shaped like one. Only the types of what the lock screen, the arming and the cleanup look at are checked here; every
 * field is checked in full (lengths, encodings, names) by prf-check.ts before anything of it is used to unlock, enrolled
 * or written by the settings page, a lazy chunk (a strict parser here would cost the popup's counted bundle about 300 B:
 * docs/design/notes/PRF-NOTES.md §9). Something written past these checks (by hand, by a tool) can at worst offer a
 * button that then opens nothing.
 */
export function parsePrfRecord(x: unknown): PrfRecord | "damaged" | null {
  if (x === undefined || x === null) return null;
  const o = x as Partial<PrfRecord>;
  const ok =
    typeof o === "object" &&
    o.v === 1 &&
    typeof o.vaultId === "string" &&
    Array.isArray(o.creds) &&
    o.creds.length <= PRF_MAX_CREDS &&
    (o.lastPasswordAt === undefined || typeof o.lastPasswordAt === "number");
  return ok ? (o as PrfRecord) : "damaged"; // stored as it is
}

/** The record for this vault, as loadView read it: null when there is none, it is damaged, or it is another vault's. */
export function prfFor(raw: unknown, keyring: Pick<Keyring, "vaultId">): PrfRecord | null {
  const r = parsePrfRecord(raw);
  return r !== null && r !== "damaged" && r.vaultId === keyring.vaultId ? r : null;
}

/** Platform credentials of a mode (security keys are Stage 4's). */
const ofMode = (r: PrfRecord, mode: PrfCred["mode"]) =>
  r.creds.filter((c) => c?.kind === "platform" && c.mode === mode);

/** The PRF credentials whose wrap opens the vault key `vkId`: the ones a device unlock may ask for. */
export const prfCreds = (r: PrfRecord, vkId: string): PrfCred[] =>
  ofMode(r, "prf").filter((c) => c.wrap?.vkId === vkId && c.salt !== undefined);
/** Gate credentials with a public key (a stored string): what a gate is at all. */
const gates = (r: PrfRecord) => ofMode(r, "gate").filter((c) => typeof c.publicKey === "string");
/** Credentials that need "turn back on": a PRF wrap or a gate's MAC nulled by a key change, absent, or under another key. */
export const pausedCreds = (r: PrfRecord, vkId: string): PrfCred[] => [
  ...ofMode(r, "prf").filter((c) => c.wrap?.vkId !== vkId),
  ...gates(r).filter((c) => c.mac?.vkId !== vkId),
];
/** The gate credentials of the vault key `vkId` (their MAC names it): the ones a gate unlock may ask for. */
export const gateCreds = (r: PrfRecord, vkId: string): PrfCred[] => gates(r).filter((c) => c.mac?.vkId === vkId);
/** A gate credential of this key is enrolled: the master password arms the gate, beside the PIN when there is one. */
export const hasGate = (r: PrfRecord, vkId: string): boolean => gateCreds(r, vkId).length > 0;

/**
 * The 14 days (Q3), enforced by the service's PRF unlock and shown by the lock screen: the master password was typed
 * within the last 14 days (exactly 14 still counts) and not more than a day "in the future" (a clock moved back). The
 * PIN after a restart counts its own time by this very rule (pin-restart.ts restartState; OWNER-DECISIONS/20).
 */
export const passwordRecent = (r: Pick<PrfRecord, "lastPasswordAt">, now: number): boolean =>
  r.lastPasswordAt !== undefined && now - r.lastPasswordAt <= PRF_PASSWORD_MS && r.lastPasswordAt - now <= PRF_AHEAD_MS;
