// TOTP autofill Stage 2, follow-up 4B-FU (docs/design/notes/AUTOFILL2-NOTES.md §13.8; the 4b review's S-2 and S-3): a
// measurement, not a gate. It runs only with SK_MEASURE=1, and prints what it measured:
//   - with the page's CPU throttled (DevTools' throttling: 1×, 4× and 6×), the time from the suggestion shown to armed, and
//     the share of refused clicks on the normal path, a person clicking it 0.7, 1, 1.5 or 2 s after it appeared and again
//     every half second until it opens (the refusals then say "a moment": S-3's cue);
//   - a page with long tasks of its own (4B-FU2, the 4B-FU review's S-3): 300 ms of work every 700 ms, and 150 ms every
//     700 ms (under GAP_MS, 250): the time to armed, the refusals by reason at a person's pace, and how often the cue
//     ("One moment, then click again") was on the button after a refusal;
//   - the frame loop's cost on a large page (5,000 elements more, no other box): the page's main-thread time per second
//     with the suggestion shown, against the same page after it was dismissed (S-2).
// Its only assertion is that the suggestion opens in the end, within 10 clicks, at every CPU rate (the busy pages are
// measured, not held to it).
import { expect, test } from "@playwright/test";
import type { World } from "./autofill-helpers";
import {
  armed,
  clickPill,
  closePopup,
  decisions,
  dropRequest,
  grantedWorld,
  inWorld,
  showIt,
  tab,
  wait,
  worker,
} from "./suggest-helpers";

test.skip(!process.env.SK_MEASURE, "a measurement: run with SK_MEASURE=1");
test.describe.configure({ timeout: 175_000 });

let w: World | undefined;
const W = async () => (w ??= await grantedWorld());
test.afterAll(async () => {
  await w?.close();
  w = undefined;
});
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

for (const rate of [1, 4, 6])
  test(`CPU ×${rate}: time to armed, and refused clicks at a person's pace`, async () => {
    const x = await W();
    const toArmed: number[] = [];
    const clicks: Record<string, { refused: number; opened: number; why: string[] }> = {};
    for (const pace of [700, 1000, 1500, 2000])
      for (let i = 0; i < 2; i++) {
        const t = await tab(x);
        await t.s.send("Emulation.setCPUThrottlingRate", { rate });
        await showIt(t);
        // the person's first click, at their pace; then again every half second until it opens
        const row = (clicks[pace] ??= { refused: 0, opened: 0, why: [] });
        await wait(pace);
        let opened = false;
        for (let n = 0; n < 10 && !opened; n++) {
          const d = await decisions(t);
          await clickPill(t);
          const v = await d.next();
          if (v === "open") opened = true;
          else (row.refused++, row.why.push(v));
          if (!opened) await wait(500);
        }
        expect(opened, `opened within 10 clicks at CPU ×${rate}`).toBe(true);
        row.opened++;
        await closePopup(x);
        await dropRequest(x);
        await t.page.close();
        // the time to armed, on a page of its own (nothing clicked)
        const u = await tab(x);
        await u.s.send("Emulation.setCPUThrottlingRate", { rate });
        await showIt(u);
        const at = Date.now();
        while (!(await armed(u)) && Date.now() - at < 20_000) await wait(20);
        toArmed.push(Date.now() - at);
        await u.page.close();
      }
    const all = Object.values(clicks).reduce((n, r) => n + r.refused + r.opened, 0);
    const refused = Object.values(clicks).reduce((n, r) => n + r.refused, 0);
    console.log(
      `MEASURE cpu×${rate}: to armed median ${median(toArmed)} ms, max ${Math.max(...toArmed)} ms (n ${toArmed.length}); ` +
        `refused ${refused} of ${all} clicks; by pace ${JSON.stringify(clicks)}`,
    );
  });

/** The page's own work: `ms` of a blocked main thread every 700 ms (run in the page; its argument passed, not closed over). */
const busyPage = (ms: number) =>
  void setInterval(() => {
    const until = performance.now() + ms;
    while (performance.now() < until);
  }, 700);

for (const busy of [300, 150])
  test(`a page busy ${busy} ms every 700 ms: time to armed, refusals and the cue at a person's pace`, async () => {
    const x = await W();
    const cueWords = await worker(x).evaluate(() => chrome.i18n.getMessage("afSugWait"));
    // the second refusal in a row says the shortcut's line instead (4B-FU3): afCanFill's words
    const lineStart = (await worker(x).evaluate(() => chrome.i18n.getMessage("afCanFill", ["\u0001"]))).split(
      "\u0001",
    )[0]!;
    let lined = 0;
    const toArmed: number[] = [];
    const rows: Record<string, { refused: number; opened: number; never: number; why: Record<string, number> }> = {};
    let cued = 0;
    let refusals = 0;
    for (const pace of [700, 1000, 1500, 2000]) {
      const row = (rows[pace] ??= { refused: 0, opened: 0, never: 0, why: {} });
      const t = await tab(x);
      await t.page.evaluate(busyPage, busy);
      await showIt(t);
      await wait(pace);
      let opened = false;
      for (let n = 0; n < 10 && !opened; n++) {
        const d = await decisions(t);
        await clickPill(t);
        const v = await d.next();
        if (v === "open") opened = true;
        else {
          row.refused++;
          refusals++;
          row.why[v] = (row.why[v] ?? 0) + 1;
          const words = await inWorld<string>(t, "L.pill().textContent");
          if (words === cueWords) cued++;
          else if (words.startsWith(lineStart)) lined++;
          await wait(500);
        }
      }
      if (opened) {
        row.opened++;
        await closePopup(x);
        await dropRequest(x);
      } else row.never++;
      await t.page.close();
      // the time to armed, on a page of its own (nothing clicked), 8 s at most
      const u = await tab(x);
      await u.page.evaluate(busyPage, busy);
      await showIt(u);
      const from = Date.now();
      while (!(await armed(u)) && Date.now() - from < 8000) await wait(20);
      toArmed.push(Date.now() - from);
      await u.page.close();
    }
    console.log(
      `MEASURE busy ${busy}/700 ms: to armed ${JSON.stringify(toArmed)} ms (8000: not armed in 8 s); ` +
        `refusals ${refusals}: "one moment" on the button after ${cued} of them, the shortcut's line after ${lined}; ` +
        `by pace ${JSON.stringify(rows)}`,
    );
  });

test("the frame loop's cost on a large page: main-thread time per second, shown against dismissed", async () => {
  const x = await W();
  const t = await tab(x);
  await t.page.evaluate(() => {
    const f = document.createElement("form");
    for (let i = 0; i < 1250; i++)
      f.insertAdjacentHTML("beforeend", `<div class="row"><label>Field ${i}</label><span>${i}</span><b>·</b></div>`);
    document.body.append(f);
  });
  await t.s.send("Performance.enable");
  const busy = async (ms: number) => {
    const m = async () =>
      Object.fromEntries(
        ((await t.s.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map(
          (x) => [x.name, x.value],
        ),
      );
    const a = await m();
    await wait(ms);
    const b = await m();
    const per = (k: string) => Math.round((((b[k] ?? 0) - (a[k] ?? 0)) * 1000 * 1000) / ms); // ms of it per second
    return { task: per("TaskDuration"), script: per("ScriptDuration"), layout: per("LayoutDuration") };
  };
  await showIt(t);
  const shown = await busy(5000);
  await t.page.keyboard.press("Escape"); // dismissed: its frames stop
  await wait(300);
  const dismissed = await busy(5000);
  console.log(
    `MEASURE frame loop, ${await t.page.evaluate(() => document.querySelectorAll("*").length)} elements: ` +
      `shown ${JSON.stringify(shown)} ms/s, dismissed ${JSON.stringify(dismissed)} ms/s`,
  );
});
