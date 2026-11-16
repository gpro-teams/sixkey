// AUTOFILL2 patch 1, the lock screen's line for a pending fill request (src/popup/screens/Locked.tsx), rendered over a
// minimal document (test/helpers/mini-dom.ts) and fake chrome.storage.session / chrome.tabs:
//  - the nonce handed on with an unlock is the one on screen when the secret was SENT, not one that arrived while the
//    unlock ran (AUTOFILL2-P1-VERIFY MINOR-1);
//  - the line goes when R's minute is over, with no storage or tab event to say so (MINOR-2), on a fake clock.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";

// what the PIN offers on the lock screen (pin-restart-count.ts restartOffer) and its record's unlock (pin-restart-steps.ts):
// set by a test
const pin = vi.hoisted(() => ({
  offer: null as unknown,
  unlock: (..._: unknown[]): Promise<unknown> => Promise.resolve(null),
}));
vi.mock("../../src/core/service/pin-restart-count", () => ({ restartOffer: () => pin.offer }));
vi.mock("../../src/core/service/pin-restart-steps", () => ({
  unlock: (...a: unknown[]) => pin.unlock(...a),
  notePassword: async () => undefined,
}));

const g = globalThis as Record<string, unknown>;
const URL1 = "https://github.com/sessions/two-factor";
let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
/** chrome.storage.session with R in it, whose onChanged can be fired by the test. */
let session: Map<string, unknown>;
let fire: (changes: Record<string, unknown>) => void;

const request = (nonce: string, at = Date.now()) => ({
  v: 1,
  nonce,
  tabId: 7,
  windowId: 3,
  url: URL1,
  host: "github.com",
  at,
  epoch: 0,
  why: "locked",
});
const lineText = () => root.byId("lock-fill")?.textContent ?? "";
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

beforeEach(() => {
  vi.resetModules();
  dom = installMiniDom();
  root = dom.doc.body;
  session = new Map();
  const listeners: ((c: Record<string, unknown>) => void)[] = [];
  fire = (c) => listeners.forEach((f) => f(c));
  const noop = { addListener: () => undefined, removeListener: () => undefined };
  g.chrome = {
    runtime: { id: "x", getManifest: () => ({ version: "0.1.0" }) },
    storage: {
      local: { get: async () => ({}), onChanged: noop },
      session: {
        get: async (k: string) => (session.has(k) ? { [k]: structuredClone(session.get(k)) } : {}),
        set: async () => undefined,
        remove: async () => undefined,
        onChanged: {
          addListener: (f: (c: Record<string, unknown>) => void) => void listeners.push(f),
          removeListener: () => undefined,
        },
      },
    },
    tabs: { query: async () => [{ id: 7, url: URL1 }], onActivated: noop, onUpdated: noop },
  };
  g.window = Object.assign(globalThis, { document: dom.doc });
  g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.useRealTimers();
  delete g.chrome;
  delete g.localStorage;
  pin.offer = null;
});

async function draw(rt: unknown, onUnlocked: (info?: { req?: string }) => Promise<void>, field?: unknown) {
  pin.offer = field ? { state: "pin", field } : null; // a PIN whose record opens Sixkey: the PIN's screen
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice("en");
  await i18n.loadCatalog(async () => ({
    lockFillFor: { message: "Unlock to fill the code on $1" },
    unlock: { message: "Unlock" },
  }));
  const { Locked } = await import("../../src/popup/screens/Locked");
  await act(async () => {
    render(h(Locked, { rt: rt as never, onUnlocked }), root as unknown as Element);
  });
  await settle();
}

describe("the lock screen's line for a pending fill", () => {
  it("hands on the nonce shown when the secret was sent, not one that arrived while the unlock ran", async () => {
    session.set("sk_fill_req", request("a".repeat(32)));
    let finish: (v: unknown) => void = () => undefined;
    const rt = { service: { unlockWithPassword: () => new Promise((ok) => (finish = ok)) } };
    const got: (string | undefined)[] = [];
    await draw(rt, async (info) => void got.push(info?.req));
    expect(lineText()).toBe("Unlock to fill the code on github.com");
    const input = root.byId("secret")!;
    input.value = "correct horse";
    await act(async () => void input.dispatch("input"));
    const form = root.all((e) => e.localName === "form")[0]!;
    await act(async () => void form.dispatch("submit"));
    // while the unlock runs, a newer request arrives and the line follows it
    session.set("sk_fill_req", request("b".repeat(32)));
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    await act(async () => finish({ view: { state: "unlocked" } }));
    await settle();
    expect(got).toEqual(["a".repeat(32)]);
  });
  it("the same with the PIN, which sends itself at its length", async () => {
    session.set("sk_fill_req", request("d".repeat(32)));
    let finish: (v: unknown) => void = () => undefined;
    pin.unlock = () => new Promise((ok) => (finish = ok));
    const rt = { service: {} };
    const got: (string | undefined)[] = [];
    await draw(rt, async (info) => void got.push(info?.req), { digits: 6, triesLeft: 5 });
    expect(lineText()).toBe("Unlock to fill the code on github.com");
    const input = root.byId("pin")!;
    input.value = "246813";
    await act(async () => void input.dispatch("input"));
    session.set("sk_fill_req", request("e".repeat(32)));
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    await act(async () => finish({ ok: true, view: { state: "unlocked" } }));
    await settle();
    expect(got).toEqual(["d".repeat(32)]);
  });
  it("goes when the request's minute is over, with no event to say so (a fake clock)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    session.set("sk_fill_req", request("c".repeat(32), Date.now()));
    await draw({ service: {} }, async () => undefined);
    expect(lineText()).toBe("Unlock to fill the code on github.com");
    await act(async () => void vi.advanceTimersByTime(59_000));
    await settle();
    expect(lineText()).toBe("Unlock to fill the code on github.com");
    await act(async () => void vi.advanceTimersByTime(1_100));
    await settle();
    expect(lineText()).toBe("");
  });
});
