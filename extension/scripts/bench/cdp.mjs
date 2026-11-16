// Raw-CDP launcher for the popup benchmarks (docs/research/ux-study.md §2.3 and appendix A; PHASE0X-PLAN A2). A manual
// tool, not part of CI. It drives Chrome for Testing directly over the DevTools protocol, without Playwright attached, so
// the extension's service worker can stop on its own and the toolbar popup is the real one (Extensions.triggerAction).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { chromium } from "@playwright/test";

/** The browser Playwright installed for the e2e tests (`npx playwright install chromium`). Override with CHROME_BIN. */
export const BIN = process.env.CHROME_BIN ?? chromium.executablePath();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let siteServer;
/** A local page with a one-time-code field, opened as the current tab at http://github.localhost:<port>/. */
export async function startSite() {
  if (siteServer) return siteServer.port;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><title>GitHub 2FA</title><h1>Two-factor authentication</h1><form><input autocomplete="one-time-code" inputmode="numeric" maxlength="6" name="otp"></form>`,
    );
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  siteServer = { srv, port: srv.address().port };
  return siteServer.port;
}

export async function launch({ profile, dist, headless = true, prefix = [], extraArgs = [] }) {
  const port = await startSite();
  const portFile = join(profile, "DevToolsActivePort");
  if (existsSync(portFile)) rmSync(portFile);
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--enable-unsafe-extension-debugging",
    `--load-extension=${dist}`,
    `--disable-extensions-except=${dist}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--window-size=1280,860",
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const cmd = prefix.length ? prefix[0] : BIN;
  const cargs = prefix.length ? [...prefix.slice(1), BIN, ...args] : args;
  const t0 = Date.now();
  const proc = spawn(cmd, cargs, { stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr.on("data", () => {});
  while (!existsSync(portFile)) {
    await sleep(20);
    if (Date.now() - t0 > 20000) throw new Error("no DevToolsActivePort");
  }
  await sleep(30);
  const [p, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${p}${path}`);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const on = (fn) => {
    listeners.push(fn);
    return () => listeners.splice(listeners.indexOf(fn), 1);
  };
  const evaluate = async (sessionId, expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  const close = async () => {
    try {
      await send("Browser.close");
    } catch {}
    await new Promise((r) => {
      proc.once("exit", r);
      setTimeout(r, 3000);
    });
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  await send("Target.setDiscoverTargets", { discover: true });
  return { proc, ws, send, on, evaluate, close, sitePort: port, launchedAt: t0 };
}

export async function targets(b) {
  return (await b.send("Target.getTargets", { filter: [{}] })).targetInfos;
}

export async function waitTarget(b, pred, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const t = (await targets(b)).find(pred);
    if (t) return t;
    if (Date.now() - t0 > timeout) throw new Error("target timeout");
    await sleep(15);
  }
}

export async function attach(b, targetId) {
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

/** Wait until one of the given performance marks exists in the page; returns its name. */
export async function waitMark(b, sid, names, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const got = await b
      .evaluate(sid, `(${JSON.stringify(names)}).find(n => performance.getEntriesByName(n).length) || null`)
      .catch(() => null);
    if (got) return got;
    if (Date.now() - t0 > timeout) throw new Error("mark timeout " + names);
    await sleep(10);
  }
}

/**
 * Injected into every popup before its first script runs (Page.addScriptToEvaluateOnNewDocument), so any build can be
 * measured as it ships, with no instrumented copy: marks for the lock screen and the first code (and the frame after
 * it), and a count of chrome.storage reads with the bytes they returned (as JSON), also taken at the first code.
 */
export const INSTRUMENT = `(() => {
  if (globalThis.__sk) return;
  const sk = globalThis.__sk = { localGet: 0, localGetBytes: 0, sessionGet: 0, atFirstCode: null };
  const wrap = (area, name) => {
    if (!area) return;
    const get = area.get.bind(area);
    area.get = async (k) => { const r = await get(k); sk[name + "Get"]++; if (name === "local") sk.localGetBytes += JSON.stringify(r).length; return r; };
  };
  if (globalThis.chrome && chrome.storage) { wrap(chrome.storage.local, "local"); wrap(chrome.storage.session, "session"); }
  let a = 0, b = 0;
  new MutationObserver(() => {
    if (!a && document.querySelector(".row .code:not(.wait)")) {
      a = 1; performance.mark("x:firstcode");
      sk.atFirstCode = { localGet: sk.localGet, localGetBytes: sk.localGetBytes, sessionGet: sk.sessionGet };
      requestAnimationFrame(() => setTimeout(() => performance.mark("x:firstcode-paint"), 0));
    }
    if (!b && document.querySelector("#secret")) { b = 1; performance.mark("x:lockscreen"); }
  }).observe(document, { childList: true, subtree: true, characterData: true });
})()`;

export const COLLECT = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const marks = Object.fromEntries(performance.getEntriesByType("mark").map(m => [m.name, +m.startTime.toFixed(2)]));
  const res = performance.getEntriesByType("resource").map(r => ({ n: r.name.split("/").pop(), t: r.initiatorType, d: +r.duration.toFixed(1), s: +r.startTime.toFixed(1) }));
  return { timeOrigin: performance.timeOrigin, nav: nav && { fetchStart: nav.fetchStart, responseEnd: +nav.responseEnd.toFixed(2), domInteractive: +nav.domInteractive.toFixed(2), dcl: +nav.domContentLoadedEventEnd.toFixed(2), load: +nav.loadEventEnd.toFixed(2) }, marks, res, sk: globalThis.__sk, rows: document.querySelectorAll(".row").length, w: innerWidth, h: innerHeight };
})()`;
