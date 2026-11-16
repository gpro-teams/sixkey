// One browser call bounded (AF-BOUND, docs/design/notes/AUTOFILL2-NOTES.md §13.10; first in platform/page-open.ts, 4B-FU):
// its answer, or, after `ms`, a failure of the operation that waited for it. Used for every storage call made inside a
// lock that other contexts share (`sixkey-fill-req`, `sixkey-af-open`), and for the reads the shortcut and the popup make
// before one, so that an answer the browser loses ends that operation instead of holding the lock, or the press, forever.

/**
 * How long one such call may take. A storage call answers in about a millisecond; on a machine at a load average of 600
 * to 800 (§13.8's runs) single browser calls took up to 0.6 s, so one that takes 5 s was lost, not slow.
 */
export const STORE_MS = 5000;

/** `call`'s answer, or a failure after `ms` (its timer cleared either way). */
export function bounded<T>(call: Promise<T>, ms: number = STORE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error("unanswered")), ms)));
  return Promise.race([call, lost]).finally(() => clearTimeout(timer));
}
