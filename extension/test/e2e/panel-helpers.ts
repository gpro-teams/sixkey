// Driving the real side panel (docs/design/notes/SIDEPANEL-NOTES.md §6). Playwright does not hand out the side panel as a
// Page, but the browser's DevTools protocol reaches both halves of it:
//   - the toolbar icon: Extensions.triggerAction on a tab target is the browser's own click on the action, the click the
//     ux-study measured with (E1, E2); it reaches action.onClicked with the tab, and grants activeTab for that tab;
//   - the panel's page: a target of type "page" at sidepanel/index.html, attached to from the browser's session, where
//     Runtime.evaluate runs in the page (as the user's own code would, not as input).
// The profile is launched with a DevTools port the browser picks (DevToolsActivePort in the profile) and
// --enable-unsafe-extension-debugging, which the Extensions domain needs. Neither is a setting of the extension.
import { chromium, expect, type Browser, type CDPSession, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST, type Profile } from "./harness";

/** The switches a driven profile is launched with; `hosts` maps names to a local server ("MAP name 127.0.0.1:port"). */
export const drivenArgs = (hosts: string[] = []) => [
  "--remote-debugging-port=0",
  "--enable-unsafe-extension-debugging",
  ...(hosts.length ? [`--host-resolver-rules=${hosts.join(", ")}`] : []),
];

export type PanelPage = {
  /** An expression evaluated in the panel's page (awaited, returned by value). */
  eval<T = unknown>(expression: string): Promise<T>;
  /** Waits until the expression is truthy in the panel. */
  until(expression: string, what: string, timeout?: number): Promise<void>;
  /**
   * The expression evaluated as the user's own action (Runtime.evaluate with userGesture): a click handler it calls has
   * the user's activation, as a real click's does, so chrome.permissions.request may answer (AUTOFILL2 patch 2).
   */
  gesture(expression: string): Promise<void>;
  /** "sixkey i18n:" errors the panel logged (a key shown without its text), as harness.ts collects them for pages. */
  missingText(): string[];
  /**
   * A DevTools protocol command in the page (the toolbar popup's, autofill-helpers.ts popupPage: a script to run before
   * the page's own at its next load, and the reload, for the site rules' updater's count of database opens, AF3-U2).
   */
  cdp?(method: string, params: Record<string, unknown>): Promise<unknown>;
};
/** A page the driver attached to, with the user's own clicks (wave 2b). */
export type DrivenPage = PanelPage & {
  /**
   * The user's own click on the element at `selector` (Input.dispatchMouseEvent at its centre: a trusted click).
   */
  click(selector: string): Promise<void>;
  /**
   * The user's click on the page's top left corner (nothing there takes a click): it gives the page the focus, after
   * which a list with Sixkey's input delay (§6.4 item 4: armed again when the window gains the focus) waits 600 ms.
   */
  focus(): Promise<void>;
};

export type Driver = {
  browser: Browser;
  bs: CDPSession;
  /** The browser's click on Sixkey's toolbar icon, on the tab whose URL contains `urlPart`. */
  clickIcon(urlPart: string): Promise<void>;
  /**
   * The browser's click on Sixkey's toolbar icon on the tab that shows `page` (AF286). Chrome runs the action for the
   * active tab of the window the given tab target is in (measured: the action on one tab's target while another tab of
   * the window is in front acts on the one in front), so `page` is brought to front first. Extensions.triggerAction takes
   * a tab target only, never the page's own target, and CDP links the two by the address they show: the page's own
   * target's, not page.url(), which a failed load's committed error page gives as chrome-error://chromewebdata/ while
   * its tab shows the address that failed. Several tabs at that address (one window): the first. None: this throws.
   */
  clickIconOn(page: Page): Promise<void>;
  /** How many side panels of Sixkey are open (chrome.runtime.getContexts in the worker). */
  panels(): Promise<number>;
  /** How many toolbar popups of Sixkey are open (the same, POPUP contexts). */
  popups(): Promise<number>;
  /**
   * Sixkey's toolbar popup, as the browser's click on the icon opens it on the tab at `urlPart` (no Sixkey page may be
   * open in a tab then: it is found by its address); its page, and how to close it (Target.closeTarget).
   */
  popup(urlPart: string): Promise<DrivenPage & { close(): Promise<void> }>;
  /** The open side panel's page (waits for exactly one). */
  panel(): Promise<DrivenPage>;
  /** Sixkey's toolbar popup that something other than a test's click opened (wave 2b: Sixkey itself), once it is open. */
  openedPopup(): Promise<DrivenPage & { close(): Promise<void> }>;
  /** Every open side panel's page (one per window that has one). */
  allPanels(): Promise<DrivenPage[]>;
  /** What every panel attached to so far logged as a key without its text. */
  missingText(): string[];
  close(): Promise<void>;
};

/** Text keys shown without their text, by profile: the pages' console (as harness.ts watches it) and the panel's. */
const missingText = new WeakMap<Profile, string[]>();

/**
 * A profile as harness.ts launch() makes one (harness.ts is frozen: export-helpers.ts), with the DevTools port, and its
 * pages' console watched for keys shown without their text. `extensions`: more unpacked extensions loaded beside Sixkey
 * (a test's own). `dist`: the build loaded, the e2e build's unless another is named (the store build's, dist/). Close it
 * with closeDriven().
 */
export async function launchDriven(
  hosts: string[] = [],
  extraArgs: string[] = [],
  extensions: readonly string[] = [],
  dist: string = DIST,
): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  const all = [dist, ...extensions].join(",");
  const ctx = await chromium.launchPersistentContext(dir, {
    // SK_CHROME: another browser binary, e.g. a wrapper that starts Playwright's Chromium in another UI language (on macOS
    // `-AppleLanguages '(zh-CN)'`; --lang is not read there), so a spec runs in Simplified Chinese (AUTOFILL2-NOTES §13).
    ...(process.env.SK_CHROME ? { executablePath: process.env.SK_CHROME } : { channel: "chromium" }),
    args: [`--disable-extensions-except=${all}`, `--load-extension=${all}`, ...drivenArgs(hosts), ...extraArgs],
    acceptDownloads: true,
  });
  let id = "";
  if (!extensions.length) {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    id = new URL(sw.url()).host;
  } else {
    // with other extensions: Sixkey's worker is the one whose extension is named "Sixkey (e2e)" (as harness.ts finds it)
    while (ctx.serviceWorkers().length < extensions.length + 1) await ctx.waitForEvent("serviceworker");
    for (const sw of ctx.serviceWorkers())
      if ((await sw.evaluate(() => chrome.runtime.getManifest().name)) === "Sixkey (e2e)") id = new URL(sw.url()).host;
    if (!id) throw new Error("Sixkey's service worker is not among the extensions loaded");
  }
  const p: Profile = { dir, ctx, id };
  const found: string[] = [];
  missingText.set(p, found);
  const watch = (page: Page) =>
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().startsWith("sixkey i18n:")) found.push(m.text());
    });
  ctx.pages().forEach(watch);
  ctx.on("page", watch);
  return p;
}

/** Closes the profile; fails if any page, the panel included (`d`), showed a key without its text. */
export async function closeDriven(p: Profile, d?: Driver): Promise<void> {
  const missing = [...(missingText.get(p) ?? []), ...(d?.missingText() ?? [])];
  await d?.close();
  await p.ctx.close();
  rmSync(p.dir, { recursive: true, force: true });
  if (missing.length)
    throw new Error(`message keys were shown without their text:\n${[...new Set(missing)].join("\n")}`);
}

export async function drive(p: Profile): Promise<Driver> {
  const port = readFileSync(join(p.dir, "DevToolsActivePort"), "utf8").split("\n")[0];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const bs = await browser.newBrowserCDPSession();
  const sw = p.ctx.serviceWorkers().find((w) => new URL(w.url()).host === p.id)!;
  let next = 1;
  const waiting = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  const missing: string[] = [];
  bs.on("Target.receivedMessageFromTarget", (e: { message: string }) => {
    const m = JSON.parse(e.message) as {
      id?: number;
      method?: string;
      params?: { type?: string; args?: { value?: unknown }[] };
      result?: unknown;
      error?: { message: string };
    };
    if (m.id !== undefined) waiting.get(m.id)?.(m);
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
      const text = String(m.params.args?.[0]?.value ?? "");
      if (text.startsWith("sixkey i18n:")) missing.push(text);
    }
  });
  const panels = () =>
    sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL" as never] })).length);
  const popups = () =>
    sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["POPUP" as never] })).length);
  const targetsAt = async (path: string) => {
    const { targetInfos } = (await bs.send("Target.getTargets")) as {
      targetInfos: { targetId: string; url: string; type: string }[];
    };
    return targetInfos.filter((t) => t.url === `chrome-extension://${p.id}/${path}`).map((t) => t.targetId);
  };
  const panelTargets = () => targetsAt("sidepanel/index.html");
  const attach = async (targetId: string): Promise<DrivenPage> => {
    const { sessionId } = (await bs.send("Target.attachToTarget", { targetId, flatten: false } as never)) as {
      sessionId: string;
    };
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
        const id = next++;
        waiting.set(id, (r) => {
          waiting.delete(id);
          resolve(r);
        });
        void bs.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        } as never);
      });
    await call("Runtime.enable", {});
    const run = async <T>(expression: string): Promise<T> => {
      const r = (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
        result?: { result?: { value?: T }; exceptionDetails?: { text: string } };
        error?: { message: string };
      };
      if (r.error) throw new Error(r.error.message);
      if (r.result?.exceptionDetails) throw new Error(`in the panel: ${r.result.exceptionDetails.text}: ${expression}`);
      return r.result?.result?.value as T;
    };
    return {
      eval: run,
      async until(expression, what, timeout = 10_000) {
        await expect
          .poll(() => run<boolean>(`!!(${expression})`).catch(() => false), { message: what, timeout })
          .toBe(true);
      },
      async gesture(expression) {
        const r = (await call("Runtime.evaluate", { expression, userGesture: true })) as {
          error?: { message: string };
        };
        if (r.error) throw new Error(r.error.message);
      },
      async click(selector) {
        const at = await run<{ x: number; y: number } | null>(
          `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        if (!at) throw new Error(`no ${selector} to click`);
        for (const type of ["mousePressed", "mouseReleased"])
          await call("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
      },
      async focus() {
        for (const type of ["mousePressed", "mouseReleased"])
          await call("Input.dispatchMouseEvent", { type, x: 1, y: 1, button: "left", clickCount: 1 });
      },
      missingText: () => [...missing],
    };
  };
  const clickIcon = async (urlPart: string) => {
    const { targetInfos } = (await bs.send("Target.getTargets", { filter: [{ type: "tab" }] } as never)) as {
      targetInfos: { targetId: string; url: string }[];
    };
    const tab = targetInfos.find((t) => t.url.includes(urlPart));
    if (!tab) throw new Error(`no tab at ${urlPart}: ${targetInfos.map((t) => t.url).join(", ")}`);
    await bs.send("Extensions.triggerAction" as never, { id: p.id, targetId: tab.targetId } as never);
  };
  const clickIconOn = async (page: Page) => {
    await page.bringToFront();
    const own = await page.context().newCDPSession(page);
    let url: string;
    try {
      url = ((await own.send("Target.getTargetInfo")) as { targetInfo: { url: string } }).targetInfo.url;
    } finally {
      await own.detach().catch(() => undefined);
    }
    const { targetInfos } = (await bs.send("Target.getTargets", { filter: [{ type: "tab" }] } as never)) as {
      targetInfos: { targetId: string; url: string }[];
    };
    const tab = targetInfos.find((t) => t.url === url);
    if (!tab) throw new Error(`no tab at ${url}: ${targetInfos.map((t) => t.url).join(", ")}`);
    await bs.send("Extensions.triggerAction" as never, { id: p.id, targetId: tab.targetId } as never);
  };
  return {
    browser,
    bs,
    clickIcon,
    clickIconOn,
    panels,
    popups,
    async popup(urlPart) {
      if ((await targetsAt("popup/index.html")).length) throw new Error("a Sixkey page is open at the popup's address");
      await clickIcon(urlPart);
      let ids: string[] = [];
      await expect
        .poll(async () => (ids = await targetsAt("popup/index.html")).length, { message: "the toolbar popup" })
        .toBe(1);
      await expect.poll(popups, { message: "a POPUP context" }).toBe(1);
      const page = await attach(ids[0]!);
      return { ...page, close: async () => void (await bs.send("Target.closeTarget", { targetId: ids[0]! } as never)) };
    },
    async openedPopup() {
      let ids: string[] = [];
      await expect.poll(popups, { message: "a POPUP context" }).toBe(1);
      await expect
        .poll(async () => (ids = await targetsAt("popup/index.html")).length, { message: "the toolbar popup" })
        .toBe(1);
      const page = await attach(ids[0]!);
      return { ...page, close: async () => void (await bs.send("Target.closeTarget", { targetId: ids[0]! } as never)) };
    },
    async panel() {
      await expect.poll(panels, { message: "a side panel is open" }).toBe(1);
      let ids: string[] = [];
      await expect.poll(async () => (ids = await panelTargets()).length, { message: "the side panel's page" }).toBe(1);
      return attach(ids[0]!);
    },
    async allPanels() {
      const ids = await panelTargets();
      return Promise.all(ids.map(attach));
    },
    missingText: () => [...missing],
    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}
