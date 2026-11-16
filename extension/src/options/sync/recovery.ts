// The recovery code in the sync flows (SYNC-DESIGN §3.1 step 4, I9; §6 O3, O7). Sixkey never stores the recovery code
// itself, only a key wrapped by it, so turning sync on needs it once more: typed by the user, or made new, shown, and
// confirmed by typing back two of its groups before anything is written (show before commit, A4, §0.0i item 14).
import { normalizeRecoveryInput } from "../../core/crypto/recovery-code";
import { CODE_SYMBOLS, codeGroups, codeSymbols } from "../code-text";

/** The code as seven groups of four symbols ("ABCD-EFGH-..."), from what was typed (spaces, hyphens, any case). */
export const GROUPS = 7;
export const GROUP_LENGTH = 4;

/** What the user typed, normalised the way the code is read (Crockford: O as 0, I and L as 1), grouped for display. */
export const groupedInput = (input: string): string => codeGroups(codeSymbols(input));

/** Whether `input` has a code's length (the recovery or the pairing code; its check bits are checked where it is used). */
export const fullLength = (input: string): boolean => normalizeRecoveryInput(input).length === CODE_SYMBOLS;

/** Two different groups to type back, in order (1-based for the screen: "group 2 and group 6"). */
export function pickGroups(random: () => number = cryptoRandom): [number, number] {
  const a = Math.floor(random() * GROUPS);
  let b = Math.floor(random() * (GROUPS - 1));
  if (b >= a) b += 1;
  return a < b ? [a, b] : [b, a];
}

/** Whether the two typed groups are those of `code` at `groups` (0-based), read the way the code is read. */
export function groupsMatch(
  code: string,
  groups: readonly [number, number],
  typed: readonly [string, string],
): boolean {
  const parts = code.split("-");
  return groups.every((g, i) => parts[g] !== undefined && normalizeRecoveryInput(typed[i] ?? "") === parts[g]);
}

function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}
