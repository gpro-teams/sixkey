// Types for rules-keys.mjs, for the tests that import it (test/unit/rules-update-gate.test.ts, rules-sign.test.ts).
export type RulesKey = { kid: string; spki: string };
export declare const STORE_RULES_KEYS: RulesKey[];
export declare const TEST_RULES_KEYS: RulesKey[];
export declare function rulesKeysOf(flavour: "prod" | "dev" | "e2e"): RulesKey[];
export declare function pointOf(k: unknown): string | null;
export declare function sameKey(a: unknown, b: unknown): boolean;
export declare function keyOrderProblem(previous: unknown, next: unknown, ever?: unknown): string | null;
