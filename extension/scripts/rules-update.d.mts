// Types for rules-update.mjs, for the tests that import it (test/unit/rules-update-gate.test.ts).
export declare const RULES_UPDATE_IN_STORE_BUILD: boolean;
export declare function rulesUpdateIn(flavour: "prod" | "dev" | "e2e"): boolean;
export declare const RULES_ORIGINS: { prod: string; dev: string; e2e: string };
export declare function updaterProblems(
  flavour: "prod" | "dev" | "e2e",
  o?: { keys?: unknown; origin?: unknown },
): Promise<string[]>;
export declare function storeOrigin(origin: string): boolean;
export declare function testRulesHosts(origins?: { prod: string; dev: string; e2e: string }): string[];
/** The one path of the rules origin the updater reads, and the CSP names with the gate open: `${origin}/v1/`. */
export function rulesPathOf(origin: string): string;
