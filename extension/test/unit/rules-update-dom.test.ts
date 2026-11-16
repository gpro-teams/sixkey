// Settings › Security › Autofill's "Get the latest site rules" (TOTP autofill Stage 3, AF3-U2 round 2: the review's S1,
// the maintainers' C34; src/options/RulesUpdate.tsx), drawn by Preact into a minimal document (test/helpers/mini-dom.ts)
// over a stand-in of the worker's answers to `sk-af-rules-status`: each answer, a failure (null: what the worker answers
// when its work failed) or a rejected message (the worker restarted, the channel closed), or one held until the test
// lets it go. What the box and the status line show is the worker's last real answer, never a guess, and the switch never
// goes away once drawn: a turn that gets no answer asks the status again and shows it (or, unanswered again, what was
// shown before the click) with a line that it did not go through, cleared by the next answered turn; turning it on shows
// "Checking…" while the worker checks, the box disabled; a first read that fails is tried once more, and a second failure
// draws the switch disabled with a line to reload. The real page is rules-update.spec.ts's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDate, setLangChoice } from "../../src/ui/i18n";
import { installMiniDom, type MiniElement } from "../helpers/mini-dom";

const EN = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../catalogs/rules-en.json"), "utf8")) as Record<
  string,
  { message: string }
>;
const say = (k: string, ...subs: (string | number)[]) =>
  subs.reduce<string>((s, v, i) => s.replace(`$${i + 1}`, String(v)), EN[k]!.message);

type Status = { on: boolean; v: number | null; got: number | null; base: number; floor: number | null; host: string };
const GOT = Date.UTC(2026, 10, 6, 9, 0, 0);
const OFF: Status = { on: false, v: null, got: null, base: 1, floor: null, host: "rules.example.net" };
const ON2: Status = { on: true, v: 2, got: GOT, base: 1, floor: null, host: "rules.example.net" };

/** What the worker does with the next message: answers it, fails it (null), rejects it, or holds it. */
type Step = { answer: Status | null } | { reject: true } | { hold: Promise<Status | null> };
let steps: Step[];
let sent: unknown[];
let Rules: typeof import("../../src/options/RulesUpdate");
let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
beforeAll(async () => {
  setLangChoice("en");
  Rules = await import("../../src/options/RulesUpdate");
  await Rules.prepare();
});
beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body;
  steps = [];
  sent = [];
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: (m: unknown) => {
        sent.push(m);
        const s = steps.shift();
        if (!s) return new Promise(() => undefined); // nothing scripted: never answered
        if ("reject" in s) return Promise.reject(new Error("The message port closed before a response was received."));
        if ("hold" in s) return s.hold;
        return Promise.resolve(s.answer);
      },
    },
  });
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.unstubAllGlobals();
});
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((r) => setTimeout(r, 2)));
};
async function mount(...first: Step[]) {
  steps.push(...first);
  act(() => render(h(Rules.RulesUpdate, {}), root as unknown as Element));
  await settle();
}
const box = () => root.byId("ru-on");
const status = () => root.byId("ru-status")?.textContent ?? null;
const failed = () => root.byId("ru-failed")?.textContent ?? null;
async function click(next: Step[]) {
  steps.push(...next);
  const b = box()!;
  b.checked = !b.checked;
  act(() => void b.dispatch("change"));
  await settle();
}
/** The box and the line as a person sees them. */
const shown = () => ({ drawn: box() !== null, checked: box()?.checked, disabled: box()?.disabled, status: status() });

describe("the switch shows the worker's last real answer, and never goes away", () => {
  it("drawn from the status: off, the built-in rules, the server's host in the lead", async () => {
    await mount({ answer: OFF });
    expect(shown()).toEqual({ drawn: true, checked: false, disabled: false, status: say("ruBuiltIn", 1) });
    expect(root.textContent).toContain(say("ruLead", "rules.example.net"));
    expect(failed()).toBeNull();
    expect(sent).toEqual([{ type: "sk-af-rules-status" }]);
  });
  it("on, slow: checked and disabled, “Checking…” in the status line; then the worker's answer", async () => {
    let answer!: (s: Status) => void;
    await mount({ answer: OFF });
    await click([{ hold: new Promise((r) => (answer = r)) }]);
    expect(sent.at(-1)).toEqual({ type: "sk-af-rules-status", on: true });
    expect(shown()).toEqual({ drawn: true, checked: true, disabled: true, status: say("ruChecking") });
    answer(ON2);
    await settle();
    expect(shown()).toEqual({
      drawn: true,
      checked: true,
      disabled: false,
      status: say("ruUpdated", formatDate(GOT), 2),
    });
    expect(failed()).toBeNull();
  });
  it("off answered null (the worker's work failed), the status asked again: what the worker says (still on), and the line", async () => {
    await mount({ answer: ON2 });
    await click([{ answer: null }, { answer: ON2 }]);
    expect(sent.slice(1)).toEqual([{ type: "sk-af-rules-status", on: false }, { type: "sk-af-rules-status" }]);
    expect(shown()).toEqual({
      drawn: true,
      checked: true,
      disabled: false,
      status: say("ruUpdated", formatDate(GOT), 2),
    });
    expect(failed()).toBe(say("ruFailed"));
  });
  it("off rejected, and the status cannot be read again: what was shown before the click, and the line", async () => {
    await mount({ answer: ON2 });
    await click([{ reject: true }, { reject: true }]);
    expect(shown()).toEqual({
      drawn: true,
      checked: true,
      disabled: false,
      status: say("ruUpdated", formatDate(GOT), 2),
    });
    expect(failed()).toBe(say("ruFailed"));
  });
  it("off answered null, and the status says it is off after all: off; the line until the next answered turn", async () => {
    await mount({ answer: ON2 });
    await click([{ answer: null }, { answer: OFF }]);
    expect(shown()).toEqual({ drawn: true, checked: false, disabled: false, status: say("ruBuiltIn", 1) });
    expect(failed()).toBe(say("ruFailed"));
    await click([{ answer: ON2 }]);
    expect(shown()).toEqual({
      drawn: true,
      checked: true,
      disabled: false,
      status: say("ruUpdated", formatDate(GOT), 2),
    });
    expect(failed()).toBeNull();
  });
  it("on rejected, then the status answers off: off, and the line (never the click's guess)", async () => {
    await mount({ answer: OFF });
    await click([{ reject: true }, { answer: OFF }]);
    expect(shown()).toEqual({ drawn: true, checked: false, disabled: false, status: say("ruBuiltIn", 1) });
    expect(failed()).toBe(say("ruFailed"));
  });
  it("an answer of another shape is no answer", async () => {
    await mount({ answer: ON2 });
    await click([{ answer: { nonsense: 1 } as unknown as Status }, { answer: ON2 }]);
    expect(shown().checked).toBe(true);
    expect(failed()).toBe(say("ruFailed"));
  });
  it("after off and on again with a floor: “Waiting for a version newer than 2” once the check is over, not during it", async () => {
    let answer!: (s: Status) => void;
    await mount({ answer: OFF });
    await click([{ hold: new Promise((r) => (answer = r)) }]);
    expect(root.byId("ru-wait")).toBeNull();
    answer({ ...OFF, on: true, floor: 2 });
    await settle();
    expect(root.byId("ru-wait")?.textContent).toBe(say("ruWaiting", 2));
    expect(status()).toBe(say("ruBuiltIn", 1));
  });
});

describe("the first read", () => {
  it("fails once: tried again, and drawn", async () => {
    await mount({ answer: null }, { answer: OFF });
    expect(sent).toHaveLength(2);
    expect(shown()).toEqual({ drawn: true, checked: false, disabled: false, status: say("ruBuiltIn", 1) });
  });
  it("fails twice (null, rejected): the title with the box disabled, and the line to reload; no lead", async () => {
    await mount({ answer: null }, { reject: true });
    expect(sent).toHaveLength(2);
    expect(shown()).toEqual({ drawn: true, checked: false, disabled: true, status: say("ruUnread") });
    expect(root.textContent).toContain(say("ruTitle"));
    expect(root.textContent).not.toContain("rules.example.net");
  });
  it("not answered yet: nothing drawn (the page shows nothing of it until the worker answers)", async () => {
    await mount();
    expect(box()).toBeNull();
  });
});
