// Which accounts belong to the page the user is on. Pure string matching on host names: no public-suffix list, no
// network. Two tiers (PHASE0X-PLAN B2, ux-study §2.10 and §7):
//   registered  the page's host is one of the account's registered domains (`Entry.domains`), or a subdomain of one.
//               Only this tier is ever labelled "This site".
//   related     a guess from the account's name. Shown apart, under "Possibly related", and never labelled.
//
// The registered rule, in full:
// - Both sides are ASCII host names in the form the browser's URL parser gives: lower case, IDN labels in punycode
//   ("xn--…"). Nothing is decoded to Unicode, for matching or for display, so a look-alike in another script
//   (gооgle.com with Cyrillic о is xn--ggle-0nda.com) can never equal the real name, and shows as what it is.
// - host === d, or host ends with "." + d: a suffix match on label boundaries, nothing else. No regular expressions,
//   no wildcards. "notgithub.com", "github.com.attacker.io" and "github.com-login.ru" do not match "github.com".
// - The scheme and port are ignored (only http and https pages have a host): "nas.example.net" matches on :5001 too.
// - One trailing dot is ignored on both sides ("github.com." is the same host).
// - IP addresses (v4, and v6 in brackets) match only exactly: "1.1" is never a parent of "1.1.1.1".
// - A registered domain counts only if it is a well-formed host name with at least two labels, or an IP address. The
//   field is free text in backups and old data, so a stored "com", "localhost", "*.example.com" or "https://x" is
//   ignored, never widened into a match.
// - What may be registered in the first place (no single labels, no shared suffixes such as co.uk or github.io, nothing
//   that covers one) is decided when it is written: site-domains.ts, loaded only when the user registers a domain.
//
// The name guess (related): the issuer, folded to its ASCII letters and digits, equals a label of the host other than
// the top-level one, or, at 5 characters or more, appears inside the host name run together (punycode labels are left
// out of both). A name of 2 counts only the first way: "ws" is related on ws.g.pro, never on aws.amazon.com or on a .ws
// site (docs/design/notes/AFMATCH-NOTES.md), and it is too weak to tick "Show first on <host>" for a new account by
// itself (firmGuess). This is the guess Sixkey made before (from 3 characters until AFMATCH), now only ever shown as
// "Possibly related". Never for IP hosts, never for names shorter than 2, and never for an account that has a usable
// registered domain: once the user has said where an account lives, Sixkey stops guessing for it, so a look-alike page
// does not even list it as related.
// One deliberate exception, made outside this file (TOTP autofill Stage 3, AF3-4: core/rules/alias.ts, popup/main/aliases.ts
// and model.ts filterRows): an account registered for a site that Apple's list says shares its sign-in with the page
// ("same sign-in": twitter.com's account on x.com) is listed as related too, with a line that names its own site. That is
// no guess from a name or a page's shape: the relation comes from a list Apple reviews, pinned by its hash and shipped with
// each release only (a downloaded rules bundle can never carry it), and it only lists the account. "Remember" still writes
// the site, and only "registered" fills (docs/design/notes/AFMATCH-NOTES.md §7).
// Names keep their Unicode letters (normalizeName: "阿里云" stays "阿里云", it is no longer cleaned to ""), but a host
// name is ASCII, so only the ASCII part of a name can ever be compared with one: a Chinese name is found by search
// and matches once its domain is registered (from the list's "which account" line, or in the editor's Sites field),
// never by guessing.
import type { Entry } from "./vault/model";

export type Tier = "registered" | "related";

/** One label of a host name, as the URL parser leaves it (underscores occur in real host names). */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for an IP address in the URL parser's form: dotted IPv4, or IPv6 in brackets. */
export const isIpHost = (h: string) => IPV4.test(h) || h.startsWith("[");

/**
 * `s` as a bare host name in the URL parser's form (lower case, punycode, no trailing dot), or null when it is not
 * one: anything with a scheme, port, path, user name, percent sign, white space or wildcard is refused, not trimmed.
 */
export function canonicalHost(s: string): string | null {
  const v = s.trim().toLowerCase();
  if (!v || v.length > 253 || /[\s/?#@\\%:*[\]]/.test(/^\[[0-9a-f:.]+\]$/.test(v) ? "" : v)) return null;
  let h: string;
  try {
    h = new URL(`http://${v}/`).hostname;
  } catch {
    return null;
  }
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > 253) return null;
  return isIpHost(h) || h.split(".").every((l) => LABEL.test(l)) ? h : null;
}

/**
 * A site as the user typed or pasted it, as it would be stored (canonicalHost), or null. A full address keeps only its
 * host; a leading "*.", a path and a port are dropped as typed shorthand. Whether it may be registered at all (not a
 * single label, not a shared suffix) is site-domains.ts's isShared.
 */
export function parseSite(input: string): string | null {
  let s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else
    s = s
      .replace(/^\*\./, "")
      .replace(/[/?#][\s\S]*$/, "")
      .replace(/^(\[[^\]]*\]|[^:]*):\d{1,5}$/, "$1");
  return canonicalHost(s);
}

/** A stored domain that can count for matching: well-formed, and an IP address or at least two labels. */
export function usableDomain(s: string): string | null {
  const d = canonicalHost(s);
  return d && (isIpHost(d) || d.includes(".")) ? d : null;
}

/** The host of a web page (http or https), lower case, without a trailing dot; null for anything else. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return h || null;
  } catch {
    return null;
  }
}

/** True when `host` is `domain` or a subdomain of it (both already canonical). IP addresses only ever equal. */
export function coveredBy(host: string, domain: string): boolean {
  return host === domain || (!isIpHost(domain) && !isIpHost(host) && host.endsWith("." + domain));
}

/** A name for comparing: compatibility forms and accents folded, lower case, only Unicode letters and digits kept. */
export const normalizeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** The part of a name a host name can be compared with: its ASCII letters and digits, once normalized. */
const asciiName = (s: string) => normalizeName(s).replace(/[^a-z0-9]/g, "");

function nameGuess(issuer: string, host: string): boolean {
  const n = asciiName(issuer); // host names are ASCII: only this part can match
  if (n.length < 2) return false; // one letter is in too many names; two count only as a whole label (below)
  const all = host.split(".");
  const plain = (l: string) => !l.startsWith("xn--"); // punycode is not a name; its letters are an encoding
  // A whole label, but not the top-level one: an issuer called "App" or "Shop" is not every .app or .shop site.
  if ((all.length > 1 ? all.slice(0, -1) : all).filter(plain).includes(n)) return true;
  // Inside the name run together, top level included, so "Booking.com" still finds account.booking.com.
  return (
    n.length >= 5 &&
    all
      .filter(plain)
      .join("")
      .replace(/[^a-z0-9]/g, "")
      .includes(n)
  );
}

/** How `e` belongs to the page at `host` (from hostOf): registered, related (a name guess), or not at all. */
export function matchTier(e: Pick<Entry, "issuer" | "domains">, host: string | null): Tier | null {
  if (!host) return null;
  const h = host.toLowerCase().replace(/\.$/, "");
  let bound = false;
  for (const raw of e.domains ?? []) {
    const d = usableDomain(raw);
    if (!d) continue;
    if (coveredBy(h, d)) return "registered";
    bound = true;
  }
  if (bound || isIpHost(h)) return null;
  return nameGuess(e.issuer, h) ? "related" : null;
}

/**
 * Whether a new account named `issuer` starts out ticked for the page at `host` on the popup's confirm page ("Show first
 * on <host>"): a name guess of 3 characters or more. A guess of 2 lists an account as related, never commits a site.
 */
export const firmGuess = (issuer: string, host: string | null) =>
  matchTier({ issuer }, host) === "related" && asciiName(issuer).length > 2;

/** Whether `e` belongs to the page at `host` at all, at either tier. */
export function matchesSite(e: Pick<Entry, "issuer" | "domains">, host: string | null): boolean {
  return matchTier(e, host) !== null;
}

/** Whether a page's host could be registered at all: an IP address, or a name of two labels or more. */
export const canRegister = (host: string | null): host is string => !!host && (isIpHost(host) || host.includes("."));
