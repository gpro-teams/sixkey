// The in-page suggestion's decisions (TOTP autofill Stage 2, patch 4b; docs/design/notes/AUTOFILL2-NOTES.md §13), pure, so
// that each rule of TOTP-AUTOFILL §4.5 as revised by the patch 4 plan (r3) has a unit test and a mutant of its own. Bundled
// into inject/suggest.js only with the release gate open (scripts/suggest-ui.mjs; ./suggest-ui.ts is the one importer).
//
//   - when the suggestion is armed: IntersectionObserver v2 has said "visible, all of it" (isVisible, ratio 1) for ARM_MS
//     without a break, and nothing has since moved it or put a page top-layer element over its place (§4.5 item 3, S-7),
//     and its frames have kept coming: a page that holds its rendering (a long task, a view transition's update) leaves a
//     frozen picture on the screen, which need not be what is there, and IntersectionObserver reports nothing meanwhile;
//   - its size: a page's `zoom` (or a transform) cannot shrink it to an unreadable speck: drawn at FULL of its designed
//     size, both ways (M-5, R2-S3);
//   - a click: accepted only when trusted, armed, at full size, not covered by what IntersectionObserver has seen but not
//     yet reported, and, from a pointer, after a trusted pointerdown on the same button with Sixkey's host the first
//     element at the pointer (§4.5 item 4). A click from the keyboard or a screen reader (`detail` 0) has no pointer to
//     test: armed is enough (the button can never hold the focus, so a page cannot turn a key into it: §3.6);
//   - the worker's answer to `cand`: exactly `{show: true, key}` or `{show: false}`.

/** §4.5 item 3: how long the suggestion must have been seen, all of it, before a click counts. */
export const ARM_MS = 800;
/** The longest pause between two of its frames that still counts as drawn all along (above: the clock starts again). */
export const GAP_MS = 250;
/**
 * How long the content script waits for the worker's answer to `cand` (AUTOFILL2-NOTES.md §13.8, the 4b review's S-1).
 * After it, a reply counts as none and is not kept: the next look asks again. Longer than the worker's own deadline
 * (platform/content-page.ts CAND_MS), so a worker that gave up has given up first. Timestamps, not a timer: the content
 * script has none (check-dist).
 */
export const ASK_MS = 20_000;
/** Shown this long without the user's own click or key press, it is hidden, and its frames stop (S-2). The next look shows it again. */
export const IDLE_MS = 120_000;
/** A click refused as too early or on a held page says so in the button itself, this long (S-3: warn, do not block). */
export const CUE_MS = 3000;
/** Its designed height (the stylesheet's), and the least part of its designed size it must be drawn at (R2-S3). */
export const PILL_PX = 32;
export const FULL = 0.8;

/** The worker's answer to `cand`, held to its exact shape; anything else is no answer. */
export type Answer = { show: true; key: string } | { show: false };
export function readAnswer(a: unknown): Answer | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const r = a as Record<string, unknown>;
  const keys = Object.keys(r).sort().join();
  if (r.show === false && keys === "show") return { show: false };
  if (r.show === true && keys === "key,show" && typeof r.key === "string" && r.key.length <= 64)
    return { show: true, key: r.key };
  return null;
}

/**
 * The arming clock. `seen`: what IntersectionObserver v2 reported; `restart`: a move, or a page top-layer change near it;
 * `frame`: one of its own animation frames (a pause longer than GAP_MS between two restarts the clock).
 */
export function arming(now: () => number) {
  let since = -1; // when it was last seen whole, without a break since; -1: not seen whole now
  let last = -Infinity; // its last frame
  return {
    seen(whole: boolean, at = now()): void {
      since = whole ? (since < 0 ? at : since) : -1;
    },
    restart(at = now()): void {
      if (since >= 0) since = at;
    },
    frame(at = now()): void {
      if (at - last > GAP_MS && since >= 0) since = at;
      last = at;
    },
    /** Its frames are coming: none missed for longer than GAP_MS up to now. */
    fresh: (at = now()): boolean => at - last <= GAP_MS,
    visible: (): boolean => since >= 0,
    armed: (at = now()): boolean => since >= 0 && at - since >= ARM_MS,
  };
}

/** Drawn at full size: its effective zoom, and its rendered height against the designed one. */
export const fullSize = (zoom: number, height: number): boolean => zoom >= FULL && height >= PILL_PX * FULL;

/** What a click on the suggestion found. */
export type Click = {
  /** The browser marks the click as the user's. */
  trusted: boolean;
  /** 0: from the keyboard or a screen reader (no pointer); more: from a pointer. */
  detail: number;
  /** The suggestion was used already in this document (one open per document). */
  used: boolean;
  /** IntersectionObserver has a record not reported yet that says it is covered or cut (takeRecords). */
  pendingHidden: boolean;
  visible: boolean;
  armed: boolean;
  /** Its frames are coming, and no view transition holds the page: what is on the screen is what is there. */
  fresh: boolean;
  fullSize: boolean;
  /** A trusted pointerdown went down on this same button, and was the last press on it. */
  downHere: boolean;
  /** Sixkey's host is the first element at the pointer (elementsFromPoint). */
  topIsHost: boolean;
};
export type Verdict = "open" | "used" | "untrusted" | "hidden" | "small" | "early" | "stale" | "nopd" | "hit";

/** The decision on a click, in the order of its reasons. */
export function judge(c: Click): Verdict {
  if (c.used) return "used";
  if (!c.trusted) return "untrusted";
  if (c.pendingHidden || !c.visible) return "hidden";
  if (!c.fullSize) return "small";
  if (!c.armed) return "early";
  if (!c.fresh) return "stale";
  if (c.detail > 0 && !c.downHere) return "nopd";
  if (c.detail > 0 && !c.topIsHost) return "hit";
  return "open";
}

/** Two rectangles meet, neither empty (a page top-layer element toggled over the suggestion's place restarts its clock: S-7). */
export type Box = { left: number; top: number; right: number; bottom: number };
export const meet = (a: Box, b: Box): boolean =>
  a.left < a.right &&
  a.top < a.bottom &&
  b.left < b.right &&
  b.top < b.bottom &&
  a.left < b.right &&
  b.left < a.right &&
  a.top < b.bottom &&
  b.top < a.bottom;

/** Where the suggestion goes: under the box (over it when there is no room), at its start edge, inside the viewport. */
export function place(
  box: Box,
  pill: { width: number; height: number },
  view: { width: number; height: number },
  rtl: boolean,
): { left: number; top: number } {
  const gap = 4;
  const margin = 8;
  const below = box.bottom + gap;
  const top = below + pill.height + margin <= view.height ? below : Math.max(margin, box.top - gap - pill.height);
  const start = rtl ? box.right - pill.width : box.left;
  const left = Math.min(Math.max(margin, start), Math.max(margin, view.width - margin - pill.width));
  return { left: Math.round(left), top: Math.round(top) };
}
