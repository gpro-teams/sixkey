// Asks the browser how this copy was installed (SYNC-DESIGN H4, PHASE0X-PLAN C3); src/core/install-source.ts decides
// whether that is a problem. chrome.management.getSelf() needs no permission. No network: the store ID is a constant
// built in (scripts/store-id.mjs), never looked up.
//
// Timing: the check never runs on the way to the first frame. It starts a moment after the page has drawn (by then
// the popup's first codes are on screen) and only when the main thread is idle. The last answer is kept in this
// copy's localStorage and read synchronously, so from the second opening on, the banner is in the first frame and
// does not push the list down under the pointer. localStorage belongs to the extension's origin, which is its ID: a
// copy with another ID never sees this copy's answer.
import { installProblem, type InstallProblem } from "../core/install-source";

// Replaced by scripts/build.mjs (Vite define). Read through typeof, so code that runs unbuilt (unit tests) sees them as
// unset: no store ID, check off.
declare const __STORE_ID__: string;
declare const __INSTALL_CHECK__: boolean;

const CACHE_KEY = "sk_install";
const PROBLEMS: readonly string[] = ["not_store", "id_mismatch"] satisfies InstallProblem[];
/** How long after the first call to wait before asking, then for an idle moment (at most a second more). */
const AFTER_MS = 300;

/** The Chrome Web Store ID this build carries: Sixkey's in the prod build (scripts/store-id.mjs), "" in dev and e2e. */
export function storeId(): string {
  return typeof __STORE_ID__ === "string" ? __STORE_ID__ : "";
}

/**
 * Whether this build checks at all: the prod build does; dev and e2e builds, always loaded unpacked, do not. A constant,
 * so a build without the check has none of its code (check-dist relies on that to tell the two apart).
 */
const ENABLED = typeof __INSTALL_CHECK__ === "boolean" && __INSTALL_CHECK__;

/** The answer of the last check, synchronously, for a page's first frame. Null when the build does not check. */
export function lastInstallProblem(): InstallProblem | null {
  if (!ENABLED) return null;
  try {
    const v = localStorage.getItem(CACHE_KEY);
    return v !== null && PROBLEMS.includes(v) ? (v as InstallProblem) : null;
  } catch {
    return null;
  }
}

function remember(p: InstallProblem | null): void {
  try {
    if (p) localStorage.setItem(CACHE_KEY, p);
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* without storage, the banner just comes a moment after the first frame each time */
  }
}

const idle = () =>
  new Promise<void>((resolve) =>
    setTimeout(
      () =>
        typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 1000 }) : resolve(),
      AFTER_MS,
    ),
  );

let pending: Promise<InstallProblem | null> | undefined;

/**
 * Check how this copy was installed: once per page, however many components ask. Never rejects. If the browser does
 * not answer, the last known answer stands and is kept.
 */
export function checkInstallSource(): Promise<InstallProblem | null> {
  if (!ENABLED) return Promise.resolve(null);
  return (pending ??= idle()
    .then(() => chrome.management.getSelf())
    .then(
      (self) => {
        const p = installProblem(self, storeId());
        remember(p);
        return p;
      },
      () => lastInstallProblem(),
    ));
}
