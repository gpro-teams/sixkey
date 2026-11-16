// The colour theme: follow the system, or always light, or always dark (PHASE0X-PLAN C4; ux-study §2.7). Like the
// language it is a per-browser choice kept in localStorage, not a vault setting, so every extension page can read it
// synchronously before it draws anything.
//
// public/theme-boot.js applies the stored choice before the first paint: it is a classic script in each page's <head>,
// loaded by src= because the CSP allows no inline script. It repeats the key and values below; test/unit/theme.test.ts
// keeps the two in step. styles.css does the rest: no data-theme follows prefers-color-scheme, data-theme="light" or
// "dark" overrides it. Changing the choice, and following a change made on another page, are in ./theme-set.ts, so a page
// that only applies it (the toolbar popup) does not carry them.

export type ThemeChoice = "auto" | "light" | "dark";
export const THEME_CHOICES: readonly ThemeChoice[] = ["auto", "light", "dark"];

export const THEME_KEY = "sk_theme";

/** The stored choice; "auto" when there is none, it is not one of ours, or storage cannot be read. */
export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

/**
 * Put a choice on the page: the data-theme attribute the stylesheets key on, and the color-scheme meta, which sets the
 * browser's own canvas and controls before any stylesheet applies.
 */
export function applyTheme(choice: ThemeChoice = getThemeChoice(), doc: Document = document): void {
  const root = doc.documentElement;
  if (choice === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", choice === "auto" ? "light dark" : choice);
}
