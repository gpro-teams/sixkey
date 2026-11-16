// Drawing the popup's screens on a page: the toolbar popup (./main.tsx) and the side panel (../sidepanel/main.tsx) both
// start here, so neither entry holds more than a call (each page's entry is a chunk of its own, and what they share is
// counted once in the popup's budget: docs/design/notes/SIDEPANEL-NOTES.md).
import { render } from "preact";
import "../ui/styles.css";
import "./popup.css";
import { getLang, loadCatalog, type CatalogSource } from "../ui/i18n";
import { applyTheme } from "../ui/theme";
import { App } from "./App";

/** `page`: the body's class, which the page's stylesheet keys on ("popup", "panel"). */
export function boot(page: string): void {
  document.documentElement.lang = getLang() === "zh_CN" ? "zh-CN" : "en";
  applyTheme(); // public/theme-boot.js already did this before the first paint; again in case that script did not run

  document.body.classList.add(page);
  // The popup's own catalogs: only the keys that popup and side panel code, and the modules they load later (the
  // confirm page), can use. The build works them out from the syntax tree and checks them (scripts/catalog-keys.mjs,
  // scripts/build.mjs); the settings page loads its own, in parts (src/options/parts.tsx); nothing here may import those,
  // nor the full catalogs (src/ui/catalog-full.ts, the tests' source).
  const popupCatalog: CatalogSource = async (lang) =>
    lang === "zh_CN"
      ? (await import("virtual:popup-catalog/zh_CN")).default
      : (await import("virtual:popup-catalog/en")).default;

  // No top-level await: it switches off the bundler's chunk optimisation for the whole build (+popup bytes).
  // loadCatalog only loads this language's text and never rejects (falls back to English).
  void loadCatalog(popupCatalog).then(() => render(<App />, document.getElementById("app")!));
}
