// Make a benchmark profile: a Sixkey vault with N accounts behind the master password, set up the way a user does it
// (PHASE0X-PLAN A1's first run: welcome -> Start -> password, recovery code, profile question; then paste N otpauth links
// on the settings page). A manual tool for bench.mjs, not part of CI.
//
//   node scripts/bench/seed.mjs <extension build> <profile dir> <N>
//
// Use the same build path that bench.mjs will load (the extension id comes from the path). Prints the stored size of
// every chrome.storage.local key, as JSON.
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const [, , distArg, profileArg, nStr] = process.argv;
if (!distArg || !profileArg || !nStr) {
  console.error("usage: node scripts/bench/seed.mjs <extension build> <profile dir> <N>");
  process.exit(2);
}
const dist = resolve(distArg);
const profile = resolve(profileArg);
const N = Number(nStr);
const PASSWORD = process.env.SIXKEY_BENCH_PASSWORD ?? "Q7m#Xv9!pL2@rT5$kB8w"; // bench.mjs's
const ISSUERS = [
  "GitHub",
  "Google",
  "AWS",
  "Microsoft",
  "Dropbox",
  "Slack",
  "Cloudflare",
  "Stripe",
  "Binance",
  "Coinbase",
  "Twitter",
  "Facebook",
  "Amazon",
  "Apple",
  "Discord",
  "Reddit",
  "GitLab",
  "Notion",
  "Figma",
  "Atlassian",
  "DigitalOcean",
  "Heroku",
  "Namecheap",
  "Proton",
  "Tutanota",
  "PayPal",
  "Shopify",
  "Zoom",
  "Okta",
  "Salesforce",
];
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const secret = () => [...randomBytes(32)].map((b) => B32[b & 31]).join("");
const lines = Array.from({ length: N }, (_, i) => {
  const iss = ISSUERS[i % ISSUERS.length] + (i >= ISSUERS.length ? ` ${Math.floor(i / ISSUERS.length)}` : "");
  return `otpauth://totp/${encodeURIComponent(iss)}:user${i}%40example.com?secret=${secret()}&issuer=${encodeURIComponent(iss)}`;
});

mkdirSync(profile, { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const id = new URL(sw.url()).host;

// welcome -> Start opens the first-run wizard on the settings page (same steps as test/e2e/harness.ts finishWizard)
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${id}/popup/index.html`);
const [opt] = await Promise.all([ctx.waitForEvent("page"), pop.locator("#start-secure").click()]);
await opt.waitForLoadState();
await opt.locator("#fr-pw").fill(PASSWORD);
await opt.locator("#fr-pw2").fill(PASSWORD);
await opt.locator("#fr-next").click({ timeout: 30_000 });
await opt.locator("#recovery-saved").check();
await opt.locator("#recovery-done").click();
await opt.locator("#fr-solo").check();
await opt.locator("#fr-finish").click();
await expect(opt.locator("#fr-hint")).toBeVisible({ timeout: 30_000 });
await pop.close();

await opt.goto(`chrome-extension://${id}/options/index.html#add`);
await opt.locator("#paste-box").fill(lines.join("\n"));
await opt.locator("#add-confirm").click();
await expect(opt.locator("#add-done")).toBeVisible({ timeout: 60_000 });
const bytes = await opt.evaluate(async () =>
  Object.fromEntries(
    Object.entries(await chrome.storage.local.get(null)).map(([k, v]) => [k, JSON.stringify(v).length]),
  ),
);
console.log(JSON.stringify({ id, N, bytes }));
await ctx.close();
