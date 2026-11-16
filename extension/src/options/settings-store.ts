// The settings record as the settings page's panels share it (PHASE0X-PLAN C4, C5). Several panels change parts of one
// record: Appearance the popup's display, Security mode the lock rules and hidden codes. A panel that saved its own copy
// from when it was drawn would put back whatever another panel changed since, and parseSettings resets anything left
// out. So every change goes through changeSettings: one at a time, it reads the record as stored, changes its part,
// saves the whole record, and hands the result to every panel.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { parseSettings, type Settings } from "../core/service/types";
import type { Runtime } from "../platform/runtime";

type Listener = (s: Settings) => void;
type Change = (s: Settings) => Settings;
const listeners = new Set<Listener>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * Change the stored settings: `change` gets the current record and returns the whole new one (spread the old, replace a
 * part). Resolves with the record as saved; rejects if it could not be read or saved, and then nothing is announced.
 */
export function changeSettings(rt: Runtime, change: Change): Promise<Settings> {
  const run = queue.then(async () => {
    const next = parseSettings(change(await rt.service.getSettings())); // what the store keeps
    await rt.service.updateSettings(next);
    for (const l of listeners) l(next);
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The settings were changed by another page (the View menu in the popup or the side panel, another settings tab): read the
 * record as stored and hand it to every panel, behind any change of this page that is still being saved. Resolves once the
 * panels have it; rejects if it could not be read, and then nothing is announced.
 */
export function refreshSettings(rt: Runtime): Promise<void> {
  const run = queue.then(async () => {
    const stored = await rt.service.getSettings();
    for (const l of listeners) l(stored);
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * While this runs, a change of the settings record made on another page (or by this one) is announced to every panel
 * (refreshSettings). Only the key's name is looked at, as the worker's listener does (src/platform/action-mode.ts); the
 * record is read again through the service. Returns the clean-up.
 */
export function watchSettings(rt: Runtime): () => void {
  const area = typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
  const settingsChanged = (c: Record<string, chrome.storage.StorageChange>) => {
    if ("sk_settings" in c) void refreshSettings(rt).catch(() => undefined);
  };
  area?.onChanged.addListener(settingsChanged);
  return () => area?.onChanged.removeListener(settingsChanged);
}

/**
 * The settings record (null until read), kept current with every change made on this page, or elsewhere (refreshSettings),
 * and a way to change it. While a change made here is being saved, `settings` already shows it, so a control never
 * springs back to its old value in between (the controls are drawn from `settings`).
 */
export function useSettings(rt: Runtime): { settings: Settings | null; change: (c: Change) => Promise<Settings> } {
  const [stored, setStored] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const pending = useRef(0);
  useEffect(() => {
    let live = true;
    const update: Listener = (x) => {
      if (live) setStored(x);
    };
    listeners.add(update);
    rt.service.getSettings().then(update, () => undefined); // unreadable: the controls stay hidden
    return () => {
      live = false;
      listeners.delete(update);
    };
  }, [rt]);
  const change = useCallback(
    async (c: Change) => {
      pending.current++;
      setDraft((d) => {
        const base = d ?? stored;
        return base ? parseSettings(c(base)) : null;
      });
      try {
        return await changeSettings(rt, c);
      } finally {
        if (--pending.current === 0) setDraft(null);
      }
    },
    [rt, stored],
  );
  return { settings: draft ?? stored, change };
}
