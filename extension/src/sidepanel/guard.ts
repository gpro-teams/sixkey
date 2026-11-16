// The side panel's own rules (docs/design/notes/SIDEPANEL-NOTES.md §3). The panel draws the popup's screens (App), but it
// is a page that stays open beside the web page for as long as the user wants, so it is treated like the settings page,
// which also stays open (ux-study §2.1; SYNC-DESIGN §9.1, cross-reference of 2026-10-16):
//   - Idle cap. Sixkey locks after 15 minutes in which the unlocked key's record of activity did not move, whatever the
//     automatic lock says; a shorter automatic lock still applies (the worker's alarm). The panel moves that record on
//     the user's own input in it (a key, a pointer press, the wheel; `touch`, at most every 30 s). Other pages move it
//     only where they call `touch`: opening the popup, a settings page loading the vault; typing or scrolling in a
//     settings tab does not. The panel's own reloads, the codes' tick and changes made elsewhere are not use. The check
//     reads the wall clock, at every tick (hidden or not) and when the panel is shown again, so a timer slowed down in a
//     hidden page or stopped by sleep only delays the lock to the next tick.
//   - The lock screen in a page that stays open: a password, PIN or recovery code typed there, or a Show box ticked, is
//     wiped (the page is drawn again) after 2 minutes without input, and when the page is hidden.
//   - The lock is the soft lock, the same as the idle timer's (QUICK-UNLOCK §5.5): the key goes from every page, a live
//     PIN stays. With "lock every time" the key is this page's own (RoutedSession), so only this page drops it, as when the
//     popup closes; another window's panel, holding its own key, is not affected.
//   - Close. Closing the panel ends the page and everything in its memory; the page drops its own key first anyway
//     (pagehide), in case the browser keeps the page. A key in shared storage stays, as when the popup closes: the
//     automatic lock and the idle cap above end it.
//   - Follow. The panel shows the vault as it is now: a commit or a settings change elsewhere reloads the list, a lock
//     anywhere closes it (App's own lock-epoch listener, as in the popup), and a tab change reads the active tab's address
//     again (no address for a tab the user has not clicked the icon on: activeTab; one line then says how to get it). An
//     unlock elsewhere opens the list at once only in a panel used in the last 5 minutes; a panel left alone (another
//     window, a shared screen) stays on its lock screen until the user's next input in it.
//   - Never in a shared profile: the panel checks the profile when it opens (./main.tsx) and whenever the settings
//     change, and closes itself. The worker no longer offers it there either (src/platform/action-mode.ts).
import { ALWAYS_MODE_MAX_IDLE_MINUTES } from "../core/service/service-core";
import { parseSettings, profileOf } from "../core/service/types";
import { CLICK_KEY } from "../platform/action-mode";
import type { PopupRuntime } from "../platform/runtime-base";
import { SESSION_KEY } from "../platform/session";
import type { PanelHooks } from "../popup/surface";

/** The idle cap: the settings page's ceiling for a page that stays open (service-core.ts). */
export const PANEL_IDLE_MS = ALWAYS_MODE_MAX_IDLE_MINUTES * 60_000;
/** Input moves the key's record of activity at most this often: one write of chrome.storage.session. */
export const TOUCH_EVERY_MS = 30_000;
/** How often the wall clock is looked at; storage is read only once the deadline seen at the last read has passed. */
export const TICK_MS = 10_000;
/** The user's own input. Not focus, pointer moves, scrolling by script, the codes' tick or a reload. */
export const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
/** A secret typed on the lock screen, or a Show box ticked, is wiped after this long without input. */
export const LOCK_SCREEN_WIPE_MS = 2 * 60_000;
/** An unlock elsewhere opens the list at once in a panel used this recently; others wait for their next input. */
export const FOLLOW_UNLOCK_MS = 5 * 60_000;

type Changes = Record<string, { newValue?: unknown } | undefined>;
type ChromeEvent<L> = { addListener(l: L): void; removeListener(l: L): void };
/** The parts of chrome.* the panel uses; tests pass fakes. */
export type PanelChrome = {
  storage: {
    local: { onChanged: ChromeEvent<(c: Changes) => void> };
    session: { onChanged: ChromeEvent<(c: Changes) => void> };
  };
  tabs: {
    onActivated: ChromeEvent<(info: unknown) => void>;
    onUpdated: ChromeEvent<(id: number, info: { status?: string }, tab: { active?: boolean }) => void>;
    query(q: { active: true; currentWindow: true }): Promise<{ url?: string }[]>;
  };
  runtime: { sendMessage(m: unknown): Promise<unknown> };
};
type Target = { addEventListener(t: string, l: (e: Event) => void, o?: AddEventListenerOptions): void };
type Removable = Target & { removeEventListener(t: string, l: (e: Event) => void, o?: AddEventListenerOptions): void };
export type PanelEnv = {
  chrome: PanelChrome;
  doc: Removable & { readonly visibilityState: string };
  win: Removable;
  now: () => number;
  setInterval: (f: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  /** The profile is no longer one the panel may be used in: close the panel, draw nothing. */
  shut: () => void;
  /** Whether anything is typed or ticked in the page's fields (the lock screen's). */
  typed: () => boolean;
  /** Wipe the page's fields: draw the page again from storage. */
  wipe: () => void;
  /** Show or hide the line that says the active tab gives no address until the icon is clicked on it. */
  hint: (show: boolean) => void;
};

/** A change of the stored settings that makes this a shared profile (or settings that cannot be read as single-person). */
export const sharedNow = (raw: unknown): boolean => profileOf(parseSettings(raw)) === "shared";

/**
 * The panel's hooks for App (src/popup/surface.ts). `attach` starts the idle cap and the listeners once App is drawn,
 * and returns their clean-up; `rt` is App's runtime, so the key this checks and drops is the one App holds.
 */
export function panelHooks(env: PanelEnv): PanelHooks {
  return {
    shown() {
      // The list is on screen (an unlock, a reload). No touch: only input is use. The worker re-arms its idle alarm for
      // the key as it is, and may run a sync round, as for the popup.
      env.chrome.runtime.sendMessage({ type: "sk-reschedule-autolock" }).catch(() => undefined);
    },
    attach(rt, reload, showing) {
      return guard(env, rt, reload, showing);
    },
    watchTab(again) {
      const { tabs, storage } = env.chrome;
      // A tab that gives no address (one the icon was not clicked on: activeTab) gets the hint, where "this site" would be
      // and above the scan's failure: one click on the icon reads it.
      let live = true;
      const look = () =>
        tabs.query({ active: true, currentWindow: true }).then(
          (t) => live && env.hint(!!t[0] && !t[0].url),
          () => live && env.hint(false),
        );
      const both = () => {
        again();
        void look();
      };
      void look();
      const activated = () => both();
      const updated = (_id: number, info: { status?: string }, tab: { active?: boolean }) => {
        if (tab.active && info.status === "complete") both(); // the active tab loaded another page
      };
      // the icon clicked again on another tab, with the panel open: activeTab is now granted for that tab
      const clicked = (c: Changes) => {
        if (CLICK_KEY in c) both();
      };
      tabs.onActivated.addListener(activated);
      tabs.onUpdated.addListener(updated);
      storage.session.onChanged.addListener(clicked);
      return () => {
        live = false;
        env.hint(false);
        tabs.onActivated.removeListener(activated);
        tabs.onUpdated.removeListener(updated);
        storage.session.onChanged.removeListener(clicked);
      };
    },
  };
}

function guard(
  env: PanelEnv,
  rt: Pick<PopupRuntime, "service" | "session">,
  reload: () => Promise<void>,
  showing: () => string,
): () => void {
  const { chrome, doc, win, now } = env;
  let lastInput = now(); // opening the panel is the user's own action
  let lastTouch = 0;
  // Before this, the last read showed that the cap could not have been reached: no read needed. Never later than the
  // real deadline (it is worked out from activity that can only have grown since), so it only saves reads.
  let due = 0;
  let checking = false;
  let unlockedElsewhere = false; // an unlock this panel did not follow (left alone): shown at its next input

  const input = () => {
    lastInput = now();
    if (showing() === "main" && lastInput - lastTouch >= TOUCH_EVERY_MS) {
      lastTouch = lastInput;
      rt.service.touch().catch(() => undefined);
    }
    if (unlockedElsewhere && showing() === "locked") {
      unlockedElsewhere = false;
      void reloadAndRead();
    }
  };
  /** The lock screen's typed secrets and Show boxes, wiped when the panel is left alone or hidden. */
  const wipeLockScreen = (hidden: boolean) => {
    if (showing() === "locked" && (hidden || now() - lastInput >= LOCK_SCREEN_WIPE_MS) && env.typed()) env.wipe();
  };

  /** The soft lock, or this page's own key dropped ("lock every time"); then the lock screen. */
  const lock = async () => {
    rt.session.forget(); // a key only this page holds is gone at once
    if (await rt.session.get()) await rt.service.lock(); // a shared one: the soft lock, everywhere
    await reload();
  };

  const check = async () => {
    if (checking || showing() !== "main" || now() < due) return;
    checking = true;
    try {
      const s = await rt.session.get(); // this page's key in "lock every time", otherwise the shared one
      if (!s)
        due = now() + PANEL_IDLE_MS; // no key to end: a vault without a password, or locked meanwhile
      else if (now() - Math.max(s.lastActive, lastInput) >= PANEL_IDLE_MS) await lock();
      else due = Math.max(s.lastActive, lastInput) + PANEL_IDLE_MS;
    } catch {
      due = 0; // read again at the next tick
    } finally {
      checking = false;
    }
  };

  const tick = () => {
    wipeLockScreen(false);
    void check();
  };
  const visible = () => {
    if (doc.visibilityState === "visible") void check();
    else wipeLockScreen(true);
  };
  // A reload that reaches the list is a new key, or a key changed elsewhere: the next tick reads it again.
  const reloadAndRead = () => {
    due = 0;
    return reload();
  };

  const localChanged = (c: Changes) => {
    if ("sk_settings" in c && sharedNow(c.sk_settings?.newValue)) return close();
    // a commit (the pointer moved) or a settings change elsewhere: the list as it is now
    if (("sk_active" in c || "sk_settings" in c) && showing() === "main") void reloadAndRead();
  };
  const sessionChanged = (c: Changes) => {
    if (!(SESSION_KEY in c)) return;
    due = 0;
    const appeared = c[SESSION_KEY]?.newValue !== undefined;
    unlockedElsewhere = false;
    // unlocked elsewhere (the shared key appeared): the list without a password here, at once in a panel in use, and
    // otherwise at the user's next input in it (so a panel left on another screen does not show the codes by itself)
    if (!appeared || showing() !== "locked") return;
    if (now() - lastInput < FOLLOW_UNLOCK_MS) void reloadAndRead();
    else unlockedElsewhere = true;
  };
  const gone = (e: Event) => {
    rt.session.forget();
    if (!(e as PageTransitionEvent).persisted) stop();
  };

  const opts = { capture: true, passive: true };
  for (const t of INPUT_EVENTS) doc.addEventListener(t, input, opts);
  doc.addEventListener("visibilitychange", visible);
  win.addEventListener("focus", tick);
  win.addEventListener("pagehide", gone);
  chrome.storage.local.onChanged.addListener(localChanged);
  chrome.storage.session.onChanged.addListener(sessionChanged);
  const timer = env.setInterval(tick, TICK_MS);

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    env.clearInterval(timer);
    for (const t of INPUT_EVENTS) doc.removeEventListener(t, input, opts);
    doc.removeEventListener("visibilitychange", visible);
    win.removeEventListener("focus", tick);
    win.removeEventListener("pagehide", gone);
    chrome.storage.local.onChanged.removeListener(localChanged);
    chrome.storage.session.onChanged.removeListener(sessionChanged);
  }
  function close() {
    rt.session.forget();
    stop();
    env.shut();
  }
  return stop;
}
