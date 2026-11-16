// TOTP autofill Stage 2, patch 4b (docs/design/notes/AUTOFILL2-NOTES.md §13): the in-page suggestion, driven in a real page
// of the e2e build (its release gate open). The suggestion lives in a closed shadow root, so the tests read it the way its
// own world does: the e2e build's content script keeps a record of its decisions and its nodes in Sixkey's isolated world
// (`__skSugLog`, that build only), which a CDP session reads from the extension's execution context in the page. Every
// input is the browser's own (CDP mouse and keyboard), so it is trusted, as a user's.
import { expect, type CDPSession, type Page } from "@playwright/test";
import { GRANTED_TLS, world, type World } from "./autofill-helpers";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const worker = (x: World) => x.p.ctx.serviceWorkers()[0]!;
const setSites = (x: World, hosts: string[]) =>
  worker(x).evaluate((h) => chrome.storage.local.set({ sk_af_sites: { v: 1, hosts: h } }), hosts);
const registered = (x: World) =>
  worker(x).evaluate(
    async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ["sk-suggest"] }))[0]?.matches ?? null,
  );

/**
 * The test's own record of the worker's side (no product code: wrappers the test puts on the worker's chrome APIs, and a
 * listener of its own that answers nothing): each `cand` as it arrives, and each browser call of the `cand` path with its
 * time, -1 while unanswered. Read when a suggestion does not show, to say which call, if any, never answered.
 */
async function instrument(x: World): Promise<void> {
  await worker(x).evaluate(() => {
    const log: { what: string; at: number; ms: number }[] = [];
    (globalThis as unknown as { __skCalls: typeof log }).__skCalls = log;
    const add = (what: string) => {
      const e = { what, at: Date.now(), ms: -1 };
      log.push(e);
      if (log.length > 400) log.shift();
      return e;
    };
    const wrap = (o: Record<string, unknown>, name: string, what: string) => {
      const f = (o[name] as (...a: unknown[]) => unknown).bind(o);
      o[name] = (...a: unknown[]) => {
        const e = add(what);
        const r = f(...a);
        Promise.resolve(r).then(
          () => (e.ms = Date.now() - e.at),
          () => (e.ms = -2),
        );
        return r;
      };
    };
    const c = chrome as unknown as Record<string, Record<string, Record<string, unknown>>>;
    wrap(c.storage!.session!, "get", "session.get");
    wrap(c.storage!.session!, "set", "session.set");
    wrap(c.storage!.local!, "get", "local.get");
    wrap(c.permissions as unknown as Record<string, unknown>, "contains", "permissions.contains");
    wrap(c.commands as unknown as Record<string, unknown>, "getAll", "commands.getAll");
    for (const n of ["setBadgeText", "setBadgeBackgroundColor", "setTitle"])
      wrap(c.action as unknown as Record<string, unknown>, n, `action.${n}`);
    chrome.runtime.onMessage.addListener((m: unknown) => {
      if ((m as { type?: string })?.type === "sk-af-cand") add("cand arrived").ms = 0;
    });
  });
}

/** A world whose granted https fixture host is a site turned on, with the content script registered for it. */
export async function grantedWorld(args: string[] = []): Promise<World> {
  const x = await world({ surface: "popup", tls: true, args });
  await instrument(x).catch((e) => console.log(`instrument(): the worker's calls not recorded: ${e}`));
  await setSites(x, [GRANTED_TLS]);
  await expect
    .poll(() => registered(x), { message: "the registration", timeout: 60_000 })
    .toEqual([`https://${GRANTED_TLS}/*`]);
  return x;
}

/** One tab on the granted site, and the suggestion's world in it. */
export type Tab = { page: Page; s: CDPSession; ctx: () => Promise<number>; x: World };
export async function tab(x: World, path = "/otc"): Promise<Tab> {
  const page = await x.p.ctx.newPage();
  const s = await page.context().newCDPSession(page);
  let ids: number[] = [];
  s.on("Runtime.executionContextCreated", (e: { context: { id: number; origin: string } }) => {
    if (e.context.origin === `chrome-extension://${x.p.id}`) ids.push(e.context.id);
  });
  s.on("Runtime.executionContextsCleared", () => void (ids = []));
  await s.send("Runtime.enable");
  await page.goto(`https://${GRANTED_TLS}${path}`);
  await page.bringToFront();
  const ctx = async () => {
    for (let i = 0; i < 50 && !ids.length; i++) await wait(50);
    return ids[ids.length - 1] ?? -1;
  };
  const t = { page, s, ctx, x };
  // the content script is in the page (document_idle) before the user's first click
  await expect
    .poll(() => inWorld<boolean>(t, "!!L").catch(() => false), { message: "the content script", timeout: 30_000 })
    .toBe(true);
  return t;
}

/** An expression evaluated in the suggestion's own world (`L` is its record). */
export async function inWorld<T>(t: Tab, expr: string): Promise<T> {
  const r = (await t.s.send("Runtime.evaluate", {
    expression: `(() => { const L = globalThis.__skSugLog; return (${expr}); })()`,
    contextId: await t.ctx(),
    returnByValue: true,
  })) as { result: { value?: T }; exceptionDetails?: unknown };
  if (r.exceptionDetails) throw new Error(`in the suggestion's world: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value as T;
}
export const log = (t: Tab) => inWorld<string[]>(t, "L ? L.log.slice() : []");
export const shown = (t: Tab) => inWorld<boolean>(t, "!!L && L.shown()");
export const armed = (t: Tab) => inWorld<boolean>(t, "!!L && L.armed()");
/** The suggestion's button, where it is drawn: [x, y, width, height]. */
export const pillRect = (t: Tab) =>
  inWorld<[number, number, number, number]>(
    t,
    "(() => { const r = L.pill().getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()",
  );

/** The user's click into the code box: the suggestion shows. */
export async function showIt(t: Tab, selector = "input"): Promise<void> {
  // as a user would, if a click brought nothing (a worker slow to wake, or its answer lost): once more after the 2 s
  // between looks, and once more after the answer is overdue (ASK_MS, 20 s: the content script then asks again)
  const start = Date.now();
  for (const [at, until] of [
    [0, 5000],
    [5000, 21_500],
    [21_500, 51_500],
  ] as const) {
    while (Date.now() - start < at) await wait(50);
    const box = await t.page.locator(selector).first().boundingBox();
    if (!box) throw new Error("no code box");
    await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    while (Date.now() - start < until) {
      if (await shown(t)) return;
      await wait(20);
    }
  }
  // which side stalled: the worker's own answer time to the test, now, its Web Locks (held and waiting) and a storage read
  const t0 = Date.now();
  await worker(t.x).evaluate(() => 1);
  const ms = Date.now() - t0;
  const w = await worker(t.x).evaluate(async (host) => {
    // each API the worker's answer to `cand` awaits, timed (5 s at most): which one, if any, does not answer
    const time = async (f: () => Promise<unknown>) => {
      const at = performance.now();
      try {
        await Promise.race([f(), new Promise((_, no) => setTimeout(() => no(new Error("over 5 s")), 5000))]);
        return Math.round(performance.now() - at);
      } catch (e) {
        return String((e as Error).message ?? e);
      }
    };
    const q = await navigator.locks.query();
    const tabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1;
    return {
      held: (q.held ?? []).map((l) => l.name),
      waiting: (q.pending ?? []).map((l) => l.name),
      session: await time(() => chrome.storage.session.get("sk_sug_shown")),
      // a write to a key of the test's own, inside a lock of its own, as the worker writes its records
      lockedWrite: await time(() =>
        navigator.locks.request("sixkey-e2e-probe", () => chrome.storage.session.set({ sk_e2e_probe: Date.now() })),
      ),
      local: await time(() => chrome.storage.local.get("sk_af_sites")),
      permissions: await time(() => chrome.permissions.contains({ origins: [`https://${host}/*`] })),
      commands: await time(() => chrome.commands.getAll()),
      badge: await time(() => chrome.action.getBadgeText({ tabId })),
      title: await time(() => chrome.action.getTitle({ tabId })),
    };
  }, GRANTED_TLS);
  const calls = await worker(t.x).evaluate((since) => {
    const l = (globalThis as unknown as { __skCalls?: { what: string; at: number; ms: number }[] }).__skCalls ?? [];
    return l.filter((e) => e.at >= since).map((e) => `${e.what}@${e.at - since}:${e.ms}`);
  }, start);
  throw new Error(
    `the suggestion not shown: cand ${JSON.stringify(await inWorld(t, "L.asks"))}, ${JSON.stringify(await log(t))}; ` +
      `the worker answered the test in ${ms} ms; its locks and a session read: ${JSON.stringify(w)}; ` +
      `the worker's calls since the first click (what@ms after it:ms taken, -1 unanswered): ${JSON.stringify(calls)}`,
  );
}
export const armIt = (t: Tab) =>
  expect.poll(() => armed(t), { message: "the suggestion armed", timeout: 30_000 }).toBe(true);

/** The decisions made from now on: `next()` waits for the first new one and returns it. */
export async function decisions(t: Tab) {
  const from = (await log(t)).length;
  return {
    next: async (): Promise<string> => {
      await expect
        .poll(async () => (await log(t)).length, { message: "a decision", timeout: 30_000 })
        .toBeGreaterThan(from);
      return (await log(t))[from]!;
    },
    since: async (): Promise<string[]> => (await log(t)).slice(from),
  };
}
/** The user's click at the suggestion's button (where it is drawn now). */
export async function clickPill(t: Tab): Promise<void> {
  const [x, y, w, h] = await pillRect(t);
  await t.page.mouse.click(x + w / 2, y + h / 2);
}
/** The button's pixels, inset from its rounded edge and shadow: equal for equal drawings. */
export async function pillPixels(t: Tab): Promise<Buffer> {
  const [x, y, w, h] = await pillRect(t);
  return t.page.screenshot({ clip: { x: x + 6, y: y + 6, width: Math.max(1, w - 12), height: Math.max(1, h - 12) } });
}
/** The request R in storage.session, as the worker wrote it (or null). */
export const request = (x: World) =>
  worker(x).evaluate(async () => (await chrome.storage.session.get("sk_fill_req")).sk_fill_req ?? null);
export const dropRequest = (x: World) => worker(x).evaluate(() => chrome.storage.session.remove("sk_fill_req"));
export { wait };

/** The page's own view: the code box has the focus (the suggestion never takes it). */
export const focusIsBox = (t: Tab) => t.page.evaluate(() => document.activeElement === document.querySelector("input"));
/** The popup the worker opened (its DevTools target), waited for. */
async function popupTarget(x: World): Promise<string> {
  const url = `chrome-extension://${x.p.id}/popup/index.html`;
  let id = "";
  await expect
    .poll(
      async () => {
        const { targetInfos } = (await x.d.bs.send("Target.getTargets")) as {
          targetInfos: { targetId: string; url: string; type: string }[];
        };
        id = targetInfos.find((i) => i.url === url && i.type !== "tab")?.targetId ?? "";
        return id;
      },
      { message: "the popup", timeout: 30_000 },
    )
    .not.toBe("");
  return id;
}

/** The popup the worker opened, closed (one popup at a time: the next `open` would fail to show its own). */
export const closePopup = async (x: World) =>
  x.d.bs.send("Target.closeTarget", { targetId: await popupTarget(x) } as never);

/**
 * The user's click on the suggestion, accepted: its one message sent, the worker's request R v2 written for this page
 * before the popup opened in this window; nothing filled (the popup asks). The popup is closed and R dropped after.
 */
/** The clicks that `accepted()` made again after a `refused:stale`, in this run (the spec reports them at its end). */
export const staleRetries = { n: 0 };
export async function accepted(t: Tab, o: { focus?: "box" | "page" } = {}): Promise<void> {
  let v = "";
  for (let i = 0; i < 2; i++) {
    const d = await decisions(t);
    await clickPill(t);
    v = await d.next();
    if (v !== "refused:stale" || i === 1) break;
    // a pause in its frames (a loaded machine) restarts its clock, as a page's held rendering does: armed again, once.
    // Counted: a case that needs a second retry fails, so the set keeps saying how often a real click is refused
    staleRetries.n++;
    console.log("accepted(): refused:stale after a frame pause; armed again and clicked again (one retry allowed)");
    await armIt(t);
  }
  expect(v, "accepted, with at most one retry after a pause in its frames").toBe("open");
  if (o.focus === "page")
    expect(await t.page.evaluate(() => document.activeElement?.tagName)).not.toBe("SIXKEY-SUGGEST");
  else expect(await focusIsBox(t)).toBe(true);
  await expect
    .poll(() => request(t.x), { message: "R v2 for this page", timeout: 30_000 })
    .toMatchObject({ v: 2, why: "page", host: GRANTED_TLS, url: t.page.url() });
  await closePopup(t.x);
  expect(await t.page.locator("input").first().inputValue()).toBe("");
  await dropRequest(t.x);
}
/** The user's click on the suggestion, refused for the reason `why`: nothing sent, no R, the focus where it was. */
export async function refused(t: Tab, why: RegExp): Promise<void> {
  const d = await decisions(t);
  await clickPill(t);
  expect(await d.next()).toMatch(why);
  expect(await focusIsBox(t)).toBe(true);
  expect(await request(t.x)).toBeNull();
}
/** No decision at all within `ms` (a click that never reached the suggestion's button). */
export async function untouched(t: Tab, d: { since(): Promise<string[]> }, ms = 400): Promise<void> {
  await wait(ms);
  expect(await d.since()).toEqual([]);
  expect(await request(t.x)).toBeNull();
}

/** A page's own top-layer element over the suggestion's button (`popover="manual"`), in the light DOM or a closed shadow root. */
export async function cover(t: Tab, css: string, o: { shadow?: boolean; show?: boolean } = {}): Promise<void> {
  const [x, y, w, h] = await pillRect(t);
  await t.page.evaluate(
    async ([x, y, w, h, css, shadow, show]) => {
      const p = document.createElement("div");
      p.id = "cover";
      p.popover = "manual";
      p.style.cssText =
        `position:fixed;inset:auto;margin:0;border:0;padding:0;left:${x - 4}px;top:${y - 4}px;` +
        `width:${w + 8}px;height:${h + 8}px;${css}`;
      if (shadow) {
        const host = document.createElement("div");
        host.id = "cover-host";
        document.body.append(host);
        host.attachShadow({ mode: "closed" }).append(p);
      } else document.body.append(p);
      (window as unknown as { __cover: HTMLElement }).__cover = p;
      if (!show) return;
      const toggled = new Promise((r) => p.addEventListener("toggle", r, { once: true }));
      p.showPopover();
      await toggled;
    },
    [x, y, w, h, css, !!o.shadow, o.show !== false] as const,
  );
}
export const uncover = (t: Tab) =>
  t.page.evaluate(() => {
    const w = window as unknown as { __cover?: HTMLElement };
    w.__cover?.remove();
    document.getElementById("cover-host")?.remove();
    delete w.__cover;
  });
