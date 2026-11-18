// The backup in Chrome's sync storage's pages in the real extension (dist-e2e/), in Playwright's Chromium, signed in to
// no Google account: chrome.storage.sync works there and stays on this computer (test/e2e/csb-probe.spec.ts), so
// nothing here reaches the network. "Another computer" is another profile, whose storage.sync is given the first one's
// items by one of its pages, as Chrome sync would deliver them (a page's write here is the test's, standing in for
// Chrome; the extension's pages never write the area). Copies of another computer's are made in Node with the same code.
//   - First run with the box (ticked for "only me"), an account, and this computer's copy in the area; another computer
//     finds it above its first step, restores it with the master password and goes on with that copy; a third, with the
//     recovery key after a wrong secret, sets a new master password first.
//   - A copy whose manifest arrives before its chunks: the restore step says so, and goes on when they come.
//   - Held: the store fell back to an older copy; the card's merge brings the newer accounts back and the backup goes on.
//   - No room: other data and another computer's copy fill the area; the card's merge-and-remove frees it.
import { expect, test, type Page } from "@playwright/test";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { planSlot, readSlots, ROOM_BYTES } from "../../src/core/cloud/slots";
import type { Generation } from "../../src/core/storage/format";
import { openWithPassword } from "../../src/core/crypto/keyring";
import { account, PASSWORD, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import { chromiumItemBytes } from "../helpers/fake-sync-area";
import {
  addByPaste,
  AWS_URI,
  close,
  finishWizard,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  STRONG,
  type Profile,
} from "./harness";

const area = (page: Page) => page.evaluate(() => chrome.storage.sync.get(null));
/** Items put into a profile's storage.sync by its page: Chrome sync delivering another computer's. */
const deliver = (page: Page, items: Record<string, unknown>) => page.evaluate((i) => chrome.storage.sync.set(i), items);
const local = (page: Page, key: string) =>
  page.evaluate(async (k) => (await chrome.storage.local.get(k))[k] as Record<string, unknown> | undefined, key);
const linkOf = async (page: Page) => ((await local(page, "sk_csb_cfg"))?.link ?? null) as { slot: string } | null;
/** The whole copies in a profile's area. */
const whole = async (page: Page) =>
  (await readSlots(await area(page))).slots.filter((s) => s.read.kind === "ok").map((s) => s.slot);
/** The vault on disk, as the store's pointer names it. */
const onDisk = (page: Page) =>
  page.evaluate(async () => {
    const ptr = (await chrome.storage.local.get("sk_active")).sk_active as string;
    return (await chrome.storage.local.get(`sk_slot_${ptr}`))[`sk_slot_${ptr}`];
  }) as Promise<Generation>;

const open: Profile[] = [];
test.afterEach(async () => {
  for (const p of open.splice(0)) await close(p);
});
async function profile(): Promise<Profile> {
  const p = await launch();
  open.push(p);
  return p;
}

/** First run's new vault on `p`, as the person sees it: the box left as it is shown. Returns the recovery code. */
async function newVault(p: Profile): Promise<{ opt: Page; code: string }> {
  const pop = await openPopup(p);
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#start-secure").click()]);
  await opt.waitForLoadState();
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  const code = (await opt.locator("#recovery-code").textContent())!.trim();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await expect(opt.locator("#fr-solo")).toBeChecked();
  await expect(opt.locator("#fr-csb")).toBeChecked(); // "only me": ticked, with its cost beside it
  await expect(opt.locator("#fr-csb-cost")).toBeVisible();
  await opt.locator("#fr-finish").click();
  await expect(opt.locator("#fr-hint")).toBeVisible();
  return { opt, code };
}

/**
 * The restore step's field, and the profile question after it. A recovery key's restore then offers to keep the same
 * master password (`keep`) or to set a new one (`newPassword`).
 */
async function restore(opt: Page, secret: string, o: { newPassword?: string; keep?: boolean } = {}) {
  await opt.locator("#cs-restore-secret").fill(secret);
  await opt.locator("#cs-open").click();
  if (o.keep) {
    await expect(opt.locator("#cs-keep-password")).toBeVisible({ timeout: 30_000 });
    await opt.locator("#cs-keep-password").click();
  }
  if (o.newPassword) {
    await expect(opt.locator("#fr-pw")).toBeVisible({ timeout: 30_000 });
    await opt.locator("#fr-pw").fill(o.newPassword);
    await opt.locator("#fr-pw2").fill(o.newPassword);
    await opt.locator("#fr-next").click();
  }
  await expect(opt.locator("#fr-solo")).toBeVisible({ timeout: 30_000 });
  await expect(opt.locator("#fr-csb")).toBeChecked();
  await opt.locator("#fr-finish").click();
  await expect(opt.locator("#fr-hint")).toBeVisible({ timeout: 30_000 });
}

test("first run with the box, an account, its copy; another computer finds it and goes on with it; a third with the recovery key", async () => {
  test.setTimeout(300_000);
  const one = await profile();
  const { opt, code } = await newVault(one);
  await opt.close();
  // the owner's report of 2026-11-17: a master password set and no account yet, and the vault is handed over already,
  // so a second computer finds it (it used to find nothing, and offered a second master password)
  const pop = await openPopup(one);
  await expect.poll(() => whole(pop), { timeout: 60_000 }).toHaveLength(1);
  const mine = (await linkOf(pop))!.slot;
  await addByPaste(one, GITHUB_URI);
  // the e2e build writes 5 s after the change (the store's 30 s): the account's copy goes to the same slot
  const card = await openOptions(one, "#backup");
  await expect(card.locator("#csb-card")).toHaveAttribute("data-state", "ok", { timeout: 60_000 });
  expect(await whole(pop)).toEqual([mine]);
  await expect(card.locator("#cs-status")).toHaveText(
    /^(Handed to (Chrome|browser) sync|已交给(Chrome |浏览器)同步) · /i,
  );
  const items = await area(pop);

  // another computer: the copy delivered, found above the first step, restored with the master password
  const two = await profile();
  const w2 = await openPopup(two);
  await deliver(w2, items);
  const [o2] = await Promise.all([two.ctx.waitForEvent("page"), w2.locator("#start-secure").click()]);
  await o2.waitForLoadState();
  await expect(o2.locator("#cs-found")).toBeVisible();
  await expect(o2.locator("#fr-pw")).toBeVisible(); // a new vault is still offered
  await o2.locator("#cs-found-restore").click();
  await restore(o2, STRONG);
  await expect(o2.locator("#fr-hint")).toContainText(/Restored 1|已恢复 1/);
  // it goes on with the copy it came from: the same slot, its own copy of nothing else
  await expect.poll(async () => (await linkOf(o2))?.slot, { timeout: 30_000 }).toBe(mine);
  expect(await whole(o2)).toEqual([mine]);
  const p2 = await openPopup(two);
  await expect(p2.locator(".row", { hasText: "GitHub" })).toHaveCount(1);

  // a third: #setup-csb, a wrong secret said, then the recovery key, and a new master password first
  const three = await profile();
  const w3 = await openPopup(three);
  await deliver(w3, items);
  const o3 = await openOptions(three, "#setup-csb");
  await expect(o3.locator("#cs-found-n")).toBeVisible();
  await o3.locator("#cs-restore-secret").fill("not the password");
  await o3.locator("#cs-open").click();
  await expect(o3.locator("#cs-wrong")).toBeVisible({ timeout: 30_000 });
  // the owner's report of 2026-11-18: by the recovery key, the same master password as the other computers goes on
  await restore(o3, code, { keep: true });
  await expect.poll(async () => (await linkOf(o3))?.slot, { timeout: 30_000 }).toBe(mine);
  const g3 = await onDisk(o3);
  expect((await openWithPassword(g3.keyring, STRONG)).vk.id).toBe(g3.keyring.vkId);
  const p3 = await openPopup(three);
  await expect(p3.locator(".row", { hasText: "GitHub" })).toHaveCount(1);
});

test("a copy whose manifest arrives before its chunks: the restore step waits, then goes on when they come", async () => {
  test.setTimeout(180_000);
  const keys = await protectedKeys();
  const gen = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ")]), 4);
  const plan = await planSlot(await makeCloudBackup(gen, "both", "Sixkey 0.0.0"), "theirs03", "00112233445566ff");
  if (plan.kind !== "plan") throw new Error("unexpected");
  const p = await profile();
  const w = await openPopup(p);
  const manifest = "bk1.theirs03";
  await deliver(w, { [manifest]: plan.items[manifest] });
  const opt = await openOptions(p, "#setup-csb");
  await expect(opt.locator("#cs-partial-only")).toBeVisible();
  await expect(opt.locator("#cs-restore-secret")).toHaveCount(0); // nothing still arriving is used
  await deliver(w, Object.fromEntries(Object.entries(plan.items).filter(([k]) => k !== manifest)));
  await expect(opt.locator("#cs-restore-secret")).toBeVisible();
  await restore(opt, PASSWORD);
  await expect.poll(async () => (await linkOf(opt))?.slot, { timeout: 30_000 }).toBe("theirs03");
  const pop = await openPopup(p);
  await expect(pop.locator(".row", { hasText: "Proton" })).toHaveCount(1);
});

test("held: the store fell back to an older copy; the card's merge brings the newer accounts back and the backup goes on", async () => {
  test.setTimeout(240_000);
  const p = await profile();
  const { opt } = await newVault(p);
  await opt.close();
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await expect.poll(() => whole(pop), { timeout: 60_000 }).toHaveLength(1);
  await addByPaste(p, AWS_URI);
  // both accounts handed over (the copy's save counter moves past the first write)
  const firstSeq = ((await local(pop, "sk_csb_cfg"))!.link as { seq: number }).seq;
  await expect
    .poll(async () => ((await local(pop, "sk_csb_cfg"))!.link as { seq: number }).seq, { timeout: 60_000 })
    .toBeGreaterThan(firstSeq);
  // the newest generation on disk damaged: the next load falls back to the one before (GitHub alone), and holds
  const ptr = (await pop.evaluate(async () => (await chrome.storage.local.get("sk_active")).sk_active)) as string;
  await pop.evaluate((k) => chrome.storage.local.set({ [k]: { torn: "half a write" } }), `sk_slot_${ptr}`);
  const card = await openOptions(p, "#backup");
  await expect(card.locator("#csb-card")).toBeVisible();
  await card.locator("#cs-now").click();
  await expect(card.locator("#csb-card")).toHaveAttribute("data-state", "held", { timeout: 30_000 });
  await expect(card.locator("#cs-off-hint")).toBeVisible();
  await card.locator("#cs-held-merge").click();
  await expect(card.locator("#cs-result")).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("#csb-card")).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
  expect((await local(card, "sk_csb_cfg"))!.link).not.toHaveProperty("held");
  const after = await openPopup(p);
  await expect(after.locator(".row")).toHaveCount(2);
});

test("no room: other data and another computer's copy fill the area; merge-and-remove frees it and this computer's copy goes in", async () => {
  test.setTimeout(240_000);
  const p = await profile();
  const pop = await openPopup(p);
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#start-secure").click()]);
  await opt.waitForLoadState();
  await finishWizard(opt, { csb: false });
  await opt.close();
  await addByPaste(p, GITHUB_URI);
  // another computer's copy of this vault (made in Node from the generation on disk), and other data beside it, so
  // that this computer's own copy does not fit
  const w = await openPopup(p);
  const backup = await makeCloudBackup(await onDisk(w), "both", "Sixkey 0.0.0");
  const theirs = await planSlot(backup, "theirs04", "aabbccddeeff0011");
  const mine = await planSlot(backup, "zzzzzzzz", "aabbccddeeff0012");
  if (theirs.kind !== "plan" || mine.kind !== "plan") throw new Error("unexpected");
  let pad = ROOM_BYTES - theirs.bytes - mine.bytes + 100;
  const pads: Record<string, string> = {};
  for (let i = 0; pad > 0; i++) {
    const v = "p".repeat(Math.min(pad, 7_000));
    pads[`pad.${i}`] = v;
    pad -= chromiumItemBytes(`pad.${i}`, v);
  }
  await deliver(w, { ...theirs.items, ...pads });
  const card = await openOptions(p, "#backup");
  await card.locator("#cs-on").click();
  await expect(card.locator("#csb-card")).toHaveAttribute("data-state", "no_room", { timeout: 30_000 });
  await expect(card.locator("#cs-save-file")).toBeVisible();
  await card.locator("#cs-merge-clean").click();
  await card.locator("#cs-secret").fill(STRONG);
  await card.locator("#cs-merge-go").click();
  await expect(card.locator("#cs-result")).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("#csb-card")).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
  const left = await whole(card);
  expect(left).not.toContain("theirs04");
  expect(left).toEqual([(await linkOf(card))!.slot]);
  expect(Object.keys(await area(card)).filter((k) => k.startsWith("pad."))).toHaveLength(Object.keys(pads).length);
});
