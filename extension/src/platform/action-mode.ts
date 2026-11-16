// What a click on Sixkey's toolbar icon (or its shortcut, `_execute_action`) opens: the popup, the default, or the side
// panel (docs/design/notes/SIDEPANEL-NOTES.md; ux-study §2.1). The choice is a per-browser preference like the theme, kept
// in chrome.storage.local (`sk_opener`) because the service worker, which applies it, cannot read a page's localStorage.
//
// How the side panel is opened, and why this way:
//   - The service worker sets the action's popup to "" and opens the panel itself in `action.onClicked`, which fires
//     only when no popup is set. The click grants activeTab for the clicked tab, so "this site" and "Scan QR code on this
//     page" work in the panel as they do in the popup. The side panel API's own behaviour that opens the panel on a click
//     instead does not grant activeTab (ux-study E2): it is never used, and check-dist fails a build that names it.
//   - `sidePanel.open()` must be called in the user's action (Chrome 116+), so the click handler calls it at once, with
//     no read or await before it.
//   - The panel's page is not in the manifest (no `side_panel` key): the worker enables it, at every start and whenever
//     the choice or the profile changes, only for a single-person profile, so a shared profile never offers it, not even
//     in the browser's own side panel menu. The panel's page checks the profile itself as well (src/sidepanel/guard.ts):
//     the worker's settings are the browser's to keep, and may lag behind.
//   - Whether Chrome keeps the action's popup and the panel's options across a browser restart is not documented: the
//     worker sets both at every start, before anything else that waits, and the click handler sets the panel's path
//     again right before it opens it.
import { parseSettings, profileOf } from "../core/service/types";

/** The stored choice (chrome.storage.local): "panel", or absent for the popup. Any other value reads as the popup. */
export const OPENER_KEY = "sk_opener";
/** The action's popup and the side panel's page, as the manifest and chrome.action / chrome.sidePanel name them. */
export const POPUP_PATH = "popup/index.html";
export const PANEL_PATH = "sidepanel/index.html";
/** The time of the last click on the icon in side panel mode (chrome.storage.session): an open panel reads its tab again. */
export const CLICK_KEY = "sk_action_click";

export type Opener = "popup" | "panel";
/** `offered`: the side panel may be opened at all (the API exists, a single-person profile). `opens`: what a click opens. */
export type ActionPlan = { readonly offered: boolean; readonly opens: Opener };

/** The parts of chrome.* this needs; each may be missing (another browser, an older Chrome, a test). */
type Api = {
  action?: {
    setPopup?(o: { popup: string; tabId?: number }): Promise<void>;
    openPopup?(o?: { windowId?: number }): Promise<void>;
    onClicked?: { addListener(l: (tab: { windowId: number; id?: number }) => void): void };
  };
  windows?: { get?(windowId: number): Promise<{ type?: string }> };
  sidePanel?: {
    open?(o: { windowId: number }): Promise<void>;
    setOptions?(o: { path?: string; enabled: boolean }): Promise<void>;
  };
  storage?: {
    local?: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      onChanged?: { addListener(l: (changes: Record<string, unknown>) => void): void };
    };
    session?: { set(items: Record<string, unknown>): Promise<void> };
  };
};
const api = (): Api | undefined => (globalThis as { chrome?: Api }).chrome;

/** The browser has the side panel calls Sixkey uses (Chrome 116+; Edge, Brave and Opera 135+ too). */
export function panelSupported(c: Api | undefined = api()): boolean {
  return typeof c?.sidePanel?.open === "function" && typeof c.sidePanel.setOptions === "function";
}

/** The stored value as a choice: only "panel" exactly is the panel. */
export const openerOf = (raw: unknown): Opener => (raw === "panel" ? "panel" : "popup");

/**
 * What the icon does, from the stored choice and the stored settings (sk_settings, for the profile): the panel only where
 * it is offered and chosen. A shared profile (QUICK-UNLOCK §5.12 item 5; ux-study §2.8) is never offered it, whatever is
 * stored: the choice stays, and comes back if the profile is declared single-person again.
 */
export function planAction(stored: Record<string, unknown>, supported: boolean): ActionPlan {
  const offered = supported && profileOf(parseSettings(stored.sk_settings)) === "solo";
  return { offered, opens: offered && openerOf(stored[OPENER_KEY]) === "panel" ? "panel" : "popup" };
}

/**
 * Put a plan into the browser. The popup first, so that whatever happens to the panel's calls the icon opens something:
 * "" (no popup, so a click reaches action.onClicked) for the panel, the popup's page otherwise. Then the panel's page,
 * enabled only where it is offered.
 */
export async function applyAction(plan: ActionPlan, c: Api | undefined = api()): Promise<void> {
  await c?.action?.setPopup?.({ popup: plan.opens === "panel" ? "" : POPUP_PATH });
  if (panelSupported(c))
    await c!.sidePanel!.setOptions!(plan.offered ? { path: PANEL_PATH, enabled: true } : { enabled: false });
}

/** The service worker's half: see the top of this file. */
export type ActionWorker = {
  /** Read the choice and the profile and apply them; serialised, so the last change read is the one applied. */
  apply(): Promise<void>;
  /** Where to report a click that could not open the panel (the diagnostics log); kept until it is set. */
  onProblem(report: (message: string) => void): void;
  /** What the latest apply decided; undefined until the first one has read the settings. */
  readonly plan: ActionPlan | undefined;
};

/**
 * Started by the service worker at load (src/background/action-first.ts): the click listener and the change listener are
 * added synchronously, as MV3 requires of every listener, and the first apply starts at once. Never throws: a browser
 * without these APIs keeps the manifest's popup.
 */
export function serveAction(c: Api | undefined = api()): ActionWorker {
  let plan: ActionPlan | undefined;
  let report: ((m: string) => void) | undefined;
  let pending: string | undefined;
  const problem = (m: string): void => {
    if (report) report(m);
    else pending ??= m;
  };
  const run = async () => {
    const local = c?.storage?.local;
    if (!local) return;
    const next = planAction(await local.get([OPENER_KEY, "sk_settings"]), panelSupported(c));
    plan = next;
    await applyAction(next, c);
  };
  const settle = (p: Promise<void>) => p.catch(() => problem("toolbar action: could not apply the side panel setting"));
  let chain: Promise<void> = Promise.resolve();
  const apply = () => (chain = settle(chain.then(run)));

  /**
   * The popup for this click instead of the panel: set for the clicked tab only (so the other tabs and windows keep the
   * panel, and the stored choice is untouched), and opened now where the browser allows it (Chrome 127+, so every Chrome
   * Sixkey runs on, 140+; where it refuses, the next click on that tab opens it). `failed`: the panel would not open, which the diagnostics log is told once; not
   * for a click that arrived while an apply was switching to the popup anyway.
   */
  const popupHere = (tab: { windowId: number; id?: number }, failed: boolean) => {
    if (failed) problem("toolbar action: the side panel did not open; the popup is used in that tab");
    void (async () => {
      if (tab.id !== undefined) await c?.action?.setPopup?.({ tabId: tab.id, popup: POPUP_PATH });
      await c?.action?.openPopup?.({ windowId: tab.windowId });
    })().catch(() => undefined);
  };
  /**
   * open() resolved. A window with no side panel (a popup-type or app window) resolves it too and shows nothing
   * [measured in headless Chromium 156: SIDEPANEL-NOTES.md §2], so the window's type is checked, after the fact: the
   * popup instead in anything but a normal browser window. Otherwise an open panel reads the clicked tab again: this
   * click granted activeTab for it (src/sidepanel/guard.ts).
   */
  const opened = (tab: { windowId: number; id?: number }) =>
    void (async () => {
      const w = await c?.windows?.get?.(tab.windowId);
      if (w?.type && w.type !== "normal") return popupHere(tab, true);
      await c?.storage?.session?.set({ [CLICK_KEY]: Date.now() });
    })().catch(() => undefined);

  try {
    c?.action?.onClicked?.addListener((tab) => {
      // Only fires while no popup is set, which only an apply that chose the panel does. A worker that has just started
      // has not read the settings yet (`plan` undefined) and goes by that; one that has read them and found the panel
      // no longer offered or chosen (a change it is applying) opens the popup instead.
      if (!panelSupported(c)) return popupHere(tab, true);
      if (plan && plan.opens !== "panel") return popupHere(tab, false);
      try {
        // In this call, with nothing awaited before it: open() only works in the user's action. The panel's path again
        // first, where the plan is known to offer it (never on a guess: a worker that has not read the profile yet
        // leaves the page as the last apply set it).
        if (plan?.offered) void c!.sidePanel!.setOptions!({ path: PANEL_PATH, enabled: true }).catch(() => undefined);
        void c!.sidePanel!.open!({ windowId: tab.windowId }).then(
          () => opened(tab),
          () => popupHere(tab, true),
        );
      } catch {
        popupHere(tab, true);
      }
    });
    // A change of the choice (the settings page) or of the profile (Security mode, the first run), from any page.
    c?.storage?.local?.onChanged?.addListener((changes) => {
      if (OPENER_KEY in changes || "sk_settings" in changes) void apply();
    });
  } catch {
    problem("toolbar action: no listener");
  }
  // The first apply's read is made now, in the worker's first synchronous run, ahead of every other read of the worker
  // (scripts/sw-order.mjs checks the built file): the later ones queue behind it.
  chain = settle(run());
  return {
    apply,
    onProblem(r) {
      report = r;
      if (pending !== undefined) r(pending);
      pending = undefined;
    },
    get plan() {
      return plan;
    },
  };
}
