// A 28-character code as typed (the recovery code, the pairing code of an approval join): read the way the code is read
// (core/crypto/recovery-code.ts normalizeRecoveryInput: any case, spaces and hyphens ignored, O as 0, I and L as 1), and
// grouped for showing. Shared by the settings page's one code input (shared.tsx CodeField) and the Sync section.
import { normalizeRecoveryInput } from "../core/crypto/recovery-code";

/** Symbols in a code: 7 groups of 4. */
export const CODE_SYMBOLS = 28;

/**
 * The symbols typed so far, read the way the code is read: all of them. A 29th is not cut off (the code's reading says
 * "not a code" for it, MUST 10, and the field says it is too long), so that what was pasted is what is checked.
 */
export const codeSymbols = (input: string): string => normalizeRecoveryInput(input);

/** Groups of four joined by "-" ("ABCD-EFGH-..."), for showing a code as it is typed. */
export const codeGroups = (symbols: string): string => symbols.match(/.{1,4}/g)?.join("-") ?? "";
