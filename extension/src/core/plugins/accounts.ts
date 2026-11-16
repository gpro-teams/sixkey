// P1, `accounts.read`, of the removed plugin platform (its type is all protocol.ts still takes from here): what a
// plugin that holds it may see of the user's accounts, and the handles it sees them by. Pure, apart from WebCrypto; who
// may ask, and when, was protocol.ts's and the click's, which went with the platform.
//   - What a summary holds (`#/$defs/accountSummary`): the handle, the issuer and the label, the type, the digits, the
//     period, the group and the sites (at most 16 host names). Never the secret, the algorithm, the counter, a code, a
//     time, the order, the vault's own IDs, or anything else of the entry: the summary is built field by field, never
//     copied from it.
//   - Which accounts: the live ones (not in the trash, not erased), in the order of their handles, so the list tells
//     nothing of the user's order or of when an account was added.
//   - Handles (§6.3): per plugin and opaque, the lowercase RFC 4648 base32, unpadded, of the first 10 bytes of
//     HMAC-SHA256(K_h, utf8(pluginId) ‖ 0x00 ‖ utf8(entryId)). K_h = HKDF-SHA256(the vault key, salt empty, info
//     "sixkey/v1/plugin-handles", 32): derived while unlocked and never stored (wave 2a; the draft's random key in
//     storage.local would have needed a write, a lock and a binding to the vault, for the same properties). A handle
//     survives a rename, and changes with the vault key: a new vault, or a key change.
//   - Text from the vault is made well-formed (a lone surrogate becomes U+FFFD) and cut to the schema's lengths, so
//     Sixkey's own message is one a plugin's JSON parser and the SDK can keep (§2.3 item 1).
import { aliveEntries, type Entry, type Vault } from "../vault/model";
import { toWellFormed } from "./text";

/** The HKDF label of K_h. Local only: not a sync label (src/core/sync/crypto/labels.ts has those). */
export const HANDLE_LABEL = "sixkey/v1/plugin-handles";

/** `#/$defs/accountSummary`. */
export type AccountSummary = {
  handle: string;
  issuer: string;
  label: string;
  type: "totp" | "hotp";
  digits: 6 | 8;
  period: number;
  group: string | null;
  sites: string[];
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** `#/$defs/host`: lowercase ASCII, at least two labels (a site Sixkey's own rules wrote; anything else is left out). */
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** K_h, from the vault key this context holds (never stored, never exported). */
export async function handleKey(vkRaw: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", vkRaw as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(HANDLE_LABEL) as BufferSource },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** RFC 4648 base32, lowercase, unpadded (10 bytes give exactly 16 letters). */
function base32(b: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** A plugin's handle for one account (§6.3): `#/$defs/handle`, 16 letters of a–z and 2–7. */
export async function handleOf(key: CryptoKey, pluginId: string, entryId: string): Promise<string> {
  const msg = new Uint8Array([...utf8(pluginId), 0, ...utf8(entryId)]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg as BufferSource));
  return base32(mac.subarray(0, 10));
}

/** Text from the vault as a summary carries it: well-formed, at most `max` characters. */
const cut = (s: string, max: number) => Array.from(toWellFormed(s)).slice(0, max).join("");

/** One account's summary, field by field (nothing of the entry is copied whole). */
export function summaryOf(e: Entry, handle: string): AccountSummary {
  const group = e.group ? cut(e.group, 64) : "";
  return {
    handle,
    issuer: cut(e.issuer, 256),
    label: cut(e.label, 256),
    type: e.type === "hotp" ? "hotp" : "totp",
    digits: e.digits === 8 ? 8 : 6,
    period: Number.isSafeInteger(e.period) && e.period >= 1 && e.period <= 86_400 ? e.period : 30,
    group: group || null,
    sites: [...new Set((e.domains ?? []).filter((d) => HOST.test(d)))].slice(0, 16),
  };
}

/** `accounts.list`'s answer for `pluginId` (`#/$defs/accountsListResult`): the live accounts, ordered by handle. */
export async function accountsFor(vault: Vault, pluginId: string, key: CryptoKey): Promise<AccountSummary[]> {
  const out: AccountSummary[] = [];
  for (const e of aliveEntries(vault).slice(0, 5000)) out.push(summaryOf(e, await handleOf(key, pluginId, e.id)));
  return out.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
}
