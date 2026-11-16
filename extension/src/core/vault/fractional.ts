// Fractional ordering keys: a string that sorts between two others, so moving one entry changes one value
// and two devices reordering different entries never conflict. Based on the midpoint scheme of rocicorp/fractional-indexing.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0]!;
const KEY_RE = /^[0-9A-Za-z]*[1-9A-Za-z]$/; // no trailing zero digit

export function isOrderKey(k: unknown): k is string {
  return typeof k === "string" && k.length > 0 && k.length <= 64 && KEY_RE.test(k);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new RangeError("a must be less than b");
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) throw new RangeError("trailing zero");
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

/** A key strictly between `before` and `after`; null means the start or end of the list. */
export function orderBetween(before: string | null, after: string | null): string {
  if (before !== null && !isOrderKey(before)) throw new RangeError("bad key");
  if (after !== null && !isOrderKey(after)) throw new RangeError("bad key");
  if (before !== null && after !== null && before >= after) throw new RangeError("before must sort before after");
  return midpoint(before ?? "", after);
}
