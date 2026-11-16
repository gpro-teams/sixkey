// Types for rules-guard.mjs, for its test (test/unit/rules-update-gate.test.ts).
export declare const GATED_IN_SRC: RegExp;
export declare const RULES_UPDATE_OFF: string;
export declare function gated(path: string, src: string): boolean;
export declare function rulesGuard(
  on: boolean,
  srcRoot?: string,
): {
  name: string;
  enforce: "pre";
  resolveId(source: string, importer?: string): string | null;
  load(id: string): string | null;
  buildEnd(this: { getModuleIds(): Iterable<string>; error(m: string): never }, err?: unknown): void;
};
