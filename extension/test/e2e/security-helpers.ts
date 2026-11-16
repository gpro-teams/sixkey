// Helpers for the security record tests (PHASE0X-PLAN C7). harness.ts is frozen after A1 (§0.5), so they live here.
import { expect, type Page } from "@playwright/test";
import { STRONG } from "./harness";

export const WRONG = "Wrong#Guess9!Zebra4$Pine";

/** The record as stored (sk_security_log), read from any extension page; undefined when there is none. */
export function record(
  page: Page,
): Promise<{ v?: number; entries?: { at: number; kind: string }[]; failed?: number } | undefined> {
  return page.evaluate(async () => (await chrome.storage.local.get("sk_security_log")).sk_security_log as never);
}
export const failedCount = async (page: Page) => (await record(page))?.failed;

/** The popup's lock button, then the lock screen. */
export async function lockPopup(pop: Page): Promise<void> {
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await expect(pop.locator("#secret")).toBeVisible();
}

/** `n` wrong master passwords at the lock screen, each one recorded before the next. */
export async function guessWrong(pop: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const before = (await failedCount(pop)) ?? 0;
    await pop.locator("#secret").fill(WRONG);
    await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect.poll(() => failedCount(pop)).toBe(before + 1);
  }
}

/** The right password at the lock screen, then the list. */
export async function unlockPopup(pop: Page, password = STRONG): Promise<void> {
  await pop.locator("#secret").fill(password);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator("#q")).toBeVisible();
}

/**
 * An init script for the popup: a timeline of the security record's reads and writes (with the keys asked for), the
 * first code on screen, and the notice going in and getting its frame. `inject`: once `window.__c7inject` is set, the
 * first read of the record also adds a wrong password to it before answering, as another page could just after the
 * popup read the count.
 */
export function popupTrace() {
  if (!location.pathname.endsWith("/popup/index.html")) return;
  type Ev = [string, number];
  const g = globalThis as unknown as { __c7: Ev[]; __c7inject?: boolean; __c7reset: () => void };
  g.__c7 = [];
  const at = () => performance.now();
  const area = chrome.storage.local;
  const get = area.get.bind(area) as (k?: unknown) => Promise<Record<string, unknown>>;
  const set = area.set.bind(area) as (items: Record<string, unknown>) => Promise<void>;
  const has = (k: unknown) =>
    k == null
      ? true
      : Array.isArray(k)
        ? k.includes("sk_security_log")
        : k === "sk_security_log" || (typeof k === "object" && "sk_security_log" in (k as object));
  (area as unknown as { get: unknown }).get = async (k?: unknown) => {
    const mine = has(k);
    if (mine) g.__c7.push([`get:${JSON.stringify(k)}`, at()]);
    const r = await get(k);
    if (mine && g.__c7inject) {
      g.__c7inject = false;
      const log = r.sk_security_log as {
        v: number;
        entries: { at: number; kind: string }[];
        failed: number;
        ackAt?: number;
      };
      await set({
        sk_security_log: {
          ...log,
          entries: [...log.entries, { at: Date.now(), kind: "unlock_failed" }],
          failed: log.failed + 1,
        },
      });
    }
    return r;
  };
  (area as unknown as { set: unknown }).set = (items: Record<string, unknown>) => {
    if ("sk_security_log" in items) g.__c7.push(["set", at()]);
    return set(items);
  };
  let code = false;
  let notice = false;
  g.__c7reset = () => {
    g.__c7 = [];
    code = false;
    notice = false;
  };
  new MutationObserver(() => {
    if (!code && document.querySelector(".row .code:not(.wait)")) {
      code = true;
      g.__c7.push(["code", at()]);
    }
    if (!notice && document.querySelector("#sec-notice")) {
      notice = true;
      g.__c7.push(["notice", at()]);
      requestAnimationFrame(() => g.__c7.push(["frame", at()]));
    }
  }).observe(document, { childList: true, subtree: true, attributes: true });
}

/** Start the timeline afresh: before an unlock, so it holds only what follows. */
export const resetTrace = (pop: Page) =>
  pop.evaluate(() => (globalThis as unknown as { __c7reset: () => void }).__c7reset());
/**
 * The timeline so far: names in order. The tests' own reads (record(), failedCount(): a key as a string) are left out;
 * the extension asks for keys as an array (ChromeLocalKV).
 */
export const trace = (pop: Page) =>
  pop.evaluate(() =>
    (globalThis as unknown as { __c7: [string, number][] }).__c7.map((e) => e[0]).filter((n) => !n.startsWith('get:"')),
  );
