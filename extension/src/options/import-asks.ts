// The questions "delete the file you imported from?" that no answer has closed yet, and the answers' outcomes. They hold
// the files' names, counts and handles (what Chrome gave Sixkey to delete exactly those files after a click), no keys and
// no text of them, so unlike what is typed or read in Add account they are kept when another section is shown and when
// the page locks: a plain-text file of keys left on the disk because a link was clicked is what the question is for.
// They end with the person's answer (Keep, Delete, Got it). Add account adds them and App draws them above every section
// (AddAccounts.tsx PendingDeletes); this module holds the list, and no text.
import { useEffect, useState } from "preact/hooks";
import type { DeleteOutcome, FileHandleLike, Seen } from "../platform/file-access";

/**
 * A file that brought accounts in, waiting for the user's answer to "delete it now?", or that answer's outcome. `left`:
 * its entries that were not imported (deleting the file loses them); `hotp`: its accounts that came in as HOTP.
 */
export type Ask = {
  id: number;
  name: string;
  handle: FileHandleLike | null;
  seen: Seen;
  left: number;
  hotp: number;
  state: "ask" | "busy" | DeleteOutcome;
};

let asks: Ask[] = [];
const listeners = new Set<() => void>();

/** Change the list, as a state setter does. */
export function setAsks(change: (cur: Ask[]) => Ask[]): void {
  asks = change(asks);
  for (const l of [...listeners]) l();
}

/** The list now, drawn again when it changes. */
export function useAsks(): Ask[] {
  const [, redraw] = useState(0);
  useEffect(() => {
    const l = () => redraw((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return asks;
}
