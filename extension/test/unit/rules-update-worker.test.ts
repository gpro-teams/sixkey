// The worker's end of the site rules' updater (TOTP autofill Stage 3, AF3-U2; src/background/sw.ts, src/platform/
// sender-policy.ts rulesMessage; docs/design/notes/AUTOFILL3-NOTES.md §10), over the fake chrome.* of sw-world.ts and a
// real IndexedDB (fake-indexeddb):
//   - gate closed (the store build): no listener of its own, the two messages taken by no listener, no answer, and the
//     daily alarm reads nothing of the updater's;
//   - gate open: `sk-af-rule` from the popup and the side panel only, `sk-af-rules-status` from the settings page only,
//     answered after the work (the channel kept open), and nothing at all for any other sender (another page, a content
//     script, another extension, a web page): no answer, no work;
//   - the switch turned on through Settings' message, a check at once, then the Fill paths' answer; `sk-daily` runs the
//     daily check; the test builds' hook (`__skRules`) only in a dev or e2e build.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorker, OTHER, SELF, unload, url } from "../helpers/sw-world";
import { bundleBytes, liveBundle, newKey, pinnedOf, signedManifest, type Key } from "../helpers/rules-live-kit";
import { RULES_SENDERS, rulesMessage } from "../../src/platform/sender-policy";

const ORIGIN = "https://rules.example.net";
const PATH = {
  popup: "/popup/index.html",
  sidepanel: "/sidepanel/index.html",
  options: "/options/index.html",
  offscreen: "/offscreen/index.html",
  worker: "/sw.js",
};
const web = "https://evil.example/";
const HOSTILE: [string, unknown][] = [
  ["a web page", { url: web, origin: "https://evil.example" }],
  ["another extension's page", { id: OTHER, url: url(PATH.options, OTHER) }],
  ["a content script (this extension's id, a web page's address)", { id: SELF, url: web, tab: { id: 3, url: web } }],
  ["an extension page in a tab with a web address", { id: SELF, url: url(PATH.options), tab: { url: web } }],
  ["no sender", undefined],
];
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let A: Key, B: Key;
beforeAll(async () => {
  [A, B] = [await newKey(), await newKey()];
});
// a fresh IndexedDB for each test (an earlier worker's connection stays open), as the global the worker's modules use
let idb: IDBFactory;
beforeEach(() => {
  idb = new IDBFactory();
  vi.stubGlobal("indexedDB", idb);
});
afterEach(unload);
const databases = async () => (await idb.databases()).map((d) => d.name);
const open = () => loadWorker({ rules: { keys: [pinnedOf(A), pinnedOf(B)], origin: ORIGIN, baseline: 1 } });
/** The rules server: the manifest and bundle of version 2, signed by A; every request recorded. */
async function serve(): Promise<string[]> {
  const b = liveBundle(2, undefined, { "login.example.com": "a" });
  const bytes = bundleBytes(b);
  const file = await signedManifest(A, bytes, b, { now: Date.now() });
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (u: string) => {
    asked.push(u);
    if (u === `${ORIGIN}/v1/manifest.json`) return new Response(file);
    if (u === `${ORIGIN}/v1/bundle-2.json`) return new Response(bytes);
    return new Response("{}", { status: 404 });
  });
  return asked;
}
/** Send to every listener; the replies given, and how many listeners kept the channel open. */
async function ask(w: Awaited<ReturnType<typeof loadWorker>>, msg: unknown, sender: unknown, ms = 60) {
  const replies: unknown[] = [];
  const kept = w.send(msg, sender, (r) => replies.push(r)).filter((r) => r === true).length;
  await wait(ms);
  return { kept, replies };
}

describe("gate closed (the store build)", () => {
  it("no listener of the updater's: the two messages are answered by none, from any page", async () => {
    const w = await loadWorker();
    expect(w.listeners.message).toHaveLength(3); // the pages', the cloud backup's, the content script's
    for (const s of ["popup", "sidepanel", "options"] as const)
      for (const type of ["sk-af-rule", "sk-af-rules-status"]) {
        const r = await ask(w, { type, host: "login.example.com", on: true }, { id: SELF, url: url(PATH[s]) }, 10);
        expect(r, `${type} from ${s}`).toEqual({ kept: 0, replies: [] });
      }
    expect(rulesMessage({ type: "sk-af-rule" }, { id: SELF, url: url(PATH.popup) }, SELF)).toBeNull();
    expect(RULES_SENDERS).toEqual({});
    // the daily alarm: the updater's database is never opened
    for (const l of w.listeners.alarm!) l({ name: "sk-daily" });
    await wait();
    expect(await databases()).not.toContain("sixkey-rules-live");
  });
});

describe("gate open", () => {
  it("one listener more, which takes the two messages from their own pages only, answered after the work", async () => {
    const w = await open();
    expect(w.listeners.message).toHaveLength(4);
    const allowed: Record<string, string[]> = {
      "sk-af-rule": ["popup", "sidepanel"],
      "sk-af-rules-status": ["options"],
    };
    for (const [type, from] of Object.entries(allowed))
      for (const s of Object.keys(PATH) as (keyof typeof PATH)[]) {
        const r = await ask(w, { type, host: "login.example.com" }, { id: SELF, url: url(PATH[s]) });
        if (from.includes(s)) {
          expect(r.kept, `${type} from ${s}`).toBe(1);
          expect(r.replies, `${type} from ${s}`).toHaveLength(1);
        } else expect(r, `${type} from ${s}`).toEqual({ kept: 0, replies: [] });
      }
  });
  it("nothing for a hostile sender: no answer, no work (the updater's database is not even opened)", async () => {
    const w = await open();
    for (const [what, sender] of HOSTILE)
      for (const type of ["sk-af-rule", "sk-af-rules-status"]) {
        const r = await ask(w, { type, host: "login.example.com", on: true }, sender, 10);
        expect(r, `${type} / ${what}`).toEqual({ kept: 0, replies: [] });
      }
    await wait();
    expect(await databases()).not.toContain("sixkey-rules-live");
  });
  it("Settings turns the switch on: a check at once; then the Fill paths get the live bundle's answer", async () => {
    const w = await open();
    const asked = await serve();
    const fill = { id: SELF, url: url(PATH.popup) };
    const settings = { id: SELF, url: url(PATH.options) };
    expect((await ask(w, { type: "sk-af-rule", host: "login.example.com" }, fill)).replies).toEqual([null]);
    const on = await ask(w, { type: "sk-af-rules-status", on: true }, settings, 300);
    expect(on.replies).toEqual([
      expect.objectContaining({ on: true, v: 2, base: 1, floor: null, host: "rules.example.net" }),
    ]);
    expect(asked).toEqual([`${ORIGIN}/v1/manifest.json`, `${ORIGIN}/v1/bundle-2.json`]);
    expect((await ask(w, { type: "sk-af-rule", host: "login.example.com" }, fill)).replies).toEqual([
      { v: 2, rule: expect.objectContaining({ id: "a", host: "login.example.com", from: "live" }) },
    ]);
    expect((await ask(w, { type: "sk-af-rule", host: "other.example.com" }, fill)).replies).toEqual([
      { v: 2, rule: null },
    ]);
    // a host that is no string: answered null, nothing looked up
    expect((await ask(w, { type: "sk-af-rule", host: 7 }, fill)).replies).toEqual([null]);
    // off: the next answer is null at once
    await ask(w, { type: "sk-af-rules-status", on: false }, settings);
    expect((await ask(w, { type: "sk-af-rule", host: "login.example.com" }, fill)).replies).toEqual([null]);
  });
  it("sk-daily runs the daily check: with the switch on and the check due, the manifest is read", async () => {
    const w = await open();
    const asked = await serve();
    await ask(w, { type: "sk-af-rules-status", on: true }, { id: SELF, url: url(PATH.options) }, 300);
    expect(asked).toHaveLength(2);
    for (const l of w.listeners.alarm!) l({ name: "sk-daily" }); // not due yet: nothing read
    await wait(100);
    expect(asked).toHaveLength(2);
    // the check made due (as a day later)
    await new Promise<void>((ok) => {
      const r = idb.open("sixkey-rules-live", 1);
      r.onsuccess = () => {
        const t = r.result.transaction("kv", "readwrite");
        t.objectStore("kv").put(0, "due");
        t.oncomplete = () => (r.result.close(), ok());
      };
    });
    for (const l of w.listeners.alarm!) l({ name: "sk-daily" });
    await wait(200);
    expect(asked.slice(2)).toEqual([`${ORIGIN}/v1/manifest.json`]); // the same version: the bundle not fetched again
  });
  it("another alarm (sk-autolock, a sync alarm) does not open the updater's database (the review's MY4)", async () => {
    const w = await open();
    for (const name of ["sk-autolock", "sk-quick-expiry", "sk-sync-periodic"])
      for (const l of w.listeners.alarm!) l({ name });
    await wait(100);
    expect(await databases()).not.toContain("sixkey-rules-live");
    for (const l of w.listeners.alarm!) l({ name: "sk-daily" }); // the daily one does (the switch is in it)
    await wait(100);
    expect(await databases()).toContain("sixkey-rules-live");
  });
  it("the test builds' hook starts a check; a build without the developer pages has none", async () => {
    const dev = await loadWorker({
      dev: true,
      rules: { keys: [pinnedOf(A), pinnedOf(B)], origin: ORIGIN, baseline: 1 },
    });
    void dev;
    const hook = (globalThis as { __skRules?: (force?: boolean) => Promise<string> }).__skRules;
    expect(typeof hook).toBe("function");
    expect(await hook!(true)).toBe("off");
    unload();
    delete (globalThis as { __skRules?: unknown }).__skRules;
    await loadWorker({ dev: false, rules: { keys: [pinnedOf(A), pinnedOf(B)], origin: ORIGIN, baseline: 1 } });
    expect((globalThis as { __skRules?: unknown }).__skRules).toBeUndefined();
  });
});

describe("rulesMessage (sender-policy.ts) with the gate open", () => {
  it("takes exactly the two types from their pages; no look-alike, no inherited type, no other shape", async () => {
    vi.resetModules();
    vi.stubGlobal("__RULES_UPDATE__", true);
    const p = await import("../../src/platform/sender-policy");
    expect(p.RULES_SENDERS).toEqual({ "sk-af-rule": ["popup", "sidepanel"], "sk-af-rules-status": ["options"] });
    const popup = { id: SELF, url: url(PATH.popup) };
    expect(p.rulesMessage({ type: "sk-af-rule" }, popup, SELF)).toBe("sk-af-rule");
    for (const msg of [
      { type: "SK-AF-RULE" },
      { type: "sk-af-rule " },
      { type: "sk-af-rules" },
      { type: ["sk-af-rule"] },
      Object.create({ type: "sk-af-rule" }),
      "sk-af-rule",
      null,
      [],
      { type: "constructor" },
      { type: "__proto__" },
    ])
      expect(p.rulesMessage(msg, popup, SELF), JSON.stringify(msg)).toBeNull();
    // a message of the main table is not the updater's
    expect(p.rulesMessage({ type: "sk-clip-arm" }, popup, SELF)).toBeNull();
    // and the main table never takes the updater's
    expect(p.acceptedType({ type: "sk-af-rule" }, popup, SELF, "worker")).toBeNull();
  });
});
