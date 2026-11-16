// What Sixkey does on the sites the user turned on is derived, never stored on its own (TOTP autofill Stage 2, patch 2;
// AUTOFILL2-PLAN §3.2 with its review's m3 and m4; docs/design/notes/AUTOFILL2-NOTES.md §7). Reconcile works it out
// from two things only, both read afresh at every run: the list (sk_af_sites, platform/autofill-sites.ts: what the user
// turned on in Sixkey) and Chrome's grants (each site's one exact pattern, asked with contains() one at a time). The
// sites that count are the list ∩ granted:
//   - a site withdrawn in Chrome's own UI (chrome://extensions › Site access, the extensions menu) drops out at the next
//     run, which its permissions.onRemoved starts (and, if that event never comes, the next worker start). The list keeps
//     it (review m4: the list is the user's intent), so Settings can say "Turned off in Chrome" and turn it on again;
//   - a broad grant ("On all sites", the pattern of every https site) makes every contains() true, so it turns on nothing
//     that is not listed.
// Before anything else, the runtime half of kill criterion K2: unless STORAGEGATE's gate says that storage.local and
// storage.session are closed to content scripts (both accepted TRUSTED_CONTEXTS, within its 5 s: storage-access.ts
// closedBy, storageClosed's rule, applied to this worker start's own call, background/storage-access-first.ts, which every
// start makes again), no site counts, whatever the list and the grants say (review m3). Before Chrome 140 that was every
// run (Sixkey needs 140 since wave 1b: the gate is a second layer now); the diagnostics log says so once.
//
// Wave 1b (MOD-PLATFORM §7.2 Option I; PLUGINS-W1B-NOTES.md): no site counts either while autofill is switched off (the
// built-in plugin's entry, read without the key: the worker holds none, and the switch is the user's intent, which
// `scripting` given back enforces), or while Sixkey does not hold `scripting` (then the registration calls are not there:
// Chrome throws "not available in this context", and the apply is not even tried). Chrome keeps a registration, AND runs
// it wherever a grant remains, after `scripting` is given back (probed, PLUGINS-W1B-NOTES.md §3): so the worker alone
// gives it back, and only after a run that unregistered (followSwitch below).
//
// Runs at every worker start, on permissions.onAdded and onRemoved, and on a change of the list (src/background/sw.ts).
// Runs are serialised, one after another (those triggers come together; patch 3's registration would otherwise be made
// twice and fail with "duplicate script ID"); a trigger that comes while a run waits for its turn joins that run; and a
// run still out after RECONCILE_MS is given up: it applies nothing even if it ends later, and the next run starts.
//
// `apply` receives the sites that count (none: gated, failed, or nothing granted): in the worker, the one content-script
// registration (platform/autofill-register.ts, the only caller of chrome.scripting's registration calls; patch 3). It is
// idempotent, since a run given up while its apply is out may still finish that one call, and it asks the storage gate
// again, now, before it registers anything.
import { scriptingHeld } from "./autofill";
import { applyRegistration } from "./autofill-register";
import { readList, siteGranted } from "./autofill-sites";
import { closedBy, type AccessResult } from "./storage-access";

/** How long one run may take: the gate's 5 s, the list, at most 32 contains() and the apply. */
export const RECONCILE_MS = 15_000;
/** The diagnostics line of a run that found the gate closed while the list has sites (written once while it stays in the log). */
export const GATED_NOTE = "autofill suggestions off: storage access not restricted";

export type ReconcileDeps = {
  /** STORAGEGATE's gate: true only if both areas are closed to content scripts (in the worker: this start's answer). */
  gate(): Promise<boolean>;
  /** Whether autofill is switched on and Sixkey holds `scripting` (W1b); false: no site counts, nothing is applied. */
  usable?(): Promise<"on" | "off" | "unscripted">;
  /** The sites on the list. */
  hosts(): Promise<string[]>;
  /** Whether Chrome grants this site's one pattern now. */
  granted(host: string): Promise<boolean>;
  /** The seam: what to do with the sites that count (see the top of this file). */
  apply(hosts: string[]): Promise<void>;
  /** One line for the diagnostics log. */
  note(line: string): void;
};
/** How a run ended: the sites applied; none, because of the gate; given up; failed (none applied, if it could be). */
export type Outcome = { k: "applied"; hosts: string[] } | { k: "gated" } | { k: "late" } | { k: "failed" };

/** One run. `live`: false once the run has been given up; then it applies nothing. */
export async function reconcileOnce(d: ReconcileDeps, live: () => boolean = () => true): Promise<Outcome> {
  try {
    // the gate first: in the worker, this start's access-level answer comes before anything is read (sw.ts)
    const open = await d.gate();
    const usable = d.usable ? await d.usable() : "on";
    // without `scripting` the registration calls are not there (a registration made before stays as Chrome keeps it)
    if (usable === "unscripted") return { k: "applied", hosts: [] };
    if (usable === "off") {
      if (live()) await d.apply([]);
      return { k: "applied", hosts: [] };
    }
    if (!open) {
      if ((await d.hosts()).length > 0) d.note(GATED_NOTE);
      if (live()) await d.apply([]);
      return { k: "gated" };
    }
    const want: string[] = [];
    for (const host of await d.hosts()) if (await d.granted(host)) want.push(host);
    if (!live()) return { k: "late" };
    await d.apply(want);
    return { k: "applied", hosts: want };
  } catch {
    if (live()) await d.apply([]).catch(() => undefined); // closed when unsure
    return { k: "failed" };
  }
}

/** Runs one after another, a trigger joining the run that waits for its turn, each bounded by `ms`. */
export function createReconciler(d: ReconcileDeps, ms: number = RECONCILE_MS): () => Promise<Outcome> {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting: Promise<Outcome> | null = null;
  const bounded = (): Promise<Outcome> => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Outcome>((done) => {
      timer = setTimeout(() => {
        live = false;
        done({ k: "late" });
      }, ms);
    });
    return Promise.race([reconcileOnce(d, () => live), late]).finally(() => clearTimeout(timer));
  };
  return () => {
    if (waiting) return waiting; // it has not read anything yet: it covers this trigger too
    const run = tail.then(() => {
      waiting = null;
      return bounded();
    });
    waiting = run;
    tail = run;
    return run;
  };
}

/**
 * The worker's reconcile over the real APIs (src/background/sw.ts). `access`: this start's own access-level call;
 * `note`: the worker's one-line-at-a-time diagnostics log; `off`: whether autofill is switched off
 * (platform/plugins/autofill-switch.ts switchedOff).
 */
export function workerReconciler(
  access: Promise<AccessResult>,
  note: (line: string) => void,
  off: () => Promise<boolean>,
): () => Promise<Outcome> {
  return createReconciler({
    usable: async () => (!(await scriptingHeld()) ? "unscripted" : (await off()) ? "off" : "on"),
    gate: () => closedBy(access),
    hosts: () => readList(),
    granted: (host) => siteGranted(host),
    apply: (hosts) => applyRegistration(hosts),
    note,
  });
}

/** What followSwitch gives back once autofill is off and unregistered (the worker's real calls: sw.ts). */
export type GiveBack = {
  /** Each listed site's own grant, the switch read again before each (platform/plugins/autofill-switch.ts giveBackSites). */
  sites(off: () => Promise<boolean>): Promise<unknown>;
  /** `scripting`. */
  scripting(): Promise<unknown>;
};
/**
 * Autofill's switch, followed by the worker (wave 1b; PLUGINS-W1B-NOTES.md §3): a run of `reconcile`, and then, if
 * autofill is off and that run unregistered (an outcome "applied", none), each listed site's grant given back, and then
 * `scripting`. Never `scripting` first: given back, the registration calls are gone and Chrome still runs the
 * registration where a grant remains. A run that failed or was given up gives back nothing: `scripting` stays, so the next
 * run can unregister, and the gate (platform/plugins/autofill-gate.ts) refuses every code meanwhile. Called on a change
 * of the grant store only (the switch is a write there: autofill-switch.ts watchSwitch), never at a worker start or on a
 * grant, at once or later: an On click's grant comes before its switch is written (and may be what starts the worker,
 * and its write may wait for the vault's lock as long as another page holds it), and must not be given back in between.
 * Where something got `scripting` back while Off (a Fill click whose page hint was missing), that click writes the
 * record again, unchanged, once the gate says Off (autofill-gate.ts touchSwitch): a write, so followed, with the switch
 * as it is then, and no clock involved. The switch is read again before each site and before `scripting` goes, so an
 * On written while the run was out keeps its grants.
 */
export async function followSwitch(
  reconcile: () => Promise<Outcome>,
  off: () => Promise<boolean>,
  giveBack: GiveBack,
  held: () => Promise<boolean> = scriptingHeld,
): Promise<void> {
  const ran = await reconcile();
  if (ran.k !== "applied" || ran.hosts.length > 0) return;
  if (!(await off())) return;
  await giveBack.sites(off);
  if ((await held()) && (await off())) await giveBack.scripting();
}
