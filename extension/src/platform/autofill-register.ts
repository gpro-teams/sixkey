// The one content-script registration of TOTP autofill Stage 2 (patch 3; AUTOFILL2-PLAN §3.2; docs/design/notes/AUTOFILL2-NOTES.md
// §9): reconcile's `apply` (platform/autofill-reconcile.ts), the only caller of chrome.scripting's registration calls.
// It makes the registration exactly what reconcile worked out, the sites that count (the list ∩ Chrome's grants, behind
// this worker start's storage gate), and it asks STORAGEGATE's gate once more, now, before it registers anything: no
// script of Sixkey's goes into a page unless storage.local and storage.session are closed to content scripts at that
// moment (storageClosed, as before every injection of Stage 1). Gated, failed, or no site: unregistered.
//
// The registration, one object, the same for a first register and an update (check-dist pins it in the built worker):
//   id "sk-suggest"; js exactly the finder, then the content script (inject/otp.js, inject/suggest.js: the same isolated
//   world as Stage 1's injections, so one finder per page); matches exactly each site's one pattern (https on that exact
//   host); every frame of those pages; at document_idle; kept across browser restarts (reconcile at every worker start
//   makes it right again either way). No `world` (the isolated world only), no `matchOriginAsFallback` (no about:blank,
//   srcdoc or blob: frame: the worker would refuse what it sent anyway), no CSS.
// Chrome never injects it where the grant is missing [probed, Chromium 156], so a site withdrawn in Chrome's own UI stops
// getting it at its next load even before reconcile removes it from `matches`.
import { sitePattern } from "../core/autofill-sites";
import { storageClosed } from "./storage-access";

/** The registration's ID. */
export const SCRIPT_ID = "sk-suggest";
/** Its files, in order: the finder first (the content script uses it). */
export const SCRIPT_FILES = ["inject/otp.js", "inject/suggest.js"] as const;

type Registered = { id: string; matches?: string[]; js?: string[] };
/** The chrome.scripting calls used here (tests pass fakes). */
export type Registrar = {
  getRegisteredContentScripts(f: { ids: string[] }): Promise<Registered[]>;
  registerContentScripts(s: object[]): Promise<void>;
  updateContentScripts(s: object[]): Promise<void>;
  unregisterContentScripts(f: { ids: string[] }): Promise<void>;
};

const same = (a: readonly string[] | undefined, b: readonly string[]) =>
  !!a && a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** How long an apply waits for the one before it to end (P3 verify NIT-1). */
export const APPLY_WAIT_MS = 10_000;
let previous: Promise<unknown> = Promise.resolve();

/**
 * Make the registration cover exactly these sites (reconcile's `apply`): registered for the first, updated when its
 * sites or files differ, unregistered when there are none, or when storage cannot be closed to content scripts now.
 * Applies run one after another (P3 verify NIT-1): a reconcile run given up while its apply was out may still finish it,
 * and the next run's apply then reads what that one wrote instead of racing it (two registrations of the one ID). Each
 * waits at most APPLY_WAIT_MS for the one before, so a call the browser never answers holds nothing up for good.
 */
export function applyRegistration(
  hosts: readonly string[],
  // `scripting` is optional (W1b): read when the call is made, and an apply without it does nothing (applyNow)
  c: Registrar | undefined = globalThis.chrome?.scripting as unknown as Registrar | undefined,
  gate: () => Promise<boolean> = storageClosed,
  waitMs: number = APPLY_WAIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const turn = Promise.race([previous, new Promise((done) => (timer = setTimeout(done, waitMs)))]).finally(() =>
    clearTimeout(timer),
  );
  const run = turn.then(
    () => applyNow(hosts, c, gate),
    () => applyNow(hosts, c, gate),
  );
  previous = run.catch(() => undefined);
  return run;
}

async function applyNow(
  hosts: readonly string[],
  c: Registrar | undefined,
  gate: () => Promise<boolean>,
): Promise<void> {
  if (!c?.getRegisteredContentScripts) return; // no `scripting` (W1b): nothing can be, or is, registered
  const patterns = hosts.map((h) => sitePattern(h)).filter((p): p is string => p !== null);
  const want = patterns.length > 0 && (await gate()) ? patterns : [];
  const [have] = await c.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (want.length === 0) {
    if (have) await c.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  const script = {
    id: SCRIPT_ID,
    js: [...SCRIPT_FILES],
    matches: want,
    allFrames: true,
    runAt: "document_idle",
    persistAcrossSessions: true,
  };
  if (!have) await c.registerContentScripts([script]);
  else if (!same(have.matches, want) || !same(have.js, SCRIPT_FILES)) await c.updateContentScripts([script]);
}
