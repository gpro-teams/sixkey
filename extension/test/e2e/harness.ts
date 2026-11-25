import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import encodeQR from "qr";
import { decodeBase32 } from "../../src/core/totp/base32";
import { totp } from "../../src/core/totp/hotp";
import { parseOtpauth } from "../../src/core/totp/otpauth";
import { legacyDeviceGeneration } from "../helpers/vaults";

export const DIST = resolve(import.meta.dirname, "../../dist-e2e");
export const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238 seed "12345678901234567890"
export const GITHUB_URI = `otpauth://totp/GitHub:alice@example.com?secret=${SECRET}&issuer=GitHub`;
export const AWS_URI = `otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS&digits=8`;
export const STRONG = "Q7m#Xv9!pL2@rT5$kB8w";

export type Profile = { dir: string; ctx: BrowserContext; id: string };

/** `extra`: more unpacked extensions loaded beside Sixkey (a test's own). */
export async function launch(dir?: string, extra: readonly string[] = []): Promise<Profile> {
  const userDataDir = dir ?? mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  const all = [DIST, ...extra].join(",");
  // Bundled Chromium only: branded Chrome 137+ ignores --load-extension.
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${all}`, `--load-extension=${all}`],
    acceptDownloads: true,
  });
  watchText(ctx);
  if (!extra.length) {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    return { dir: userDataDir, ctx, id: new URL(sw.url()).host };
  }
  // with other extensions: Sixkey's worker is the one whose extension is named "Sixkey (e2e)"
  while (ctx.serviceWorkers().length < extra.length + 1) await ctx.waitForEvent("serviceworker");
  for (const sw of ctx.serviceWorkers())
    if ((await sw.evaluate(() => chrome.runtime.getManifest().name)) === "Sixkey (e2e)")
      return { dir: userDataDir, ctx, id: new URL(sw.url()).host };
  throw new Error("Sixkey's service worker is not among the extensions loaded");
}

/**
 * Message keys shown without their text. The e2e build reports every t() of a key the page's catalog has no text for
 * (src/ui/i18n.ts, __I18N_GUARD__): on the popup, whose catalog holds only the keys its code can use (scripts/catalog-
 * keys.mjs), that is a key name on screen. Every page of a profile from launch() is watched, and close() fails the test
 * if anything was reported, so every e2e test that goes through a screen also checks its text.
 */
const missingText = new WeakMap<BrowserContext, string[]>();
function watchText(ctx: BrowserContext) {
  const found: string[] = [];
  missingText.set(ctx, found);
  const watch = (page: Page) =>
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().startsWith("sixkey i18n:")) found.push(m.text());
    });
  ctx.pages().forEach(watch);
  ctx.on("page", watch);
}
/** What the profile's pages reported so far (see watchText). */
export const missingTextOf = (p: Profile): string[] => [...(missingText.get(p.ctx) ?? [])];

export async function close(p: Profile, remove = true) {
  const missing = missingTextOf(p); // read before closing: a page's last console events arrive before its close
  await p.ctx.close();
  if (remove) rmSync(p.dir, { recursive: true, force: true });
  if (missing.length)
    throw new Error(`message keys were shown without their text:\n${[...new Set(missing)].join("\n")}`);
}

export async function openPopup(p: Profile): Promise<Page> {
  const page = await p.ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  (page as Page & { _errors: string[] })._errors = errors;
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);
  return page;
}

export async function openOptions(p: Profile, hash = ""): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.goto(`chrome-extension://${p.id}/options/index.html${hash}`);
  return page;
}

/** The group of the rail each leaf of the settings page is in (src/options/route.ts); #clipboard is a panel. */
const GROUP_OF: Record<string, string> = {
  add: "accounts",
  groups: "accounts",
  backup: "accounts",
  trash: "accounts",
  security: "security",
  "security-keys": "security",
  "security-log": "security",
  appearance: "appearance",
  clipboard: "appearance",
  sync: "sync",
  advanced: "advanced",
};
/** The groups that have leaves of their own (a row of links under the title). */
const SUB_GROUPS = new Set(["accounts", "security"]);
/** The leaf a name shows (a panel inside a leaf: the leaf it is in). */
const LEAF_OF: Record<string, string> = { clipboard: "appearance" };

/**
 * Show a part of the settings page the way a person does: the rail's link of its group, then, where the group has more
 * than one leaf, the link of the leaf under the title (src/options/route.ts: the address's hash is the choice, one leaf
 * is on the page at a time). Resolves once it is drawn.
 */
export async function showSection(opt: Page, id: string): Promise<void> {
  const leaf = LEAF_OF[id] ?? id;
  const group = GROUP_OF[id]!;
  // the page has drawn (a page just opened is not yet on a leaf as far as its links go): its current group is marked
  await opt.locator(".rail nav a[aria-current]").first().waitFor();
  const groupLink = opt.locator(`.rail nav a[href="#${group}"]`);
  const inGroup = (await groupLink.getAttribute("aria-current")) !== null;
  if (!inGroup) {
    await groupLink.click();
    await expect(groupLink).toHaveAttribute("aria-current", /.+/); // the click's hashchange has been taken
  }
  // in a group with leaves of its own, on a leaf other than the one wanted: its link under the title
  if (SUB_GROUPS.has(group)) {
    const sub = opt.locator(`.subnav a[href="#${leaf}"]`);
    await sub.waitFor();
    if ((await sub.getAttribute("aria-current")) !== "page") await sub.click();
    await expect(sub).toHaveAttribute("aria-current", "page");
  }
  await expect(opt.locator(`#${id}`)).toBeVisible();
}

/** Open a folded box of the settings page (src/options/shared.tsx Fold) by its button, if it is closed. */
export async function openFold(opt: Page, id: string): Promise<void> {
  const toggle = opt.locator(`#${id}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(opt.locator(`#${id}-body`)).toBeVisible();
}

export type Risk = "solo" | "shared";

/**
 * The first-run wizard on a settings page, from the master password to the end (PHASE0X-PLAN A1): password, recovery
 * code (confirmed saved), the profile question, and for a shared profile the clipboard step. Returns the code shown.
 * The last step's box, "back up automatically to Chrome Sync", is ticked for "only me" by default; here it is left as
 * `csb` says, cleared unless asked, so a spec that is not about that backup runs as before it existed
 * (test/e2e/csb-pages.spec.ts and firstrun.spec.ts take the box as first run shows it).
 */
export async function finishWizard(
  opt: Page,
  o: { risk?: Risk; password?: string; csb?: boolean; pin?: string } = {},
): Promise<string> {
  const pw = o.password ?? STRONG;
  await opt.locator("#fr-pw").fill(pw);
  await opt.locator("#fr-pw2").fill(pw);
  await opt.locator("#fr-next").click(); // enabled once the strength check passes
  const code = (await opt.locator("#recovery-code").textContent())!.trim();
  await expect(opt.locator("#recovery-done")).toBeDisabled();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await opt.locator(o.risk === "shared" ? "#fr-shared" : "#fr-solo").check();
  await opt.locator("#fr-csb").setChecked(o.csb ?? false);
  await opt.locator("#fr-finish").click();
  if (o.risk === "shared") await opt.locator("#fr-clip-next").click();
  else if (o.pin) {
    // the PIN step: the PIN twice, and nothing else (no master password: it was typed on this page a moment ago)
    await expect(opt.locator("#fr-pin input")).toHaveCount(2);
    await opt.locator("#fr-pin-new").fill(o.pin);
    await opt.locator("#fr-pin-new2").fill(o.pin);
    await opt.locator("#fr-pin-set").click();
  } else await skipFirstPin(opt);
  await expect(opt.locator("#fr-hint")).toBeVisible(); // the last step: the page, at "Add accounts"
  return code;
}

/**
 * First run's PIN step ("only me", once the vault is written; 2026-11-25): passed over with "Not now" when it shows. A
 * restore that typed no master password (the recovery key, keeping the backup's) has none, and goes on to the page.
 */
export async function skipFirstPin(opt: Page): Promise<void> {
  const skip = opt.locator("#fr-pin-skip");
  await expect(skip.or(opt.locator("#fr-hint"))).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) await skip.click();
}

/**
 * Welcome screen -> Start: the settings tab it opens runs the first run with a master password (there is no other way to
 * start). Ends where the old "Start" did: on the list in the popup, or, for a shared profile, on its lock screen.
 */
export async function startFresh(p: Profile, o: { risk?: Risk; pin?: string } = {}): Promise<{ recoveryCode: string }> {
  const pop = await openPopup(p);
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#start-secure").click()]);
  await opt.waitForLoadState();
  const recoveryCode = await finishWizard(opt, o);
  await opt.close();
  const check = await openPopup(p);
  await expect(check.locator(o.risk === "shared" ? "#secret" : "#q")).toBeVisible();
  await check.close();
  return { recoveryCode };
}

/**
 * A Phase 0 device-key vault holding `uris`, as an old install has it on disk. Built in Node with the core code (the
 * shipped code can no longer make one) and written into chrome.storage.local from an extension page.
 */
export async function seedLegacyDeviceVault(p: Profile, uris: string[] = []): Promise<void> {
  const entries = uris.map((u) => {
    const r = parseOtpauth(u);
    if (!r.ok) throw new Error(`not an otpauth URI: ${r.error}`);
    return r.value;
  });
  const gen = await legacyDeviceGeneration(entries);
  const page = await p.ctx.newPage();
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);
  await page.evaluate(
    async (g) => {
      await chrome.storage.local.set({
        sk_slot_a: g,
        sk_active: "a",
        sk_keyring: { v: 1, savedAt: g.savedAt, keyring: g.keyring },
      });
    },
    JSON.parse(JSON.stringify(gen)),
  );
  await page.close();
}

export async function addByPaste(p: Profile, text: string): Promise<void> {
  const opt = await openOptions(p, "#add");
  await opt.locator("#paste-box").fill(text);
  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#add-done")).toBeVisible();
  await opt.close();
}

/** The codes a correct app may show right now (current period, plus neighbours so a boundary tick cannot fail the test). */
export async function acceptable(
  secret: string,
  digits: 6 | 8 = 6,
  alg: "SHA1" | "SHA256" | "SHA512" = "SHA1",
  period = 30,
): Promise<string[]> {
  const key = decodeBase32(secret);
  const now = Date.now();
  return Promise.all([-period, 0, period].map((d) => totp(key, now + d * 1000, { algorithm: alg, digits, period })));
}

export const digitsOf = (text: string | null) => (text ?? "").replace(/\D/g, "");

/** A grayscale PNG of a QR code, built without any canvas so tests do not depend on the browser's image stack. */
export function qrPng(text: string, scale = 6, quiet = 4): Buffer {
  const m = encodeQR(text, "raw");
  const n = m.length + quiet * 2;
  const size = n * scale;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size, 255);
    row[0] = 0;
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      if (my >= 0 && my < m.length && mx >= 0 && mx < m.length && m[my]![mx]) row[1 + x] = 0;
    }
    rows.push(row);
  }
  const crcTable = new Int32Array(256).map((_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writeTmp(name: string, data: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-file-"));
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}
