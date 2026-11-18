// The service worker (src/background/sw.ts) over the fake chrome.* of test/helpers/sw-world.ts, as every build wires it
// since the server sync's client went (OWNER-DECISIONS/25, DV-0b): there is no sync worker, no bridge and no transport in
// any build, so a start reads no sync record, asks nothing about an API permission and fetches nothing, and the server
// sync's messages and alarms get no answer and do nothing; the pages' messages are answered, the backup in Chrome sync
// turns on from the settings page, and every permission event that names a host may be about a site (there is no API
// permission to tell apart). Each with the developer builds' define on and off (__SYNC_DEV__: their test hooks and the
// leftovers' removal, test/unit/no-server-sync.test.ts), which changes none of this. The store build itself:
// check-dist (no fetch in its worker, no API host in any shipped file) and test/e2e/store-worker.spec.ts.
import { afterEach, describe, expect, it } from "vitest";
import { siteHostOk, sitePattern } from "../../src/core/autofill-sites";
import { SITES_KEY } from "../../src/platform/autofill-sites";
import { loadWorker, unload, wait, type World } from "../helpers/sw-world";

const OPTIONS = {
  id: "abcdefghijklmnopabcdefghijklmnop",
  url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options/index.html",
};
const POPUP = { ...OPTIONS, url: OPTIONS.url.replace("options", "popup") };
/** The server sync's API origin's pattern, which the dev and e2e builds' manifests declared until DV-0b. */
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
/** The server sync's records in chrome.storage.local, as it named them. */
const syncKeys = (w: World) => w.local.reads.flat().filter((k) => k.startsWith("sk_sync_") || k === "sk_prejoin");
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);
const BUILDS = [false, true] as const; // the store and test builds' define, and the dev and e2e builds'

describe("the worker without the server sync, in every build", () => {
  afterEach(() => {
    unload();
    process.off("unhandledRejection", onError);
  });

  it("registers the pages', the backup in Chrome sync's and the content script's message listeners, one of each other kind; nothing fails at its start", async () => {
    process.on("unhandledRejection", onError);
    for (const dev of BUILDS) {
      const w = await loadWorker({ dev });
      await wait();
      expect(counts(w), `dev=${dev}`).toMatchObject({
        message: 3,
        alarm: 1,
        installed: 1,
        startup: 1,
        permAdded: 1,
        permRemoved: 1,
      });
      expect(errors).toEqual([]);
      expect(w.fx.fetched).toEqual([]);
      expect((w.local.data.get("sk_diag") ?? []) as unknown[]).toEqual([]);
      unload();
    }
  });

  it("reads no sync record and asks nothing about the API's permission, at its start, a browser's, or the server sync's old alarm", async () => {
    for (const dev of BUILDS) {
      const w = await loadWorker({ dev });
      await wait();
      for (const l of w.listeners.startup!) l();
      for (const l of w.listeners.alarm!) l({ name: "sk-sync-periodic" });
      await wait();
      expect(syncKeys(w), `dev=${dev}`).toEqual([]);
      expect(aboutApi(w)).toEqual([]);
      expect(w.badges).toEqual([]); // nothing draws the toolbar's own badge (the sync badge went with its worker)
      expect(w.fx.fetched).toEqual([]);
      unload();
    }
  });

  it("the server sync's messages get no answer and do nothing; the pages' are taken", async () => {
    for (const dev of BUILDS) {
      const w = await loadWorker({ dev });
      await wait();
      const quick = w.quickReads();
      for (const type of ["sk-sync-soon", "sk-sync-changed"])
        expect(await ask(w, { type }, type === "sk-sync-changed" ? OPTIONS : POPUP), type).toBe("no answer");
      // a sync page's signed request: no listener keeps the channel, nothing is sent
      expect(await ask(w, { type: "sk-api", request: { method: "GET", path: "/v1/devices", headers: {} } })).toBe(
        "no answer",
      );
      await wait();
      expect(syncKeys(w)).toEqual([]);
      expect(w.quickReads()).toBe(quick);
      expect(w.fx.fetched).toEqual([]);
      // the idle alarm's re-arming is answered at once or not at all (never), and done
      expect(await ask(w, { type: "sk-reschedule-autolock" }, POPUP)).toBe("no answer");
      await wait();
      expect(w.quickReads()).toBe(quick + 1);
      unload();
    }
  });

  it("the backup in Chrome sync turns on from the settings page", async () => {
    for (const dev of BUILDS) {
      const w = await loadWorker({ dev });
      await wait();
      expect(await ask(w, { type: "sk-csb-on" }, POPUP)).toBe("no answer");
      expect(await ask(w, { type: "sk-csb-on" })).toEqual({ ok: true });
      expect(w.local.data.get("sk_csb_cfg")).toMatchObject({ on: true });
      unload();
    }
  });

  it("autofill's permission events: every event that names a host reconciles the sites, the old API's pattern too", async () => {
    const seed = { [SITES_KEY]: { v: 1, hosts: ["github.com"] } };
    for (const dev of BUILDS) {
      const w = await loadWorker({ dev, seedLocal: seed, grants: ["https://github.com/*"] });
      await wait();
      const n = aboutSites(w).length;
      expect(n).toBeGreaterThan(0); // the start's reconcile
      fire(w, "permAdded", [API]); // there is no API permission: any host may be a site's
      await wait();
      expect(aboutSites(w).length).toBe(n + 1);
      fire(w, "permRemoved", ["https://github.com/*"]);
      await wait();
      expect(aboutSites(w).length).toBe(n + 2);
      expect(aboutApi(w)).toEqual([]);
      unload();
    }
  });
});

describe("no API host for autofill", () => {
  it("every https site may be one, the server sync's API host too (it could be none while its client was there)", () => {
    expect(siteHostOk("api.sixkey.app")).toBe(true);
    expect(sitePattern("api.sixkey.app")).toBe("https://api.sixkey.app/*");
    expect(sitePattern("github.com")).toBe("https://github.com/*");
    expect(siteHostOk("")).toBe(false); // no host is the empty one
  });
});
