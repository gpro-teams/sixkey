// The backup in Chrome's sync storage's popup text: a catalog of its own, catalogs/csb-popup-<lang>.json
// (scripts/messages.py, the fragment scripts/i18n/csbpopup.py's CSB_POPUP_EN / CSB_POPUP_ZH): the header pill, the
// footer's words on a problem and the welcome's copy found, in the popup and the side panel, loaded with their lazy
// chunks (src/popup/main/CsbPop.tsx, src/popup/screens/CsbFound.tsx) and counted in neither page's up-front budget; the
// settings page never loads it (check-dist). The lookup is lazy-text.ts's: until the text is in, nothing of it is drawn.
// "Chrome 同步" is written as this browser's word for it, the catalog's cbBrowser, where the browser is not Google
// Chrome (csb-brand.ts, as on the settings page); none of these lines names a Google account.
import { branded, isChrome } from "./csb-brand";
import { lazyText, type LazyText } from "./lazy-text";

/** One literal import per language, so each is its own chunk (assets/csb-popup-locale-<lang>-*.js); only `.default`. */
const text = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/csb-popup-zh_CN.json")).default
      : (await import("../../catalogs/csb-popup-en.json")).default,
  true,
);

/** A key's text, as lazy-text.ts gives it, with "Chrome Sync" written as this browser's word for it. */
export const cb: LazyText = Object.assign(
  (key: string, ...subs: (string | number)[]) => branded(text(key, ...subs), isChrome(), text("cbBrowser")),
  { loaded: text.loaded, words: text.words },
);
