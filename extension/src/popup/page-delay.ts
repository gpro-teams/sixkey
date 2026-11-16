// The input delay of a Sixkey surface (the popup, the side panel) while it holds a page's fill request: the request R v2
// that a click on the in-page suggestion wrote (AUTOFILL2 patch 4a; docs/design/notes/AUTOFILL2-NOTES.md §12). A page
// that can time when Sixkey's surface appears must not be able to have a key or a click that was meant for the page land on
// it: the input delay, 600 ms (ui/input-delay.ts INPUT_DELAY_MS), for the same threat as the plugin platform's screens had.
//
// One clock per surface document, started by App at the document's start (startPageDelay; the screens that ask it start it
// too, idempotently, so a later start only makes it stricter). Only with the suggestion's release gate open: a build with
// the gate closed never starts it, nothing asks it, and the module is not in that build at all (it has no work of its own
// at import):
//   - armed at the document's start, when its window gains the focus, and when the page becomes visible again; a focus that
//     a press inside this document brought (the side panel clicked into) does not re-arm it, so that very press counts;
//   - re-armed by any key or pointer press during the delay ("re-armed by input"), so a stream of typing never lands, but
//     NOT by a character typed into a secret field (the PIN, the password, the recovery code): a fast but deliberate entry
//     keeps its characters, and what the delay holds back is its submission (screens/Locked.tsx);
//   - re-armed when a page R arrives at a surface already open (main/Fill.tsx, the side panel's case).
// A press counts only when it began after the delay was over, and a key repeat never counts.
//
// The consumers ask only while a page R is for here: the shortcut's own request and an ordinary popup are untouched.
import { INPUT_DELAY_MS } from "../ui/input-delay";

export { INPUT_DELAY_MS };
let started = 0;
/** When this surface's clock started (Date.now(): R's `at` is on the same clock); 0 before it has. */
export const surfaceStart = (): number => started;

type Press = { type: string; key?: unknown; repeat?: unknown; target?: unknown };
let readyAt = 0;
let lastPress = -Infinity;
/** The last press was a key repeat (never counts). */
let lastRepeat = false;
let subs: Set<() => void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const tell = () => subs?.forEach((f) => f());

function arm(at: number = performance.now()): void {
  readyAt = at + INPUT_DELAY_MS;
  clearTimeout(timer);
  tell();
  timer = setTimeout(tell, INPUT_DELAY_MS + 10); // drawn again once ready
}

/** A secret field's own character: kept, never a reason to re-arm (its submission is what Locked.tsx holds back). */
function secretChar(e: Press): boolean {
  if (e.type !== "keydown" || typeof e.key !== "string" || e.key.length !== 1) return false;
  const t = e.target as { localName?: unknown; type?: unknown } | null | undefined;
  return t?.localName === "input" && t.type === "password";
}

/** A key or pointer press reaching this surface (the capture phase, before any of its handlers). */
export function onPress(e: Press, at: number = performance.now()): void {
  lastPress = at;
  lastRepeat = e.repeat === true;
  if (at < readyAt && !secretChar(e)) arm(at);
}

export const pageDelay = {
  /** Whether the delay is over. */
  ready: (at: number = performance.now()): boolean => at >= readyAt,
  /**
   * Whether a press ending now counts: the delay is over, and the last press began after it, which is to say after every
   * arming since (a press before a re-arm, held across it, does not count), and was no key repeat. With no press seen at
   * all (none reached this document), the delay alone decides.
   */
  pressOk: (at: number = performance.now()): boolean =>
    at >= readyAt && (lastPress === -Infinity || (lastPress >= readyAt && !lastRepeat)),
  /** When the last key or pointer press reached this surface (performance.now()). */
  lastPress: (): number => lastPress,
  /** A page R arrived at this surface while it was open: the delay starts again. */
  rearm: (): void => arm(),
  /** `f` is called whenever the delay is armed or ends; returns its removal. */
  subscribe(f: () => void): () => void {
    (subs ??= new Set()).add(f);
    return () => void subs?.delete(f);
  },
};

type Target = { addEventListener?: (t: string, f: (e: never) => void, capture?: boolean) => void };
/** Start this surface's clock: armed now, and its window's and document's listeners added. Once; later calls do nothing. */
export function startPageDelay(): void {
  if (started) return;
  started = Date.now();
  arm();
  const win = globalThis as unknown as Target;
  const doc = (globalThis as unknown as { document?: Target & { visibilityState?: string } }).document;
  win.addEventListener?.("focus", () => {
    if (performance.now() - lastPress > 50) arm(); // not the focus a press inside this document brought
  });
  doc?.addEventListener?.("visibilitychange", () => doc.visibilityState === "visible" && arm());
  doc?.addEventListener?.("keydown", (e: Press) => onPress(e), true);
  doc?.addEventListener?.("pointerdown", (e: Press) => onPress(e), true);
}
