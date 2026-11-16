// Recovery code shares on the pages (docs/design/notes/SHAMIR-NOTES.md §5), rendered by Preact into a minimal document
// (test/helpers/mini-dom.ts): the share entry (ui/ShareEntry.tsx) reads each share as it is typed and refuses a typo, a
// share of another set or the same share again; it hands the host the rebuilt code only with the set's threshold; it
// keeps nothing past a lock, the page going away, "Start again" or its own end. The settings page's recovery code input
// (options/RecoveryCodeInput.tsx) hands the code on as if typed. The wizard (options/ShareWizard.tsx) shows one share at a
// time, prints one share at a time, and switches only through the page's key operation once the test restore is done.
// The real browser is test/e2e/shares.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRecoveryCode } from "../../src/core/crypto/recovery-code";
import { makeShareSet, parseShare } from "../../src/core/crypto/shares";
import type { PreparedShares } from "../../src/core/service/service";
import { LOCK_EPOCH_KEY } from "../../src/platform/session";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice, t } from "../../src/ui/i18n";
import { sx } from "../../src/ui/share-text";
import { ShareEntry } from "../../src/ui/ShareEntry";
import type { KeyOps } from "../../src/options/key-ops";
import { installMiniDom, MiniElement, type MiniDocument } from "../helpers/mini-dom";

const downloads: { name: string; text: string }[] = [];
vi.mock("../../src/options/shared", async (orig) => ({
  ...(await orig<typeof import("../../src/options/shared")>()),
  download: (name: string, text: string) => void downloads.push({ name, text }),
}));
vi.mock("../../src/platform/runtime", async (orig) => ({
  ...(await orig<typeof import("../../src/platform/runtime")>()),
  passwordFormat: () => Promise.resolve(null),
}));

let dom: ReturnType<typeof installMiniDom>;
let doc: MiniDocument;
let root: MiniElement;
const g = globalThis as Record<string, unknown>;
let sessionListeners: ((c: Record<string, unknown>) => void)[];
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
  await sx.loaded;
});
beforeEach(() => {
  dom = installMiniDom();
  doc = dom.doc;
  root = doc.body;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  sessionListeners = [];
  g.chrome = {
    storage: {
      session: {
        onChanged: {
          addListener: (f: (c: Record<string, unknown>) => void) => sessionListeners.push(f),
          removeListener: (f: (c: Record<string, unknown>) => void) =>
            (sessionListeners = sessionListeners.filter((x) => x !== f)),
        },
      },
    },
  };
  downloads.length = 0;
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  delete g.chrome;
  delete g.window;
  delete g.print;
});

const byId = (id: string) => root.byId(id);
const click = (id: string) =>
  act(async () => {
    byId(id)!.dispatch("click");
    await ticks();
  });
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
};
const typeInto = (id: string, v: string) =>
  act(async () => {
    const el = byId(id)!;
    el.value = v;
    el.dispatch("input", { inputType: "insertText" });
    await ticks();
  });
const text = () => root.textContent;
/** Until `cond` holds (a lazy chunk, a catalog), at most 3 s. */
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await act(() => ticks(1));
  expect(cond()).toBe(true);
};
const R = Uint8Array.from({ length: 16 }, (_, i) => 3 * i + 1);

async function setOf(t = 2, n = 3, secret = R) {
  return makeShareSet(secret, t, n);
}

function mountEntry(o: Partial<Parameters<typeof ShareEntry>[0]> = {}) {
  const calls: [string, readonly string[]][] = [];
  const props = {
    id: "e",
    lockKey: LOCK_EPOCH_KEY,
    toCode: formatRecoveryCode,
    onCode: (c: string, typed: readonly string[]) => void calls.push([c, typed]),
    ...o,
  };
  act(() => render(h(ShareEntry, props), root as unknown as Element));
  return calls;
}

describe("the share entry", () => {
  it("each share is read as it is typed, leaves the field, and with the threshold the code goes to the host", async () => {
    const set = await setOf();
    const calls = mountEntry();
    expect(byId("e-in")!.type).toBe("password"); // masked until Show
    expect(byId("e-in")!.getAttribute("autoComplete")).toBe("off");
    expect(byId("e-in")!.getAttribute("name")).toBeNull();
    await typeInto("e-in", set.shares[2]!);
    expect(byId("e-in")!.value).toBe(""); // it left the field
    expect(byId("e-typed")!.textContent).toContain(
      sx("shEntryTyped", 3, (await parseShare(set.shares[2]!)).setId.toString(16).toUpperCase().padStart(4, "0")),
    );
    expect(byId("e-typed")!.getAttribute("data-sk-held")).toBe(""); // the side panel's wipe sees it
    expect(calls).toEqual([]); // not before the threshold
    await typeInto("e-in", set.shares[0]!.toLowerCase().replace(/-/g, " ")); // read as the recovery code is
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(await formatRecoveryCode(R));
    expect(calls[0]![1]).toHaveLength(2);
    expect(byId("e-rebuilt")).not.toBeNull();
    expect(byId("e-in")).toBeNull(); // no field once rebuilt
  });
  it("a typo, a share of another set, the same share again: refused, nothing handed over", async () => {
    const set = await setOf();
    const other = await setOf(
      2,
      3,
      Uint8Array.from({ length: 16 }, () => 9),
    );
    const calls = mountEntry();
    const s = set.shares[0]!;
    await typeInto("e-in", (s[0] === "2" ? "3" : "2") + s.slice(1));
    expect(byId("e-err")!.textContent).toBe(sx("shWrongCheck"));
    expect(byId("e-typed")).toBeNull();
    await typeInto("e-in", s);
    await typeInto("e-in", s);
    expect(byId("e-err")!.textContent).toBe(sx("shSame"));
    await typeInto("e-in", other.shares[1]!);
    expect(byId("e-err")!.textContent).toBe(sx("shDifferentSets"));
    await typeInto("e-in", "ABCD-EFGH");
    await act(async () => {
      byId("e-add")!.dispatch("click");
      await ticks();
    });
    expect(byId("e-err")!.textContent).toBe(sx("shLength"));
    expect(calls).toEqual([]);
  });
  it("with `set`, a share of another set (or threshold) is refused as it is typed, naming both sets (F2)", async () => {
    const mine = await setOf(2, 3);
    const older = await setOf(2, 3); // the same kind of paper, from an earlier set
    const id = (await parseShare(mine.shares[0]!)).setId;
    const oldId = (await parseShare(older.shares[0]!)).setId;
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
    const calls = mountEntry({ set: { setId: id, threshold: 2 }, want: [0, 2] });
    await typeInto("e-in", older.shares[0]!); // the right member, the wrong set
    expect(byId("e-err")!.textContent).toBe(sx("shEntryOtherSet", hex(oldId), hex(id)));
    expect(byId("e-typed")).toBeNull();
    const three = await setOf(3, 5);
    await typeInto("e-in", three.shares[0]!);
    expect(byId("e-err")!.textContent).toMatch(new RegExp(hex(id)));
    await typeInto("e-in", mine.shares[0]!);
    await typeInto("e-in", mine.shares[2]!);
    expect(calls).toHaveLength(1);
  });
  it("with `want`, another member is refused with which one to type", async () => {
    const set = await setOf(2, 3);
    const calls = mountEntry({ want: [0, 2] });
    expect(byId("e")!.textContent).toContain(sx("shEntryLabel", 1));
    await typeInto("e-in", set.shares[1]!);
    expect(byId("e-err")!.textContent).toBe(sx("shEntryOther", 2, 1));
    await typeInto("e-in", set.shares[0]!);
    expect(byId("e")!.textContent).toContain(sx("shEntryLabel", 3)); // the next one asked for
    await typeInto("e-in", set.shares[2]!);
    expect(calls).toHaveLength(1);
  });
  it("shares that do not fit together (a typo the check bits missed): refused", async () => {
    const a = await setOf(2, 3);
    // the same set id and threshold, another polynomial: two shares that read well and do not combine
    const p = await parseShare(a.shares[0]!);
    const { formatShare } = await import("../../src/core/crypto/shares");
    const forged = await formatShare({ setId: p.setId, threshold: 2, index: 1, value: new Uint8Array(16).fill(5) });
    const calls = mountEntry();
    await typeInto("e-in", a.shares[0]!);
    await typeInto("e-in", forged);
    expect(byId("e-err")!.textContent).toBe(sx("shNoFit"));
    expect(calls).toEqual([]);
  });
  it("a lock from any page, the page going away, Start again and its own end wipe everything, and tell the host", async () => {
    const set = await setOf(3, 5);
    for (const how of ["lock", "pagehide", "clear", "unmount"] as const) {
      const calls = mountEntry();
      await typeInto("e-in", set.shares[0]!);
      await act(async () => {
        const el = byId("e-in")!;
        el.value = set.shares[1]!.slice(0, 10); // half a share in the field
        el.dispatch("input", { inputType: "insertText" });
        await ticks();
      });
      expect(byId("e-typed")).not.toBeNull();
      await act(async () => {
        if (how === "lock") for (const f of sessionListeners) f({ [LOCK_EPOCH_KEY]: { newValue: 2 } });
        else if (how === "pagehide") dom.page.dispatch("pagehide");
        else if (how === "clear") byId("e-clear")!.dispatch("click");
        else render(null, root as unknown as Element);
        await ticks();
      });
      expect(calls.at(-1), how).toEqual(["", []]);
      if (how !== "unmount") {
        expect(byId("e-typed"), how).toBeNull();
        expect(byId("e-in")!.value, how).toBe("");
        expect(byId("e-show")!.checked, how).toBe(false);
      }
      act(() => render(null, root as unknown as Element));
    }
  });
  it("another key changing in session storage is not a lock", async () => {
    const set = await setOf();
    mountEntry();
    await typeInto("e-in", set.shares[0]!);
    await act(async () => {
      for (const f of sessionListeners) f({ sk_session: { newValue: 1 } });
      await ticks();
    });
    expect(byId("e-typed")).not.toBeNull();
  });
  it("the host says the rebuilt code is an old one: the entry says so (stale)", async () => {
    const set = await setOf();
    const calls = mountEntry();
    await typeInto("e-in", set.shares[0]!);
    await typeInto("e-in", set.shares[1]!);
    expect(calls).toHaveLength(1);
    act(() =>
      render(
        h(ShareEntry, {
          id: "e",
          lockKey: LOCK_EPOCH_KEY,
          toCode: formatRecoveryCode,
          onCode: () => undefined,
          stale: true,
        }),
        root as unknown as Element,
      ),
    );
    const id = (await parseShare(set.shares[0]!)).setId.toString(16).toUpperCase().padStart(4, "0");
    expect(byId("e-stale")!.textContent).toBe(sx("shStale", id)); // "may belong to an older code or another vault"
    expect(byId("e-stale")!.textContent).not.toMatch(/destroy|销毁/i); // never "destroy them" (F3)
  });
});

describe("the settings page's recovery code input", () => {
  it("I have shares instead: the rebuilt code reaches the host as its symbols, as if typed; back to the field empties it", async () => {
    const { RecoveryCodeInput } = await import("../../src/options/RecoveryCodeInput");
    const set = await setOf();
    const values: string[] = [];
    const shares: boolean[] = [];
    act(() =>
      render(
        h(RecoveryCodeInput, {
          id: "rc",
          label: "Recovery key",
          value: "",
          onValue: (v: string) => void values.push(v),
          onShares: (on: boolean) => void shares.push(on),
        }),
        root as unknown as Element,
      ),
    );
    expect(byId("rc")).not.toBeNull(); // the code field first
    await click("rc-shares-link");
    await waitFor(() => byId("rc-shares-in") !== null);
    expect(byId("rc")).toBeNull();
    expect(shares).toEqual([true]);
    await typeInto("rc-shares-in", set.shares[1]!);
    await typeInto("rc-shares-in", set.shares[2]!);
    expect(values.at(-1)).toBe((await formatRecoveryCode(R)).replace(/-/g, ""));
    await click("rc-shares-to-code");
    expect(byId("rc")).not.toBeNull();
    expect(shares).toEqual([true, false]);
    expect(values.at(-1)).toBe("");
  });
});

describe("the wizard", () => {
  function keysOf(over: Partial<KeyOps> = {}): KeyOps & { confirmed: [PreparedShares, readonly string[]][] } {
    const confirmed: [PreparedShares, readonly string[]][] = [];
    return {
      busy: false,
      code: null,
      error: null,
      info: null,
      clear: () => undefined,
      enable: async () => true,
      change: async () => true,
      newCode: async () => true,
      rotate: async () => true,
      confirmShares: async (p, t) => (confirmed.push([p, t]), true),
      codeSaved: () => undefined,
      ...over,
      confirmed,
    };
  }
  async function handle(mode: "replace" | "split" = "replace"): Promise<PreparedShares> {
    const set = await setOf(2, 3);
    return Object.freeze({
      mode,
      setId: set.setId.toString(16).toUpperCase().padStart(4, "0"),
      threshold: 2,
      count: 3,
      shares: Object.freeze(set.shares),
      test: Object.freeze([0, 2]),
    });
  }
  async function mount(h0: PreparedShares, keys = keysOf(), service: Record<string, unknown> = {}) {
    const { ShareWizard } = await import("../../src/options/ShareWizard");
    const asked: unknown[] = [];
    const rt = {
      service: {
        prepareShares: async (...a: unknown[]) => (asked.push(a), h0),
        confirmShares: async () => undefined,
        checkRecoveryCode: async () => "current",
        ...service,
      },
    } as never;
    await act(async () => {
      render(h(ShareWizard, { rt, keys }), root as unknown as Element);
      await ticks();
    });
    await waitFor(() => byId("shares-wizard") !== null);
    return { asked, keys };
  }
  it("replace: the password, then one share per screen, each kept before the next; the switch only after the test", async () => {
    const h0 = await handle();
    const { asked, keys } = await mount(h0);
    expect(byId("shares-new")!.checked).toBe(true); // the recommended way first
    expect(byId("shares-23")!.checked).toBe(true); // 2 of 3 by default
    expect(byId("shares-make")!.disabled).toBe(true);
    await typeInto("shares-pw", "the-master-password-1");
    await click("shares-make");
    expect(asked).toEqual([[{ password: "the-master-password-1" }, { threshold: 2, count: 3 }]]);
    for (let i = 0; i < 3; i++) {
      expect(byId("shares-sheet-title")!.textContent).toBe(sx("shSheetTitle", i + 1, 3));
      expect(byId("shares-share")!.textContent).toBe(h0.shares[i]); // this share, and no other one, on screen
      for (const other of h0.shares.filter((_, k) => k !== i)) expect(text()).not.toContain(other);
      expect(byId("shares-not-yet")).not.toBeNull(); // nothing has changed yet
      expect(byId("shares-copy")).toBeNull(); // no Copy
      expect(byId("shares-next")!.disabled).toBe(true);
      await act(async () => {
        const c = byId("shares-kept")!;
        c.checked = true;
        c.dispatch("change");
        await ticks();
      });
      await click("shares-next");
    }
    expect(byId("shares-test-title")!.textContent).toBe(sx("shTestTitle", 2));
    expect(byId("shares-switch")!.disabled).toBe(true); // not before the test restore
    await typeInto("shares-test-in", h0.shares[0]!);
    expect(byId("shares-switch")!.disabled).toBe(true);
    await typeInto("shares-test-in", h0.shares[2]!);
    expect(keys.confirmed).toEqual([]); // typed, not yet switched
    await click("shares-switch");
    expect(keys.confirmed).toHaveLength(1);
    expect(keys.confirmed[0]![0]).toBe(h0);
    expect([...keys.confirmed[0]![1]]).toEqual([h0.shares[0]!, h0.shares[2]!].map((s) => s.replace(/-/g, "")));
    expect(byId("shares-done")!.textContent).toBe(sx("shDone", 2, 3));
  });
  it("the test restore refuses a share of an earlier set at once (F2), and the switch hands the page the shares' words", async () => {
    const h0 = await handle();
    const earlier = await setOf(2, 3);
    let say: ((e: unknown) => string | null) | undefined;
    const keys = keysOf({
      confirmShares: async (_p, _t, s) => {
        say = s;
        return true;
      },
    });
    await mount(h0, keys);
    await typeInto("shares-pw", "pw");
    await click("shares-make");
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        const c = byId("shares-kept")!;
        c.checked = true;
        c.dispatch("change");
        await ticks();
      });
      await click("shares-next");
    }
    await typeInto("shares-test-in", earlier.shares[0]!);
    expect(byId("shares-test-err")!.textContent).toMatch(new RegExp(h0.setId)); // "type the shares of set <this one>"
    expect(byId("shares-switch")!.disabled).toBe(true);
    await typeInto("shares-test-in", h0.shares[0]!);
    await typeInto("shares-test-in", h0.shares[2]!);
    await click("shares-switch");
    // an error of the shares themselves in their words; never the page's "could not read its data"
    expect(say!(Object.assign(new Error("x"), { code: "shares_mixed" }))).toBe(sx("shDifferentSets"));
    expect(say!(Object.assign(new Error("x"), { code: "share_checksum" }))).toBe(sx("shWrongCheck"));
    expect(say!(Object.assign(new Error("x"), { code: "shares_digest" }))).toBe(sx("shNoFit"));
    expect(say!(Object.assign(new Error("x"), { code: "bad_state" }))).toBeNull();
    // the done screen holds no share (F5)
    expect(byId("shares-done")).not.toBeNull();
    for (const sh of h0.shares) expect(text()).not.toContain(sh);
  });
  it("a switch the page refused leaves the wizard on the test, nothing claimed done", async () => {
    const h0 = await handle();
    await mount(h0, keysOf({ confirmShares: async () => false }));
    await typeInto("shares-pw", "pw");
    await click("shares-make");
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        const c = byId("shares-kept")!;
        c.checked = true;
        c.dispatch("change");
        await ticks();
      });
      await click("shares-next");
    }
    await typeInto("shares-test-in", h0.shares[0]!);
    await typeInto("shares-test-in", h0.shares[2]!);
    await click("shares-switch");
    expect(byId("shares-done")).toBeNull();
    expect(byId("shares-switch")).not.toBeNull();
  });
  it("print: one share's paper under <body> while printing, then gone; save: one share per file", async () => {
    const h0 = await handle();
    await mount(h0);
    await typeInto("shares-pw", "pw");
    await click("shares-make");
    const printed: string[] = [];
    const classes = new Set<string>();
    Object.assign(doc, {
      documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
    });
    g.window = Object.assign(globalThis, {
      print: () => {
        printed.push(doc.body.byId("sh-print")!.textContent);
        expect(classes.has("sh-printing")).toBe(true);
      },
    });
    await click("shares-print");
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(h0.shares[0]);
    for (const other of h0.shares.slice(1)) expect(printed[0]).not.toContain(other);
    expect(printed[0]).toContain(sx("shPaperTitle", 1, 3));
    expect(doc.body.byId("sh-print")).toBeNull(); // removed once printing is over
    expect(classes.has("sh-printing")).toBe(false);
    await click("shares-save");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toBe(`sixkey-share-${h0.setId}-1-of-3.txt`);
    expect(downloads[0]!.text).toContain(h0.shares[0]);
    for (const other of h0.shares.slice(1)) expect(downloads[0]!.text).not.toContain(other);
    expect(byId("shares-save-warn")!.textContent).toBe(sx("shSaveWarn"));
  });
  it("split: the current code typed; after the test restore the service checks it, writes nothing, and it is done", async () => {
    const h0 = await handle("split");
    const confirmed: unknown[] = [];
    const keys = keysOf();
    const code = (await formatRecoveryCode(R)).replace(/-/g, "");
    const { asked } = await mount(h0, keys, { confirmShares: async (...a: unknown[]) => void confirmed.push(a) });
    await act(async () => {
      byId("shares-current")!.dispatch("change");
      await ticks();
    });
    await typeInto("shares-code", code);
    await click("shares-make");
    expect(asked).toEqual([[{ recoveryCode: code }, { threshold: 2, count: 3 }]]);
    expect(byId("shares-not-yet")).toBeNull(); // nothing will change: no "not yet"
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        const c = byId("shares-kept")!;
        c.checked = true;
        c.dispatch("change");
        await ticks();
      });
      await click("shares-next");
    }
    expect(byId("shares-switch")).toBeNull(); // nothing to switch
    await typeInto("shares-test-in", h0.shares[0]!);
    await typeInto("shares-test-in", h0.shares[2]!);
    expect(confirmed).toHaveLength(1);
    expect(keys.confirmed).toEqual([]); // not the page's key operation: nothing is written
    expect(byId("shares-done")!.textContent).toBe(sx("shDoneSplit", 2, 3));
  });
  it("check my shares: current, or stale (the entry says so)", async () => {
    const h0 = await handle();
    const set = await setOf();
    let answer: "current" | "current_before_restart" | "stale" | "stale_after_switch" = "current";
    await mount(h0, keysOf(), { checkRecoveryCode: async () => answer });
    await click("shares-check-open");
    await typeInto("shares-check-in", set.shares[0]!);
    await typeInto("shares-check-in", set.shares[1]!);
    expect(byId("shares-check-ok")!.textContent).toBe(sx("shCheckOk"));
    expect(byId("shares-check-restart")).toBeNull();
    answer = "stale";
    await click("shares-check-clear");
    await typeInto("shares-check-in", set.shares[0]!);
    await typeInto("shares-check-in", set.shares[2]!);
    expect(byId("shares-check-ok")).toBeNull();
    const id = (await parseShare(set.shares[0]!)).setId.toString(16).toUpperCase().padStart(4, "0");
    expect(byId("shares-check-stale")!.textContent).toBe(sx("shStale", id));
    expect(byId("shares-check-lost")).toBeNull();
  });
  it("check my shares after a switch (the review's N1, N7): before the restart one more check after it; a switch lost", async () => {
    const h0 = await handle();
    const set = await setOf();
    let answer: "current_before_restart" | "stale_after_switch" = "current_before_restart";
    const sets: unknown[] = [];
    await mount(h0, keysOf(), { checkRecoveryCode: async (_c: string, s?: string) => (sets.push(s), answer) });
    await click("shares-check-open");
    await typeInto("shares-check-in", set.shares[0]!);
    await typeInto("shares-check-in", set.shares[1]!);
    expect(byId("shares-check-ok")!.textContent).toBe(sx("shCheckOk"));
    expect(byId("shares-check-restart")!.textContent).toBe(sx("shCheckRestart"));
    answer = "stale_after_switch";
    await click("shares-check-clear");
    await typeInto("shares-check-in", set.shares[0]!);
    await typeInto("shares-check-in", set.shares[2]!);
    expect(byId("shares-check-ok")).toBeNull();
    expect(byId("shares-check-restart")).toBeNull();
    expect(byId("shares-check-stale")).not.toBeNull();
    expect(byId("shares-check-lost")!.textContent).toBe(sx("shSwitchLost"));
    // the service is told which set the shares are of, so it says "that switch did not complete" for that set only
    const id = (await parseShare(set.shares[0]!)).setId.toString(16).toUpperCase().padStart(4, "0");
    expect(sets).toEqual([id, id]);
  });
  it("the page's real key operation says a switch's error in the shares' words (key-ops.ts; the review's N3)", async () => {
    const { useKeyOps } = await import("../../src/options/key-ops");
    const { sharesWords } = await import("../../src/options/ShareWizard");
    const { errText } = await import("../../src/options/shared");
    const h0 = await handle();
    let refusal: Error = Object.assign(new Error("x"), { code: "shares_mixed" });
    let reloads = 0;
    let keys!: KeyOps;
    const service = {
      confirmShares: async () => {
        throw refusal;
      },
    };
    function Holder() {
      keys = useKeyOps({ service } as never, async () => void reloads++);
      return null;
    }
    act(() => render(h(Holder, {}), root as unknown as Element));
    let ok: boolean | undefined;
    await act(async () => void (ok = await keys.confirmShares(h0, [h0.shares[0]!], sharesWords)));
    expect(ok).toBe(false);
    expect(keys.error).toBe(sx("shDifferentSets"));
    expect(keys.error).not.toBe(errText(refusal));
    refusal = Object.assign(new Error("x"), { code: "share_checksum" });
    await act(async () => void (await keys.confirmShares(h0, [h0.shares[0]!], sharesWords)));
    expect(keys.error).toBe(sx("shWrongCheck"));
    refusal = Object.assign(new Error("x"), { code: "bad_state" }); // not the shares': the page's own words
    await act(async () => void (await keys.confirmShares(h0, [h0.shares[0]!], sharesWords)));
    expect(keys.error).toBe(errText(refusal));
    await act(async () => void (await keys.confirmShares(h0, [h0.shares[0]!])));
    expect(keys.error).toBe(errText(refusal)); // and without the wizard's words at all
    expect(reloads).toBe(4); // the page reads what is true after each
  });
  it("a wrong password, and a wrong current code, are said in words, not codes", async () => {
    const h0 = await handle();
    const wrong = Object.assign(new Error("wrong_secret"), { code: "wrong_secret" });
    await mount(h0, keysOf(), {
      prepareShares: async () => {
        throw wrong;
      },
    });
    await typeInto("shares-pw", "pw");
    await click("shares-make");
    expect(byId("shares-err")!.textContent).toBe(t("wrongPassword"));
    await act(async () => {
      byId("shares-current")!.dispatch("change");
      await ticks();
    });
    await typeInto("shares-code", (await formatRecoveryCode(R)).replace(/-/g, ""));
    await click("shares-make");
    expect(byId("shares-err")!.textContent).toBe(sx("shWrongCode"));
  });
});

// last: it loads fresh copies of the modules (vi.resetModules), with the shares' catalogs made to fail
describe("the share entry without its text", () => {
  it("its text not loadable: nothing of it is drawn (no key name), and the host's code field comes back", async () => {
    vi.resetModules();
    for (const l of ["en", "zh_CN"])
      vi.doMock(`../../catalogs/shares-${l}.json`, () => {
        throw new Error("chunk not found");
      });
    try {
      const fresh = await import("../../src/ui/ShareEntry");
      const back = vi.fn();
      await act(async () => {
        render(
          h(fresh.ShareEntry, {
            id: "e",
            lockKey: LOCK_EPOCH_KEY,
            toCode: formatRecoveryCode,
            onCode: () => undefined,
            onCodeField: back,
          }),
          root as unknown as Element,
        );
        await ticks(40);
      });
      expect(root.textContent).toBe("");
      expect(text()).not.toMatch(/sh[A-Z]/);
      expect(back).toHaveBeenCalled();
    } finally {
      for (const l of ["en", "zh_CN"]) vi.doUnmock(`../../catalogs/shares-${l}.json`);
    }
  });
});
