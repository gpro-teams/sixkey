// The backup in Chrome sync's two records: a count of the changes of either that this page has heard, from its start
// (App), so from before the open's read of them, which comes with the settings (platform/runtime-base.ts). The pill's
// chunk (main/CsbPop.tsx) takes the open's records only while the count is what it was when that read began (the
// screen's `mark`, load.ts); otherwise it reads them again. So a change written between that read and the pill's own
// listener is not missed, and an open with no change reads nothing more. Nothing of a change's values is used.
import { CSB_CFG_KEY, CSB_STATE_KEY } from "../platform/cloud-mark";

let n = 0;
let heard: unknown = null;

type Area = { onChanged: { addListener(f: (c: Record<string, unknown>) => void): void } };

/** Counts the changes from now on, in this area (the page's storage.local: once per page). */
export function watchCsbChanges(area: Area | undefined = globalThis.chrome?.storage?.local): void {
  if (!area || area === heard) return;
  heard = area;
  area.onChanged.addListener((c) => void ((CSB_CFG_KEY in c || CSB_STATE_KEY in c) && n++));
}

/** The changes counted so far. */
export const csbChanges = (): number => n;
