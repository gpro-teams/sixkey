// The settings page follows a change of the settings record made on another page (the View menu in the popup or the side
// panel, another settings tab): refreshSettings reads the record as stored and hands it to every panel that shows it
// (src/options/settings-store.ts; the page's chrome.storage listener is in options/App.tsx), behind its own saves.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type Settings } from "../../src/core/service/types";
import type { Runtime } from "../../src/platform/runtime";
import { changeSettings, refreshSettings, useSettings, watchSettings } from "../../src/options/settings-store";
import { installMiniDom, type MiniElement } from "../helpers/mini-dom";

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
let record: Settings;
let reads: number;
let gate: Promise<void>;
beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body;
  record = parseSettings({ display: { density: "standard", hideCodes: false, sort: "manual" } });
  reads = 0;
  gate = Promise.resolve();
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
});
const rt = {
  service: {
    getSettings: async () => (reads++, await gate, structuredClone(record)),
    updateSettings: async (s: Settings) => {
      await gate;
      record = parseSettings(s);
    },
  },
} as unknown as Runtime;

function Probe() {
  const { settings } = useSettings(rt);
  return h("span", { id: "sort" }, settings?.display?.sort ?? "none");
}
const shown = () => root.byId("sort")!.textContent;
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

describe("refreshSettings", () => {
  it("shows in every panel a record that another page changed", async () => {
    await act(async () => render(h(Probe, {}), root as unknown as Element));
    await settle();
    expect(shown()).toBe("manual");
    record = parseSettings({ display: { density: "standard", hideCodes: false, sort: "name" } }); // another page wrote it
    await act(async () => refreshSettings(rt));
    expect(shown()).toBe("name");
  });

  it("goes behind a change of this page that is still being saved: the last word is the stored one", async () => {
    await act(async () => render(h(Probe, {}), root as unknown as Element));
    await settle();
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const saving = changeSettings(rt, (s) => ({ ...s, display: { ...s.display!, sort: "name" } }));
    const refreshing = refreshSettings(rt);
    await act(async () => {
      open();
      await Promise.all([saving, refreshing]);
    });
    expect(record.display!.sort).toBe("name");
    expect(shown()).toBe("name"); // not the older record the refresh would have read first
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("reads after the saves that were asked for before it (the order of the service's calls)", async () => {
    await act(async () => render(h(Probe, {}), root as unknown as Element));
    await settle();
    const calls: string[] = [];
    const logged = {
      service: {
        getSettings: async () => (calls.push("get"), await Promise.resolve(), structuredClone(record)),
        updateSettings: async (s: Settings) => {
          calls.push("update");
          await new Promise((r) => setTimeout(r, 5));
          record = parseSettings(s);
        },
      },
    } as unknown as Runtime;
    const saving = changeSettings(logged, (s) => ({ ...s, display: { ...s.display!, sort: "name" } }));
    const refreshing = refreshSettings(logged);
    await act(async () => void (await Promise.all([saving, refreshing])));
    expect(calls).toEqual(["get", "update", "get"]);
  });

  it("rejects when the record cannot be read, and announces nothing", async () => {
    await act(async () => render(h(Probe, {}), root as unknown as Element));
    await settle();
    const broken = { service: { getSettings: async () => Promise.reject(new Error("gone")) } } as unknown as Runtime;
    await expect(refreshSettings(broken)).rejects.toThrow("gone");
    expect(shown()).toBe("manual");
    await expect(refreshSettings(rt)).resolves.toBeUndefined(); // the queue goes on
  });
});

describe("watchSettings (the settings page's listener)", () => {
  type Listener = (c: Record<string, unknown>) => void;
  const listeners = new Set<Listener>();
  beforeEach(() => {
    listeners.clear();
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          onChanged: {
            addListener: (f: Listener) => void listeners.add(f),
            removeListener: (f: Listener) => void listeners.delete(f),
          },
        },
      },
    };
  });
  afterEach(() => void delete (globalThis as Record<string, unknown>).chrome);

  it("announces the record when its key changes, reads nothing for any other key, and is gone when stopped", async () => {
    await act(async () => render(h(Probe, {}), root as unknown as Element));
    await settle();
    const stop = watchSettings(rt);
    expect(listeners.size).toBe(1);
    const before = reads;
    listeners.forEach((f) => f({ sk_last_backup: {}, sk_active: {} }));
    await settle();
    expect(reads).toBe(before);
    record = parseSettings({ display: { density: "standard", hideCodes: false, sort: "name" } });
    await act(async () => listeners.forEach((f) => f({ sk_settings: { newValue: "ignored" } })));
    await settle();
    expect(shown()).toBe("name"); // read again through the service, not taken from the change
    stop();
    expect(listeners.size).toBe(0);
  });

  it("does nothing where there is no chrome.storage (tests, other contexts)", () => {
    delete (globalThis as Record<string, unknown>).chrome;
    expect(() => watchSettings(rt)()).not.toThrow();
  });
});
