// Types for catalog-keys.mjs, for the tests that import it (test/unit/i18n-collector.test.ts, i18n-popup.test.ts).
import type { CompilerOptions } from "typescript";

export type Catalog = Record<string, { message: string }>;
/** An expression the tracer cannot follow, with what it can hold. A family is a key pattern; * is any run of key characters. */
export type AllowEntry = { file: string; code: string; keys?: string[]; families?: string[]; why: string };
export type Collected = {
  /** Every key to keep, in catalog order: the traced ones and the mentioned ones. */
  keys: string[];
  /** The modules read, relative to root, sorted. */
  modules: string[];
  /** Reads of the catalog found (catalog[key]). */
  lookups: number;
  /** Keys a catalog read can get (literals, families, allowlist). */
  traced: string[];
  /** Keys mentioned anywhere in the modules (the fallback). */
  mentioned: string[];
  families: { at: string; pattern: string; keys: string[] }[];
};

export const POPUP_CATALOG_PREFIX: string;
export const POPUP_ALLOW: AllowEntry[];
export class CatalogKeysError extends Error {
  problems: string[];
  constructor(problems: string[]);
}
export function moduleEntriesOfHtml(htmlFile: string): string[];
export function tsOptions(tsconfig: string): CompilerOptions;
export function collectKeys(o: {
  root: string;
  entries: string[];
  keys: string[];
  catalogModule: string;
  catalogBinding?: string;
  allow?: AllowEntry[];
  catalogImports?: string[];
  compilerOptions?: CompilerOptions;
  /** The in-page suggestion's release gate; false: `SUGGEST_UI && ...` (the gate's idiom) is not the page's (rule 5). */
  suggestUi?: boolean;
  /** Modules the walk does not enter: the parts' entries, for a page's own core (rule 6). */
  stop?: string[];
  /** The entries are a part's: a lookup that reaches what their exported functions are passed fails (rule 6). */
  part?: boolean;
  /** The page's own catalog files (absolute paths): text, not code (rule 6). */
  pageCatalogs?: (file: string) => boolean;
}): Collected;
export function subsetCatalog(catalog: Catalog, keys: string[], lang?: string): Catalog;
export function readCatalogs(root: string): Record<string, Catalog>;
export function popupKeys(root: string, catalogs?: Record<string, Catalog>, o?: { suggestUi?: boolean }): Collected;
/** The popup's View menu (docs/design/notes/QUICKVIEW-NOTES.md): its module (relative to extension/), loaded when the menu opens. */
export const VIEW_ENTRIES: string[];
export const VIEW_CATALOG_FILE: RegExp;
/** The keys the View menu can show, from its own module (rule 6). */
export function viewKeys(root: string, catalogs?: Record<string, Catalog>, o?: { suggestUi?: boolean }): Collected;
/** The settings page's text parts: each part's entry modules (relative to extension/). */
export const SETTINGS_PARTS: Record<string, string[]>;
export function settingsKeys(
  root: string,
  catalogs?: Record<string, Catalog>,
  o?: { suggestUi?: boolean },
): { core: Collected; parts: Record<string, Collected> };
