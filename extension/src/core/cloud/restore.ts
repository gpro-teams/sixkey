// Restoring from the cloud backup (CLOUDBK; CLOUD-BACKUP.md §3.6). A restore asks for the secret once and opens every
// file it can, newest first, so nothing written by any device is lost and nobody has to choose a file.
//   - Keys: each distinct wrap the secret fits is tried once, however many files share it; then every file whose vault
//     key is already in hand opens with it, though its own wrap does not fit the secret (a fork made before a password
//     change, a recovery-only file and a password: review r2 CB-06). The PBKDF2 work of one restore is bounded
//     (MAX_RESTORE_ITERATIONS): a file past it is skipped as "limit" (CB-09).
//   - Data, by vault (CB-02): the files of each vault are merged with mergeVaults, the merge sync uses (commutative and
//     idempotent; deletions win by their own clocks, so no fork brings back an account deleted in another). The newest
//     file's vault is the base; each other vault, merged first, then adds its live accounts as new entries, skipping those
//     already there, as importBackup does. Every file is clamped first (clampVault), as any vault from outside.
//   - The vault key (review r3, R2-03): within the base vault, the newest key, the one whose keyrings hold the newest
//     wrap by createdAt, not the key of the file Drive changed last: with sync off a computer that did not rotate the key
//     may write last, and a restore must not go back to the key a rotation retired. A key that any opened file of the
//     vault names as retired (its `retired` ids, review r3 S4) is never chosen while another is there, whatever its
//     wraps' dates: a computer that kept the old key and changed its password after the rotation dates its wraps later.
//     `olderKeys` counts the base vault's other keys among the files opened (their data is merged all the same).
//   - The keyring (CB-03, R2-04): that key's, with, for each method, the newest wrap (by its createdAt) among the opened
//     files under it, so a restore never brings back a recovery key that another computer replaced. A password restore
//     stays one step and keeps the password wrap the typed password opened, so a wrong clock elsewhere can never lock the
//     user out; when a password wrap dated later exists, `outdated` says so, and the page offers a new master password
//     right then (patch 5), which the user may skip. A recovery-key restore keeps the recovery wrap and, when the copy
//     has one, the newest master-password wrap too (`keepsPassword`): the person goes on with the same master password
//     as their other computers, or sets a new one if they forgot it; only a copy with no password wrap at all must set
//     one (`needsPassword`). (Until 2026-11-18 it kept the recovery wrap alone and always asked for a new master
//     password, so one vault ended with a different master password on each computer.)
//     createdAt is not authenticated and comes from each computer's clock: a clock far ahead, or someone who controls the
//     Google account and holds an old secret, can make an old wrap look new. Neither can lock the user out of a password
//     restore; such a person already holds what that secret opened, and a new vault key is the cure (§1.5).
// The secret's own mistakes (an empty password, a recovery key of the wrong length or with a typo the check bits catch)
// are thrown as they are, for the page to say so; a secret that is well formed but opens nothing gives null.
import { CryptoError } from "../crypto/bytes";
import { decryptVault } from "../crypto/envelope";
import { openWithPassword, unlockWithRecoveryCode, type Keyring, type WrappedKey } from "../crypto/keyring";
import { passwordCandidates } from "../crypto/password-candidates";
import type { Vk } from "../crypto/vk";
import { createClock } from "../vault/hlc";
import { canonicalJson, mergeVaults } from "../vault/merge";
import type { Vault } from "../vault/model";
import { addAccountsFrom, clampVault, observeVault } from "../vault/ops";
import { VaultError, deserializeVault } from "../vault/validate";
import type { CloudBackup } from "./format";

export type CloudSecret = { password: string } | { recoveryKey: string };

/** A file as listed and parsed: its Drive id, the head revision listed, when it was last changed. */
export type CloudCandidate = { id: string; head: string; modified: number; backup: CloudBackup };

export type SkippedFile = {
  id: string;
  /** "secret": this secret does not open it and no key in hand does; "damaged": its keys open but its data does not (or
   *  is not this vault's); "newer": a later Sixkey's vault schema; "limit": past this restore's PBKDF2 budget. */
  why: "secret" | "damaged" | "newer" | "limit";
};

export type CloudRestore = {
  /** Every file opened, merged. */
  vault: Vault;
  /** The newest key's keyring, with the wraps chosen above, and no earlier keys. */
  keyring: Keyring;
  vk: Vk;
  /** The newest file opened under that key: the restored device continues it (rules.ts adoptLink). */
  base: CloudCandidate;
  /** How many other vault keys of the base vault the files opened were under (a computer that did not rotate). */
  olderKeys: number;
  /** The ids of the files in the vault, newest first. */
  merged: string[];
  skipped: SkippedFile[];
  /** A wrap of the typed secret's method dated later than the one it opened exists (changed on another computer). */
  outdated: boolean;
  /** A recovery-key restore whose copy had no password wrap: a new master password must be set next. */
  needsPassword: boolean;
  /** A recovery-key restore that kept the copy's master-password wrap: the same master password goes on, or a new one. */
  keepsPassword: boolean;
  /** A password restore: the spelling that opened the kept wrap (openWithPassword; PASSWORD-SETUP-NOTES §7). */
  password?: string;
};

/** The most PBKDF2 iterations one restore spends: twenty derivations at today's count (CB-09). */
export const MAX_RESTORE_ITERATIONS = 40_000_000;

/** Newest first: by Drive's modification time, then by the save time inside, then by id (a total order). */
export function newestFirst(a: CloudCandidate, b: CloudCandidate): number {
  return (
    b.modified - a.modified ||
    b.backup.generation.savedAt - a.backup.generation.savedAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

type Opened = { vk: Vk; password?: string } | null;
const methodOf = (secret: CloudSecret) => ("password" in secret ? "password" : "recovery");
/** A key naming a wrap, with the ids its additional data binds. */
const wrapKey = (keyring: Keyring, wrap: WrappedKey) => canonicalJson([keyring.vaultId, keyring.vkId, wrap]);

/** The PBKDF2 iterations this secret costs on this wrap (a generated-shape password may be tried twice). */
function costOf(wrap: WrappedKey, secret: CloudSecret): number {
  if (!("password" in secret) || wrap.kdf?.name !== "PBKDF2") return 0;
  return wrap.kdf.iterations * passwordCandidates(secret.password).length;
}

async function openKeyring(keyring: Keyring, secret: CloudSecret): Promise<Opened> {
  try {
    if ("password" in secret) {
      const r = await openWithPassword(keyring, secret.password);
      return { vk: r.vk, password: r.password };
    }
    return { vk: await unlockWithRecoveryCode(keyring, secret.recoveryKey) };
  } catch (e) {
    if (e instanceof CryptoError && e.code === "unwrap_failed") return null;
    throw e; // the secret's own mistake (empty, malformed): for the page to say so
  }
}

async function openVault(b: CloudBackup, vk: Vk): Promise<Vault | "damaged" | "newer"> {
  const env = b.generation.envelope;
  try {
    const vault = deserializeVault(await decryptVault(env, vk));
    return vault.vaultId === env.vaultId ? vault : "damaged";
  } catch (e) {
    return e instanceof VaultError && e.code === "newer_schema" ? "newer" : "damaged";
  }
}

type Held = { wrap: WrappedKey; keyring: Keyring };

/** For each method, the newest wrap (by createdAt; a tie goes to the newer file) among these keyrings, newest first. */
function newestWraps(keyrings: readonly Keyring[]): Map<string, Held> {
  const best = new Map<string, Held>();
  for (const keyring of keyrings)
    for (const wrap of keyring.wraps) {
      const had = best.get(wrap.method);
      if (!had || wrap.createdAt > had.wrap.createdAt) best.set(wrap.method, { wrap, keyring });
    }
  return best;
}

/**
 * The newest key of these files (one vault): the one with the newest wrap by createdAt, a tie going to the newer file;
 * a key some file names as retired only when every key is (S4).
 */
function newestKey(files: readonly CloudBackup[]): string {
  const retired = new Set(files.flatMap((b) => b.retired));
  const live = files.filter((b) => !retired.has(b.generation.keyring.vkId));
  const from = live.length ? live : files;
  let best = from[0]!.generation.keyring.vkId;
  let at = -Infinity;
  for (const b of from)
    for (const w of b.generation.keyring.wraps)
      if (w.createdAt > at) {
        at = w.createdAt;
        best = b.generation.keyring.vkId;
      }
  return best;
}

/**
 * Every candidate the secret opens, merged; null when it opens none. `now` clamps the files' timestamps; `device` is
 * this install's device id, for the entries the added mode makes; `budget` (tests) replaces MAX_RESTORE_ITERATIONS.
 */
export async function openCloudBackups(
  candidates: readonly CloudCandidate[],
  secret: CloudSecret,
  opts: { now: number; device: string; budget?: number },
): Promise<CloudRestore | null> {
  const sorted = [...candidates].sort(newestFirst);
  const method = methodOf(secret);
  // 1. keys: each distinct wrap that fits the secret, once, within the budget
  const byWrap = new Map<string, Opened>();
  const byVk = new Map<string, Vk>();
  const overBudget = new Set<string>();
  let budget = opts.budget ?? MAX_RESTORE_ITERATIONS;
  for (const c of sorted) {
    const keyring = c.backup.generation.keyring;
    const wrap = keyring.wraps.find((w) => w.method === method);
    if (!wrap) continue;
    const key = wrapKey(keyring, wrap);
    if (byWrap.has(key)) continue;
    const cost = costOf(wrap, secret);
    if (cost > budget) {
      overBudget.add(c.id);
      continue;
    }
    budget -= cost;
    const opened = await openKeyring(keyring, secret);
    byWrap.set(key, opened);
    if (opened) byVk.set(opened.vk.id, opened.vk);
  }
  // 2. data: every file whose vault key is in hand, whether or not its own wrap fit
  const opened: { c: CloudCandidate; vault: Vault }[] = [];
  const skipped: SkippedFile[] = [];
  for (const c of sorted) {
    const vk = byVk.get(c.backup.generation.keyring.vkId);
    if (!vk) {
      skipped.push({ id: c.id, why: overBudget.has(c.id) ? "limit" : "secret" });
      continue;
    }
    const vault = await openVault(c.backup, vk);
    if (typeof vault === "string") skipped.push({ id: c.id, why: vault });
    else opened.push({ c, vault });
  }
  const first = opened[0];
  if (!first) return null;
  const baseVault = first.vault.vaultId;
  // 3. the vault: each vault's files merged; the newest file's vault is the base, the others add their live accounts
  const groups = new Map<string, Vault>();
  for (const o of opened) {
    const v = clampVault(o.vault, opts.now);
    const had = groups.get(v.vaultId);
    groups.set(v.vaultId, had ? mergeVaults(had, v) : v);
  }
  const clock = createClock(opts.device, { now: () => opts.now });
  let vault = groups.get(baseVault)!;
  observeVault(clock, vault);
  for (const [id, other] of groups) {
    if (id === baseVault) continue;
    observeVault(clock, other);
    vault = addAccountsFrom(vault, other, clock, "all").vault;
  }
  // 4. the key: the base vault's newest (R2-03); the keyring: its wraps as above (CB-03, R2-04)
  const inVault = opened.filter((o) => o.vault.vaultId === baseVault);
  const vkId = newestKey(inVault.map((o) => o.c.backup));
  const baseFile = inVault.find((o) => o.c.backup.generation.keyring.vkId === vkId)!.c;
  const base = baseFile.backup.generation.keyring;
  const keyrings = inVault.map((o) => o.c.backup.generation.keyring).filter((k) => k.vkId === vkId);
  const best = newestWraps(keyrings);
  // the wraps of the secret's method that it opened, the newest of them first
  const opens = (h: Held) => byWrap.get(wrapKey(h.keyring, h.wrap)) ?? null;
  const fittedWraps = keyrings
    .flatMap((keyring) => keyring.wraps.filter((w) => w.method === method).map((wrap) => ({ wrap, keyring })))
    .filter((h) => opens(h) !== null)
    .sort((x, y) => y.wrap.createdAt - x.wrap.createdAt);
  const typed = fittedWraps[0] ?? best.get(method);
  const outdated = !typed || (best.get(method)?.wrap.createdAt ?? -Infinity) > typed.wrap.createdAt || !opens(typed);
  // after a password restore, the password the user typed, never one dated later (R2-04)
  const kept = method === "recovery" ? [best.get("password"), best.get("recovery")] : [typed, best.get("recovery")];
  const keepsPassword = method === "recovery" && best.get("password") !== undefined;
  const keyring: Keyring = {
    ...base,
    wraps: kept.filter((h): h is Held => h !== undefined).map((h) => h.wrap),
    previous: [],
  };
  const spelling = typed ? opens(typed)?.password : undefined;
  return {
    vault,
    keyring,
    vk: byVk.get(vkId)!,
    base: baseFile,
    olderKeys: new Set(inVault.map((o) => o.c.backup.generation.keyring.vkId)).size - 1,
    merged: opened.map((o) => o.c.id),
    skipped,
    outdated,
    needsPassword: method === "recovery" && !keepsPassword,
    keepsPassword,
    ...(method === "password" && spelling !== undefined ? { password: spelling } : {}),
  };
}
