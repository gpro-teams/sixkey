// The Fill chunk's binding to a page's fill request (R v2, the user's click on the in-page suggestion; AUTOFILL2 patch 4a,
// docs/design/notes/AUTOFILL2-NOTES.md §12). Fill.tsx uses it only with the suggestion's release gate open: a build with the
// gate closed calls none of it, and has none of it (no work at import).
//
// An offered page R binds the next Fill press here (Fill.tsx press): R taken, then that document filled, its top frame, or
// nothing. The binding goes with its request:
//   - when R is removed or replaced, its minute is over, a lock comes, or (the side panel) another tab comes in front;
//   - not when only the page under it changed (an address of the same tab): the first press then says that the page
//     changed and fills nothing, and the next is an ordinary one (the review's S-2).
import type { Cand } from "../../platform/autofill";
import { forHere, hereNow, REQ_MS, requestArea, storedRequest, type FillReq } from "../../platform/fill-request";
import { INPUT_DELAY_MS, pageDelay, startPageDelay, surfaceStart } from "../page-delay";
import { surface } from "../surface";

type Offer = { nonce: string; host: string; at: number; doc: string };
let offer: Offer | null = null;
let poke: () => void = () => undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;

/** Fill.tsx's redraw, called whenever the binding or the surface's input delay changes; starts the delay's clock. */
export function connect(redraw: () => void): void {
  startPageDelay(); // App started it with the document; a later start only makes it stricter
  poke = redraw;
  pageDelay.subscribe(redraw);
}

/** Its request's minute is not over at `now`. */
const live = (o: Offer, now: number = Date.now()) => now < o.at + REQ_MS;

/** The request the next press is bound to, if any: a binding whose request's minute is over is dropped here, timer or not. */
export function current(): Offer | null {
  if (offer && !live(offer)) drop();
  return offer;
}

/** The binding dropped (used by a press, or its request gone). */
export function drop(): void {
  if (!offer) return;
  offer = null;
  clearTimeout(expiry);
  poke();
}

/**
 * A page's request offered here: the next press is bound to it. If it came to a surface already open (the side panel),
 * the input delay starts again. Returns whether the focus may move to Fill: not while the user is busy in this surface (a
 * key or a click within the delay: the review's M-2).
 */
export function bind(r: Extract<FillReq, { v: 2 }>): boolean {
  offer = { nonce: r.nonce, host: r.host, at: r.at, doc: r.doc };
  if (r.at > surfaceStart()) pageDelay.rearm();
  clearTimeout(expiry);
  expiry = setTimeout(() => void refresh(), Math.max(0, r.at + REQ_MS - Date.now()) + 5);
  poke();
  return performance.now() - pageDelay.lastPress() >= INPUT_DELAY_MS;
}

/** Look at the binding's request again: dropped unless it is still there and still for here, or only its page changed. */
export async function refresh(): Promise<void> {
  const o = offer;
  const area = requestArea();
  if (!o || !area) return;
  // R read with its bound (AF-BOUND, platform/bounded.ts; 4B-FU3): a lost answer is no R, and the binding goes
  const r = await storedRequest(area).catch(() => null);
  const not = !r || r.nonce !== o.nonce ? "gone" : await forHere(r, hereNow(area)).catch(() => "gone" as const);
  if (offer === o && not && not !== "page") drop();
}

/** The side panel follows the user between tabs: the binding is looked at again at each change. Returns its removal. */
export const watch = (): (() => void) | undefined => surface.panel?.watchTab(() => void refresh());

/** The host for "Press Enter to fill the code on <host>", while the binding's request lives. */
export const line = (): string | null => (offer && live(offer) ? offer.host : null);

/** The Fill buttons are drawn disabled: a binding, during the surface's input delay. */
export const held = (): boolean => offer !== null && live(offer) && !pageDelay.ready();

/** A box in the bound document's top frame. */
export const inDoc = (c: Cand, doc: string): boolean => c.frameId === 0 && c.documentId === doc;
