// The lock screen's rules while a page's fill request is on it (R v2: the user's click on the in-page suggestion; AUTOFILL2
// patch 4a, docs/design/notes/AUTOFILL2-NOTES.md §12). Used by Locked.tsx only with the suggestion's release gate open: a
// build with the gate closed calls none of it, and has none of it (no work at import).
//
// A page can time when this screen appears, so while its request is on it (and only then) the screen holds back what such a
// page could otherwise make of keys meant for itself:
//   - nothing is sent, and the device button does nothing, during the surface's input delay (../page-delay.ts), or for a
//     press that began inside it; drawn disabled meanwhile;
//   - an entry may send itself at the PIN's length only if it began after the delay and no wrong secret was typed on this
//     screen yet (the review's R2-M1 a);
//   - any other entry (the PIN's, the password's or the recovery code's) is sent by Enter alone, and only after
//     INPUT_DELAY_MS with no character typed into it (R2-M1 b: for the password too, so a page cannot have text it timed
//     sent as a wrong master password, which would leave a failed-unlock record);
//   - a PIN sent by Enter whose length is not the PIN's is cleared and not tried, so no try is spent (R2-M1 c);
//   - the request handed on with the unlock is the one that was on screen at the entry's FIRST character, or at the device
//     button's press, and only if it had been on screen for INPUT_DELAY_MS by then (with the delay over) and is still the
//     one on screen (the review's M-2): a request that came while the user was typing is offered after the unlock, never
//     filled by it.
// Characters are never dropped and never counted as a try by any of this: at most an entry loses its automatic step. With the
// shortcut's request (v1) or none, nothing here applies (`on` is false), and the screen is exactly as before.
import { useEffect, useRef, useState } from "preact/hooks";
import { normalizePin } from "../../core/crypto/pin";
import type { FillReq } from "../../platform/fill-request";
import { INPUT_DELAY_MS, pageDelay, startPageDelay } from "../page-delay";

export type PageLock = {
  /** A page's request (v2) is on screen now. */
  on: boolean;
  /** The field's value changed (typed, pasted, emptied). */
  typed(v: string): void;
  /** The entry is gone without a send (another field, the field cleared). */
  forget(): void;
  /** Whether this entry may send itself now at the PIN's length. */
  auto(): boolean;
  /** Whether the Unlock button (and so Enter) is drawn disabled now: the delay, or an entry not quiet yet. */
  holdSend(): boolean;
  /** Whether the device button is drawn disabled now (the delay). */
  holdDevice(): boolean;
  /** Enter or Unlock now: "ok"; "wait" (the delay, or not quiet yet); "length" (a PIN of another length: clear it). */
  send(pin: string | null, digits: number): "ok" | "wait" | "length";
  /** A wrong secret on this screen. */
  wrong(): void;
  /** The nonce to hand on with an unlock by a typed secret (read before the unlock is awaited); the entry is used up. */
  handOn(shown: string | undefined, fromShares?: boolean): string | undefined;
  /** The nonce to hand on with an unlock by the device button, at its press. */
  device(shown: string | undefined): string | undefined;
};

type Entry = { nonce?: string; handOn: boolean; inDelay: boolean; last: number };

export function usePageLock(req: FillReq | null): PageLock {
  startPageDelay(); // App started it with the document; a later start only makes it stricter
  const on = req?.v === 2;
  const line = useRef<{ nonce?: string; at: number }>({ at: 0 });
  if (line.current.nonce !== req?.nonce) line.current = { nonce: req?.nonce, at: performance.now() };
  const entry = useRef<Entry | null>(null);
  const [wrongOnce, setWrongOnce] = useState(false);
  const [, redraw] = useState(0);
  useEffect(() => pageDelay.subscribe(() => redraw((n) => n + 1)), []);
  const quietAt = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(quietAt.current), []);
  /** The line of the request on screen had been there INPUT_DELAY_MS at `at`, with the surface's delay over. */
  const settled = (at: number) => !!req && at - line.current.at >= INPUT_DELAY_MS && pageDelay.ready(at);
  /** This entry is held to Enter after a quiet INPUT_DELAY_MS, and is not quiet yet. */
  const loud = () => {
    const e = entry.current;
    const strict = wrongOnce || !e || e.inDelay;
    return strict && (!e || performance.now() - e.last < INPUT_DELAY_MS);
  };
  return {
    on,
    typed(v) {
      const at = performance.now();
      if (v === "") return void (entry.current = null);
      if (entry.current) entry.current.last = at;
      else entry.current = { nonce: req?.nonce, handOn: settled(at), inDelay: !pageDelay.ready(at), last: at };
      // drawn again when the entry has been quiet long enough for its Enter
      clearTimeout(quietAt.current);
      quietAt.current = setTimeout(() => redraw((n) => n + 1), INPUT_DELAY_MS + 10);
    },
    forget: () => void (entry.current = null),
    auto: () => !wrongOnce && entry.current !== null && !entry.current.inDelay,
    holdSend: () => on && (!pageDelay.ready() || loud()),
    holdDevice: () => on && !pageDelay.ready(),
    send(pin, digits) {
      if (!pageDelay.pressOk() || loud()) return "wait";
      if (pin !== null && normalizePin(pin)?.length !== digits) {
        entry.current = null;
        return "length";
      }
      return "ok";
    },
    wrong: () => on && setWrongOnce(true),
    handOn(shown, fromShares = false) {
      const e = entry.current;
      entry.current = null;
      return !fromShares && e?.handOn && e.nonce === shown ? e.nonce : undefined;
    },
    device: (shown) => (pageDelay.pressOk() && settled(performance.now()) ? shown : undefined),
  };
}
