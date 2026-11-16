// PHASE0X-PLAN A2 / ux-study §2.3: how fast the popup shows the first code with 100 accounts, warm and cold. Timing is
// noisy (and e2e runs share the CPU), so timings only WARN: a test annotation and a console line, never a failure on a
// number. The real browser's chrome.storage.local read counts are deterministic, so those are HARD gates here, on the
// whole popup (App, Main, the list, touch()), which test/unit/read-budget.test.ts cannot see:
//   open:   at most 4 reads and 1.5x the active slot before the first code; at most 6 in all (touch() adds 2; the
//           backup in Chrome sync's pill and footer, src/popup/main/CsbPop.tsx, read nothing of their own: their two
//           records come in the open's read of the settings, src/platform/runtime-base.ts. The Drive path's pill read
//           them once more, after the first code: the 7th read, gone with that path in CSB-3)
//   unlock: at most 8 reads and 3x before the first code (lock screen included); at most 11 in all (9 before C7, plus
//           the one documented exception: the security record's notice reads sk_security_log once, after the first code,
//           only after an unlock; PHASE0X-PLAN C7, src/popup/notice.ts; the cloud backup's one read gone, as for open)
//   warm: the vault unlocked, the popup opened again and again (median of 5, after one to settle);
//   cold: the browser restarted (so the extension's process starts afresh and the vault is locked, as every password
//         user meets it): navigation -> lock screen, then submitting the password -> first code, minus PBKDF2 measured
//         in the same page. A popup opened while the service worker has been stopped is measured by scripts/bench
//         (scenario proccold): Playwright keeps the worker alive while it is attached, so it cannot be done here.
import { expect, test, type Page } from "@playwright/test";
import { addByPaste, close, launch, openPopup, startFresh, STRONG, type Profile } from "./harness";
import { accountLines } from "./list-helpers";

const ACCOUNTS = 100;
/** ux-study §2.3: budgets over a blank popup, which took about 15 ms from navigation to content in the study. */
const BLANK_MS = 15;
const BUDGET = { warmFirstCode: BLANK_MS + 60, coldLockScreen: BLANK_MS + 60, unlockMinusKdf: 80 };
const READS = {
  // all: 6: it was 7 with one read of sk_cloud_cfg and sk_cloud_state after the first code, shared by the cloud
  // backup's pill and footer (CLOUDBK patch 6), until CSB-3; the backup in Chrome sync's pill and footer
  // read none (CsbPop.tsx: sk_csb_cfg and sk_csb_state come with the settings)
  open: { firstCode: 4, slots: 1.5, all: 6 },
  // all: 10, was 9: one read of sk_security_log after the first code, only after an unlock, for the C7 notice; it was
  // 11 with the cloud backup's one read, as for open, until CSB-3
  unlock: { firstCode: 8, slots: 3, all: 10 },
} as const;

/** Before any script of the page: marks for the lock screen and the first code, and a count of storage reads. */
function instrument() {
  const g = globalThis as unknown as { __sk: { local: number; localBytes: number; session: number } };
  g.__sk = { local: 0, localBytes: 0, session: 0 };
  const wrap = (area: chrome.storage.StorageArea | undefined, name: "local" | "session") => {
    if (!area) return;
    const get = area.get.bind(area) as (k?: unknown) => Promise<Record<string, unknown>>;
    (area as unknown as { get: unknown }).get = async (k?: unknown) => {
      const r = await get(k);
      g.__sk[name]++;
      if (name === "local") g.__sk.localBytes += JSON.stringify(r).length;
      return r;
    };
  };
  if (typeof chrome !== "undefined" && chrome.storage) {
    wrap(chrome.storage.local, "local");
    wrap(chrome.storage.session, "session");
  }
  let code = false;
  let lock = false;
  new MutationObserver(() => {
    if (!code && document.querySelector(".row .code:not(.wait)")) {
      code = true;
      performance.mark("x:firstcode");
      Object.assign(g.__sk, { atFirstCode: g.__sk.local, bytesAtFirstCode: g.__sk.localBytes });
    }
    if (!lock && document.querySelector("#secret")) {
      lock = true;
      performance.mark("x:lockscreen");
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
}

const markAt = (page: Page, name: string) =>
  page
    .waitForFunction((n) => performance.getEntriesByName(n)[0]?.startTime ?? null, name, { timeout: 30_000 })
    .then((h) => h.jsonValue() as Promise<number>);
const counts = (page: Page) => page.evaluate(() => (globalThis as unknown as { __sk: Record<string, number> }).__sk);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/** The counts once the popup has stopped reading (touch() runs after the first frame): unchanged for half a second. */
async function settled(page: Page): Promise<Record<string, number>> {
  let last = JSON.stringify(await counts(page));
  for (let same = 0, i = 0; same < 5 && i < 50; i++) {
    await page.waitForTimeout(100);
    const now = JSON.stringify(await counts(page));
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return JSON.parse(last) as Record<string, number>;
}
/** The active slot's size as the counter measures it (JSON). Read after the counts were taken. */
const slotBytes = (page: Page) =>
  page.evaluate(async () => {
    const a = (await chrome.storage.local.get("sk_active")).sk_active;
    const key = a === "b" ? "sk_slot_b" : "sk_slot_a";
    return JSON.stringify((await chrome.storage.local.get(key))[key]).length;
  });

function note(type: string, value: number, budget: number | null, extra = "") {
  const detail = `${value.toFixed(1)} ms${budget === null ? "" : ` (budget ${budget} ms)`}${extra ? `; ${extra}` : ""}`;
  test.info().annotations.push({ type, description: detail });
  if (budget !== null && value > budget) {
    test.info().annotations.push({ type: "warning", description: `${type} over budget: ${detail}` });
    console.warn(`WARNING ${type} over budget: ${detail}`);
  } else console.log(`${type}: ${detail}`);
}

let p: Profile;
test.afterEach(async () => {
  await close(p);
});

test("first code with 100 accounts, warm and after a browser restart (timings warn; read counts are gates)", async () => {
  test.setTimeout(180_000);
  p = await launch();
  await startFresh(p);
  await addByPaste(p, accountLines(ACCOUNTS));
  await p.ctx.addInitScript(instrument);

  // warm
  const warm: number[] = [];
  let warmReads: Record<string, number> = {};
  let slot = 0;
  for (let i = 0; i < 6; i++) {
    const pop = await openPopup(p);
    const at = await markAt(pop, "x:firstcode");
    await expect(pop.locator(".row")).toHaveCount(ACCOUNTS);
    if (i > 0) warm.push(at);
    if (i === 1) {
      warmReads = await settled(pop);
      slot = await slotBytes(pop);
    }
    await pop.close();
  }
  note(
    "warm: navigation -> first code (median of 5)",
    median(warm),
    BUDGET.warmFirstCode,
    `runs ${warm.map((x) => x.toFixed(0)).join(", ")}; local reads up to the first code ${warmReads.atFirstCode} (${warmReads.bytesAtFirstCode} B, slot ${slot} B), whole open ${warmReads.local} (${warmReads.localBytes} B), session ${warmReads.session}`,
  );
  expect(warmReads.atFirstCode, "open: local reads before the first code").toBeLessThanOrEqual(READS.open.firstCode);
  expect(
    warmReads.bytesAtFirstCode! / slot,
    "open: bytes read before the first code, in active slots",
  ).toBeLessThanOrEqual(READS.open.slots);
  expect(warmReads.local, "open: local reads in all").toBeLessThanOrEqual(READS.open.all);

  // cold: restart the browser on the same profile
  const dir = p.dir;
  await close(p, false);
  p = await launch(dir);
  await p.ctx.addInitScript(instrument);
  const pop = await openPopup(p);
  const lockAt = await markAt(pop, "x:lockscreen");
  note("cold: navigation -> lock screen", lockAt, BUDGET.coldLockScreen);
  await pop.locator("#secret").fill(STRONG);
  const before = await counts(pop);
  const submitAt = await pop.evaluate(() => {
    const t = performance.now();
    (document.querySelector("form.lock") as HTMLFormElement).requestSubmit();
    return t;
  });
  const codeAt = await markAt(pop, "x:firstcode");
  await expect(pop.locator(".row")).toHaveCount(ACCOUNTS);
  const after = await settled(pop);
  const unlockSlot = await slotBytes(pop);
  // PBKDF2-SHA256 at the 600k floor, in this page, three times: the part of an unlock no code change can remove
  const kdf = await pop.evaluate(async () => {
    const out: number[] = [];
    const pw = new TextEncoder().encode("Q7m#Xv9!pL2@rT5$kB8w");
    for (let i = 0; i < 3; i++) {
      const k = await crypto.subtle.importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
      const t = performance.now();
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 600_000 },
        k,
        256,
      );
      out.push(performance.now() - t);
    }
    return out.sort((a, b) => a - b)[1]!;
  });
  const unlock = codeAt - submitAt;
  note(
    "cold: submit password -> first code",
    unlock,
    null,
    `PBKDF2 ${kdf.toFixed(1)} ms; local reads: lock screen ${before.local}, until the first code ${after.atFirstCode} (${after.bytesAtFirstCode} B, slot ${unlockSlot} B), in all ${after.local} (${after.localBytes} B), session ${after.session}`,
  );
  note("cold: submit password -> first code, minus PBKDF2", unlock - kdf, BUDGET.unlockMinusKdf);
  expect(after.atFirstCode, "unlock: local reads before the first code, lock screen included").toBeLessThanOrEqual(
    READS.unlock.firstCode,
  );
  expect(
    after.bytesAtFirstCode! / unlockSlot,
    "unlock: bytes read before the first code, in active slots",
  ).toBeLessThanOrEqual(READS.unlock.slots);
  expect(after.local, "unlock: local reads in all").toBeLessThanOrEqual(READS.unlock.all);
  expect(unlock).toBeGreaterThan(0); // measured, not judged
});
