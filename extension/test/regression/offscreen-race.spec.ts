// Review: two clipboard clean-ups armed at about the same time while no offscreen document exists yet.
// sw.ts ensureOffscreen() is check-then-create; the second createDocument() throws, the error is swallowed by
// `.catch(() => undefined)`, and that arm message is never forwarded. Uses dist-e2e (clipboard permissions granted).
import { expect, test } from "@playwright/test";
import { close, launch, openOptions, type Profile } from "../e2e/harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

test("how far apart two copies must be to both get cleared", async () => {
  const opt = await openOptions(p);
  await opt.bringToFront();
  const out: string[] = [];
  for (const gap of [20, 60, 120, 250, 500]) {
    const r = await opt.evaluate(async (gap) => {
      const hex = async (s: string) =>
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      for (let i = 0; i < 50; i++) {
        const c = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
        });
        if (c.length === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const first = `11111${gap}`,
        second = `22222${gap}`;
      await navigator.clipboard.writeText(first);
      void chrome.runtime
        .sendMessage({ type: "sk-clip-arm", hash: await hex(first), delayMs: 1000 })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, gap));
      await navigator.clipboard.writeText(second); // the user copied a second account's code
      void chrome.runtime
        .sendMessage({ type: "sk-clip-arm", hash: await hex(second), delayMs: 1000 })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 2500));
      const now = await navigator.clipboard.readText();
      return now.trim() === "" ? "cleared" : `NOT cleared`;
    }, gap);
    out.push(`gap ${gap} ms: ${r}`);
  }
  console.log(out);
  expect(out.filter((r) => !r.endsWith(": cleared"))).toEqual([]);
});

test("both of two near-simultaneous copies get cleared", async () => {
  const opt = await openOptions(p);
  await opt.bringToFront();
  const results: string[] = [];
  for (let round = 0; round < 8; round++) {
    const control = round % 2 === 0; // even rounds: a single copy, to show the mechanism itself works here
    const r = await opt.evaluate(
      async ([round, control]) => {
        const hex = async (s: string) =>
          Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
        // wait until no offscreen document is left from the previous round
        for (let i = 0; i < 50; i++) {
          const c = await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
          });
          if (c.length === 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const mine = `12345${round}`; // the code that is on the clipboard
        const other = `99999${round}`; // a code copied a moment earlier (e.g. the popup's "copy next code" path)
        await navigator.clipboard.writeText(mine);
        await Promise.all([
          control
            ? Promise.resolve()
            : chrome.runtime
                .sendMessage({ type: "sk-clip-arm", hash: await hex(other), delayMs: 1000 })
                .catch(() => undefined),
          chrome.runtime
            .sendMessage({ type: "sk-clip-arm", hash: await hex(mine), delayMs: 1000 })
            .catch(() => undefined),
        ]);
        await new Promise((r) => setTimeout(r, 2500));
        const now = await navigator.clipboard.readText();
        return now.trim() === "" ? "cleared" : `NOT cleared (still ${now})`;
      },
      [round, control] as const,
    );
    results.push(`${control ? "single copy" : "two copies"}: ${r}`);
  }
  console.log(results);
  expect(results.filter((r) => !r.endsWith(": cleared"))).toEqual([]);
});
