// The full catalogs, every key in both languages: the tests' source for loadCatalog. No page loads them: the popup loads
// its own, smaller ones (src/popup/main.tsx) and the settings page its text in parts (src/options/parts.tsx).
// scripts/catalog-keys.mjs fails the build if popup code imports this module or a _locales file (and the settings
// page's test, test/unit/budget-split.test.ts, if the settings page's does), scripts/build.mjs fails the build if either
// page's module graph holds a _locales file, and check-dist fails if a build carries a chunk of them.
import type { CatalogSource } from "./i18n";

// Two literal imports, one per branch, so the bundler makes exactly one chunk per language.
export const fullCatalog: CatalogSource = async (lang) =>
  lang === "zh_CN"
    ? (await import("../../_locales/zh_CN/messages.json")).default
    : (await import("../../_locales/en/messages.json")).default;
