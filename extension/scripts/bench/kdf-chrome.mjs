// PBKDF2-SHA256 in a real browser (docs/design/notes/OWN-PASSWORD-NOTES.md §2.1): crypto.subtle.deriveBits at each
// count, on a page served from 127.0.0.1 (a secure context), after one warm-up derivation, in interleaved rounds (the
// order reversed every other round), with the load average beside each. A manual tool, not part of CI: timings depend on
// the machine. scripts/bench-kdf.mjs is the Node equivalent.
//
//   nice -n 19 node scripts/bench/kdf-chrome.mjs [rounds=7] [channel=chrome]
//
// `channel`: "chrome" (the installed Google Chrome), "chromium" (Playwright's), or another Playwright channel. Prints one
// JSON line per derivation, then the median of each count.
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const rounds = Number(process.argv[2] ?? 7);
const channel = process.argv[3] ?? "chrome";
const COUNTS = [600_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000];
const load = () => {
  try {
    return execSync("sysctl -n vm.loadavg", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "n/a";
  }
};

const server = createServer((_q, r) => r.end("<!doctype html><title>kdf</title>"));
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
console.log(
  JSON.stringify({ browser: browser.version(), secure: await page.evaluate(() => isSecureContext), load: load() }),
);
await page.evaluate(async () => {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode("warm up"), "PBKDF2", false, [
    "deriveBits",
  ]);
  await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations: 100_000 },
    base,
    256,
  );
});
const times = new Map(COUNTS.map((c) => [c, []]));
for (let r = 0; r < rounds; r++) {
  for (const iterations of r % 2 ? [...COUNTS].reverse() : COUNTS) {
    const before = load();
    const ms = await page.evaluate(async (it) => {
      const base = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("a password of one's own"),
        "PBKDF2",
        false,
        ["deriveBits"],
      );
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const t = performance.now();
      await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: it }, base, 256);
      return performance.now() - t;
    }, iterations);
    times.get(iterations).push(ms);
    console.log(JSON.stringify({ round: r, iterations, ms: Math.round(ms), loadBefore: before, loadAfter: load() }));
  }
}
await browser.close();
server.close();
for (const [iterations, v] of times) {
  const s = [...v].sort((a, b) => a - b);
  console.log(
    `${iterations}: median ${Math.round(s[s.length >> 1])} ms, min ${Math.round(s[0])}, max ${Math.round(s.at(-1))}`,
  );
}
