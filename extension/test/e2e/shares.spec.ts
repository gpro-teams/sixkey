// Recovery key shares (docs/design/notes/SHAMIR-NOTES.md; ADVANCED-RECOVERY-AND-TIERS §3), in the real browser:
//   1. replace: 2 of 3 made from a new recovery code, each share shown on its own (printed alone, saved alone), the test
//      restore of the two shares Sixkey asks for, the switch; the old code no longer opens the popup's lock screen, two
//      shares do ("I have shares instead"), recorded as a recovery code is;
//   2. split: the current code shared, the test restore writing nothing, "Check my shares", then a new recovery code: the
//      same shares are now an old code's, in the wizard's check and on the popup's lock screen;
//   3. the reset (forgot the password) with shares instead of the code.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { makeShareSet } from "../../src/core/crypto/shares";
import { closeDriven, launchDriven } from "./panel-helpers";
import {
  addByPaste,
  close,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  openPopup,
  type Profile,
  showSection,
  startFresh,
  STRONG,
} from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** The security record's kinds as stored: oldest first. */
const securityKinds = (page: Page) =>
  page.evaluate(
    async () =>
      (
        (await chrome.storage.local.get("sk_security_log")).sk_security_log as
          { entries: { kind: string }[] } | undefined
      )?.entries.map((e) => e.kind) ?? [],
  );

/** Settings › Security › Password & recovery, the shares fold open and its wizard drawn. */
async function wizard(): Promise<Page> {
  const opt = await openOptions(p, "#security-keys");
  await showSection(opt, "security-keys");
  await openFold(opt, "fold-shares");
  await expect(opt.locator("#shares-wizard")).toBeVisible();
  return opt;
}

/** Through the share screens (each kept), collecting each share's text; ends on the test restore. */
async function throughShares(opt: Page, count: number, each?: (i: number, share: string) => Promise<void>) {
  const shares: string[] = [];
  for (let i = 0; i < count; i++) {
    await expect(opt.locator("#shares-sheet-title")).toContainText(String(i + 1));
    const share = (await opt.locator("#shares-share").textContent())!.trim();
    expect(share).toMatch(/^[0-9A-Z]{4}(?:-[0-9A-Z]{4}){8}$/);
    for (const earlier of shares) await expect(opt.locator("#shares-wizard")).not.toContainText(earlier); // one at a time
    await expect(opt.getByRole("button", { name: /^(Copy|复制)$/ })).toHaveCount(0); // no Copy
    await each?.(i, share);
    await expect(opt.locator("#shares-next")).toBeDisabled();
    await opt.locator("#shares-kept").check();
    await opt.locator("#shares-next").click();
    shares.push(share);
  }
  await expect(opt.locator("#shares-test-in")).toBeVisible();
  return shares;
}

/** The members the test restore asks for (0-based), read from its lead line ("Type shares 1 and 3 back ..."). */
async function asked(opt: Page): Promise<number[]> {
  const lead = (await opt.locator("#shares-test-lead").textContent())!;
  return [...lead.matchAll(/\d+/g)].map((m) => Number(m[0]) - 1);
}

/** On the popup's lock screen: Use recovery key, then I have shares instead. */
async function lockShares(pop: Page) {
  await pop.getByRole("button", { name: /Use recovery key|使用恢复密钥/ }).click();
  await pop.locator("#use-shares").click();
  await expect(pop.locator("#lock-shares-in")).toBeVisible();
}

test("replace: 2 of 3 from a new recovery code, printed and saved one at a time, switched only after the test; the popup unlocks with two shares", async () => {
  const { recoveryCode: old } = await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await wizard();
  await expect(opt.locator("#shares-new")).toBeChecked(); // the recommended way, preselected
  await expect(opt.locator("#shares-23")).toBeChecked(); // 2 of 3 by default
  await opt.locator("#shares-pw").fill(STRONG);
  await opt.locator("#shares-make").click();
  await expect(opt.locator("#shares-not-yet")).toBeVisible(); // nothing has changed yet

  // printing shows that one share alone: the print view hides the page and shows only the share's paper
  await opt.evaluate(() => {
    const w = window as unknown as { __printed: { text: string; page: string; paper: string }[] };
    w.__printed = [];
    window.print = () => {
      const paper = document.getElementById("sh-print")!;
      w.__printed.push({
        text: paper.innerText,
        // everything else under <body> (the page itself) is not printed
        page: [...document.body.children]
          .filter((e) => e !== paper)
          .map((e) => getComputedStyle(e).display)
          .join(),
        paper: getComputedStyle(paper).display,
      });
    };
  });
  const shares = await throughShares(opt, 3, async (i, share) => {
    if (i === 0) {
      await opt.emulateMedia({ media: "print" });
      await opt.locator("#shares-print").click();
      await opt.emulateMedia({ media: "screen" });
      const printed = await opt.evaluate(
        () => (window as unknown as { __printed: { text: string; page: string; paper: string }[] }).__printed,
      );
      expect(printed).toHaveLength(1);
      expect(printed[0]!.text).toContain(share);
      expect(printed[0]!.text).toMatch(/1 of 3|第 1 份/);
      expect(printed[0]!.page).toMatch(/^none(?:,none)*$/);
      expect(printed[0]!.paper).toBe("block");
      await expect(opt.locator("#sh-print")).toHaveCount(0); // gone once printing is over
    }
    if (i === 1) {
      const [dl] = await Promise.all([opt.waitForEvent("download"), opt.locator("#shares-save").click()]);
      expect(dl.suggestedFilename()).toMatch(/^sixkey-share-[0-9A-F]{4}-2-of-3\.txt$/);
      const file = readFileSync((await dl.path())!, "utf8");
      expect(file).toContain(share);
      await expect(opt.locator("#shares-save-warn")).toBeVisible();
    }
  });
  expect(new Set(shares).size).toBe(3);

  // the test restore: the two members asked for; nothing switches before both are typed and Switch is pressed
  const want = await asked(opt);
  expect(want).toHaveLength(2);
  await expect(opt.locator("#shares-switch")).toBeDisabled();
  const notAsked = [0, 1, 2].find((i) => !want.includes(i))!;
  await opt.locator("#shares-test-in").fill(shares[notAsked]!);
  await expect(opt.locator("#shares-test-err")).toBeVisible(); // not the one asked for
  for (const i of want) await opt.locator("#shares-test-in").fill(shares[i]!.toLowerCase());
  await expect(opt.locator("#shares-test-rebuilt")).toBeVisible();
  expect(await securityKinds(opt)).not.toContain("recovery_code_new"); // still nothing written
  await opt.locator("#shares-switch").click();
  await expect(opt.locator("#shares-done")).toBeVisible();
  // keep the old code until the shares pass a check after a browser restart (a commit can be rolled back by power loss)
  await expect(opt.locator("#shares-done")).toContainText(/Keep the old recovery key|请先保留旧的恢复密钥/);
  expect(await securityKinds(opt)).toContain("recovery_code_new");
  await opt.close();

  // the popup's lock screen: the old code no longer opens; two shares (any two) do
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await pop.getByRole("button", { name: /Use recovery key|使用恢复密钥/ }).click();
  await pop.locator("#secret").fill(old);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.getByRole("alert")).toContainText(/does not match|不匹配/);
  await pop.locator("#use-shares").click();
  await expect(pop.locator("#lock-shares-in")).toHaveAttribute("type", "password");
  await pop.locator("#lock-shares-in").fill(shares[notAsked]!);
  await expect(pop.locator("#lock-shares-progress")).toBeVisible();
  await pop.locator("#lock-shares-in").fill(shares[want[0]!]!);
  await expect(pop.locator(".row", { hasText: "GitHub" })).toBeVisible();
  const kinds = await securityKinds(pop);
  expect(kinds.at(-1)).toBe("recovery_used"); // recorded as a recovery code is
  expect(kinds).toContain("recovery_failed"); // the old code
});

test("split: the current code shared, nothing written; check my shares; after a new recovery code the same shares are an old code's", async () => {
  const { recoveryCode: code } = await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await wizard();
  await opt.locator("#shares-current").check();
  await opt.locator("#shares-code").fill(code);
  await opt.locator("#shares-make").click();
  await expect(opt.locator("#shares-sheet-title")).toBeVisible();
  await expect(opt.locator("#shares-not-yet")).toHaveCount(0); // nothing will change
  const before = await opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  const shares = await throughShares(opt, 3);
  for (const i of await asked(opt)) await opt.locator("#shares-test-in").fill(shares[i]!);
  await expect(opt.locator("#shares-done")).toBeVisible();
  await expect(opt.locator("#shares-switch")).toHaveCount(0);
  expect(await opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)))).toBe(before);

  // check my shares: writes nothing, records nothing
  await opt.locator("#shares-again").click();
  await opt.locator("#shares-check-open").click();
  await opt.locator("#shares-check-in").fill(shares[0]!);
  await opt.locator("#shares-check-in").fill(shares[1]!);
  await expect(opt.locator("#shares-check-ok")).toBeVisible();
  expect(await opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)))).toBe(before);

  // a new recovery code: it says the shares stop working too
  await openFold(opt, "fold-code");
  await expect(opt.locator("#code-shares-note")).toBeVisible();
  await opt.locator("#code-pw").fill(STRONG);
  await opt.locator("#new-code").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await expect(opt.locator("#recovery-code")).toHaveCount(0);

  // the same shares, checked again: an old recovery code's
  await openFold(opt, "fold-shares");
  await opt.locator("#shares-check-open").click();
  await opt.locator("#shares-check-in").fill(shares[2]!);
  await opt.locator("#shares-check-in").fill(shares[0]!);
  await expect(opt.locator("#shares-check-stale")).toBeVisible();
  await expect(opt.locator("#shares-check-ok")).toHaveCount(0);
  await opt.close();

  // and on the popup's lock screen: refused, said so, still locked
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await lockShares(pop);
  await pop.locator("#lock-shares-in").fill(shares[1]!);
  await pop.locator("#lock-shares-in").fill(shares[2]!);
  await expect(pop.locator("#lock-shares-stale")).toBeVisible();
  await expect(pop.locator(".row", { hasText: "GitHub" })).toHaveCount(0);
  expect((await securityKinds(pop)).at(-1)).toBe("recovery_failed");
  // Start again empties the entry, and it asks from the first share again
  await pop.locator("#lock-shares-clear").click();
  await expect(pop.locator("#lock-shares-typed")).toHaveCount(0);
  await pop.locator("#lock-shares-in").fill(shares[0]!);
  await expect(pop.locator("#lock-shares-progress")).toBeVisible();
});

test("forgot the password: the reset takes shares instead of the recovery code", async () => {
  await startFresh(p);
  const opt = await wizard();
  await opt.locator("#shares-pw").fill(STRONG);
  await opt.locator("#shares-make").click();
  const shares = await throughShares(opt, 3);
  const want = await asked(opt);
  for (const i of want) await opt.locator("#shares-test-in").fill(shares[i]!);
  await opt.locator("#shares-switch").click();
  await expect(opt.locator("#shares-done")).toBeVisible();
  await opt.close();

  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await pop.getByRole("button", { name: /Use recovery key|使用恢复密钥/ }).click();
  const [tab] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#forgot-password").click()]);
  await expect(tab.locator("#reset")).toBeVisible();
  await expect(tab.locator("#reset-shares-note")).toBeVisible(); // the reset makes a new code: the shares stop working
  await tab.locator("#reset-code-in-shares-link").click();
  for (const i of [2, 0]) await tab.locator("#reset-code-in-shares-in").fill(shares[i]!);
  await expect(tab.locator("#reset-code-in-shares-rebuilt")).toBeVisible();
  const NEW = "Zk4#nW8!qR2@vL7$mT5x";
  await tab.locator("#reset-pw").fill(NEW);
  await tab.locator("#reset-pw2").fill(NEW);
  await tab.locator("#reset-next").click();
  await expect(tab.locator("#recovery-code")).toBeVisible();
  await tab.locator("#recovery-saved").check();
  await tab.locator("#recovery-done").click();
  await expect(tab.locator("#reset-done")).toBeVisible();
  expect(await securityKinds(tab)).toContain("password_reset");
});

test("the side panel's lock screen: shares typed and held (their field empty) are wiped after 2 idle minutes", async () => {
  test.setTimeout(90_000);
  await close(p);
  p = await launchDriven(); // the panel's page as panel-helpers.ts opens it
  try {
    await startFresh(p);
    // a well-formed share of some set: it is read, and held, but not combined before the set's threshold
    const share = (await makeShareSet(new Uint8Array(16).fill(1), 2, 3)).shares[0]!;
    const page = await p.ctx.newPage();
    await page.clock.install();
    await page.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
    await expect(page.locator("#q")).toBeVisible();
    await page.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
    await lockShares(page);
    await page.locator("#lock-shares-in").fill(share);
    await expect(page.locator("#lock-shares-typed")).toBeVisible();
    await expect(page.locator("#lock-shares-in")).toHaveValue(""); // nothing in any field: only the entry holds it
    await page.clock.fastForward(60_000);
    await expect(page.locator("#lock-shares-typed")).toBeVisible();
    await page.clock.fastForward(60_000 + 20_000);
    await expect(page.locator("#lock-shares-typed")).toHaveCount(0);
    await expect(page.locator("#secret")).toBeVisible(); // drawn again from storage, at the lock screen's start
  } finally {
    await closeDriven(p);
    p = await launch(); // for afterEach
  }
});

test("replacing a vault (start over) says shares of its recovery code stop working; a new profile's first run does not", async () => {
  const fresh = await openOptions(p, "#setup");
  await fresh.locator("#fr-pw").fill(STRONG);
  await fresh.locator("#fr-pw2").fill(STRONG);
  await fresh.locator("#fr-next").click();
  await expect(fresh.locator("#recovery-code")).toBeVisible();
  await expect(fresh.locator("#fr-shares-note")).toHaveCount(0); // nothing to replace: no shares can exist
  fresh.on("dialog", (d) => void d.accept());
  await fresh.close({ runBeforeUnload: true });

  const seed = await openPopup(p);
  await seed.evaluate(() => chrome.storage.local.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } }));
  await seed.close();
  const opt = await openOptions(p, "#advanced");
  await opt.locator("#so-confirm").fill("DELETE");
  await opt.locator("#so-go").click();
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  await expect(opt.locator("#fr-shares-note")).toBeVisible();
});

test("the test restore refuses a paper of an earlier set as it is typed; from the next browser start the popup reminds at every unlock until the shares pass a check", async () => {
  test.setTimeout(120_000);
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  // an earlier set, made and left unfinished: its papers exist, and open nothing
  let opt = await wizard();
  await opt.locator("#shares-pw").fill(STRONG);
  await opt.locator("#shares-make").click();
  const earlier = await throughShares(opt, 3);
  await opt.locator("#shares-cancel").click();
  // the set that is finished
  await opt.locator("#shares-pw").fill(STRONG);
  await opt.locator("#shares-make").click();
  const shares = await throughShares(opt, 3);
  const want = await asked(opt);
  await opt.locator("#shares-test-in").fill(earlier[want[0]!]!); // the right member, from the earlier paper
  await expect(opt.locator("#shares-test-err")).toContainText(/set|分片组/);
  await expect(opt.locator("#shares-test-typed")).toHaveCount(0);
  await expect(opt.locator("#shares-switch")).toBeDisabled();
  for (const i of want) await opt.locator("#shares-test-in").fill(shares[i]!);
  await opt.locator("#shares-switch").click();
  await expect(opt.locator("#shares-done")).toBeVisible();
  // a check at once passes, and asks for one more after the restart: the reminder stays (the review's N1)
  await opt.locator("#shares-again").click();
  await opt.locator("#shares-check-open").click();
  for (const i of [1, 2]) await opt.locator("#shares-check-in").fill(shares[i]!);
  await expect(opt.locator("#shares-check-ok")).toBeVisible();
  await expect(opt.locator("#shares-check-restart")).toBeVisible();
  await opt.close();

  // no reminder in this browser session
  let pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await pop.locator("#secret").fill(STRONG);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator(".row", { hasText: "GitHub" })).toBeVisible();
  await pop.waitForTimeout(500);
  await expect(pop.locator("#shares-remind")).toHaveCount(0);
  await pop.close();

  // the browser restarts: the reminder, once the master password has opened the popup
  const dir = p.dir;
  await close(p, false);
  p = await launch(dir);
  pop = await openPopup(p);
  await pop.locator("#secret").fill(STRONG);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator("#shares-remind")).toBeVisible();
  await expect(pop.locator("#shares-remind")).toContainText(/destroy the old recovery key|再销毁旧的恢复密钥/);
  const [tab] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#shares-remind button").click()]);
  await expect(tab.locator("#shares-check-in")).toBeVisible(); // straight at "Check my shares"
  for (const i of [2, 0]) await tab.locator("#shares-check-in").fill(shares[i]!);
  await expect(tab.locator("#shares-check-ok")).toBeVisible();
  await expect(tab.locator("#shares-check-restart")).toHaveCount(0); // after the restart: this check is the one
  await tab.close();
  await pop.close();
  // checked: no reminder any more
  pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await pop.locator("#secret").fill(STRONG);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator(".row", { hasText: "GitHub" })).toBeVisible();
  await pop.waitForTimeout(500);
  await expect(pop.locator("#shares-remind")).toHaveCount(0);
});
