// Imported by sw.ts right after storage-access-first.ts, so that its body runs second (ES modules run in import order):
// what a click on the toolbar icon opens, the popup or the side panel (src/platform/action-mode.ts), is set at every start
// of the worker before anything else that waits, and its listeners are added at load, as MV3 requires. A click that wakes
// the worker reaches the click listener whether or not this first apply has finished.
import { serveAction } from "../platform/action-mode";

export const action = serveAction();
