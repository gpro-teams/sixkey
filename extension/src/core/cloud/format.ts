// The cloud backup's file (CLOUDBK; docs/design/proposals/CLOUD-BACKUP.md §1.2): the vault exactly as it is on disk, one
// generation's envelope and keyring, in a small versioned container. It is made from what the store reads with no key
// (VaultStore.load), so the service worker can make it while Sixkey is locked, and it opens with the master password or
// the recovery key, as the copy on this computer does.
//
// What goes in, field by field. Every field is copied by name, never by spreading what was read, so nothing that sits
// beside these on disk, now or in a later version, can ride along:
//   - the generation's v, seq and savedAt;
//   - the envelope: format, formatVersion, cipher, vaultId, vkId, rev, iv, ciphertext, checksum;
//   - the keyring: format, v, vaultId, vkId, the password and recovery wraps (method, vkId, kdf, iv, wrapped, createdAt;
//     the kdf as name, hash, iterations, salt, v), and an empty `previous`. The earlier vault keys the current one wraps
//     are left out (review r2 CB-13): a restore never needs them (the envelope is always under the current key), and they
//     would hand whoever opens this file the keys to older copies that their own wraps no longer open;
//   - `retired`: the ids of those earlier vault keys, and nothing else of them (review r3, S4): a restore never lands on
//     a key that another file of the vault names as retired.
// What never goes in: the PIN's records (sk_pin, sk_pin_restart: a 4-digit PIN falls in seconds offline), Touch ID and
// Windows Hello (sk_prf), plugin grants, settings, the security record, the diagnostics log, snapshots and the mirror.
// None of them is part of a generation, and a generation is all this module is given. A keyring that a device key opens
// (a `device` wrap, or a `deviceKey`) is refused: that file would open with no secret at all.
//
// `opens: "recovery"` is the card's switch "只用恢复密钥打开" (option c): the password wrap is left out, so this file holds
// nothing to guess; only the 128-bit recovery key opens it. Copies made before the switch are another matter: Sixkey
// deletes its own superseded versions and files after each upload (rules.ts), but a copy someone already downloaded
// stays as it was, and only a new vault key ("更换加密密钥") makes it useless for what is uploaded next (CLOUD-BACKUP.md §1.5).
//
// The parser is strict: the exact set of fields at every level, the wrap methods and their KDFs, `opens` matching the
// wraps, then the store's own checks (shape, checksum, key and data agreeing). A file of a later version is "newer",
// never "invalid", so a later Sixkey's file is named as such, not as damaged.
import { checkGeneration, type Generation } from "../storage/format";
import type { EncryptedVault } from "../crypto/envelope";
import { PBKDF2_MAX_ITERATIONS, PBKDF2_MIN_ITERATIONS, type KdfParams } from "../crypto/kdf";
import type { Keyring, WrappedKey } from "../crypto/keyring";

export const CLOUD_FORMAT = "sixkey-cloud-backup";
export const CLOUD_VERSION = 1;
/**
 * The largest file text read: an envelope as large as sync allows (MAX_ENVELOPE_BYTES, 8 MiB, SYNC-DESIGN §4.3) with its
 * keyring and container, as UTF-8.
 */
export const MAX_CLOUD_FILE_BYTES = 9 * 1024 * 1024;

export type CloudOpens = "both" | "recovery";

export type CloudBackup = {
  format: typeof CLOUD_FORMAT;
  v: typeof CLOUD_VERSION;
  /** The Sixkey that wrote it ("Sixkey 0.2.0"), informational, at most 40 characters. */
  app: string;
  /** Which secrets open it: the master password or the recovery key ("both"), or the recovery key only. */
  opens: CloudOpens;
  /** The ids (only) of the vault keys this file's key replaced, from the keyring's `previous` (S4). */
  retired: string[];
  generation: Generation;
};

export class CloudBackupError extends Error {
  constructor(
    readonly code:
      | "device_key" // the keyring opens with a device key: never uploaded
      | "no_wrap" // nothing would open the file (no password or recovery wrap for what `opens` asks)
      | "damaged" // the generation does not pass the store's checks
      | "invalid_file" // not a cloud backup of this version's shape
      | "newer_format", // a later Sixkey wrote it
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CloudBackupError";
  }
}

const ENVELOPE_FIELDS = ["format", "formatVersion", "cipher", "vaultId", "vkId", "rev", "iv", "ciphertext", "checksum"];
const KEYRING_FIELDS = ["format", "v", "vaultId", "vkId", "wraps", "previous"];
const WRAP_FIELDS = ["method", "vkId", "kdf", "iv", "wrapped", "createdAt"];
const PBKDF2_FIELDS = ["name", "hash", "iterations", "salt", "v"];
const HKDF_FIELDS = ["name", "hash", "salt", "v"];
const GENERATION_FIELDS = ["v", "seq", "savedAt", "envelope", "keyring"];
const CONTAINER_FIELDS = ["format", "v", "app", "opens", "retired", "generation"];
const VK_ID_RE = /^[0-9a-f]{16}$/;
/** The most retired key ids a file names (the keyring keeps at most this many earlier keys: keyring.ts). */
const MAX_RETIRED = 64;
/** The KDF each method's wrap must have: the password is stretched; the recovery key is 128 random bits. */
const KDF_OF = { password: "PBKDF2", recovery: "HKDF" } as const;
const APP_MAX = 40;

const pick = <T>(o: object, fields: readonly string[]): T =>
  Object.fromEntries(fields.map((f) => [f, (o as Record<string, unknown>)[f]])) as T;

const copyKdf = (k: KdfParams): KdfParams =>
  k.name === "PBKDF2" ? pick<KdfParams>(k, PBKDF2_FIELDS) : pick<KdfParams>(k, HKDF_FIELDS);

const copyWrap = (w: WrappedKey): WrappedKey => ({ ...pick<WrappedKey>(w, WRAP_FIELDS), kdf: copyKdf(w.kdf!) });

/**
 * The container for one generation, as `opens` says. Refuses a device-key keyring and a file nothing would open. The
 * result is parsed back before it is returned, so what is uploaded is always what a restore accepts.
 */
export async function makeCloudBackup(gen: Generation, opens: CloudOpens, app: string): Promise<CloudBackup> {
  const g = await checkGeneration(gen);
  if (!g) throw new CloudBackupError("damaged");
  const k = g.keyring;
  if (k.deviceKey !== undefined || k.wraps.some((w) => w.method === "device")) throw new CloudBackupError("device_key");
  // "both": the password wrap must be there (the recovery wrap comes too when the keyring has one); "recovery": the
  // recovery wrap alone, the password wrap left out
  const needed = opens === "both" ? "password" : "recovery";
  if (!k.wraps.some((w) => w.method === needed)) throw new CloudBackupError("no_wrap", `no ${needed} wrap`);
  const wraps = k.wraps.filter((w) => w.method === "recovery" || (opens === "both" && w.method === "password"));
  const keyring: Keyring = {
    format: k.format,
    v: k.v,
    vaultId: k.vaultId,
    vkId: k.vkId,
    wraps: wraps.map(copyWrap),
    previous: [], // never uploaded (CB-13)
  };
  const out: CloudBackup = {
    format: CLOUD_FORMAT,
    v: CLOUD_VERSION,
    app: app.slice(0, APP_MAX),
    opens,
    retired: [...new Set(k.previous.map((p) => p.vkId))].slice(-MAX_RETIRED),
    generation: {
      v: g.v,
      seq: g.seq,
      savedAt: g.savedAt,
      envelope: pick<EncryptedVault>(g.envelope, ENVELOPE_FIELDS),
      keyring,
    },
  };
  return parseCloudBackup(JSON.parse(JSON.stringify(out)));
}

/** The text that is uploaded. */
export const cloudBackupText = (b: CloudBackup): string => JSON.stringify(b);

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Exactly these fields, no more and no fewer. */
function exact(x: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (!isObject(x)) throw new CloudBackupError("invalid_file", `${what}: not an object`);
  const keys = Object.keys(x);
  if (keys.length !== fields.length || !fields.every((f) => Object.prototype.hasOwnProperty.call(x, f)))
    throw new CloudBackupError("invalid_file", `${what}: fields`);
  return x;
}

const isTime = (t: unknown): boolean => typeof t === "number" && Number.isFinite(t) && t >= 0;

/** A parsed file, or CloudBackupError: "newer_format" for a later version's, "invalid_file" or "damaged" otherwise. */
export async function parseCloudBackup(x: unknown): Promise<CloudBackup> {
  if (isObject(x) && x.format === CLOUD_FORMAT && typeof x.v === "number" && x.v > CLOUD_VERSION)
    throw new CloudBackupError("newer_format");
  const o = exact(x, CONTAINER_FIELDS, "file");
  if (o.format !== CLOUD_FORMAT || o.v !== CLOUD_VERSION) throw new CloudBackupError("invalid_file", "format");
  if (typeof o.app !== "string" || o.app.length > APP_MAX) throw new CloudBackupError("invalid_file", "app");
  if (o.opens !== "both" && o.opens !== "recovery") throw new CloudBackupError("invalid_file", "opens");
  const g = exact(o.generation, GENERATION_FIELDS, "generation");
  exact(g.envelope, ENVELOPE_FIELDS, "envelope");
  const k = exact(g.keyring, KEYRING_FIELDS, "keyring");
  if (!Array.isArray(k.wraps) || !Array.isArray(k.previous)) throw new CloudBackupError("invalid_file", "keyring");
  const methods: string[] = [];
  for (const w of k.wraps) {
    const wrap = exact(w, WRAP_FIELDS, "wrap");
    if (wrap.method !== "password" && wrap.method !== "recovery") throw new CloudBackupError("invalid_file", "method");
    if (methods.includes(wrap.method)) throw new CloudBackupError("invalid_file", "method twice");
    methods.push(wrap.method);
    const kdf = wrap.kdf;
    if (!isObject(kdf) || kdf.name !== KDF_OF[wrap.method]) throw new CloudBackupError("invalid_file", "kdf");
    exact(kdf, kdf.name === "PBKDF2" ? PBKDF2_FIELDS : HKDF_FIELDS, "kdf");
    // kdf.ts's own range, here, so a file asking for more work than any Sixkey makes is refused before anything is
    // derived (review r2 CB-09; restore.ts also bounds a restore's total)
    const it = kdf.iterations;
    if (
      kdf.name === "PBKDF2" &&
      (typeof it !== "number" || !Number.isInteger(it) || it < PBKDF2_MIN_ITERATIONS || it > PBKDF2_MAX_ITERATIONS)
    )
      throw new CloudBackupError("invalid_file", "iterations");
    if (!isTime(wrap.createdAt)) throw new CloudBackupError("invalid_file", "createdAt");
  }
  // earlier vault keys are never uploaded (CB-13): a file that carries any is not one of ours
  if (k.previous.length !== 0) throw new CloudBackupError("invalid_file", "previous");
  // "recovery": the recovery wrap and nothing else; "both": the password wrap, with or without the recovery wrap
  if (o.opens === "recovery" ? methods.join() !== "recovery" : !methods.includes("password"))
    throw new CloudBackupError("invalid_file", "the wraps are not what `opens` says");
  // the retired keys: ids only, each once, never the file's own key (S4)
  const retired = o.retired;
  if (
    !Array.isArray(retired) ||
    retired.length > MAX_RETIRED ||
    !retired.every((r) => typeof r === "string" && VK_ID_RE.test(r) && r !== k.vkId) ||
    new Set(retired).size !== retired.length
  )
    throw new CloudBackupError("invalid_file", "retired");
  // the store's own checks: the envelope's and the keyring's shapes, the checksum, the key and the data agreeing
  const checked = await checkGeneration(g);
  if (!checked) throw new CloudBackupError("damaged");
  return {
    format: CLOUD_FORMAT,
    v: CLOUD_VERSION,
    app: o.app,
    opens: o.opens,
    retired: [...(retired as string[])],
    generation: checked,
  };
}

/** The uploaded text back: at most MAX_CLOUD_FILE_BYTES, JSON, then parseCloudBackup. */
export async function parseCloudBackupText(text: string): Promise<CloudBackup> {
  if (new TextEncoder().encode(text).length > MAX_CLOUD_FILE_BYTES) throw new CloudBackupError("invalid_file", "size");
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    throw new CloudBackupError("invalid_file", "not JSON");
  }
  return parseCloudBackup(x);
}
