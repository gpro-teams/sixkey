// Opening copies of the backup (the cloud backup's file format, core/cloud/format.ts) with what was typed in one field,
// which may be the master password or the recovery key: the restore from Chrome Sync, Settings › Backup's merges, and
// "Choose file" with a downloaded copy (file.ts). Moved here from the Google Drive path's pages, which are gone.
import { openCloudBackups, type CloudCandidate, type CloudRestore } from "../../core/cloud/restore";
import { CryptoError } from "../../core/crypto/crypto-error";
import { parseRecoveryCode } from "../../core/crypto/recovery-code";

/** What a restore's one field holds: a recovery key when it reads as one (its groups and checksum), else a password. */
export const secretOf = (typed: string, isRecoveryKey: boolean) =>
  isRecoveryKey ? { recoveryKey: typed } : { password: typed };

/**
 * The copies opened with what was typed, which may be the master password or the recovery key. A recovery key's shape
 * only orders the tries and words the refusal, never rules the master password out (about 1 in 226 of Sixkey's own
 * five-word passphrases has that shape): a key whose checksum holds is tried as the recovery key first, then as the
 * master password; one whose checksum fails is tried as the master password, and if that fails too it is "typo" (a
 * mistyped recovery key, said so). Anything else is the master password.
 */
export async function openBackups(
  candidates: readonly CloudCandidate[],
  typed: string,
  o: { now: number; device: string },
): Promise<CloudRestore | null | "typo"> {
  const read = await parseRecoveryCode(typed).then(
    () => "key" as const,
    (e: unknown) =>
      e instanceof CryptoError && e.code === "recovery_checksum" ? ("typo" as const) : ("password" as const),
  );
  if (read === "key") {
    const r = await openCloudBackups(candidates, secretOf(typed, true), o);
    if (r) return r;
  }
  const r = await openCloudBackups(candidates, secretOf(typed, false), o);
  return r ?? (read === "typo" ? "typo" : null);
}

/**
 * A restore opened, as first run takes it: what it holds (restore.ts), what was typed (the restored keys' password, or
 * the recovery key), and how many copies were not used (still arriving through Chrome Sync, or not a copy this Sixkey
 * reads). `slots`: from Chrome Sync, the slots it may continue (none for a downloaded file).
 */
export type CsbOpened = { restore: CloudRestore; typed: string; partial: number; unusable: number; slots: boolean };

/** What a restore's result says, under "已恢复 N 个账户" (SetupReady): the lines that apply, as keys with their number. */
export function resultLines(o: Pick<CsbOpened, "restore" | "partial" | "unusable">): [string, number?][] {
  const out: [string, number?][] = [];
  if (o.restore.needsPassword && o.restore.outdated) out.push(["csOutdatedKey"]);
  if (o.restore.olderKeys > 0) out.push(["csOlderKeys"]);
  if (o.partial > 0) out.push(["csPartial", o.partial]);
  const secret = o.restore.skipped.filter((s) => s.why === "secret").length;
  if (secret > 0) out.push(["csOtherSecret", secret]);
  const damaged = o.restore.skipped.length - secret + o.unusable;
  if (damaged > 0) out.push(["csDamaged", damaged]);
  return out;
}
