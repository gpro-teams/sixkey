// AF-BOUND (docs/design/notes/AUTOFILL2-NOTES.md §13.10), in a real browser: a storage answer lost on the shortcut's path.
// The test makes the worker's next storage.session call of one kind never answer, in the same evaluate that presses the
// shortcut (a wrapper of the test's own on the worker's chrome API, then the e2e build's `__skFill`; no product code), so
// the call lost is the press's own. What must hold (the `autofill2.spec.ts:77` family's stall, turned into the fallback a
// press without a request R always had):
//   - the press ends within STORE_MS and a little: the popup opens on the lock screen, with no line for the page, and no R;
//   - no lock is held: the next press, with storage answering, writes R, and the open popup shows its line.
import { expect, test, type Page } from "@playwright/test";
import { popupPage, windowOpen, world, type World } from "./autofill-helpers";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});
const worker = (x: World) => x.p.ctx.serviceWorkers()[0]!;
const req = (x: World) =>
  worker(x).evaluate(async () => (await chrome.storage.session.get("sk_fill_req")).sk_fill_req ?? null);
const line = (s: PanelPage) => s.eval<string>("document.querySelector('#lock-fill')?.textContent ?? ''");
const press = (x: World) =>
  worker(x).evaluate(() => (globalThis as unknown as { __skFill: () => Promise<void> }).__skFill());
/** The shortcut pressed with the worker's next storage.session `call` naming `key` never answered (once). */
const pressLosing = (x: World, call: "get" | "set", key: string) =>
  worker(x).evaluate(
    ([call, key]) => {
      const area = chrome.storage.session as unknown as Record<string, (a: unknown) => Promise<unknown>>;
      const real = area[call]!.bind(area);
      area[call] = (a: unknown) => {
        const names = typeof a === "string" ? [a] : Array.isArray(a) ? a : Object.keys((a as object) ?? {});
        if (!names.includes(key)) return real(a);
        area[call] = real; // once
        return new Promise(() => undefined);
      };
      return (globalThis as unknown as { __skFill: () => Promise<void> }).__skFill();
    },
    [call, key] as const,
  );
async function popupOpen(x: World): Promise<boolean> {
  const { targetInfos } = (await x.d.bs.send("Target.getTargets")) as { targetInfos: { url: string; type: string }[] };
  return targetInfos.some((t) => t.url === `chrome-extension://${x.p.id}/popup/index.html` && t.type !== "tab");
}
async function lockedOn(x: World): Promise<Page> {
  const page = await x.tab("127.0.0.1", "/otc");
  const s = await x.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await s.eval("void setTimeout(() => window.close(), 50)");
  await expect.poll(() => popupOpen(x), { message: "the popup closed" }).toBe(false);
  await worker(x).evaluate(() => chrome.storage.session.clear()); // locked to the master password
  await windowOpen(20);
  return page;
}

for (const [what, call, key] of [
  ["the lock epoch's read", "get", "sk_lock_epoch"],
  ["R's write (under sixkey-fill-req)", "set", "sk_fill_req"],
] as const)
  test(`the shortcut's ${what} lost: the press ends in the lock screen without the page's line; the next press writes R`, async () => {
    test.setTimeout(120_000);
    w = await world({ surface: "popup" });
    await lockedOn(w);
    const t0 = Date.now();
    const pressed = pressLosing(w, call, key);
    const s = await popupPage(w.d, w.p);
    await s.until("document.querySelector('form.lock')", "the lock screen");
    const took = Date.now() - t0;
    expect(took, "the popup opened after the lost call's bound (5 s), not never").toBeGreaterThan(4500);
    expect(took).toBeLessThan(20_000);
    await new Promise((r) => setTimeout(r, 800));
    expect(await line(s)).toBe(""); // no R, so no line: the user unlocks here, and presses again
    expect(await req(w)).toBeNull();
    await pressed; // the press itself ended (its badge's few seconds)
    // no lock held: the next press, storage answering, writes R, and the popup still open shows the page's line
    const again = press(w);
    await expect
      .poll(() => req(w!), { message: "R written by the next press", timeout: 15_000 })
      .toMatchObject({
        v: 1,
        why: "locked",
      });
    await s.until("document.querySelector('#lock-fill')", "the line, in the popup already open");
    expect(await line(s)).toBe("Unlock to fill the code on 127.0.0.1");
    await again;
  });
