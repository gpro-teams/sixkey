// All user-visible text comes from _locales. The catalogs are bundled and looked up here rather than through
// chrome.i18n, because chrome.i18n only follows the browser's own UI language and cannot be changed in the app:
// someone running an English browser who reads Chinese would be stuck. The choice is "auto" (follow the browser,
// any Chinese variant gets Chinese), English, or Chinese, kept in localStorage so every extension page reads it
// synchronously before its first render.
//
// Only the chosen language's catalog is loaded (PHASE0X-PLAN O5): each page awaits loadCatalog(source) before it
// renders, and the build puts each catalog in its own chunk (named in scripts/build.mjs), so a page never parses the
// language it does not show. Each page passes its own source, and this module imports no catalog itself, so a page can
// only ever load the catalogs its own entry names:
//   - the settings page: its text in parts, each loaded before that part is drawn (src/options/parts.tsx, which passes
//     loadCatalog the parts loaded so far; assets/settings-locale-<part>-<lang>-*.js; docs/design/notes/BUDGET-NOTES.md);
//   - the popup: catalogs of only the keys popup code can use (src/popup/main.tsx, assets/popup-locale-<lang>-*.js),
//     which the build works out from the syntax tree (scripts/catalog-keys.mjs) and checks. check-dist counts the
//     larger catalog the popup can load in its budget.

export type Catalog = Record<string, { message: string }>;
/**
 * Where a page's catalogs come from: one literal import() per language, so each language is its own chunk, taking only
 * `.default` (the whole module would keep the JSON plugin's per-key named exports in the chunk too).
 */
export type CatalogSource = (lang: Lang) => Promise<Catalog>;
export type Lang = "en" | "zh_CN";
export type LangChoice = "auto" | Lang;

const PREF_KEY = "sk_lang";

function storedChoice(): LangChoice {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "en" || v === "zh_CN" ? v : "auto";
  } catch {
    return "auto";
  }
}

function browserLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return typeof navigator !== "undefined" ? navigator.language : "en";
  }
}

export function resolveLang(choice: LangChoice, browser: string = browserLanguage()): Lang {
  if (choice !== "auto") return choice;
  return /^zh\b/i.test(browser) ? "zh_CN" : "en"; // zh, zh-CN, zh-TW, zh-HK, zh-Hans...: the only Chinese catalog is Simplified
}

let current: Lang = resolveLang(storedChoice());
let catalog: Catalog = {};

export const getChoice = storedChoice;
export const getLang = (): Lang => current;

/** Remember the choice and apply it. Pages reload afterwards; anything else calls loadCatalog() again. */
export function setLangChoice(choice: LangChoice): void {
  try {
    if (choice === "auto") localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, choice);
  } catch {
    /* without storage the choice lasts for this page only */
  }
  current = resolveLang(choice);
}

/**
 * Load the current language's catalog from the page's source. Never rejects: if that chunk cannot be loaded the English
 * one is used, and if that fails too, t() shows key names, which still renders a page rather than a blank one. When
 * calls overlap, the catalog for the language current at the end wins.
 */
export async function loadCatalog(source: CatalogSource): Promise<void> {
  const lang = current;
  let next: Catalog;
  try {
    next = await source(lang);
  } catch {
    try {
      next = await source("en");
    } catch {
      next = {};
    }
  }
  if (lang === current) catalog = next;
}

// Test builds only (scripts/build.mjs defines it for --e2e and --dev; prod builds compile this out): a key with no text
// in the loaded catalog is reported on the console, which test/e2e/harness.ts turns into a failed test, so a key name
// shown on screen cannot pass the e2e suite.
declare const __I18N_GUARD__: boolean;
const GUARD = typeof __I18N_GUARD__ === "boolean" && __I18N_GUARD__;

export function t(key: string, ...subs: (string | number)[]): string {
  const entry = catalog[key];
  if (GUARD && !entry) console.error(`sixkey i18n: no text for ${JSON.stringify(key)} on ${location.pathname}`);
  const msg = entry?.message ?? key; // a missing key shows itself; both catalogs have the same keys (generator + i18n test)
  return msg.replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1] ?? ""));
}

const locale = () => (current === "zh_CN" ? "zh-CN" : "en-GB");

/** Dates in the language the user picked, not the browser's: "2026年10月15日 18:31" or "15 Oct 2026, 18:31". */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(locale(), { dateStyle: "medium" });
}
