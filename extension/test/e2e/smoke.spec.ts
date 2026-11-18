import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../../dist");
let ctx: BrowserContext;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  // Bundled Chromium only: branded Chrome 137+ ignores --load-extension.
  ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
});

test.afterAll(async () => {
  await ctx.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

async function extensionId(): Promise<string> {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return new URL(sw.url()).host;
}

test("service worker registers and popup renders without console errors", async () => {
  const id = await extensionId();
  expect(id).toMatch(/^[a-p]{32}$/);

  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  // Opened as a tab, so no activeTab grant; enough for a render check.
  await page.goto(`chrome-extension://${id}/popup/index.html`);
  await expect(page.locator("#app")).toContainText("Sixkey");
  expect(errors).toEqual([]);

  await page.goto(`chrome-extension://${id}/options/index.html`);
  await expect(page.locator("#app")).toContainText("Sixkey");
  expect(errors).toEqual([]);
});

test("manifest declares only the permissions shipped code uses", async () => {
  const id = await extensionId();
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup/index.html`);
  const m = await page.evaluate(() => chrome.runtime.getManifest());
  // sidePanel: the side panel mode (docs/design/notes/SIDEPANEL-NOTES.md), used by the worker and the popup's button
  expect(m.permissions).toEqual([
    "storage",
    "unlimitedStorage",
    "activeTab",
    "alarms",
    "idle",
    "offscreen",
    "sidePanel",
  ]);
  // TOTP autofill's `scripting` (Stage 1: the Fill button and the shortcut; no install warning, no host access): optional
  // since wave 1b of the plugin platform, asked for by the first Fill click, not held at install (PLUGINS-W1B-NOTES.md)
  expect(m.optional_permissions).toContain("scripting");
  expect(await page.evaluate(() => chrome.permissions.contains({ permissions: ["scripting"] }))).toBe(false);
  expect(Number(m.minimum_chrome_version)).toBeGreaterThanOrEqual(140);
  // since autofill Stage 2 patch 2, https sites one at a time, only optional, nothing granted at install; the server
  // sync's API origin in no build since its client went (DV-0b)
  expect(m.host_permissions).toBeUndefined();
  expect(m.optional_host_permissions).toEqual(["https://*/*"]);
  expect(JSON.stringify(m.content_security_policy)).toContain("connect-src 'none'");
  expect(await page.evaluate(() => chrome.permissions.contains({ origins: ["https://api.sixkey.app/*"] }))).toBe(false);
  expect(await page.evaluate(() => chrome.permissions.contains({ origins: ["https://example.com/*"] }))).toBe(false);
  expect(m.content_scripts).toBeUndefined();
});
