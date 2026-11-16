// Wave 1b of the plugin platform: autofill as the built-in official plugin (docs/design/proposals/MOD-PLATFORM.md §7.2
// Option I; docs/design/notes/PLUGINS-W1B-NOTES.md). What it does, over the real grant store and request log on a stand-in
// chrome.storage (the shape of the code that keeps it so: plugins-w1b-source-rules.test.ts):
//   - its reserved ID, its catalog row (official, `codes.forPage` only) that no build's file can replace, and its switch
//     (no entry: On; Off and On again: tagged writes that change nothing else);
//   - the gate: a code only with the vault key, the switch on, a record that verifies and `codes.forPage` within the
//     ceiling; every ask logged under autofill's ID with its outcome;
//   - Off and On from Settings: the list of sites kept, only each listed site's own grant given back, one request for On;
//     the page hint follows;
//   - the worker following the switch: unregistered first, then `scripting` given back, and never an On click's grant.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approved,
  overlayWith,
  OVERLAY_KEY,
  parseOverlay,
  type GrantReason,
  type OverlayAction,
} from "../../src/core/plugins/grants";
import type { GrantKeys, GrantStore } from "../../src/core/plugins/store";
import type { Entry } from "../../src/core/vault/model";
import { codeAt } from "../../src/ui/otp";
import { desc, keysOf, newVk, PID } from "../helpers/plugins";

let local: Map<string, unknown>;
let session: Map<string, unknown>;
let page: Map<string, string>;
const area = (m: Map<string, unknown>) => ({
  get: async (keys: string[] | string | null) => {
    const ks = keys === null ? [...m.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(ks.filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))]));
  },
  set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => m.set(k, structuredClone(v))),
  remove: async (keys: string[] | string) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => m.delete(k)),
});
const g = globalThis as Record<string, unknown>;
/**
 * A tagged write that approves another plugin, as the removed platform's approval screen did: the extension's store
 * writes a new record and leaves that entry out of it (plugins-retired.test.ts).
 */
const approveOther = (store: GrantStore, keys: GrantKeys) =>
  store.write(keys, (b) => approved(b, { descriptor: desc(PID), granted: ["ui.slots"], now: Date.now() }));
/** An overlay entry, as the removed platform's worker wrote one: honoured at once, and it can only tighten. */
const tighten = (id: string, action: OverlayAction, reason?: GrantReason) =>
  local.set(OVERLAY_KEY, {
    v: 1,
    entries: overlayWith(parseOverlay(local.get(OVERLAY_KEY)), {
      pluginId: id,
      action,
      ...(reason ? { reason } : {}),
      at: Date.now(),
    }),
  });
beforeEach(() => {
  local = new Map();
  session = new Map();
  page = new Map();
  g.chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: { id: "sixkeysixkeysixkeysixkeysixkeysi", getManifest: () => ({ version: "0.1.0" }) },
    i18n: { getUILanguage: () => "en-GB" },
    permissions: { contains: async () => false },
  };
  g.localStorage = {
    getItem: (k: string) => page.get(k) ?? null,
    setItem: (k: string, v: string) => void page.set(k, String(v)),
    removeItem: (k: string) => void page.delete(k),
  };
});
afterEach(() => {
  delete g.localStorage;
  delete g.__PLUGIN_CATALOG__;
  vi.resetModules();
});

const entry = (): Entry =>
  ({
    id: "e1",
    createdAt: 0,
    type: "totp",
    issuer: "Example",
    label: "alice",
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    domains: ["example.com"],
    hlc: "",
    order: "a",
    phlc: "",
  }) as Entry;
const AT = 1_700_000_010_000;

async function platform() {
  const builtin = await import("../../src/core/plugins/builtin");
  const gate = await import("../../src/platform/plugins/autofill-gate");
  const sw = await import("../../src/platform/plugins/autofill-switch");
  const { grantStore, pluginSession, catalog } = await import("../../src/platform/plugins/chrome");
  return { ...builtin, ...gate, ...sw, store: grantStore(), log: () => pluginSession().log(), catalog };
}

describe("the built-in autofill: its ID, its catalog row, its switch", () => {
  it("a reserved ID no extension can have; official, with `codes.forPage` as its whole ceiling", async () => {
    const { AUTOFILL_ID, isBuiltin, catalog, autofillDescriptor } = await platform();
    expect(AUTOFILL_ID).toBe("a".repeat(32));
    expect(isBuiltin(AUTOFILL_ID)).toBe(true);
    expect(isBuiltin(PID)).toBe(false);
    expect(catalog().plugins.filter((p) => p.id === AUTOFILL_ID)).toEqual([
      { id: AUTOFILL_ID, trust: "official", name: "Autofill", publisher: "Sixkey", ceiling: ["codes.forPage"] },
    ]);
    // nothing to ask for, nothing to draw: its buttons are Sixkey's own
    expect(autofillDescriptor().capabilities).toEqual([]);
    expect(autofillDescriptor().contributions).toEqual([]);
  });

  it("the catalog is the built-in's entry alone: no build's catalog is read, whatever the old define holds", async () => {
    // the define of the removed plugin platform, set as a build once set it: nothing reads it any more
    g.__PLUGIN_CATALOG__ = {
      v: 1,
      plugins: [
        {
          id: "a".repeat(32),
          trust: "official",
          name: "Evil",
          publisher: "X",
          ceiling: ["codes.read", "codes.forPage"],
        },
        { id: PID, trust: "official", name: "Gen", publisher: "Y", ceiling: ["ui.slots"] },
      ],
    };
    const { catalog, AUTOFILL_ID } = await platform();
    const rows = catalog().plugins;
    expect(rows.map((p) => p.id)).toEqual([AUTOFILL_ID]);
    expect(rows[0]).toMatchObject({ name: "Autofill", trust: "official", ceiling: ["codes.forPage"] });
  });

  it("On by default (no entry); Off and On again are tagged writes of its entry alone; locked: nothing is written", async () => {
    const { store, autofillOn, AUTOFILL_ID } = await platform();
    const keys = keysOf(await newVk());
    await approveOther(store, keys);
    expect(JSON.stringify(local.get("sk_plugins"))).not.toContain(PID); // written without it
    let v = await store.read(keys);
    expect(v.ok && autofillOn(v.plugins)).toBe(true); // no entry
    await store.setAutofill(keys, false);
    v = await store.read(keys);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(autofillOn(v.plugins)).toBe(false);
    expect(v.plugins.find((e) => e.pluginId === AUTOFILL_ID)).toMatchObject({
      state: "disabled",
      reason: "user",
      granted: ["codes.forPage"],
    });
    expect(v.plugins.find((e) => e.pluginId === PID)).toBeUndefined(); // never read back (plugins-retired.test.ts)
    await store.setAutofill(keys, true);
    v = await store.read(keys);
    expect(v.ok && autofillOn(v.plugins)).toBe(true);
    if (!v.ok) return;
    expect(v.plugins.filter((e) => e.pluginId === AUTOFILL_ID)).toHaveLength(1);
    expect(v.plugins.find((e) => e.pluginId === PID)).toBeUndefined(); // never read back (plugins-retired.test.ts)
    // the other key cannot write it: a write needs the vault key the record is tagged with
    const other = keysOf(await newVk());
    expect((await store.read(other)).ok).toBe(false);
  });
});

describe("the gate (platform/plugins/autofill-gate.ts): the one way to a code", () => {
  it("a code only with the key and the switch on; every ask logged under autofill's ID", async () => {
    const { gatedCode, store, log, AUTOFILL_ID } = await platform();
    const keys = keysOf(await newVk());
    const want = await codeAt(entry(), AT);
    // locked
    expect(await gatedCode(async () => null)(entry(), AT)).toEqual({ no: "locked" });
    // unlocked, no record: On by default
    expect(await gatedCode(async () => keys)(entry(), AT)).toEqual({ code: want });
    // switched off
    await store.setAutofill(keys, false);
    expect(await gatedCode(async () => keys)(entry(), AT)).toEqual({ no: "off" });
    // on again
    await store.setAutofill(keys, true);
    expect(await gatedCode(async () => keys)(entry(), AT)).toEqual({ code: want });
    await new Promise((r) => setTimeout(r, 20)); // the log's writes are not awaited by the fill
    const l = await log();
    expect(l.map((e) => [e.pluginId, e.type, e.outcome])).toEqual([
      [AUTOFILL_ID, "codes.forPage", "locked"],
      [AUTOFILL_ID, "codes.forPage", "ok"],
      [AUTOFILL_ID, "codes.forPage", "disabled"],
      [AUTOFILL_ID, "codes.forPage", "ok"],
    ]);
    // the log holds no code, no secret, no account
    expect(JSON.stringify([...session.values()])).not.toContain(want);
    expect(JSON.stringify([...session.values()])).not.toContain(entry().secret);
    expect(JSON.stringify([...session.values()])).not.toContain("alice");
  });

  it("what its entry holds counts: a grant without `codes.forPage`, or an entry the worker's overlay tightened, gets nothing", async () => {
    const { autofillAllowed, store, AUTOFILL_ID } = await platform();
    const keys = keysOf(await newVk());
    await store.setAutofill(keys, true);
    expect(await autofillAllowed(async () => keys)).toBe("ok");
    await store.write(keys, (b) => ({
      ...b,
      plugins: b.plugins.map((e) => (e.pluginId === AUTOFILL_ID ? { ...e, granted: [] } : e)),
    }));
    expect(await autofillAllowed(async () => keys)).toBe("off");
    await store.setAutofill(keys, true); // On again grants its capability again
    expect(await autofillAllowed(async () => keys)).toBe("ok");
    await new Promise((r) => setTimeout(r, 5)); // later than that approval (an older overlay entry is stale)
    tighten(AUTOFILL_ID, "disable"); // the overlay can only take away
    expect(await autofillAllowed(async () => keys)).toBe("off");
  });

  it("any state but approved is Off: a suspended entry too (the overlay's suspend), and an overlay remove disables it", async () => {
    const { autofillAllowed, store, AUTOFILL_ID, autofillOn, switchedOff } = await platform();
    const keys = keysOf(await newVk());
    await store.setAutofill(keys, true);
    await new Promise((r) => setTimeout(r, 5));
    tighten(AUTOFILL_ID, "suspend", "changed");
    expect(await switchedOff()).toBe(true); // the worker's reading, before any merge
    expect(await autofillAllowed(async () => keys)).toBe("off");
    const v = await store.read(keys);
    expect(v.ok && v.plugins.find((e) => e.pluginId === AUTOFILL_ID)?.state).toBe("suspended");
    expect(v.ok && autofillOn(v.plugins)).toBe(false);
    // the overlay only tightens the built-in: a "remove" of its entry is no way back to its default, On
    await store.setAutofill(keys, true);
    await new Promise((r) => setTimeout(r, 5));
    tighten(AUTOFILL_ID, "remove");
    expect(await switchedOff()).toBe(true);
    expect(await autofillAllowed(async () => keys)).toBe("off");
    const after = await store.read(keys);
    expect(after.ok && after.plugins.find((e) => e.pluginId === AUTOFILL_ID)?.state).toBe("disabled");
  });

  it("a record whose tag fails (OD-1): the built-in's switch read from it tighten-only, the same in the page and the worker", async () => {
    const { autofillAllowed, store, switchedOff, switchRecord } = await platform();
    const keys = keysOf(await newVk());
    const spoil = () => local.set("sk_plugins", { ...(local.get("sk_plugins") as object), tag: "A".repeat(43) });
    // On in the record, the tag spoiled: still On, here and in the worker, and Settings learns it was not verified
    await approveOther(store, keys);
    await store.setAutofill(keys, true);
    spoil();
    expect((await store.read(keys)).ok).toBe(false);
    expect(await autofillAllowed(async () => keys)).toBe("ok");
    expect(await switchedOff()).toBe(false);
    expect((await switchRecord(keys)).verified).toBe(false);
    // Off in the record, the tag spoiled: Off in both
    local.delete("sk_plugins");
    await store.setAutofill(keys, false);
    spoil();
    expect(await autofillAllowed(async () => keys)).toBe("off");
    expect(await switchedOff()).toBe(true);
    // no entry at all, the tag spoiled: On (the default), in both
    local.delete("sk_plugins");
    await approveOther(store, keys);
    spoil();
    expect(await autofillAllowed(async () => keys)).toBe("ok");
    expect(await switchedOff()).toBe(false);
    // and the third-party plugin of that record is still not honoured (its approval needs the tag)
    const v = await store.read(keys);
    expect(v.ok).toBe(false);
    // a flip writes a new, tagged record: verified again
    await store.setAutofill(keys, false);
    expect((await switchRecord(keys)).verified).toBe(true);
    expect(await autofillAllowed(async () => keys)).toBe("off");
  });

  it("a record whose tag fails says Off; the next tagged write (another plugin approved again) keeps it Off (N-01)", async () => {
    const { autofillAllowed, store, switchedOff, AUTOFILL_ID } = await platform();
    const keys = keysOf(await newVk());
    await store.setAutofill(keys, false);
    local.set("sk_plugins", { ...(local.get("sk_plugins") as object), tag: "A".repeat(43) });
    expect(await autofillAllowed(async () => keys)).toBe("off");
    expect(await switchedOff()).toBe(true);
    await approveOther(store, keys); // a new, tagged record, and nothing kept aside
    expect(local.has("sk_plugins_unverified")).toBe(false);
    expect(await autofillAllowed(async () => keys)).toBe("off");
    expect(await switchedOff()).toBe(true);
    const v = await store.read(keys);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.plugins.find((e) => e.pluginId === AUTOFILL_ID)).toMatchObject({
      state: "disabled",
      granted: ["codes.forPage"],
    });
    expect(v.plugins.find((e) => e.pluginId === PID)).toBeUndefined(); // never read back (plugins-retired.test.ts)
    // a failed record that said On (or had no entry) starts the new one with no entry: On, as before
    await store.setAutofill(keys, true);
    local.set("sk_plugins", { ...(local.get("sk_plugins") as object), tag: "A".repeat(43) });
    await approveOther(store, keys);
    expect(await autofillAllowed(async () => keys)).toBe("ok");
    // and a flip On from a failed Off record is On (the user's own write wins)
    await store.setAutofill(keys, false);
    local.set("sk_plugins", { ...(local.get("sk_plugins") as object), tag: "A".repeat(43) });
    await store.setAutofill(keys, true);
    expect(await autofillAllowed(async () => keys)).toBe("ok");
  });

  it("touchSwitch: the record written again, unchanged, so the worker follows the switch as it is; locked: nothing", async () => {
    const { touchSwitch, store, AUTOFILL_ID } = await platform();
    const keys = keysOf(await newVk());
    await store.setAutofill(keys, false);
    const before = local.get("sk_plugins") as { epoch: number; plugins: unknown[] };
    await touchSwitch(async () => null);
    expect(local.get("sk_plugins")).toEqual(before);
    await touchSwitch(async () => keys);
    const after = local.get("sk_plugins") as { epoch: number; plugins: unknown[] };
    expect(after.epoch).toBe(before.epoch + 1); // a write (sk_plugins changes: watchSwitch fires)
    expect(after.plugins).toEqual(before.plugins); // of the same content
    const v = await store.read(keys);
    expect(v.ok && v.plugins.find((e) => e.pluginId === AUTOFILL_ID)?.state).toBe("disabled");
  });

  it("a record that fails its tag can only take away: an entry whose grant lacks `codes.forPage` is Off", async () => {
    const { autofillAllowed, store, AUTOFILL_ID } = await platform();
    const keys = keysOf(await newVk());
    await store.setAutofill(keys, true);
    await store.write(keys, (b) => ({
      ...b,
      plugins: b.plugins.map((e) => (e.pluginId === AUTOFILL_ID ? { ...e, granted: [] } : e)),
    }));
    local.set("sk_plugins", { ...(local.get("sk_plugins") as object), tag: "A".repeat(43) });
    expect(await autofillAllowed(async () => keys)).toBe("off");
  });

  it("the ceiling is the catalog's: official with `codes.forPage`, else nothing", async () => {
    vi.doMock("../../src/core/plugins/builtin", async (orig) => {
      const m = (await orig()) as typeof import("../../src/core/plugins/builtin");
      return { ...m, BUILTIN_CATALOG: [{ ...m.BUILTIN_CATALOG[0]!, ceiling: [] }] };
    });
    const { autofillAllowed } = await platform();
    expect(await autofillAllowed(async () => keysOf(await newVk()))).toBe("off");
    vi.doUnmock("../../src/core/plugins/builtin");
    vi.resetModules();
    vi.doMock("../../src/core/plugins/builtin", async (orig) => {
      const m = (await orig()) as typeof import("../../src/core/plugins/builtin");
      return { ...m, BUILTIN_CATALOG: [{ ...m.BUILTIN_CATALOG[0]!, trust: "listed" }] };
    });
    const again = await platform();
    expect(await again.autofillAllowed(async () => keysOf(await newVk()))).toBe("off"); // listed: no codes.forPage
    vi.doUnmock("../../src/core/plugins/builtin");
  });
});

/** chrome.permissions as Settings uses it: what was asked, removed; which patterns Chrome grants exactly. */
function perms(granted: string[]) {
  const calls: unknown[][] = [];
  const have = new Set(granted);
  return {
    calls,
    have,
    p: {
      request: (x: chrome.permissions.Permissions) => (calls.push(["request", x]), Promise.resolve(true)),
      remove: async (x: chrome.permissions.Permissions) => {
        calls.push(["remove", x]);
        for (const o of x.origins ?? []) have.delete(o);
        return true;
      },
      contains: async (x: chrome.permissions.Permissions) => (x.origins ?? []).every((o) => have.has(o)),
      getAll: async () => ({ origins: [...have], permissions: [] }),
    },
  };
}

describe("Off and On (platform/plugins/autofill-switch.ts)", () => {
  it("Off in the page: the switch and the hint, nothing else (the worker does the rest, so a page closed early leaves none of it)", async () => {
    const { turnAutofillOff, store, autofillOn } = await platform();
    const keys = keysOf(await newVk());
    const calls: unknown[] = [];
    const g2 = globalThis as { chrome: { permissions: Record<string, unknown> } };
    g2.chrome.permissions = new Proxy(
      {},
      {
        get:
          (_t, k) =>
          (...a: unknown[]) => (calls.push([k, ...a]), Promise.resolve(true)),
      },
    );
    expect(await turnAutofillOff(keys)).toBe(true);
    const v = await store.read(keys);
    expect(v.ok && autofillOn(v.plugins)).toBe(false);
    expect(page.get("sk_af_off")).toBe("1");
    expect(calls).toEqual([]); // no chrome.permissions call at all from the page
  });

  it("the worker's sites give-back: each listed site's own grant, one call each; a broad grant and the list untouched", async () => {
    const { giveBackSites } = await platform();
    const hosts = ["github.com", "example.org", "gitlab.com"];
    const before = JSON.stringify(hosts);
    // github's grant is exact; example.org has none; gitlab is covered only by a broad grant the user set in Chrome
    const f = perms(["https://github.com/*", "https://*/*"]);
    await giveBackSites({ off: async () => true, p: f.p, hosts: async () => hosts });
    expect(f.calls).toEqual([["remove", { origins: ["https://github.com/*"] }]]);
    expect(f.have.has("https://*/*")).toBe(true);
    expect(JSON.stringify(hosts)).toBe(before);
    expect(JSON.stringify(f.calls)).not.toContain("scripting");
  });

  it("the sites' give-back reads the switch again before each site: an On meanwhile keeps the rest (N-04)", async () => {
    const { giveBackSites } = await platform();
    const f = perms(["https://github.com/*", "https://gitlab.com/*", "https://example.org/*"]);
    let on = false;
    const p = {
      ...f.p,
      // the user's On lands right after the first site's grant went: its request found the others still there
      remove: async (x: chrome.permissions.Permissions) => ((on = true), f.p.remove(x)),
    };
    await giveBackSites({ off: async () => !on, p, hosts: async () => ["github.com", "gitlab.com", "example.org"] });
    expect(f.calls).toEqual([["remove", { origins: ["https://github.com/*"] }]]);
    expect([...f.have].sort()).toEqual(["https://example.org/*", "https://gitlab.com/*"]);
  });

  it("followSwitch with Off then On during its sites step (the r2 review's Q2): no site the On wants is given back", async () => {
    const { followSwitch } = await import("../../src/platform/autofill-reconcile");
    const { giveBackSites } = await platform();
    const f = perms(["https://github.com/*", "https://gitlab.com/*"]);
    const st = { on: false, held: true };
    await followSwitch(
      async () => ({ k: "applied", hosts: [] }),
      async () => !st.on,
      {
        sites: (off) =>
          giveBackSites({
            off,
            p: { ...f.p, remove: async (x) => ((st.on = true), f.p.remove(x)) },
            hosts: async () => ["github.com", "gitlab.com"],
          }),
        scripting: async () => void (st.held = false),
      },
      async () => st.held,
    );
    expect(st).toEqual({ on: true, held: true }); // `scripting` kept
    expect([...f.have]).toEqual(["https://gitlab.com/*"]); // only the one given back before the On: no more
  });

  it("Off while locked: nothing is done", async () => {
    const { turnAutofillOff } = await platform();
    expect(await turnAutofillOff(null)).toBe(false);
    expect(local.has("sk_plugins")).toBe(false);
    expect(page.has("sk_af_off")).toBe(false);
  });

  it("On: one request (scripting and the listed sites), made before anything is awaited; granted: hint, then switch", async () => {
    const { askAutofillOn, turnAutofillOn, store, autofillOn } = await platform();
    const keys = keysOf(await newVk());
    await store.setAutofill(keys, false);
    page.set("sk_af_off", "1");
    const f = perms([]);
    const asked = askAutofillOn(["github.com", "example.org"], f.p);
    // already asked, synchronously: the click's gesture is still there
    expect(f.calls).toEqual([
      ["request", { permissions: ["scripting"], origins: ["https://github.com/*", "https://example.org/*"] }],
    ]);
    expect(await turnAutofillOn(keys, await asked)).toBe(true);
    expect(page.has("sk_af_off")).toBe(false);
    const v = await store.read(keys);
    expect(v.ok && autofillOn(v.plugins)).toBe(true);
    // no sites listed: `scripting` alone
    const g2 = perms([]);
    void askAutofillOn([], g2.p);
    expect(g2.calls).toEqual([["request", { permissions: ["scripting"] }]]);
  });

  it("On refused, or locked: nothing is written, the hint stays", async () => {
    const { turnAutofillOn, store, autofillOn } = await platform();
    const keys = keysOf(await newVk());
    await store.setAutofill(keys, false);
    page.set("sk_af_off", "1");
    expect(await turnAutofillOn(keys, false)).toBe(false);
    expect(await turnAutofillOn(null, true)).toBe(false);
    const v = await store.read(keys);
    expect(v.ok && autofillOn(v.plugins)).toBe(false);
    expect(page.get("sk_af_off")).toBe("1");
  });

  it("the worker's watch: only a change of the grant store (sk_plugins) calls it", async () => {
    const { watchSwitch } = await platform();
    let listener: (c: Record<string, unknown>) => void = () => undefined;
    let n = 0;
    watchSwitch({ onChanged: { addListener: (f) => void (listener = f) } }, () => void n++);
    listener({ sk_af_sites: {} });
    listener({ sk_plugins_overlay: {} });
    expect(n).toBe(0);
    listener({ sk_plugins: {} });
    expect(n).toBe(1);
  });
});

describe("the worker follows the switch (platform/autofill-reconcile.ts followSwitch)", () => {
  type O = import("../../src/platform/autofill-reconcile").Outcome;
  async function follow(o: { ran: O; off: boolean[]; held: boolean }) {
    const { followSwitch } = await import("../../src/platform/autofill-reconcile");
    const order: string[] = [];
    const offs = [...o.off];
    await followSwitch(
      async () => (order.push("reconcile"), o.ran),
      async () => (order.push("off"), offs.shift() ?? false),
      {
        sites: async () => void order.push("sites"),
        scripting: async () => void order.push("scripting"),
      },
      async () => (order.push("held"), o.held),
    );
    return order;
  }
  it("off, and the run unregistered: then the sites' grants, and only then `scripting`, given back", async () => {
    expect(await follow({ ran: { k: "applied", hosts: [] }, off: [true, true], held: true })).toEqual([
      "reconcile",
      "off",
      "sites",
      "held",
      "off",
      "scripting",
    ]);
  });
  it("a run that failed, was given up, or registered sites: nothing given back", async () => {
    for (const ran of [
      { k: "failed" },
      { k: "late" },
      { k: "gated" },
      { k: "applied", hosts: ["github.com"] },
    ] as O[]) {
      const order = await follow({ ran, off: [true, true], held: true });
      expect(order).not.toContain("sites");
      expect(order).not.toContain("scripting");
    }
  });
  it("on, an On written while the run was out, or `scripting` not held: `scripting` stays", async () => {
    expect(await follow({ ran: { k: "applied", hosts: [] }, off: [false], held: true })).toEqual(["reconcile", "off"]);
    expect(await follow({ ran: { k: "applied", hosts: [] }, off: [true, false], held: true })).not.toContain(
      "scripting",
    );
    // not held (a Fill never asked, or given back before): the sites' grants still go, nothing else to give back
    expect(await follow({ ran: { k: "applied", hosts: [] }, off: [true, true], held: false })).toEqual([
      "reconcile",
      "off",
      "sites",
      "held",
    ]);
  });

  it("the unregister is waited for: `scripting` goes only once the apply has finished (W1b review F-11)", async () => {
    const { createReconciler, followSwitch } = await import("../../src/platform/autofill-reconcile");
    const order: string[] = [];
    const reconcile = createReconciler({
      gate: async () => true,
      usable: async () => "off",
      hosts: async () => ["github.com"],
      granted: async () => true,
      // the registration call answers a moment later, as Chrome's does
      apply: (h) => new Promise((done) => setTimeout(() => (order.push(`applied ${h.join(",")}`), done()), 30)),
      note: () => undefined,
    });
    await followSwitch(
      reconcile,
      async () => true,
      { sites: async () => void order.push("sites"), scripting: async () => void order.push("scripting") },
      async () => true,
    );
    expect(order).toEqual(["applied ", "sites", "scripting"]);
  });

  it("an On click: its grant (which may start the worker) and then its switch write never lose `scripting`", async () => {
    const { createReconciler, followSwitch } = await import("../../src/platform/autofill-reconcile");
    const st = { on: false, held: false, registered: [] as string[] };
    const reconcile = createReconciler({
      gate: async () => true,
      usable: async () => (!st.held ? "unscripted" : st.on ? "on" : "off"),
      hosts: async () => ["github.com"],
      granted: async () => true,
      apply: async (h) => void (st.registered = [...h]),
      note: () => undefined,
    });
    const off = async () => !st.on;
    const held = async () => st.held;
    const giveBack = { sites: async () => undefined, scripting: async () => void (st.held = false) };
    // the click: Chrome grants, the worker starts (a reconcile, as sw.ts's start makes: never followSwitch) and its
    // permissions.onAdded reconciles; then the page writes the switch, whose change the worker follows
    st.held = true;
    await reconcile();
    await reconcile();
    expect(st.held).toBe(true);
    st.on = true;
    await followSwitch(reconcile, off, giveBack, held);
    expect(st).toEqual({ on: true, held: true, registered: ["github.com"] });
    // Off: the write, followed: unregistered, then given back
    st.on = false;
    await followSwitch(reconcile, off, giveBack, held);
    expect(st).toEqual({ on: false, held: false, registered: [] });
    // regained while Off (a Fill whose page hint was missing): that click's unchanged write (touchSwitch) is followed
    st.held = true;
    await followSwitch(reconcile, off, giveBack, held);
    expect(st).toEqual({ on: false, held: false, registered: [] });
  });
});

describe("reconcile (platform/autofill-reconcile.ts): the switch and `scripting`", () => {
  async function run(usable: "on" | "off" | "unscripted") {
    const { reconcileOnce } = await import("../../src/platform/autofill-reconcile");
    const order: string[] = [];
    const out = await reconcileOnce({
      gate: async () => (order.push("gate"), true),
      usable: async () => (order.push("usable"), usable),
      hosts: async () => (order.push("hosts"), ["github.com"]),
      granted: async () => true,
      apply: async (h) => void order.push(`apply ${h.join(",")}`),
      note: () => undefined,
    });
    return { out, order };
  }
  it("the gate is asked first (this start's access answer before any read), then the switch and `scripting`", async () => {
    expect((await run("on")).order.slice(0, 2)).toEqual(["gate", "usable"]);
  });
  it("on: the listed and granted sites; off: none (unregistered); without `scripting`: nothing is even tried", async () => {
    expect(await run("on")).toMatchObject({ out: { k: "applied", hosts: ["github.com"] } });
    expect(await run("off")).toEqual({ out: { k: "applied", hosts: [] }, order: ["gate", "usable", "apply "] });
    expect(await run("unscripted")).toEqual({ out: { k: "applied", hosts: [] }, order: ["gate", "usable"] });
  });
});
