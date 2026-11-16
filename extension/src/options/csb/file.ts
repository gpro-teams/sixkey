// "Choose file" with a downloaded cloud backup (CLOUDBK patch 5; CLOUD-BACKUP.md §3.6, last paragraph): a file in the
// cloud format (format.ts sixkey-cloud-backup), as the retired Google Drive backup wrote it or as one kept on a USB
// stick, opened here with the master password or the recovery key, as a restore from Chrome Sync opens its copies
// (open.ts, restore.ts), only with nothing behind it to continue. In every build. (Moved here from options/cloud/ when
// the Google Drive path's code went.)
import { parseCloudBackup } from "../../core/cloud/format";
import type { CloudRestore } from "../../core/cloud/restore";
import { openBackups } from "./open";

/** The file opened with what was typed; null when that does not open it, "typo" for a recovery key mistyped (open.ts).
 *  Throws when it is not a valid cloud backup. */
export async function openCloudFile(
  json: unknown,
  typed: string,
  device: string,
): Promise<CloudRestore | null | "typo"> {
  const backup = await parseCloudBackup(json);
  const now = Date.now();
  return openBackups([{ id: "file", head: "file", modified: now, backup }], typed, { now, device });
}
