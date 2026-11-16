// The security record on screen (PHASE0X-PLAN C7; SYNC-DESIGN H6, Z4): the popup's "N wrong passwords" notice after an
// unlock, and the card in Settings > Security. The record itself is A3's (security-log.ts); what the notice reads and
// when is src/popup/notice.ts; the read it costs is counted in test/unit/read-budget.test.ts and perf.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import {
  addByPaste,
  AWS_URI,
  close,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  openPopup,
  type Profile,
  seedLegacyDeviceVault,
  showSection,
  startFresh,
  STRONG,
} from "./harness";
import {
  failedCount,
  guessWrong,
  lockPopup,
  popupTrace,
  record,
  resetTrace,
  trace,
  unlockPopup,
  WRONG,
} from "./security-helpers";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const notice = (pop: Page) => pop.locator("#sec-notice");
const READ = 'get:["sk_security_log"]';
/** What the popup did with the record since the trace was reset, once it has settled. */
async function settledTrace(pop: Page): Promise<string[]> {
  let last = "";
  for (let same = 0; same < 6;) {
    await pop.waitForTimeout(150);
    const now = JSON.stringify(await trace(pop));
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return JSON.parse(last) as string[];
}

test("3 wrong passwords, then the right one: the popup says 3 (no 'data restored'), the card says the same, the ack comes once it is on screen, the next unlock says nothing", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  await p.ctx.addInitScript(popupTrace);
  const pop = await openPopup(p);
  await lockPopup(pop);
  await guessWrong(pop, 3);

  // Settings while locked: the card shows the 3, and looking at it acks nothing
  const opt = await openOptions(p, "#security-log");
  const count = opt.locator("#sec-log-count");
  await expect(count).toContainText(/: 3$|：3$/);
  await expect(opt.locator("#sec-log-list li.bad")).toHaveCount(3);
  await expect(opt.locator("#sec-log-list li").first()).toContainText(/Wrong master password|主密码输错/);
  await opt.reload();
  await expect(count).toContainText(/: 3$|：3$/);
  expect(await failedCount(opt)).toBe(3);

  await resetTrace(pop);
  await unlockPopup(pop);
  await expect(pop.locator(".row")).toHaveCount(1);
  await expect(notice(pop)).toBeVisible();
  await expect(notice(pop)).toContainText(/\b3\b/);
  await expect(notice(pop)).toHaveAttribute("role", "status");
  await expect(pop.getByRole("alert")).toHaveCount(0); // no "data restored" banner, and the notice is not one
  await expect(pop.getByRole("button", { name: /Got it|知道了/ })).toHaveCount(0);
  await expect.poll(() => failedCount(pop)).toBe(0); // acked: the 3 shown came off
  // one read, after the first code; the ack (a read and a write under the record's lock) only after the notice had a frame
  expect(await settledTrace(pop)).toEqual(["code", READ, "notice", "frame", READ, "set"]);
  // the entries stay; only the count went down
  expect((await record(pop))?.entries?.map((e) => e.kind)).toEqual(["unlock_failed", "unlock_failed", "unlock_failed"]);
  expect(await pop.evaluate(async () => (await chrome.storage.local.get("sk_events")).sk_events ?? [])).toEqual([]);

  // the open settings page follows: 0 not yet shown, the 3 entries still listed
  await expect(count).toContainText(/: 0$|：0$/);
  await expect(opt.locator("#sec-log-list li.bad")).toHaveCount(3);

  // the next unlock reads again and has nothing to say
  await lockPopup(pop);
  await resetTrace(pop);
  await unlockPopup(pop);
  expect(await settledTrace(pop)).toEqual(["code", READ]);
  await expect(notice(pop)).toHaveCount(0);
});

test("only an unlock reads the record: wrong guesses while unlocked wait for the next unlock; the reset needs the master password, refuses and counts a wrong one", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  await p.ctx.addInitScript(popupTrace);

  // an empty record: nothing to clear
  const opt = await openOptions(p, "#security-log");
  await expect(opt.locator(".nothing", { hasText: /Nothing recorded|还没有/ })).toBeVisible();
  await expect(opt.locator("#sec-log-clear")).toHaveCount(0);
  // a wrong password while Sixkey is unlocked (asked again for a new recovery code), then one in the card's reset:
  // the reset refuses it and counts it
  await showSection(opt, "security-keys");
  await openFold(opt, "fold-code");
  await opt.locator("#code-pw").fill(WRONG);
  await opt.locator("#new-code").click();
  await expect(opt.getByRole("alert")).toContainText(/Wrong password|密码错误/);
  await showSection(opt, "security-log");
  await expect(opt.locator("#sec-log-count")).toContainText(/: 1$|：1$/);
  await opt.locator("#sec-log-clear").click();
  const confirm = opt.locator("#sec-log-confirm");
  await expect(opt.locator("#sec-log-pw")).toBeFocused();
  await expect(confirm).toBeDisabled(); // nothing typed: no request at all
  await opt.locator("#sec-log-pw").fill(WRONG);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(opt.locator("#security-log [role=alert]")).toContainText(/Wrong password|密码错误/);
  await expect(opt.locator("#sec-log-count")).toContainText(/: 2$|：2$/);
  await expect(opt.locator("#sec-log-list li")).toHaveCount(2);
  expect((await record(opt))?.entries?.map((e) => e.kind)).toEqual(["unlock_failed", "unlock_failed"]);

  // opening the popup is not an unlock: no read of the record, no notice
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(1);
  expect(await settledTrace(pop)).toEqual(["code"]); // the list, and not one read of the record
  await expect(notice(pop)).toHaveCount(0);
  expect(await failedCount(pop)).toBe(2);

  // the next unlock tells
  await lockPopup(pop);
  await resetTrace(pop);
  await unlockPopup(pop);
  await expect(notice(pop)).toContainText(/\b2\b/);
  await expect.poll(() => failedCount(pop)).toBe(0);

  // the right password clears it: one dated line stays
  await opt.locator("#sec-log-pw").fill(STRONG);
  await opt.locator("#sec-log-confirm").click();
  await expect(opt.locator("#security-log [role=status]")).toContainText(/Record cleared|记录已清空/);
  await expect(opt.locator("#sec-log-list li")).toHaveCount(1);
  await expect(opt.locator("#sec-log-list li")).toContainText(/Record cleared|记录已清空/);
  await expect(opt.locator("#sec-log-count")).toContainText(/: 0$|：0$/);
  expect((await record(opt))?.entries?.map((e) => e.kind)).toEqual(["log_cleared"]);
});

test("a wrong guess made after the popup read the count is still counted: the ack takes off only the number shown", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  await p.ctx.addInitScript(popupTrace);
  const pop = await openPopup(p);
  await lockPopup(pop);
  await guessWrong(pop, 2);
  await pop.evaluate(() => {
    (globalThis as unknown as { __c7inject: boolean }).__c7inject = true;
  });
  await unlockPopup(pop);
  await expect(notice(pop)).toContainText(/\b2\b/); // what the read found; the third came just after it
  await expect.poll(() => failedCount(pop)).toBe(1);
  await lockPopup(pop);
  await unlockPopup(pop);
  await expect(notice(pop)).toContainText(/\b1\b/);
  await expect.poll(() => failedCount(pop)).toBe(0);
});

test("a damaged record, or one from a newer version, reads as 'can't be read' in the popup and on the card, never as 0; the reset still replaces it", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await openOptions(p, "#security-log");
  for (const [bad, why] of [
    ["half a write", /damaged|已损坏/],
    [{ v: 3, entries: [], failed: 0 }, /newer version|更新版本/],
  ] as const) {
    await opt.evaluate((v) => chrome.storage.local.set({ sk_security_log: v }), bad);
    await expect(opt.locator("#sec-log-bad")).toContainText(/can't be read|无法读取安全记录/);
    await expect(opt.locator("#sec-log-bad")).toContainText(why);
    await expect(opt.locator("#sec-log-count")).toHaveCount(0);
    await expect(opt.locator("#sec-log-bad")).not.toHaveAttribute("role", "alert");
    const pop = await openPopup(p);
    await lockPopup(pop);
    await unlockPopup(pop);
    await expect(notice(pop)).toContainText(/can't be read|无法读取安全记录/);
    await expect(notice(pop)).not.toContainText(/\d/);
    await pop.waitForTimeout(500);
    expect(await record(pop)).toEqual(bad); // nothing acked, nothing added by the read
    await pop.close();
  }
  await opt.locator("#sec-log-clear").click();
  await opt.locator("#sec-log-pw").fill(STRONG);
  await opt.locator("#sec-log-confirm").click();
  await expect(opt.locator("#sec-log-bad")).toHaveCount(0);
  await expect(opt.locator("#sec-log-list li")).toContainText(/Record cleared|记录已清空/);
});

test("the notice and the 'data restored' banner are two things: both shown, each acked on its own", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  await addByPaste(p, AWS_URI);
  const pop = await openPopup(p);
  await lockPopup(pop);
  await guessWrong(pop, 2);
  await pop.evaluate(async () => {
    const { sk_active } = (await chrome.storage.local.get("sk_active")) as { sk_active: "a" | "b" };
    await chrome.storage.local.set({ [`sk_slot_${sk_active}`]: { torn: "half a write" } });
  });
  await pop.reload();
  await unlockPopup(pop);
  await expect(pop.getByRole("alert")).toContainText(/restored|恢复/);
  await expect(notice(pop)).toContainText(/\b2\b/);
  await expect.poll(() => failedCount(pop)).toBe(0);
  const events = () =>
    pop.evaluate(
      async () => ((await chrome.storage.local.get("sk_events")).sk_events as { ack?: unknown }[] | undefined) ?? [],
    );
  expect(await events()).toHaveLength(1); // the restore is still there to acknowledge
  await expect(pop.getByRole("alert")).toBeVisible();
  await pop.getByRole("button", { name: /Got it|知道了/ }).click();
  await expect(pop.getByRole("alert")).toHaveCount(0);
  await expect(notice(pop)).toBeVisible(); // "Got it" is the banner's alone
  expect((await record(pop))?.entries?.map((e) => e.kind)).toEqual(["unlock_failed", "unlock_failed"]);
});

test("a Phase 0 device-key vault: the card lists the newest first, a bounded number, clears without a password (there is none), and says the key is kept unlocked", async () => {
  await seedLegacyDeviceVault(p, [GITHUB_URI]);
  const opt = await openOptions(p, "#security-log");
  await expect(opt.locator("#security-stored")).toContainText(/unlocked: a copy of this profile opens them|未加锁/);
  await expect(opt.locator("#security-stored")).not.toContainText(/While unlocked|解锁期间/); // no session key for this vault
  // 19 encrypted backups, then a plain text list: the newest on top, 15 shown and the rest counted
  await opt.evaluate(() =>
    chrome.storage.local.set({
      sk_security_log: {
        v: 1,
        entries: Array.from({ length: 20 }, (_, i) => ({
          at: Date.now() - (20 - i) * 60_000,
          kind: i === 19 ? "export_plain" : "export_encrypted",
        })),
        failed: 0,
      },
    }),
  );
  const items = opt.locator("#sec-log-list li");
  await expect(items).toHaveCount(16);
  await expect(items.first()).toContainText(/Plain text list saved|保存了明文列表/);
  await expect(items.nth(1)).toContainText(/Encrypted backup saved|保存了加密备份/);
  await expect(items.last()).toContainText(/and 5 older|另有 5 条/);
  await opt.locator("#sec-log-clear").click();
  await expect(opt.locator("#sec-log-pw")).toHaveCount(0);
  await opt.locator("#sec-log-confirm").click();
  await expect(items).toHaveCount(1);
  await expect(items).toContainText(/Record cleared|记录已清空/);
  expect((await record(opt))?.entries?.map((e) => e.kind)).toEqual(["log_cleared"]);
});
