// Which page draws the popup's screens: the toolbar popup, or the side panel (src/sidepanel/), which reuses them
// (docs/design/notes/SIDEPANEL-NOTES.md). The side panel's entry fills in `panel` before anything is drawn; in the popup it
// stays undefined, and these few seams cost the popup's budget a few bytes, not the panel's code, which lives in the panel's
// own entry. What differs:
//   - the way to the settings page: the popup closes itself, the panel stays open (chrome.tsx openOptions);
//   - the current site: the popup reads the active tab once, the panel follows it (main/Main.tsx);
//   - activity: the popup counts every load that reaches the list as use (App), the panel only the user's own input,
//     and it follows changes made elsewhere and locks after 15 idle minutes (src/sidepanel/guard.ts).
import type { PopupRuntime } from "../platform/runtime-base";

export type PanelHooks = {
  /**
   * The list is on screen (App, after every load that reaches it). In place of the popup's "touch the session and re-arm
   * the idle alarm": a long-lived page must not count its own reloads as use.
   */
  shown(rt: PopupRuntime): void;
  /** App's runtime, its reload and the screen it shows, once it is drawn; returns the clean-up. */
  attach(rt: PopupRuntime, reload: () => Promise<void>, showing: () => string): () => void;
  /** Call `again` whenever the active tab may have changed; returns the clean-up. */
  watchTab(again: () => void): () => void;
};

export const surface: { panel?: PanelHooks } = {};
