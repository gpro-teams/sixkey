// TOTP autofill Stage 3, AF3-3a: the site rules' bundle in the package, as Chrome itself reads it (docs/design/notes/
// AUTOFILL3-NOTES.md §4; the plan's P3, measured on the real build; the AF3-1a review's note).
//   - the worker (the manifest's CSP, whose connect-src has no 'self') and a page under its own `connect-src 'none'` read
//     rules/baseline.json from the package, and get the e2e build's bundle byte for byte (the repository's
//     rules/build/baseline.json with that build's test rules: AF3-3b, rules-package.mjs e2eBaselineText); the page is
//     refused a data: URL (so its CSP is in force), and a web page cannot read the file at all (it is not web-accessible);
//   - the extension's own reader, readRules (src/platform/package-data.ts), run by Chrome in the worker and in the page:
//     it fetches the file, checks it with the format's checker and Chrome's URL parser (canonicalHost), and accepts it,
//     the same bundle as Node's reading; one read per context. In the build it is in the Fill chunk (AF3-3b), which no
//     test can call into, so the module is bundled here, as one classic script, by the build's own bundler, with the e2e
//     build's define (reserved names accepted, for its test rules);
//   - Chrome's URL parser writes every host of the bundle as the bundler (Node's, match.ts canonicalHost) wrote it.
import { expect, test, type Page, type Worker } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseBaseline } from "../../src/core/rules/baseline";
import { e2eBaselineText } from "../../scripts/rules-package.mjs";
import { close, launch, openPopup } from "./harness";

const EXT = resolve(import.meta.dirname, "../..");
const COMMITTED = readFileSync(resolve(EXT, "../rules/build/baseline.json"), "utf8");
// the e2e build carries the committed bundle with its own test rules on its fixture hosts (AF3-3b), and its reader accepts
// their reserved names (scripts/build.mjs __SK_RULES_TEST_HOSTS__, defined here as that build defines it)
let E2E = "";
const FILE = "rules/baseline.json";

/** src/platform/package-data.ts as one classic script that sets globalThis.__skRules (its exports). */
async function readerScript(): Promise<string> {
  const { build } = await import("vite");
  const out = await build({
    configFile: false,
    logLevel: "silent",
    root: EXT,
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve(EXT, "src/platform/package-data.ts"), formats: ["iife"], name: "__skRules" },
    },
    define: { __SK_RULES_TEST_HOSTS__: "true" },
  });
  const [first] = Array.isArray(out) ? out : [out];
  const code = (first as unknown as { output: { type: string; code?: string }[] }).output.find(
    (o) => o.type === "chunk",
  )?.code;
  if (!code) throw new Error("the reader did not bundle");
  return code;
}

/**
 * What readRules answered in a context, to two calls together and one after: the bundle's parts that say it is this one,
 * and whether all three answers were one object.
 */
type Read = {
  kind: string;
  version: number;
  rules: number;
  hosts: number;
  aliases: string;
  appends: string[];
  once: boolean;
} | null;
const READ = async (): Promise<Read> => {
  const m = (globalThis as unknown as { __skRules: { readRules(): Promise<Record<string, any> | null> } }).__skRules;
  // two calls together, as the Fill paths and the alias module will make them, then a later one: one read, one answer
  const [a, b] = await Promise.all([m.readRules(), m.readRules()]);
  const c = await m.readRules();
  if (!a) return null;
  return {
    kind: a.kind,
    version: a.version,
    rules: a.rules.size,
    hosts: a.hosts.size,
    aliases: JSON.stringify(a.aliases),
    appends: a.appends,
    once: a === b && b === c,
  };
};

test("Chrome reads the packaged bundle from the worker and from a page under connect-src 'none'; no web page can", async () => {
  const reader = await readerScript();
  E2E = await e2eBaselineText(COMMITTED);
  const node = parseBaseline(E2E, { allowReserved: true });
  if (!node.ok) throw new Error(node.error);
  const want: Read = {
    kind: "baseline",
    version: node.value.version,
    rules: node.value.rules.size,
    hosts: node.value.hosts.size,
    aliases: JSON.stringify(node.value.aliases),
    appends: node.value.appends,
    once: true,
  };
  expect(node.value.aliases.length).toBeGreaterThan(100);
  const p = await launch();
  try {
    const sw: Worker = p.ctx.serviceWorkers()[0]!;
    const fromWorker = await sw.evaluate(async (f) => (await fetch(chrome.runtime.getURL(f))).text(), FILE);
    expect(fromWorker).toBe(E2E);
    const page: Page = await openPopup(p);
    expect(
      await page.evaluate(() =>
        document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
      ),
    ).toBe("connect-src 'none'");
    const fromPage = await page.evaluate(async (f) => (await fetch(chrome.runtime.getURL(f))).text(), FILE);
    expect(fromPage).toBe(E2E);
    // the page's CSP is in force: another address, even a data: URL, is refused
    expect(
      await page.evaluate(async () => {
        try {
          await fetch("data:application/json,{}");
          return "read";
        } catch {
          return "refused";
        }
      }),
    ).toBe("refused");
    // the extension's reader, in each context: the bundle Node reads, read once
    await sw.evaluate(reader);
    expect(await sw.evaluate(READ)).toEqual(want);
    await page.evaluate(reader);
    expect(await page.evaluate(READ)).toEqual(want);
    // the licence file beside it, as the build wrote it
    const licence = await page.evaluate(async () => (await fetch(chrome.runtime.getURL("rules/LICENSE.txt"))).text());
    expect(licence.startsWith(readFileSync(resolve(EXT, "../rules/NOTICE"), "utf8"))).toBe(true);
    // a web page: not web-accessible, so not even a request reaches it
    const web = await p.ctx.newPage();
    await web.route("http://web.fix.test/**", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>web</title>" }),
    );
    await web.goto("http://web.fix.test/");
    expect(
      await web.evaluate(async (u) => {
        try {
          await fetch(u);
          return "read";
        } catch {
          return "refused";
        }
      }, `chrome-extension://${p.id}/${FILE}`),
    ).toBe("refused");
    // Chrome's URL parser and the bundler's agree on every host the bundle holds
    const b = JSON.parse(fromPage);
    const hosts: string[] = [
      ...Object.keys(b.hosts),
      ...b.aliases.flatMap((g: Record<string, string[]>) => [...(g.s ?? []), ...(g.f ?? []), ...(g.t ?? [])]),
      ...b.appends,
    ];
    expect(hosts.length).toBeGreaterThan(250);
    const parsed = await page.evaluate((hs) => hs.map((h) => new URL(`https://${h}/`).hostname), hosts);
    expect(parsed).toEqual(hosts);
  } finally {
    await close(p);
  }
});
