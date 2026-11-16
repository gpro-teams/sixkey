// A file chosen under Backup that is another app's export, not a Sixkey backup, goes to Add account, which reads every
// format (src/core/import/file-formats.ts), so there is one reader for both sections. The File object is handed over
// in the page's memory, never its text, and the two parts of the page do not import each other
// (docs/design/notes/BUDGET-NOTES.md §2): both import only this module, which holds no text of its own.
// The sections are not on the page together: Backup is shown when the file is chosen, Add account is not. Backup keeps
// the file and hands it over when the person follows its link to Add account (handToAdd); it waits here only from that
// click until Add account is shown and takes it (takeHandoffs), a moment. It is dropped on a lock and when Add account is
// shown locked, and a hand-over that was begun before a lock (the file was still being read) is refused after it: every
// drop bumps the epoch Backup read when it began.
import type { Picked } from "../platform/file-access";

type Taker = (files: Picked[]) => void;
let taker: Taker | null = null;
let waiting: Picked[] = [];
let epoch = 0;

/** Add account takes handed-over files while it is on the page, those waiting first. Returns the function that stops taking them. */
export function takeHandoffs(t: Taker): () => void {
  taker = t;
  if (waiting.length) {
    const files = waiting;
    waiting = [];
    t(files);
  }
  return () => {
    if (taker === t) taker = null;
  };
}

/** The epoch to read when a hand-over begins (the file is read, the person chooses), and give to handToAdd. */
export const handoffEpoch = (): number => epoch;

/** Hands files to Add account: at once when it is on the page, else they wait for it. Refused (false) if a drop came since `since`. */
export function handToAdd(files: Picked[], since: number = epoch): boolean {
  if (since !== epoch) return false;
  if (taker) taker(files);
  else waiting = [...waiting, ...files];
  return true;
}

/** Whatever waits is dropped (the page locked, or Add account is shown locked), and hand-overs begun before are refused. */
export function dropHandoffs(): void {
  waiting = [];
  epoch++;
}
