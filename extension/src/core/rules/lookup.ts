// The site rule for a page, what the code box finder receives of it, and the "code after the password" hosts (TOTP
// autofill Stage 3, AF3-1a; docs/design/notes/AUTOFILL3-NOTES.md). Pure: it reads bundles that format.ts has checked, and
// it imports nothing at run time (only format.ts's types), so the tools under rules/ can load it with Node's type
// stripping too.
//
// Which rules are in effect: a live bundle's, whole, when it is newer than the baseline (a higher version); else the
// baseline's (inEffect). A live bundle holds every rule it means to keep, and so can take a wrong one out; an older one
// (a release brought a newer baseline since) is not used. Whether a live bundle has expired is the updater's to decide
// before it hands one over. The alias groups and the appends always come from the baseline: a live bundle has none.
//
// A rule applies to exact hosts only: `example.com` and `www.example.com` are two hosts, and a subdomain gets nothing from
// its parent's rule. The host asked about is the top page's (match.ts hostOf: lower case, no trailing dot), and the hint
// names that host alone, so the finder applies the rule in the top page and in frames of the same host, never in a frame
// of another host even when the rule lists it.
import type { Bundle, Fill, Rule } from "./format";

/** What the finder (src/inject/otp.ts) takes as `inspect`'s argument. */
export type Hint = {
  /** The host the rule was found for: the finder applies it only where location.hostname is one of these. */
  d: string[];
  /** Path prefix, selector, segments (0: one box), strategy (0 auto, 1 chars, 2 paste). */
  p: { at: string; sel: string; n: number; how: 0 | 1 | 2 }[];
  /** The site's code box is for codes it sends: the "sent" note. */
  sent: boolean;
};
/** The rule found for a host: its id, the host, the rule, and which kind of bundle had it. */
export type Found = { id: string; host: string; rule: Rule; from: Bundle["kind"] };

const HOW: Record<Fill, 0 | 1 | 2> = { auto: 0, chars: 1, paste: 2 };

/**
 * The bundle whose rules are in effect: the live one, whole, when it is a live bundle newer than the baseline (or there
 * is no baseline); else the baseline. A bundle of the wrong kind in either place is never used.
 */
export function inEffect(live: Bundle | null | undefined, baseline: Bundle | null | undefined): Bundle | null {
  const base = baseline?.kind === "baseline" ? baseline : null;
  if (live?.kind === "live" && (!base || live.version > base.version)) return live;
  return base;
}

/** The rule for `host` in `bundle` (see inEffect), or null. */
export function ruleFor(host: string | null, bundle: Bundle | null | undefined): Found | null {
  if (!host || !bundle) return null;
  const id = bundle.hosts.get(host);
  const rule = id === undefined ? undefined : bundle.rules.get(id);
  return id !== undefined && rule ? { id, host, rule, from: bundle.kind } : null;
}

/** The finder's argument for a found rule (null for none: the finder then uses its heuristics alone). */
export function hintOf(found: Found | null): Hint | null {
  if (!found) return null;
  return {
    d: [found.host],
    p: found.rule.pages.map((p) => ({ at: p.path, sel: p.field, n: p.segments, how: HOW[p.fill] })),
    sent: found.rule.sent,
  };
}

/** The seconds of a code's period that must remain to fill it on this site, or null for the default (MIN_LEFT_S). */
export const minLeftOf = (found: Found | null): number | null => found?.rule.minLeft ?? null;

/**
 * Whether the site at `host` wants the code typed after the password (the baseline's appends): the host is one of them or
 * a subdomain of one, on label boundaries (E*TRADE's sign-in is on us.etrade.com), as match.ts coveredBy reads a site.
 */
export function appendsOn(baseline: Bundle | null | undefined, host: string | null): boolean {
  if (baseline && baseline.kind !== "baseline")
    throw new Error("appendsOn takes the baseline bundle: a live one has none");
  if (!host || !baseline) return false;
  return baseline.appends.some((a) => host === a || host.endsWith(`.${a}`));
}
