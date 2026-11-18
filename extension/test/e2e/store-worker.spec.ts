// The store build's service worker (dist/), which has no sync worker, bridge or transport (no build has since the server
// sync's client went: OWNER-DECISIONS/25, DV-0b; src/background/sw.ts), in the real extension:
//   - its start leaves nothing in its console: no error, no warning, no uncaught exception or rejection. Read over the
//     DevTools protocol from the worker's own target once it runs (the console keeps what was logged before anyone
//     looked, and hands it over when Runtime is enabled); the control is a throw-away extension whose worker logs an
//     error and leaves a rejection unhandled at its start, both of which the same look finds;
//   - the pages' messages still reach its listeners: the popup's clipboard clean-up is answered, the settings page's
//     backup in Chrome sync is answered, and neither page's message to the worker finds no receiver;
//   - autofill: the popup's Fill types the code into a page's code box, as in the e2e build (autofill1.spec.ts), the
//     store build's worker and content script included.
// The backup in Chrome sync's card turning it on in this build is store-rail.spec.ts's; the popup's and the settings
// page's first run and backup are store-backup.spec.ts's.
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clickFill, codesNow, windowOpen, world, type World } from "./autofill-helpers";
import { openOptions, openPopup, startFresh, type Profile } from "./harness";

const PROD = resolve(import.meta.dirname, "../../dist");

/** A profile with these unpacked extensions, and a DevTools port of the browser's choosing (DevToolsActivePort). */
async function launchWith(dirs: string[]): Promise<{ dir: string; ctx: BrowserContext; id: string }> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  // Bundled Chromium only: branded Chrome 137+ ignores --load-extension.
  const ctx = await chromium.launchPersistentContext(join(dir, "profile"), {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${dirs.join(",")}`,
      `--load-extension=${dirs.join(",")}`,
      "--remote-debugging-port=0",
    ],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { dir, ctx, id: new URL(sw.url()).host };
}

/**
 * What the extension's service worker logged as an error or a warning, and every exception it left uncaught, since it
 * started: its target attached to from the browser's session, Runtime enabled, and what it hands over within a second.
 */
async function workerConsole(dir: string, id: string): Promise<string[]> {
  const port = readFileSync(join(dir, "profile", "DevToolsActivePort"), "utf8").split("\n")[0];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const bs = await browser.newBrowserCDPSession();
    const { targetInfos } = (await bs.send("Target.getTargets")) as {
      targetInfos: { targetId: string; url: string; type: string }[];
    };
    const target = targetInfos.find((t) => t.type === "service_worker" && t.url === `chrome-extension://${id}/sw.js`);
    if (!target) throw new Error(`no service worker target: ${JSON.stringify(targetInfos.map((t) => t.url))}`);
    const seen: string[] = [];
    bs.on("Target.receivedMessageFromTarget", (e: { message: string }) => {
      const m = JSON.parse(e.message) as {
        method?: string;
        params?: {
          type?: string;
          args?: { value?: unknown; description?: string }[];
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
      };
      if (m.method === "Runtime.exceptionThrown")
        seen.push(
          `exception: ${m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text}`,
        );
      if (m.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(m.params?.type ?? ""))
        seen.push(`${m.params!.type}: ${(m.params!.args ?? []).map((a) => a.value ?? a.description).join(" ")}`);
    });
    const { sessionId } = (await bs.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    } as never)) as { sessionId: string };
    await bs.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }),
    } as never);
    await new Promise((r) => setTimeout(r, 1000));
    return seen;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

test("the store build's worker starts with nothing in its console (a worker that does log is seen)", async () => {
  test.setTimeout(120_000);
  // the control: an extension whose worker logs an error and leaves a rejection unhandled as it starts
  const root = mkdtempSync(join(tmpdir(), "sixkey-e2e-control-"));
  const control = join(root, "control");
  mkdirSync(control);
  writeFileSync(
    join(control, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Sixkey e2e control",
      version: "1.0",
      background: { service_worker: "sw.js" },
    }),
  );
  writeFileSync(
    join(control, "sw.js"),
    'console.error("control: logged at start");\nPromise.reject(new Error("control: rejected at start"));\n',
  );
  const c = await launchWith([control]);
  try {
    const seen = await workerConsole(c.dir, c.id);
    expect(
      seen.some((l) => l.startsWith("error: control: logged at start")),
      seen.join("\n"),
    ).toBe(true);
    expect(
      seen.some((l) => l.startsWith("exception:") && l.includes("control: rejected at start")),
      seen.join("\n"),
    ).toBe(true);
  } finally {
    await c.ctx.close();
    rmSync(c.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }

  const s = await launchWith([PROD]);
  try {
    expect(await s.ctx.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getManifest().name)).toBe("Sixkey");
    expect(await workerConsole(s.dir, s.id)).toEqual([]);
    // and after a first run, a new vault, and the pages' own messages to it
    const p: Profile = { dir: join(s.dir, "profile"), ctx: s.ctx, id: s.id };
    await startFresh(p);
    const pop = await openPopup(p);
    const clip = await pop.evaluate(() =>
      chrome.runtime.sendMessage({ type: "sk-clip-arm", hash: "0".repeat(64), delayMs: 30_000 }).then(
        (r) => r,
        (e) => `error: ${String(e)}`,
      ),
    );
    expect(clip).toEqual({ ok: true });
    const opt = await openOptions(p, "#backup");
    const csb = await opt.evaluate(() =>
      chrome.runtime.sendMessage({ type: "sk-csb-now" }).then(
        (r) => r,
        (e) => `error: ${String(e)}`,
      ),
    );
    expect(csb).toEqual(expect.objectContaining({ ok: expect.any(Boolean) }));
    expect(await workerConsole(s.dir, s.id)).toEqual([]);
  } finally {
    await s.ctx.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

test("the store build's autofill: the popup's Fill types the code into a page's code box", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "popup", dist: PROD });
  expect(await w.p.ctx.serviceWorkers()[0]!.evaluate(() => chrome.runtime.getManifest().name)).toBe("Sixkey");
  const page = await w.tab("127.0.0.1", "/otc");
  const pop = await w.icon(page);
  await pop.until("document.querySelector('.fillbar.ok')", "the strip says a code box was found");
  await windowOpen();
  await clickFill(pop);
  await pop.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await page.locator("input").first().inputValue());
});
