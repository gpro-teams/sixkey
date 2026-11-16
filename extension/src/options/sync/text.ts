// The Sync section's own text (SYNC-DESIGN §6; M6). Its keys live in a catalog of their own, in two files that
// scripts/messages.py writes: catalogs/sync-<lang>.json (the fragments' SYNC_EN and SYNC_ZH tables) and the managing
// screens' catalogs/sync-manage-<lang>.json (SYNC_MANAGE_EN, SYNC_MANAGE_ZH; a file of its own since the budget relief,
// docs/design/notes/BUDGET-NOTES.md). Both are loaded with the section's code, before it is drawn, never by the popup and
// never into the settings page's other catalogs, so a build without the sync user interface (scripts/sync-ui.mjs)
// carries none of it. check-dist finds the chunks by name (assets/sync-locale-<lang>-*.js,
// assets/sync-manage-locale-<lang>-*.js) and counts each against its own limit.
//
// st(key) looks a key up in this catalog; the words the section shares with the rest of the page (Cancel, Continue,
// Password, ...) stay t()'s, from the core text the page has already loaded (src/options/parts.tsx). Both report a missing
// key the same way in test builds (__I18N_GUARD__), which the end-to-end harness turns into a failed test.
import { getLang, type Catalog, type CatalogSource } from "../../ui/i18n";

/**
 * One literal import per file and language, so each is its own chunk; only `.default` (see src/ui/catalog-full.ts). The
 * two files are fetched side by side; their keys are disjoint (scripts/messages.py); both are this language's, or the
 * English fallback is used for both.
 */
export const syncCatalog: CatalogSource = async (lang) => {
  const [main, manage] = await Promise.all(
    lang === "zh_CN"
      ? [
          import("../../../catalogs/sync-zh_CN.json").then((m) => m.default),
          import("../../../catalogs/sync-manage-zh_CN.json").then((m) => m.default),
        ]
      : [
          import("../../../catalogs/sync-en.json").then((m) => m.default),
          import("../../../catalogs/sync-manage-en.json").then((m) => m.default),
        ],
  );
  return { ...main, ...manage };
};

let text: Catalog = {};

/**
 * Loads the current language's sync text. Never rejects: if that chunk cannot be loaded the English one is used, and if
 * that fails too st() shows key names (the page still works).
 */
export async function loadSyncText(source: CatalogSource = syncCatalog): Promise<void> {
  const lang = getLang();
  try {
    text = await source(lang);
  } catch {
    try {
      text = await source("en");
    } catch {
      text = {};
    }
  }
}

declare const __I18N_GUARD__: boolean;
const GUARD = typeof __I18N_GUARD__ === "boolean" && __I18N_GUARD__;

/** A key of the Sync section's catalog, with $1..$9 replaced by `subs` (the same rules as t()). */
export function st(key: string, ...subs: (string | number)[]): string {
  const entry = text[key];
  if (GUARD && !entry) console.error(`sixkey i18n: no text for ${JSON.stringify(key)} on ${location.pathname}`);
  const msg = entry?.message ?? key;
  return msg.replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1] ?? ""));
}

/**
 * A day as the server keeps it (a device's last sync, §2.4: to the day, a UTC midnight), in the page's language. Formatted
 * in UTC: in the local time zone, a midnight UTC falls on the day before anywhere west of Greenwich.
 */
export function formatServerDay(ms: number): string {
  return new Date(ms).toLocaleDateString(getLang() === "zh_CN" ? "zh-CN" : "en-GB", {
    dateStyle: "medium",
    timeZone: "UTC",
  });
}
