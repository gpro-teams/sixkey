// The text of a lazily loaded part of the popup (the View menu, the Fill button): a lookup of the part's own, never the page's
// catalog (src/ui/i18n.ts), so a chunk that cannot be read costs that part its words and the rest of the popup nothing. This
// language's catalog is tried, then English's; with neither, `words()` is null and the part draws nothing of its own (a key
// name must never reach the screen). One helper for both parts (docs/design/notes/AUTOFILL1-NOTES.md §6a); it is imported by
// lazy chunks only, so it is not in the popup's counted bundle.
import { getLang, type Catalog, type Lang } from "./i18n";

declare const __I18N_GUARD__: boolean;
const GUARD = typeof __I18N_GUARD__ === "boolean" && __I18N_GUARD__;

export type LazyText = {
  /** A key's text, with $1..$9 replaced by `subs` (the same rules as t()); the key itself when it has none. */
  (key: string, ...subs: (string | number)[]): string;
  /** Settles when the text is in, or when neither language's could be read. */
  loaded: Promise<void>;
  /** undefined until `loaded`; null when no text could be read; else the text. */
  words(): Catalog | null | undefined;
};

/**
 * `load`: one literal import per language, so each language is its own chunk (scripts/build.mjs names them). Starts
 * reading at once. `report`: in test builds (__I18N_GUARD__) a key with no text is reported on the console, as t() does.
 */
export function lazyText(load: (lang: Lang) => Promise<Catalog>, report = false): LazyText {
  let words: Catalog | null | undefined;
  const loaded = (async () => {
    for (const lang of [getLang(), "en" as const]) {
      try {
        words = await load(lang);
        return;
      } catch {
        /* the next one */
      }
    }
    words = null;
  })();
  const text = (key: string, ...subs: (string | number)[]): string => {
    const entry = words?.[key];
    if (report && GUARD && words && !entry)
      console.error(`sixkey i18n: no text for ${JSON.stringify(key)} on ${location.pathname}`);
    return (entry?.message ?? key).replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1] ?? ""));
  };
  return Object.assign(text, { loaded, words: () => words });
}
