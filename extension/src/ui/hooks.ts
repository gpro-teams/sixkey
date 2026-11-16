import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Entry } from "../core/vault/model";
import { canGenerate, codeAt, counterAt } from "./otp";

/** How many codes are worked out before any others: about what the popup shows without scrolling. */
export const FIRST_SCREEN = 16;

/** Milliseconds from `now` until just after the next whole second. Late rather than early, so a redraw never shows the second that is ending. */
export const msToNextSecond = (now: number, slackMs = 10) => 1000 - (now % 1000) + slackMs;

const keyOf = (e: Entry) => e.id + e.secret;

/**
 * Which codes to work out at `now`, in two batches, keeping the order given (display order):
 * - `first`: codes not yet shown for this period among the first `n` entries, unless already asked for as part of an
 *   earlier `first` batch. An entry that moved up into the first screen after its code was queued with the rest (the
 *   current site is only known a moment after opening) is asked for again here, so the top of the list never waits
 *   for the bottom. Asking twice costs one HMAC: the key is already imported.
 * - `rest`: every other code not yet shown for this period and not yet asked for.
 * `shown` maps each entry to the period counter of the code on screen; `asked` and `askedFirst` to the counter last
 * asked for in any batch, and in a `first` batch. Pure, so the scheduling can be tested without a browser.
 */
export function planCodes(
  entries: readonly Entry[],
  now: number,
  shown: ReadonlyMap<string, number>,
  asked: ReadonlyMap<string, number>,
  askedFirst: ReadonlyMap<string, number>,
  n = FIRST_SCREEN,
): { first: Entry[]; rest: Entry[] } {
  const first: Entry[] = [];
  const rest: Entry[] = [];
  entries.forEach((e, i) => {
    if (!canGenerate(e)) return;
    const c = counterAt(e, now);
    const k = keyOf(e);
    if (shown.get(k) === c) return;
    if (i < n) {
      if (askedFirst.get(k) !== c) first.push(e);
    } else if (asked.get(k) !== c) rest.push(e);
  });
  return { first, rest };
}

/** Run `fn` once the browser has had a chance to paint (a frame, then a task), or after 100 ms if no frame comes. */
function afterPaint(fn: () => void): void {
  let done = false;
  const go = () => {
    if (!done) {
      done = true;
      fn();
    }
  };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 100);
}

/**
 * Current codes for the given entries (in display order), recomputed when a period rolls over, and `now`, the clock the
 * list is drawn with. The clock ticks once a second, just after the second turns, so the seconds, the rings and a new
 * period's code all change together. The first screen's codes are worked out first and the rest only after that has
 * been painted, so with hundreds of accounts the first code does not wait for the last.
 */
export function useCodes(entries: Entry[], n = FIRST_SCREEN): { codes: Map<string, string>; now: number } {
  const [now, setNow] = useState(() => Date.now());
  const [codes, setCodes] = useState<Map<string, string>>(() => new Map());
  const shown = useRef(new Map<string, number>());
  const asked = useRef(new Map<string, number>());
  const askedFirst = useRef(new Map<string, number>());
  const alive = useRef(true);

  useEffect(() => {
    let id = window.setTimeout(function tick() {
      setNow(Date.now());
      id = window.setTimeout(tick, msToNextSecond(Date.now()));
    }, msToNextSecond(Date.now()));
    return () => {
      alive.current = false;
      clearTimeout(id);
    };
  }, []);

  // A layout effect, so the work starts before the first paint rather than after it.
  useLayoutEffect(() => {
    const { first, rest } = planCodes(entries, now, shown.current, asked.current, askedFirst.current, n);
    const run = async (batch: Entry[]) => {
      const got = await Promise.all(
        batch.map((e) =>
          codeAt(e, now).then(
            (code) => ({ e, code }),
            () => null,
          ),
        ),
      );
      if (!alive.current) return;
      const fresh = got.filter((g): g is { e: Entry; code: string } => {
        if (!g) return false;
        const c = counterAt(g.e, now);
        if ((shown.current.get(keyOf(g.e)) ?? -1) > c) return false; // a newer period's code got there first
        shown.current.set(keyOf(g.e), c);
        return true;
      });
      if (fresh.length) {
        setCodes((prev) => {
          const next = new Map(prev);
          for (const { e, code } of fresh) next.set(e.id, code);
          return next;
        });
      }
    };
    for (const e of first) askedFirst.current.set(keyOf(e), counterAt(e, now));
    for (const e of [...first, ...rest]) asked.current.set(keyOf(e), counterAt(e, now));
    if (first.length) void run(first);
    if (rest.length) afterPaint(() => void run(rest));
  }, [entries, now, n]);

  return { codes, now };
}
