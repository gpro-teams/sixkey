// Helpers for the export tests (PHASE0X-PLAN C6). harness.ts is frozen after A1 (§0.5), so they live here.
import { expect, type Download, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openPopup, STRONG, type Profile } from "./harness";

/** H3: type the master password again in Settings > Backup. The field is emptied after every export, so each one asks. */
export async function confirmExport(opt: Page, password = STRONG): Promise<void> {
  await opt.locator("#export-pw").fill(password);
}

/** The kinds in the local security log (sk_security_log, A3), oldest first. Read from any extension page. */
export async function securityKinds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { sk_security_log: log } = (await chrome.storage.local.get("sk_security_log")) as {
      sk_security_log?: { entries?: { kind: string }[] };
    };
    return (log?.entries ?? []).map((e) => e.kind);
  });
}

/** Count the downloads a page starts, from now on. */
export function countDownloads(page: Page): { readonly n: number; readonly last: Download | null } {
  const c = { n: 0, last: null as Download | null };
  page.on("download", (d) => {
    c.n++;
    c.last = d;
  });
  return c;
}

/** Click and wait for the download it starts; its text. */
export async function downloadText(page: Page, click: () => Promise<void>): Promise<string> {
  const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
  return readFileSync((await dl.path())!, "utf8");
}

/** The vault id this profile's vault has (the keyring of the active slot). */
export async function vaultIdOf(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const { sk_active } = (await chrome.storage.local.get("sk_active")) as { sk_active: "a" | "b" };
    const slot = (await chrome.storage.local.get(`sk_slot_${sk_active}`))[`sk_slot_${sk_active}`] as {
      keyring: { vaultId: string };
    };
    return slot.keyring.vaultId;
  });
  expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  return id;
}

/** Another page changes the vault: the popup moves an account to the trash. */
export async function trashInPopup(p: Profile, issuer: string): Promise<void> {
  const pop = await openPopup(p);
  await pop.locator(".row", { hasText: issuer }).locator(".more").click();
  await pop.getByRole("button", { name: /^(Delete|删除)$/ }).click();
  await pop.getByRole("button", { name: /Click again|再点一次/ }).click();
  await expect(pop.locator(".row", { hasText: issuer })).toHaveCount(0);
  await pop.close();
}

/** Another page changes the vault: the popup's edit dialog renames an account, sets its group, or adds a site. */
export async function editInPopup(
  p: Profile,
  issuer: string,
  change: { issuer?: string; group?: string; site?: string },
): Promise<void> {
  const pop = await openPopup(p);
  await pop.locator(".row", { hasText: issuer }).locator(".more").click();
  if (change.issuer !== undefined) await pop.locator("#e-issuer").fill(change.issuer);
  if (change.group !== undefined) await pop.locator("#e-group").fill(change.group);
  if (change.site !== undefined) {
    await pop.locator("#e-site").fill(change.site);
    await pop.locator("#e-site").press("Enter");
    await expect(pop.locator(".sites .dchip span", { hasText: change.site })).toBeVisible();
  }
  await pop.getByRole("button", { name: /^(Save|保存)$/ }).click();
  await expect(pop.locator(".dialog")).toHaveCount(0); // closed once the change is saved
  await pop.close();
}
