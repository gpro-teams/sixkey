// The sites where the user turned on code suggestions (TOTP autofill Stage 2; docs/design/notes/AUTOFILL2-NOTES.md §7).
// Pure: no chrome.*, no storage. src/platform/autofill-sites.ts keeps the list and asks Chrome; this module decides which
// hosts may be on it, the one permission pattern each may ask for, and what a stored list reads back as.
//
// A site is one exact host, asked for as the one origin pattern of that host over https (sitePattern, below: an exact
// host, so it does not cover gist.github.com for github.com). Never http, never an IP address, never a single label (the loopback name among them),
// never a shared suffix (co.uk, github.io: site-domains.ts), never the sync API's host (TOTP-AUTOFILL §2.3: the network
// permission and a site's are kept apart), never a host the URL parser would write differently (upper case, Unicode, a
// trailing dot, a port, a wildcard), and never longer than a host name can be.
import { canonicalHost, isIpHost } from "./match";
import { isShared } from "./site-domains";

/** At most this many sites (AUTOFILL2-PLAN §3.1). */
export const MAX_SITES = 32;

/** Whether `host` may be turned on (`apiHost`: the sync API's host name, which never may). */
export function siteHostOk(host: unknown, apiHost: string): host is string {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (canonicalHost(host) !== host) return false; // exactly as the URL parser writes it, nothing to normalise
  if (isIpHost(host)) return false;
  return !isShared(host) && host !== apiHost; // isShared also refuses a single label
}

/** The one origin pattern asked for, or given back, for a site: exactly https://<host>/*. Null for a host that may not be. */
export const sitePattern = (host: string, apiHost: string): string | null =>
  siteHostOk(host, apiHost) ? `https://${host}/*` : null;

/**
 * The site a page may offer to turn on: the host of an https page at the default port, without a user name, if it may be
 * turned on; else null (http, another scheme, a port, an IP address, a shared suffix, the API host).
 */
export function siteOfUrl(url: string | undefined, apiHost: string): string | null {
  try {
    const u = new URL(url ?? "");
    if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") return null;
    return siteHostOk(u.hostname, apiHost) ? u.hostname : null;
  } catch {
    return null;
  }
}

/** A stored list (`{v: 1, hosts}`) read back: its hosts that may be on it, each once, at most MAX_SITES; anything else is none. */
export function readSites(raw: unknown, apiHost: string): string[] {
  const r = raw as { v?: unknown; hosts?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || r.v !== 1 || !Array.isArray(r.hosts)) return [];
  const out: string[] = [];
  for (const h of r.hosts) if (siteHostOk(h, apiHost) && !out.includes(h) && out.length < MAX_SITES) out.push(h);
  return out;
}

/** The record to store for a list (only its two fields: anything else a reader met is dropped). */
export const sitesRecord = (hosts: readonly string[]) => ({ v: 1 as const, hosts: [...hosts] });
