// The plan of Settings > Add account: the paste box and every file and camera scan read so far, through the one
// importer (importer.ts planImport), then compared with the vault by dedupe.ts (key bytes, not text) and by the OTP
// parameters. Settings-side only: the popup's confirm page keeps its own use of dedupe.ts, so nothing here changes
// what the popup loads. docs/design/notes/IMPORT-FILE-NOTES.md §6.
import type { OtpParams } from "../totp/otpauth";
import { isAlive, type Entry } from "../vault/model";
import { keyBytes } from "./dedupe";
import { isSteamEncoder, secretRunsOn, SPLIT, unescapeAmp } from "./file-formats";
import { planImport, type ImportOptions, type ImportPlan } from "./importer";

const fold = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/** Codes from the two are the same: type, algorithm, digits, and the period of a TOTP. A HOTP counter moves; it is not compared. */
export const sameParams = (a: OtpParams | Entry, b: OtpParams | Entry): boolean =>
  a.type === b.type &&
  a.algorithm === b.algorithm &&
  a.digits === b.digits &&
  (a.type === "hotp" || a.period === b.period);

/** One account as the import sees it: the key's bytes, the names folded, the OTP parameters. */
export const accountKey = (p: OtpParams): string =>
  [
    keyBytes(p.secret) ?? p.secret,
    fold(p.issuer),
    fold(p.label),
    p.type,
    p.algorithm,
    p.digits,
    p.type === "hotp" ? "" : p.period,
  ].join("\u0000");

/**
 * The paste box's text made safe for the importer, line by line, so the preview's line numbers do not move; the same
 * checks a file's links get (file-formats.ts Found.link):
 *   - `&amp;` and its numeric spellings, however many times escaped, are read as `&`, in lines that hold a link: the
 *     importer would otherwise read `amp;digits` and give the account the default 6 digits and 30 s;
 *   - a TOTP link whose `encoder` parameter says Steam (read as the importer reads it, so `%73team` too) is written as a
 *     Steam link, so the importer reports an unsupported type instead of taking it as six TOTP digits;
 *   - a link whose `secret` runs on into a word (`…?secret=K work`) gets its first such space written as `*`, so the
 *     importer refuses its key ("secret key is not valid") instead of taking `KWORK`.
 */
export function cleanBox(text: string): string {
  if (!/otpauth/i.test(text)) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!/otpauth/i.test(line)) return line;
      return unescapeAmp(line)
        .split(SPLIT)
        .map((part) => {
          if (!/^\s*otpauth:\/\//i.test(part)) return part;
          let out = part;
          if (/^\s*otpauth:\/\/totp\//i.test(out) && isSteamEncoder(out.trim()))
            out = out.replace(/otpauth:\/\/totp\//i, "otpauth://steam/");
          if (secretRunsOn(out.trim())) out = refuseSecret(out);
          return out;
        })
        .join("");
    })
    .join("\n");
}

/** The link with the first white space inside its first `secret` value written as `*`, which no key holds. */
function refuseSecret(link: string): string {
  const m = /[?&]secret=/.exec(link);
  if (!m) return link;
  for (let i = m.index + m[0].length; i < link.length && link[i] !== "&" && link[i] !== "#"; i++)
    if (/\s/.test(link[i]!)) return link.slice(0, i) + "*" + link.slice(i + 1);
  return link;
}

/**
 * The plan for the paste box `text` and the files' and scans' `lines` (already checked links, file-formats.ts), as one
 * import. Duplicates are found by dedupe.ts's rules, with its keyBytes (the key's bytes, not its text), against the
 * live accounts only (the trash does not count), each rule only when the codes are the same as well:
 *   - an account whose key is in the vault under the same issuer ("exists") is a duplicate only when its codes are the
 *     same (sameParams); the same key with other digits, period, algorithm or type gives other codes, and is added;
 *   - a key seen earlier in the same import ("repeat") is a duplicate on the same terms: under the same issuer, with
 *     the same codes. The same key under another name stays, as the paste box always kept it.
 * The importer's own check drops a repeat of the same key, issuer and account whatever its parameters; such a repeat
 * whose codes differ from every account kept is taken back here, after the others.
 */
export function planSettings(
  text: string,
  lines: readonly string[],
  existing: readonly Entry[],
  opts: ImportOptions = {},
): ImportPlan {
  const combined = [cleanBox(text), ...lines].join("\n");
  const { plan } = planImport(combined, [], [], opts);
  // The live accounts by their key's bytes (dedupe.ts keyBytes), once: an import of thousands of lines against a vault
  // of thousands of accounts is compared in linear time, on every keystroke in the box.
  const byKey = (list: Iterable<OtpParams | Entry>) => {
    const m = new Map<string, (OtpParams | Entry)[]>();
    for (const e of list) {
      const kb = keyBytes(e.secret);
      if (kb === null) continue;
      const same = m.get(kb);
      if (same) same.push(e);
      else m.set(kb, [e]);
    }
    return m;
  };
  const live = byKey(existing.filter(isAlive));
  const kept = new Map<string, OtpParams[]>();
  const fromText = new Set(plan.fromText);
  const add: OtpParams[] = [];
  const addFromText: number[] = [];
  const duplicates: OtpParams[] = [];
  /**
   * dedupe.ts's "exists" (the key in the vault under the same issuer) and "repeat" (the key earlier in this import),
   * each only when the codes are the same too.
   */
  const isDuplicate = (p: OtpParams, kb: string | null) => {
    if (kb === null) return false;
    const same = (e: OtpParams | Entry) => fold(e.issuer) === fold(p.issuer) && sameParams(e, p);
    return (live.get(kb) ?? []).some(same) || (kept.get(kb) ?? []).some(same);
  };
  const keep = (p: OtpParams, kb: string | null) => {
    add.push(p);
    if (kb === null) return;
    const same = kept.get(kb);
    if (same) same.push(p);
    else kept.set(kb, [p]);
  };
  plan.add.forEach((p, i) => {
    const kb = keyBytes(p.secret);
    if (isDuplicate(p, kb)) return void duplicates.push(p);
    if (fromText.has(i)) addFromText.push(add.length);
    keep(p, kb);
  });
  for (const p of plan.duplicates) {
    const kb = keyBytes(p.secret);
    if (isDuplicate(p, kb)) duplicates.push(p);
    else keep(p, kb); // the importer took it for a repeat, but its codes are not the same
  }
  return { ...plan, add, duplicates, fromText: addFromText };
}

/** A file offered for deletion: how many of its accounts were not imported, and how many came in as HOTP. */
export type Offer<T> = { source: T; left: number; hotp: number };

/**
 * The files to offer for deletion after `added` went into the vault: those that brought in at least one of those
 * accounts. None when nothing was added (an import that failed, was cancelled, or added nothing asks nothing). Each
 * says what deleting it would lose: `left`, the entries of it that were not imported (`refused`, counted by the file's
 * reader: Steam and other kinds, unreadable entries; and what the importer refused), and `hotp`, its accounts that
 * came in as HOTP, whose codes Sixkey cannot make yet. An account it holds that was already in the vault is not lost.
 */
export function offerDelete<T extends { lines: readonly string[]; refused: number }>(
  sources: readonly T[],
  added: readonly OtpParams[],
  opts: ImportOptions = {},
): Offer<T>[] {
  if (!added.length) return [];
  const keys = new Set(added.map(accountKey));
  const out: Offer<T>[] = [];
  for (const s of sources) {
    if (!s.lines.length) continue;
    const { plan } = planImport(s.lines.join("\n"), [], [], opts);
    const mine = plan.add.filter((p) => keys.has(accountKey(p)));
    if (!mine.length) continue;
    out.push({ source: s, left: s.refused + plan.failed.length, hotp: mine.filter((p) => p.type === "hotp").length });
  }
  return out;
}
