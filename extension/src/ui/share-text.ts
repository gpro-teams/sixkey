// The recovery code shares' text (docs/design/notes/SHAMIR-NOTES.md §6): a catalog of its own, catalogs/shares-<lang>.json
// (scripts/messages.py, the fragment scripts/i18n/shares.py's SHARES_EN / SHARES_ZH), loaded with the shares' lazy chunks
// (ShareEntry.tsx here, used by the popup's lock screen, the side panel's and the settings page's recovery code fields;
// options/ShareWizard.tsx) and counted in no page's up-front budget. The lookup is lazy-text.ts's, as the View menu's and
// the Fill button's are: until the text is in, or when neither language's can be read, the shares draw nothing of their own.
import { lazyText } from "./lazy-text";

/** One literal import per language, so each is its own chunk (assets/shares-locale-<lang>-*.js); only `.default`. */
export const sx = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/shares-zh_CN.json")).default
      : (await import("../../catalogs/shares-en.json")).default,
  true,
);
