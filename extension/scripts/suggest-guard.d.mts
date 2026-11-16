// Types for suggest-guard.mjs, for its test (test/unit/autofill4b-build.test.ts).
export declare const SUGGEST_OFF: string;
export declare function suggestGuard(on: boolean): {
  name: string;
  enforce: "pre";
  resolveId(source: string, importer?: string): string | null;
  load(id: string): string | null;
  buildEnd(this: { getModuleIds(): Iterable<string>; error(m: string): never }, err?: unknown): void;
};
