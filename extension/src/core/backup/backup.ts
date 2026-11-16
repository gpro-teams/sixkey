// Encrypted backup file. It stands alone: its own password, its own KDF parameters, no link to the device key or keyring,
// so a backup never carries key material that opens anything else.
import { CryptoError, bs, fromB64, randomBytes, toB64, utf8, type Random } from "../crypto/bytes";
import { checkPasswordPolicy } from "../crypto/password-policy";
import { assertKdfParams, deriveKekFromPassword, newPbkdf2Params, type Pbkdf2Params } from "../crypto/kdf";
import { passwordCandidates } from "../crypto/password-candidates";
import type { Vault } from "../vault/model";
import { VaultError, deserializeVault, serializeVault } from "../vault/validate";

export type BackupFile = {
  format: "sixkey-backup";
  v: 1;
  created: number;
  app: string;
  kdf: Pbkdf2Params;
  iv: string;
  ciphertext: string;
};

export class BackupError extends Error {
  constructor(
    readonly code: "invalid_file" | "newer_format" | "wrong_password_or_damaged" | "weak_password",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BackupError";
  }
}

const aad = (created: number, kdf: Pbkdf2Params) =>
  utf8(`sixkey-backup|1|${created}|PBKDF2-SHA256:${kdf.iterations}:${kdf.salt}`);

export async function createBackup(
  vault: Vault,
  password: string,
  opts: { now?: () => number; rng?: Random; app?: string; iterations?: number } = {},
): Promise<BackupFile> {
  if (!checkPasswordPolicy(password).ok) throw new BackupError("weak_password");
  const rng = opts.rng ?? randomBytes;
  const created = (opts.now ?? Date.now)();
  const kdf = newPbkdf2Params(rng, opts.iterations);
  const key = await deriveKekFromPassword(password, kdf);
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(aad(created, kdf)), tagLength: 128 },
      key,
      bs(serializeVault(vault)),
    ),
  );
  return {
    format: "sixkey-backup",
    v: 1,
    created,
    app: opts.app ?? "sixkey",
    kdf,
    iv: toB64(iv),
    ciphertext: toB64(ct),
  };
}

export function parseBackupFile(x: unknown): BackupFile {
  const bad = (m: string): never => {
    throw new BackupError("invalid_file", m);
  };
  if (typeof x !== "object" || x === null) return bad("not an object");
  const o = x as Record<string, unknown>;
  if (o.format !== "sixkey-backup") return bad("not a Sixkey backup");
  if (typeof o.v === "number" && o.v > 1) throw new BackupError("newer_format");
  if (o.v !== 1 || typeof o.created !== "number" || !Number.isFinite(o.created)) return bad("fields");
  try {
    assertKdfParams(o.kdf);
    if ((o.kdf as { name: string }).name !== "PBKDF2") return bad("kdf");
    if (typeof o.iv !== "string" || fromB64(o.iv).length !== 12) return bad("iv");
    if (typeof o.ciphertext !== "string" || fromB64(o.ciphertext).length < 16) return bad("ciphertext");
  } catch (e) {
    if (e instanceof BackupError) throw e;
    return bad("fields");
  }
  return {
    format: "sixkey-backup",
    v: 1,
    created: o.created,
    app: typeof o.app === "string" ? o.app.slice(0, 40) : "",
    kdf: o.kdf as Pbkdf2Params,
    iv: o.iv as string,
    ciphertext: o.ciphertext as string,
  };
}

/**
 * The file's password as typed or, once, the generator's spelling of it (src/core/crypto/password-candidates.ts: only for
 * a typed string of a generated shape, so at most two key derivations). The file format has no room for a hint and gets
 * none: a file is opened by its password alone (docs/design/notes/PASSWORD-SETUP-NOTES.md §7).
 */
export async function openBackup(file: unknown, password: string): Promise<{ vault: Vault; created: number }> {
  const f = parseBackupFile(file);
  let plain: Uint8Array | null = null;
  for (const candidate of passwordCandidates(password)) {
    try {
      const key = await deriveKekFromPassword(candidate, f.kdf);
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bs(fromB64(f.iv)), additionalData: bs(aad(f.created, f.kdf)), tagLength: 128 },
          key,
          bs(fromB64(f.ciphertext)),
        ),
      );
      break;
    } catch (e) {
      if (e instanceof CryptoError && e.code === "empty_password") break; // nothing typed (it has no second spelling)
    }
  }
  // a wrong password, an empty one and a damaged file are one answer, as before
  if (plain === null) throw new BackupError("wrong_password_or_damaged");
  try {
    return { vault: deserializeVault(plain), created: f.created };
  } catch (e) {
    if (e instanceof VaultError && e.code === "newer_schema") throw new BackupError("newer_format");
    throw new BackupError("wrong_password_or_damaged");
  }
}
