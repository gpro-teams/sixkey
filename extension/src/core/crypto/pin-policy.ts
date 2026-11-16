// The policy for a new PIN (QUICK-UNLOCK §5.4 step 4): 4 to 8 digits; one that is too easy to guess is said to be so,
// and taken all the same (OWNER-DECISIONS/20, 2026-10-30: warn, do not block). Only the settings page sets a PIN, so this
// module is not in the popup's bundle (the lock screen needs only normalizePin).
import { normalizePin } from "./pin";

/**
 * Common PINs the rules below do not already catch (repeated digits, runs, a repeated block): years people pick, the
 * keypad's middle column, and the lists' most frequent 6- to 8-digit choices. Short on purpose (§5.4 step 4); the
 * 5-try limit does the rest.
 */
const COMMON = new Set([
  "1004",
  "2000",
  "2001",
  "1122",
  "2580",
  "0852",
  "1998",
  "1999",
  "112233",
  "123321",
  "147258",
  "147369",
  "147852",
  "159357",
  "159753",
  "741852",
  "789456",
  "963852",
  "102030",
  "112358",
  "1234321",
  "5201314",
  "1314520",
  "11223344",
  "12344321",
]);

/** Each digit one more (or one less) than the one before, 9 and 0 next to each other: 1234, 7890, 987654, 3210. */
function isRun(p: string): boolean {
  const steps = new Set<number>();
  for (let i = 1; i < p.length; i++) steps.add((Number(p[i]) - Number(p[i - 1]) + 10) % 10);
  return steps.size === 1 && (steps.has(1) || steps.has(9));
}

/** A shorter block repeated: 1212, 6969, 123123, 520520. All one digit is the block of length 1. */
function isRepeated(p: string): boolean {
  for (let n = 1; n <= p.length / 2; n++)
    if (p.length % n === 0 && p.slice(0, n).repeat(p.length / n) === p) return true;
  return false;
}

export type PinCheck = { ok: true; pin: string; weak: boolean } | { ok: false; reason: "format" };

/** The policy for a new PIN (§5.4 step 4): 4 to 8 digits; `weak`, too easy to guess (said, not refused). */
export function checkPinPolicy(input: string): PinCheck {
  const pin = normalizePin(input);
  if (pin === null) return { ok: false, reason: "format" };
  return { ok: true, pin, weak: isRepeated(pin) || isRun(pin) || COMMON.has(pin) };
}
