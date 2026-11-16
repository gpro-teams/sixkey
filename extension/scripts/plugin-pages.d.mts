// Types for plugin-pages.mjs, for the test that holds it to made-up builds (test/unit/check-dist-plugin-pages.test.ts).
/** `from`: the one view whose chunks (assets/<from>*.js) may name the kind's text (none since the change list went). */
export type PluginTextKind = { name: string; pages: string[]; not: string[]; from?: string };
export declare const SETTINGS_PAGE: string[];
export declare const POPUP_PAGES: string[];
export declare const PLUGIN_TEXT_KINDS: PluginTextKind[];
export declare function pluginPageProblems(
  dist: string,
  textsOf: ReadonlyMap<string, readonly string[]>,
  kinds?: readonly PluginTextKind[],
): string[];
