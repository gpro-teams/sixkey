// "Export selected accounts" (SYNC-DESIGN §9.1 H2, review H-d; PHASE0X-PLAN C6): a backup of only the accounts the user
// picked, for a profile that others use or a fingerprint-browser vendor syncs to its cloud. Whoever gets the file must get
// those accounts and nothing else of the vault: not another account's secret, name, group or sites, not the trash, not
// the vault's ids or edit history, nothing that ties it to this device or to another file exported from the same vault.
//
// The file is an ordinary `sixkey-backup` v1 (backup.ts) with its own password, chosen for the file: no new format and
// no new field (SYNC-DESIGN budget rule), so any version that reads backups reads it. It opens where every backup opens:
//   - Restore, in a profile with no vault: through the first-run wizard, which prepares keys for the file's vault id.
//   - Import, into a vault that exists: the vault id is never that vault's, so the accounts are added as new entries,
//     skipping any already there with the same key, issuer and account name (VaultService.importBackup). A file exported
//     again later therefore adds only what is new; an account renamed since comes in as a second entry (H-d).
//
// The decrypted vault holds exactly this:
//   schemaVersion  1
//   vaultId        new and random on every export (newVaultId), never the source's. With the source's id a restored
//                  profile would hold "the same vault under another key", the case SYNC-DESIGN I6/§3.5 leaves open, and
//                  Import would merge by entry id instead of adding.
//   entries        one per selected id that is alive in the vault given (isAlive: in the trash or erased is not, and
//                  ids that match nothing are ignored), sorted by id as every vault is. Each holds only:
//     id                 new and random, a UUID like the ones addEntry makes, so it looks like any other entry
//     createdAt          the export time
//     type, issuer, label, secret, algorithm, digits, period   the account itself: what the codes need
//     counter            HOTP only, where the counter stands (a counter left on a TOTP entry is dropped)
//     group, domains, note   only if set on that account: the user put it there. A group name appears only as the group of
//                        a selected account, so the names of other groups never do
//     hlc, phlc          stamps of a clock made for this export: the export time, a counter, and a new random device id
//                        (not one of the vault's), so no edit time and no device of the source comes along
//     order              new keys, spread evenly, in the order the accounts are listed now
//   and never deleted or dhlc. Nothing is copied by spreading a source entry: contentOf names every field taken.
// The envelope around it (backup.ts): format, v, created (the export time), app ("sixkey"), kdf (new salt), iv, ciphertext.
//
// What still links two files exported from the same vault: the accounts they both hold (that is their content), that
// each was made at its export time, and roughly their size: the ciphertext is not padded, so two files of the same
// selection have the same length (a full backup is no different). Ids, device id and salt are new each time. The export
// time is kept as it is: it is when the file was made, which the file's own header (created) says anyway. A subset file
// can be told from a full backup once opened (every createdAt and stamp is the export time) and by its default name
// (sixkey-selected-<date>.json); its order keys and stamp counters follow the list order the accounts had.
//
// Every profile restored from one subset file gets that file's vault id (Restore keeps it). A full backup of one such
// profile imported into another is then merged, not added. Harmless before sync; a note for M2 (C6-REVIEW C6-8).
import { randomBytes, type Random } from "../crypto/bytes";
import { newVaultId } from "../crypto/keyring";
import { createClock, newDeviceId, parseHlc } from "../vault/hlc";
import { aliveEntries, emptyVault, type Entry, type Vault } from "../vault/model";
import { addEntry, rebalance, type NewEntry } from "../vault/ops";
import { deserializeVault, serializeVault } from "../vault/validate";
import { createBackup, type BackupFile } from "./backup";

export type SubsetOptions = { now?: () => number; rng?: Random };

/** What a subset copies of an account, field by field: the allowlist. Adding a field to Entry adds nothing here. */
function contentOf(e: Entry): NewEntry {
  return {
    type: e.type,
    issuer: e.issuer,
    label: e.label,
    secret: e.secret,
    algorithm: e.algorithm,
    digits: e.digits,
    period: e.period,
    ...(e.type === "hotp" && e.counter !== undefined ? { counter: e.counter } : {}),
    ...(e.group ? { group: e.group } : {}),
    ...(e.domains && e.domains.length > 0 ? { domains: [...e.domains] } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

/** A random version 4 UUID from `rng`, in the form crypto.randomUUID() gives addEntry. */
function uuid(rng: Random): string {
  const b = Uint8Array.from(rng(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A value not in `taken` (then added to it). A repeat is drawn again; a random source that keeps repeating is broken. */
function unused(draw: () => string, taken: Set<string>): string {
  for (let i = 0; i < 8; i++) {
    const v = draw();
    if (!taken.has(v)) {
      taken.add(v);
      return v;
    }
  }
  throw new Error("the random source keeps repeating itself");
}

/** The live entries of `vault` that a subset of `ids` would hold, in list order. For the page's count and preview. */
export function selectedEntries(vault: Vault, ids: Iterable<string>): Entry[] {
  const want = new Set(ids);
  return aliveEntries(vault).filter((e) => want.has(e.id));
}

/**
 * Whether `now` (the same accounts read again) still shows what `shown` showed: every one still there and alive, with the
 * same name, account, group and sites. The settings page checks this before it saves a file, so the file never holds an
 * account, a name, a group or a site the page did not show (C6-REVIEW C6-2). The list order does not count.
 */
export function sameAsShown(shown: readonly Entry[], now: readonly Entry[]): boolean {
  if (shown.length !== now.length) return false;
  const byId = new Map(now.map((e) => [e.id, e]));
  const sites = (e: Entry) => (e.domains ?? []).join("\n");
  return shown.every((e) => {
    const n = byId.get(e.id);
    return (
      !!n &&
      n.issuer === e.issuer &&
      n.label === e.label &&
      (n.group ?? "") === (e.group ?? "") &&
      sites(n) === sites(e)
    );
  });
}

/**
 * The vault a subset file holds (see the top of this file for exactly what is in it). Throws if none of `ids` is a live
 * entry: an empty file is never what the user meant. The result is read back through deserializeVault, so it is what an
 * import will see, and anything an import would refuse fails here instead.
 */
export function buildSubsetVault(vault: Vault, ids: Iterable<string>, opts: SubsetOptions = {}): Vault {
  const rng = opts.rng ?? randomBytes;
  const at = (opts.now ?? Date.now)();
  const now = () => at;
  const chosen = selectedEntries(vault, ids);
  if (chosen.length === 0) throw new RangeError("no live account selected");

  const devices = new Set<string>();
  for (const e of vault.entries)
    for (const h of [e.hlc, e.phlc, e.dhlc]) {
      const d = h ? parseHlc(h)?.device : undefined;
      if (d) devices.add(d);
    }
  const clock = createClock(
    unused(() => newDeviceId(rng), devices),
    { now },
  );
  const taken = new Set(vault.entries.map((e) => e.id)); // no new id is any id of the source, even a tombstone's

  let sub = emptyVault(unused(() => newVaultId(rng), new Set([vault.vaultId])));
  for (const e of chosen) sub = addEntry(sub, contentOf(e), clock, { id: unused(() => uuid(rng), taken), now }).vault;
  sub = rebalance(sub, clock); // fresh, evenly spread order keys: their length says nothing about how the list was edited
  return deserializeVault(serializeVault(sub));
}

/** The subset as a backup file under `password` (the file's own, not the master password), made at one instant. */
export async function createSubsetBackup(
  vault: Vault,
  ids: Iterable<string>,
  password: string,
  opts: SubsetOptions = {},
): Promise<{ file: BackupFile; count: number }> {
  const at = (opts.now ?? Date.now)();
  const o = { now: () => at, ...(opts.rng ? { rng: opts.rng } : {}) };
  const sub = buildSubsetVault(vault, ids, o);
  return { file: await createBackup(sub, password, o), count: sub.entries.length };
}
