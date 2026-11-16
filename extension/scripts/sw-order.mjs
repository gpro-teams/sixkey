// The order of the built service worker's first calls (TOTP-AUTOFILL §4.2 items 2 and 3, scripts/check-dist.mjs). The
// bundle is one file with no imports; it is run once, synchronously, in a Node `vm` over a `chrome.*` stand-in that logs
// the calls and never settles an asynchronous one, so only the top-level code of the file runs. The three
// `setAccessLevel` calls (storage.local, storage.session, and storage.sync for the backup in Chrome's sync storage:
// CSB-3, the maintainers' C7) must be the first three logged calls: before any listener is added and before any
// storage access. This is the check on the BUILT order; the unit tests run the source, where the
// module order is not the bundler's. (Adapted from the independent review's probe, tools/sw-order-probe.mjs.)
import vm from "node:vm";

/** The top level of the built worker run once over the stand-in: the calls it logged, or the error it threw. */
function topLevelCalls(src) {
  const log = [];
  const stub = (path) =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === "then" ? undefined : stub(`${path}.${String(k)}`)),
      apply: (_t, _this, args) => {
        void args;
        if (path.endsWith(".addListener")) log.push(`addListener ${path.slice(0, -".addListener".length)}`);
        else if (/storage\.(local|session|sync)\.(get|set|remove|setAccessLevel)$/.test(path)) log.push(path);
        if (path === "chrome.runtime.getManifest") return { version: "0.0.0" };
        return new Promise(() => undefined);
      },
    });
  const ctx = vm.createContext({
    chrome: stub("chrome"),
    console,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    URL,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    navigator: { locks: stub("navigator.locks"), userAgent: "x" },
    self: {},
    queueMicrotask,
    indexedDB: stub("indexedDB"),
    fetch: stub("fetch"),
    AbortController,
    structuredClone,
    Response,
    Headers,
    Request,
    atob,
    btoa,
  });
  ctx.globalThis = ctx;
  try {
    vm.runInContext(src, ctx, { filename: "sw.js", timeout: 5000 });
  } catch (e) {
    return { log, error: e };
  }
  return { log, error: null };
}

/** @returns {{ ok: boolean, reason: string, first: string[] }} */
export function swAccessLevelOrder(src) {
  const { log, error } = topLevelCalls(src);
  if (error)
    return { ok: false, reason: `the worker's top level threw under the stand-in: ${error}`, first: log.slice(0, 8) };
  const first = log.slice(0, 8);
  const set = log.filter((e) => e.endsWith(".setAccessLevel"));
  const all =
    log.slice(0, 3).sort().join() ===
    "chrome.storage.local.setAccessLevel,chrome.storage.session.setAccessLevel,chrome.storage.sync.setAccessLevel";
  if (!all || set.length !== 3)
    return {
      ok: false,
      reason: `the first three calls of the worker must be storage.local.setAccessLevel, storage.session.setAccessLevel and storage.sync.setAccessLevel, once each (before any listener or storage access); the first calls are: ${first.join(", ") || "none"}`,
      first,
    };
  return { ok: true, reason: "", first };
}

/**
 * What the toolbar icon opens (src/platform/action-mode.ts, src/background/action-first.ts) is set right after the access
 * level, before any other listener and any other storage access: the next three calls are the click listener, the change
 * listener and the one read of the choice and the profile. A worker that does not read them at start would leave the
 * icon as the last worker set it, or as the manifest says after a browser restart (docs/design/notes/SIDEPANEL-NOTES.md).
 * @returns {{ ok: boolean, reason: string, first: string[] }}
 */
export function swActionFirst(src) {
  const { log, error } = topLevelCalls(src);
  const first = log.slice(0, 8);
  if (error) return { ok: false, reason: `the worker's top level threw under the stand-in: ${error}`, first };
  const want = [
    "addListener chrome.action.onClicked",
    "addListener chrome.storage.local.onChanged",
    "chrome.storage.local.get",
  ];
  const got = log.slice(3, 6);
  if (got.join() !== want.join())
    return {
      ok: false,
      reason: `right after the access level, the worker must add the toolbar icon's click and change listeners and read what the icon opens (${want.join(", ")}); the calls are: ${first.join(", ") || "none"}`,
      first,
    };
  return { ok: true, reason: "", first };
}
