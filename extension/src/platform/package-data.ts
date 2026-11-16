// The extension's own data files, read from its package (TOTP autofill Stage 3, AF3-3a; docs/design/notes/AUTOFILL3-NOTES.md
// §4). One so far: the site rules' baseline bundle (core/rules/baseline.ts), rules/baseline.json in every build.
//
// - From the package only: fetch of chrome.runtime.getURL(BASELINE_FILE), the one path this module asks for. A package
//   file is the extension's own: neither the manifest's CSP nor a page's `connect-src 'none'` stands in its way (the
//   plan's P3, which test/e2e/rules-package.spec.ts measures on the real build), no permission is involved and nothing
//   leaves the computer. No web page can read it (it is not web-accessible: check-dist holds the manifest to that).
// - Once per context: the first call reads (calls that come while it reads wait for the same read), and every later one
//   gets the same answer, kept in memory for the life of the worker or page that asked. Nothing of it is written
//   anywhere: no chrome.storage area (where a get(null) would read it at every open), no IndexedDB, no localStorage.
// - Bounded: at most BASELINE_MAX_BYTES, and READ_MS for the whole read, the body's too (a lost answer ends it). A read
//   that fails, takes too long, is too large, or is not a valid baseline bundle is null, and the finder works on its
//   heuristics alone, as before Stage 3. What the file says (an error status, too large, not UTF-8, not JSON, not a
//   baseline bundle) is kept as the answer: the package does not change while the extension runs. A read that was lost
//   (it took too long, or the request itself failed) is not: the next call reads again, since a side panel can stay open
//   for hours after one slow moment.
// Who calls it: the popup's and the side panel's Fill paths, through platform/site-rule.ts, when they look at a page an
// account is registered for, with `scripting` held (AF3-3b); and their "same sign-in" lines, through
// popup/main/aliases.ts, after the first code on a page no account is registered for, when some account has a site
// (AF3-4). Both are lazy chunks, and the bundler puts this module in one of its own that both load (check-dist holds it
// there). Not the worker: its `fill` shortcut takes no rule (the maintainers' C27), and check-dist refuses this read in
// sw.js. So, once any account has a site, an open on any web page reads it (once for the popup's or the panel's life);
// nothing is read when no account has a site, when the tab is no web page, before the first code on a page no account is
// registered for, or without `scripting` on one an account is.
import { BASELINE_FILE, BASELINE_MAX_BYTES, parseBaseline } from "../core/rules/baseline";
import type { Bundle } from "../core/rules/format";

// The e2e build's bundle also holds the test rules of its fixture hosts, which are under reserved names (`.test`):
// scripts/build.mjs defines this true there, and false in every other build, whose bundle check-dist holds to none. Used
// in the call itself, where the minifier folds it to `allowReserved:!0` or `!1`, which check-dist reads.
declare const __SK_RULES_TEST_HOSTS__: boolean;

/** The whole read, at most: a package file is read in milliseconds, so one that takes this long was lost. */
export const READ_MS = 5000;

let rules: Promise<Bundle | null> | undefined;

/** The packaged baseline bundle, checked: the same answer for every call in this context; null if it cannot be had. */
export function readRules(): Promise<Bundle | null> {
  return (rules ??= load().catch(() => {
    rules = undefined; // a lost read: the next call reads again
    return null;
  }));
}

/** The bundle, or null for what the file says; throws (rejects) only when the read itself was lost. */
async function load(): Promise<Bundle | null> {
  const res = await fetch(chrome.runtime.getURL(BASELINE_FILE), { signal: AbortSignal.timeout(READ_MS) });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BASELINE_MAX_BYTES) {
      reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null; // not UTF-8
  }
  const read = parseBaseline(text, {
    allowReserved: typeof __SK_RULES_TEST_HOSTS__ === "boolean" && __SK_RULES_TEST_HOSTS__,
  });
  return read.ok ? read.value : null;
}
