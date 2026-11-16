// "Chrome 同步" / "Chrome Sync" as this browser's word for it, for the backup in Chrome's sync storage's text on every
// page that shows it: the settings page's (src/ui/csb-text.ts) and the popup's and the side panel's
// (src/ui/csb-popup-text.ts). Where the browser is not Google Chrome (navigator.userAgentData's brands name no "Google
// Chrome": Edge, Brave, Chromium), it is the word each catalog has for "browser sync": what syncs there, and whether it
// carries an extension's data, is that browser's, and Sixkey does not know it. No text of its own and no catalog, so
// each page's chunk takes it without loading the other's text.

type Brands = { brands?: readonly { brand: string }[] };
/** Whether this browser says it is Google Chrome (User-Agent Client Hints; a browser that says nothing is not). */
export const isChrome = (): boolean =>
  (globalThis.navigator as { userAgentData?: Brands } | undefined)?.userAgentData?.brands?.some(
    (b) => b.brand === "Google Chrome",
  ) === true;

/**
 * `s` with "Chrome 同步" / "Chrome Sync" written as `word` where the browser is not Google Chrome (`chrome` false). The
 * space Chinese text keeps before a Latin word goes with it ("已交给 Chrome 同步" reads "已交给浏览器同步"); an English
 * sentence that now starts with the word starts with a capital.
 */
export function branded(s: string, chrome: boolean, word: string): string {
  if (chrome) return s;
  const out = s
    .replace(/(?<=[\u3000-\u9fff\uff00-\uffef]) Chrome 同步/g, word)
    .replace(/Chrome 同步|Chrome Sync/g, word);
  return out !== s && out.startsWith(word) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}
