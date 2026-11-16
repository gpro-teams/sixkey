// The pure part of the content script (src/inject/suggest.ts, which bundles it: one classic script, no exports, so no global
// of its own; the unit tests import this module). What makes a user event a reason to look, and what makes a look a reason
// to tell the worker (AUTOFILL2-PLAN §4.3; docs/design/notes/AUTOFILL2-NOTES.md §9).
export type Seen = {
  c: { t: string; k: 0 | 1; n: number; s: number; weak: boolean }[];
  z: 0 | 1;
};
export type Finder = { inspect(): Seen | null; of(el: unknown): string | null };

/** The least score the finder must give the box the user is in (its own threshold is 40: AUTOFILL2-PLAN §4.3). */
const MIN_SCORE = 60;
/** How often this document may be looked at, at most (AUTOFILL2-PLAN §4.3). */
const LOOK_MS = 2000;

/** Whether a box the finder found has room for a 6- or 8-digit code: a group of 6 or 8 boxes, or a box taking 6 or more. */
export const roomy = (f: { k: 0 | 1; n: number }) => (f.k === 1 ? f.n === 6 || f.n === 8 : f.n === 0 || f.n >= 6);

/** The input a user event is about, if a code could be typed into it: a text-like type, editable, with a size on screen. */
export function boxOf(e: {
  isTrusted: boolean;
  target: unknown;
  composedPath?: () => unknown[];
}): HTMLInputElement | null {
  if (!e.isTrusted) return null; // only the user's own click or key press: never a page's focus() or its own events
  const el = e.composedPath?.()[0] ?? e.target; // a box in an open shadow root, not its host
  if (!(el instanceof HTMLInputElement)) return null;
  if (!["text", "tel", "number", "password", ""].includes(el.type) || el.readOnly || el.disabled) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** Whether the finder's look names `el` as a code box worth telling the worker about. */
export function qualifies(finder: Finder, el: HTMLInputElement): boolean {
  const seen = finder.inspect();
  if (!seen || seen.z) return false;
  const t = finder.of(el);
  return t !== null && seen.c.some((f) => f.t === t && f.s >= MIN_SCORE && !f.weak && roomy(f));
}

/** The listener's state, per document: when it last looked, and the address it sent for. */
export function watcher(
  finder: () => Finder | undefined,
  send: () => void,
  now: () => number = () => performance.now(),
) {
  let looked = -Infinity;
  let sentFor: string | null = null;
  return (e: Parameters<typeof boxOf>[0], href: string): void => {
    const el = boxOf(e);
    if (!el) return;
    const page = href.split("#")[0]!;
    if (sentFor === page) return; // once per page address
    const f = finder();
    if (!f || now() - looked < LOOK_MS) return;
    looked = now();
    if (!qualifies(f, el)) return;
    sentFor = page;
    send();
  };
}
