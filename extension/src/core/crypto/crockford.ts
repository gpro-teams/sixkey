// The Crockford base32 reading every Sixkey code shares (the recovery code, the pairing code): the
// alphabet, and how typed text is read: full-width forms as their ASCII (NFKC: a Chinese IME in 全角 types ＡＢＣ１２３ and
// －, as pin.ts reads a PIN); any case; spaces, hyphens and underscores ignored; O read as 0, I and L as 1. A module that
// imports nothing, so a lazy chunk can use it (crypto-error.ts says why that matters).
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U

/** NFKC first (full-width ＡＢＣ１２３ and － are ABC123 and -); then any case, spaces, hyphens and underscores; O as 0, I/L as 1. */
export function normalizeCrockford(input: string): string {
  return input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\-_]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}
