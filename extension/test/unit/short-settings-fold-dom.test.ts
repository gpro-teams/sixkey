// The other folded boxes of the settings page (SHORT-SETTINGS-NOTES.md): Backup's "Export selected accounts" and
// "Encrypted backup" (their file passwords) and the PIN box (the master password and the PIN), rendered by Preact into
// a minimal document (test/helpers/mini-dom.ts). Closed, they hold no field; closing them (the button, Escape) or a
// lock drops what was typed; the PIN's state and "End quick unlock now" are in view while it is closed. Security's
// three forms: short-settings-dom.test.ts.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceStatus } from "../../src/core/service/service";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice } from "../../src/ui/i18n";
import { Backup } from "../../src/options/Backup";
import { PinBox } from "../../src/options/PinBox";
import { installMiniDom, type MiniDocument, type MiniElement } from "../helpers/mini-dom";

let quick: unknown = { available: "ok", pin: null };
vi.mock("../../src/core/service/pin-admin", () => ({
  PinAdmin: class {
    state = () => Promise.resolve(quick);
  },
}));
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
  (globalThis as Record<string, unknown>).chrome = {
    storage: { onChanged: { addListener() {}, removeListener() {} } },
    runtime: { sendMessage: () => Promise.resolve() },
  };
  quick = { available: "ok", pin: null };
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  delete (globalThis as Record<string, unknown>).chrome;
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
const escape = (id: string) => act(() => void byId(id)!.dispatch("keydown", { key: "Escape", stopPropagation() {} }));
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

const unlocked = { state: "unlocked", passwordProtected: true, events: [] } as unknown as ServiceStatus;
const locked = { state: "locked", events: [] } as unknown as ServiceStatus;
const vault = { schemaVersion: 1, vaultId: "v", entries: [] } as never;
const rt = {} as never;
const reload = () => Promise.resolve();

describe("Backup: Export selected accounts", () => {
  const put = (status: ServiceStatus) =>
    act(() =>
      render(
        h(Backup, { rt, status, vault: status.state === "unlocked" ? vault : null, reload, onSetup: () => undefined }),
        root as unknown as Element,
      ),
    );

  it("closed by default: no file password field", () => {
    put(unlocked);
    expect(byId("subset-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(byId("subset-pw")).toBeNull();
  });

  it("closing it drops the file password; so does Escape", () => {
    put(unlocked);
    click("subset-toggle");
    typeInto("subset-pw", "file password typed here");
    click("subset-toggle");
    expect(byId("subset-pw")).toBeNull();
    click("subset-toggle");
    expect(byId("subset-pw")!.value).toBe("");
    typeInto("subset-pw", "file password typed again");
    escape("subset-body");
    expect(byId("subset-pw")).toBeNull();
    click("subset-toggle");
    expect(byId("subset-pw")!.value).toBe("");
  });

  it("a hidden tab closes it and drops the file password", () => {
    const listeners: (() => void)[] = [];
    Object.assign(doc, {
      addEventListener: (_t: string, f: () => void) => void listeners.push(f),
      visibilityState: "visible",
    });
    put(unlocked);
    click("subset-toggle");
    typeInto("subset-pw", "file password typed here");
    (doc as unknown as { visibilityState: string }).visibilityState = "hidden";
    act(() => listeners.forEach((f) => f()));
    expect(byId("subset-pw")).toBeNull();
  });

  it("a lock closes it and drops the file password", () => {
    put(unlocked);
    click("subset-toggle");
    typeInto("subset-pw", "file password typed here");
    put(locked);
    expect(byId("subset-pw")).toBeNull();
    put(unlocked);
    expect(byId("subset-toggle")!.getAttribute("aria-expanded")).toBe("false");
    click("subset-toggle");
    expect(byId("subset-pw")!.value).toBe("");
  });
});

describe("Backup: Encrypted backup", () => {
  const put = (status: ServiceStatus) =>
    act(() =>
      render(
        h(Backup, { rt, status, vault: status.state === "unlocked" ? vault : null, reload, onSetup: () => undefined }),
        root as unknown as Element,
      ),
    );

  // one line until opened, as "Export selected accounts": the cloud backup's card is the leaf's first, and the leaf
  // stays within a screen and a half (BACKUP-VISUAL)
  it("closed by default: no file password field until opened", () => {
    put(unlocked);
    expect(byId("encrypted-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(byId("backup-pw")).toBeNull();
    expect(byId("export-encrypted")).toBeNull();
    click("encrypted-toggle");
    expect(byId("encrypted-toggle")!.getAttribute("aria-expanded")).toBe("true");
    expect(byId("backup-pw")).not.toBeNull();
    expect(byId("export-encrypted")).not.toBeNull();
  });

  it("closing it drops the file password; so does Escape", () => {
    put(unlocked);
    click("encrypted-toggle");
    typeInto("backup-pw", "file password typed here");
    typeInto("backup-pw2", "file password typed here");
    click("encrypted-toggle");
    expect(byId("backup-pw")).toBeNull();
    click("encrypted-toggle");
    expect(byId("backup-pw")!.value).toBe("");
    expect(byId("backup-pw2")!.value).toBe("");
    typeInto("backup-pw", "file password typed again");
    escape("encrypted-body");
    expect(byId("backup-pw")).toBeNull();
    click("encrypted-toggle");
    expect(byId("backup-pw")!.value).toBe("");
  });
});

describe("PIN quick unlock", () => {
  const put = async (status: ServiceStatus) => {
    act(() => render(h(PinBox, { rt, status, vault: null, reload }), root as unknown as Element));
    await settle();
  };

  it("closed by default: no field; opening shows its lead and the form", async () => {
    await put(unlocked);
    expect(byId("pin-box-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(byId("pin-pw")).toBeNull();
    click("pin-box-toggle");
    expect(byId("pin-box")!.textContent).toContain("A PIN of 4 to 8 digits");
    expect(byId("pin-pw")).not.toBeNull();
    expect(byId("pin-new")).not.toBeNull();
  });

  it("a hidden tab closes it and drops what was typed", async () => {
    const listeners: (() => void)[] = [];
    Object.assign(doc, {
      addEventListener: (_t: string, f: () => void) => void listeners.push(f),
      visibilityState: "visible",
    });
    await put(unlocked);
    click("pin-box-toggle");
    typeInto("pin-pw", "master password typed here");
    (doc as unknown as { visibilityState: string }).visibilityState = "hidden";
    act(() => listeners.forEach((f) => f()));
    expect(byId("pin-pw")).toBeNull();
    (doc as unknown as { visibilityState: string }).visibilityState = "visible";
    click("pin-box-toggle");
    expect(byId("pin-pw")!.value).toBe("");
  });

  it("closing it, or Escape, drops the typed master password and PIN", async () => {
    await put(unlocked);
    click("pin-box-toggle");
    typeInto("pin-pw", "master password typed here");
    typeInto("pin-new", "246813");
    click("pin-box-toggle");
    click("pin-box-toggle");
    expect(byId("pin-pw")!.value).toBe("");
    expect(byId("pin-new")!.value).toBe("");
    typeInto("pin-new", "246813");
    escape("pin-box-body");
    expect(byId("pin-new")).toBeNull();
    click("pin-box-toggle");
    expect(byId("pin-new")!.value).toBe("");
  });

  it("a lock closes it and drops what was typed", async () => {
    await put(unlocked);
    click("pin-box-toggle");
    typeInto("pin-pw", "master password typed here");
    await put(locked);
    expect(byId("pin-pw")).toBeNull();
    await put(unlocked);
    expect(byId("pin-box-toggle")!.getAttribute("aria-expanded")).toBe("false");
    click("pin-box-toggle");
    expect(byId("pin-pw")!.value).toBe("");
  });

  it("what must stay in view is not behind the fold: the PIN's state and 'End quick unlock now'", async () => {
    quick = { available: "ok", pin: { digits: 6 }, restart: { state: "pin", triesLeft: 5 } }; // its record opens Sixkey
    await put(unlocked);
    expect(byId("pin-box-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(byId("pin-state")).not.toBeNull();
    expect(byId("quick-end")).not.toBeNull();
    expect(byId("pin-pw")).toBeNull();
  });

  it("a profile declared shared says why there is no PIN without opening anything", async () => {
    quick = { available: "shared", pin: null };
    await put(unlocked);
    expect(byId("pin-shared")).not.toBeNull();
  });
});
