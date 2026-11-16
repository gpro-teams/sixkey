// Wave 1b of the plugin platform: the built-in autofill's switch (src/options/AutofillSwitch.tsx), rendered by Preact into
// a minimal document (test/helpers/mini-dom.ts) over the real grant store on a stand-in chrome.storage: it shows what the
// record says, read tighten-only where its tag fails, with the line that the setting could not be checked (the autofill
// page, Settings › Security › Autofill, is its one place since Settings › Plugins went). The page hint follows. The real
// pages are plugins-w1b.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniElement } from "../helpers/mini-dom";
import { keysOf, newVk, PID } from "../helpers/plugins";

let local: Map<string, unknown>;
let session: Map<string, unknown>;
let page: Map<string, string>;
let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
const area = (m: Map<string, unknown>) => ({
  get: async (keys: string[] | string | null) => {
    const ks = keys === null ? [...m.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(ks.filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))]));
  },
  set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => m.set(k, structuredClone(v))),
  remove: async (keys: string[] | string) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => m.delete(k)),
});
const g = globalThis as Record<string, unknown>;
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
  dom = installMiniDom();
  root = dom.doc.body;
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  delete g.localStorage;
  vi.resetModules();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const spoil = () => local.set("sk_plugins", { ...(local.get("sk_plugins") as object), tag: "A".repeat(43) });

async function mount(keys: Awaited<ReturnType<typeof keysOf>>) {
  const { AutofillSwitch, prepare } = await import("../../src/options/AutofillSwitch");
  const { px } = await import("../../src/ui/plugins/text");
  await prepare();
  const rt = { service: { grantKeys: async () => keys } } as never;
  act(() => render(h(AutofillSwitch, { rt, status: { state: "unlocked" } as never }), root as unknown as Element));
  await settle();
  const box = root.all((e) => e.localName === "input" && e.getAttribute("id") === "af-on")[0]!;
  const warn = root.all((e) => e.localName === "p" && (e.getAttribute("class") ?? "").includes("warn"));
  return { checked: box.checked, warn: warn.map((e) => e.textContent), badTagText: px("pxBadTag") };
}

describe("the built-in autofill's switch (options/AutofillSwitch.tsx)", () => {
  it("a record that verifies: the switch as it says, and no line about checking", async () => {
    const { grantStore } = await import("../../src/platform/plugins/chrome");
    const keys = keysOf(await newVk());
    await grantStore().setAutofill(keys, false);
    const r = await mount(keys);
    expect(r).toMatchObject({ checked: false, warn: [] });
    expect(page.get("sk_af_off")).toBe("1");
    // its name alone: the plugin platform's chips (Official, Built in) went with it
    expect(root.textContent).toContain("Autofill");
    expect(root.textContent).not.toMatch(/Official|Built in/);
  });

  it("a record whose tag fails: the switch read tighten-only (On stays On), and the line that it could not be checked", async () => {
    const { grantStore } = await import("../../src/platform/plugins/chrome");
    const keys = keysOf(await newVk());
    await grantStore().setAutofill(keys, true);
    spoil();
    page.set("sk_af_off", "1"); // stale: the record says On
    const r = await mount(keys);
    expect(r.badTagText).toMatch(/could not check/);
    expect(r).toMatchObject({ checked: true, warn: [r.badTagText] });
    expect(page.has("sk_af_off")).toBe(false); // the hint follows the tighten-only reading
  });

  it("a record whose tag fails and says Off: Off, with the line, which names no plugin", async () => {
    const { grantStore } = await import("../../src/platform/plugins/chrome");
    const keys = keysOf(await newVk());
    await grantStore().setAutofill(keys, false);
    spoil();
    const r = await mount(keys);
    expect(r).toMatchObject({ checked: false, warn: [r.badTagText] });
    expect(r.badTagText).not.toMatch(/plugin/i);
  });

  it("its recent requests: autofill's own last ten lines of the request log, newest first, each outcome in words", async () => {
    const { grantStore } = await import("../../src/platform/plugins/chrome");
    const { AUTOFILL_ID } = await import("../../src/core/plugins/builtin");
    const keys = keysOf(await newVk());
    await grantStore().setAutofill(keys, true);
    const line = (i: number, pluginId: string, outcome: string) => ({
      at: 1_700_000_000_000 + i * 60_000,
      pluginId,
      type: "codes.forPage",
      outcome,
    });
    session.set("sk_plugin_log", {
      v: 1,
      log: [
        ...Array.from({ length: 8 }, (_, i) => line(i, AUTOFILL_ID, "ok")),
        line(8, AUTOFILL_ID, "denied"), // a word an earlier version wrote
        line(9, AUTOFILL_ID, "disabled"),
        line(10, AUTOFILL_ID, "locked"),
        line(20, PID, "rate"), // another plugin's line, an earlier version's: not autofill's
      ],
    });
    page.set("sk_plugins_any", "1"); // an earlier version's
    await mount(keys);
    const log = root.all((e) => e.localName === "details" && e.getAttribute("id") === "af-log");
    expect(log).toHaveLength(1);
    const items = log[0]!.all((e) => e.localName === "li");
    expect(items).toHaveLength(10);
    // the newest first, each its time and then its outcome in words, never the log's own protocol words
    const said = items.map((li) => li.textContent.slice(li.all((e) => e.localName === "span")[0]!.textContent.length));
    expect(said).toEqual([
      " No code: Sixkey was locked",
      " No code: autofill was off",
      " No code",
      ...Array.from({ length: 7 }, () => " Code given for the page"),
    ]);
    for (const w of ["codes.forPage", "disabled", "denied", "rate"])
      expect(items.some((li) => li.textContent.includes(w))).toBe(false);
    // and the removed plugin platform's page hint is taken out where the switch is read
    expect(page.has("sk_plugins_any")).toBe(false);
  });
  it("no recent requests: no list drawn", async () => {
    const { grantStore } = await import("../../src/platform/plugins/chrome");
    const keys = keysOf(await newVk());
    await grantStore().setAutofill(keys, true);
    await mount(keys);
    expect(root.all((e) => e.localName === "details")).toHaveLength(0);
  });
});
