// A page that looks like an account's site but is not it (the owner's request of 2026-11-18, before the store listing):
// "githuh.com" or "github-login.com" for GitHub's github.com. The popup warns at the top and asks again before copying
// that account's code there, and never guesses such a page as the account's ("Possibly related"). Pure, and only a
// warning: a page the user tells Sixkey is the account's (Remember) is that account's site from then on.
//
// What looks like a site, for an account with remembered sites (each compared by its name: the label before its suffix):
//   - the same name on another domain, as a label of the page ("github.com.evil.ru", "github.evil.com", "github.io");
//   - the name as one part of a hyphenated label ("github-login.com", "secure-github.net");
//   - the name one edit away (a letter changed, added, dropped or two swapped), for a name of 5 letters or more, two edits
//     for 9 or more ("githuh.com", "gitthub.com");
//   - the name spelled with look-alike characters (0 for o, 1 or i for l, rn for m, vv for w: "g1thub.com", "rnicrosoft").
// An account with no remembered site has only its name, which the page's own name may rightly contain: only the edits
// and the look-alike characters count there. Names under 4 letters are never compared (too many sites share them).
import { coveredBy, isIpHost, normalizeName, usableDomain } from "./match";
import type { Entry } from "./vault/model";

/** Second-level labels that are part of a country's suffix ("co.uk", "com.cn"): the name is the label before them. */
const SECOND = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

/** A host's labels split into its name's place: [the labels before the name, the name, the suffix]. */
function split(host: string): { before: string[]; name: string; suffix: string } | null {
  const l = host.split(".");
  if (l.length < 2) return null;
  const cut = l.length >= 3 && SECOND.has(l[l.length - 2]!) && l[l.length - 1]!.length === 2 ? 2 : 1;
  return { before: l.slice(0, l.length - cut - 1), name: l[l.length - cut - 1]!, suffix: l.slice(-cut).join(".") };
}

/** Look-alike characters folded to the letters they stand for. */
const fold = (s: string) =>
  s
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/[1i|]/g, "l")
    .replace(/5/g, "s")
    .replace(/3/g, "e");

/** Edits between two strings (Damerau-Levenshtein, adjacent swaps), stopping early once past `max`. */
function edits(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let row = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      row = Math.min(row, v);
    }
    if (row > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** Whether a page's name is a near miss of `name`: edits, or look-alike characters. Never the name itself. */
function nearMiss(page: string, name: string): boolean {
  if (page === name) return false;
  if (fold(page) === fold(name)) return true;
  const max = name.length >= 9 ? 2 : name.length >= 5 ? 1 : 0;
  return max > 0 && edits(page, name, max) <= max;
}

/**
 * The site (or name) of `e` that the page at `host` looks like without being it, or null: no remembered site of `e` covers
 * the page and one of the rules above holds. For an account with sites, the site it imitates ("github.com"); for one
 * without, its name ("GitHub").
 */
export function lookalikeOf(e: Pick<Entry, "issuer" | "domains">, host: string | null): string | null {
  if (!host || isIpHost(host)) return null;
  const page = split(host.toLowerCase().replace(/\.$/, ""));
  if (!page) return null;
  const sites = (e.domains ?? []).map(usableDomain).filter((d): d is string => d !== null && !isIpHost(d));
  if (sites.some((d) => coveredBy(host, d))) return null; // the account's own site
  for (const d of sites) {
    const s = split(d);
    if (!s || s.name.length < 4) continue;
    const labels = [...page.before, page.name];
    if (labels.includes(s.name)) return d; // the name, on another domain
    if (labels.some((l) => l.includes("-") && l.split("-").includes(s.name))) return d; // one part of a hyphenated label
    if (nearMiss(page.name, s.name)) return d;
  }
  if (sites.length) return null;
  const n = normalizeName(e.issuer).replace(/[^a-z0-9]/g, "");
  return n.length >= 4 && nearMiss(page.name, n) ? e.issuer : null;
}
