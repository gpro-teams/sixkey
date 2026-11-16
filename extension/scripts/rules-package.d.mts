// Types for rules-package.mjs, for the tests that hold the build's rules files and the store package's source gate to it
// (test/unit/rules-package.test.ts, m5-build-guard.test.ts).
export const RULES_DIR: string;
export const BASELINE_SOURCE: string;
export const PACKAGED_BASELINE: string;
export const PACKAGED_LICENCE: string;
export const LICENCE_LINE: string;
export function extensionLicenceText(): string;
export function rulesLicenceText(): string;
export function checkedBaseline(
  raw?: string,
  what?: string,
  o?: { allowReserved?: boolean },
): Promise<{ text: string; bundle: unknown; maxBytes: number }>;
export const E2E_RULES_DIR: string;
export function e2eBaselineText(raw: string, dir?: string): Promise<string>;
export function normalised(code: string): string;
export function dataProbes(raw: string): string[];
export function sourceGate(raw?: string, template?: string): string | null;
