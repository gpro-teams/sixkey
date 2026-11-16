// TOTP autofill, Stage 1: the finder (src/inject/otp.ts, built as dist-e2e/inject/otp.js) in real Chromium, on synthetic pages
// (test/helpers/autofill-pages.ts), without the extension around it: what it finds, where it types, and what it refuses.
// The built file is loaded into the page's own world here, which is the harder case for a framework wrapper (React's value
// tracker is on the element in this world); test/e2e/autofill1.spec.ts runs the same file through the extension, in the
// isolated world, with the popup, the side panel and the shortcut.
import { chromium, expect, test, type Browser, type Frame, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { servePages } from "../helpers/autofill-pages";

const ENGINE = readFileSync(resolve(import.meta.dirname, "../../dist-e2e/inject/otp.js"), "utf8");
const CODE = "482915";

let browser: Browser;
let site: Awaited<ReturnType<typeof servePages>>;
test.beforeAll(async () => {
  site = await servePages();
  browser = await chromium.launch({
    channel: "chromium",
    args: [
      `--host-resolver-rules=MAP app.fix.test 127.0.0.1:${site.port}, MAP auth.fix.test 127.0.0.1:${site.port}, MAP evil.test 127.0.0.1:${site.port}`,
    ],
  });
});
test.afterAll(async () => {
  await browser.close();
  await site.close();
});

type Found = { t: string; k: 0 | 1; n: number; s: number; sent: boolean; weak: boolean; lab: string };
type Inspected = { o: string; a: string[]; top: boolean; c: Found[]; x: number; z: number };
type Filled = { ok: true; how: string } | { ok: false; r: string };
type Engine = {
  inspect(): Inspected | null;
  fill(c: string, o: string, d: string, t: string, k: string): Promise<Filled>;
};

const url = (host: string, path: string) => `http://${host}:${site.port}${path}`;
const ORIGIN = () => `http://127.0.0.1:${site.port}`;

/** What the page's console and its `message` events saw: the finder must leave neither a log nor a message behind. */
const noise = new WeakMap<Page, string[]>();
async function open(path: string, host = "127.0.0.1"): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const seen: string[] = [];
  noise.set(page, seen);
  page.on("console", (m) => seen.push(`console:${m.text()}`));
  page.on("pageerror", (e) => seen.push(`error:${e.message}`));
  await page.addInitScript(() =>
    addEventListener("message", (e) => (window as unknown as { __msgs: string[] }).__msgs?.push(String(e.data))),
  );
  await page.addInitScript(() => ((window as unknown as { __msgs: string[] }).__msgs = []));
  await page.goto(url(host, path));
  await install(page);
  return page;
}
async function install(f: Page | Frame) {
  await f.evaluate(ENGINE);
}
const inspectRaw = (f: Page | Frame) =>
  f.evaluate(() => (globalThis as unknown as { __skOtp: Engine }).__skOtp.inspect());
/** The finder's answer for a document it works in (every page of these tests but a blob: frame). */
const inspect = async (f: Page | Frame): Promise<Inspected> => (await inspectRaw(f))!;
const fill = (f: Page | Frame, code: string, origin: string, domain: string, top: string, token: string) =>
  f.evaluate(
    ([c, o, d, t, k]) => (globalThis as unknown as { __skOtp: Engine }).__skOtp.fill(c!, o!, d!, t!, k!),
    [code, origin, domain, top, token],
  );
/** Inspect, take the best box, and fill it as the extension would for a page at 127.0.0.1. */
async function fillBest(page: Page, code = CODE): Promise<{ seen: Inspected; r: Filled }> {
  const seen = await inspect(page);
  const best = seen.c.find((c) => !c.weak)!;
  expect(best, JSON.stringify(seen)).toBeDefined();
  return { seen, r: await fill(page, code, ORIGIN(), "127.0.0.1", ORIGIN(), best.t) };
}
const events = (page: Page) => page.evaluate(() => (window as unknown as { __ev: string[] }).__ev);

test("the owner's page: a plain text box whose placeholder says TOTP code, among user name, password and remember-me", async () => {
  const page = await open("/owner");
  const seen = await inspect(page);
  expect(seen).toMatchObject({ o: ORIGIN(), a: [], top: true });
  expect(seen.c).toHaveLength(1);
  expect(seen.c[0]).toMatchObject({ k: 0, n: 0, weak: false, sent: false });
  expect(seen.c[0]!.s).toBeGreaterThanOrEqual(40);
  const r = await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t);
  expect(r).toEqual({ ok: true, how: "single" });
  expect(await page.locator(".ant-input").inputValue()).toBe(CODE);
  // nothing else was touched, nothing was submitted, clicked or typed
  expect(await page.locator("[name=username]").inputValue()).toBe("");
  expect(await page.locator("[name=password]").inputValue()).toBe("");
  expect(await page.locator("[name=remember]").isChecked()).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { submitted?: boolean }).submitted)).toBeUndefined();
  expect(await events(page)).toEqual([]);
});

test("autocomplete=one-time-code: a box keeps its token across looks; a fill spends it until the next look", async () => {
  const page = await open("/otc");
  const seen = await inspect(page);
  expect(seen.c).toHaveLength(1);
  expect(seen.c[0]).toMatchObject({ k: 0, n: 6, weak: false });
  const t = seen.c[0]!.t;
  // a second look (the side panel's) between the first look and the fill does not take the token away
  expect((await inspect(page)).c[0]!.t).toBe(t);
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), t)).toEqual({ ok: true, how: "single" });
  expect(await page.locator("input").inputValue()).toBe(CODE);
  expect(await fill(page, "111111", ORIGIN(), "127.0.0.1", ORIGIN(), t)).toEqual({ ok: false, r: "gone" }); // spent
  expect(await page.locator("input").inputValue()).toBe(CODE);
  // looking again hands the same box its token again; another page's token, or a made-up one, still does nothing
  expect((await inspect(page)).c[0]!.t).toBe(t);
  expect(await fill(page, "222222", ORIGIN(), "127.0.0.1", ORIGIN(), "0000000000000000")).toEqual({
    ok: false,
    r: "gone",
  });
  const other = await open("/otc");
  expect(await fill(other, "333333", ORIGIN(), "127.0.0.1", ORIGIN(), t)).toEqual({ ok: false, r: "gone" });
  expect(await other.locator("input").inputValue()).toBe("");
});

const LABELS: [mode: string, text: string][] = [
  ["label", "Verification code"],
  ["placeholder", "Enter the 6-digit code from your authenticator app"],
  ["aria", "Two-factor authentication code"],
  ["label", "验证码"],
  ["placeholder", "请输入动态口令"],
  ["aria", "两步验证"],
  ["label", "谷歌验证器"],
  ["placeholder", "請輸入驗證碼"],
  ["label", "Código de verificación"],
  ["label", "Bestätigungscode"],
  ["placeholder", "Code de vérification"],
  ["label", "認証コード"],
  ["label", "Код подтверждения"],
  ["aria", "인증 코드"],
  ["label", "TOTP"],
];
for (const [mode, text] of LABELS)
  test(`a box named only by its ${mode} "${text}" is found and filled`, async () => {
    const page = await open(`/label?mode=${mode}&text=${encodeURIComponent(text)}`);
    const { seen, r } = await fillBest(page);
    expect(seen.c[0]!.sent).toBe(false);
    expect(r).toEqual({ ok: true, how: "single" });
    expect(await page.locator("input").inputValue()).toBe(CODE);
  });

for (const [path, n] of [
  ["/seg6", 6],
  ["/seg8", 8],
] as const)
  test(`${n} one-character boxes with auto-advance: one group, each digit in its box`, async () => {
    const page = await open(path);
    const seen = await inspect(page);
    expect(seen.c).toHaveLength(1);
    expect(seen.c[0]).toMatchObject({ k: 1, n });
    const code = n === 6 ? CODE : "48291537";
    expect(await fill(page, code, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t)).toEqual({ ok: true, how: "chars" });
    expect(
      await page.locator("#g input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join("")),
    ).toBe(code);
    expect(await events(page)).toEqual([]);
  });

test("six boxes that only understand a paste into the first: the second strategy fills them, the clipboard is untouched", async () => {
  const page = await open("/seg6-paste");
  const seen = await inspect(page);
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t)).toEqual({ ok: true, how: "paste" });
  expect(
    await page.locator("#g input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join("")),
  ).toBe(CODE);
  expect(await page.evaluate(() => (window as unknown as { __log: string[] }).__log)).toContain(`pasted:${CODE}`);
});

test("boxes that rewrite their value (a component that rejects scripted input): a refusal, not a wrong fill", async () => {
  for (const path of ["/seg6-reject", "/refuse"]) {
    const page = await open(path);
    const seen = await inspect(page);
    expect(seen.c, path).toHaveLength(1);
    expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t), path).toEqual({
      ok: false,
      r: "refused",
    });
  }
});

test("a code of the wrong length for the page: refused before anything is written", async () => {
  const four = await open("/seg4");
  const s4 = await inspect(four);
  expect(s4.c[0]).toMatchObject({ k: 1, n: 4 });
  expect(await fill(four, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), s4.c[0]!.t)).toEqual({ ok: false, r: "digits" });
  expect(
    await four.locator("#g input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join("")),
  ).toBe("");
  const short = await open("/maxlen4");
  const sh = await inspect(short);
  expect(sh.c[0]).toMatchObject({ k: 0, n: 4 });
  expect(await fill(short, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), sh.c[0]!.t)).toEqual({ ok: false, r: "digits" });
  expect(await short.locator("input").inputValue()).toBe("");
});

test("a React-controlled input (its value tracker): the state gets the code through onChange", async () => {
  const page = await open("/react");
  const { r } = await fillBest(page);
  expect(r).toEqual({ ok: true, how: "single" });
  expect(await page.evaluate(() => (window as unknown as { __state: { value: string } }).__state.value)).toBe(CODE);
  expect(await page.evaluate(() => (window as unknown as { __log: string[] }).__log)).toEqual([`onChange:${CODE}`]);
  expect(await page.locator("input").inputValue()).toBe(CODE); // and a re-render did not wipe it
});

test("Vue v-model (input) and v-model.lazy (change): both models get the code", async () => {
  for (const path of ["/vue", "/vue-lazy"]) {
    const page = await open(path);
    const { r } = await fillBest(page);
    expect(r, path).toEqual({ ok: true, how: "single" });
    expect(await page.evaluate(() => (window as unknown as { model: { code: string } }).model.code), path).toBe(CODE);
  }
});

test("search, phone, e-mail, card, ZIP, coupon, captcha and password boxes: none is found, none is written", async () => {
  const page = await open("/negatives");
  const seen = await inspect(page);
  expect(seen.c, JSON.stringify(seen)).toEqual([]);
  // even with the focus in each of them, none is offered
  for (const sel of [
    "[name=q]",
    "[name=phone]",
    "[name=card_cvc]",
    "[name=zip]",
    "[name=coupon]",
    "[name=email]",
    "[name=captcha]",
    "[name=password]",
  ]) {
    await page.locator(sel).focus();
    expect((await inspect(page)).c, sel).toEqual([]);
  }
});

test("an SMS code page: the label says the code was sent, so it is not offered as an authenticator box", async () => {
  const page = await open("/sms");
  const seen = await inspect(page);
  expect(seen.c.filter((c) => !c.weak)).toEqual([]);
});

test("no code box, hidden / invisible / disabled / read-only boxes: nothing is found", async () => {
  for (const path of ["/nofield", "/plain", "/hidden-box"]) {
    const page = await open(path);
    expect((await inspect(page)).c, path).toEqual([]);
  }
});

test("two boxes that look alike: both are listed, neither leads, nothing is chosen for the user", async () => {
  const page = await open("/two");
  const seen = await inspect(page);
  expect(seen.c).toHaveLength(2);
  expect(Math.abs(seen.c[0]!.s - seen.c[1]!.s)).toBeLessThan(20);
  expect(seen.c.map((c) => c.lab).join("|")).toMatch(/work.*personal|personal.*work/);
});

test("the focused box is offered as a weak choice only if it is no password, phone, card or search box", async () => {
  const page = await open("/owner");
  await page.locator("[name=username]").focus();
  const u = await inspect(page);
  expect(u.c.filter((c) => c.weak)).toEqual([]); // the user name box is vetoed
  await page.locator("[name=password]").focus();
  expect((await inspect(page)).c.filter((c) => c.weak)).toEqual([]);
  const plain = await open("/label?text=Reference&mode=label&len=0");
  await plain.locator("input").focus();
  const p = await inspect(plain);
  expect(p.c).toHaveLength(1);
  expect(p.c[0]!.weak).toBe(true);
});

test("a box that appears after the page loaded is found by a later look", async () => {
  const page = await open("/late");
  expect((await inspect(page)).c).toEqual([]);
  await page.waitForSelector("input", { timeout: 5000 });
  expect((await inspect(page)).c).toHaveLength(1);
});

test("shadow DOM: an open root is searched and filled, a closed one is not", async () => {
  const open_ = await open("/shadow-open");
  const { r } = await fillBest(open_);
  expect(r).toEqual({ ok: true, how: "single" });
  expect(
    await open_.evaluate(
      () => (document.getElementById("host")!.shadowRoot!.querySelector("input") as HTMLInputElement).value,
    ),
  ).toBe(CODE);
  const closed = await open("/shadow-closed");
  expect((await inspect(closed)).c).toEqual([]);
});

test("the second look: the page's own origin, host and top page are checked against what the extension passed in", async () => {
  const page = await open("/otc");
  const t = (await inspect(page)).c[0]!.t;
  const o = ORIGIN();
  const bad: [string, Parameters<typeof fill>, string][] = [
    ["another origin", [page, CODE, "http://127.0.0.1:1", "127.0.0.1", o, t], "origin"],
    ["another scheme", [page, CODE, `https://127.0.0.1:${site.port}`, "127.0.0.1", o, t], "origin"],
    ["another domain", [page, CODE, o, "example.com", o, t], "origin"],
    ["a suffix that is not a label boundary", [page, CODE, o, "0.0.1", o, t], "origin"],
    ["another top page", [page, CODE, o, "127.0.0.1", "http://evil.test", t], "frame"],
    ["an unknown box", [page, CODE, o, "127.0.0.1", o, "0000000000000000"], "gone"],
    ["a code that is no digits", [page, "12345a", o, "127.0.0.1", o, t], "args"],
    ["a code of five digits", [page, "12345", o, "127.0.0.1", o, t], "args"],
    ["a code of nine digits", [page, "123456789", o, "127.0.0.1", o, t], "args"],
    ["an origin that is no http origin", [page, CODE, "javascript:1", "127.0.0.1", o, t], "args"],
    ["a domain that is no host name", [page, CODE, o, "a b", o, t], "args"],
    ["a domain with a path", [page, CODE, o, "127.0.0.1/x", o, t], "args"],
  ];
  for (const [what, args, why] of bad) {
    expect(await fill(...args), what).toEqual({ ok: false, r: why });
    expect(await page.locator("input").inputValue(), `${what}: nothing written`).toBe("");
  }
  // and the good call still works after all those refusals (the token was never spent)
  expect(await fill(page, CODE, o, "127.0.0.1", o, t)).toEqual({ ok: true, how: "single" });
});

test("a box that stops being a code box, or leaves the page, between the look and the fill: gone, nothing written", async () => {
  const page = await open("/otc");
  const t = (await inspect(page)).c[0]!.t;
  await page.evaluate(() => document.querySelector("input")!.setAttribute("type", "email"));
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), t)).toEqual({ ok: false, r: "gone" });
  const again = await open("/otc");
  const t2 = (await inspect(again)).c[0]!.t;
  await again.evaluate(() => document.querySelector("input")!.remove());
  expect(await fill(again, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), t2)).toEqual({ ok: false, r: "gone" });
  const hidden = await open("/otc");
  const t3 = (await inspect(hidden)).c[0]!.t;
  await hidden.evaluate(() => (document.querySelector("input")!.style.display = "none"));
  expect(await fill(hidden, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), t3)).toEqual({ ok: false, r: "gone" });
  const pw = await open("/otc");
  const t4 = (await inspect(pw)).c[0]!.t;
  await pw.evaluate(() => {
    const i = document.querySelector("input")!;
    i.setAttribute("autocomplete", "current-password");
    i.setAttribute("name", "password");
  });
  expect(await fill(pw, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), t4)).toEqual({ ok: false, r: "gone" });
  expect(await pw.locator("input").inputValue()).toBe("");
});

test("a document that is not on screen is not filled (a background tab, a minimised window, the back-forward cache: AUTOFILL2 patch 3, review m2)", async () => {
  const page = await open("/otc");
  const t = (await inspect(page)).c[0]!.t;
  // what the browser says of a hidden document (headless Chromium reports every tab visible, so the test says it)
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true }),
  );
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), t)).toEqual({ ok: false, r: "gone" });
  expect(await page.locator("input").inputValue()).toBe("");
  // on screen again: the same token fills (the refusal spent nothing)
  await page.evaluate(() => delete (document as unknown as { visibilityState?: string }).visibilityState);
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), t)).toEqual({ ok: true, how: "single" });
  expect(await page.locator("input").inputValue()).toBe(CODE);
});

test("frames: a same-site frame reports its ancestors; a frame fills only with the right top page and an all-covered chain", async () => {
  const page = await (await browser.newContext()).newPage();
  const o = `http://auth.fix.test:${site.port}`;
  const top = `http://app.fix.test:${site.port}`;
  await page.goto(url("app.fix.test", `/frame?src=${encodeURIComponent(`${o}/otc`)}`));
  const inner = page.frames().find((f) => f.url().startsWith(o))!;
  await install(inner);
  const seen = await inspect(inner);
  expect(seen).toMatchObject({ o, a: [top], top: false });
  const t = seen.c[0]!.t;
  expect(await fill(inner, CODE, o, "fix.test", `http://evil.test:${site.port}`, t)).toEqual({ ok: false, r: "frame" }); // not the top page
  expect(await fill(inner, CODE, o, "other.test", top, t)).toEqual({ ok: false, r: "origin" }); // the frame's own host is not covered
  expect(await inner.locator("input").inputValue()).toBe("");
  expect(await fill(inner, CODE, o, "fix.test", top, t)).toEqual({ ok: true, how: "single" });
  expect(await inner.locator("input").inputValue()).toBe(CODE);
});

test("frames: a hostile top page around a real login page is refused by the page itself", async () => {
  const page = await (await browser.newContext()).newPage();
  const o = `http://auth.fix.test:${site.port}`;
  const evil = `http://evil.test:${site.port}`;
  await page.goto(url("evil.test", `/frame?src=${encodeURIComponent(`${o}/otc`)}`));
  const inner = page.frames().find((f) => f.url().startsWith(o))!;
  await install(inner);
  const seen = await inspect(inner);
  expect(seen.a).toEqual([evil]);
  const t = seen.c[0]!.t;
  // even if the extension were told that the top page is the evil one and the domain is the real one
  expect(await fill(inner, CODE, o, "fix.test", evil, t)).toEqual({ ok: false, r: "frame" });
  expect(await inner.locator("input").inputValue()).toBe("");
});

test("a frame of the same origin as its top page", async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url("127.0.0.1", `/frame?src=${encodeURIComponent("/otc")}`));
  const inner = page.frames().find((f) => f !== page.mainFrame())!;
  await install(inner);
  const seen = await inspect(inner);
  expect(seen).toMatchObject({ o: ORIGIN(), a: [ORIGIN()], top: false });
  expect(await fill(inner, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t)).toEqual({ ok: true, how: "single" });
});

test("looking and filling use the page's DOM read-only and write only values: the page's own element tree is unchanged", async () => {
  const page = await open("/owner");
  const before = await page.evaluate(() => document.documentElement.outerHTML.replace(/value="[^"]*"/g, ""));
  const { r } = await fillBest(page);
  expect(r.ok).toBe(true);
  const after = await page.evaluate(() => document.documentElement.outerHTML.replace(/value="[^"]*"/g, ""));
  expect(after).toBe(before);
});

test("the finder counts the visible frames of other sites it cannot enter (activeTab does not reach them), and not same-origin frames", async () => {
  const cross = await (await browser.newContext()).newPage();
  await cross.goto(url("app.fix.test", `/frame?src=${encodeURIComponent(`http://auth.fix.test:${site.port}/otc`)}`));
  await install(cross);
  expect((await inspect(cross)).x).toBe(1);
  const same = await (await browser.newContext()).newPage();
  await same.goto(url("127.0.0.1", `/frame?src=${encodeURIComponent("/otc")}`));
  await install(same);
  expect((await inspect(same)).x).toBe(0);
  expect((await inspect(await open("/otc"))).x).toBe(0);
});

test('a name that says phone keeps a box named "Verification code" out; a focused password-type box is never offered; 2 or 10 one-character boxes are no group', async () => {
  expect((await inspect(await open("/phone-verify"))).c).toEqual([]);
  const pw = await open("/pw-plain");
  await pw.locator("#p").focus();
  expect((await inspect(pw)).c).toEqual([]);
  for (const path of ["/seg2", "/seg10"]) {
    const seen = await inspect(await open(path));
    expect(
      seen.c.filter((c) => c.k === 1),
      path,
    ).toEqual([]);
  }
});

test("the code is kept nowhere after a fill: no property of the page's window, no storage, holds it", async () => {
  const page = await open("/otc");
  const { r } = await fillBest(page, "739204");
  expect(r.ok).toBe(true);
  const kept = await page.evaluate(() => {
    const hits: string[] = [];
    for (const k of Object.getOwnPropertyNames(window))
      try {
        const v = (window as unknown as Record<string, unknown>)[k];
        if (typeof v === "string" && v.includes("739204")) hits.push(k);
      } catch {
        /* a cross-origin or throwing getter */
      }
    for (const s of [localStorage, sessionStorage])
      for (let i = 0; i < s.length; i++) if ((s.getItem(s.key(i)!) ?? "").includes("739204")) hits.push("storage");
    if (document.cookie.includes("739204")) hits.push("cookie");
    return hits;
  });
  expect(kept).toEqual([]);
});

test("looking and filling log nothing and post no message to the page, for a single box and for separate boxes", async () => {
  for (const path of ["/owner", "/otc", "/seg6"]) {
    const page = await open(path);
    const seen = await inspect(page);
    await fill(page, "739204", ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t);
    await new Promise((r) => setTimeout(r, 100));
    // (the browser logs its own lines too: an autocomplete hint, a missing favicon; none may carry the code or be an error)
    expect(
      noise.get(page)!.filter((l) => l.includes("739204") || l.startsWith("error:")),
      path,
    ).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __msgs: string[] }).__msgs), path).toEqual([]);
  }
});

for (const kind of [
  "offscreen",
  "above",
  "clippath",
  "clip",
  "inert",
  "ariahidden",
  "zero",
  "tiny",
  "visibility",
  "display",
  "opacity",
  "closed",
  // hidden by an ancestor, drawn over, or digits that cannot be seen and no slots under them (the second review's F2)
  "parentclip",
  "parentoverflow",
  "parentfilter",
  "parentmask",
  "parentopacity",
  "parentclipped",
  "belowclip",
  "belowclippath",
  "covered",
  "transparent",
  "fillcolor",
  "transparentunder",
  "shadowfilter",
  "parentvisibility",
  "parentdisplay",
])
  test(`a box the user cannot see (${kind}) is neither offered nor filled`, async () => {
    const page = await open(`/hp?kind=${kind}`);
    const seen = await inspect(page);
    expect(seen.c, kind).toEqual([]);
  });

test("a real box drawn over by other elements (a transparent input over its slots, the usual OTP widget) is still found and filled", async () => {
  const page = await open("/overlay-widget");
  const { r } = await fillBest(page);
  expect(r).toEqual({ ok: true, how: "single" });
  expect(await page.locator("input").inputValue()).toBe(CODE);
});

test("a box under its own label (a floating label, drawn over the box until it is focused) is seen, and filled", async () => {
  const page = await open("/floating-label");
  const { r } = await fillBest(page);
  expect(r).toEqual({ ok: true, how: "single" });
  expect(await page.locator("input").inputValue()).toBe(CODE);
});

test("a visible real box and, elsewhere, a box whose digits cannot be seen: only the real one is offered, and it is the one that gets the code", async () => {
  const page = await open("/real-and-honey");
  const seen = await inspect(page);
  expect(seen.c).toHaveLength(1);
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t)).toEqual({ ok: true, how: "single" });
  expect(await page.locator("#real").inputValue()).toBe(CODE);
  expect(await page.locator("#honey").inputValue()).toBe("");
});

test("an OTP widget (invisible input over drawn slots) next to a plain visible box: the visible box is preferred", async () => {
  const page = await open("/widget-and-real");
  const seen = await inspect(page);
  expect(seen.c).toHaveLength(1);
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t)).toEqual({ ok: true, how: "single" });
  expect(await page.locator("#real").inputValue()).toBe(CODE);
  expect(await page.locator("#widget").inputValue()).toBe("");
});

test("a box that is covered after the look is not filled (the deep look test is made again at the fill)", async () => {
  const page = await open("/otc");
  const seen = await inspect(page);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;background:#fff;z-index:99";
    document.body.append(d);
  });
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t)).toEqual({ ok: false, r: "gone" });
  expect(await page.locator("input").inputValue()).toBe("");
});

test("a second install of the finder (the side panel looks again while the shortcut is between its look and its fill) keeps the boxes the first look found; a finder of another build starts afresh", async () => {
  // the build's name, as scripts/build.mjs makes it (a hash of the source): the built file must carry it
  const id = createHash("sha256")
    .update(readFileSync(resolve(import.meta.dirname, "../../src/inject/otp.ts")))
    .digest("hex")
    .slice(0, 16);
  expect(ENGINE.includes(id), "dist-e2e/inject/otp.js is built from src/inject/otp.ts as it is now").toBe(true);
  const page = await open("/otc");
  const first = await inspect(page);
  await install(page); // the same build again, before the fill
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), first.c[0]!.t)).toEqual({ ok: true, how: "single" });
  expect(await page.locator("input").inputValue()).toBe(CODE);
  // another build of the finder (Sixkey updated while the page stayed open): its own table, so the old token is gone
  const other = await open("/otc");
  const before = await inspect(other);
  await other.evaluate(ENGINE.replaceAll(id, "0".repeat(16)));
  expect(await fill(other, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), before.c[0]!.t)).toEqual({ ok: false, r: "gone" });
  const now = await inspect(other);
  expect(await fill(other, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), now.c[0]!.t)).toEqual({ ok: true, how: "single" });
});

test("a box whose aria-labelledby names a 1 MB block of text 200 times is looked at quickly, and still found (the block is no label)", async () => {
  const page = await open("/bigref?n=200");
  const [ms, seen] = await page.evaluate(() => {
    const t0 = performance.now();
    const r = (globalThis as unknown as { __skOtp: Engine }).__skOtp.inspect();
    return [performance.now() - t0, r] as const;
  });
  expect(seen!.c).toHaveLength(1);
  // the second review measured 1,282 ms for this page without the bounds; with them the block is read once (a few ms): the
  // bound leaves a wide margin for a busy machine
  expect(ms).toBeLessThan(400);
});

test("a page with thousands of inputs is answered fast and honestly (too complex); one with hundreds is looked through in linear time", async () => {
  const huge = await open("/many?n=20000");
  const t0 = Date.now();
  const seen = await inspect(huge);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(seen).toMatchObject({ c: [], z: 1 });
  const some = await open("/many?n=500");
  const t1 = await some.evaluate(() => performance.now());
  const found = await inspect(some);
  const took = (await some.evaluate(() => performance.now())) - t1;
  expect(found!.z).toBe(0);
  expect(found!.c).toHaveLength(1);
  expect(took).toBeLessThan(400);
});

test("filling separate boxes moves no focus (a page's focus handler would run synchronously)", async () => {
  const page = await open("/seg6-focus");
  const { r } = await fillBest(page);
  expect(r).toEqual({ ok: true, how: "chars" });
  expect(await page.evaluate(() => (window as unknown as { __focus: number }).__focus)).toBe(0);
});

test("a document that is no http(s) page (a blob: frame) is not looked at at all", async () => {
  const page = await open("/plain");
  await page.evaluate(() => {
    const url = URL.createObjectURL(
      new Blob([`<input autocomplete="one-time-code" maxlength="6">`], { type: "text/html" }),
    );
    const f = document.createElement("iframe");
    f.src = url;
    document.body.append(f);
  });
  await page.waitForFunction(() => document.querySelector("iframe")!.contentDocument?.querySelector("input"));
  const frame = page.frames().find((f) => f.url().startsWith("blob:"))!;
  await install(frame);
  expect(await inspectRaw(frame)).toBeNull();
});

test("a page of tens of thousands of elements is not walked to the end: a box past the node cap is not found, and the answer says too complex", async () => {
  const page = await open("/nodes?n=60000");
  const t0 = Date.now();
  const seen = await inspect(page);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(seen.c).toEqual([]);
  expect(seen.z).toBe(1);
});

test("separate boxes that go away when the last one is filled, and a box that is covered by the page's own element as it is written to: 'moved' (not 'filled', not 'refused')", async () => {
  const seg = await open("/seg6-hide");
  const s1 = await inspect(seg);
  expect(await fill(seg, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), s1.c[0]!.t)).toEqual({ ok: false, r: "moved" });
  const cover = await open("/cover-on-input");
  const s2 = await inspect(cover);
  expect(await fill(cover, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), s2.c[0]!.t)).toEqual({ ok: false, r: "moved" });
});

test("a page with more qualifying boxes than the finder can tell apart (17 that all say one-time code) is 'too complex', and one with 16 is not; the bound holds with the clock stopped (so it is not the time budget that answers)", async () => {
  const stopped = async (n: number) => {
    const page = await open(`/otcs?n=${n}`);
    await page.evaluate(() => (performance.now = () => 0)); // the finder's 60 ms budget never runs out
    return inspect(page);
  };
  expect(await stopped(17)).toMatchObject({ c: [], z: 1 });
  const few = await stopped(16);
  expect(few.z).toBe(0);
  expect(few.c).toHaveLength(4);
  expect(await inspect(await open("/otcs?n=30"))).toMatchObject({ c: [], z: 1 });
});

test("a look that runs out of its time (the page's thread slowed down 20 times) answers 'too complex', never a partial list of boxes", async () => {
  const page = await open("/many?n=500");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
  const seen = await inspect(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  expect(seen.z).toBe(1);
  expect(seen.c).toEqual([]);
});

test("a small page is never 'too complex' because of the clock (a pause that is not its own: a garbage collection, a busy machine): the clock counts only after some work", async () => {
  const page = await open("/otc");
  await page.evaluate(() => {
    let first = true;
    performance.now = () => (first ? ((first = false), 0) : 1e12); // every look at the clock after the start: far too late
  });
  const seen = await inspect(page);
  expect(seen.z).toBe(0);
  expect(seen.c).toHaveLength(1);
  const big = await open("/many?n=500");
  await big.evaluate(() => {
    let first = true;
    performance.now = () => (first ? ((first = false), 0) : 1e12);
  });
  expect(await inspect(big)).toMatchObject({ c: [], z: 1 });
  // the work is counted per look: a look after a big one starts from nothing again (the same finder answers every look of a page)
  const again = await open("/otcs?n=1&pad=60");
  await again.evaluate(() => (performance.now = () => 0)); // a first look of 61 inputs, on a stopped clock
  expect((await inspect(again)).c).toHaveLength(1);
  await again.evaluate(() => {
    for (const e of document.querySelectorAll("input[name=pad]")) e.remove();
    let first = true;
    performance.now = () => (first ? ((first = false), 0) : 1e12);
  });
  expect(await inspect(again)).toMatchObject({ z: 0, c: [{ k: 0 }] });
});

test("a look that runs out of its time in the deep test (the clock jumps on at the first box it looks at closely) answers 'too complex', never the boxes looked at so far", async () => {
  const page = await open("/otcs?n=3&pad=60"); // (60 inputs first: past the work after which the clock counts)
  await page.evaluate(() => {
    // the deep test is the one part of a look that asks what is on top of a box: the time runs out there, and only there
    const real = document.elementFromPoint.bind(document);
    let late = false;
    performance.now = () => (late ? 1e12 : 0);
    document.elementFromPoint = (x: number, y: number) => ((late = true), real(x, y));
  });
  expect(await inspect(page)).toMatchObject({ c: [], z: 1 });
});

test("a box that keeps the code and then hides itself (a page that moves on): not 'filled' and not 'refused' but 'moved'; a box that does not keep the code is 'refused'", async () => {
  const page = await open("/hide-on-input");
  const seen = await inspect(page);
  expect(await fill(page, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), seen.c[0]!.t)).toEqual({ ok: false, r: "moved" });
  const wipe = await open("/otc");
  await wipe.evaluate(() =>
    document.querySelector("input")!.addEventListener("input", (e) => ((e.target as HTMLInputElement).value = "")),
  );
  const s2 = await inspect(wipe);
  expect(await fill(wipe, CODE, ORIGIN(), "127.0.0.1", ORIGIN(), s2.c[0]!.t)).toEqual({ ok: false, r: "refused" });
});
