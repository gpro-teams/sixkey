// The grouped input (src/ui/PasswordGroups.tsx) and the popup's lock screen (src/popup/screens/Locked.tsx) rendered by
// Preact into a minimal document (test/helpers/mini-dom.ts), events dispatched as a browser would: what the component
// hands the page, and what the lock screen sends to the unlock (docs/design/notes/PASSWORD-SETUP-NOTES.md §8.2, §8.3).
// The real browser, its caret and its clipboard are pw-entry.spec.ts's.
import fc from "fast-check";
import { h, render, type ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatedForm } from "../../src/core/crypto/password-candidates";
import { ServiceError } from "../../src/core/service/service-error";
import type { PopupRuntime } from "../../src/platform/runtime-base";
import { Locked } from "../../src/popup/screens/Locked";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice } from "../../src/ui/i18n";
import { codeSymbols, PasswordGroups } from "../../src/ui/PasswordGroups";
import { installMiniDom, type MiniDocument, type MiniElement } from "../helpers/mini-dom";

vi.mock("../../src/popup/chrome", () => ({
  Frame: (p: { children: ComponentChildren }) => p.children,
  openOptions: vi.fn(),
}));
// what the PIN offers on the lock screen (pin-restart-count.ts restartOffer, from the view's read): set by a test
const pin = vi.hoisted(() => ({ offer: null as unknown }));
vi.mock("../../src/core/service/pin-restart-count", () => ({ restartOffer: () => pin.offer }));

const GEN = "JDXT-NBSG-6JQG-XBTV";
const CODE = GEN.replace(/-/g, "");
const GROUPS = ["JDXT", "NBSG", "6JQG", "XBTV"];

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
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
});
afterAll(() => vi.restoreAllMocks());

const inputs = () => root.all((e) => e.localName === "input");
const groups = () => inputs().map((b) => b.value);
const showButton = () => root.all((e) => e.localName === "button" && e.getAttribute("aria-pressed") !== null)[0];

/** A key typed as a browser types it: keydown, and unless that is prevented, the character in and an input event. */
function type(box: MiniElement, ch: string) {
  act(() => {
    const down = box.dispatch("keydown", { key: ch, isComposing: false });
    if (down.defaultPrevented) return;
    const a = box.selectionStart ?? box.value.length;
    const b = box.selectionEnd ?? a;
    box.value = box.value.slice(0, a) + ch + box.value.slice(b);
    box.setSelectionRange(a + ch.length, a + ch.length);
    box.dispatch("input", { isComposing: false, inputType: "insertText", data: ch });
  });
}
/** Keys typed one by one into whatever box has the focus. */
function typeAll(text: string) {
  for (const ch of text) type(doc.activeElement!, ch);
}
/** A key the component may take (Backspace, the arrows); unless prevented, the browser's own step inside the box. */
function press(box: MiniElement, key: string, mods: Record<string, boolean> = {}) {
  act(() => {
    const down = box.dispatch("keydown", { key, isComposing: false, ...mods });
    if (down.defaultPrevented) return;
    const a = box.selectionStart ?? 0;
    if (key === "Backspace" && a > 0) {
      box.value = box.value.slice(0, a - 1) + box.value.slice(a);
      box.setSelectionRange(a - 1, a - 1);
      box.dispatch("input", { isComposing: false, inputType: "deleteContentBackward" });
    } else if (key === "ArrowLeft") box.setSelectionRange(Math.max(0, a - 1), Math.max(0, a - 1));
    else if (key === "ArrowRight")
      box.setSelectionRange(Math.min(box.value.length, a + 1), Math.min(box.value.length, a + 1));
  });
}
/** A paste of `text`; the event, to see whether the component took it (it always prevents the browser's own). */
function paste(box: MiniElement, text: string) {
  let e!: ReturnType<MiniElement["dispatch"]>;
  act(() => {
    box.focus();
    e = box.dispatch("paste", { clipboardData: { getData: () => text } });
  });
  return e;
}

describe("the grouped input in a page (src/ui/PasswordGroups.tsx)", () => {
  let seen: string[];
  let setOuter: (v: string) => void;
  function mount(extra: { showable?: boolean } = {}) {
    seen = [];
    function Page() {
      const [v, setV] = useState("");
      setOuter = setV;
      return h(PasswordGroups, {
        id: "pw",
        label: "Master password",
        labelledBy: "pw-label",
        value: v,
        onValue: (x: string) => {
          seen.push(x);
          setV(x);
        },
        ...extra,
      });
    }
    act(() => render(h(Page, {}), root as unknown as Element));
    act(() => inputs()[0]!.focus());
  }

  it("hands the page the generator's spelling, hyphens and all, whether typed in lower case or pasted (one key derivation at the unlock)", () => {
    mount();
    typeAll(CODE.toLowerCase());
    expect(groups()).toEqual(GROUPS);
    expect(seen.at(-1)).toBe(GEN); // not the bare symbols: the exact spelling, which opens with one derivation
    expect(doc.activeElement).toBe(inputs()[3]);
    act(() => setOuter(""));
    expect(groups()).toEqual(["", "", "", ""]);
    for (const text of [
      GEN.toLowerCase(),
      CODE.toLowerCase(),
      " jdxt nbsg\t6jqg xbtv\n",
      "ｊｄｘｔ-ｎｂｓｇ-６ｊｑｇ-ｘｂｔｖ",
    ]) {
      const e = paste(inputs()[2]!, text);
      expect(e.defaultPrevented, text).toBe(true);
      expect(groups(), text).toEqual(GROUPS);
      expect(seen.at(-1), text).toBe(GEN);
    }
  });

  it("a part goes in at the caret; a paste or key the plain field's check would refuse is refused, the boxes as they were", () => {
    mount();
    typeAll("jdxtnb");
    expect(paste(inputs()[1]!, "sg").defaultPrevented).toBe(true);
    expect(groups()).toEqual(["JDXT", "NBSG", "", ""]);
    const before = groups();
    const n = seen.length;
    for (const bad of [
      GEN.replace(/-/g, "\u2010"), // hyphen
      GEN.replace(/-/g, "\u2011"), // non-breaking hyphen
      GEN.replace(/-/g, "\u2013"), // en dash
      GEN.replace(/-/g, "\u2212"), // minus
      GEN.replace(/-/g, "\u200b"), // zero-width space
      GEN.replace(/-/g, "\u200d"), // zero-width joiner
      GEN + "-EXTRA", // more than 16
      `Password: ${GEN}`,
      "6jqg\u200bxbtv", // a part with a zero-width space
      "6JQGXBTVA", // a part that makes 17
    ]) {
      const e = paste(inputs()[2]!, bad);
      expect(e.defaultPrevented, bad).toBe(true); // nothing goes in by the browser's own paste either
      expect(groups(), bad).toEqual(before);
    }
    expect(seen.length).toBe(n);
    // keys: what the generator never makes, and a dash that is not "-", do nothing
    for (const ch of ["I", "l", "O", "0", "1", "\u2013", "\u200b"]) type(doc.activeElement!, ch);
    expect(groups()).toEqual(before);
    expect(seen.at(-1)).toBe("JDXT-NBSG"); // put back as it was
    // a typed "-" or space is a separator, as in the plain field: left out
    typeAll("- 6");
    expect(groups()).toEqual(["JDXT", "NBSG", "6", ""]);
    // full: a 17th symbol is refused, not pushed in with the last one dropped
    typeAll("jqgxbtv");
    expect(groups()).toEqual(GROUPS);
    act(() => inputs()[1]!.setSelectionRange(2, 2));
    type(inputs()[1]!, "a");
    expect(groups()).toEqual(GROUPS);
    expect(seen.at(-1)).toBe(GEN);
  });

  it("takes and refuses exactly what the plain field's check does (generatedForm), for any text", () => {
    const parts = [
      "jdxt",
      "NBSG",
      "6jqg",
      "xbtv",
      "-",
      " ",
      "\t",
      "\u2010",
      "\u2013",
      "\u200b",
      "\ufeff",
      "\u00a0",
      "I",
      "0",
      "ａ",
      "Z",
      "9",
      "ß",
      "ı",
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...parts), { maxLength: 12 }), (bits) => {
        const text = bits.join("");
        const plain = generatedForm(text);
        const whole = codeSymbols(text)?.length === 16;
        // a whole code for the boxes exactly when the plain field's check finds the 16-symbol shape (words aside)
        if (plain?.format !== "gen5words-v1") expect(whole, JSON.stringify(text)).toBe(plain?.format === "gen16-v1");
        if (whole && plain) expect(codeSymbols(text)).toBe(plain.canonical.replace(/-/g, ""));
      }),
      { numRuns: 3000 },
    );
  });

  it("Backspace at a box's start and the arrows at its edges cross into the box beside, as in one field", () => {
    mount();
    typeAll("jdxtn");
    const [b1, b2, b3] = inputs();
    expect(doc.activeElement).toBe(b2);
    press(b2!, "Backspace");
    press(b2!, "Backspace");
    expect(groups()).toEqual(["JDX", "", "", ""]);
    expect(doc.activeElement).toBe(b1);
    typeAll("tnbsg6");
    expect(doc.activeElement).toBe(b3);
    // left from the start of box 3: before the last symbol of box 2
    act(() => b3!.setSelectionRange(0, 0));
    press(b3!, "ArrowLeft");
    expect([doc.activeElement, b2!.selectionStart]).toEqual([b2, 3]);
    press(b2!, "ArrowRight"); // inside the box: the browser's
    expect([doc.activeElement, b2!.selectionStart]).toEqual([b2, 4]);
    press(b2!, "ArrowRight"); // the edge: after the first symbol of box 3, no press spent on the same place
    expect([doc.activeElement, b3!.selectionStart]).toEqual([b3, 1]);
    press(b3!, "ArrowLeft", { shiftKey: true }); // with a modifier: the browser's
    expect(doc.activeElement).toBe(b3);
    expect(groups()).toEqual(["JDXT", "NBSG", "6", ""]);
  });

  it("Show: off at first, and off again whenever the value is emptied (a lock elsewhere, a step done)", () => {
    mount();
    typeAll("jdxt");
    act(() => void showButton()!.dispatch("click"));
    expect(inputs().map((b) => b.type)).toEqual(["text", "text", "text", "text"]);
    expect(showButton()!.getAttribute("aria-pressed")).toBe("true");
    act(() => setOuter(""));
    expect(inputs().map((b) => b.type)).toEqual(["password", "password", "password", "password"]);
    expect(showButton()!.getAttribute("aria-pressed")).toBe("false");
    // and the page going away empties it
    typeAll("jd");
    act(() => void dom.page.dispatch("pagehide"));
    expect(seen.at(-1)).toBe("");
  });

  it("showable={false}: no Show button at all, every box masked", () => {
    mount({ showable: false });
    typeAll(CODE);
    expect(showButton()).toBeUndefined();
    expect(root.all((e) => e.localName === "button")).toEqual([]);
    expect(inputs().map((b) => [b.type, b.getAttribute("autocomplete")])).toEqual(Array(4).fill(["password", "off"]));
  });

  it("an input method composing is left alone; what it commits is taken at compositionend", () => {
    mount();
    typeAll("jd");
    const b1 = inputs()[0]!;
    const n = seen.length;
    // the browser shows the composition in the box; the component must not rewrite it under the input method
    for (const comp of ["x", "xt", "xtn"]) {
      act(() => {
        b1.value = "JD" + comp;
        b1.dispatch("input", { isComposing: true, inputType: "insertCompositionText", data: comp });
      });
      expect(b1.value).toBe("JD" + comp);
      const down = b1.dispatch("keydown", { key: "Backspace", isComposing: true });
      expect(down.defaultPrevented).toBe(false);
    }
    expect(seen.length).toBe(n);
    act(() => void b1.dispatch("compositionend", { data: "xtn" }));
    expect(groups()).toEqual(["JDXT", "N", "", ""]);
    expect(seen.at(-1)).toBe("JDXT-N");
    // a key pressed while composing is the input method's, even one the boxes would take (Backspace at a box's start)
    const b2 = inputs()[1]!;
    act(() => b2.setSelectionRange(0, 0));
    expect(b2.dispatch("keydown", { key: "Backspace", isComposing: true }).defaultPrevented).toBe(false);
    expect(groups()).toEqual(["JDXT", "N", "", ""]);
    let taken = false;
    act(() => {
      taken = b2.dispatch("keydown", { key: "Backspace", isComposing: false }).defaultPrevented;
    });
    expect(taken).toBe(true); // not composing: the boxes take it
    expect(groups()).toEqual(["JDXN", "", "", ""]);
    typeAll("t");
    expect(groups()).toEqual(["JDXT", "N", "", ""]);
    // a committed word with nothing of the code in it is refused: the boxes as before the composition
    act(() => {
      inputs()[1]!.value = "N进行";
      void inputs()[1]!.dispatch("compositionend", { data: "进行" });
    });
    expect(groups()).toEqual(["JDXT", "N", "", ""]);
  });
});

describe("the popup's lock screen (src/popup/screens/Locked.tsx)", () => {
  function runtime(open: (pw: string) => boolean) {
    const unlockWithPassword = vi.fn(async (pw: string) => {
      if (open(pw)) return { view: { state: "unlocked" } };
      throw new ServiceError("wrong_secret");
    });
    return {
      rt: {
        service: { unlockWithPassword, unlockWithRecoveryCode: vi.fn() },
      } as unknown as PopupRuntime,
      unlockWithPassword,
    };
  }
  async function mount(props: Record<string, unknown>, open: (pw: string) => boolean = () => false) {
    const r = runtime(open);
    const onUnlocked = vi.fn(async () => undefined);
    await act(async () => render(h(Locked, { rt: r.rt, onUnlocked, ...props } as never), root as unknown as Element));
    return { ...r, onUnlocked };
  }
  const form = () => root.all((e) => e.localName === "form")[0]!;
  async function submit() {
    await act(async () => void form().dispatch("submit"));
  }
  const err = () => root.all((e) => e.getAttribute("role") === "alert");

  it("under a 16-symbol hint: the boxes, never showable, named by the screen's label; they send the generator's spelling", async () => {
    const { unlockWithPassword, onUnlocked } = await mount({ format: "gen16-v1" }, (pw) => pw === GEN);
    expect(inputs().map((b) => b.id)).toEqual(["secret", "secret-2", "secret-3", "secret-4"]);
    expect(showButton()).toBeUndefined(); // the master password is never shown in the popup
    expect(inputs().every((b) => b.type === "password" && b.getAttribute("autocomplete") === "off")).toBe(true);
    const group = root.all((e) => e.getAttribute("role") === "group")[0]!;
    expect(group.getAttribute("aria-labelledby")).toBe("lock-label");
    expect(root.byId("lock-label")!.textContent).toMatch(/Master password/);
    expect(doc.activeElement).toBe(inputs()[0]);
    paste(inputs()[1]!, CODE.toLowerCase());
    await submit();
    expect(unlockWithPassword).toHaveBeenCalledTimes(1);
    expect(unlockWithPassword).toHaveBeenCalledWith(GEN); // the exact spelling: one key derivation
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("a wrong try marks the boxes; the plain field, one click away, clears the error and the value and takes the focus", async () => {
    const { unlockWithPassword } = await mount({ format: "gen16-v1" });
    paste(inputs()[0]!, CODE.replace(/.$/, "A").toLowerCase());
    await submit();
    expect(err()).toHaveLength(1);
    expect(inputs().map((b) => b.getAttribute("aria-invalid"))).toEqual(["true", "true", "true", "true"]);
    await act(async () => void root.byId("secret-plain")!.dispatch("click"));
    expect(err()).toEqual([]);
    expect(inputs()).toHaveLength(1);
    const plain = inputs()[0]!;
    expect([plain.id, plain.type, plain.value, plain.getAttribute("aria-invalid")]).toEqual([
      "secret",
      "password",
      "",
      null,
    ]);
    expect(doc.activeElement).toBe(plain);
    expect(root.byId("secret-plain")).toBeNull();
    // the plain field sends what is typed, as before: the unlock's tolerance takes it loosely
    act(() => {
      plain.value = "jdxt nbsg 6jqg xbtv";
      plain.dispatch("input");
    });
    await submit();
    expect(unlockWithPassword).toHaveBeenLastCalledWith("jdxt nbsg 6jqg xbtv");
  });

  it("no hint, a words hint: the plain field as before, masked, no way to show it", async () => {
    for (const format of [undefined, "gen5words-v1"]) {
      await mount(format ? { format } : {});
      expect(inputs().map((b) => [b.id, b.type, b.getAttribute("autocomplete")])).toEqual([
        ["secret", "password", "off"],
      ]);
      expect(root.byId("secret-plain")).toBeNull();
      expect(root.byId("secret-show")).toBeNull();
      act(() => render(null, root as unknown as Element));
    }
  });

  it("the PIN and the recovery code keep their own fields; the boxes come with the master password only", async () => {
    pin.offer = { state: "pin", field: { digits: 6, triesLeft: 5 } }; // a PIN whose record opens Sixkey
    await mount({ format: "gen16-v1" });
    pin.offer = null;
    expect(inputs().map((b) => [b.id, b.type, b.getAttribute("inputmode") ?? b.getAttribute("inputMode")])).toEqual([
      ["pin", "password", "numeric"],
    ]);
    await act(async () => void root.byId("use-password")!.dispatch("click"));
    expect(inputs().map((b) => b.id)).toEqual(["secret", "secret-2", "secret-3", "secret-4"]);
    const recovery = root.all((e) => e.localName === "button" && /recovery key/i.test(e.textContent))[0]!;
    await act(async () => void recovery.dispatch("click"));
    expect(inputs().map((b) => [b.id, b.type])).toEqual([
      ["secret", "password"],
      ["secret-show", "checkbox"],
    ]);
    const show = root.byId("secret-show")!;
    act(() => {
      show.checked = true;
      show.dispatch("change");
    });
    expect(root.byId("secret")!.type).toBe("text"); // the recovery code only, read off paper
  });
});
