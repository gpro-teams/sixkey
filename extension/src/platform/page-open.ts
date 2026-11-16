// What the worker keeps for the in-page suggestion's `open` (TOTP autofill Stage 2, patch 4a; docs/design/notes/
// AUTOFILL2-NOTES.md §12), in chrome.storage.session (memory, trusted contexts only), so that a worker restart forgets
// none of it. Two records, both under one lock (webLock("sixkey-af-open")):
//   - SHOWN_KEY, the documents this worker answered `show: true` (platform/content-channel.ts): an `open` is taken only
//     from one of them, and from each at most once. An entry lives SHOWN_MS; there are at most SHOWN_MAX, the oldest go
//     first. A document that has opened stays opened: answering `show: true` to it again does not make it new;
//   - OPEN_KEY, a token bucket per tab: BUCKET opens at once, then one more each REFILL_MS. A retry after a rejected code
//     (the page reloads: a new document) passes; a sustained rate is held to two a minute.
// Each record holds IDs and times only: no address, no host, nothing of the page or the vault. A record of another shape
// (a later or earlier Sixkey) is read as empty.
//
// Every storage call inside the lock is bounded (STORE_MS; AUTOFILL2-NOTES.md §13.8, the 4b review's S-1): a call whose
// answer never comes fails its operation, and the lock is let go. Without the bound, one lost response would hold the lock
// for the rest of the worker's life, and every later `cand` and `open` would wait behind it.
import { bounded, STORE_MS } from "./bounded";
import { SHOWN_MAX, SHOWN_MS } from "./content-page";
import { webLock } from "./locks";

export const SHOWN_KEY = "sk_sug_shown";
export const OPEN_KEY = "sk_sug_open";
// how long a document answered `show: true` may still open Sixkey, and how many are kept (the channel's memory keeps the same)
export { SHOWN_MAX, SHOWN_MS };
/** Opens a tab may make at once, and how long each further one waits. */
export const BUCKET = 2;
export const REFILL_MS = 30_000;

// Each storage call inside the lock: bounded by STORE_MS (./bounded.ts, 5 s, why that long there). A read and a write: the
// lock is held 10 s at most, inside the worker's deadline on `cand` (content-page.ts CAND_MS), so it goes first.
export { STORE_MS };

/** The part of chrome.storage.session used here. */
export type OpenArea = Pick<chrome.storage.StorageArea, "get" | "set">;
let made: ReturnType<typeof webLock> | undefined;
/** The one lock of both records, made at its first use: nothing runs at import, so a build without the suggestion drops this module. */
const lock = <T>(fn: () => Promise<T>): Promise<T> => (made ??= webLock("sixkey-af-open"))(fn);

type Shown = Record<string, { at: number; o: 0 | 1 }>;
type Bucket = Record<string, { n: number; at: number }>;
const int = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function shownOf(raw: unknown): Shown {
  const out: Shown = {};
  if (!plain(raw)) return out;
  for (const [doc, v] of Object.entries(raw))
    if (plain(v) && int(v.at) && (v.o === 0 || v.o === 1) && /^[0-9A-Za-z]{1,64}$/.test(doc))
      out[doc] = { at: v.at, o: v.o };
  return out;
}
function bucketOf(raw: unknown): Bucket {
  const out: Bucket = {};
  if (!plain(raw)) return out;
  for (const [tab, v] of Object.entries(raw))
    if (plain(v) && int(v.at) && int(v.n) && v.n <= BUCKET && /^[0-9]{1,16}$/.test(tab))
      out[tab] = { n: v.n, at: v.at };
  return out;
}
/** The entries still alive at `now`, at most SHOWN_MAX of them, the newest kept. */
function pruned(s: Shown, now: number): Shown {
  const live = Object.entries(s).filter(([, v]) => v.at <= now && now - v.at < SHOWN_MS);
  live.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(live.slice(0, SHOWN_MAX));
}

/** This worker answered `show: true` to `doc`: it may open Sixkey once, within SHOWN_MS. An opened one stays opened. */
export function noteShown(area: OpenArea, doc: string, now: number = Date.now()): Promise<void> {
  return lock(async () => {
    const s = pruned(shownOf((await bounded(area.get(SHOWN_KEY)))[SHOWN_KEY]), now);
    s[doc] = { at: now, o: s[doc]?.o ?? 0 };
    await bounded(area.set({ [SHOWN_KEY]: pruned(s, now) }));
  });
}

/** Whether `doc` may open Sixkey now: answered `show: true` within SHOWN_MS and not opened yet. If so, it is opened now. */
export function takeShown(area: OpenArea, doc: string, now: number = Date.now()): Promise<boolean> {
  return lock(async () => {
    const s = pruned(shownOf((await bounded(area.get(SHOWN_KEY)))[SHOWN_KEY]), now);
    const e = s[doc];
    if (!e || e.o === 1) return false;
    s[doc] = { at: e.at, o: 1 };
    await bounded(area.set({ [SHOWN_KEY]: s }));
    return true;
  });
}

/** One token of `tabId`'s bucket, if there is one now (BUCKET at once, one more each REFILL_MS). */
export function takeToken(area: OpenArea, tabId: number, now: number = Date.now()): Promise<boolean> {
  return lock(async () => {
    const b = bucketOf((await bounded(area.get(OPEN_KEY)))[OPEN_KEY]);
    const key = String(tabId);
    const cur = b[key];
    // the tokens now: what was left, plus one per REFILL_MS since, at most BUCKET (a clock that went back refills nothing)
    const since = cur ? Math.max(0, now - cur.at) : 0;
    const n = cur ? Math.min(BUCKET, cur.n + Math.floor(since / REFILL_MS)) : BUCKET;
    if (n === 0) return false;
    // the refill's clock: from now when the bucket was full, else from the last refill counted
    const at = !cur || n === BUCKET ? now : cur.at + Math.floor(since / REFILL_MS) * REFILL_MS;
    b[key] = { n: n - 1, at };
    // tabs whose buckets are full again need no entry
    for (const [k, v] of Object.entries(b))
      if (k !== key && v.n + Math.floor(Math.max(0, now - v.at) / REFILL_MS) >= BUCKET) delete b[k];
    await bounded(area.set({ [OPEN_KEY]: b }));
    return true;
  });
}
