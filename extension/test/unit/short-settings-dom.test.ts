// The folded boxes of the settings page (SHORT-SETTINGS-NOTES.md), rendered by Preact into a minimal document
// (test/helpers/mini-dom.ts): a closed box holds nothing, and whatever was typed in it is dropped when it closes (the
// button, Escape, another box opening) and when the page locks, as every other typed password on the page is. The real
// browser (focus, layout, the keyboard) is short-settings.spec.ts's.
import { h, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceStatus } from "../../src/core/service/service";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice } from "../../src/ui/i18n";
import { Fold } from "../../src/options/shared";
import type { KeyOps } from "../../src/options/key-ops";
import { SecurityKeys } from "../../src/options/Security";
import { installMiniDom, type MiniDocument, type MiniElement } from "../helpers/mini-dom";

// the boxes under the folds read the browser and the service; they are not what is tested here
vi.mock("../../src/options/PinBox", () => ({ PinBox: () => null }));
vi.mock("../../src/options/SecurityMode", () => ({ SecurityMode: () => null }));
vi.mock("../../src/options/SecurityCard", () => ({ SecurityCard: () => null }));
vi.mock("../../src/platform/runtime", async (orig) => ({
  ...(await orig<typeof import("../../src/platform/runtime")>()),
  passwordFormat: () => Promise.resolve(null),
}));

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
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
});
afterAll(() => vi.restoreAllMocks());

const byId = (id: string) => root.byId(id);
const click = (id: string) => act(() => void byId(id)!.dispatch("click"));
const typeInto = (id: string, v: string) =>
  act(() => {
    const el = byId(id)!;
    el.value = v;
    el.dispatch("input", { inputType: "insertText" });
  });
const submit = () => act(() => void root.all((e) => e.localName === "form")[0]!.dispatch("submit"));
const escape = (id: string) => act(() => void byId(id)!.dispatch("keydown", { key: "Escape", stopPropagation() {} }));

describe("Fold", () => {
  function mount(start = false) {
    const toggled: boolean[] = [];
    function Page() {
      const [open, setOpen] = useState(start);
      return h(
        Fold,
        {
          id: "f",
          icon: "key",
          title: "Title",
          open,
          onToggle: (on: boolean) => {
            toggled.push(on);
            setOpen(on);
          },
          note: h("p", { id: "note" }, "status"),
        } as never,
        h("input", { id: "inside", type: "password" }),
      );
    }
    act(() => render(h(Page, {}), root as unknown as Element));
    return () => toggled;
  }

  it("closed: the title as a button (aria-expanded false), its note, and nothing of the body", () => {
    mount();
    expect(byId("f-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(byId("f-toggle")!.getAttribute("aria-controls")).toBeNull();
    expect(byId("note")).not.toBeNull(); // a status never hides behind the fold
    expect(byId("inside")).toBeNull();
    expect(byId("f-body")).toBeNull();
  });

  it("the button opens and closes it; open: aria-expanded true and aria-controls names the body", () => {
    const toggled = mount();
    click("f-toggle");
    expect(byId("inside")).not.toBeNull();
    expect(byId("f-toggle")!.getAttribute("aria-expanded")).toBe("true");
    expect(byId("f-toggle")!.getAttribute("aria-controls")).toBe("f-body");
    click("f-toggle");
    expect(byId("inside")).toBeNull();
    expect(toggled()).toEqual([true, false]);
  });

  it("Escape inside closes it and puts the focus back on its button", () => {
    mount(true);
    act(() => byId("inside")!.focus());
    escape("f-body");
    expect(byId("inside")).toBeNull();
    expect(doc.activeElement).toBe(byId("f-toggle"));
  });

  it("any other key does nothing", () => {
    mount(true);
    act(() => void byId("f-body")!.dispatch("keydown", { key: "a", stopPropagation() {} }));
    expect(byId("inside")).not.toBeNull();
  });
});

describe("Security › Password and recovery: the forms", () => {
  const unlocked = { state: "unlocked", passwordProtected: true, events: [] } as unknown as ServiceStatus;
  const device = { state: "unlocked", passwordProtected: false, events: [] } as unknown as ServiceStatus;
  const locked = { state: "locked", events: [] } as unknown as ServiceStatus;
  const rt = {} as never;
  let calls: string[][];
  let error: string | null;
  const keysOf = (over: Partial<KeyOps> = {}): KeyOps => ({
    busy: false,
    code: null,
    error,
    info: null,
    clear: () => void calls.push(["clear"]),
    enable: async (pw) => (calls.push(["enable", pw]), true),
    change: async (o, pw) => (calls.push(["change", o, pw]), true),
    newCode: async (pw) => (calls.push(["newCode", pw as string]), true), // no PIN here: the master password
    rotate: async (pw) => (calls.push(["rotate", pw]), true),
    codeSaved: () => undefined,
    ...over,
  });
  const put = (status: ServiceStatus, keys: KeyOps = keysOf()) =>
    act(() =>
      render(
        h(SecurityKeys, { rt, status, vault: null, reload: () => Promise.resolve(), keys, syncOn: false }),
        root as unknown as Element,
      ),
    );
  beforeEach(() => {
    calls = [];
    error = null;
  });

  it("all three start closed: no password field is on the page", () => {
    put(unlocked);
    for (const f of ["fold-change", "fold-code", "fold-rotate"])
      expect(byId(`${f}-toggle`)!.getAttribute("aria-expanded"), f).toBe("false");
    for (const id of ["old-pw", "change-pw", "code-pw", "rot-pw"]) expect(byId(id), id).toBeNull();
  });

  it("closing the change form drops the typed passwords: opened again it is empty", () => {
    put(unlocked);
    click("fold-change-toggle");
    typeInto("old-pw", "old secret");
    typeInto("change-pw", "new secret that is long");
    expect(byId("old-pw")!.value).toBe("old secret");
    click("fold-change-toggle");
    click("fold-change-toggle");
    expect(byId("old-pw")!.value).toBe("");
    expect(byId("change-pw")!.value).toBe("");
  });

  it("Escape does the same, and an input method's Escape does not", () => {
    put(unlocked);
    click("fold-change-toggle");
    typeInto("old-pw", "old secret");
    act(
      () =>
        void byId("fold-change-body")!.dispatch("keydown", { key: "Escape", isComposing: true, stopPropagation() {} }),
    );
    expect(byId("old-pw")!.value).toBe("old secret"); // a composition's own Escape: nothing closes
    escape("fold-change-body");
    expect(byId("old-pw")).toBeNull();
    click("fold-change-toggle");
    expect(byId("old-pw")!.value).toBe("");
  });

  it("one form at a time: opening another closes the first and drops what was typed in it", () => {
    put(unlocked);
    click("fold-code-toggle");
    typeInto("code-pw", "master pw typed for a new code");
    click("fold-rotate-toggle");
    expect(byId("code-pw")).toBeNull();
    expect(byId("rot-pw")!.value).toBe("");
    click("fold-code-toggle");
    expect(byId("code-pw")!.value).toBe("");
    expect(byId("rot-pw")).toBeNull();
  });

  it("an answer of one form does not follow into another: opening a form clears what the last operation said", () => {
    error = "Wrong password";
    put(unlocked);
    click("fold-code-toggle");
    expect(calls).toEqual([["clear"]]);
    click("fold-rotate-toggle");
    expect(calls).toEqual([["clear"], ["clear"]]);
  });

  it("a lock closes the form and drops what was typed: unlocked again, it is closed and empty", () => {
    put(unlocked);
    click("fold-rotate-toggle");
    typeInto("rot-pw", "master pw typed for a new key");
    put(locked);
    expect(byId("rot-pw")).toBeNull();
    put(unlocked);
    expect(byId("fold-rotate-toggle")!.getAttribute("aria-expanded")).toBe("false");
    click("fold-rotate-toggle");
    expect(byId("rot-pw")!.value).toBe("");
  });

  it("a hidden tab closes the form too: nothing typed waits there for whoever sits down next", () => {
    const listeners: (() => void)[] = [];
    Object.assign(doc, {
      addEventListener: (_t: string, f: () => void) => void listeners.push(f),
      removeEventListener() {},
      visibilityState: "visible",
    });
    put(unlocked);
    click("fold-code-toggle");
    typeInto("code-pw", "master pw typed for a new code");
    (doc as unknown as { visibilityState: string }).visibilityState = "hidden";
    act(() => listeners.forEach((f) => f()));
    expect(byId("code-pw")).toBeNull();
    (doc as unknown as { visibilityState: string }).visibilityState = "visible";
    click("fold-code-toggle");
    expect(byId("code-pw")!.value).toBe("");
  });

  it("a form hands what was typed to the page's operation, and closes when it went through", async () => {
    put(unlocked);
    click("fold-code-toggle");
    typeInto("code-pw", "the master password");
    click("new-code");
    await act(() => Promise.resolve());
    expect(calls).toEqual([["clear"], ["newCode", "the master password"]]);
    expect(byId("code-pw")).toBeNull();
    click("fold-change-toggle");
    typeInto("old-pw", "the old one");
    typeInto("change-pw", "A brand new Strong#Pass1word");
    typeInto("change-pw2", "A brand new Strong#Pass1word");
    await act(() => new Promise<void>((r) => setTimeout(r, 50))); // the strength estimate answers
    submit();
    await act(() => Promise.resolve());
    expect(calls.at(-1)).toEqual(["change", "the old one", "A brand new Strong#Pass1word"]);
    expect(byId("old-pw")).toBeNull();
  });

  it("while a new recovery code waits (the page shows it), the forms are not offered", () => {
    put(unlocked, keysOf({ code: "AAAA-BBBB" }));
    expect(byId("fold-change-toggle")).toBeNull();
  });

  it("a device-key vault: the box that turns a master password on, its fields its own", async () => {
    put(device);
    typeInto("enable-pw", "A brand new Strong#Pass1word");
    typeInto("enable-pw2", "A brand new Strong#Pass1word");
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    submit();
    await act(() => Promise.resolve());
    expect(calls).toEqual([["enable", "A brand new Strong#Pass1word"]]);
    expect(byId("enable-pw")!.value).toBe(""); // went through: nothing left in the fields
  });
});
