// The site rule for the page the popup's or the side panel's Fill path is about to look at (TOTP autofill Stage 3,
// AF3-3b; docs/design/notes/AUTOFILL3-NOTES.md §5; the worker's shortcut takes none: the maintainers' C27): the rules
// in effect, the rule for the top page's host, and what the Fill path takes of it, the finder's hint
// (platform/autofill.ts scan's argument) and the site's `minLeft` (fillCand's `d.minLeft`). No rule for the host, or no
// rules to read: no hint and the default wait, which is the finder's heuristics alone, as before Stage 3.
// The rules in effect: the package's baseline (platform/package-data.ts readRules), unless the site rules' updater has a
// live bundle in use (AF3-U2, §10: in a build whose updater's release gate is open, and in no other: there the ask below
// is dead code the build removes). Pages never open the updater's database: the Fill path asks the worker (`sk-af-rule`,
// platform/rules-live.ts answer), while it reads the package, and waits ASK_MS at most for the answer:
//   - a live bundle in use: its rule for this host, or none, which is final: the live bundle replaces the built-in rules
//     whole (the plan's R4-1, C24), so the package's rule for the host is not used;
//   - none in use (the switch off, no bundle, or it expired), no answer in time, or no answer at all: the package's.
// With the rule, whether the site wants the code typed right after the password, in the same box (the baseline's appends,
// Apple's list: AF3-5, §7): the Fill card says so where it finds no code box. Always the package's baseline, whatever
// rules are in effect: a live bundle carries no appends (lookup.ts appendsOn takes the baseline only, and is given the
// package's alone: AF3-5's review, NIT-2).
import { hostOf } from "../core/match";
import { appendsOn, hintOf, inEffect, minLeftOf, ruleFor, type Found, type Hint } from "../core/rules/lookup";
import { readRules } from "./package-data";

declare const __RULES_UPDATE__: boolean;
const RULES_UPDATE = typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__;
/** How long a Fill path waits for the worker's answer before it reads the package's rules alone (the plan's S9). */
export const ASK_MS = 1000;
/** The worker's answer when a live bundle is in use: its version, and this host's rule in it or null (none). */
export type LiveAnswer = { v: number; rule: Found | null };

/**
 * The live bundle's answer for `host`, or null: none in use, no answer within ASK_MS, no answer at all (the message
 * rejected, or thrown at once: a context the extension's update invalidated). Never rejects, never throws.
 */
export function askWorker(host: string): Promise<LiveAnswer | null> {
  return new Promise((done) => {
    const late = setTimeout(() => done(null), ASK_MS);
    const none = () => {
      clearTimeout(late);
      done(null);
    };
    try {
      chrome.runtime.sendMessage({ type: "sk-af-rule", host }).then((a: unknown) => {
        clearTimeout(late);
        const o = a as Partial<LiveAnswer> | null;
        done(o !== null && typeof o === "object" && typeof o.v === "number" && "rule" in o ? (o as LiveAnswer) : null);
      }, none);
    } catch {
      none();
    }
  });
}

/**
 * What a Fill path takes of a page's site rule: the finder's argument, the seconds a code must still have (or null), and
 * whether the site wants the code typed after the password (the host is one of the baseline's appends or under one).
 */
export type PageRule = { hint: Hint | null; minLeft: number | null; appends: boolean };
export const NO_RULE: PageRule = { hint: null, minLeft: null, appends: false };

/** The rule for the page at `url` (an http or https address: its host, exact), as a Fill path uses it. Never rejects. */
export async function ruleForPage(url: string | undefined): Promise<PageRule> {
  const host = hostOf(url);
  if (host === null) return NO_RULE;
  try {
    const asked = RULES_UPDATE ? askWorker(host) : null;
    const baseline = await readRules();
    const live = asked && (await asked);
    const found = live ? live.rule : ruleFor(host, inEffect(null, baseline));
    return { hint: hintOf(found), minLeft: minLeftOf(found), appends: appendsOn(baseline, host) };
  } catch {
    return NO_RULE;
  }
}
