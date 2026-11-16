// "Lock every time" (the shared-profile preset) against the real API server (SYNC-DESIGN §3.11, §4.7, P10, D1):
//   - an edit made in a settings page, which holds the key only while it is open, is pushed by the service worker, which
//     never has the key: the outbox computed at the commit is the request;
//   - an edit whose push failed, then the active slot torn on disk: the worker's next load falls back to the older slot,
//     its hook keeps the outbox as an orphan entry, and the worker pushes that entry (the server is still where it was
//     built on); unlocked, a round with the key brings the save back into the local vault.
import { expect, test, type Page } from "@playwright/test";
import { close, launch, openFold, openOptions, type Profile, startFresh, STRONG } from "../e2e/harness";
import { dev, openDevSync, signIn } from "../e2e/sync-helpers";
import { startSyncBackend, storagePage, syncState, type SyncBackend } from "./sync-e2e";

let b: SyncBackend;
test.beforeAll(async () => {
  b = await startSyncBackend();
});
test.afterAll(async () => {
  await b?.stop();
});

/** Adds an account in the settings page, unlocking it first (in this mode the page holds the key until it closes). */
async function addInLockedMode(p: Profile, uri: string): Promise<void> {
  const opt = await openOptions(p, "#add");
  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  await opt.locator("#paste-box").fill(uri);
  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#add-done")).toBeVisible();
  await opt.close();
}
const vaultPuts = () => b.api.wire.filter((w) => w.method === "PUT" && w.target === "/v1/vault");
const local = (page: Page, key: string) => page.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

test("the worker pushes what a closed page committed, and a save survives a torn slot as an orphan entry", async () => {
  test.setTimeout(240_000);
  const email = `always-${Date.now().toString(36)}@example.com`;
  const p = await launch();
  try {
    const { recoveryCode } = await startFresh(p, { risk: "shared" }); // "lock every time"
    const d = await openDevSync(p);
    await dev(d, "unlock", STRONG); // this page's own key, for the first upload and its first round
    await signIn(d, email, (e) => b.server.inbox(e));
    expect(await dev(d, "firstUpload", { password: STRONG, recoveryCode, deviceName: "Shared", email })).toBe("done");
    expect((await dev(d, "round")).status).toBe("ok");
    await d.close(); // the key goes with the page: nothing in this profile holds it now
    const s = await storagePage(p);
    expect(await local(s, "sk_session")).toBeUndefined();

    // 1. P10: an edit in a page that closes at once; the worker, without the key, pushes its outbox
    const before = vaultPuts().length;
    await addInLockedMode(p, "otpauth://totp/First:x?secret=JBSWY3DPEHPK3PXA&issuer=First");
    await expect.poll(() => vaultPuts().length, { timeout: 30_000 }).toBe(before + 1);
    await expect.poll(async () => (await syncState(s))?.status, { timeout: 10_000 }).toBe("locked");
    expect(await local(s, "sk_sync_outbox")).toBeNull(); // pushed: the outbox is spent and lastSynced moved on

    // 2. the next push fails (the network drops), then the active slot is torn on disk
    b.down(true);
    await addInLockedMode(p, "otpauth://totp/Second:x?secret=JBSWY3DPEHPK3PXB&issuer=Second");
    await expect.poll(async () => Number((await syncState(s))?.failures ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await local(s, "sk_sync_outbox")).toMatchObject({ v: 1, base: expect.any(Number) }); // the pushable outbox of the second save
    expect((await syncState(s))?.lastSynced).not.toBeNull();
    await s.evaluate(async () => {
      const ptr = (await chrome.storage.local.get("sk_active")).sk_active as string;
      await chrome.storage.local.set({ [`sk_slot_${ptr}`]: { torn: true } });
    });
    const putsBefore = vaultPuts().length;
    b.down(false);
    // the worker's retry: its load recovers the older slot, the hook keeps the outbox, the entry is pushed and retired
    await expect.poll(() => vaultPuts().length, { timeout: 60_000 }).toBe(putsBefore + 1);
    await expect.poll(async () => (await local(s, "sk_sync_orphan")) ?? null, { timeout: 10_000 }).toBeNull();
    // it went through the recovery hook (lastSynced cleared with the outbox moved to the list) and the orphan's push,
    // which never brings lastSynced back (§4.7 D2): the next round with the key is a full pull and merge
    expect((await syncState(s))?.lastSynced).toBeNull();
    expect(await local(s, "sk_sync_outbox")).toBeNull();

    // 3. unlocked, a round with the key brings the save back into the local vault (the older slot did not have it)
    const d2 = await openDevSync(p);
    await dev(d2, "unlock", STRONG);
    expect((await dev(d2, "round")).status).toBe("ok");
    const opt = await openOptions(p, "#backup");
    await opt.locator("#unlock-pw").fill(STRONG);
    await opt.locator("#unlock-btn").click();
    await openFold(opt, "subset"); // the accounts are listed where a selection is picked
    await expect(opt.getByText("Second", { exact: true }).first()).toBeVisible();
    await expect(opt.getByText("First", { exact: true }).first()).toBeVisible();
    await opt.close();
    await d2.close();
    await s.close();
  } finally {
    b.down(false);
    await close(p);
  }
});
