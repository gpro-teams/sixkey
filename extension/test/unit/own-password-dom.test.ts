// The master password is the user's own (OWNER-DECISIONS/15; docs/design/notes/OWN-PASSWORD-NOTES.md §1, §3), rendered
// by Preact into a minimal document (test/helpers/mini-dom.ts): PasswordFields' order by purpose, the warning below 50
// bits and its "Use anyway" toggle, held to the value it was pressed for; the change form handing the press to key-ops;
// the popup's lock screen's line for a PIN that needs the master password. The browser's is own-password.spec.ts's.
import { h, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceStatus } from "../../src/core/service/service";
import type { KeyOps } from "../../src/options/key-ops";
import { SecurityKeys } from "../../src/options/Security";
import { PasswordFields } from "../../src/options/shared";
import type { PopupRuntime } from "../../src/platform/runtime-base";
import { Locked } from "../../src/popup/screens/Locked";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice } from "../../src/ui/i18n";
import { masterAccepts, measure, offlineSeconds, roughTime, type Strength } from "../../src/ui/strength";
import { installMiniDom, type MiniDocument, type MiniElement } from "../helpers/mini-dom";

vi.mock("../../src/popup/chrome", () => ({
  Frame: (p: { children: preact.ComponentChildren }) => p.children,
  openOptions: vi.fn(),
}));
vi.mock("../../src/options/PinBox", () => ({ PinBox: () => null }));
// what the PIN offers on the lock screen (pin-restart-count.ts restartOffer, from the view's read) and its record's unlock
// (pin-restart-steps.ts, a lazy chunk): set by each test
const pin = vi.hoisted(() => ({
  offer: null as unknown,
  unlock: (..._: unknown[]): Promise<unknown> => Promise.resolve(null),
  note: (..._: unknown[]): Promise<void> => Promise.resolve(),
}));
vi.mock("../../src/core/service/pin-restart-count", () => ({ restartOffer: () => pin.offer }));
vi.mock("../../src/core/service/pin-restart-steps", () => ({
  unlock: (...a: unknown[]) => pin.unlock(...a),
  notePassword: (...a: unknown[]) => pin.note(...a),
}));
vi.mock("../../src/options/SecurityMode", () => ({ SecurityMode: () => null }));
vi.mock("../../src/options/SecurityCard", () => ({ SecurityCard: () => null }));
vi.mock("../../src/platform/runtime", async (orig) => ({
  ...(await orig<typeof import("../../src/platform/runtime")>()),
  passwordFormat: () => Promise.resolve(null),
}));

const OWN = "JennyLovesTea"; // 13 characters, about 34 bits: past the floor, below the bar
const SHORT = "Jenny2Loves"; // 11: refused by the floor

let dom: ReturnType<typeof installMiniDom>;
let doc: MiniDocument;
let root: MiniElement;
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
  await measure("warm up"); // zxcvbn's lazy chunk, loaded once
});
beforeEach(() => {
  dom = installMiniDom();
  doc = dom.doc;
  root = doc.body;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
});
afterAll(() => vi.restoreAllMocks());

const byId = (id: string) => root.byId(id);
/** Every element with an id, in document order. */
const order = () => root.all((e) => e.id !== "").map((e) => e.id);
async function typeInto(id: string, v: string) {
  await act(async () => {
    const el = byId(id)!;
    el.value = v;
    el.dispatch("input", { inputType: "insertText" });
  });
  await act(async () => void (await measure(v))); // the field's own measure() has answered too
}
const click = (id: string) => act(async () => void byId(id)!.dispatch("click"));

/** A page that sets a master password, as FirstRun, Reset and Security hold it: the rule is masterAccepts. */
function harness(purpose?: "file", withAnyway = true) {
  const seen: { accept: boolean; anyway: string | null } = { accept: false, anyway: null };
  function Page() {
    const [pw, setPw] = useState("");
    const [pw2, setPw2] = useState("");
    const [strength, setStrength] = useState<Strength | null>(null);
    const [anyway, setAnyway] = useState<string | null>(null);
    seen.anyway = anyway;
    seen.accept = pw.length > 0 && pw === pw2 && masterAccepts(strength, anyway === pw);
    return h(PasswordFields, {
      idPrefix: "x",
      value: pw,
      confirm: pw2,
      onValue: setPw,
      onConfirm: setPw2,
      onStrength: setStrength,
      ...(purpose ? { purpose } : {}),
      ...(withAnyway ? { anyway: { value: anyway, set: setAnyway } } : {}),
    });
  }
  return { seen, mount: () => act(() => render(h(Page, {}), root as unknown as Element)) };
}

describe("PasswordFields: which comes first", () => {
  it("the master password: the fields first, 'Generate for me' a secondary button after them; its box under it", async () => {
    harness().mount();
    const ids = order();
    expect(ids.indexOf("x-pw")).toBeLessThan(ids.indexOf("x-gen"));
    expect(ids.indexOf("x-pw2")).toBeLessThan(ids.indexOf("x-gen"));
    expect(byId("x-gen")!.getAttribute("class")).toBe("btn sm ghost");
    expect(byId("x-own")).toBeNull(); // nothing to go back from yet
    await click("x-gen");
    const after = order();
    expect(after.indexOf("x-gen")).toBeLessThan(after.indexOf("x-made"));
    expect(after.indexOf("x-own")).toBeGreaterThan(after.indexOf("x-made")); // "Choose my own" in the box
    expect(byId("x-pw")!.value).toBe(byId("x-value")!.textContent);
    await click("x-own");
    expect(byId("x-pw")!.value).toBe("");
    expect(byId("x-made")).toBeNull();
    expect(doc.activeElement?.id).toBe("x-pw");
  });

  it("a backup file: 'Generate for me' first and primary, 'Choose my own' beside it, as before", () => {
    harness("file", false).mount();
    const ids = order();
    expect(ids.indexOf("x-gen")).toBeLessThan(ids.indexOf("x-pw"));
    expect(ids.indexOf("x-own")).toBeLessThan(ids.indexOf("x-pw"));
    expect(byId("x-gen")!.getAttribute("class")).toBe("btn");
  });
});

describe("PasswordFields: below 50 bits on the master password's pages", () => {
  it("the warning says what it means and how long; 'Use anyway' accepts this value and only it", async () => {
    const { seen, mount } = harness();
    mount();
    expect(byId("x-strength")!.textContent).toBe(
      "At least 12 characters. 50 bits or more is best: a few random words work well.",
    );
    await typeInto("x-pw", OWN);
    await typeInto("x-pw2", OWN);
    const bits = Math.floor((await measure(OWN)).bits);
    expect(byId("x-strength")!.textContent).toBe(`Estimated ${bits} bits, below the 50 we recommend.`);
    const why = byId("x-weak-why")!.textContent;
    expect(why).toMatch(/^Someone who copies this browser profile can guess offline, with no limit on tries/);
    // 2^bits guesses at 2M iterations on one RTX 5090: about 40 days for this one's 34.2 bits
    const time = roughTime(offlineSeconds((await measure(OWN)).bits));
    expect(time).toEqual({ unit: "day", count: 40 });
    expect(why).toContain("in about 40 days, and more cards are faster.");
    expect(byId("x-pw")!.getAttribute("aria-describedby")).toBe("x-strength x-weak-why");
    expect(byId("x-anyway")!.getAttribute("aria-pressed")).toBe("false");
    expect(byId("x-use-gen")).not.toBeNull(); // a generated one is still one click away
    expect(seen.accept).toBe(false);
    await click("x-anyway");
    expect(byId("x-anyway")!.getAttribute("aria-pressed")).toBe("true");
    expect(seen.anyway).toBe(OWN);
    expect(seen.accept).toBe(true);
    // pressed again: taken back
    await click("x-anyway");
    expect(seen.accept).toBe(false);
    await click("x-anyway");
    // an edit lets go of it at once, and typing the same value back needs a new press
    await typeInto("x-pw", `${OWN}x`);
    expect(seen.anyway).toBeNull();
    expect(seen.accept).toBe(false);
    await typeInto("x-pw", OWN);
    expect(seen.anyway).toBeNull();
    expect(byId("x-anyway")!.getAttribute("aria-pressed")).toBe("false");
    expect(seen.accept).toBe(false);
  });

  it("under 10^6 guesses (a common password with digits): 'too easy to guess', refused, no 'Use anyway'", async () => {
    const { seen, mount } = harness();
    mount();
    await typeInto("x-pw", "Password1234");
    await typeInto("x-pw2", "Password1234");
    expect(byId("x-strength")!.textContent).toBe("Too easy to guess: too close to a common password.");
    expect(byId("x-weak")).toBeNull();
    expect(byId("x-anyway")).toBeNull();
    expect(byId("x-use-gen")).not.toBeNull();
    expect(seen.accept).toBe(false);
  });

  it("refused by the floor: why, and no warning or 'Use anyway'", async () => {
    const { seen, mount } = harness();
    mount();
    await typeInto("x-pw", SHORT);
    await typeInto("x-pw2", SHORT);
    expect(byId("x-strength")!.textContent).toBe("Too short: at least 12 characters.");
    expect(byId("x-weak")).toBeNull();
    expect(byId("x-anyway")).toBeNull();
    expect(seen.accept).toBe(false);
    await typeInto("x-pw", "abababababab");
    expect(byId("x-strength")!.textContent).toBe("Too predictable: avoid keyboard runs, sequences and repeats.");
    expect(byId("x-anyway")).toBeNull();
  });

  it("a generated password: no warning, accepted without a press", async () => {
    const { seen, mount } = harness();
    mount();
    await click("x-gen");
    await act(async () => void (await measure(byId("x-pw")!.value)));
    expect(byId("x-weak")).toBeNull();
    expect(byId("x-strength")!.textContent).toMatch(/^Generated: 79 bits/);
    expect(seen.accept).toBe(true);
    expect(seen.anyway).toBeNull();
  });

  it("the page going away lets go of the press with the values", async () => {
    const { seen, mount } = harness();
    mount();
    await typeInto("x-pw", OWN);
    await typeInto("x-pw2", OWN);
    await click("x-anyway");
    expect(seen.anyway).toBe(OWN);
    await act(async () => void dom.page.dispatch("pagehide"));
    expect(seen.anyway).toBeNull();
    expect(byId("x-pw")!.value).toBe("");
  });

  it("the fields going away (their step or box closed) let go of the press, while the page that held it stays", async () => {
    const seen: { anyway: string | null; hide: () => void } = { anyway: null, hide: () => undefined };
    function Page() {
      const [pw, setPw] = useState("");
      const [anyway, setAnyway] = useState<string | null>(null);
      const [shown, setShown] = useState(true);
      seen.anyway = anyway;
      seen.hide = () => setShown(false);
      return shown
        ? h(PasswordFields, {
            idPrefix: "x",
            value: pw,
            confirm: pw,
            onValue: setPw,
            onConfirm: () => undefined,
            anyway: { value: anyway, set: setAnyway },
          })
        : h("p", { id: "gone" }, "");
    }
    act(() => render(h(Page, {}), root as unknown as Element));
    await typeInto("x-pw", OWN);
    await click("x-anyway");
    expect(seen.anyway).toBe(OWN);
    await act(async () => seen.hide());
    expect(byId("gone")).not.toBeNull();
    expect(seen.anyway).toBeNull();
  });

  it("without `anyway` (a backup file, the sync key operations) 50 bits is the bar: the old line, no warning", async () => {
    for (const purpose of ["file", undefined] as const) {
      const { seen, mount } = harness(purpose, false);
      mount();
      await typeInto("x-pw", OWN);
      await typeInto("x-pw2", OWN);
      expect(byId("x-strength")!.textContent).toMatch(/^Estimated \d+ of 50 bits: \d+ bits short\./);
      expect(byId("x-weak")).toBeNull();
      expect(byId("x-anyway")).toBeNull();
      expect(seen.accept).toBe(false);
      act(() => render(null, root as unknown as Element));
    }
  });
});

describe("Security › change the master password, through key-ops", () => {
  it("the button waits for 'Use anyway'; the change is asked with the press for this value", async () => {
    const calls: unknown[][] = [];
    const keys: KeyOps = {
      busy: false,
      code: null,
      error: null,
      info: null,
      clear: () => undefined,
      enable: async () => true,
      change: async (o, pw, anyway) => (calls.push([o, pw, anyway]), true),
      newCode: async () => true,
      rotate: async () => true,
      confirmShares: async () => true,
      codeSaved: () => undefined,
    };
    const status = { state: "unlocked", passwordProtected: true, events: [] } as unknown as ServiceStatus;
    await act(async () =>
      render(
        h(SecurityKeys, { rt: {} as never, status, vault: null, reload: () => Promise.resolve(), keys, syncOn: false }),
        root as unknown as Element,
      ),
    );
    await click("fold-change-toggle");
    await typeInto("old-pw", "JDXT-NBSG-6JQG-XBTV"); // an existing user's generated password
    await typeInto("change-pw", OWN);
    await typeInto("change-pw2", OWN);
    const button = () => root.all((e) => e.localName === "button" && e.type === "submit")[0]!;
    expect(button().disabled).toBe(true);
    await click("change-anyway");
    expect(button().disabled).toBe(false);
    await act(async () => void root.all((e) => e.localName === "form")[0]!.dispatch("submit"));
    expect(calls).toEqual([["JDXT-NBSG-6JQG-XBTV", OWN, true]]);
  });
});

describe("the popup's lock screen: the line for a PIN that waits for the master password", () => {
  const rt = { service: { unlockWithPassword: vi.fn() } } as unknown as PopupRuntime;
  const mount = async () => {
    await act(async () => render(h(Locked, { rt, onUnlocked: vi.fn() } as never), root as unknown as Element));
    // the PIN's steps, the lazy chunk the screen loads as soon as it shows the PIN's field: in before a PIN is typed
    // (two imports of a mocked module still under way can hand one of them the real module)
    await act(async () => void (await import("../../src/core/service/pin-restart-steps")));
  };
  const unmount = () => act(() => render(null, root as unknown as Element));
  const opens = (triesLeft = 5) => ({ state: "pin", field: { digits: 6, triesLeft } });
  /** Until the PIN typed has reached the record's unlock (a lazy chunk: a few turns), and its answer is drawn. */
  async function sent(unlock: { mock: { calls: unknown[] } }) {
    for (let i = 0; i < 50 && !unlock.mock.calls.length; i++)
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  }
  afterEach(() => {
    pin.offer = null;
  });

  it("shown under the master password's field when the record waits for it or is paused, and only then", async () => {
    for (const state of ["wait", "paused"]) {
      pin.offer = { state };
      await mount();
      expect(byId("pin"), state).toBeNull();
      expect(byId("pin-waiting")!.textContent, state).toBe("The PIN works again once you type the master password.");
      unmount();
    }
    pin.offer = null; // no PIN set up here, or a profile declared shared
    await mount();
    expect(byId("pin-waiting")).toBeNull();
    unmount();
    // a PIN that opens Sixkey: the PIN's own screen, no line
    pin.offer = opens();
    await mount();
    expect(byId("pin")).not.toBeNull();
    expect(byId("pin-waiting")).toBeNull();
  });

  it("the 5th wrong PIN on this screen: the master password's field, with the line at once", async () => {
    const unlock = vi.fn(async (..._: unknown[]) => ({ ok: false, reason: "exhausted" }));
    pin.unlock = unlock;
    pin.offer = opens(1);
    await mount();
    expect(byId("pin-waiting")).toBeNull();
    await act(async () => {
      const field = byId("pin")!;
      field.value = "135792";
      field.dispatch("input", { inputType: "insertText" }); // its length reached: sent
    });
    await sent(unlock);
    expect(unlock.mock.calls[0]![1]).toBe("135792");
    expect(byId("secret")).not.toBeNull();
    expect(byId("pin-waiting")).not.toBeNull();
  });

  it("a 'waiting' answer (the right 5th PIN with a lock meanwhile): the master password's field, with the line at once (review of PINONE, PO-03)", async () => {
    const unlock = vi.fn(async (..._: unknown[]) => ({ ok: false, reason: "waiting" }));
    pin.unlock = unlock;
    pin.offer = opens(1);
    await mount();
    await act(async () => {
      const field = byId("pin")!;
      field.value = "135792";
      field.dispatch("input", { inputType: "insertText" });
    });
    await sent(unlock);
    expect(byId("secret")).not.toBeNull();
    expect(byId("pin-waiting")?.textContent).toBe("The PIN works again once you type the master password.");
    expect(root.all((e) => e.getAttribute("role") === "alert")[0]?.textContent).not.toMatch(/locked meanwhile|again/i);
  });

  it("the master password typed: the PIN's note (the service and the kit), waited for before the list, for a record that waits, is paused or is not made yet; none without a PIN, none after the recovery key (review of PINONE, PO-02, PO-07)", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const note = vi.fn((..._: unknown[]) => {
      order.push("note");
      return new Promise<void>((r) => (release = r));
    });
    pin.note = note;
    const unlockWithPassword = vi.fn(async () => ({ view: { state: "unlocked" } }));
    const unlockWithRecoveryCode = vi.fn(async () => ({ view: { state: "unlocked" } }));
    const service = { unlockWithPassword, unlockWithRecoveryCode };
    const onUnlocked = vi.fn(async () => void order.push("list"));
    const draw = () =>
      act(async () => render(h(Locked, { rt: { service } as never, onUnlocked } as never), root as unknown as Element));
    const typeAndSend = async (v: string) => {
      await typeInto("secret", v);
      await act(async () => void root.all((e) => e.localName === "form")[0]!.dispatch("submit"));
    };
    // the migration's offer is "wait" too (sk_pin, no record): what the screen is told is the same
    for (const offer of [{ state: "wait" }, { state: "paused" }, { state: "wait" }]) {
      note.mockClear();
      order.length = 0;
      pin.offer = offer;
      await draw();
      await typeAndSend(OWN);
      for (let i = 0; i < 20 && !note.mock.calls.length; i++) await act(async () => void (await Promise.resolve()));
      expect(note.mock.calls, offer.state).toHaveLength(1);
      expect(note.mock.calls[0]![0], offer.state).toBe(service);
      expect(note.mock.calls[0]!.length, offer.state).toBe(2); // (service, kit): its proof is the service's own mark
      expect(order, offer.state).toEqual(["note"]); // the list waits for it
      await act(async () => release());
      for (let i = 0; i < 20 && order.length < 2; i++) await act(async () => void (await Promise.resolve()));
      expect(order, offer.state).toEqual(["note", "list"]);
      act(() => render(null, root as unknown as Element));
    }
    // no PIN set up here (or a shared profile): no note
    note.mockClear();
    pin.offer = null;
    await draw();
    await typeAndSend(OWN);
    expect(note).not.toHaveBeenCalled();
    act(() => render(null, root as unknown as Element));
    // the recovery key: never a note
    pin.offer = { state: "wait" };
    await draw();
    const recovery = root.all((e) => e.localName === "button" && /recovery key/i.test(e.textContent))[0]!;
    await act(async () => void recovery.dispatch("click"));
    await typeAndSend("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567");
    expect(unlockWithRecoveryCode).toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("the list waits for the note at most 10 s: not shown while it runs, shown once it ends, or at 10 s if it hangs (fake timers; review of PINONE r2, S-07)", async () => {
    const flush = () =>
      act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
    for (const endsAt of [3_000, null] as const) {
      let release: () => void = () => undefined;
      const note = vi.fn((..._: unknown[]) => new Promise<void>((r) => (release = r)));
      pin.note = note;
      pin.offer = { state: "wait" };
      const onUnlocked = vi.fn(async () => undefined);
      const service = { unlockWithPassword: vi.fn(async () => ({ view: { state: "unlocked" } })) };
      await act(async () =>
        render(h(Locked, { rt: { service } as never, onUnlocked } as never), root as unknown as Element),
      );
      await act(async () => void (await import("../../src/core/service/pin-restart-steps"))); // its chunk, loaded
      await typeInto("secret", OWN);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await act(async () => void root.all((e) => e.localName === "form")[0]!.dispatch("submit"));
        await flush();
        expect(note, String(endsAt)).toHaveBeenCalledTimes(1);
        expect(onUnlocked, String(endsAt)).not.toHaveBeenCalled(); // not at once
        if (endsAt !== null) {
          await act(async () => void vi.advanceTimersByTime(endsAt));
          await flush();
          expect(onUnlocked, "still running").not.toHaveBeenCalled();
          await act(async () => release()); // the note ends before the 10 s
          await flush();
          expect(onUnlocked, "once it ended").toHaveBeenCalledTimes(1);
          await act(async () => void vi.advanceTimersByTime(10_000));
          await flush();
          expect(onUnlocked, "and only once").toHaveBeenCalledTimes(1);
        } else {
          await act(async () => void vi.advanceTimersByTime(9_999));
          await flush();
          expect(onUnlocked, "a hung note, under 10 s").not.toHaveBeenCalled();
          await act(async () => void vi.advanceTimersByTime(1));
          await flush();
          expect(onUnlocked, "a hung note, at 10 s").toHaveBeenCalledTimes(1);
          await act(async () => release());
        }
      } finally {
        vi.useRealTimers();
      }
      act(() => render(null, root as unknown as Element));
    }
  });

  it("an 'ended' answer (removed, a key change, or the profile declared shared meanwhile): no line", async () => {
    // "ended" says only that the PIN cannot be used now, not that the master password brings it back: in a profile
    // declared shared it never does, so the line must not follow it (only "exhausted", tries spent, implies it)
    const unlock = vi.fn(async (..._: unknown[]) => ({ ok: false, reason: "ended" }));
    pin.unlock = unlock;
    pin.offer = opens();
    await mount();
    await act(async () => {
      const field = byId("pin")!;
      field.value = "135792";
      field.dispatch("input", { inputType: "insertText" });
    });
    await sent(unlock);
    expect(unlock.mock.calls[0]![1]).toBe("135792");
    expect(byId("secret")).not.toBeNull(); // the master password's field, with the PIN's "can't be used now" error
    expect(root.all((e) => e.getAttribute("role") === "alert")[0]!.textContent).toMatch(/can't be used now/);
    expect(byId("pin-waiting")).toBeNull();
  });
});
