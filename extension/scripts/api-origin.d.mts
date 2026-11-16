// Types for api-origin.mjs, for the tests that import it (test/unit/m5-source-rules.test.ts).
export declare const API_ORIGINS: Readonly<{ prod: string; dev: string; e2e: string }>;
export declare function hostPermissionOf(origin: string): string;
export declare function cspOf(origin: string | null, extra?: readonly string[]): string;
