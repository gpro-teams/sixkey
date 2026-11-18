// The built-in autofill's On/Off (docs/design/proposals/MOD-PLATFORM.md §7.2 Option I items 2–4; R-9;
// wave 1b of the removed plugin platform), from Settings › Security › Autofill.
//   - Off: the switch written (the grant store: core/plugins/builtin.ts, a tagged write, the vault key needed) and the
//     page hint set; nothing else in the page, so a page closed right after its write leaves nothing half done. The
//     worker follows the write (platform/autofill-reconcile.ts followSwitch): the content script unregistered, then each
//     listed site's own grant given back, one call each (giveBackSites: a grant Chrome refuses to remove, a required one
//     in the e2e build, stays; a broad grant chosen in Chrome's own menus stays as the user set it, as removeSite does),
//     THEN `scripting` (the registration calls exist only while it is held, and Chrome runs a registration left behind
//     wherever a grant remains; only the worker may make them: check-dist). The list of sites is KEPT, for a later On,
//     and the vault is not touched.
//   - On: ONE request, the first statement of the click (Chrome grants only in the gesture): `scripting` and the listed
//     sites' patterns; granted, the hint cleared and the switch written. The worker follows the write (followSwitch: a
//     reconcile, which registers the sites that count).
//   - The page hint (`sk_af_off`, page localStorage; new in wave 1b): lets the popup and the side
//     panel know in a click that autofill is off without a chrome.storage read at their open (perf.spec's six). Only ever
//     a reason not to ask Chrome: what decides is the gate (autofill-gate.ts), and what keeps autofill out of pages is
//     `scripting` gone. Every verified read of the record that draws the switch sets it again (Settings:
//     options/AutofillSwitch.tsx), and so does a Fill the gate refuses as off (popup/main/Fill.tsx).
import { sitePattern } from "../../core/autofill-sites";
import { autofillOn } from "../../core/plugins/builtin";
import { GRANTS_KEY, type GrantEntry } from "../../core/plugins/grants";
import type { GrantKeys } from "../../core/plugins/store";
import { readList, setOffHint } from "../autofill-sites";
import { grantedExactly, type GrantList } from "../permission-grants";
import { grantStore } from "./chrome";

/** The patterns of the listed sites (core/autofill-sites.ts sitePattern), for On's one request and Off's removals. */
export const patternsOf = (hosts: readonly string[]): string[] =>
  hosts.map((h) => sitePattern(h)).filter((p): p is string => p !== null);

/** The chrome.permissions calls used here (tests pass fakes). */
export type SwitchPermissions = {
  request(p: chrome.permissions.Permissions): Promise<boolean>;
  remove(p: chrome.permissions.Permissions): Promise<boolean>;
} & GrantList;
const permissions = (): SwitchPermissions => chrome.permissions as unknown as SwitchPermissions;

/**
 * Off. `keys`: the vault key (the switch is a tagged write; null: locked, nothing is done). The list stays; the worker
 * unregisters and gives back the sites' grants and `scripting` on the switch's write. Resolves with whether it was switched.
 */
export async function turnAutofillOff(keys: GrantKeys | null): Promise<boolean> {
  if (!keys) return false;
  await grantStore().setAutofill(keys, false);
  setOffHint(true);
  return true;
}

/**
 * Off, in the worker (followSwitch, after the unregister): each listed site's own grant given back, one call each, an
 * exact grant only (no gesture needed). The list itself is not touched. `off` is read again before each site: an On
 * clicked meanwhile found those grants still there (so Chrome granted nothing new) and must keep them (the W1b r2
 * review's N-04).
 */
export async function giveBackSites(o: {
  off: () => Promise<boolean>;
  p?: SwitchPermissions;
  hosts?: () => Promise<string[]>;
}): Promise<void> {
  const p = o.p ?? permissions();
  for (const pattern of patternsOf(await (o.hosts ?? readList)())) {
    if (!(await o.off())) return;
    if (await grantedExactly(pattern, p).catch(() => false)) await p.remove({ origins: [pattern] }).catch(() => false);
  }
}

/**
 * On, step one: Chrome's request, as the FIRST statement of the click: `scripting` and the listed sites' patterns
 * (`hosts`: the list the page has read already; a read here would spend the gesture). Step two (turnAutofillOn) needs the
 * answer.
 */
export function askAutofillOn(hosts: readonly string[], p: SwitchPermissions = permissions()): Promise<boolean> {
  const origins = patternsOf(hosts);
  try {
    return p.request({ permissions: ["scripting"], ...(origins.length ? { origins } : {}) }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * On, step two: once Chrome granted, the hint cleared and the switch written. Resolves with whether it was switched. (The
 * hint first, as Off sets it last: cut short in between, it says "on" while the switch is off, never the reverse, and the
 * next Fill then meets the gate, which says so and sets it again.)
 */
export async function turnAutofillOn(keys: GrantKeys | null, granted: boolean): Promise<boolean> {
  if (!keys || !granted) return false;
  setOffHint(false);
  await grantStore().setAutofill(keys, true);
  return true;
}

/**
 * The entries the built-in's switch is read from: the verified record's; or, where its tag fails, the record as the
 * worker reads it (unverified, the overlay applied), tighten-only for the built-in (above). `verified`: which it was
 * (Settings says so when it was not).
 */
export async function switchRecord(k: GrantKeys): Promise<{ plugins: GrantEntry[]; verified: boolean }> {
  const v = await grantStore().read(k);
  return v.ok
    ? { plugins: v.plugins, verified: true }
    : { plugins: (await grantStore().unverified()).plugins, verified: false };
}

/**
 * Whether autofill is switched off, read without the key (the worker's reconcile and followSwitch run locked too): the
 * record unverified, the overlay applied. Where its tag holds, that is the verified record's answer; where it fails, it is
 * the very reading switchRecord makes, so the worker and the page agree.
 */
export const switchedOff = async (): Promise<boolean> => !autofillOn((await grantStore().unverified()).plugins);

/** Calls `f` on every change of the grant store (sk_plugins: where the switch is written), in the worker. */
export function watchSwitch(
  local: { onChanged: { addListener(f: (changes: Record<string, unknown>) => void): void } },
  f: () => unknown,
): void {
  local.onChanged.addListener((changes) => {
    if (GRANTS_KEY in changes) void f();
  });
}
