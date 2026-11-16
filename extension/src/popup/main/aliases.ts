// "Same sign-in" suggestions in the popup's and the side panel's list (TOTP autofill Stage 3, AF3-4; the plan's §3.4,
// §4.5; docs/design/notes/AUTOFILL3-NOTES.md §8): a lazy chunk, which Main (Main.tsx `aliasView`) loads after the first code
// on a page no account is registered for, when some account has a registered site. Its answer is the line each such
// account's row then shows, under "Possibly related" ("Same sign-in as <its registered site>"); filterRows (./model.ts)
// makes those rows `related`, never `registered`: no Fill button, and nothing is registered until the user's "Remember"
// (TOTP-AUTOFILL §5.1 M1, M2).
// The groups are Apple's (shared-credentials.json), in the package's baseline bundle (platform/package-data.ts readRules):
// never a live bundle's, which carries none (the maintainers' C29; format.ts refuses one that does). The rule is
// core/rules/alias.ts aliasRelated's. Its text is the Fill card's lazy catalog's (./fill-text.ts), so the popup's counted
// catalog does not carry it.
// When the list shows an answer is decided here, so the popup's counted code holds only the call (the maintainers' C30):
// `ask` keeps each page's answer and redraws the list when it came within 300 ms of the lookup's start, the moment Main's
// effect began it, before this chunk was loaded, so the chunk's load counts in the 300 ms (the plan's N9, C22: before the
// user can aim at a row), and changes something; `shown` gives the list what it reads when it is rebuilt anyway
// (Main.tsx).
import { matchTier } from "../../core/match";
import { aliasRelated } from "../../core/rules/alias";
import type { Entry } from "../../core/vault/model";
import { readRules } from "../../platform/package-data";
import { ft } from "./fill-text";
import { aliasKey } from "./model";

/** The line for each account Apple's list offers on `host`, by aliasKey; empty when there is none, or no text. */
export async function aliasNotes(entries: readonly Entry[], host: string): Promise<Map<string, string>> {
  const b = await readRules(); // the package's own file, checked as a baseline bundle (a live one is never read here)
  const found = aliasRelated(entries, host, b?.kind === "baseline" ? b.aliases : []);
  if (found.size) await ft.loaded;
  if (!ft.words()) return new Map(); // no text could be read: no line, and so no row moved (never a key name)
  return new Map(
    entries.filter((e) => found.has(e.id)).map((e) => [aliasKey(e), ft("afAlias", found.get(e.id)!)] as const),
  );
}

/**
 * Each page's answer, by its host, as its last lookup gave it (the side panel visits many: a late one stays its page's);
 * an answer with no line is not kept. What it holds: hosts visited, the ids and sites of the accounts offered there and
 * their lines; no secret, in this page's memory only. A lock empties it (round 2's r2-b): every lock bumps
 * `sk_lock_epoch` in chrome.storage.session (platform/session.ts LOCK_EPOCH_KEY, spelled again here, as
 * platform/fill-request.ts does, so this chunk imports nothing more from the counted code), and an unlock asks again.
 */
let pages = new Map<string, Map<string, string>>();
try {
  chrome.storage.session.onChanged.addListener((changes) => {
    if ("sk_lock_epoch" in changes) pages = new Map();
  });
} catch {
  /* no session area (a unit test's stand-in): nothing to follow */
}

/**
 * Looks `host` up for `entries` and keeps the answer as that page's. `at`: when Main began the lookup (`Date.now()`, before
 * it loaded this chunk). `redraw` is called when the answer came within 300 ms of `at` and changes something: a later one
 * draws nothing (the list reads it when it is rebuilt anyway), and neither does an empty answer where there was none (the
 * review's N5). Never rejects: a lookup that fails keeps what the page had.
 */
export async function ask(entries: readonly Entry[], host: string, at: number, redraw: () => void): Promise<void> {
  try {
    const m = await aliasNotes(entries, host);
    const had = pages.get(host);
    if (m.size) pages.set(host, m);
    else pages.delete(host);
    if ((m.size || had?.size) && Date.now() - at < 300) redraw();
  } catch {
    /* the page keeps what it had */
  }
}

/**
 * The lines the list shows on `host`: its kept answer, but none once an account is registered for the page (the review's
 * N4: as the next opening, which asks nothing there).
 */
export const shown = (entries: readonly Entry[], host: string | null): Map<string, string> | undefined =>
  host !== null && !entries.some((e) => matchTier(e, host) === "registered") ? pages.get(host) : undefined;
