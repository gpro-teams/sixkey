// The Fill button's text (TOTP-AUTOFILL Stage 1): a catalog of its own, catalogs/autofill-<lang>.json (scripts/messages.py,
// the fragments' AUTOFILL_EN / AUTOFILL_ZH tables), loaded with the lazy chunk Fill.tsx and not counted in the popup's
// catalog, which has no room for it (docs/design/notes/AUTOFILL1-NOTES.md §6). The words the popup already has (Cancel) stay
// t()'s. The lookup is src/ui/lazy-text.ts's, as the View menu's is: when no text can be read, Fill.tsx draws nothing.
import { lazyText } from "../../ui/lazy-text";

/** One literal import per language, so each is its own chunk (assets/autofill-locale-<lang>-*.js); only `.default`. */
export const ft = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../../catalogs/autofill-zh_CN.json")).default
      : (await import("../../../catalogs/autofill-en.json")).default,
  true,
);
