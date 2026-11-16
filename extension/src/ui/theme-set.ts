// Changing the colour theme (src/ui/theme.ts reads and applies it): the pages that offer the choice, and the ones that stay
// open beside another and follow it. A module of its own so the toolbar popup's counted bundle, which only applies the
// stored choice, carries none of it: the View menu loads it with the menu (src/popup/main/View.tsx).
import { applyTheme, getThemeChoice, THEME_KEY, type ThemeChoice } from "./theme";

/** Remember a choice and apply it to this page. Other pages that follow it (followTheme) pick it up at once, the rest when they next load. */
export function setThemeChoice(choice: ThemeChoice, doc: Document = document): void {
  try {
    if (choice === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* without storage the choice lasts for this page only */
  }
  applyTheme(choice, doc);
}

/**
 * Follow a choice made on another extension page while this one is open: a write to localStorage fires `storage` in the
 * other documents of the origin, not in the writer's. Applies it to this page and tells `then`. The pages that stay open
 * beside another (the side panel, the settings page, the View menu) use it; the toolbar popup closes when it loses the
 * focus, so there is nothing to follow. Returns the clean-up.
 */
export function followTheme(then?: (choice: ThemeChoice) => void, win: Window = window): () => void {
  const on = (e: StorageEvent) => {
    if (e.key !== THEME_KEY && e.key !== null) return; // another key, or `clear()` (key null)
    const choice = getThemeChoice();
    applyTheme(choice, win.document);
    then?.(choice);
  };
  win.addEventListener("storage", on);
  return () => win.removeEventListener("storage", on);
}
