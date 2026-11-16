// A floor for master passwords, not a strength guarantee. Real strength estimation (dictionary and pattern aware)
// is an open decision: see docs/security/local-vault.md. This catches the obviously weak ones.
const COMMON = new Set([
  "password",
  "password1",
  "123456789012",
  "qwertyuiop12",
  "iloveyou1234",
  "letmein12345",
  "administrator",
  "welcome12345",
  "changeme1234",
  "1234567890ab",
]);

export type PolicyResult = { ok: boolean; reasons: ("too_short" | "too_repetitive" | "sequence" | "common")[] };

export const MIN_PASSWORD_LENGTH = 12;

export function checkPasswordPolicy(password: string): PolicyResult {
  const p = password.normalize("NFKC");
  const chars = [...p];
  const reasons: PolicyResult["reasons"] = [];
  if (chars.length < MIN_PASSWORD_LENGTH) reasons.push("too_short");
  if (new Set(chars.map((c) => c.toLowerCase())).size < 6) reasons.push("too_repetitive");
  if (isSequence(p)) reasons.push("sequence");
  if (COMMON.has(p.toLowerCase())) reasons.push("common");
  return { ok: reasons.length === 0, reasons };
}

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "1q2w3e4r5t6y7u8i9o0p"];

/** Counting up or down (abcdef, 654321), or a stretch of 6+ keys along a keyboard row, making up most of the password. */
function isSequence(p: string): boolean {
  const s = p.toLowerCase();
  if (s.length < 6) return false;
  for (const row of ROWS) {
    for (const r of [row, [...row].reverse().join("")]) {
      for (let i = 0; i + 6 <= r.length; i++) if (s.includes(r.slice(i, i + 6))) return true;
    }
  }
  let run = 1;
  let best = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d === 1 || d === -1) run++;
    else run = 1;
    best = Math.max(best, run);
  }
  return best >= s.length - 2;
}
