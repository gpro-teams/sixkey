// Layout probes for the visual guard (visual-guard.spec.ts): cheap checks, run on the page as drawn, for the defects
// that show at a glance and that no functional test notices. A checkbox inside a `.field` once inherited the text-field
// rule (full width, 38px high) and squeezed its label into a column one character wide (popup.css `.field .show input`);
// the popup's search field was squeezed to half its height by a long list; the "Remember this site" sheet was drawn
// with the browser's own fieldset and radio until the edit dialog's style sheet happened to be loaded.
//   box       a checkbox or radio drawn larger than 24px or smaller than 12px on a side
//   column    text squeezed into a column: three or more lines of fewer than four characters each
//   wrap      a control's text on more lines than it may take (a button two, a chip, a toolbar button or a key one)
//   spill     text drawn past the right edge of its own box (a long unbroken word, an address)
//   clipped   text cut off by a box that hides its overflow and does not end it with an ellipsis
//   hscroll   a box that scrolls sideways, or anything drawn past the page's right edge
//   vscroll   the popup's document itself scrolls (only its list may)
//   unstyled  an element none of whose classes any loaded style sheet names, or with the browser's default border
//   target    a control smaller than 28px on a side (a checkbox or radio is measured by its label)
//   contrast  text below 4.5:1 against what is behind it (3:1 at 18.66px bold or 24px), disabled controls excepted
// Each issue names the element as tag#id.class plus the start of its text, so a test can allow one by name, with its reason.
import type { Page } from "@playwright/test";

export type Issue = { kind: string; el: string; detail: string };

/** Every issue the layout probe finds on the page as it is now, or under `root` (the kinds above; focus: focusIssues). */
export async function layoutIssues(page: Page, o: { popup?: boolean; root?: string } = {}): Promise<Issue[]> {
  await settle(page);
  return page.evaluate(probe, { popup: o.popup ?? false, root: o.root ?? "body" });
}

/**
 * Wait for the entrance animations to end (rows and options rise into place): a box measured mid-way is not where it
 * stays. At most 1.5 s, so a paused animation, whose `finished` never comes, cannot hold the test up.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((done) => setTimeout(done, 1500)),
    ]),
  );
}

function probe(o: { popup: boolean; root: string }): Issue[] {
  const out: Issue[] = [];
  const name = (el: Element) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = [...el.classList].map((c) => `.${c}`).join("");
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  const add = (kind: string, el: Element, detail: string) => out.push({ kind, el: name(el), detail });
  const styles = new Map<Element, CSSStyleDeclaration>();
  const st = (el: Element) => styles.get(el) ?? styles.set(el, getComputedStyle(el)).get(el)!;
  const shown = (el: Element) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    el.getBoundingClientRect().width > 0 &&
    !el.closest("[aria-hidden=true], .vh");
  const px = (v: string) => parseFloat(v) || 0;

  // colours, through a canvas so every syntax the page uses (rgb, color-mix, oklch) comes back as sRGB bytes
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const colours = new Map<string, number[]>();
  const rgba = (c: string): number[] => {
    const known = colours.get(c);
    if (known) return known;
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = "#000";
    cv.fillStyle = c;
    cv.fillRect(0, 0, 1, 1);
    const d = cv.getImageData(0, 0, 1, 1).data;
    const v = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    colours.set(c, v);
    return v;
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const over = (top: number[], a: number, under: number[]) => under.map((u, i) => top[i]! * a + u * (1 - a));
  /** What is drawn behind `el`: its own and its ancestors' backgrounds, blended; null under an image or gradient. */
  const backs = new Map<Element, number[] | null>();
  const behind = (el: Element | null): number[] | null => {
    if (!el) return [255, 255, 255];
    if (backs.has(el)) return backs.get(el)!;
    const cs = st(el);
    let v: number[] | null;
    if (cs.backgroundImage !== "none") v = null;
    else {
      const c = rgba(cs.backgroundColor);
      const under = c[3]! >= 1 ? [0, 0, 0] : behind(el.parentElement);
      v = under && over(c, c[3]!, under);
    }
    backs.set(el, v);
    return v;
  };
  const opacities = new Map<Element, number>();
  const opacity = (el: Element | null): number => {
    if (!el) return 1;
    if (!opacities.has(el)) opacities.set(el, px(st(el).opacity) * opacity(el.parentElement));
    return opacities.get(el)!;
  };

  // every class any loaded style sheet names: an element none of whose classes is named has lost its rules (a lazy
  // chunk's style sheet not loaded yet, say), and falls back to the browser's own look
  const styled = new Set<string>();
  const collect = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) for (const m of rule.selectorText.matchAll(/\.([\w-]+)/g)) styled.add(m[1]!);
      if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) collect(sheet.cssRules);
  const unstyled = new Set<string>();

  const viewW = document.documentElement.clientWidth;
  const right = o.popup ? Math.min(viewW, document.body.getBoundingClientRect().right) : viewW;
  if (document.documentElement.scrollWidth > viewW + 1)
    add("hscroll", document.documentElement, `page ${document.documentElement.scrollWidth}px wide in ${viewW}px`);
  if (o.popup && document.documentElement.scrollHeight > innerHeight + 1)
    add("vscroll", document.body, `document ${document.documentElement.scrollHeight}px tall in ${innerHeight}px`);

  const root = document.querySelector(o.root) ?? document.body;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!shown(el)) continue;
    const cs = st(el);
    const r = el.getBoundingClientRect();

    const classes = [...el.classList];
    if (classes.length && !classes.some((c) => styled.has(c)) && !unstyled.has(classes.join("."))) {
      unstyled.add(classes.join("."));
      add("unstyled", el, `no loaded style sheet has a rule for .${classes.join(", .")}`);
    }
    if (["groove", "outset", "inset", "ridge"].includes(cs.borderTopStyle))
      add("unstyled", el, `the browser's default ${cs.borderTopStyle} border`);

    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      if (r.width > 24 || r.height > 24 || r.width < 12 || r.height < 12)
        add("box", el, `${el.type} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }

    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1)
      add("hscroll", el, `scrolls sideways: ${el.scrollWidth}px in ${el.clientWidth}px`);
    if (r.right > right + 1 && cs.position !== "fixed") {
      let clipped = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
        if (st(a).overflowX !== "visible") clipped = true;
      if (!clipped) add("hscroll", el, `right edge at ${Math.round(r.right)}px, page ends at ${Math.round(right)}px`);
    }

    const texts = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
    if (!texts.length) continue;
    const range = document.createRange();
    const rects: DOMRect[] = [];
    for (const t of texts) {
      range.selectNodeContents(t);
      rects.push(...[...range.getClientRects()].filter((x) => x.width > 0));
    }
    if (!rects.length) continue;
    const tops: number[] = [];
    for (const x of rects) if (!tops.some((t) => Math.abs(t - x.top) < 3)) tops.push(x.top);
    const lines = tops.length;
    const chars = texts.map((t) => t.textContent!.replace(/\s/g, "")).join("").length;
    if (lines >= 3 && chars / lines < 4) add("column", el, `${chars} characters on ${lines} lines`);
    const control = el.closest("button, .btn, .chip, .tb, kbd");
    const limit = !control ? 0 : control.matches(".chip, .tb, kbd") ? 1 : 2;
    if (limit && lines > limit) add("wrap", el, `${lines} lines in a ${control!.tagName.toLowerCase()}`);
    const padR = px(cs.paddingRight) + px(cs.borderRightWidth);
    const spill = Math.max(...rects.map((x) => x.right)) - (r.right - padR);
    if (spill > 2 && cs.overflowX === "visible" && cs.display !== "inline")
      add("spill", el, `text ${Math.round(spill)}px past its box`);
    if (cs.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis")
      add("clipped", el, `${el.scrollWidth}px of text in ${el.clientWidth}px, no ellipsis`);

    const bg = behind(el);
    if (bg && !el.closest(":disabled, [aria-disabled=true]")) {
      const fg = rgba(cs.color);
      const seen = over(fg, fg[3]! * opacity(el), bg);
      const [a, b] = [lum(seen), lum(bg)].sort((x, y) => y - x) as [number, number];
      const ratio = (a + 0.05) / (b + 0.05);
      const size = px(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && px(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) add("contrast", el, `${ratio.toFixed(2)}:1 at ${size}px`);
    }
  }

  for (const el of root.querySelectorAll<HTMLElement>(
    "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [tabindex='0']",
  )) {
    if (!shown(el)) continue;
    const box = el.matches("input[type=checkbox], input[type=radio]") ? (el.closest("label") ?? el) : el;
    const r = box.getBoundingClientRect();
    if (Math.min(r.width, r.height) < 28) add("target", box, `${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
}

/**
 * Walk the page with the Tab key (real key presses, so :focus-visible applies as it does for a person) from its top, and
 * report each stop that shows no focus: no outline, and no box-shadow, border or background change on it or its two
 * ancestors against how they looked before the walk. Also reports a ring that a box hiding its overflow would cut
 * (`focus-clipped`). Returns the stops, in order, and the issues.
 */
export async function focusIssues(page: Page, maxStops = 60): Promise<{ stops: string[]; issues: Issue[] }> {
  const stops: string[] = [];
  const issues: Issue[] = [];
  await settle(page);
  await page.evaluate(snapshot);
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(compare);
    if (!r || stops[0] === r.el) break;
    stops.push(r.el);
    if (r.issue) issues.push({ kind: r.issue, el: r.el, detail: r.detail });
  }
  return { stops, issues };
}

/** Nothing focused, the walk starting at the top of the page; how every control and its two ancestors look now. */
function snapshot(): void {
  (document.activeElement as HTMLElement | null)?.blur();
  document.body.tabIndex = -1;
  document.body.focus();
  document.body.removeAttribute("tabindex");
  const look = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderColor", "backgroundColor"] as const;
  const snap = new WeakMap<Element, string[]>();
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, summary, [tabindex]")) {
    const chain = [el, el.parentElement, el.parentElement?.parentElement];
    snap.set(
      el,
      chain.flatMap((e) => (e ? look.map((k) => getComputedStyle(e)[k]) : [])),
    );
  }
  (window as unknown as { __vgSnap: WeakMap<Element, string[]> }).__vgSnap = snap;
}

function compare(): { el: string; issue?: string; detail: string } | null {
  const look = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderColor", "backgroundColor"] as const;
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const id = el.id ? `#${el.id}` : "";
  const cls = [...el.classList].map((c) => `.${c}`).join("");
  const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  const desc = `${el.tagName.toLowerCase()}${id}${cls}${label ? ` "${label}"` : ""}`;
  const before = (window as unknown as { __vgSnap: WeakMap<Element, string[]> }).__vgSnap.get(el);
  const chain = [el, el.parentElement, el.parentElement?.parentElement];
  const now = chain.flatMap((e) => (e ? look.map((k) => getComputedStyle(e)[k]) : []));
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1;
  if (!outline && before && now.every((v, i) => v === before[i]))
    return { el: desc, issue: "focus", detail: "no visible focus" };
  if (outline && parseFloat(cs.outlineOffset) > -parseFloat(cs.outlineWidth)) {
    const r = el.getBoundingClientRect();
    const grow = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflow === "visible" && acs.contentVisibility !== "auto") continue;
      const ar = a.getBoundingClientRect();
      const sides = [
        r.left - grow - ar.left,
        ar.right - r.right - grow,
        r.top - grow - ar.top,
        ar.bottom - r.bottom - grow,
      ];
      if (sides.some((d) => d < -0.5))
        return { el: desc, issue: "focus-clipped", detail: `ring cut by ${a.tagName.toLowerCase()}.${a.className}` };
    }
  }
  return { el: desc, detail: "" };
}
