// TOTP autofill Stage 2, patch 4b (docs/design/notes/AUTOFILL2-NOTES.md §13): the in-page suggestion in real pages of the
// e2e build (its release gate open), on the fixture site turned on and granted (grantedtls.fix.test), driven by the
// browser's own mouse, keyboard and touch input. First the normal path; then the DOM-clickjacking set K3 of the patch 4
// plan (§9.3, r2 and r3), each case as the attack a page could make and what the suggestion must do about it. The rule
// every case asserts: a click is accepted only while the suggestion is drawn at full size and uncovered, armed, and from
// the user; it never takes the focus from the code box; and when accepted it opens Sixkey's popup with the request R v2
// for that document, and fills nothing.
//
// The set runs in both languages: the browser's (chrome.i18n, the content script's only source of words). The tests read
// the expected words from the extension itself, so they hold in either.
import { expect, test, type Page } from "@playwright/test";
import { GRANTED_TLS, type World } from "./autofill-helpers";
import {
  accepted,
  staleRetries,
  armed,
  armIt,
  clickPill,
  closePopup,
  cover,
  decisions,
  dropRequest,
  focusIsBox,
  grantedWorld,
  inWorld,
  log,
  pillPixels,
  pillRect,
  refused,
  request,
  shown,
  showIt,
  tab,
  uncover,
  untouched,
  wait,
  worker,
  type Tab,
} from "./suggest-helpers";

// One browser for the file (each case in a tab of its own: one document, one open); closed at the end.
let w: World | undefined;
const W = async () => (w ??= await grantedWorld());
let open: Tab[] = [];
const newTab = async (path?: string) => {
  const t = await tab(await W(), path);
  open.push(t);
  return t;
};
test.beforeEach(async () => {
  if (w) await dropRequest(w);
});
test.afterEach(async () => {
  for (const t of open) await t.page.close().catch(() => undefined);
  open = [];
});
test.afterAll(async () => {
  await w?.close();
  w = undefined;
  console.log(`accepted() stale retries in this run: ${staleRetries.n}`);
});

/** The page's own script, run in its world (as the attacking page would). */
const onPage = <A, R>(t: Tab, f: (a: A) => R | Promise<R>, a?: A): Promise<R> =>
  t.page.evaluate(f as never, a as never) as Promise<R>;
const css = (t: Tab, text: string) =>
  onPage(
    t,
    (s: string) => document.head.append(Object.assign(document.createElement("style"), { textContent: s })),
    text,
  );
/** The pill as drawn on a clean page, armed: the baseline every "painted" case is held to. */
let base: { pixels: Buffer; width: number } | undefined;
async function baseline(): Promise<{ pixels: Buffer; width: number }> {
  if (base) return base;
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  await wait(100); // the armed colours at the next frame
  base = { pixels: await pillPixels(t), width: (await pillRect(t))[2] };
  return base;
}
/** Drawn as on a clean page (armed): its pixels, inset from the edge, equal the baseline's. */
async function painted(t: Tab): Promise<void> {
  const b = await baseline();
  await armIt(t);
  await wait(100);
  expect((await pillPixels(t)).equals(b.pixels), "the suggestion drawn as on a clean page").toBe(true);
}
/** Not armed, and staying so, while the page's attack is up. */
async function neverArmed(t: Tab, ms = 1200): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    expect(await armed(t)).toBe(false);
    await wait(100);
  }
}
const say = (key: string, subs: string[] = []) =>
  worker(w!).evaluate(([k, s]) => chrome.i18n.getMessage(k, s), [key, subs] as const);
const tabIdOf = async (page: Page) => {
  await page.bringToFront();
  return worker(w!).evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]!.id!);
};

test.describe.configure({ timeout: 120_000 });

// ---- the normal path ----

test("P-1: after the user's click in the code box: under it, the host named, drawn idle, then armed; a click opens the popup with R v2", async () => {
  const t = await newTab();
  await showIt(t);
  const idle = await pillPixels(t); // at once: armed only after 800 ms
  expect(await inWorld<string>(t, "getComputedStyle(L.pill()).cursor")).toBe("default");
  expect(await inWorld<string>(t, "L.pill().textContent")).toBe(await say("afSugFill", [GRANTED_TLS]));
  const key = await worker(w!).evaluate(
    async () => (await chrome.commands.getAll()).find((c) => c.name === "fill")?.shortcut ?? "",
  );
  expect(await inWorld<string>(t, "L.pill().title")).toBe(
    key ? await say("afCanFill", [key]) : await say("afCanFillOpen"),
  );
  await armIt(t);
  await wait(100);
  expect((await pillPixels(t)).equals(idle), "drawn differently once armed").toBe(false);
  const box = (await t.page.locator("input").boundingBox())!;
  const [, y] = await pillRect(t);
  expect(y).toBeGreaterThanOrEqual(box.y + box.height); // under the box, never over it
  expect(await inWorld<string>(t, "getComputedStyle(L.pill()).cursor")).toBe("pointer");
  expect(await focusIsBox(t)).toBe(true);
  await accepted(t);
  expect(await shown(t)).toBe(false); // used: gone for the document
});

test("P-2: × and Esc dismiss it for the document; a click elsewhere hides it until the next look", async () => {
  const a = await newTab();
  await showIt(a);
  const d = await decisions(a);
  const [x, y, wd, h] = await inWorld<number[]>(
    a,
    "(() => { const r = L.root().getElementById('x').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()",
  );
  await a.page.mouse.click(x! + wd! / 2, y! + h! / 2);
  expect(await d.next()).toBe("end:x");
  expect(await focusIsBox(a)).toBe(true);
  await wait(2100);
  const box = (await a.page.locator("input").boundingBox())!;
  await a.page.mouse.click(box.x + 5, box.y + 5);
  await wait(500);
  expect(await shown(a)).toBe(false);

  const b = await newTab();
  await showIt(b);
  const e = await decisions(b);
  await b.page.keyboard.press("Escape");
  expect(await e.next()).toBe("end:esc");
  expect(await shown(b)).toBe(false);

  const c = await newTab();
  await showIt(c);
  await c.page.mouse.click(600, 500); // the page, away from the box and the suggestion
  await expect.poll(() => shown(c)).toBe(false);
  await wait(2100);
  await showIt(c); // the next look shows it again (a hide is not a dismissal)
});

// ---- K3: the DOM-clickjacking set ----

test("K3-1: opacity 0 on our host through its style attribute is tamper: ended for the document", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  const d = await decisions(t);
  await onPage(t, () => ((document.querySelector("sixkey-suggest") as HTMLElement).style.opacity = "0"));
  // a MutationObserver reports at once: within 3 s, exactly this
  await expect.poll(() => d.since(), { message: "tamper", timeout: 3000 }).toEqual(["end:tamper"]);
  expect(await shown(t)).toBe(false);
  const e = await decisions(t);
  await clickPill(t);
  await untouched(t, e);
});

for (const [k, rule] of [
  ["html opacity 0", "html{opacity:0!important}"],
  ["html opacity 0.5", "html{opacity:.5!important}"],
  ["body opacity 0", "body{opacity:0!important}"],
  ["body opacity 0.5", "body{opacity:.5!important}"],
] as const)
  test(`K3-2: ${k}: drawn as on a clean page, and accepted`, async () => {
    await baseline();
    const t = await newTab();
    await showIt(t); // a page this transparent has no code box to the finder: the page hides it once it shows
    await css(t, rule);
    await painted(t);
    await accepted(t);
  });

test("K3-3: filters, clip-path and transform on html and on body: drawn as on a clean page, and accepted", async () => {
  test.setTimeout(170_000);
  await baseline();
  for (const el of ["html", "body"])
    for (const kind of ["filter", "clip", "transform"]) {
      const t = await newTab();
      await showIt(t);
      // the clip keeps the box (the user can click it) and cuts away everything under it, where the suggestion is
      await onPage(
        t,
        ([el, kind]: string[]) => {
          const b = document.querySelector("input")!.getBoundingClientRect();
          const rule =
            kind === "filter"
              ? "filter:blur(6px) grayscale(1) opacity(.2)"
              : kind === "clip"
                ? `clip-path:inset(0 0 ${innerHeight - b.bottom}px 0)`
                : "transform:translateX(40px) scale(.9) rotate(2deg)";
          document.head.append(
            Object.assign(document.createElement("style"), { textContent: `${el}{${rule}!important}` }),
          );
        },
        [el, kind],
      );
      await painted(t);
      await accepted(t);
      await t.page.close();
    }
});

test("K3-4: html visibility hidden: drawn (its own reset), and accepted", async () => {
  await baseline();
  const t = await newTab();
  await showIt(t);
  await css(t, "html{visibility:hidden!important}");
  await painted(t);
  await accepted(t, { focus: "page" }); // a hidden box loses the focus: the browser's doing, not Sixkey's
});

test("K3-5: html colour transparent and font size 0: drawn with its words, and accepted", async () => {
  await baseline();
  const t = await newTab();
  await showIt(t);
  await css(t, "html{color:transparent!important;font-size:0!important}");
  await painted(t);
  expect(await inWorld<string>(t, "L.pill().textContent")).toBe(await say("afSugFill", [GRANTED_TLS]));
  await accepted(t);
});

for (const rule of ["body{display:none!important}", "body{content-visibility:hidden!important}"])
  test(`K3-6: ${rule} (the box outside body): drawn, its host under html, and accepted`, async () => {
    await baseline();
    const t = await newTab();
    await onPage(t, () => document.documentElement.append(document.querySelector("label")!));
    await css(t, rule);
    await showIt(t);
    expect(await inWorld<boolean>(t, "L.host().parentNode === document.documentElement")).toBe(true);
    await painted(t);
    await accepted(t);
  });

for (const [k, style, shadow] of [
  ["K3-7: a page popover over it, opaque, pointer-events none", "background:#fff;pointer-events:none", false],
  ["K3-8: the same with opacity 0", "background:#fff;opacity:0;pointer-events:none", false],
  ["K3-9: a partial popover, pointer-events none", "background:#fff;pointer-events:none;width:24px", false],
] as const)
  test(`${k}: never armed while it is up; a click passes through and is refused (hidden)`, async () => {
    const t = await newTab();
    await showIt(t);
    await armIt(t);
    await cover(t, style, { shadow });
    await neverArmed(t, 1000); // past the 800 ms: what refuses it is IntersectionObserver, not the clock
    await refused(t, /^refused:hidden$/);
    expect(await shown(t)).toBe(true); // a refused click changes nothing
  });

test("K3-10: a popover with opacity 0 that takes pointer events: never armed; the click is the page's", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  await cover(t, "background:#fff;opacity:0");
  await neverArmed(t, 1000);
  const d = await decisions(t);
  await clickPill(t);
  await untouched(t, d);
  expect(await onPage(t, () => document.activeElement?.tagName)).not.toBe("SIXKEY-SUGGEST"); // the page's own element took it
});

test("K3-11: a modal dialog opened over it after it: never armed; nothing can click it (inert)", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  const [x, y, wd, h] = await pillRect(t);
  await onPage(
    t,
    ([x, y, wd, h]: number[]) => {
      const m = document.createElement("dialog");
      m.style.cssText = `position:fixed;inset:auto;margin:0;left:${x! - 6}px;top:${y! - 6}px;width:${wd! + 12}px;height:${h! + 12}px;padding:0;border:0;background:#fff;pointer-events:none`;
      document.body.append(m);
      document.head.append(
        Object.assign(document.createElement("style"), { textContent: "::backdrop{pointer-events:none}" }),
      );
      m.showModal();
    },
    [x, y, wd, h],
  );
  await neverArmed(t, 1000);
  const d = await decisions(t);
  await clickPill(t);
  await untouched(t, d);
  expect(await onPage(t, () => document.activeElement?.tagName)).not.toBe("SIXKEY-SUGGEST");
});

test("K3-12: a view transition holding the page: never armed meanwhile; a click is not the suggestion's", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  await css(t, "::view-transition{pointer-events:none!important}");
  await onPage(t, () => {
    const d = document as Document & { startViewTransition(f: () => Promise<void>): unknown };
    d.startViewTransition(() => new Promise<void>((r) => setTimeout(r, 2500)));
  });
  await wait(100);
  // the screen shows a frozen picture (no frame of the page, nothing from IntersectionObserver): not armed
  await neverArmed(t, 1000);
  const d = await decisions(t);
  await clickPill(t);
  await wait(400);
  expect(await d.since()).not.toContain("open");
  expect(await request(t.x)).toBeNull();
});

test("K3-13: a page popover shown over it between the press and the release, after arming: refused (the clock restarts)", async () => {
  const t = await newTab();
  await showIt(t);
  for (let i = 0; i < 4; i++) {
    await armIt(t);
    const [x, y, wd, h] = await pillRect(t);
    await t.page.mouse.move(x + wd / 2, y + h / 2);
    const d = await decisions(t);
    await t.page.mouse.down();
    await cover(t, "background:#fff;pointer-events:none"); // waits for its toggle event: a few ms
    await t.page.mouse.up();
    expect(await d.next()).toMatch(/^refused:(early|hidden)$/);
    expect(await focusIsBox(t)).toBe(true);
    await uncover(t);
  }
  expect(await request(t.x)).toBeNull();
});

test("K3-14: the page goes fullscreen after arming: never armed while it is up; no click opens it", async () => {
  const t = await newTab();
  await showIt(t);
  await css(t, "#fs,#fs::backdrop{pointer-events:none!important;background:transparent!important}");
  await armIt(t);
  const d = await decisions(t);
  await onPage(t, async () => {
    const f = Object.assign(document.createElement("div"), { id: "fs" });
    document.body.append(f);
    await f.requestFullscreen();
  });
  await clickPill(t); // at once
  await neverArmed(t, 1000);
  await clickPill(t); // and once IntersectionObserver has seen it
  await wait(300);
  expect((await d.since()).every((v) => /^refused:(early|hidden|stale)$/.test(v))).toBe(true);
  expect(await request(t.x)).toBeNull();
});

test("K3-15: the box moved so the armed suggestion lands under the pointer, 50 ms before the click: refused (early)", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  await onPage(t, () => ((document.querySelector("label") as HTMLElement).style.marginLeft = "220px"));
  await wait(50);
  await refused(t, /^refused:early$/);
  await armIt(t);
  await accepted(t); // after its 800 ms in the new place, a click counts
});

test("K3-16: a click 500 ms after it appeared: refused (early), and it stays", async () => {
  const t = await newTab();
  await showIt(t);
  await wait(500);
  await refused(t, /^refused:early$/);
  expect(await shown(t)).toBe(true);
});

test("K3-17: the page's own events at our host, and host.click(): no decision; then the user's click opens it", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  const d = await decisions(t);
  const [x, y, wd, h] = await pillRect(t);
  const seen = await onPage(
    t,
    ([cx, cy]: number[]) => {
      const host = document.querySelector("sixkey-suggest") as HTMLElement;
      const init = { bubbles: true, composed: true, cancelable: true, clientX: cx, clientY: cy, detail: 1 };
      host.click();
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
        host.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, init));
      document.elementFromPoint(cx!, cy!)?.dispatchEvent(new MouseEvent("click", init));
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // with a closed root the page has no way in; an open one would give it the button itself
      const b = host.shadowRoot?.querySelector("button");
      b?.click();
      return { root: host.shadowRoot === null, hit: document.elementFromPoint(cx!, cy!)?.tagName };
    },
    [x + wd / 2, y + h / 2],
  );
  expect(seen).toEqual({ root: true, hit: "SIXKEY-SUGGEST" });
  await untouched(t, d);
  expect(await shown(t)).toBe(true);
  await accepted(t);
});

test("K3-18: a trusted click with no pointerdown seen on the button: refused (nopd)", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  // the page swallows every pointerdown before Sixkey's listener sees it
  await onPage(t, () => addEventListener("pointerdown", (e) => e.stopImmediatePropagation(), true));
  await refused(t, /^refused:nopd$/);
});

for (const [k, f] of [
  ["removed", () => document.querySelector("sixkey-suggest")!.remove()],
  ["moved (appended again)", () => document.documentElement.append(document.querySelector("sixkey-suggest")!)],
  ["hidden attribute", () => document.querySelector("sixkey-suggest")!.setAttribute("hidden", "")],
  [
    "inert",
    () => {
      (document.querySelector("sixkey-suggest") as HTMLElement).inert = true;
    },
  ],
  ["a class", () => document.querySelector("sixkey-suggest")!.classList.add("x")],
] as const)
  test(`K3-19: our host ${k}: tamper, ended for the document`, async () => {
    const t = await newTab();
    await showIt(t);
    await armIt(t);
    const d = await decisions(t);
    await onPage(t, f);
    // a MutationObserver reports at once: within 3 s, exactly this
    await expect.poll(() => d.since(), { message: "tamper", timeout: 3000 }).toEqual(["end:tamper"]);
    expect(await shown(t)).toBe(false);
    const e = await decisions(t);
    await clickPill(t).catch(() => undefined);
    await wait(2100);
    const box = (await t.page.locator("input").boundingBox())!;
    await t.page.mouse.click(box.x + 5, box.y + 5);
    await untouched(t, e, 600);
  });

test("K3-20: the page's focus(), autofocus and its own events in the box: never shown", async () => {
  const t = await newTab();
  await onPage(t, () => {
    const i = document.querySelector("input")!;
    i.focus();
    for (const type of ["pointerdown", "mousedown", "click"])
      i.dispatchEvent(
        new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, composed: true }),
      );
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, composed: true }));
    const a = Object.assign(document.createElement("input"), {
      autofocus: true,
      maxLength: 6,
      autocomplete: "one-time-code",
    });
    document.body.append(a);
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, composed: true }));
  });
  await wait(1500);
  expect(await shown(t)).toBe(false);
  expect(await log(t)).toEqual([]);
});

test("K3-21: a page stylesheet hiding our element: drawn (the inner !important wins), and accepted", async () => {
  await baseline();
  const t = await newTab();
  await css(
    t,
    "sixkey-suggest{display:none!important;visibility:hidden!important;opacity:0!important;" +
      "content-visibility:hidden!important;position:absolute!important;transform:scale(0)!important}",
  );
  await showIt(t);
  await painted(t);
  await accepted(t);
});

for (const zoom of ["0.1", "0.5"])
  test(`K3-22: html zoom ${zoom}: applied after it shows: never armed again; a click is refused (small)`, async () => {
    const t = await newTab();
    await showIt(t);
    await armIt(t);
    // after it shows (a box this small is no code box to the finder): the page shrinks everything, the suggestion too
    await css(t, `html{zoom:${zoom}!important}`);
    await neverArmed(t, 1300);
    await refused(t, /^refused:small$/);
  });

test("K3-22: html zoom 0.9: armed, and accepted", async () => {
  const t = await newTab();
  await css(t, "html{zoom:0.9!important}");
  await showIt(t);
  await armIt(t);
  await accepted(t);
});

for (const ms of [150, 50, 10])
  test(`K3-23: a popover in a page's closed shadow root, shown ${ms} ms before the click, 20 times: the bound of §14`, async () => {
    test.setTimeout(175_000);
    const tally: Record<string, number> = {};
    let t = await newTab();
    await showIt(t);
    for (let i = 0; i < 20; i++) {
      await armIt(t);
      const d = await decisions(t);
      await cover(t, "background:#fff;pointer-events:none", { shadow: true });
      await wait(ms);
      await clickPill(t);
      const v = await d.next();
      tally[v] = (tally[v] ?? 0) + 1;
      // past IntersectionObserver's first period: refused, always; inside it, refused or (§14's residual) accepted
      if (ms === 150) expect(v).toBe("refused:hidden");
      else expect(v).toMatch(/^(refused:hidden|open)$/);
      expect(await focusIsBox(t)).toBe(true);
      if (v === "open") {
        // the popup opens with R for this page; nothing is filled
        await expect
          .poll(() => request(t.x), { timeout: 30_000 })
          .toMatchObject({ v: 2, why: "page", url: t.page.url() });
        expect(await t.page.locator("input").first().inputValue()).toBe("");
        await closePopup(t.x);
        await t.page.close();
        await dropRequest(t.x);
        t = await newTab();
        await showIt(t);
        continue;
      }
      await uncover(t);
    }
    console.log(`K3-23 tally ${ms} ms ${JSON.stringify(tally)}`);
  });

/**
 * A popover in a page's closed shadow root shown inside one of the page's frames, then the page's main thread held
 * (`pre` ms before that frame, `post` ms after it) while the user's press and release wait behind it.
 */
async function heldCover(t: Tab, pre: number, post: number, sendAfter: number): Promise<string> {
  await armIt(t);
  const [x, y, wd, h] = await pillRect(t);
  await cover(t, "background:#fff;pointer-events:none", { shadow: true, show: false });
  const d = await decisions(t);
  await onPage(
    t,
    ([pre, post]: number[]) => {
      const p = (window as unknown as { __cover: HTMLElement }).__cover;
      const hold = (ms: number) => {
        const until = performance.now() + ms;
        while (performance.now() < until);
      };
      hold(pre!); // IntersectionObserver's next look is due by the next frame
      requestAnimationFrame(() => {
        p.showPopover();
        const c = new MessageChannel();
        c.port1.onmessage = () => hold(post!); // after the frame: IntersectionObserver's report waits behind it
        c.port2.postMessage(0);
      });
    },
    [pre, post],
  );
  await wait(sendAfter);
  const at = { x: x + wd / 2, y: y + h / 2, button: "left" as const, clickCount: 1 };
  await Promise.all([
    t.s.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at }),
    t.s.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at }),
  ]);
  const v = await d.next();
  await uncover(t);
  return v;
}

test("K3-23: a cover drawn in a frame, its report not delivered yet when the queued click comes: refused (takeRecords)", async () => {
  const t = await newTab();
  await showIt(t);
  // held 130 ms before the cover's frame (so IntersectionObserver looks in it) and 110 ms after (under GAP_MS): the report
  // is computed and waits behind the click, which takeRecords reads (N-3: hidden, and only that)
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) seen.push(await heldCover(t, 130, 110, 40));
  console.log(`K3-23 takeRecords: ${JSON.stringify(seen)}`);
  expect(seen).toEqual(["refused:hidden", "refused:hidden", "refused:hidden", "refused:hidden"]);
  expect(await request(t.x)).toBeNull();
});

test("K3-23: a cover drawn in a frame, then the page's main thread held 600 ms with the click queued: refused (stale)", async () => {
  const t = await newTab();
  await showIt(t);
  for (let i = 0; i < 4; i++) expect(await heldCover(t, 0, 600, 200)).toMatch(/^refused:(hidden|early|stale)$/);
  expect(await request(t.x)).toBeNull();
});

test("K3-24: a page's @font-face named as system fonts: the words drawn exactly as on a clean page", async () => {
  const b = await baseline();
  const t = await newTab();
  const faces = ["PingFang SC", "Segoe UI", "system-ui", "-apple-system", "BlinkMacSystemFont", "sans-serif", "Arial"];
  await css(
    t,
    faces
      .map((f) => `@font-face{font-family:"${f}";src:local("Hiragino Mincho ProN"),local("Songti SC"),local("STSong")}`)
      .join("") + `body{font-family:${faces.map((f) => `"${f}"`).join(",")}}`,
  );
  await onPage(t, async () => {
    await document.fonts.load('16px "PingFang SC"');
    await document.fonts.ready;
  });
  await showIt(t);
  await armIt(t);
  await wait(100);
  expect((await pillRect(t))[2]).toBe(b.width);
  expect((await pillPixels(t)).equals(b.pixels), "the words drawn as on a clean page").toBe(true);
});

test("K3-25: the box inside a page's modal dialog: never shown; the badge only", async () => {
  const t = await newTab();
  await onPage(t, () => {
    const m = document.createElement("dialog");
    document.body.append(m);
    m.append(document.querySelector("label")!);
    m.showModal();
  });
  const id = await tabIdOf(t.page);
  const box = (await t.page.locator("input").boundingBox())!;
  await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => log(t)).toEqual(["blocked"]);
  expect(await shown(t)).toBe(false);
  expect(await worker(w!).evaluate((i) => chrome.action.getBadgeText({ tabId: i }), id)).toBe("1");
});

test("K3-26: inert on html, before the click and while the worker answers: never shown", async () => {
  const a = await newTab();
  await onPage(a, () => (document.documentElement.inert = true));
  const box = (await a.page.locator("input").boundingBox())!;
  await a.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await wait(800);
  expect(await shown(a)).toBe(false);
  expect(await log(a)).not.toContain("show");

  // the page makes its root inert in its own handler of the user's click, after Sixkey asked the worker
  const b = await newTab();
  await onPage(b, () =>
    document.addEventListener("pointerdown", () => (document.documentElement.inert = true), { once: true }),
  );
  const bb = (await b.page.locator("input").boundingBox())!;
  await b.page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await expect.poll(() => log(b)).toEqual(["blocked"]);
  expect(await shown(b)).toBe(false);
});

test("K3-27: cursorjacking (no cursor, a drawn fake, a big offset cursor): its own pointer cursor; only the real pointer's click counts", async () => {
  const t = await newTab();
  // a 128 px cursor image whose hotspot is far from what it draws
  const big = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><path d="M100 100l20 8-8 3-3 8z"/></svg>')}`;
  await css(
    t,
    `*{cursor:none!important}html{cursor:url("${big}") 0 0,auto!important}#fake{position:fixed;width:12px;height:18px;background:#000;pointer-events:none;z-index:9}`,
  );
  await onPage(t, () => {
    const f = Object.assign(document.createElement("div"), { id: "fake" });
    document.body.append(f);
    addEventListener(
      "pointermove",
      (e: PointerEvent) => (f.style.cssText = `left:${e.clientX + 150}px;top:${e.clientY}px`),
    );
  });
  await showIt(t);
  await armIt(t);
  await wait(100);
  expect(await inWorld<string>(t, "getComputedStyle(L.pill()).cursor")).toBe("pointer");
  expect(await inWorld<string>(t, "getComputedStyle(L.host()).cursor")).toBe("auto");
  // the fake cursor drawn over the suggestion, the real pointer 150 px to its left: that click is not the suggestion's
  const [x, y, wd, h] = await pillRect(t);
  const d = await decisions(t);
  await t.page.mouse.click(x + wd / 2 - 150, y + h / 2);
  await untouched(t, d);
  expect(await shown(t)).toBe(false); // a click elsewhere: hidden until the next look
  await wait(2100);
  await showIt(t);
  await armIt(t);
  await accepted(t); // the real pointer at it, the fake cursor drawn 150 px away
});

test("K3-28: a click on it before it is armed, then Enter and Space (mouse; touch): refused, and the keys go to the box", async () => {
  for (const by of ["mouse", "touch"] as const) {
    const t = await newTab();
    await showIt(t);
    await wait(300);
    const d = await decisions(t);
    const [x, y, wd, h] = await pillRect(t);
    const at = { x: x + wd / 2, y: y + h / 2 };
    if (by === "mouse") await t.page.mouse.click(at.x, at.y);
    else {
      await t.s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
      await t.s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    expect(await d.next()).toBe("refused:early");
    expect(await focusIsBox(t)).toBe(true);
    await wait(900);
    const from = await onPage(t, () => (window as unknown as { __ev: string[] }).__ev.length);
    await t.page.keyboard.press("Enter");
    await t.page.keyboard.press(" ");
    await wait(400);
    const ev = await onPage(t, (n: number) => (window as unknown as { __ev: string[] }).__ev.slice(n), from);
    expect(ev.filter((e) => e.startsWith("keydown:"))).toEqual(["keydown:INPUT", "keydown:INPUT"]);
    expect(await t.page.locator("input").first().inputValue()).toBe(" ");
    expect(await d.since()).toEqual(["refused:early"]);
    expect(await request(t.x)).toBeNull();
  }
});

test("K3-29: the box moved between the press and the release: refused (early)", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  const [x, y, wd, h] = await pillRect(t);
  await t.page.mouse.move(x + wd / 2, y + h / 2);
  const d = await decisions(t);
  await t.page.mouse.down();
  await onPage(t, () => ((document.querySelector("label") as HTMLElement).style.marginLeft = "4px"));
  await wait(50);
  await t.page.mouse.up();
  expect(await d.next()).toBe("refused:early");
  expect(await focusIsBox(t)).toBe(true);
});

test("K3-30: the page scrolled 50 ms before the click: refused (early)", async () => {
  const t = await newTab();
  await onPage(t, () => (document.body.style.minHeight = "3000px"));
  await showIt(t);
  await armIt(t);
  await onPage(t, () => scrollTo(0, 24));
  await wait(50);
  await refused(t, /^refused:early$/);
});

test("K3-31: a line inserted above the box 50 ms before the click: refused (early); it moved with the box, never over it", async () => {
  const t = await newTab();
  await showIt(t);
  await armIt(t);
  await onPage(t, () =>
    document.querySelector("h1")!.after(Object.assign(document.createElement("p"), { textContent: "A new line" })),
  );
  await wait(50);
  const box = (await t.page.locator("input").boundingBox())!;
  const [, y] = await pillRect(t);
  expect(y).toBeGreaterThanOrEqual(box.y + box.height);
  await refused(t, /^refused:early$/);
});

test("K3-32: a rapid stream of clicks, then a double-click: refused until armed, then exactly one open; nothing after it", async () => {
  const t = await newTab();
  await showIt(t);
  const [x, y, wd, h] = await pillRect(t);
  const until = Date.now() + 2500;
  while (Date.now() < until && !(await log(t)).includes("open")) {
    await t.page.mouse.click(x + wd / 2, y + h / 2);
    await wait(40);
  }
  await t.page.mouse.dblclick(x + wd / 2, y + h / 2);
  await wait(300);
  const l = (await log(t)).slice(1);
  const first = l.indexOf("open");
  expect(first).toBeGreaterThan(0);
  expect(l.slice(0, first).every((v) => /^refused:(hidden|early)$/.test(v))).toBe(true);
  expect(l.slice(0, first).filter((v) => v === "refused:early").length).toBeGreaterThanOrEqual(3);
  expect(l.slice(first + 1).every((v) => v === "refused:used")).toBe(true);
  expect(l.filter((v) => v === "open")).toHaveLength(1);
  // used: the user's next click in the box does not bring it back in this document
  await wait(2100);
  const box = (await t.page.locator("input").boundingBox())!;
  await t.page.mouse.click(box.x + 5, box.y + 5);
  await wait(800);
  expect((await log(t)).filter((v) => v === "show")).toHaveLength(1);
  expect(await shown(t)).toBe(false);
});

for (const [k, f] of [
  [
    "document.open()",
    () => {
      document.open();
      document.write("<!doctype html><title>x</title><label><input autocomplete=one-time-code maxlength=6></label>");
      document.close();
    },
  ],
  [
    "its root element replaced",
    () => {
      const h = document.createElement("html");
      h.innerHTML = "<body><label><input autocomplete=one-time-code maxlength=6></label></body>";
      document.replaceChild(h, document.documentElement);
    },
  ],
] as const)
  test(`K3-33: ${k}: tamper; nothing more in that document`, async () => {
    const t = await newTab();
    await showIt(t);
    await armIt(t);
    const d = await decisions(t);
    await onPage(t, f);
    // a MutationObserver reports at once: within 3 s, exactly this
    await expect.poll(() => d.since(), { message: "tamper", timeout: 3000 }).toEqual(["end:tamper"]);
    expect(await shown(t)).toBe(false);
    await wait(2100);
    const box = (await t.page.locator("input").boundingBox())!;
    await t.page.mouse.click(box.x + 5, box.y + 5);
    await wait(800);
    expect(await d.since()).toEqual(["end:tamper"]);
  });

// ---- 4B-FU4 (the review's P-M1): a second code box while it is shown ----

/** Two code boxes (/otcs?n=2), the second 260 px lower: the suggestion jumps a long way when it goes there. */
const twoBoxes = async () => {
  const t = await newTab("/otcs?n=2");
  await onPage(t, () => {
    (document.querySelectorAll("input")[1]!.parentElement as HTMLElement).style.marginTop = "260px";
  });
  return t;
};

test("K3-34: a key in a second code box while it is armed moves it there: the click right after the jump refused (early); its own 800 ms there", async () => {
  const t = await twoBoxes();
  await showIt(t);
  await armIt(t);
  const [, y1] = await pillRect(t);
  await wait(2200); // past the 2 s between looks
  await t.page.keyboard.press("Tab"); // as a page could move the focus itself (B.focus()) while the user types in A
  expect(await onPage(t, () => document.activeElement === document.querySelectorAll("input")[1])).toBe(true);
  await t.page.keyboard.press("1"); // the user's own key, in B
  await expect
    .poll(async () => (await pillRect(t))[1], { message: "moved to the second box", timeout: 10_000 })
    .toBeGreaterThan(y1 + 200);
  // seen there by IntersectionObserver, its clock running from that report: not armed, and a click at once is early
  await expect
    .poll(() => inWorld<boolean>(t, "L.seen()"), { message: "seen at the second box", timeout: 10_000 })
    .toBe(true);
  expect(await armed(t)).toBe(false);
  const d = await decisions(t);
  await clickPill(t);
  expect(await d.next()).toBe("refused:early");
  expect(await request(t.x)).toBeNull();
  await armIt(t); // its own 800 ms there, then the user's click is taken
  await accepted(t, { focus: "page" });
});

test("P-3: two code boxes: a click into the second while it is armed under the first moves it there, and it arms there", async () => {
  const t = await twoBoxes();
  await showIt(t);
  await armIt(t);
  const [, y1] = await pillRect(t);
  await wait(2200);
  const b = (await t.page.locator("input").nth(1).boundingBox())!;
  await t.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // hidden and shown again, in one task
  await expect
    .poll(async () => ((await shown(t)) ? (await pillRect(t))[1] : -1), {
      message: "shown at the second box",
      timeout: 10_000,
    })
    .toBeGreaterThan(y1 + 200);
  await armIt(t);
  await accepted(t, { focus: "page" });
});

// The mini-DOM models the popover's width; Chromium must also stretch the actual clickable button to it.
for (const rtl of [false, true])
  for (const edge of [false, true])
    test(`C-N2: a shorter cue holds the button's visible width, then restores without expansion (rtl=${rtl}, edge=${edge})`, async () => {
      const t = await newTab();
      await onPage(
        t,
        ({ rtl, edge }) => {
          const input = document.querySelector("input")!;
          input.style.cssText = `position:fixed;top:100px;width:120px;direction:${rtl ? "rtl" : "ltr"};left:${edge ? innerWidth - 140 : 300}px`;
        },
        { rtl, edge },
      );
      await showIt(t);
      await armIt(t);
      const label = await inWorld<string>(t, "L.pill().textContent");
      const before = await pillRect(t);
      // A page event restarts the clock; the following genuine click produces the short wait cue.
      await onPage(t, () => document.dispatchEvent(new Event("fullscreenchange")));
      await refused(t, /^refused:early$/);
      expect(await inWorld<string>(t, "L.pill().textContent")).not.toBe(label);
      const cue = await pillRect(t);
      expect(cue[0]).toBeLessThanOrEqual(before[0] + 1);
      expect(cue[0] + cue[2]).toBeGreaterThanOrEqual(before[0] + before[2] - 1);
      await expect.poll(() => inWorld<string>(t, "L.pill().textContent"), { timeout: 10_000 }).toBe(label);
      const restored = await pillRect(t);
      expect(restored[0]).toBeGreaterThanOrEqual(cue[0] - 1);
      expect(restored[0] + restored[2]).toBeLessThanOrEqual(cue[0] + cue[2] + 1);
      expect(restored[2]).toBeCloseTo(before[2], 0);
    });
