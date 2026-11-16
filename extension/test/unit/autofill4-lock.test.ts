// AUTOFILL2 patch 4a (docs/design/notes/AUTOFILL2-NOTES.md §12): the lock screen (src/popup/screens/Locked.tsx) while a
// page's fill request (R v2) is on it, on a fake clock, over a minimal document (test/helpers/mini-dom.ts). A page can time
// when this screen appears, so (the plan reviews' M-2, M-3 and R2-M1):
//   - a normal pace is unchanged: the PIN typed after the surface's input delay sends itself at its length, and the
//     request is handed on with the unlock (the list then fills that page once);
//   - an entry begun inside the delay keeps its digits but does not send itself, and is sent only by an Enter after
//     600 ms with no digit typed into it; after one wrong PIN, Enter only; an Enter-sent PIN of another length is cleared
//     and not tried (no try spent);
//   - the request handed on is the one on screen at the entry's first character, if it had been there 600 ms by then;
//   - the password and the device button send nothing during the delay;
//   - with the shortcut's request (v1), or none, all of it is as before.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";

const pin = vi.hoisted(() => ({
  offer: null as unknown,
  calls: [] as string[],
  answer: (_: string): unknown => ({ ok: true, view: { state: "unlocked" } }),
}));
vi.mock("../../src/core/service/pin-restart-count", () => ({ restartOffer: () => pin.offer }));
vi.mock("../../src/core/service/pin-restart-steps", () => ({
  unlock: async (_s: unknown, p: string) => (pin.calls.push(p), pin.answer(p)),
  notePassword: async () => undefined,
}));
// the device unlock's chunk, stood in for: a button that reports its press, as ui/DeviceUnlock.tsx's does (onStart first)
vi.mock("../../src/ui/DeviceUnlock", () => ({
  DeviceUnlock: (p: { disabled?: boolean; onStart?: () => void; onUnlocked: (r: unknown) => unknown }) =>
    h(
      "button",
      {
        id: "device",
        disabled: p.disabled,
        onClick: () => {
          p.onStart?.();
          void p.onUnlocked({ view: { state: "unlocked" } });
        },
      },
      "Touch ID",
    ),
  notePassword: async () => undefined,
}));

const g = globalThis as Record<string, unknown>;
const URL1 = "https://github.com/sessions/two-factor";
const DOC = "0123456789ABCDEF0123456789ABCDEF";
let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
let session: Map<string, unknown>;
let fire: (changes: Record<string, unknown>) => void;

const page = (nonce: string) => ({
  v: 2,
  nonce,
  tabId: 7,
  windowId: 3,
  url: URL1,
  host: "github.com",
  at: Date.now(),
  epoch: 0,
  why: "page",
  doc: DOC,
});
const shortcut = (nonce: string) => {
  const { doc: _d, ...r } = page(nonce);
  return { ...r, v: 1, why: "locked" };
};
const A = "a".repeat(32);
const B = "b".repeat(32);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.resetModules();
  g.__SUGGEST_UI__ = true; // the in-page suggestion's release gate open (the build's define); closed: the last describe
  vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
  dom = installMiniDom();
  root = dom.doc.body;
  session = new Map();
  pin.calls = [];
  pin.answer = () => ({ ok: true, view: { state: "unlocked" } });
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
  delete g.__SUGGEST_UI__;
  pin.offer = null;
});
/** A press reaching the surface (its capture listener's call; the mini document has no listeners of its own). */
const pressAt = async (target: unknown = { localName: "button", type: "submit" }) =>
  (await import("../../src/popup/page-delay")).onPress({ type: "pointerdown", target });

async function draw(o: { field?: unknown; device?: boolean; rt?: unknown } = {}) {
  pin.offer = o.field ? { state: "pin", field: o.field } : null;
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice("en");
  await i18n.loadCatalog(async () => ({
    lockFillFor: { message: "Unlock to fill the code on $1" },
    unlock: { message: "Unlock" },
    pinLength: { message: "Your PIN has $1 digits. Type it again." },
    pinWrong: { message: "Wrong PIN. Tries left: $1." },
  }));
  const got: (string | undefined)[] = [];
  const { Locked } = await import("../../src/popup/screens/Locked");
  await act(async () => {
    render(
      h(Locked, {
        rt: (o.rt ?? { service: {} }) as never,
        ...(o.device ? { device: { kind: "device" } as never } : {}),
        onUnlocked: async (info?: { req?: string }) => void got.push(info?.req),
      }),
      root as unknown as Element,
    );
  });
  await settle();
  return got;
}
/** Type `digits` into the field one character at a time, `gap` ms apart. */
async function type(id: string, digits: string, gap = 0) {
  const input = root.byId(id)!;
  for (let i = 1; i <= digits.length; i++) {
    input.value = digits.slice(0, i);
    await act(async () => void input.dispatch("input"));
    if (gap) await tick(gap);
  }
  await settle();
}
const enter = async () => {
  const form = root.all((e) => e.localName === "form")[0]!;
  await act(async () => void form.dispatch("submit"));
  await settle();
};
const errorText = () => root.all((e) => e.getAttribute("class") === "err")[0]?.textContent ?? "";

describe("a page's request on the lock screen: the PIN", () => {
  it("a normal pace is unchanged: typed after the delay, the PIN sends itself at its length, and the request is handed on", async () => {
    session.set("sk_fill_req", page(A));
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(700);
    await type("pin", "246813", 120);
    expect(pin.calls).toEqual(["246813"]);
    expect(got).toEqual([A]);
  });

  it("an entry begun inside the delay keeps its digits, does not send itself, and needs an Enter after a quiet 600 ms", async () => {
    session.set("sk_fill_req", page(A));
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(200);
    await type("pin", "246813", 50); // the last digit at 500 ms
    expect(root.byId("pin")!.value).toBe("246813"); // kept
    expect(pin.calls).toEqual([]); // no send at the PIN's length
    await tick(150); // 650 ms from the start: the delay is over, but the entry is not quiet yet
    await enter();
    expect(pin.calls).toEqual([]);
    await tick(450); // 1,100 ms: 600 ms since its last digit
    await enter();
    expect(pin.calls).toEqual(["246813"]);
    // its first digit came before the request had been on screen 600 ms: not handed on (offered after the unlock)
    expect(got).toEqual([undefined]);
  });

  it("after a wrong PIN, no further send at the length: Enter only, after a quiet 600 ms", async () => {
    session.set("sk_fill_req", page(A));
    pin.answer = () => ({ ok: false, reason: "wrong", triesLeft: 4, digits: 6 });
    await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(700);
    await type("pin", "111111", 100);
    expect(pin.calls).toEqual(["111111"]); // the first entry: a normal pace, sent at its length (case 3: one try)
    expect(errorText()).toContain("Wrong PIN. Tries left: 4.");
    await type("pin", "222222", 100);
    expect(pin.calls).toEqual(["111111"]); // not sent at its length
    await enter();
    expect(pin.calls).toEqual(["111111"]); // not quiet yet
    await tick(600);
    await enter();
    expect(pin.calls).toEqual(["111111", "222222"]);
  });

  it("a 6-digit stream with a 4-digit PIN: no send at 4, and its Enter clears it with the length line; no try spent", async () => {
    session.set("sk_fill_req", page(A));
    await draw({ field: { digits: 4, triesLeft: 5 } });
    await tick(100);
    await type("pin", "123456", 80); // a code typed for the page, landing here
    expect(pin.calls).toEqual([]);
    await tick(700);
    await enter();
    expect(pin.calls).toEqual([]);
    expect(root.byId("pin")!.value).toBe("");
    expect(errorText()).toContain("Your PIN has 4 digits. Type it again.");
  });

  it("the request handed on is the one on screen at the first digit: one that came while typing is not", async () => {
    session.set("sk_fill_req", page(A));
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(700);
    await type("pin", "24", 100);
    session.set("sk_fill_req", page(B));
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    await type("pin", "246813", 100);
    expect(pin.calls).toEqual(["246813"]);
    expect(got).toEqual([undefined]);
  });
});

describe("a page's request that appears on an open lock screen", () => {
  it("is not handed on when its line had been on screen less than 600 ms at the first digit (the delay long over)", async () => {
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(5000); // the surface's delay is long over
    session.set("sk_fill_req", page(A));
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    await tick(200); // the user starts typing 200 ms after the line appeared
    await type("pin", "246813", 50);
    expect(pin.calls).toEqual(["246813"]); // a normal entry: it sends itself
    expect(got).toEqual([undefined]); // but the request is only offered after the unlock
  });

  it("is handed on when its line had been on screen 600 ms or more at the first digit", async () => {
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(5000);
    session.set("sk_fill_req", page(A));
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    await tick(650);
    await type("pin", "246813", 50);
    expect(got).toEqual([A]);
  });
});

describe("a press that begins inside the input delay does not count when it ends after it", () => {
  it("the Unlock button pressed down at 300 ms and let go at 1,000 ms sends nothing; a press begun after the delay does", async () => {
    session.set("sk_fill_req", page(A));
    let sent = 0;
    const rt = { service: { unlockWithPassword: async () => (sent++, { view: { state: "unlocked" } }) } };
    await draw({ rt });
    await tick(800);
    await type("secret", "correct horse");
    await tick(700); // quiet since the last character, and the delay long over
    await pressAt(); // goes down now, at about 1,500 ms: the delay is over, so this one counts…
    await enter();
    expect(sent).toBe(1);
  });

  it("…but one that went down inside the delay does not, though the delay is over when it ends", async () => {
    session.set("sk_fill_req", page(A));
    let sent = 0;
    const rt = { service: { unlockWithPassword: async () => (sent++, { view: { state: "unlocked" } }) } };
    await draw({ rt });
    await tick(300);
    await pressAt(); // down at 300 ms, inside the delay (it re-arms it, to 900 ms)
    await tick(700); // up at 1,000 ms: the delay is over
    const input = root.byId("secret")!;
    input.value = "correct horse"; // typed before the press ended, as a page could have it (no keydown here)
    await act(async () => void input.dispatch("input"));
    await tick(700);
    await enter(); // the click of that press
    expect(sent).toBe(0);
  });
});

describe("a page's request on the lock screen: the master password (R2-M1 b, for the password too)", () => {
  it("typed inside the delay: Enter waits for 600 ms with no character typed, then sends; nothing is handed on", async () => {
    session.set("sk_fill_req", page(A));
    let sent = 0;
    const rt = { service: { unlockWithPassword: async () => (sent++, { view: { state: "unlocked" } }) } };
    const got = await draw({ rt });
    await tick(100);
    await type("secret", "my page password", 20); // the last character at about 400 ms
    await tick(300); // 700 ms: the delay is over, the entry is not quiet yet
    await enter();
    expect(sent).toBe(0);
    await tick(400);
    await enter();
    expect(sent).toBe(1);
    expect(got).toEqual([undefined]);
  });

  it("after a wrong password on this screen, the next one is sent by Enter only after its quiet", async () => {
    session.set("sk_fill_req", page(A));
    let tries = 0;
    const rt = {
      service: {
        unlockWithPassword: async () => {
          tries++;
          throw Object.assign(new Error("wrong"), { code: "wrong_secret" });
        },
      },
    };
    await draw({ rt });
    await tick(800);
    await type("secret", "first try");
    await enter(); // a normal pace: sent at once (and wrong)
    expect(tries).toBe(1);
    const input = root.byId("secret")!;
    input.value = "";
    await act(async () => void input.dispatch("input"));
    await type("secret", "second try");
    await enter(); // right after its last character: not yet
    expect(tries).toBe(1);
    await tick(650);
    await enter();
    expect(tries).toBe(2);
  });
});

describe("a page's request on the lock screen: the device button and a request that came late (M-2)", () => {
  it("a request that appears on an open lock screen, with Touch ID pressed 200 ms later: not handed on, only offered", async () => {
    const got = await draw({ device: true });
    await tick(5000); // the surface's delay long over
    session.set("sk_fill_req", page(A));
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    await tick(200);
    await act(async () => void root.byId("device")!.dispatch("click"));
    await settle();
    expect(got).toEqual([undefined]);
  });

  it("the same request, with Touch ID pressed 700 ms after it appeared: handed on", async () => {
    const got = await draw({ device: true });
    await tick(5000);
    session.set("sk_fill_req", page(A));
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    await tick(700);
    await act(async () => void root.byId("device")!.dispatch("click"));
    await settle();
    expect(got).toEqual([A]);
  });

  it("the delay armed again after the line was up (the window's focus): an entry begun then is not handed on", async () => {
    session.set("sk_fill_req", page(A));
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(700); // the line up 700 ms, the delay over
    (await import("../../src/popup/page-delay")).pageDelay.rearm(); // the window gained the focus again
    await tick(100);
    await type("pin", "246813", 50); // begun inside the new delay: no send at the length
    expect(pin.calls).toEqual([]);
    await tick(700);
    await enter();
    expect(pin.calls).toEqual(["246813"]);
    expect(got).toEqual([undefined]);
  });
});

describe("a page's request on the lock screen: the password and the device button", () => {
  it("the password: nothing is sent during the delay; typed after it, sent and handed on", async () => {
    session.set("sk_fill_req", page(A));
    let sent = 0;
    const rt = { service: { unlockWithPassword: async () => (sent++, { view: { state: "unlocked" } }) } };
    const got = await draw({ rt });
    await tick(100);
    await type("secret", "pw");
    await enter();
    expect(sent).toBe(0);
    await tick(700);
    const input = root.byId("secret")!;
    input.value = "";
    await act(async () => void input.dispatch("input"));
    await type("secret", "correct horse");
    await enter();
    expect(sent).toBe(1);
    expect(got).toEqual([A]);
  });

  it("the device button is disabled during the delay; pressed after it, the request is handed on", async () => {
    session.set("sk_fill_req", page(A));
    const got = await draw({ device: true });
    await settle();
    const btn = () => root.byId("device")!;
    expect(btn().disabled).toBe(true);
    await tick(700);
    expect(btn().disabled).toBe(false);
    await act(async () => void btn().dispatch("click"));
    await settle();
    expect(got).toEqual([A]);
  });
});

describe("the shortcut's request (v1), or none: as before", () => {
  it("a PIN typed at once sends itself at its length and hands the request on", async () => {
    session.set("sk_fill_req", shortcut(A));
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    await tick(50);
    await type("pin", "246813", 30);
    expect(pin.calls).toEqual(["246813"]);
    expect(got).toEqual([A]);
  });

  it("after a wrong PIN it still sends itself at its length; an Enter of another length is tried", async () => {
    pin.answer = () => ({ ok: false, reason: "wrong", triesLeft: 4, digits: 6 });
    await draw({ field: { digits: 6, triesLeft: 5 } });
    await type("pin", "111111");
    await type("pin", "222222");
    expect(pin.calls).toEqual(["111111", "222222"]);
    await type("pin", "1234");
    await enter();
    expect(pin.calls).toEqual(["111111", "222222", "1234"]);
  });
});

describe("the gate closed (a store build until the flip)", () => {
  it("a request v2 is no request at all: no line, and a PIN typed at once sends itself at its length", async () => {
    delete g.__SUGGEST_UI__;
    session.set("sk_fill_req", page(A));
    const got = await draw({ field: { digits: 6, triesLeft: 5 } });
    expect(root.byId("lock-fill")).toBeNull();
    await tick(50);
    await type("pin", "246813", 30);
    expect(pin.calls).toEqual(["246813"]);
    expect(got).toEqual([undefined]);
  });
});
