// The backup in Chrome's sync storage's worker in the real extension (CSB-3; src/platform/csb-worker.ts), in
// Playwright's Chromium, signed in to no Google account: chrome.storage.sync works there and stays on this computer
// (test/e2e/csb-probe.spec.ts), so nothing here reaches the network. It is turned on the one way every build has, the
// settings page's sk-csb-on (the popup's is not taken); then a change of the vault is written after the debounce (5 s in
// the e2e build, 30 s in the store's) and not before (the area's first change is timed in the page); a locked vault is written all the same and stays locked; another
// computer's slot is never touched, and one that leaves no room stops this one as no_room; a slot that shrinks loses its
// chunks past the new count; and turning it off removes this device's slot alone. Slots are read back in Node with
// core/cloud/slots.ts; another computer's are made in Node with the same code and put into the area by the page, as
// Chrome sync would deliver them.
import { expect, test, type Page } from "@playwright/test";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { assembleSlot, planSlot, readSlots, ROOM_BYTES, type Assembled } from "../../src/core/cloud/slots";
import { account, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import {
  addByPaste,
  AWS_URI,
  close,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  startFresh,
  STRONG,
  type Profile,
} from "./harness";

const area = (opt: Page) => opt.evaluate(() => chrome.storage.sync.get(null));
const local = (opt: Page, key: string) =>
  opt.evaluate(async (k) => (await chrome.storage.local.get(k))[k] as Record<string, unknown> | undefined, key);
const ask = (page: Page, type: string) =>
  page.evaluate((t) => chrome.runtime.sendMessage({ type: t }).catch((e: unknown) => `no answer: ${String(e)}`), type);
/** This device's slot, as its link names it, assembled from the area as it is now (null: no link yet). */
async function own(opt: Page): Promise<{ slot: string; read: Assembled } | null> {
  const cfg = (await local(opt, "sk_csb_cfg")) as { link: { slot: string } | null } | undefined;
  if (!cfg?.link) return null;
  return { slot: cfg.link.slot, read: await assembleSlot(await area(opt), cfg.link.slot) };
}
const seqOf = async (opt: Page) => {
  const o = await own(opt);
  return o?.read.kind === "ok" ? o.read.backup.generation.seq : 0;
};

/** Another computer's slot: its own vault of `n` accounts, at `slot`, as the area would hold it. */
async function otherSlot(slot: string, n: number): Promise<{ items: Record<string, unknown>; bytes: number }> {
  const keys = await protectedKeys("other-computer-pass-7");
  const accounts = Array.from({ length: n }, (_, i) => account(`Elsewhere ${i}`, "JBSWY3DPEHPK3PXP"));
  const gen = await seal(keys, vaultOf(keys.keyring.vaultId, accounts), 9);
  const plan = await planSlot(await makeCloudBackup(gen, "both", "Sixkey 0.1.0"), slot, "fedcba9876543210");
  if (plan.kind !== "plan") throw new Error(`${n} accounts do not fit a slot`);
  return { items: plan.items, bytes: plan.bytes };
}

/** A new profile with an empty vault, the backup turned on from the settings page (the one way). */
async function turnedOn(): Promise<{ p: Profile; opt: Page }> {
  const p = await launch();
  await startFresh(p);
  // the popup's message is not taken: no listener answers it (Chrome resolves with nothing), nothing is turned on
  const pop = await openPopup(p);
  expect(await ask(pop, "sk-csb-on")).toBeUndefined();
  await pop.close();
  const opt = await openOptions(p);
  expect(await local(opt, "sk_csb_cfg")).toMatchObject({ on: false, declined: true, link: null }); // first run's box cleared
  expect(await ask(opt, "sk-csb-on")).toEqual({ ok: true });
  expect(await local(opt, "sk_csb_cfg")).toMatchObject({ on: true });
  return { p, opt };
}

test("turned on from the settings page alone; a change is written after the debounce, not before; a locked vault too", async () => {
  test.setTimeout(90_000);
  const { p, opt } = await turnedOn();
  // the time of the area's first change, as the page sees it (none yet: the area is empty, and this computer alone
  // writes it)
  await opt.evaluate(() => {
    const w = window as unknown as { firstSync: number | null };
    w.firstSync = null;
    chrome.storage.sync.onChanged.addListener(() => void (w.firstSync ??= Date.now()));
  });
  const firstSync = () => opt.evaluate(() => (window as unknown as { firstSync: number | null }).firstSync);
  // the vault is empty: the run that turning on asked for ends, and nothing is written (rule 1)
  await expect
    .poll(async () => ((await local(opt, "sk_csb_state")) as { lastRun: number | null } | undefined)?.lastRun ?? null, {
      timeout: 20_000,
    })
    .not.toBeNull();
  expect(Object.keys(await area(opt))).toEqual([]);
  await addByPaste(p, GITHUB_URI);
  const st = (await local(opt, "sk_csb_state")) as { pendingSince: number | null };
  expect(st.pendingSince).not.toBeNull();
  const alarm = await opt.evaluate(() => chrome.alarms.get("sk-csb-soon"));
  expect(alarm).toBeTruthy();
  expect(alarm!.scheduledTime - st.pendingSince!).toBeGreaterThanOrEqual(5_000);
  expect(alarm!.scheduledTime - st.pendingSince!).toBeLessThan(6_000);
  await expect.poll(() => seqOf(opt), { timeout: 20_000 }).toBeGreaterThan(0);
  // nothing before the debounce, however fast or slow the machine: the area first changed at the alarm's time or after
  expect(await firstSync()).toBeGreaterThanOrEqual(alarm!.scheduledTime);
  const first = await seqOf(opt);
  const after = (await local(opt, "sk_csb_state")) as { lastOk: number; err: unknown; pendingSince: unknown };
  expect(after).toMatchObject({ err: null, pendingSince: null });
  expect(after.lastOk).toBeGreaterThanOrEqual(alarm!.scheduledTime);
  const reminder = (await local(opt, "sk_last_backup")) as unknown as number; // the backup reminder counts it (C4)
  expect(reminder).toBeGreaterThanOrEqual(alarm!.scheduledTime);
  expect(reminder).toBeLessThanOrEqual(after.lastOk);
  const o = (await own(opt))!;
  expect(o.read.kind === "ok" && o.read.backup.generation.envelope.vaultId).toBeTruthy();

  // locked: the worker needs no key, and the vault stays locked
  await addByPaste(p, AWS_URI);
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(pop.locator("#secret")).toBeVisible();
  await pop.close();
  await expect.poll(() => seqOf(opt), { timeout: 20_000 }).toBeGreaterThan(first);
  const again = await openPopup(p);
  await expect(again.locator("#secret")).toBeVisible();
  await again.close();
  expect(((await local(opt, "sk_csb_state")) as { err: unknown }).err).toBeNull();
  await close(p);
});

test("another computer's slot is never touched; turning off removes this device's slot alone", async () => {
  test.setTimeout(90_000);
  const { p, opt } = await turnedOn();
  const theirs = await otherSlot("elsewhr1", 3);
  await opt.evaluate((items) => chrome.storage.sync.set(items), theirs.items);
  await addByPaste(p, GITHUB_URI);
  await expect.poll(() => seqOf(opt), { timeout: 20_000 }).toBeGreaterThan(0);
  await addByPaste(p, AWS_URI);
  const first = await seqOf(opt);
  await expect.poll(() => seqOf(opt), { timeout: 20_000 }).toBeGreaterThan(first);
  const now = await area(opt);
  for (const [k, v] of Object.entries(theirs.items)) expect(now[k], k).toEqual(v);
  const s = (await local(opt, "sk_csb_state")) as { others: { n: number; otherVaults: number }; seen: boolean };
  expect(s.others).toMatchObject({ n: 1, otherVaults: 1 });
  expect(s.seen).toBe(true);
  // off: this device's slot goes, theirs stays
  const mine = (await own(opt))!.slot;
  expect(await ask(opt, "sk-csb-off")).toEqual({ ok: true, removed: true });
  const left = await area(opt);
  expect(Object.keys(left).sort()).toEqual(Object.keys(theirs.items).sort());
  expect((await readSlots(left)).slots.map((x) => x.slot)).toEqual(["elsewhr1"]);
  expect(await local(opt, "sk_csb_cfg")).toMatchObject({ on: false, declined: true, link: { slot: mine } });
  await close(p);
});

test("another computer's slot that leaves no room: this one stops as no_room, nothing written, theirs untouched", async () => {
  test.setTimeout(120_000);
  // the largest slot under the area's room with this device's ~2 KB beside it, found in Node
  let n = 200;
  let theirs = await otherSlot("elsewhr2", n);
  while (theirs.bytes < ROOM_BYTES - 1_400) theirs = await otherSlot("elsewhr2", ++n);
  expect(theirs.bytes).toBeLessThanOrEqual(ROOM_BYTES);
  const { p, opt } = await turnedOn();
  await opt.evaluate((items) => chrome.storage.sync.set(items), theirs.items);
  await addByPaste(p, GITHUB_URI);
  await expect
    .poll(async () => ((await local(opt, "sk_csb_state")) as { err: unknown } | undefined)?.err, { timeout: 20_000 })
    .toBe("no_room");
  expect(await own(opt)).toBeNull(); // no slot of its own, no link
  const now = await area(opt);
  expect(Object.keys(now).sort()).toEqual(Object.keys(theirs.items).sort());
  for (const [k, v] of Object.entries(theirs.items)) expect(now[k], k).toEqual(v);
  expect(await opt.evaluate(() => chrome.alarms.get("sk-csb-retry"))).toBeFalsy(); // waits for the user
  await close(p);
});

test("a slot that shrinks: one set, then its chunks past the new count are removed", async () => {
  test.setTimeout(150_000);
  const { p, opt } = await turnedOn();
  // ten accounts with long names and keys (about 1.1 KB each in the copy): two chunks
  const long = (i: number) => {
    const issuer = `${"Issuer".repeat(30)}${i}`;
    const label = `${"label".repeat(36)}${i}@example.com`;
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${"JBSWY3DPEHPK3PXP".repeat(12)}&issuer=${encodeURIComponent(issuer)}`;
  };
  await addByPaste(p, Array.from({ length: 10 }, (_, i) => long(i)).join("\n"));
  await expect.poll(() => seqOf(opt), { timeout: 20_000 }).toBeGreaterThan(0);
  const o = (await own(opt))!;
  const n = o.read.kind === "ok" ? o.read.manifest.n : 0;
  expect(n).toBeGreaterThanOrEqual(2);
  // nine of them erased for good: their names and keys leave the vault, their tombstones stay (about 0.4 KB each)
  const pop = await openPopup(p);
  const quick = { timeout: 10_000 };
  for (let i = 0; i < 9; i++) {
    await pop.locator(".row .more").first().click(quick);
    await pop.getByRole("button", { name: /^(Delete|删除)$/ }).click(quick);
    await pop.getByRole("button", { name: /Click again|再点一次/ }).click(quick);
    await expect(pop.locator(".row")).toHaveCount(9 - i);
  }
  await pop.close();
  const trash = await openOptions(p, "#trash");
  for (let i = 0; i < 9; i++) {
    await trash.locator("#trash-pw").fill(STRONG, quick); // the master password, for each erase
    await trash
      .locator("#trash tr")
      .first()
      .getByRole("button", { name: /^(Delete forever|永久删除)$/ })
      .click(quick);
    await expect(trash.locator("#trash tr")).toHaveCount(8 - i);
  }
  await trash.close();
  await expect
    .poll(
      async () => {
        const x = await own(opt);
        return x?.read.kind === "ok" ? x.read.manifest.n : -1;
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(n);
  const now = await own(opt);
  const m = now!.read.kind === "ok" ? now!.read.manifest.n : 0;
  const keys = Object.keys(await area(opt)).sort();
  expect(keys).toEqual([`bk1.${o.slot}`, ...Array.from({ length: m }, (_, i) => `bk1.${o.slot}.${i}`)].sort()); // nothing past the new count is left
  expect(((await local(opt, "sk_csb_state")) as { err: unknown }).err).toBeNull();
  await close(p);
});
