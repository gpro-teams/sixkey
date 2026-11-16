// M6C in the settings page's Sync section against the real API server (SYNC-DESIGN §6 O13, §3.5; M6C-NOTES §2, §3):
//   - an account erased for good comes back from the server's history through "find accounts": the versions listed, one
//     opened, the account ticked and brought back, and the next round uploads it as any edit;
//   - a profile with an account the synced vault already has joins by approval (the pairing code, then the SAS): its summary says the duplicates go to
//     the trash after the first sync, and after it the extra copy is in the trash, on both profiles, said once.
// (The repair of server_older_key needs the server's database restored to before a rotation, which this harness cannot
// do; it is checked against the in-memory server, test/unit/m6c-older-key.test.ts and test/fault/m6c-crash-repair.test.ts.)
// Every request on the wire: signed by a device, exactly application/json on bodies, no cookie, no referrer.
import { expect, test } from "@playwright/test";
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
} from "../e2e/harness";
import { trashInPopup } from "../e2e/export-helpers";
import { answerRequestUi, enterPairingCodeUi, finishJoinUi, openSync, readSasUi, startJoinUi, turnOnUi } from "./m6-ui";
import { startSyncBackend, type SyncBackend } from "./sync-e2e";

let b: SyncBackend;
test.beforeAll(async () => {
  b = await startSyncBackend();
});
test.afterAll(async () => {
  await b?.stop();
});

const inbox = (e: string) => b.server.inbox(e);
const issuersIn = async (p: Profile) => {
  const pop = await openPopup(p);
  await expect(pop.locator(".row").first()).toBeVisible();
  const names = (await pop.locator(".row .who b").allTextContents()).map((x) => x.trim()).sort();
  await pop.close();
  return names;
};
const sent = (from: number, pick: (w: (typeof b.api.wire)[number]) => boolean) =>
  b.api.wire.slice(from).filter(pick).length;
function wireIsClean() {
  for (const w of b.api.wire) {
    expect(w.cookie, w.target).toBe(false);
    expect(w.referer, w.target).toBe(false);
    expect(w.contentType, w.target).toBe(w.method === "GET" ? null : "application/json");
    const path = w.target.split("?")[0];
    if (path !== "/v1/auth/otp" && path !== "/v1/auth/verify" && path !== "/v1/account")
      expect(w.signer, w.target).not.toBeNull();
  }
}

test("an account erased for good comes back from the server's history (find accounts)", async () => {
  const email = `m6c-find-${Date.now().toString(36)}@example.com`;
  const w0 = b.api.wire.length;
  const p1 = await launch();
  try {
    const { recoveryCode } = await startFresh(p1);
    await addByPaste(p1, GITHUB_URI);
    await addByPaste(p1, AWS_URI);
    const s1 = await openSync(p1);
    await turnOnUi(s1, { password: STRONG, email, recoveryCode, name: "Profile one", inbox });

    // AWS to the trash, then erased for good there, and synced
    await trashInPopup(p1, "AWS");
    const trash = await openOptions(p1, "#trash");
    // Delete forever cannot be undone: it asks for the master password (QUICK-PIN-NOTES; quick-pin.spec.ts), sync or not
    await trash.locator("#trash-pw").fill(STRONG);
    await trash
      .locator("#trash tr", { hasText: "AWS" })
      .getByRole("button", { name: /Delete forever|永久删除/ })
      .click();
    await expect(trash.locator("#trash tr", { hasText: "AWS" })).toHaveCount(0);
    await trash.close();
    await s1.locator("#sync-act-sync_now").click();
    await expect(s1.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 30_000 });
    expect(await issuersIn(p1)).toEqual(["GitHub"]);

    // find accounts: the server's history and this device's snapshots; the version that still holds AWS
    await s1.locator("#sync-find-open").click();
    await expect(s1.locator("#sync-find-server li").first()).toBeVisible({ timeout: 30_000 });
    await expect(s1.locator("#sync-find-local li").first()).toBeVisible();
    const versions = s1.locator("#sync-find-server li button");
    const n = await versions.count();
    let found = false;
    for (let i = 0; i < n && !found; i++) {
      await versions.nth(i).click();
      await expect(s1.locator("#sync-find-form, #sync-find-none, #sync-find-unreadable").first()).toBeVisible({
        timeout: 30_000,
      });
      if (await s1.locator("#sync-find-form", { hasText: "AWS" }).count()) found = true;
      else await s1.locator("#sync-find-back").click();
    }
    expect(found).toBe(true);
    await expect(s1.locator("#sync-find-form")).not.toContainText("GitHub"); // alive now: not offered
    expect(await s1.locator("#sync-find-go").isDisabled()).toBe(true); // nothing ticked for the user
    await s1.locator("#sync-find-form label", { hasText: "AWS" }).locator("input").check();
    const puts = sent(0, (w) => w.method === "PUT" && w.target === "/v1/vault" && w.status === 200);
    await s1.locator("#sync-find-go").click();
    await expect(s1.locator("#sync-find-done")).toBeVisible({ timeout: 30_000 });
    await s1.locator("#sync-find-close").click();
    expect(await issuersIn(p1)).toEqual(["AWS", "GitHub"]);

    // an ordinary edit: the next round uploads it (the worker may have already)
    await s1.locator("#sync-act-sync_now").click();
    await expect(s1.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => sent(0, (w) => w.method === "PUT" && w.target === "/v1/vault" && w.status === 200), {
        timeout: 30_000,
      })
      .toBeGreaterThan(puts);
    expect(
      sent(w0, (w) => w.method === "GET" && w.target === "/v1/vault/versions" && w.status === 200),
    ).toBeGreaterThan(0);
    wireIsClean();
  } finally {
    await close(p1);
  }
});

test("joined by approval with an account the synced vault had: after the first round the extra copy is in the trash, said once", async () => {
  const email = `m6c-dedupe-${Date.now().toString(36)}@example.com`;
  const p1 = await launch();
  const p2 = await launch();
  try {
    const { recoveryCode } = await startFresh(p1);
    await addByPaste(p1, GITHUB_URI);
    const s1 = await openSync(p1);
    await turnOnUi(s1, { password: STRONG, email, recoveryCode, name: "Approver", inbox });

    // the new profile has a vault of its own: the same GitHub account, and AWS
    await startFresh(p2);
    await addByPaste(p2, GITHUB_URI);
    await addByPaste(p2, AWS_URI);
    const s2 = await openSync(p2, "#sync/join");
    await startJoinUi(s2, { email, inbox, name: "New laptop" });
    await s2.locator("#sync-join-approval").click();
    await expect(s2.locator("#sync-waiting")).toBeVisible();
    await enterPairingCodeUi(s2, await answerRequestUi(s1, STRONG));
    const sas = await readSasUi(s2);
    await s1.locator("#sync-approve-sas-in").fill(sas);
    await s1.locator("#sync-approve-sas-next").click();
    await expect(s1.locator("#sync-approve-done")).toBeVisible({ timeout: 30_000 });
    // the summary says what the first sync will do with the accounts the synced vault already has
    await expect(s2.locator("#sync-summary")).toContainText(/trash|回收站/);
    await finishJoinUi(s2);
    await s1.locator("#sync-approve-close").click();

    // after the first round: GitHub once, the extra copy in the trash, said once
    await expect(s2.locator("#sync-notices")).toContainText(/in the synced vault already|同步库里已经有了/, {
      timeout: 30_000,
    });
    expect(await issuersIn(p2)).toEqual(["AWS", "GitHub"]);
    const trash2 = await openOptions(p2, "#trash");
    await expect(trash2.locator("#trash tr", { hasText: "GitHub" })).toHaveCount(1);
    await trash2.close();
    // the approving profile: the new account, GitHub once, and the copy in its trash too
    await s1.locator("#sync-act-sync_now").click();
    await expect.poll(() => issuersIn(p1), { timeout: 30_000 }).toEqual(["AWS", "GitHub"]);
    const trash1 = await openOptions(p1, "#trash");
    await expect(trash1.locator("#trash tr", { hasText: "GitHub" })).toHaveCount(1);
    await trash1.close();
    wireIsClean();
  } finally {
    await close(p1);
    await close(p2);
  }
});
