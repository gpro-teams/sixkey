import { createMutex, type Lock } from "../core/storage/kv";

/** A lock that is taken only when free (the sync engine's TryLock, core/sync/engine/deps.ts, structurally). */
export type TryLock = <T>(fn: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;

/** One critical section at a time across the popup, options page and service worker. Falls back to a per-context mutex. */
export function webLock(name: string): Lock {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return createMutex();
  return <T>(fn: () => Promise<T>) => locks.request(name, { mode: "exclusive" }, fn) as Promise<T>;
}

/**
 * The same lock, taken only if it is free at once (Web Locks ifAvailable): `{ ran: false }` when another context holds
 * it, and `fn` does not run. For webLock("sixkey-sync") (SYNC-DESIGN §4.2, §4.9 D10): a round that finds another round
 * running asks for a rerun instead of waiting. Without Web Locks, a per-context flag does the same.
 */
export function tryWebLock(name: string): TryLock {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) {
    let busy = false;
    return async <T>(fn: () => Promise<T>) => {
      if (busy) return { ran: false as const };
      busy = true;
      try {
        return { ran: true as const, value: await fn() };
      } finally {
        busy = false;
      }
    };
  }
  return <T>(fn: () => Promise<T>) =>
    locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock): Promise<{ ran: true; value: T } | { ran: false }> =>
        lock ? { ran: true, value: await fn() } : { ran: false },
    ) as unknown as Promise<{ ran: true; value: T } | { ran: false }>;
}
