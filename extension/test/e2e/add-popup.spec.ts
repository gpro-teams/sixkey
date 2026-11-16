// B3 (U1): "paste anything" in the popup and its confirm page. A paste goes straight to the confirm page, which shows
// what will be added but never the key, dedupes by key bytes, and adds with "Add and copy code". Real keyboard pastes
// (ControlOrMeta+V with the text on the clipboard) except for the screenshot, which is a synthetic paste event
// carrying an image, as the plan says (PHASE0X-PLAN B3).
import { expect, test, type Page } from "@playwright/test";
import {
  acceptable,
  addByPaste,
  AWS_URI,
  close,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  qrPng,
  SECRET,
  startFresh,
  type Profile,
} from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const PW = "Hunter2-Correct!Horse";
const OTHER = "JBSWY3DPEHPK3PXP"; // a second key, for "the same account with a new key"

/** Put text on the clipboard and press the paste shortcut where the focus is, as a person would. */
async function pasteText(page: Page, text: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+V");
}

/** The clipboard once it holds a code (copying finishes just after the toast appears). */
async function clipboard(page: Page): Promise<string> {
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\d{6,8}$/);
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The popup's add view, with the paste zone focused. */
async function addView(page: Page) {
  await page.locator(".pf .add").click();
  await expect(page.locator("#pa-box")).toBeFocused();
}

/** Nothing in the page, text or attribute, may hold the key. */
async function noKeyIn(page: Page, ...keys: string[]) {
  const all = await page.evaluate(
    () =>
      document.documentElement.outerHTML +
      "\n" +
      [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join("\n"),
  );
  for (const k of keys) {
    expect(all).not.toContain(k);
    expect(all.toLowerCase()).not.toContain(k.toLowerCase());
  }
}

test("paste a link on Add account: the confirm page shows the account, never the key; Add and copy code copies a working code", async () => {
  await startFresh(p);
  const pop = await openPopup(p);
  await expect(pop.locator("#empty-paste")).toBeVisible(); // the empty list offers paste and scan
  await expect(pop.locator("#empty-scan")).toBeVisible();
  await pop.locator("#empty-paste").click();
  await expect(pop.locator("#pa-box")).toBeFocused();
  await pasteText(pop, GITHUB_URI);

  await expect(pop.locator("#pa-issuer")).toHaveValue("GitHub");
  await expect(pop.locator("#pa-label")).toHaveValue("alice@example.com");
  await expect(pop.locator(".cf-card")).toContainText(/6.*30.*SHA1/);
  await expect(pop.locator(".cf-next")).toContainText(/clock|时间/);
  await expect(pop.locator("#pa-verdict")).toHaveCount(0); // new: no prompt
  await noKeyIn(pop, SECRET);

  await pop.locator("#pa-add-copy").click();
  await expect(pop.locator(".row")).toHaveCount(1);
  await expect(pop.locator(".row .who b")).toHaveText("GitHub");
  await expect(pop.locator(".toast")).toContainText(/[Cc]opied|已复制/);
  expect(await acceptable(SECRET)).toContain(await clipboard(pop));
  expect((pop as Page & { _errors: string[] })._errors).toEqual([]);
});

test("pasting an account that is already there says so and adds nothing, even when the key is written differently", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(1);
  await addView(pop);
  // the same key in lower case, with "=" padding, under the same issuer: not the same text, the same key bytes
  await pasteText(pop, `otpauth://totp/GitHub:someone?secret=${SECRET.toLowerCase()}%3D%3D&issuer=GitHub`);
  await expect(pop.locator("#pa-verdict")).toContainText(/Already in Sixkey|已在 Sixkey 中/);
  await expect(pop.locator("#pa-add-copy")).toHaveCount(0);
  await expect(pop.locator("#pa-add")).toHaveCount(0);
  // "Copy" copies the existing account's code instead
  await pop.locator("#pa-copy").click();
  await expect(pop.locator(".row")).toHaveCount(1);
  await expect(pop.locator(".toast")).toContainText(/[Cc]opied|已复制/);
  expect(await acceptable(SECRET)).toContain(await clipboard(pop));
});

test("Ctrl+V on the list opens the confirm page; in the search box it stays an ordinary paste; not while editing", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(1);

  await pop.locator("#q").focus();
  await pasteText(pop, "github");
  await expect(pop.locator("#q")).toHaveValue("github");
  await expect(pop.locator("#pa-issuer")).toHaveCount(0);
  await pop.locator("#q").fill("");

  await pop.locator(".row .copy").first().focus(); // focus in the list, not in a text field
  await pasteText(pop, AWS_URI);
  await expect(pop.locator("#pa-issuer")).toHaveValue("AWS");
  await expect(pop.locator(".cf-card")).toContainText(/8.*30/);
  await pop.locator(".ph .back").click();
  await expect(pop.locator(".row")).toHaveCount(1); // back to the list, nothing added

  await pop.locator(".row .more").first().click();
  await expect(pop.locator("#e-issuer")).toBeFocused();
  await pop.locator(".sheet .acts .btn.quiet").focus();
  await pasteText(pop, AWS_URI);
  await expect(pop.locator("#pa-issuer")).toHaveCount(0); // the edit sheet is still open, nothing else happened
  await expect(pop.locator("#e-issuer")).toHaveValue("GitHub");
});

test("a pasted screenshot of a QR code is read; an image without one, or text that is not a key, adds nothing", async () => {
  await startFresh(p);
  const pop = await openPopup(p);
  await expect(pop.locator("#empty-paste")).toBeVisible(); // the list is up (a person cannot paste before that either)
  const send = (png: number[]) =>
    pop.evaluate((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png);

  await send([...qrPng(GITHUB_URI)]);
  await expect(pop.locator("#pa-issuer")).toHaveValue("GitHub");
  await noKeyIn(pop, SECRET);
  await pop.locator("#pa-add").click(); // Add only
  await expect(pop.locator(".row .who b")).toHaveText("GitHub");
  await expect(pop.locator(".toast")).toContainText(/Added GitHub|已添加 GitHub/);

  // a plain white picture: no code in it
  await pop.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 240;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 240, 240);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "blank.png", { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(pop.locator(".cf-alert.bad")).toContainText(/Nothing to add|没有可添加/);
  await expect(pop.locator(".cf-alert.bad")).toContainText(/No QR code|没有找到二维码/);
  await expect(pop.locator(".cf-alert.bad")).toContainText(/Nothing to add|没有可添加/);
  await pop.locator("#pa-back").click();

  await pop.locator(".row .copy").first().focus();
  await pasteText(pop, "hello world");
  await expect(pop.locator(".cf-alert.bad")).toContainText(/Nothing to add|没有可添加/);
  await expect(pop.locator(".cf-alert.bad")).toContainText(/not a link or a key|不是链接，也不是密钥/); // the settings page's reason
  await pop.locator("#pa-back").click();
  await expect(pop.locator(".row")).toHaveCount(1);
});

test("name|key|password lines go on in Settings: the popup shows none of their content and adds nothing", async () => {
  await startFresh(p);
  const pop = await openPopup(p);
  await addView(pop);
  await pasteText(pop, `GitHub|${SECRET}|${PW}\nAWS|${OTHER}|${PW}-2`);
  await expect(pop.locator("#pa-settings")).toBeVisible();
  await expect(pop.locator(".cf-alert")).toContainText(/several columns|多列/);
  await expect(pop.locator("#pa-issuer, #pa-add, #pa-add-copy, #pa-list")).toHaveCount(0);
  await noKeyIn(pop, SECRET, OTHER, PW, "GitHub", "AWS");
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#pa-settings").click()]);
  await opt.waitForLoadState();
  expect(opt.url()).toContain("options/index.html#add-paste");
  // nothing was handed over through session storage (which holds only the unlocked session): the user pastes again
  const session = await opt.evaluate(() => chrome.storage.session.get(null));
  expect(Object.keys(session).sort()).toEqual(["sk_session"]);
  for (const k of [SECRET, OTHER, PW, "GitHub"]) expect(JSON.stringify(session)).not.toContain(k);
  await expect(opt.locator("#paste-box")).toHaveValue("");
});

test("the same account with a new key: keep both, or replace, which moves the old one to the trash", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await addView(pop);
  await pasteText(pop, `otpauth://totp/GitHub:alice@example.com?secret=${OTHER}&issuer=GitHub`);
  await expect(pop.locator("#pa-verdict")).toContainText(/different key|密钥不同/);
  await expect(pop.locator("#pa-keep")).toBeChecked(); // never replaces unless asked
  await pop.locator("#pa-replace").check();
  await pop.locator("#pa-add").click();
  await expect(pop.locator(".row")).toHaveCount(1);
  await expect(pop.locator(".row .code")).toHaveText(/\d{3}\D*\d{3}/);
  const code = (await pop.locator(".row .code").textContent())!.replace(/\D/g, "");
  expect(await acceptable(OTHER)).toContain(code); // the new key is the one in the list

  const opt = await openOptions(p, "#trash");
  await expect(opt.locator("#trash")).toContainText("GitHub"); // the old one, restorable
});

test("a Google export with two accounts offers Add 2 and copies nothing; one already saved is shown and not ticked", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await addView(pop);
  await pasteText(
    pop,
    migrationUri([
      { secret: base32Bytes(SECRET), name: "alice@example.com", issuer: "GitHub" },
      { secret: base32Bytes(OTHER), name: "root", issuer: "AWS" },
      { secret: base32Bytes("MFRGGZDFMZTWQ2LK"), name: "team", issuer: "Zoom" },
    ]),
  );
  await expect(pop.locator("#pa-list li")).toHaveCount(3);
  await expect(pop.locator("#pa-list li", { hasText: "GitHub" }).locator("input")).toBeDisabled();
  await expect(pop.locator("#pa-add-copy")).toHaveCount(0);
  await expect(pop.locator("#pa-add")).toContainText(/2/);
  await noKeyIn(pop, SECRET, OTHER);
  await pop.locator("#pa-add").click();
  await expect(pop.locator(".row")).toHaveCount(3);
  await expect(pop.locator(".toast")).toContainText(/Added 2|已添加 2/);
});

test("in a tab there is no current site: no 'Show first on' box; Scan reports that this page cannot be captured", async () => {
  // The popup knows the page it was opened on only as the real toolbar popup (activeTab); that case, with the box ticked
  // when the name matches the site, is checked in the CDP run against the real popup (PHASE0X-PLAN B2 and §4).
  await startFresh(p);
  const pop = await openPopup(p);
  await pop.locator("#empty-scan").click();
  await expect(pop.locator(".toast")).toContainText(/Could not capture|无法截取/);
  await addView(pop);
  await pasteText(pop, GITHUB_URI);
  await expect(pop.locator("#pa-issuer")).toHaveValue("GitHub");
  await expect(pop.locator("#pa-site")).toHaveCount(0);
});

/**
 * The popup as if opened over `url`: a popup opened as a tab has no current page, so the active-tab query is answered
 * here (as popup-text.spec.ts does), which brings in the site sections and the confirm page's "Show first on" box.
 */
async function popupOn(url: string): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.addInitScript((u) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    const fake = (async (q: chrome.tabs.QueryInfo) => (q?.active ? [{ url: u }] : real(q))) as typeof chrome.tabs.query;
    Object.defineProperty(chrome.tabs, "query", { configurable: true, value: fake });
  }, url);
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);
  return page;
}

test('AFMATCH: "Show first on" starts ticked for a name guessed from 3 characters up, never for a guess of 2', async () => {
  await startFresh(p);
  // "ws" on ws.g.test: related by a name of 2, so the box is there but not ticked, and the account is added without a site
  let pop = await popupOn("https://ws.g.test/admin/");
  await addView(pop);
  await pasteText(pop, `otpauth://totp/ws:admin?secret=${OTHER}&issuer=ws`);
  await expect(pop.locator("#pa-issuer")).toHaveValue("ws");
  await expect(pop.locator("#pa-site")).toHaveCount(1);
  await expect(pop.locator("label:has(#pa-site)")).toContainText("ws.g.test");
  await expect(pop.locator("#pa-site")).not.toBeChecked();
  await pop.locator("#pa-add").click();
  await expect(pop.locator(".sect.related .row .who b")).toHaveText(["ws"]);
  await expect(pop.locator(".sect.site")).toHaveCount(0);
  await pop.close();
  // "GitHub" on github.test, as before: ticked, and added as "This site"
  pop = await popupOn("https://github.test/login");
  await addView(pop);
  await pasteText(pop, GITHUB_URI);
  await expect(pop.locator("#pa-issuer")).toHaveValue("GitHub");
  await expect(pop.locator("#pa-site")).toBeChecked();
  await pop.locator("#pa-add").click();
  await expect(pop.locator(".sect.site .row .who b")).toHaveText(["GitHub"]);
});

test("Add account is styled from the first frame it is drawn in: its stylesheet comes with its chunk (AF3-4t)", async () => {
  // the view's rules are in its own add.css (docs/design/notes/BUDGET-NOTES.md §9), which the bundler's preload loads
  // before the view's code runs: when its first choice is in the page, and before the browser paints, it is drawn with them
  await startFresh(p);
  const pop = await openPopup(p);
  await pop.evaluate(() => {
    const w = window as unknown as { __first?: Record<string, string> };
    new MutationObserver((_, o) => {
      const opt = document.querySelector(".opt");
      const foot = document.querySelector(".opts-foot");
      if (!opt || !foot) return;
      const a = getComputedStyle(opt);
      const b = getComputedStyle(foot);
      w.__first = {
        display: a.display,
        radius: a.borderTopLeftRadius,
        columns: a.gridTemplateColumns,
        foot: b.display,
      };
      o.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
  });
  await addView(pop);
  const first = await pop.evaluate(() => (window as unknown as { __first?: Record<string, string> }).__first);
  expect(first).toMatchObject({ display: "grid", radius: "14px", foot: "flex" });
  expect(first!.columns).toMatch(/^38px \d/);
  expect((pop as Page & { _errors: string[] })._errors).toEqual([]);
});

test("Add account in the side panel is styled from its first frame too (AF3-4t; the review's NIT, done with AF3-4)", async () => {
  // the same view in the side panel's page (sidepanel/index.html, opened here as a tab: the same scripts and stylesheets),
  // whose own stylesheet places the view's list: the view's rules come with its chunk there too
  await startFresh(p);
  const panel = await p.ctx.newPage();
  await panel.setViewportSize({ width: 360, height: 720 });
  await panel.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
  await expect(panel.locator(".pf .add")).toBeVisible();
  await panel.evaluate(() => {
    const w = window as unknown as { __first?: Record<string, string> };
    new MutationObserver((_, o) => {
      const opt = document.querySelector(".opt");
      const foot = document.querySelector(".opts-foot");
      if (!opt || !foot) return;
      const a = getComputedStyle(opt);
      const b = getComputedStyle(foot);
      w.__first = {
        display: a.display,
        radius: a.borderTopLeftRadius,
        columns: a.gridTemplateColumns,
        foot: b.display,
      };
      o.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
  });
  await addView(panel);
  const first = await panel.evaluate(() => (window as unknown as { __first?: Record<string, string> }).__first);
  expect(first).toMatchObject({ display: "grid", radius: "14px", foot: "flex" });
  expect(first!.columns).toMatch(/^38px \d/);
  await panel.close();
});

test("a counter-based (HOTP) account is saved and marked, with no code to copy", async () => {
  await startFresh(p);
  const pop = await openPopup(p);
  await addView(pop);
  await pasteText(pop, `otpauth://hotp/Bank:me?secret=${OTHER}&issuer=Bank&counter=5`);
  await expect(pop.locator(".cf-card")).toContainText(/counter|计数型/);
  await expect(pop.locator(".cf-line")).toContainText(/HOTP/);
  await expect(pop.locator("#pa-add-copy")).toHaveCount(0);
  await pop.locator("#pa-add").click();
  await expect(pop.locator(".row .who b")).toHaveText("Bank");
  await expect(pop.locator(".row .otp.hotp")).toContainText(/counter|计数型/);
});

// --- a tiny Google Authenticator export writer (protobuf), for the test only ---------------------------------------
type MEntry = { secret: number[]; name: string; issuer: string };
function base32Bytes(s: string): number[] {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    acc = (acc << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}
function migrationUri(entries: MEntry[]): string {
  const varint = (n: number) => {
    const o: number[] = [];
    do {
      let b = n & 127;
      n >>>= 7;
      if (n) b |= 128;
      o.push(b);
    } while (n);
    return o;
  };
  const lf = (no: number, b: number[]) => [...varint((no << 3) | 2), ...varint(b.length), ...b];
  const vf = (no: number, n: number) => [...varint(no << 3), ...varint(n)];
  const str = (s: string) => [...new TextEncoder().encode(s)];
  const one = (e: MEntry) => [
    ...lf(1, e.secret),
    ...lf(2, str(e.name)),
    ...lf(3, str(e.issuer)),
    ...vf(4, 1),
    ...vf(5, 1),
    ...vf(6, 2),
  ];
  const bytes = [...entries.flatMap((e) => lf(1, one(e))), ...vf(2, 1), ...vf(3, 1), ...vf(4, 0), ...vf(5, 7)];
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...bytes)))}`;
}
