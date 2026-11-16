// The pending fill request R (AUTOFILL2 patch 1; docs/design/notes/AUTOFILL2-NOTES.md). The `fill` shortcut pressed while
// Sixkey cannot fill by itself (locked; several accounts for the site; a plain http page) writes R, then opens the popup
// (or leaves the badge for the side panel). The surface that then shows R's line on its lock screen and is unlocked there,
// by the PIN or the password typed into it, fills the page of R by the ordinary press of the Fill button (Fill.tsx), once.
//
// R lives in chrome.storage.session only (memory, trusted contexts: closed to content scripts on every Chrome version), under
// the one key spelled here. It holds no secret and no account: the tab, its window, its address and host as the browser gave
// them to the shortcut, when, the lock epoch then, and why the shortcut stopped. The worker is the only writer of a new R
// (putRequest); a surface only removes one, by the compare-and-delete in takeRequest, under webLock("sixkey-fill-req").
// The take checks, all of them inside the lock: the nonce the surface showed; at most 60 s old; the lock epoch unchanged (any
// lock voids R; an unlock does not move the epoch); R's tab is the tab in front of THE SURFACE'S OWN WINDOW, at the same full
// address (the comparator of Fill.tsx's lookAtFront and FU's `away`). A tab of a window behind the one the user is in is
// never filled by an unlock made in front (the plan review's M2).
//
// Version 2 (AUTOFILL2 patch 4a; docs/design/notes/AUTOFILL2-NOTES.md §12): the same request, written for the user's click
// on the in-page suggestion (`why: "page"`, only with the suggestion's release gate open), with one more field: the
// document the user clicked (`doc`, the browser's documentId of the top frame). A press made for it fills that document or
// nothing. A reader takes exactly v1's fields or exactly v2's, so a Sixkey older than v2 sees no request at all. All of v2
// is behind the suggestion's release gate (scripts/suggest-ui.mjs): a build with the gate closed neither writes nor reads
// it, as a Sixkey older than v2 (check-dist holds the built files to that, both ways).
import { bounded } from "./bounded";
import { webLock } from "./locks";

// The release gate, as the build's define gives it: a constant of this module, folded by the build.
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;

/**
 * The key every lock bumps (platform/session.ts LOCK_EPOCH_KEY; spelled again here so that this module, which the popup
 * loads lazily, does not pull the session module into a chunk of its own).
 */
const LOCK_EPOCH_KEY = "sk_lock_epoch";
/** The one spelling of the key (chrome.storage.session). */
export const FILL_REQ_KEY = "sk_fill_req";
/** How long R lives. */
export const REQ_MS = 60_000;

/** Why the shortcut handed over: `locked` may be filled after an unlock in the surface; the others are only offered. */
export type ReqWhy = "locked" | "choose" | "insecure";
type FillReqV1 = {
  v: 1;
  /** 128 bits, hex: the surface shows R with it and takes R only by it. */
  nonce: string;
  tabId: number;
  windowId: number;
  /** The tab's full address when the shortcut was pressed (its pin: patch 1's R has no documentId). */
  url: string;
  /** Its host name, ASCII, as the URL parser gives it: the line names it. */
  host: string;
  at: number;
  /** The lock epoch (sk_lock_epoch) when the shortcut was pressed. */
  epoch: number;
  why: ReqWhy;
};
/** The suggestion's request: v1's fields for the click, and the document clicked. It may be filled after an unlock too. */
type FillReqV2 = Omit<FillReqV1, "v" | "why"> & {
  v: 2;
  why: "page";
  /** The documentId of the top frame the user clicked in (sender.documentId): a press made for R fills it or nothing. */
  doc: string;
};
export type FillReq = FillReqV1 | FillReqV2;

const FIELDS = ["at", "epoch", "host", "nonce", "tabId", "url", "v", "why", "windowId"];
/** A documentId as Chrome gives it (32 hex digits, upper case: probed on Chromium 156, AUTOFILL2-NOTES §12). */
const DOC_RE = /^[0-9A-F]{32}$/;
const int = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** R as read back, checked down to its exact shape; anything else is no R. */
export function readRequest(raw: unknown): FillReq | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (SUGGEST_UI && r.v === 2) return readV2(r);
  if (Object.keys(r).sort().join() !== FIELDS.join()) return null;
  if (r.v !== 1 || typeof r.nonce !== "string" || !/^[0-9a-f]{32}$/.test(r.nonce)) return null;
  if (!int(r.tabId) || !int(r.windowId) || !int(r.at) || !int(r.epoch)) return null;
  if (typeof r.url !== "string" || r.url.length > 4096 || !/^https?:\/\//.test(r.url)) return null;
  if (typeof r.host !== "string" || !/^[a-z0-9.[\]:-]{1,253}$/.test(r.host)) return null;
  if (r.why !== "locked" && r.why !== "choose" && r.why !== "insecure") return null;
  return r as unknown as FillReq;
}

/**
 * v2 (the gate open only): `why: "page"`, a document ID of Chrome's shape, and the rest exactly v1's fields, held by v1's own
 * reader (so a field more or less is no request either).
 */
function readV2(r: Record<string, unknown>): FillReq | null {
  if (r.why !== "page" || typeof r.doc !== "string" || !DOC_RE.test(r.doc)) return null;
  const { doc: _doc, ...rest } = r;
  return readRequest({ ...rest, v: 1, why: "locked" }) ? (r as unknown as FillReq) : null;
}

/** The part of chrome.storage.session this needs. */
export type ReqArea = Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;
const lock = webLock("sixkey-fill-req");
// AF-BOUND (AUTOFILL2-NOTES.md §13.10): every await of a storage call or a tab query on R's path is bounded (./bounded.ts,
// STORE_MS). `sixkey-fill-req` is shared by the worker, the popup and the side panel: an answer lost inside it would hold
// every context's Fill. A lost one fails that operation (no R written, R not taken, no line), and the lock is let go.

/** R as stored now (or null), read with its bound. */
export const storedRequest = async (area: ReqArea): Promise<FillReq | null> =>
  readRequest((await bounded(area.get(FILL_REQ_KEY)))[FILL_REQ_KEY]);

/**
 * The worker's write, for a shortcut that stopped at `why`, or (v2) for the user's click on the in-page suggestion (`doc`):
 * a new R (a new nonce) in place of any other. Called BEFORE the surface is opened, so a popup that opens finds it (and an
 * open one sees it change).
 */
export function putRequest(
  area: ReqArea,
  o:
    | { tabId: number; windowId: number; url: string; epoch: number; why: ReqWhy }
    | { tabId: number; windowId: number; url: string; epoch: number; why: "page"; doc: string },
  now: number = Date.now(),
): Promise<FillReq | null> {
  let host: string;
  try {
    host = new URL(o.url).hostname;
  } catch {
    return Promise.resolve(null);
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const r = readRequest(
    // v2 only with the suggestion's gate open (its one writer, the worker's `open`, exists only then)
    SUGGEST_UI && o.why === "page"
      ? {
          v: 2,
          nonce: [...b].map((x) => x.toString(16).padStart(2, "0")).join(""),
          tabId: o.tabId,
          windowId: o.windowId,
          url: o.url,
          host,
          at: now,
          epoch: o.epoch,
          why: o.why,
          doc: o.doc,
        }
      : {
          v: 1,
          nonce: [...b].map((x) => x.toString(16).padStart(2, "0")).join(""),
          tabId: o.tabId,
          windowId: o.windowId,
          url: o.url,
          host,
          at: now,
          epoch: o.epoch,
          why: o.why,
        },
  );
  if (!r) return Promise.resolve(null);
  return lock(async () => {
    await bounded(area.set({ [FILL_REQ_KEY]: r }));
    return r;
  });
}

/** What the take, and the lock screen's line, need to know about here and now. */
export type Here = {
  now(): number;
  /** The lock epoch now (sk_lock_epoch). */
  epoch(): Promise<number>;
  /** The tab in front of this surface's own window (tabs.query({active: true, currentWindow: true})). */
  front(): Promise<{ id?: number; url?: string } | undefined>;
};
/** Why R is not for here: another tab in front, another address, too old, a lock since, or no such R. */
export type NotHere = "tab" | "page" | "old" | "lock" | "gone";

/** Whether R is for this surface now (everything the take checks but the nonce). */
export async function forHere(r: FillReq, here: Here): Promise<NotHere | null> {
  const age = here.now() - r.at;
  if (age < 0 || age > REQ_MS) return "old";
  if ((await bounded(here.epoch())) !== r.epoch) return "lock";
  const front = await bounded(here.front());
  if (front?.id !== r.tabId) return "tab";
  if (front.url !== r.url) return "page";
  return null;
}

/** R, if there is one that is for here now (the lock screen's line), else null. Reads; never writes. */
export async function peekRequest(area: ReqArea, here: Here): Promise<FillReq | null> {
  const r = await storedRequest(area);
  return r && !(await forHere(r, here)) ? r : null;
}

/**
 * The compare-and-delete: R if it is still the one with `nonce` and for here now, removed in the same critical section, so
 * one R fills at most once and only where it was shown. Else why not (R is left as it is: another surface may still be
 * the one it is for).
 */
export function takeRequest(
  area: ReqArea,
  nonce: string,
  here: Here,
): Promise<{ ok: true; r: FillReq } | { ok: false; why: NotHere }> {
  return lock(async () => {
    const r = await storedRequest(area);
    if (!r || r.nonce !== nonce) return { ok: false as const, why: "gone" as const };
    const not = await forHere(r, here);
    if (not) return { ok: false as const, why: not };
    await bounded(area.remove(FILL_REQ_KEY));
    return { ok: true as const, r };
  });
}

/** A change of R or of the lock epoch, for a surface that shows R (storage.session's onChanged). */
export const requestChanged = (changes: Record<string, unknown>): boolean =>
  FILL_REQ_KEY in changes || LOCK_EPOCH_KEY in changes;

/** Where R is: chrome.storage.session (for a surface; undefined where there is none). */
export const requestArea = (): ReqArea | undefined => globalThis.chrome?.storage?.session;
/** A surface's watch on R and on the lock epoch (storage.session's onChanged); returns its removal. */
export function watchRequest(f: () => void): () => void {
  const area = globalThis.chrome?.storage?.session;
  const changed = (c: Record<string, unknown>) => requestChanged(c) && f();
  area?.onChanged.addListener(changed);
  return () => area?.onChanged.removeListener(changed);
}

/** Here and now for a surface (the popup, the side panel): the clock, the lock epoch as stored, the front tab of its window. */
export function hereNow(area: ReqArea): Here {
  return {
    now: () => Date.now(),
    epoch: async () => {
      const v = (await area.get(LOCK_EPOCH_KEY))[LOCK_EPOCH_KEY];
      return typeof v === "number" ? v : 0;
    },
    front: async () => (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0],
  };
}
