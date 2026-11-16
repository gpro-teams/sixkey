// sk_pw_format: which input the master-password prompts show (docs/design/notes/PASSWORD-SETUP-NOTES.md §8). An input
// hint and nothing more: { v: 1, format, salt }, where `format` says the master password is exactly a generator spelling
// (src/core/crypto/password-candidates.ts) and `salt` is the KDF salt of the keyring's password wrap it was written
// beside. Every new password gets a new salt (keyring.ts setPassword), so a record for an earlier password (changed in
// another page, adopted from another device) simply stops applying.
//
// In chrome.storage.session only (memory; the extension's own pages and service worker), never chrome.storage.local
// (owner decision, HYPHEN review M3): on disk its presence or absence would tell someone with a copy of the profile
// which passwords are a user's own, and which of those are lower-case 5-word passphrases, a structure worth a dictionary
// attack. So nothing of it is ever persisted. It survives a lock (no lock removes it) and goes when the browser closes
// or the extension reloads; the next password unlock learns it again. Until then the prompts show the plain field, which
// takes a generated password typed loosely all the same.
//
// Never trusted: nothing decides anything on it. What opens the vault is decided by the key derivation alone, and the
// candidates do not take the hint as an input. A wrong or forged record only shows the other input, and the prompts keep
// a visible way to the plain field. Written only by the service (service.ts), after a password is set or a password
// unlock shows what the stored one is; read by the service (that unlock, and openView for the popup's lock screen) and
// the settings page (platform/runtime.ts).
import type { Keyring } from "../crypto/keyring";
import { generatedForm, type PasswordFormat } from "../crypto/password-candidates";
import type { KV } from "../storage/kv";

export const PW_FORMAT_KEY = "sk_pw_format";
export type PwFormatRecord = { v: 1; format: PasswordFormat; salt: string };

/** The PBKDF2 salt of the keyring's password wrap, or null (no password wrap). */
function saltOf(keyring: Keyring): string | null {
  const kdf = keyring.wraps.find((w) => w.method === "password")?.kdf;
  return kdf?.name === "PBKDF2" ? kdf.salt : null;
}

/**
 * The record for `password` as the stored master password of `keyring`: only when it is exactly a generator spelling
 * (a loose spelling of one is not what is stored), else null.
 */
export function formatRecord(keyring: Keyring, password: string): PwFormatRecord | null {
  const g = generatedForm(password);
  const salt = saltOf(keyring);
  if (g === null || salt === null || g.canonical !== password.normalize("NFKC")) return null;
  return { v: 1, format: g.format, salt };
}

/** What a stored record says about this keyring's password wrap: the format, or null (absent, damaged, another wrap). */
export function formatFor(raw: unknown, keyring: Keyring): PasswordFormat | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<PwFormatRecord>;
  if (r.v !== 1 || (r.format !== "gen16-v1" && r.format !== "gen5words-v1") || typeof r.salt !== "string") return null;
  return r.salt === saltOf(keyring) ? r.format : null;
}

/** The record in chrome.storage.session (the runtime passes that area as the KV; never chrome.storage.local). */
export class PwFormatStore {
  constructor(private readonly kv: KV) {}
  /** One read, unparsed (formatFor checks it). */
  async read(): Promise<unknown> {
    return (await this.kv.get([PW_FORMAT_KEY]))[PW_FORMAT_KEY];
  }
  /** The record, or none (null): a password that is not a generator spelling has no record. */
  async write(rec: PwFormatRecord | null): Promise<void> {
    if (rec) await this.kv.set({ [PW_FORMAT_KEY]: rec });
    else await this.kv.remove([PW_FORMAT_KEY]);
  }
}
