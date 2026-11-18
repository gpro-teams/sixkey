import { createMutex, type Lock } from "../core/storage/kv";

/** One critical section at a time across the popup, options page and service worker. Falls back to a per-context mutex. */
export function webLock(name: string): Lock {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return createMutex();
  return <T>(fn: () => Promise<T>) => locks.request(name, { mode: "exclusive" }, fn) as Promise<T>;
}
