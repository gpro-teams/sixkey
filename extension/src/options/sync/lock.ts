// A lock of Sixkey, as the Sync section sees it. What a lock protects does not wait on the page for whoever sits down next
// (the convention Backup.tsx keeps for the export password): an open flow ends at a lock, its secrets dropped, and the
// panel forgets a password it holds for a confirmation (enable.ts, join.ts, panel.ts `locked`).
//
// "A lock" is a real one: every lock, from any context (the popup's Lock, the worker's idle or screen lock, another page),
// bumps the lock epoch in chrome.storage.session (platform/session.ts), and the service then says "locked". A profile with
// nothing to lock (empty, its vault unreadable, or without a master password) can see the epoch move, but stays as it was:
// that is not a lock, and the join from the first-run wizard goes on.
import type { ServiceStatus } from "../../core/service/service";

/** The key every lock bumps (platform/session.ts EPOCH_KEY). */
export const LOCK_EPOCH_KEY = "sk_lock_epoch";

/** The part of chrome.storage.session this needs. */
export type LockArea = {
  onChanged: {
    addListener(f: (changes: Record<string, unknown>) => void): void;
    removeListener(f: (changes: Record<string, unknown>) => void): void;
  };
};

/**
 * Calls `onLock` each time Sixkey locks: the epoch moved and the service says "locked". It may be called more than once
 * for one lock (reading the status can clear a voided session, which moves the epoch again): `onLock` must not mind.
 * Returns the function that stops watching.
 */
export function watchLock(
  area: LockArea,
  status: () => Promise<Pick<ServiceStatus, "state">>,
  onLock: () => void,
): () => void {
  let stopped = false;
  const changed = (changes: Record<string, unknown>) => {
    if (!Object.hasOwn(changes, LOCK_EPOCH_KEY)) return;
    void status().then(
      (s) => {
        if (!stopped && s.state === "locked") onLock();
      },
      () => undefined,
    );
  };
  area.onChanged.addListener(changed);
  return () => {
    stopped = true;
    area.onChanged.removeListener(changed);
  };
}
