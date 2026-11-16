// Helpers for the popup list tests (PHASE0X-PLAN B1). harness.ts belongs to A1, so new helpers live here.
import type { Page } from "@playwright/test";
import { openOptions, type Profile } from "./harness";

export type Display = { density: "standard" | "compact"; hideCodes: boolean; sort: "manual" | "name" };
export const DISPLAY: Display = { density: "standard", hideCodes: false, sort: "manual" };

/**
 * Set the popup's display settings as the settings page would save them: the whole settings record, with `display`
 * replaced and everything else kept. The settings page has controls for them (Appearance: density, order and hidden codes;
 * Security mode: hidden codes); these tests write the record directly so that they do not depend on those panels.
 */
export async function setDisplay(p: Profile, display: Partial<Display>): Promise<void> {
  const opt = await openOptions(p);
  await opt.evaluate(
    async (d) => {
      const cur = ((await chrome.storage.local.get("sk_settings")).sk_settings ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({
        sk_settings: { autoLock: { mode: "idle", minutes: 15 }, lockOnScreenLock: true, ...cur, display: d },
      });
    },
    { ...DISPLAY, ...display },
  );
  await opt.close();
}

/** `n` otpauth lines with distinct names and fixed, valid secrets. */
export function accountLines(n: number, name = (i: number) => `Account ${String(i).padStart(3, "0")}`): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return Array.from({ length: n }, (_, i) => {
    const secret = Array.from({ length: 32 }, (_, k) => B32[(i * 7 + k * 13 + (i >> 5)) % 32]).join("");
    const issuer = encodeURIComponent(name(i));
    return `otpauth://totp/${issuer}:user${i}?secret=${secret}&issuer=${issuer}`;
  }).join("\n");
}

/**
 * Everything a page shows or carries that could hold a code: its text with all white space removed (so "123 456" and
 * digits in separate elements read as one run), and every attribute value except ids and inline styles.
 */
export async function pageTextAndAttributes(page: Page): Promise<string> {
  return page.evaluate(() => {
    const attrs: string[] = [];
    for (const el of document.querySelectorAll("*"))
      for (const a of el.attributes) if (a.name !== "data-id" && a.name !== "style") attrs.push(a.value);
    return `${(document.documentElement.textContent ?? "").replace(/\s+/g, "")}\n${attrs.join("\n")}`;
  });
}
