// RFC 4648 base32, lenient on input (full-width forms as their ASCII, NFKC: a key typed in a Chinese IME's 全角 mode;
// case, spaces, hyphens, '=' padding), strict on alphabet. NFKC changes the reading of nothing that read before (every
// code point is checked: test/unit/nfkc-codes.test.ts); full-width ０, １, ８ and ９ stay refused, as 0, 1, 8 and 9 are.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const LOOKUP: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export class Base32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base32Error";
  }
}

/** NFKC (full-width ＡＢ２３ is AB23), uppercase, strip whitespace, hyphens and padding. Does not validate. */
export function cleanBase32(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\s\-=]/g, "")
    .toUpperCase();
}

/** Canonical form used for storage: uppercase, no spaces, no padding. Throws on invalid characters. */
export function normalizeBase32(input: string): string {
  const s = cleanBase32(input);
  for (const ch of s) if (!(ch in LOOKUP)) throw new Base32Error("invalid base32 character");
  return s;
}

export function decodeBase32(input: string): Uint8Array {
  const s = normalizeBase32(input);
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    acc = (acc << 5) | LOOKUP[ch]!;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}
