// What the backup's status line says (CLOUDBK; CLOUD-BACKUP.md §6.2), worked out from what the worker records. Sixkey
// speaks up (the popup's pill and footer) only when the backup has stopped or has been failing for long with changes
// waiting; a passing failure is shown on the settings card only, and the worker retries it.
// The backup in Chrome's sync storage (CSB; slots.ts) keeps the same record and the same lines, with errors of its own
// and its own stopping set (csbStatus). The Google Drive backup's errors, its stopping set and cloudStatus went with
// that path's code.

/** Why the last write did not happen. */
export type CloudError =
  | "too_large" // Chrome sync: the vault alone over its room (slots.ts)
  | "no_room" // Chrome sync: the copy fits alone, not beside the other copies there (slots.ts room)
  | "held" // Chrome sync: this computer's data may be older than its copy there (slots.ts rules 3, 7): merge first
  | "busy" // Chrome sync: a write-operation quota (MAX_WRITE_OPERATIONS_PER_MINUTE, _PER_HOUR)
  | "other" // Chrome sync: any other refusal
  | "no_password" // the keyring opens with a device key (never uploaded)
  | "unreadable"; // the local vault could not be read

/** What the worker keeps about its uploads (storage.local, patch 4). Times are ms since the epoch. */
export type CloudRecord = {
  lastOk: number | null;
  /** The last error, cleared by the next success; `errSince` is when it first happened in this run of errors. */
  err: CloudError | null;
  errSince: number | null;
  /** The first save not yet uploaded, cleared by a success; null when the file has everything. */
  pendingSince: number | null;
};

export type CloudStatus<S extends CloudError = CsbStoppingError> =
  | { kind: "off" }
  | { kind: "ok"; at: number }
  | { kind: "waiting"; at: number | null } // changes not uploaded yet, no error (or never uploaded at all)
  | { kind: "failed"; err: CloudError; at: number | null } // a passing failure: shown on the card, retried
  | { kind: "stale"; err: CloudError | null; since: number } // changes waiting for STALE_AFTER_MS or more
  | { kind: "stopped"; err: S }; // nothing happens until the user acts

export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The backup in Chrome sync's errors that no retry fixes: the vault alone is too large for the area ("too_large", the
 * room of slots.ts) or does not fit beside the other copies (the user frees room or merges them), its copy there may
 * be newer (a page merges it), there is no master password, or the vault is damaged. The worker waits for the user,
 * and for its daily check, which also finds room that others freed. The others ("busy", "other") are retried.
 */
export type CsbStoppingError = "too_large" | "no_room" | "held" | "no_password" | "unreadable";
/** The errors the backup in Chrome sync records. */
export type CsbError = CsbStoppingError | "busy" | "other";

const CSB_STOPPING: readonly CloudError[] = ["too_large", "no_room", "held", "no_password", "unreadable"];
/** Whether no retry fixes this error of the backup in Chrome sync. */
export const csbStops = (e: CloudError | null): e is CsbStoppingError => e !== null && CSB_STOPPING.includes(e);

/** The status of the backup in Chrome sync: the status lines above, with csbStops for the stopping set. */
export function csbStatus(on: boolean, r: CloudRecord, now: number): CloudStatus<CsbStoppingError> {
  if (!on) return { kind: "off" };
  if (csbStops(r.err)) return { kind: "stopped", err: r.err };
  if (r.pendingSince !== null && now - r.pendingSince >= STALE_AFTER_MS)
    return { kind: "stale", err: r.err, since: r.pendingSince };
  if (r.err !== null) return { kind: "failed", err: r.err, at: r.lastOk };
  if (r.pendingSince !== null || r.lastOk === null) return { kind: "waiting", at: r.lastOk };
  return { kind: "ok", at: r.lastOk };
}
