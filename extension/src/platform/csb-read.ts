// The pages' read of the backup in Chrome's sync storage (CSB): which slots chrome.storage.sync holds, each
// assembled and checked (core/cloud/slots.ts readSlots), and a watch while Chrome is still delivering one. The settings
// page's (first run, the restore, the merges: src/options/csb/), and the popup's and the side panel's welcome, which
// offers a copy found (src/popup/screens/CsbFound.tsx): here, beside the worker's writer, so that the popup takes it
// without any of the settings page's modules. Read only: a page never writes the area; platform/csb-area.ts, the
// worker's, is the one module that does (test/unit/source-rules.test.ts holds both).
//
// Chrome sync delivers another computer's items one by one, in any order, so a slot read now may be "partial"
// (slots.ts assembleSlot); nothing partial is ever used, and only the intact slots are offered to a restore
// (core/cloud/restore.ts openCloudBackups takes `intact` as it is). The watch reads the whole area again at each change
// of a slot's key, never the change's values (a read sees all the items as they are together), one read at a time,
// and once more when a change came during a read; its listener is added before its first read, so nothing that
// arrives in between is missed. A slot whose items never all arrive (a computer lost while Chrome uploaded it) stays
// partial: waitForSlots gives up at its time limit and says so. chrome.storage.sync itself never leaves this module:
// chromeSyncReader is not exported, and is only the functions' default area (source-rules.test.ts).
import { newestFirst, type CloudCandidate } from "../core/cloud/restore";
import { parseKey, readSlots, slotCandidate, type SlotRead } from "../core/cloud/slots";

/** The part of chrome.storage.sync a page uses: reads and onChanged. */
export type SyncReader = {
  get(keys: null): Promise<Record<string, unknown>>;
  onChanged: {
    addListener(f: (changes: Record<string, unknown>) => void): void;
    removeListener(f: (changes: Record<string, unknown>) => void): void;
  };
};

/** chrome.storage.sync, where there is one: the default area of this module's functions, and nothing else. */
const chromeSyncReader = (): SyncReader | undefined =>
  globalThis.chrome?.storage?.sync as unknown as SyncReader | undefined;

export type SlotList = {
  /** Every slot of the area, by id, as read. */
  slots: SlotRead[];
  /** The intact ones, newest first, as a restore takes them (restore.ts openCloudBackups). */
  intact: CloudCandidate[];
  /** The newest intact slot's time (its manifest's `t`, the copy's savedAt), or null. */
  latest: number | null;
  /** The ids of the slots still arriving, of those that are not a slot this version reads, and of a later Sixkey's. */
  partial: string[];
  invalid: string[];
  newer: string[];
  /** The keys of no slot: used space, never read. */
  foreign: string[];
};

/** An area's items (get(null)'s answer) as a list of slots. */
export async function slotList(items: Readonly<Record<string, unknown>>): Promise<SlotList> {
  const { slots, foreign } = await readSlots(items);
  const ids = (kind: string) => slots.filter((s) => s.read.kind === kind).map((s) => s.slot);
  const intact = slots.flatMap((s) => (s.read.kind === "ok" ? [slotCandidate(s.slot, s.read)] : [])).sort(newestFirst);
  return {
    slots,
    intact,
    latest: intact[0]?.modified ?? null,
    partial: ids("partial"),
    invalid: ids("invalid"),
    newer: ids("newer"),
    foreign,
  };
}

const missing = () => new Error("storage.sync is not available");

/** The slots in the area now: one get(null). Rejects when the area cannot be read. */
export async function listSlots(area: SyncReader | undefined = chromeSyncReader()): Promise<SlotList> {
  if (!area) throw missing();
  return slotList(await area.get(null));
}

/**
 * `onError` is required: it gets every exception the watch meets, with where it came from: "read" when the area could
 * not be read (the watch goes on, and reads again at the next change), "on" when `on` itself threw (the watch goes on
 * too). Nothing is dropped, and neither is taken for the other.
 */
export type WatchOptions = { area?: SyncReader; onError: (e: unknown, from: "read" | "on") => void };

/**
 * Calls `on` with the slots now, then again after each change of a slot's key (the header's rules). Returns the stop:
 * the listener removed, no call after it, and no further read.
 */
export function watchSlots(on: (list: SlotList) => void, o: WatchOptions): () => void {
  const area = "area" in o ? o.area : chromeSyncReader();
  if (!area) throw missing();
  let live = true;
  let reading = false;
  let again = false;
  const report = (e: unknown, from: "read" | "on") => {
    if (live) o.onError(e, from);
  };
  const read = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        let list: SlotList;
        try {
          list = await listSlots(area);
        } catch (e) {
          report(e, "read");
          continue;
        }
        if (!live) break;
        try {
          on(list);
        } catch (e) {
          report(e, "on");
        }
      } while (again && live);
    } finally {
      reading = false;
    }
  };
  const changed = (changes: Record<string, unknown>) => {
    if (Object.keys(changes).some((k) => parseKey(k) !== null)) void read();
  };
  area.onChanged.addListener(changed);
  void read();
  return () => {
    live = false;
    area.onChanged.removeListener(changed);
  };
}

/** Nothing still arriving. */
export const nothingArriving = (l: SlotList): boolean => l.partial.length === 0;

/** The longest wait setTimeout keeps (2^31 − 1 ms); a longer one, or Infinity, it would end at once. */
export const MAX_WAIT_MS = 2_147_483_647;

/**
 * The slots once `done` holds of them (default: nothing still arriving), read now and after each change; at `ms` the
 * last list, unsettled; when no read has ended by `ms`, the first list that does, unsettled (so a first read that never
 * ends keeps the wait, and its listener, until it does: Chrome answers reads). Rejects when any read fails, or `done`
 * throws, and when `ms` is not a whole number from 0 to MAX_WAIT_MS. Its watch is stopped whichever way it ends.
 */
export function waitForSlots(o: {
  ms: number;
  done?: (list: SlotList) => boolean;
  area?: SyncReader;
}): Promise<{ list: SlotList; settled: boolean }> {
  const done = o.done ?? nothingArriving;
  if (!Number.isSafeInteger(o.ms) || o.ms < 0 || o.ms > MAX_WAIT_MS)
    return Promise.reject(new RangeError(`waitForSlots: ms must be a whole number from 0 to ${MAX_WAIT_MS}`));
  return new Promise((resolve, reject) => {
    let last: SlotList | null = null;
    let late = false;
    let stop: () => void = () => undefined;
    const timer = setTimeout(() => {
      late = true;
      if (last) end({ list: last, settled: false });
    }, o.ms);
    const end = (r: { list: SlotList; settled: boolean }) => {
      clearTimeout(timer);
      stop();
      resolve(r);
    };
    try {
      stop = watchSlots(
        (list) => {
          last = list;
          if (done(list)) end({ list, settled: true });
          else if (late) end({ list, settled: false });
        },
        {
          ...("area" in o ? { area: o.area } : {}),
          onError: (e) => {
            clearTimeout(timer);
            stop();
            reject(e);
          },
        },
      );
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}
