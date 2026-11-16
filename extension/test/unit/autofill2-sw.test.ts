// TOTP autofill Stage 2, patch 2: the service worker's side of autofill's sites (src/background/sw.ts; AUTOFILL2-NOTES §7),
// the real module over the fake chrome.* of sw-world.ts: reconcile at the start, on onAdded and onRemoved and on a change of
// the list, each time behind this start's access-level answer, asking Chrome for each listed site's own pattern and for no
// other; the worker's end of an ask (review M7); the diagnostics line when the gate is closed; and the start's own order
// (the access-level calls first, once each) untouched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATED_NOTE } from "../../src/platform/autofill-reconcile";
import { PENDING_KEY, SITES_KEY } from "../../src/platform/autofill-sites";
import { loadWorker, unload, wait, type World } from "../helpers/sw-world";

const list = (...hosts: string[]) => ({ [SITES_KEY]: { v: 1, hosts } });
/** What the worker asked Chrome about sites (sync asks about the API origin on the same events: its own tests). */
const asked = (w: World) =>
  w.perms.filter(([k, o]) => k === "contains" && !o.includes("https://api.sixkey.app/*")).map(([, o]) => o);
const lines = (w: World) => ((w.local.data.get("sk_diag") ?? []) as { message: string }[]).map((d) => d.message);
const fire = (w: World, name: "permAdded" | "permRemoved", origins: string[]) => {
  for (const l of w.listeners[name]!) l({ origins });
};

describe("the worker reconciles autofill's sites", () => {
  afterEach(unload);

  it("at its start: each listed site's own pattern, nothing else, after this start's access-level calls", async () => {
    const w = await loadWorker({ seedLocal: list("github.com", "gitlab.com"), grants: ["https://github.com/*"] });
    await wait();
    expect(asked(w)).toEqual([["https://github.com/*"], ["https://gitlab.com/*"]]);
    expect(w.log.slice(0, 2).sort()).toEqual(["local.setAccessLevel", "session.setAccessLevel"]);
    // reconcile's gate is this start's answer (local and session; storage.sync's, third, is the backup's alone: CSB-3);
    // the registration (patch 3) asks the two once more, just before it registers
    const levels = w.log.filter((e) => e.endsWith("setAccessLevel") || e === "scripting.register");
    expect(levels).toEqual([
      expect.stringMatching(/^(local|session)\.setAccessLevel$/),
      expect.stringMatching(/^(local|session)\.setAccessLevel$/),
      "sync.setAccessLevel",
      expect.stringMatching(/^(local|session)\.setAccessLevel$/),
      expect.stringMatching(/^(local|session)\.setAccessLevel$/),
      "scripting.register",
    ]);
    expect(lines(w)).toEqual([]);
  });

  it("on onRemoved and onAdded (a site withdrawn in Chrome's own UI, or granted again), and on a change of the list", async () => {
    const w = await loadWorker({ seedLocal: list("github.com"), grants: ["https://github.com/*"] });
    await wait();
    const n = asked(w).length;
    w.grants!.delete("https://github.com/*");
    fire(w, "permRemoved", ["https://github.com/*"]);
    await wait();
    expect(asked(w).length).toBe(n + 1);
    fire(w, "permAdded", ["https://github.com/*"]);
    await wait();
    expect(asked(w).length).toBe(n + 2);
    await w.local.set(list("github.com", "gitlab.com"));
    for (const l of w.listeners.localChanged!) l({ [SITES_KEY]: { newValue: list("github.com", "gitlab.com") } });
    await wait();
    expect(asked(w).slice(n + 2)).toEqual([["https://github.com/*"], ["https://gitlab.com/*"]]);
    // a change of another key is not the list's
    for (const l of w.listeners.localChanged!) l({ sk_settings: { newValue: {} } });
    await wait();
    expect(asked(w).length).toBe(n + 4);
  });

  for (const [area, how] of [
    ["local", "absent"],
    ["local", "reject"],
    ["local", "hang"],
    ["session", "reject"],
  ] as const)
    it(`the gate closed (storage.${area} ${how}): no site is asked about, and one line says why`, async () => {
      const w = await loadWorker({ [area]: how, seedLocal: list("github.com"), grants: ["https://*/*"] });
      await wait(how === "hang" ? 5300 : 60); // a call with no answer counts as a refusal after 5 s
      if (how !== "hang") {
        fire(w, "permRemoved", ["https://github.com/*"]);
        await wait();
      }
      expect(asked(w)).toEqual([]);
      expect(lines(w)).toContain(GATED_NOTE);
      expect(lines(w).filter((l) => l === GATED_NOTE)).toHaveLength(1);
      if (how !== "hang") expect(lines(w)).toContain(`storage access level not restricted: ${area}`); // both lines kept
    }, 20_000);

  it("the worker's end of an ask: exactly the asked site's pattern puts it on the list; On all sites and the API do not", async () => {
    const w = await loadWorker({ grants: [] });
    await w.session.set({ [PENDING_KEY]: { v: 1, host: "github.com", at: Date.now() } });
    fire(w, "permAdded", ["https://*/*"]);
    fire(w, "permAdded", ["https://api.sixkey.app/*"]);
    await wait();
    expect(w.local.data.has(SITES_KEY)).toBe(false);
    w.grants!.add("https://github.com/*");
    fire(w, "permAdded", ["https://github.com/*"]);
    await wait();
    expect(w.local.data.get(SITES_KEY)).toEqual({ v: 1, hosts: ["github.com"] });
    expect(w.session.data.has(PENDING_KEY)).toBe(false);
    expect(asked(w).at(-1)).toEqual(["https://github.com/*"]); // and a reconcile with it
  });
});

// ---- patch 3: the registration and the content script's message, in the worker ------------------------------------------
const SELF_ID = "abcdefghijklmnopabcdefghijklmnop";
const sender = (host = "github.com", tab = 7) => ({
  id: SELF_ID,
  url: `https://${host}/login`,
  origin: `https://${host}`,
  frameId: 0,
  documentId: "0123456789ABCDEF0123456789ABCDEF",
  documentLifecycle: "active",
  tab: { id: tab, windowId: 1, url: `https://${host}/login`, active: true, incognito: false },
});
const matches = (w: World) => (w.registered.get("sk-suggest")?.matches as string[] | undefined) ?? null;

describe("the worker registers the content script for exactly the sites that count (patch 3)", () => {
  afterEach(unload);

  it("at its start: the listed and granted sites, the pinned object", async () => {
    const w = await loadWorker({ seedLocal: list("github.com", "gitlab.com"), grants: ["https://github.com/*"] });
    await wait();
    expect(w.registered.get("sk-suggest")).toEqual({
      id: "sk-suggest",
      js: ["inject/otp.js", "inject/suggest.js"],
      matches: ["https://github.com/*"],
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: true,
    });
  });

  it("a site withdrawn in Chrome's settings is taken out at its onRemoved; the last one removes the registration", async () => {
    const w = await loadWorker({
      seedLocal: list("github.com", "gitlab.com"),
      grants: ["https://github.com/*", "https://gitlab.com/*"],
    });
    await wait();
    expect(matches(w)).toEqual(["https://github.com/*", "https://gitlab.com/*"]);
    w.grants!.delete("https://gitlab.com/*");
    fire(w, "permRemoved", ["https://gitlab.com/*"]);
    await wait();
    expect(matches(w)).toEqual(["https://github.com/*"]);
    w.grants!.delete("https://github.com/*");
    fire(w, "permRemoved", ["https://github.com/*"]);
    await wait();
    expect(w.registered.has("sk-suggest")).toBe(false);
  });

  it("a registration left from an earlier start for a site no longer granted is removed at this start", async () => {
    const w = await loadWorker({ seedLocal: list("github.com"), grants: [] });
    await wait();
    expect(w.registered.has("sk-suggest")).toBe(false);
    // (the same over a stale registration: the browser kept it across the restart)
    const v = await loadWorker({ seedLocal: list("github.com"), grants: [] });
    v.registered.set("sk-suggest", {
      id: "sk-suggest",
      matches: ["https://github.com/*"],
      js: ["inject/otp.js", "inject/suggest.js"],
    });
    fire(v, "permRemoved", ["https://github.com/*"]);
    await wait();
    expect(v.registered.has("sk-suggest")).toBe(false);
  });

  for (const [area, how] of [
    ["local", "absent"],
    ["session", "reject"],
  ] as const)
    it(`the gate closed (storage.${area} ${how}): nothing registered, whatever the list and the grants`, async () => {
      const w = await loadWorker({ [area]: how, seedLocal: list("github.com"), grants: ["https://*/*"] });
      await wait();
      expect(w.regLog).toEqual([]); // the start registered nothing
      // a registration an earlier start left (the browser keeps it): the next reconcile, gated, removes it
      w.registered.set("sk-suggest", { id: "sk-suggest", matches: ["https://github.com/*"], js: [] });
      fire(w, "permAdded", ["https://github.com/*"]);
      await wait(120);
      expect(w.registered.has("sk-suggest")).toBe(false);
      expect(w.regLog).not.toContain("register");
    });

  it("the content script's message: the badge of its tab, for a listed and granted site only; a page's sender is no content script", async () => {
    const w = await loadWorker({ seedLocal: list("github.com"), grants: ["https://github.com/*"] });
    await wait();
    const r = w.send({ type: "sk-af-cand", origin: "https://github.com" }, sender("github.com", 7));
    expect(r.every((x) => x !== true)).toBe(true); // no listener keeps the channel open: never an answer
    await wait();
    expect(w.tabBadges.get(7)).toEqual({ text: "1", title: "afCanFill:Alt+Shift+F" });
    // another site's content script (not on the list): nothing, whatever it claims
    w.send({ type: "sk-af-cand", origin: "https://github.com", host: "github.com" }, sender("evil.example", 8));
    // a page of Sixkey's own sending the content script's type: not a content script
    w.send(
      { type: "sk-af-cand" },
      { id: SELF_ID, url: `chrome-extension://${SELF_ID}/popup/index.html`, origin: `chrome-extension://${SELF_ID}` },
    );
    // the content script sending a page's type: no page's handler takes it
    w.send({ type: "sk-clip-arm", hash: "x" }, sender("github.com", 9));
    await wait();
    expect([...w.tabBadges.keys()]).toEqual([7]);
    expect(w.fx.created).toBe(0); // the clipboard's offscreen document was not asked for
  });

  it("Autofill switched off: a page still open keeps its script, and its message sets no badge, even under the broad grant Off leaves (AFSWITCH)", async () => {
    // the real wiring (sw.ts hands the channel switchedOff), with only the switch's reading replaced: "On all sites"
    // chosen in Chrome stays after Off, so the list and the grant alone would let the message through
    const SWITCH = "../../src/platform/plugins/autofill-switch";
    let off = true;
    vi.doMock(SWITCH, async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/platform/plugins/autofill-switch")>()),
      switchedOff: async () => off,
    }));
    try {
      const w = await loadWorker({ seedLocal: list("github.com"), grants: ["https://*/*"] });
      await wait();
      w.send({ type: "sk-af-cand" }, sender("github.com", 7));
      await wait();
      expect(w.tabBadges.size).toBe(0);
      off = false; // turned on again: read at the next message, no restart needed
      w.send({ type: "sk-af-cand" }, sender("github.com", 8));
      await wait();
      expect([...w.tabBadges.keys()]).toEqual([8]);
    } finally {
      vi.doUnmock(SWITCH);
    }
  });

  it("gated: the message sets no badge", async () => {
    const w = await loadWorker({ local: "absent", seedLocal: list("github.com"), grants: ["https://github.com/*"] });
    w.send({ type: "sk-af-cand" }, sender());
    await wait();
    expect(w.tabBadges.size).toBe(0);
  });
});
