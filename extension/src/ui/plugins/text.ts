// The autofill switch's text (Settings › Security › Autofill: the switch and its recent requests), the catalog the
// removed plugin platform's settings-page text had: catalogs/plugins-<lang>.json (scripts/messages.py, the fragments'
// PLUGINS tables: scripts/i18n/plugins.py, w1b.py, w2a.py), loaded with the switch's lazy chunk and counted in no page's
// up-front budget. The popup and the side panel never load it (scripts/check-dist.mjs). The lookup is lazy-text.ts's, as
// the shares' and the Fill button's are: until the text is in, or when neither language's can be read, the switch draws
// nothing.
import { lazyText } from "../lazy-text";

/** One literal import per language, so each is its own chunk (assets/plugins-locale-<lang>-*.js); only `.default`. */
export const px = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../../catalogs/plugins-zh_CN.json")).default
      : (await import("../../../catalogs/plugins-en.json")).default,
  true,
);
