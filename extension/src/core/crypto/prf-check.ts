// sk_prf checked in full (QUICK-UNLOCK Stage 2; the record: prf-record.ts): every field of every credential, before any of
// it is used to unlock (src/core/service/device-unlock.ts), shown or changed by the settings page
// (src/core/service/device-admin.ts). Lazy chunks only: the popup's main chunk reads the record's shape alone
// (prf-record.ts parsePrfRecord), and this module imports nothing (a lazy chunk must not import the main chunk's modules:
// docs/design/notes/SHAMIR-NOTES.md §7, PRF-NOTES.md §9).
import type { PrfCred, PrfRecord } from "./prf-record";

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // keyring.ts's vault id
const HEX_RE = /^[0-9a-f]{16}$/; // a vault key id
const B64U_RE = /^[A-Za-z0-9_-]{16,1366}$/; // a credential id: 12 to 1023 bytes
const PROVIDERS = ["icloud", "google", "chrome", "windows"];
const MAX_CREDS = 10; // prf-record.ts PRF_MAX_CREDS
const isTime = (t: unknown): t is number => typeof t === "number" && Number.isSafeInteger(t) && t >= 0;
/** Standard base64 of exactly `min` bytes (`min`..`max` with a range), without decoding it. */
const b64 = (s: unknown, min: number, max = min) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return false;
  const n = (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  return n >= min && n <= max;
};

/**
 * One credential, every field: the id (base64url), the kind, the name (at most 40 code points), the synced flag, the
 * provider, the time; a PRF one with a 32-byte salt and a wrap (null, or a vault key id, a 12-byte IV and 48 bytes) and no
 * public key or MAC; a gate with an SPKI key of 64 to 2,048 bytes, ES256 or RS256, no wrap, and its MAC (a vault key id
 * and 32 bytes) or none yet (paused). Whether the MAC checks is the gate unlock's to say, with the vault key (prf.ts).
 */
export function credOk(c: Partial<PrfCred>): boolean {
  const base =
    typeof c === "object" &&
    c !== null &&
    typeof c.id === "string" &&
    B64U_RE.test(c.id) &&
    (c.kind === "platform" || c.kind === "security-key") &&
    typeof c.name === "string" &&
    [...c.name].length <= 40 &&
    typeof c.synced === "boolean" &&
    (c.provider === undefined || PROVIDERS.includes(c.provider)) &&
    isTime(c.createdAt);
  if (!base) return false;
  if (c.mode === "prf")
    return (
      b64(c.salt, 32) &&
      (c.wrap === null ||
        (typeof c.wrap === "object" &&
          c.wrap !== undefined &&
          typeof c.wrap.vkId === "string" &&
          HEX_RE.test(c.wrap.vkId) &&
          b64(c.wrap.iv, 12) &&
          b64(c.wrap.wrapped, 48))) &&
      c.publicKey === undefined &&
      c.mac === undefined
    );
  return (
    c.mode === "gate" &&
    b64(c.publicKey, 64, 2048) &&
    (c.alg === -7 || c.alg === -257) &&
    c.wrap === undefined &&
    (c.mac === undefined ||
      (typeof c.mac === "object" && c.mac !== null && HEX_RE.test(c.mac.vkId) && b64(c.mac.tag, 32)))
  );
}

/**
 * The record as the lazy side uses it: the record itself checked (its version and vault id; else "damaged"), and only its
 * usable credentials kept (every field checked by credOk, the first of any id seen twice, at most 10), with an unusable
 * time left out, and nothing it does not know (a field of an earlier draft: the session choice). `dropped`: something
 * was left out, so the next write stores the record healed (an unusable credential then leaves sk_prf for good; its
 * passkey stays in the OS). So one bad credential never hides the others, nor keeps a gate that can never open armed
 * beside the PIN for more than one master password (docs/design/notes/PRF-NOTES.md §2).
 */
export function usableRecord(x: unknown): { rec: PrfRecord; dropped: boolean } | "damaged" | null {
  if (x === undefined || x === null) return null;
  const o = x as Partial<PrfRecord>;
  if (typeof o !== "object" || o.v !== 1 || typeof o.vaultId !== "string" || !ID_RE.test(o.vaultId)) return "damaged";
  if (!Array.isArray(o.creds)) return "damaged";
  const seen = new Set<string>();
  const creds = o.creds.filter((c) => credOk(c) && !seen.has(c.id) && (seen.add(c.id), true)).slice(0, MAX_CREDS);
  const rec: PrfRecord = {
    v: 1,
    vaultId: o.vaultId,
    creds,
    ...(isTime(o.lastPasswordAt) ? { lastPasswordAt: o.lastPasswordAt } : {}),
  };
  const dropped =
    creds.length !== o.creds.length ||
    (o.lastPasswordAt !== undefined && rec.lastPasswordAt === undefined) ||
    Object.keys(o).some((k) => !["v", "vaultId", "creds", "lastPasswordAt"].includes(k));
  return { rec, dropped };
}
