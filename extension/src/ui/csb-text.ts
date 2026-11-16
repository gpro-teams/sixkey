// The backup in Chrome's sync storage: the settings page's text, a catalog of its own, catalogs/csb-<lang>.json
// (scripts/messages.py, the fragment scripts/i18n/csb.py's CSB_EN / CSB_ZH): Settings › Backup's card, first run's box,
// the restore from Chrome Sync, what a restore found, and "Choose file" opening a downloaded copy of the backup. Loaded
// with those lazy chunks and counted in no page's up-front budget (check-dist holds it to its own and keeps it from the
// popup and the side panel). The lookup is lazy-text.ts's: until the text is in, or when neither language's can be
// read, nothing of it is drawn.
// Where the browser is not Google Chrome (navigator.userAgentData's brands name no "Google Chrome": Edge, Brave,
// Chromium), "Chrome Sync" is written as the catalog's csBrowser ("browser sync"; csb-brand.ts, which the popup's text
// shares): what syncs there, and whether it carries an extension's data, is that browser's, and Sixkey does not know
// it. The lines that speak of a Google account or of Chrome itself have their own text there (`<key>Other`): its
// account may be another.
import { branded, isChrome } from "./csb-brand";
import { lazyText, type LazyText } from "./lazy-text";

export { branded, isChrome };

/** One literal import per language, so each is its own chunk (assets/csb-locale-<lang>-*.js); only `.default`. */
const text = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/csb-zh_CN.json")).default
      : (await import("../../catalogs/csb-en.json")).default,
  true,
);

/** The keys whose text names a Google account or Chrome itself: elsewhere, their `<key>Other` text. */
const OTHER: ReadonlySet<string> = new Set(["csBody", "csCost", "csCostRecovery", "csShared"]);

/**
 * A key's text, as lazy-text.ts gives it, with "Chrome Sync" written as this browser's word for it, and in a browser
 * that is not Google Chrome, a line about the Google account in its own words.
 */
export const cs: LazyText = Object.assign(
  (key: string, ...subs: (string | number)[]) => {
    const chrome = isChrome();
    return branded(text(!chrome && OTHER.has(key) ? `${key}Other` : key, ...subs), chrome, text("csBrowser"));
  },
  { loaded: text.loaded, words: text.words },
);
