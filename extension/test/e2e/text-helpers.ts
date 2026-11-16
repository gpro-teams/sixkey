// Message keys on screen. The popup's catalog holds only the keys its code can use (scripts/catalog-keys.mjs); one it
// lacked would show as its name. The e2e build's console guard (src/ui/i18n.ts, test/e2e/harness.ts) catches every t()
// of such a key. This reads the page itself, so it also catches a key shown some other way, and works on the prod
// build (install-source.spec.ts), which has no guard. harness.ts is A1's, so this lives in its own file (§0.5).
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const KEYS = Object.keys(
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../_locales/en/messages.json"), "utf8")) as object,
);
/** Keys that are not a word of any message, so they can be looked for anywhere: camelCase, digits or underscores. */
const DISTINCT = new Set(KEYS.filter((k) => /[A-Z0-9_]/.test(k)));
/** "add", "back", "lock"...: words of English text. Only an element whose whole text is one, on the Chinese UI, counts. */
const WORDS = new Set(KEYS.filter((k) => !DISTINCT.has(k)));

/** The raw keys in the page's text and in the attributes people read (title, labels, placeholders, alt text). */
export async function rawKeysIn(page: Page): Promise<string[]> {
  const { texts, zh } = await page.evaluate(() => {
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.textContent ?? "");
    for (const el of document.body.querySelectorAll("*")) {
      for (const a of ["title", "aria-label", "aria-description", "placeholder", "alt"]) {
        const v = el.getAttribute(a);
        if (v) out.push(v);
      }
      if (el instanceof HTMLElement && el.children.length === 0) out.push(el.innerText ?? "");
    }
    return { texts: out, zh: document.documentElement.lang === "zh-CN" };
  });
  const hits = new Set<string>();
  for (const s of texts) {
    for (const tok of s.match(/[A-Za-z0-9_]+/g) ?? []) if (DISTINCT.has(tok)) hits.add(tok);
    if (zh && WORDS.has(s.trim())) hits.add(s.trim());
  }
  return [...hits].sort();
}

export async function expectNoRawKeys(page: Page, where: string): Promise<void> {
  expect(await rawKeysIn(page), `message keys shown as text on ${where}`).toEqual([]);
}
