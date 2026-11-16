// A code window's arithmetic, without any key or HMAC (hotp.ts re-exports it): what autofill may know of a code without
// making one (test/unit/plugins-w1b-source-rules.test.ts walks autofill's imports, which never reach hotp.ts).
export function totpCounter(timeMs: number, period: number): number {
  assertPeriod(period);
  return Math.floor(timeMs / 1000 / period);
}

/** Seconds (fractional) until the current code expires. */
export function secondsRemaining(timeMs: number, period: number): number {
  assertPeriod(period);
  return period - ((timeMs / 1000) % period);
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError("period must be a positive integer");
}
