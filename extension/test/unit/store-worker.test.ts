// The service worker of a build without the sync user interface (the store build: scripts/sync-ui.mjs, its release gate
// closed), as src/background/sw.ts wires it then, over the fake chrome.* of test/helpers/sw-world.ts, beside the same
// worker with the gate open (the dev and e2e builds). Closed: no sync worker, no bridge and no transport, so a start
// reads no sync record, asks nothing about the API's permission and fetches nothing, and the bridge's message gets no
// answer; everything else is as with the gate open: the same listeners but the bridge's, the pages' messages answered,
// the backup in Chrome sync turned on from the settings page, the alarms, and autofill's permission events (where every
// event that names a host may be about a site: there is no API permission to tell apart). And the API's host for
// autofill when the build's API origin is empty, as the store build's is. The store build itself: check-dist (no fetch
// in its worker, no API host in any shipped file) and test/e2e/store-worker.spec.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITES_KEY } from "../../src/platform/autofill-sites";
import { loadWorker, unload, wait, type World } from "../helpers/sw-world";

const OPTIONS = {
  id: "abcdefghijklmnopabcdefghijklmnop",
  url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options/index.html",
};
const POPUP = { ...OPTIONS, url: OPTIONS.url.replace("options", "popup") };
const API = "https://api.sixkey.app/*";
/** A message to the worker, as Chrome hands it to every listener: the answer, or "no answer" when no listener kept it. */
const ask = (w: World, msg: Record<string, unknown>, sender = OPTIONS) =>
  new Promise<unknown>((resolve) => {
    const kept = w.send(msg, sender, resolve).some((r) => r === true);
    if (!kept) resolve("no answer");
  });
/** How many listeners of each kind the worker registered. */
const counts = (w: World) => Object.fromEntries(Object.entries(w.listeners).map(([k, v]) => [k, v.length]));
const fire = (w: World, name: "permAdded" | "permRemoved", origins: string[]) => {
  for (const l of w.listeners[name]!) l({ origins });
};
/** What the worker asked Chrome about the API's pattern. */
const aboutApi = (w: World) => w.perms.filter(([, o]) => (o as string[]).includes(API));
/** What it asked about sites (each listed site's own pattern). */
const aboutSites = (w: World) => w.perms.filter(([k, o]) => k === "contains" && !(o as string[]).includes(API));
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);

describe("the worker with the sync release gate closed (the store build)", () => {
  afterEach(() => {
    unload();
    process.off("unhandledRejection", onError);
  });

  it("registers the same listeners as with the gate open, but the bridge's; nothing fails at its start", async () => {
    process.on("unhandledRejection", onError);
    const open = counts(await loadWorker({ syncUi: true }));
    await wait();
    unload();
    const w = await loadWorker({ syncUi: false });
    await wait();
    expect(counts(w)).toEqual({ ...open, message: open.message! - 1 });
    expect(counts(w)).toMatchObject({ message: 3, alarm: 1, installed: 1, startup: 1, permAdded: 1, permRemoved: 1 });
    expect(errors).toEqual([]);
    expect(w.fx.fetched).toEqual([]);
    expect((w.local.data.get("sk_diag") ?? []) as unknown[]).toEqual([]);
  });

  it("reads no sync record and asks nothing about the API's permission, at its start or a browser's", async () => {
    const open = await loadWorker({ syncUi: true });
    await wait();
    expect(open.syncReads()).toBeGreaterThan(0); // the probe sees the open gate's start
    for (const l of open.listeners.startup!) l();
    await wait();
    expect(aboutApi(open).length).toBeGreaterThan(0);
    unload();
    const w = await loadWorker({ syncUi: false });
    await wait();
    for (const l of w.listeners.startup!) l();
    for (const l of w.listeners.alarm!) l({ name: "sk-sync-periodic" });
    await wait();
    expect(w.syncReads()).toBe(0);
    expect(w.local.reads.flat().filter((k) => k.startsWith("sk_sync_"))).toEqual([]);
    expect(aboutApi(w)).toEqual([]);
    expect(w.badges).toEqual([]);
    expect(w.fx.fetched).toEqual([]);
  });

  it("answers the pages' messages, sync's without effect; the bridge's gets no answer", async () => {
    const w = await loadWorker({ syncUi: false });
    await wait();
    for (const type of ["sk-sync-soon", "sk-sync-changed", "sk-reschedule-autolock"])
      expect(await ask(w, { type }, type === "sk-sync-changed" ? OPTIONS : POPUP), type).toBe("no answer");
    await wait();
    expect(w.syncReads()).toBe(0);
    // a sync page's signed request: no listener keeps the channel, nothing is sent
    expect(await ask(w, { type: "sk-api", request: { method: "GET", path: "/v1/devices", headers: {} } })).toBe(
      "no answer",
    );
    await wait();
    expect(w.fx.fetched).toEqual([]);
  });

  it("the backup in Chrome sync turns on from the settings page, as with the gate open", async () => {
    const w = await loadWorker({ syncUi: false });
    await wait();
    expect(await ask(w, { type: "sk-csb-on" }, POPUP)).toBe("no answer");
    expect(await ask(w, { type: "sk-csb-on" })).toEqual({ ok: true });
    expect(w.local.data.get("sk_csb_cfg")).toMatchObject({ on: true });
  });

  it("autofill's permission events: every event that names a host reconciles the sites, the API's pattern too", async () => {
    const seed = { [SITES_KEY]: { v: 1, hosts: ["github.com"] } };
    const open = await loadWorker({ syncUi: true, seedLocal: seed, grants: ["https://github.com/*"] });
    await wait();
    let n = aboutSites(open).length;
    fire(open, "permAdded", [API]); // with sync: the API's own pattern is sync's, not a site's
    await wait();
    expect(aboutSites(open).length).toBe(n);
    unload();
    const w = await loadWorker({ syncUi: false, seedLocal: seed, grants: ["https://github.com/*"] });
    await wait();
    n = aboutSites(w).length;
    expect(n).toBeGreaterThan(0); // the start's reconcile
    fire(w, "permAdded", [API]); // without sync there is no API permission: any host may be a site's
    await wait();
    expect(aboutSites(w).length).toBe(n + 1);
    fire(w, "permRemoved", ["https://github.com/*"]);
    await wait();
    expect(aboutSites(w).length).toBe(n + 2);
    expect(aboutApi(w)).toEqual([]);
  });
});

describe("the API's host for autofill, from the build's API origin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  it("the sync API's host with an origin; none when the build's is empty (the store build), so every site may be one", async () => {
    vi.resetModules();
    vi.stubGlobal("__API_ORIGIN__", "https://api.sixkey.app");
    expect((await import("../../src/platform/autofill-sites")).API_HOST).toBe("api.sixkey.app");
    vi.resetModules();
    vi.stubGlobal("__API_ORIGIN__", "");
    const { API_HOST } = await import("../../src/platform/autofill-sites");
    const { siteHostOk, sitePattern } = await import("../../src/core/autofill-sites");
    expect(API_HOST).toBe("");
    expect(sitePattern("github.com", API_HOST)).toBe("https://github.com/*");
    expect(siteHostOk("", API_HOST)).toBe(false); // no host is the empty one
  });
});
