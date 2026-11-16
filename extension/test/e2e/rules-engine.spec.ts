// TOTP autofill Stage 3, AF3-2: the finder's side of a site rule (src/inject/otp.ts, built as dist-e2e/inject/otp.js) in real
// Chromium, without the extension: the hint a Fill path's look passes, the token kinds (the plan's M2), the rule-made entries
// a look with an argument replaces (R3-1), the boost conditions on real boxes with selectors that really match them (S1),
// every box of a group checked at the look and at the fill, and a selector that throws (R4-2). docs/design/notes/
// AUTOFILL3-NOTES.md §3. The pages are written here and served by the browser context's routes at their own host names
// (rules.fix.test, other.fix.test); nothing else is reached. As in autofill-engine.spec.ts, the finder is loaded into the
// page's own world.
import { chromium, expect, test, type Browser, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE = readFileSync(resolve(import.meta.dirname, "../../dist-e2e/inject/otp.js"), "utf8");
const CODE = "482915";
const HOST = "rules.fix.test";
const TOP = `http://${HOST}`;

type Found = { t: string; k: 0 | 1; n: number; s: number; sent: boolean; weak: boolean; lab: string; r?: 1 };
type Inspected = { o: string; a: string[]; top: boolean; c: Found[]; x: number; z: number };
type Filled = { ok: true; how: string } | { ok: false; r: string };
type Hint = { d: string[]; p: { at: string; sel: string; n: number; how: 0 | 1 | 2 }[]; sent: boolean };
type Engine = {
  inspect(h?: unknown): Inspected | null;
  fill(c: string, o: string, d: string, t: string, k: string): Promise<Filled>;
  of(el: unknown): string | null;
};

const head = (t: string, css = "") =>
  `<!doctype html><meta charset="utf-8"><title>${t}</title><style>body{font:16px sans-serif}` +
  `.row{display:flex;gap:6px}.row input{width:34px;height:40px;text-align:center}${css}</style>`;
const digits = (cls: string, n: number, extra = (_i: number) => "") =>
  Array.from(
    { length: n },
    (_, i) => `<input class="${cls}" id="b${i + 1}" aria-label="Digit ${i + 1}"${extra(i)}>`,
  ).join("");
/** A paste on the first box puts one digit in each (a component that splits a paste); `clear`: typing into a box is undone. */
const splitter = (sel: string, clear = false) => `<script>
  const boxes = [...document.querySelectorAll(${JSON.stringify(sel)})];
  boxes.forEach((b) => b.addEventListener("input", () => { if (${clear}) b.value = ""; }));
  boxes[0].addEventListener("paste", (e) => {
    e.preventDefault();
    const t = (e.clipboardData.getData("text/plain") || "").replace(/\\D/g, "");
    boxes.forEach((x, j) => { x.value = t[j] || ""; });
    window.__log.push("pasted");
  });
</script>`;
const LOG = `<script>window.__log = [];</script>`;

const NEG = `${head("Negatives")}${LOG}<form onsubmit="return false">
    <p><input type="password" id="p1"></p>
    <p><input name="cardNumber" id="c1"></p>
    <p><input type="tel" name="phone" id="t1"></p>
    <p><input type="search" name="q" id="s1"></p>
    <p><input name="coupon" id="k1" placeholder="Promo code"></p>
    <p><input name="username" id="u1"></p>
    <p><input name="zip" id="z1"></p>
    <p><input id="n1"></p>
  </form>`;
/** The pages, by host and path. */
const PAGES: Record<string, string> = {
  // six boxes without maxlength (no heuristic group), the first one autocomplete=one-time-code: the heuristics see six
  // single boxes, the first a strong one; the rule sees one group
  [`${HOST}/2fa`]: `${head("Six")}${LOG}<p>Enter the code</p><div class="row" id="row">${digits("d", 6, (i) => (i ? "" : ' autocomplete="one-time-code"'))}</div>${splitter("#row input")}`,
  // the same boxes, each undoing what is typed into it: only a paste works
  [`${HOST}/2fa-paste`]: `${head("Paste only")}${LOG}<p>Enter the code</p><div class="row" id="row">${digits("d", 6)}</div>${splitter("#row input", true)}`,
  // six one-character boxes (a heuristic group) on a plain page
  [`${HOST}/seg`]: `${head("Seg")}${LOG}<div>Enter your verification code<div class="row" id="g">${digits("g", 6, () => ' maxlength="1" inputmode="numeric"')}</div></div>`,
  // the boxes a rule must never promote, each by its own selector, and one neutral box (the control)
  [`${HOST}/neg`]: NEG,
  "other.fix.test/neg": NEG,
  // one box per rule entry: two that share a class, one with a hidden copy, one in a heuristic group, rows that are not one
  [`${HOST}/n`]: `${head("Counts", ".low{margin-top:40px}.wide{width:80px!important}")}${LOG}
    <p><input class="two"> <input class="two"></p>
    <p><input class="tpl" style="display:none"><input class="tpl" id="tpl"></p>
    <div class="row" id="g">${digits("g", 6, () => ' maxlength="1"')}</div>
    <div class="row" id="r1">${digits("e", 6)}</div>
    <div class="row" id="r2"><input class="f"><input class="f"><input class="f"><input class="f low"><input class="f"><input class="f"></div>
    <div class="row" id="r3"><input class="w"><input class="w"><input class="w"><input class="w wide"><input class="w"><input class="w"></div>`,
  // groups the page names as no code box, two levels above their boxes (the review of AF3-2, S1: its H3 and H4)
  [`${HOST}/card`]: `${head("Card")}${LOG}<div><p>Card number</p><div class="row">${digits("seg", 4)}</div></div>`,
  // a group whose name the page can change after the look (the words of its grandparent: short, as a label is)
  [`${HOST}/named`]: `${head("Named")}${LOG}<div><p id="nm">Enter the code</p><div class="row">${digits("seg", 6)}</div></div>`,
  [`${HOST}/phone`]: `${head("Phone")}${LOG}<div><p>Phone number</p><div class="row">${digits("seg", 6, () => ' maxlength="1"')}</div></div>`,
  // a strong box for the heuristics and a neutral one for a rule
  [`${HOST}/both`]: `${head("Both")}${LOG}<p><input autocomplete="one-time-code" id="h1"></p><p><input id="n1"></p>`,
  [`${HOST}/frames`]: `${head("Frames")}${LOG}<iframe id="same" src="${TOP}/neg" width="400" height="700"></iframe><iframe id="other" src="http://other.fix.test/neg" width="400" height="700"></iframe>`,
};

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => {
  await browser.close();
});

async function context(): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    const body = u.protocol === "http:" ? PAGES[`${u.hostname}${u.pathname}`] : undefined;
    return body === undefined
      ? route.abort()
      : route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  return ctx;
}
async function open(path: string): Promise<Page> {
  const page = await (await context()).newPage();
  await page.goto(`${TOP}${path}`);
  await page.evaluate(ENGINE);
  return page;
}
/** The look of a Fill path (one argument: the hint, or null), or the content script's (none). */
const look = (f: Page | Frame, ...hint: [Hint | null] | []) =>
  f.evaluate(
    ([h, n]) => {
      const e = (globalThis as unknown as { __skOtp: Engine }).__skOtp;
      return (n ? e.inspect(h) : e.inspect())!;
    },
    [hint[0] ?? null, hint.length] as const,
  );
/** A fill as the extension makes it for an account registered for the page's own host. */
const fill = (f: Page | Frame, t: string, code = CODE) =>
  f.evaluate(([c, o, d, k]) => (globalThis as unknown as { __skOtp: Engine }).__skOtp.fill(c, o, d, o, k), [
    code,
    TOP,
    HOST,
    t,
  ] as const);
const values = (page: Page, sel: string) => page.$$eval(sel, (els) => (els as HTMLInputElement[]).map((e) => e.value));
const rule = (sel: string, n = 0, how: 0 | 1 | 2 = 0, at = "/", d = [HOST], sent = false): Hint => ({
  d,
  p: [{ at, sel, n, how }],
  sent,
});
const ruled = (s: Inspected) => s.c.filter((c) => c.r === 1);

test("M2: hint, then a hint-less look with the focus in the first box, then the fill: the rule's group whole, with its strategy; the first box alone is refused", async () => {
  const page = await open("/2fa");
  const G = rule("input.d", 6, 2, "/2fa");
  const hinted = await look(page, G);
  expect(ruled(hinted)).toHaveLength(1);
  const g = ruled(hinted)[0]!;
  expect(g).toMatchObject({ k: 1, n: 6, r: 1, weak: false });
  expect(g.s).toBeGreaterThanOrEqual(100);
  expect(hinted.c.filter((c) => c.r !== 1)).toEqual([]); // the rule's entry stands for its boxes
  // the content script's look (no argument), with the focus in b1: it sees b1 alone, under the heuristics' token
  await page.focus("#b1");
  const plain = await look(page);
  const b1 = plain.c.find((c) => c.k === 0 && c.s >= 40)!;
  expect(b1, JSON.stringify(plain)).toBeDefined();
  expect(b1.r).toBeUndefined();
  expect(b1.t).not.toBe(g.t);
  expect(await page.evaluate(() => (globalThis as any).__skOtp.of(document.getElementById("b1")))).toBe(b1.t);
  // a box the rule groups is never filled alone
  expect(await fill(page, b1.t)).toEqual({ ok: false, r: "gone" });
  expect(await values(page, "#row input")).toEqual(["", "", "", "", "", ""]);
  // the rule's token still stands for the six boxes and their strategy (paste first: the page splits it)
  expect(await fill(page, g.t)).toEqual({ ok: true, how: "paste" });
  expect(await values(page, "#row input")).toEqual([...CODE]);
});

test("the strategy is the rule's: chars only refuses where only a paste works; auto and paste first fill it", async () => {
  for (const [how, want] of [
    [1, { ok: false, r: "refused" }],
    [0, { ok: true, how: "paste" }],
    [2, { ok: true, how: "paste" }],
  ] as const) {
    const page = await open("/2fa-paste");
    const g = ruled(await look(page, rule("input.d", 6, how)))[0]!;
    expect(await fill(page, g.t), `how ${how}`).toEqual(want);
    await page.context().close();
  }
});

test("R3-1: a look with an argument replaces the rule's entries: after the page moves on, the first box fills as the heuristics see it", async () => {
  const G = rule("input.d", 6, 0, "/2fa");
  const changes: [string, (p: Page) => Promise<unknown>][] = [
    ["another path (a single-page app)", (p) => p.evaluate(() => history.pushState({}, "", "/elsewhere"))],
    [
      "a seventh box",
      (p) => p.evaluate(() => document.getElementById("row")!.insertAdjacentHTML("beforeend", '<input class="d">')),
    ],
    [
      "a box turned vetoed",
      (p) => p.evaluate(() => document.getElementById("b4")!.setAttribute("autocomplete", "cc-number")),
    ],
    ["no hint (the look of a Fill path today)", async () => undefined],
  ];
  for (const [what, change] of changes) {
    const page = await open("/2fa");
    const g = ruled(await look(page, G))[0]!;
    expect(g, what).toBeDefined();
    await change(page);
    const again = await look(page, what.startsWith("no hint") ? null : G);
    expect(ruled(again), what).toEqual([]);
    const b1 = again.c.find((c) => c.k === 0 && !c.weak)!;
    expect(b1, `${what}: ${JSON.stringify(again)}`).toBeDefined();
    expect(await fill(page, g.t), what).toEqual({ ok: false, r: "gone" }); // the old group is no longer
    expect(await fill(page, b1.t), what).toEqual({ ok: true, how: "single" });
    expect((await values(page, "#b1"))[0], what).toBe(CODE);
    await page.context().close();
  }
});

test("R3-1: only a look with an argument touches the rule's entries; the content script's look leaves them, however often", async () => {
  const page = await open("/2fa");
  const g = ruled(await look(page, rule("input.d", 6, 2, "/2fa")))[0]!;
  for (let i = 0; i < 3; i++) await look(page);
  expect(await fill(page, g.t)).toEqual({ ok: true, how: "paste" });
});

test("S1: a rule promotes no password, card, phone, search, coupon, user-name or zip box, whatever its selector; a neutral box it does", async () => {
  const page = await open("/neg");
  const plain = await look(page, null);
  for (const sel of [
    "#p1",
    'input[type="password"]',
    "#c1",
    'input[name="cardNumber"]',
    "#t1",
    'input[type="tel"]',
    "#s1",
    "#k1",
    "#u1",
    "#z1",
  ]) {
    const seen = await look(page, rule(sel));
    expect(ruled(seen), sel).toEqual([]);
    expect(
      seen.c.map(({ t, s, weak }) => ({ t, s, weak })),
      sel,
    ).toEqual(plain.c.map(({ t, s, weak }) => ({ t, s, weak })));
  }
  const n1 = ruled(await look(page, rule("#n1")));
  expect(n1).toHaveLength(1);
  expect(n1[0]).toMatchObject({ k: 0, r: 1, weak: false });
  expect(n1[0]!.s).toBeGreaterThanOrEqual(100);
  expect(await fill(page, n1[0]!.t)).toEqual({ ok: true, how: "single" });
  expect((await values(page, "#n1"))[0]).toBe(CODE);
  for (const id of ["p1", "c1", "t1", "s1", "k1", "u1", "z1"]) expect((await values(page, `#${id}`))[0], id).toBe("");
});

test("S1: a rule group with a password box is no group at the look, and is refused at the fill when the page swaps one in after it", async () => {
  const page = await open("/2fa");
  await page.evaluate(() => ((document.getElementById("b3") as HTMLInputElement).type = "password"));
  expect(ruled(await look(page, rule("input.d", 6)))).toEqual([]);
  await page.evaluate(() => ((document.getElementById("b3") as HTMLInputElement).type = "text"));
  const g = ruled(await look(page, rule("input.d", 6)))[0]!;
  await page.evaluate(() => ((document.getElementById("b3") as HTMLInputElement).type = "password"));
  expect(await fill(page, g.t)).toEqual({ ok: false, r: "gone" });
  // a hard negative on a later box, too (its name, after the look)
  await page.evaluate(() => ((document.getElementById("b3") as HTMLInputElement).type = "text"));
  const h = ruled(await look(page, rule("input.d", 6)))[0]!;
  await page.evaluate(() => document.getElementById("b5")!.setAttribute("name", "phone"));
  expect(await fill(page, h.t)).toEqual({ ok: false, r: "gone" });
  expect(await values(page, "#row input")).toEqual(["", "", "", "", "", ""]);
});

test("S1: a group the page names as a card or a phone number is not promoted, at the look or at the fill (the review of AF3-2)", async () => {
  for (const [path, n] of [
    ["/card", 4],
    ["/phone", 6],
  ] as const) {
    const page = await open(path);
    const plain = await look(page, null);
    expect(
      plain.c.filter((c) => !c.weak),
      path,
    ).toEqual([]); // the heuristics do not offer it
    // each box alone has nothing against it; the group's own name has
    const seen = await look(page, rule("input.seg", n));
    expect(ruled(seen), path).toEqual([]);
    expect(seen, path).toEqual(plain);
    await page.context().close();
  }
  // the page names the group so after the look: the rule's group is refused at the fill
  const page = await open("/named");
  const g = ruled(await look(page, rule("input.seg", 6)))[0]!;
  expect(g).toBeDefined();
  await page.evaluate(() => (document.getElementById("nm")!.textContent = "Phone number"));
  expect(await fill(page, g.t)).toEqual({ ok: false, r: "gone" });
  expect(await values(page, "input.seg")).toEqual(["", "", "", "", "", ""]);
  // and named back as a code, it fills
  await page.evaluate(() => (document.getElementById("nm")!.textContent = "Enter the code"));
  const again = ruled(await look(page, rule("input.seg", 6)))[0]!;
  expect(await fill(page, again.t)).toEqual({ ok: true, how: "chars" });
});

test("every box of a heuristic group is checked, at the look and at the fill, not only the first", async () => {
  const page = await open("/seg");
  const seen = await look(page, null);
  const g = seen.c.find((c) => c.k === 1)!;
  expect(g).toMatchObject({ n: 6, weak: false });
  await page.evaluate(() => document.getElementById("b4")!.setAttribute("name", "password"));
  expect(await fill(page, g.t)).toEqual({ ok: false, r: "gone" });
  expect(await values(page, "#g input")).toEqual(["", "", "", "", "", ""]);
  expect((await look(page, null)).c.filter((c) => c.k === 1)).toEqual([]);
  expect((await look(page)).c.filter((c) => c.k === 1)).toEqual([]);
  // the box made a code box again: the group is back, and fills
  await page.evaluate(() => document.getElementById("b4")!.removeAttribute("name"));
  const back = (await look(page, null)).c.find((c) => c.k === 1)!;
  expect(back.t).toBe(g.t);
  expect(await fill(page, back.t)).toEqual({ ok: true, how: "chars" });
});

test("counts: one box is exactly one usable match outside a heuristic group; a group is exactly n on one line of one size", async () => {
  const page = await open("/n");
  const one = async (sel: string, n = 0) => ruled(await look(page, rule(sel, n)));
  expect(await one(".two")).toEqual([]); // two matches
  expect(await one(".tpl")).toHaveLength(1); // a hidden copy does not count
  expect(await one('#g input[aria-label="Digit 1"]')).toEqual([]); // a box of a heuristic group
  expect(await one("#g input", 6)).toHaveLength(1); // the group itself, named by a rule
  expect(await one(".e", 6)).toHaveLength(1);
  expect(await one(".e", 5)).toEqual([]);
  expect(await one(".e", 8)).toEqual([]);
  expect(await one(".f", 6)).toEqual([]); // not on one line
  expect(await one(".w", 6)).toEqual([]); // not of one size
  expect(await one(".e")).toEqual([]); // six matches for one box
  // an entry with a box an earlier entry named is void: a box belongs to one rule entry
  const twice: Hint = {
    d: [HOST],
    p: [
      { at: "/", sel: ".e", n: 6, how: 0 },
      { at: "/", sel: "#r1 input", n: 6, how: 0 },
      { at: "/", sel: ".tpl", n: 0, how: 0 },
      { at: "/", sel: "#tpl", n: 0, how: 0 },
    ],
    sent: false,
  };
  const both = ruled(await look(page, twice));
  expect(both.map((c) => c.k)).toEqual([1, 0]);
});

test("the rule's box comes first, with the rule's sent flag; its path is a prefix; another host's rule does nothing", async () => {
  const page = await open("/both");
  const seen = await look(page, rule("#n1", 0, 0, "/bo", [HOST], true));
  expect(seen.c[0]).toMatchObject({ r: 1, sent: true });
  expect(seen.c[1]).toMatchObject({ k: 0, weak: false });
  expect(seen.c[1]!.r).toBeUndefined();
  expect(ruled(await look(page, rule("#n1", 0, 0, "/both/x")))).toEqual([]);
  expect(ruled(await look(page, rule("#n1", 0, 0, "/", ["other.fix.test"])))).toEqual([]);
  expect(ruled(await look(page, rule("#n1", 0, 0, "/", ["fix.test"])))).toEqual([]);
});

test("frames: the rule applies in a frame of its host, never in one of another host", async () => {
  const page = await open("/frames");
  const same = page.frame({ url: `${TOP}/neg` })!;
  const other = page.frame({ url: "http://other.fix.test/neg" })!;
  for (const f of [same, other]) await f.evaluate(ENGINE);
  expect(ruled(await look(same, rule("#n1")))).toHaveLength(1);
  expect(ruled(await look(other, rule("#n1")))).toEqual([]);
});

test("R4-2: an entry whose selector throws is skipped; the other entries and the heuristics go on", async () => {
  const page = await open("/both");
  await page.evaluate(() => {
    const real = Element.prototype.matches;
    Element.prototype.matches = function (s: string) {
      if (s === "#boom") throw new DOMException("not a selector", "SyntaxError");
      return real.call(this, s);
    };
  });
  const h: Hint = {
    d: [HOST],
    p: [
      { at: "/", sel: "#boom", n: 0, how: 0 },
      { at: "/", sel: "#n1", n: 0, how: 0 },
    ],
    sent: false,
  };
  const seen = await look(page, h);
  expect(ruled(seen)).toHaveLength(1);
  expect(seen.c.some((c) => c.r === undefined && !c.weak)).toBe(true); // the heuristics' box is still there
});

test("a hint that is not one is no hint: the look is the heuristics' alone, and a look with null is the content script's", async () => {
  const page = await open("/2fa");
  const plain = await look(page);
  expect(await look(page, null)).toEqual(plain);
  for (const bad of [
    { ...rule("input.d", 6), x: 1 },
    { ...rule("input.d", 6), d: [] },
    rule("input:focus", 0),
    rule("input.d", 3),
    rule("input.d", 0, 2),
    "input.d",
  ])
    expect(await look(page, bad as Hint)).toEqual(plain);
});
