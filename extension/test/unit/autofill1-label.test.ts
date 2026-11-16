// TOTP autofill, Stage 1: what the finder reads to name a box (`labelOf`, src/inject/otp.ts) stays small whatever the page
// does (AUTOFILL1-R3-VERIFY.md §4: one box whose aria-labelledby names a 1 MB block 200 times held the look up for 1.3 s).
// Plain objects stand for the elements: the function reads only the properties given here, and counts are taken on them.
import { describe, expect, it, vi } from "vitest";
import { labelOf } from "../../src/inject/otp";

/** An element whose text is `text`, counting how often its text is read. */
function block(text: string) {
  const el = {
    reads: 0,
    get textContent() {
      el.reads++;
      return text;
    },
  };
  return el;
}
/** A box with these attributes, these labels, and these elements in its document (by id). */
function box(o: { attrs?: Record<string, string>; labels?: unknown[]; byId?: Record<string, unknown> }) {
  const lookups: string[] = [];
  const el = {
    labels: o.labels ?? [],
    getAttribute: (k: string) => o.attrs?.[k] ?? null,
    placeholder: o.attrs?.placeholder ?? "",
    title: o.attrs?.title ?? "",
    getRootNode: () => ({ getElementById: (id: string) => (lookups.push(id), o.byId?.[id] ?? null) }),
    previousElementSibling: null,
    parentElement: null,
  } as unknown as HTMLInputElement;
  return { el, lookups };
}

describe("labelOf: a page cannot make the look read much to name one box", () => {
  it("the reviewer's shape: one id named 200 times, for a 1 MB block of text, is read once, quickly, and not used", () => {
    const big = block("lorem ipsum ".repeat(90_000)); // about 1 MB, with spaces to collapse
    const { el, lookups } = box({ attrs: { "aria-labelledby": Array(200).fill("big").join(" ") }, byId: { big } });
    const t0 = performance.now();
    const label = labelOf(el, new Map());
    const ms = performance.now() - t0;
    expect(big.reads).toBe(1);
    expect(lookups).toEqual(["big"]);
    expect(label.trim()).toBe(""); // a block that size is no label
    // without the bounds this takes hundreds of milliseconds (200 copies of 1 MB, each collapsed); with them, well under 1 ms:
    // the bound leaves a hundred times the room, so a busy machine does not make it fail
    expect(ms).toBeLessThan(100);
  });
  it("at most 8 named elements and 8 labels are read; a short label is used as it is", () => {
    const named = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, block(`Code ${i}`)]));
    const labels = Array.from({ length: 20 }, (_, i) => block(`Label ${i}`));
    const { el, lookups } = box({
      attrs: { "aria-labelledby": Object.keys(named).join(" ") },
      byId: named,
      labels,
    });
    const label = labelOf(el, new Map());
    expect(lookups).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    expect(label).toContain("Code 7");
    expect(label).not.toContain("Code 8");
    expect(labels.filter((l) => l.reads > 0)).toHaveLength(8);
    expect(label).toContain("Label 7");
    expect(label).not.toContain("Label 8");
  });
  it("a referenced text longer than 4,096 characters is not used, and its spaces are not even collapsed; one padded with spaces at both ends is still a label; long attributes are cut", () => {
    const block4k = block("Authenticator code ".repeat(300)); // 5,700 characters of text
    const replace = vi.spyOn(String.prototype, "replace");
    expect(labelOf(box({ attrs: { "aria-labelledby": "b" }, byId: { b: block4k } }).el, new Map())).not.toContain(
      "Authenticator",
    );
    expect(replace.mock.contexts.filter((c) => String(c).length > 4096)).toEqual([]); // no pass over the long text
    replace.mockRestore();
    // the FU verify's NIT: 3,000 spaces on each side of a short label (the r3 finder found it; the first FU did not)
    const padded = block(" ".repeat(3000) + "Authenticator code" + "\n".repeat(3000));
    expect(labelOf(box({ attrs: { "aria-labelledby": "p" }, byId: { p: padded } }).el, new Map())).toContain(
      "Authenticator code",
    );
    const short = block("  Authenticator   code  ");
    expect(labelOf(box({ attrs: { "aria-labelledby": "s" }, byId: { s: short } }).el, new Map())).toContain(
      "Authenticator code",
    );
    const long = labelOf(
      box({ attrs: { "aria-label": "x".repeat(100_000), placeholder: "y".repeat(100_000) } }).el,
      new Map(),
    );
    expect(long.length).toBeLessThan(1000);
  });
});
