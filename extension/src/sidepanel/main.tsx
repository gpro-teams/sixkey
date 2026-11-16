// The side panel (docs/design/notes/SIDEPANEL-NOTES.md): the popup's screens (src/popup/boot.tsx, App), in a column beside
// the web page that stays open, with the panel's own rules (./guard.ts) and layout (./panel.css). Nothing here is in the
// popup's bundle: what the two pages share is one chunk, and this entry is the panel's alone.
import { render } from "preact";
import { boot } from "../popup/boot";
import { surface } from "../popup/surface";
import { t } from "../ui/i18n";
import { followTheme } from "../ui/theme-set";
import { panelHooks, sharedNow } from "./guard";
import "./panel.css";

/** Not in a shared profile: the panel closes itself and draws nothing (the worker does not offer it there either). */
function shut(): void {
  render(null, document.getElementById("app")!);
  window.close();
}

// The line for a tab the browser gives no address for (the icon was not clicked on it): beside the list and the add view,
// where "this site" would be and above a scan's failure (panel.css places it). Filled in when first shown, once the
// catalog is in (the list is only drawn after it).
const hint = document.createElement("p");
hint.id = "panel-hint";
hint.className = "panel-hint";
hint.setAttribute("role", "status");
hint.hidden = true;
document.body.append(hint);

followTheme(); // it stays open beside the settings page: a theme chosen there (or in the View menu of the popup) shows at once

surface.panel = panelHooks({
  chrome,
  doc: document,
  win: window,
  now: Date.now,
  setInterval: (f, ms) => window.setInterval(f, ms),
  clearInterval: (id) => window.clearInterval(id as number),
  shut,
  // (and recovery code shares typed on the lock screen, which leave their field: ui/ShareEntry.tsx marks what it holds)
  typed: () =>
    [...document.querySelectorAll("input")].some((i) => (i.type === "checkbox" ? i.checked : !!i.value)) ||
    document.querySelector("[data-sk-held]") !== null,
  // drawn again from storage: every field empty, every Show box off (the page is on its lock screen: no key in memory)
  wipe: () => location.reload(),
  hint(show) {
    if (show) hint.textContent = t("panelTabHint");
    hint.hidden = !show;
  },
});
// a page the browser kept and shows again (back/forward cache): drawn again from storage, with no key in memory
addEventListener("pageshow", (e: PageTransitionEvent) => {
  if (e.persisted) location.reload();
});

// The profile first: one read of the settings, before anything is drawn. A read that fails is not a shared profile
// (the lock screen then asks for the password as in the popup), and the guard looks again at every settings change.
void chrome.storage.local.get("sk_settings").then(
  (r) => (sharedNow(r.sk_settings) ? shut() : boot("panel")),
  () => boot("panel"),
);
