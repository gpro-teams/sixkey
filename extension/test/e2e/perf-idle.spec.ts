// PHASE0X-PLAN B1 / ux-study §2.3: main-thread time an open popup uses while nobody touches it. Timing is noisy, so this
// only warns (a test annotation and a console line); it never fails on the number. Budget: 20 ms per second with 100
// accounts (before B1: about 230).
import { expect, test } from "@playwright/test";
import { addByPaste, close, launch, openPopup, startFresh, type Profile } from "./harness";
import { accountLines } from "./list-helpers";

const ACCOUNTS = 100;
const BUDGET_MS_PER_S = 20;

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

test("idle CPU with 100 accounts, popup open for 10 seconds (warning only)", async () => {
  test.setTimeout(120_000);
  await startFresh(p);
  await addByPaste(p, accountLines(ACCOUNTS));
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(ACCOUNTS);
  await expect(pop.locator(".row .code:not(.wait)").first()).toBeVisible();

  const cdp = await p.ctx.newCDPSession(pop);
  await cdp.send("Performance.enable");
  const metrics = async () =>
    Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value])) as Record<
      string,
      number
    >;
  await pop.waitForTimeout(1_000); // let the opening settle
  const m0 = await metrics();
  await pop.waitForTimeout(10_000);
  const m1 = await metrics();
  const perSecond = (k: string) => ((m1[k]! - m0[k]!) * 1000) / (m1.Timestamp! - m0.Timestamp!);
  const task = perSecond("TaskDuration");
  const detail = `TaskDuration ${task.toFixed(1)} ms/s (script ${perSecond("ScriptDuration").toFixed(1)}, style ${perSecond("RecalcStyleDuration").toFixed(1)}, layout ${perSecond("LayoutDuration").toFixed(1)}); budget ${BUDGET_MS_PER_S}`;
  test.info().annotations.push({ type: "idle-cpu", description: detail });
  if (task > BUDGET_MS_PER_S) {
    test.info().annotations.push({ type: "warning", description: `idle CPU over budget: ${detail}` });
    console.warn(`WARNING idle CPU over budget: ${detail}`);
  } else console.log(`idle CPU: ${detail}`);
  expect(task).toBeGreaterThanOrEqual(0); // measured, not judged
});
