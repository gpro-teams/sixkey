// The master password's pages hold "Use anyway" to the value it was pressed for (OWNER-DECISIONS/15;
// docs/design/notes/OWN-PASSWORD-NOTES.md §1.3), and the settings page's unlock bar shows the PIN's line only when it is
// true (§3), rendered by Preact into a minimal document (test/helpers/mini-dom.ts). PasswordFields is replaced by a stub
// that hands the test its props, so a press for another value, which the real component never leaves behind, can be
// put in front of each page: its button must stay disabled and its last check before the write must refuse.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceStatus } from "../../src/core/service/service";
import type { KeyOps } from "../../src/options/key-ops";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice } from "../../src/ui/i18n";
import { measure, type Strength } from "../../src/ui/strength";
import { installMiniDom, type MiniDocument, type MiniElement } from "../helpers/mini-dom";

type Fields = {
  value: string;
  onValue: (v: string) => void;
  onConfirm: (v: string) => void;
  onStrength?: (s: Strength | null) => void;
  anyway?: { value: string | null; set: (v: string | null) => void };
};
const fields: { current: Fields | null } = { current: null };
const pinState: { current: unknown; next?: () => Promise<unknown> } = { current: null };

vi.mock("../../src/options/shared", async (orig) => ({
  ...(await orig<typeof import("../../src/options/shared")>()),
  PasswordFields: (p: Fields) => {
    fields.current = p;
    return null;
  },
}));
vi.mock("../../src/core/service/pin-admin", () => ({
  PinAdmin: class {
    state = () => (pinState.next ? pinState.next() : Promise.resolve(pinState.current));
  },
}));
// the PIN's unlock and the master password's note (its record's steps, a lazy chunk): what the bar is told
const pinSteps = vi.hoisted(() => ({
  unlock: (..._: unknown[]): Promise<unknown> => Promise.resolve(null),
  note: (..._: unknown[]): Promise<void> => Promise.resolve(),
}));
vi.mock("../../src/core/service/pin-restart-steps", () => ({
  unlock: (...a: unknown[]) => pinSteps.unlock(...a),
  notePassword: (...a: unknown[]) => pinSteps.note(...a),
}));
vi.mock("../../src/options/PinBox", () => ({ PinBox: () => null }));
vi.mock("../../src/options/SecurityMode", () => ({ SecurityMode: () => null }));
vi.mock("../../src/options/SecurityCard", () => ({ SecurityCard: () => null }));
vi.mock("../../src/platform/runtime", async (orig) => ({
  ...(await orig<typeof import("../../src/platform/runtime")>()),
  passwordFormat: () => Promise.resolve(null),
}));

const { FirstRun } = await import("../../src/options/FirstRun");
const { ResetPassword } = await import("../../src/options/Reset");
const { SecurityKeys } = await import("../../src/options/Security");
const { UnlockBar } = await import("../../src/options/UnlockBar");

const OWN = "JennyLovesTea"; // 13 characters, about 34 bits: the warning, and "Use anyway"

let dom: ReturnType<typeof installMiniDom>;
let doc: MiniDocument;
let root: MiniElement;
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
});
beforeEach(() => {
  dom = installMiniDom();
  doc = dom.doc;
  root = doc.body;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  fields.current = null;
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
});
afterAll(() => vi.restoreAllMocks());

const byId = (id: string) => root.byId(id);
const form = () => root.all((e) => e.localName === "form").at(-1)!;
const submitButton = () => root.all((e) => e.localName === "button" && e.type === "submit").at(-1)!;
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}
/** The user's own weak password in both fields, its strength reported, and a press left for `pressedFor`. */
async function typeOwn(pressedFor: string | null) {
  const s = await measure(OWN);
  await act(async () => {
    fields.current!.onValue(OWN);
    fields.current!.onConfirm(OWN);
  });
  await act(async () => fields.current!.onStrength?.(s));
  await act(async () => fields.current!.anyway!.set(pressedFor));
}
async function submit() {
  await act(async () => void form().dispatch("submit"));
  await settle();
}

describe("each page holds 'Use anyway' to the value it was pressed for", () => {
  it("first run: a press for another value keeps Continue disabled and the last check refuses", async () => {
    const prepareKeys = vi.fn(async () => ({ vaultId: "vault-aaaaaaaa", recoveryCode: "CODE" }));
    const rt = { service: { prepareKeys } } as never;
    const props = {
      rt,
      start: { mode: "create" },
      onExit: vi.fn(),
      onDone: vi.fn(),
      onRefresh: vi.fn(),
      onHolding: vi.fn(),
    };
    await act(async () => render(h(FirstRun, props as never), root as unknown as Element));
    await typeOwn("JennyLovesTe"); // stale: pressed for what the field held a moment ago
    expect(byId("fr-next")!.disabled).toBe(true);
    await submit(); // past the button: the page's own last check
    expect(prepareKeys).not.toHaveBeenCalled();
    await act(async () => fields.current!.anyway!.set(OWN));
    expect(byId("fr-next")!.disabled).toBe(false);
    await submit();
    expect(prepareKeys).toHaveBeenCalledWith(OWN, {});
  });

  it("the reset with the recovery code: the same", async () => {
    const prepareReset = vi.fn(async () => ({ recoveryCode: "CODE" }));
    const ctx = { rt: { service: { prepareReset } }, status: { state: "locked" }, vault: null, reload: vi.fn() };
    await act(async () =>
      render(h(ResetPassword, { ctx, onLeave: vi.fn(), onHolding: vi.fn() } as never), root as unknown as Element),
    );
    await act(async () => {
      const code = byId("reset-code-in")!;
      code.value = "ZDXY-QX0C-0NHK-2ZR9-2Y4A-AGSX-FCCP";
      code.dispatch("input", { inputType: "insertText" });
    });
    await typeOwn("JennyLovesTe");
    expect(byId("reset-next")!.disabled).toBe(true);
    await submit();
    expect(prepareReset).not.toHaveBeenCalled();
    await act(async () => fields.current!.anyway!.set(OWN));
    expect(byId("reset-next")!.disabled).toBe(false);
    await submit();
    expect(prepareReset).toHaveBeenCalledWith(expect.any(String), OWN);
  });

  it("turning the master password on and changing it hand key-ops the press for this value only", async () => {
    const calls: unknown[][] = [];
    const keys: KeyOps = {
      busy: false,
      code: null,
      error: null,
      info: null,
      clear: () => undefined,
      // as key-ops answers: refused (false) without the press, below the bar
      enable: async (pw, anyway) => (calls.push(["enable", pw, anyway]), anyway),
      change: async (o, pw, anyway) => (calls.push(["change", o, pw, anyway]), anyway),
      newCode: async () => true,
      rotate: async () => true,
      codeSaved: () => undefined,
    };
    const put = (status: ServiceStatus) =>
      act(async () =>
        render(
          h(SecurityKeys, {
            rt: {} as never,
            status,
            vault: null,
            reload: () => Promise.resolve(),
            keys,
            syncOn: false,
          }),
          root as unknown as Element,
        ),
      );
    // a Phase 0 device-key vault: the box that turns the password on
    await put({ state: "unlocked", passwordProtected: false, events: [] } as unknown as ServiceStatus);
    await typeOwn("JennyLovesTe");
    expect(byId("enable-password")!.disabled).toBe(true);
    await submit();
    expect(calls).toEqual([["enable", OWN, false]]); // asked without the press: key-ops refuses it (short-settings-state)
    await act(async () => fields.current!.anyway!.set(OWN));
    expect(byId("enable-password")!.disabled).toBe(false);
    await submit();
    expect(calls.at(-1)).toEqual(["enable", OWN, true]);
    act(() => render(null, root as unknown as Element));

    // a protected vault: the change form
    calls.length = 0;
    await put({ state: "unlocked", passwordProtected: true, events: [] } as unknown as ServiceStatus);
    await act(async () => void byId("fold-change-toggle")!.dispatch("click"));
    await act(async () => {
      const old = byId("old-pw")!;
      old.value = "JDXT-NBSG-6JQG-XBTV";
      old.dispatch("input", { inputType: "insertText" });
    });
    await typeOwn("JennyLovesTe");
    expect(submitButton().disabled).toBe(true);
    await submit();
    expect(calls).toEqual([["change", "JDXT-NBSG-6JQG-XBTV", OWN, false]]);
    await act(async () => fields.current!.anyway!.set(OWN));
    expect(submitButton().disabled).toBe(false);
    await submit();
    expect(calls.at(-1)).toEqual(["change", "JDXT-NBSG-6JQG-XBTV", OWN, true]);
  });
});

describe("the settings page's unlock bar: the PIN's line only when it is true", () => {
  // PinAdmin.state's answer: the PIN's record opens Sixkey ("pin"), or waits for the master password ("wait")
  const look = (opens: boolean, available = "ok") => ({
    available,
    pin: { digits: 6 },
    restart: opens ? { state: "pin", triesLeft: 5 } : { state: "wait", triesLeft: 0 },
  });
  const set = (opens: boolean, available = "ok") => (pinState.current = look(opens, available));
  // the bar also looks at the lock screen's view for Touch ID / Windows Hello (openView's `device`; PRF-NOTES.md): none here
  const openView = vi.fn(async () => ({ state: "locked" }));
  async function mount() {
    const ctx = {
      rt: { service: { unlockWithPassword: vi.fn(), openView } },
      status: { state: "locked" },
      vault: null,
      reload: vi.fn(async () => undefined),
    };
    await act(async () => render(h(UnlockBar, { ctx } as never), root as unknown as Element));
    await settle();
  }

  it("a live PIN: the PIN's field, and no line, also after 'Use master password'", async () => {
    set(true);
    await mount();
    expect(byId("unlock-pin")).not.toBeNull();
    expect(byId("unlock-pin-waiting")).toBeNull();
    await act(async () => void byId("unlock-switch")!.dispatch("click"));
    expect(byId("unlock-pw")).not.toBeNull();
    expect(byId("unlock-pin-waiting")).toBeNull(); // the PIN works: it waits for nothing
  });

  it("a PIN set up whose record waits for the master password: the line; in a shared profile: none", async () => {
    set(false);
    await mount();
    expect(byId("unlock-pw")).not.toBeNull();
    expect(byId("unlock-pin-waiting")!.textContent).toBe("The PIN works again once you type the master password.");
    act(() => render(null, root as unknown as Element));
    set(false, "shared");
    await mount();
    expect(byId("unlock-pin-waiting")).toBeNull();
  });

  it("an older look answering after a newer one is dropped: it never puts back a PIN that has ended", async () => {
    const answers: ((v: unknown) => void)[] = [];
    pinState.next = () => new Promise((r) => answers.push(r));
    const ctx = (status: string) => ({
      rt: { service: { unlockWithPassword: vi.fn(), openView } },
      status: { state: status },
      vault: null,
      reload: vi.fn(async () => undefined),
    });
    const first = ctx("locked");
    await act(async () => render(h(UnlockBar, { ctx: first } as never), root as unknown as Element));
    // the page's status changes (another page locked it again): a second look, while the first is still out
    await act(async () =>
      render(h(UnlockBar, { ctx: { ...first, status: { state: "locked" } } } as never), root as unknown as Element),
    );
    expect(answers).toHaveLength(2);
    const armed = look(true);
    const ended = look(false);
    await act(async () => answers[1]!(ended)); // the newer answer: the PIN waits for the master password
    await settle();
    expect(byId("unlock-pin-waiting")).not.toBeNull();
    await act(async () => answers[0]!(armed)); // the older one, late: dropped
    await settle();
    expect(byId("unlock-pin")).toBeNull();
    expect(byId("unlock-pw")).not.toBeNull();
    expect(byId("unlock-pin-waiting")).not.toBeNull();
    delete pinState.next;
  });

  it("the master password typed in the bar: the PIN's note (the service and the kit) for a record that waits, is paused or opens, waited for before the page reloads; none without a PIN (review of PINONE, PO-02, PO-07)", async () => {
    for (const restart of [
      { state: "wait", triesLeft: 0 },
      { state: "paused", triesLeft: 5 },
      { state: "pin", triesLeft: 5 },
    ]) {
      const order: string[] = [];
      let release: () => void = () => undefined;
      const note = vi.fn((..._: unknown[]) => {
        order.push("note");
        return new Promise<void>((r) => (release = r));
      });
      pinSteps.note = note;
      pinState.current = { available: "ok", pin: { digits: 6 }, restart };
      const unlockWithPassword = vi.fn(async () => ({ view: { state: "unlocked" } }));
      const service = { unlockWithPassword, openView };
      const reload = vi.fn(async () => void order.push("reload"));
      const ctx = { rt: { service }, status: { state: "locked" }, vault: null, reload };
      await act(async () => render(h(UnlockBar, { ctx } as never), root as unknown as Element));
      await settle();
      if (restart.state === "pin") await act(async () => void byId("unlock-switch")!.dispatch("click"));
      await act(async () => {
        const f = byId("unlock-pw")!;
        f.value = OWN;
        f.dispatch("input", { inputType: "insertText" });
      });
      await act(async () => void form().dispatch("submit"));
      await settle();
      expect(unlockWithPassword, restart.state).toHaveBeenCalledWith(OWN);
      expect(note.mock.calls, restart.state).toHaveLength(1);
      expect(note.mock.calls[0]![0], restart.state).toBe(service);
      expect(note.mock.calls[0]!.length, restart.state).toBe(2);
      expect(order, restart.state).toEqual(["note"]); // the page waits for it
      await act(async () => release());
      await settle();
      expect(order, restart.state).toEqual(["note", "reload"]);
      act(() => render(null, root as unknown as Element));
    }
    // no PIN set up: no note
    const note = vi.fn(async (..._: unknown[]) => undefined);
    pinSteps.note = note;
    pinState.current = { available: "ok", pin: null };
    const service = { unlockWithPassword: vi.fn(async () => ({ view: { state: "unlocked" } })), openView };
    await act(async () =>
      render(
        h(UnlockBar, { ctx: { rt: { service }, status: { state: "locked" }, vault: null, reload: vi.fn() } } as never),
        root as unknown as Element,
      ),
    );
    await settle();
    await act(async () => {
      const f = byId("unlock-pw")!;
      f.value = OWN;
      f.dispatch("input", { inputType: "insertText" });
    });
    await act(async () => void form().dispatch("submit"));
    await settle();
    expect(service.unlockWithPassword).toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("the 5th wrong PIN here: the line at once, without a reload", async () => {
    set(true);
    const unlock = vi.fn(async (..._: unknown[]) => {
      set(false); // what the service now says: the PIN is set up, its record's key is off the disk
      return { ok: false, reason: "exhausted" };
    });
    pinSteps.unlock = unlock;
    await mount();
    await act(async () => {
      const pin = byId("unlock-pin")!;
      pin.value = "135792";
      pin.dispatch("input", { inputType: "insertText" });
    });
    await submit();
    expect(unlock.mock.calls[0]![1]).toBe("135792");
    expect(byId("unlock-pw")).not.toBeNull();
    expect(byId("unlock-pin-waiting")).not.toBeNull();
  });
});
