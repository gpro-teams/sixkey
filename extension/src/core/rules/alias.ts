// "Same sign-in" suggestions (TOTP autofill Stage 3, AF3-1a; the plan's §3.4; docs/design/notes/AUTOFILL3-NOTES.md): which
// accounts may be offered, under "Possibly related", on a page whose host is in an alias group with one of the account's
// registered sites. The groups come from Apple's shared-credentials list, imported into the baseline bundle with its hash
// pinned, and ship with releases only (format.ts refuses them in a live bundle).
//
// The rules, all of them:
//   - a host is "at" a member when the two are the same once one leading "www." is taken off each: x.com and www.x.com
//     are at x.com, and seek.com.au (what "Remember" stores for www.seek.com.au, site-domains.ts preferredChoice) is at
//     Apple's www.seek.com.au. No other subdomain: a member's user-content subdomains (every community wiki under
//     fandom.com, say) are never offered, and an account registered for a subdomain of a member is not offered either;
//   - a `shared` group: on a host at one member, every other member is offered;
//   - a one-way group: on a host at a `t` member, the `f` members are offered, and nothing the other way. Apple writes
//     twitter.com → x.com so: an account registered for twitter.com is offered on x.com, and one for x.com is not offered
//     on twitter.com;
//   - an account is offered when it is not registered for the page already (match.ts "registered": it is "This site"
//     then) and one of its usable registered sites is at an offered member. The answer names that site, so the row can
//     say which site the account was saved for (Apple's README asks that it be clearly stated);
//   - never for an IP address. Nothing here makes an account "This site", fills anything or adds a site to an account:
//     the user's "Remember" does that, for the page's own host (TOTP-AUTOFILL §5.1 M1, M2).
import { isIpHost, matchTier, usableDomain } from "../match";
import type { Entry } from "../vault/model";
import type { AliasGroup } from "./format";

const bare = (h: string) => (h.startsWith("www.") ? h.slice(4) : h);
/** Whether `host` is the alias member `m`, one leading `www.` taken off each. */
export const atMember = (host: string, m: string): boolean => bare(host) === bare(m);

/** The members offered on `host`, in the groups' order, each once. */
export function offeredOn(groups: readonly AliasGroup[], host: string | null): string[] {
  if (!host || isIpHost(host)) return [];
  const out = new Set<string>();
  for (const g of groups) {
    if ("s" in g) {
      const here = g.s.find((m) => atMember(host, m));
      if (here !== undefined) for (const m of g.s) if (m !== here) out.add(m);
    } else if (g.t.some((m) => atMember(host, m))) for (const m of g.f) out.add(m);
  }
  return [...out];
}

/**
 * The accounts to offer on `host`, each with the registered site that makes it the same sign-in (its first usable one
 * at an offered member), by account id.
 */
export function aliasRelated(
  entries: readonly Pick<Entry, "id" | "issuer" | "domains">[],
  host: string | null,
  groups: readonly AliasGroup[],
): Map<string, string> {
  const out = new Map<string, string>();
  const offered = offeredOn(groups, host);
  if (offered.length === 0) return out;
  for (const e of entries) {
    if (matchTier(e, host) === "registered") continue;
    for (const raw of e.domains ?? []) {
      const d = usableDomain(raw);
      if (d && offered.some((m) => atMember(d, m))) {
        out.set(e.id, d);
        break;
      }
    }
  }
  return out;
}
