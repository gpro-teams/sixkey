// The settings page's Sync section against the real API server (SYNC-DESIGN §6, §8.6; M6): real profiles, every step
// through the section's own screens.
//   - Profile one turns sync on (§3.1, the first upload); a new profile joins with the recovery code (§3.3) from the
//     first-run wizard's "join instead"; an edit reaches it; it turns sync off (§3.10): revoked on the server, its
//     accounts kept, the section back to the explanation card. Before that, profile one makes a new recovery code
//     (§3.8) and changes the master password (§3.7): on profile two's lock screen the new one fails and the screen says
//     why (§6 P2), its old password still opens it, and its section takes the new one (§3.9).
//   - A new profile joins with the recovery code, for a user without the master password, and sets a new one with the
//     code (§3.3 step 5): a new code shown first, the new password opens it, the first profile hears of it.
//   - A new profile joins by approval (§3.2, enrolment v2): the approving section shows the pairing code, typed into the
//     new profile's (a typo first: said there, nothing sent); the new profile then shows the six-digit check, the
//     approving section types it (one wrong try first). The approving section then lists both devices by name, revokes
//     the new one as retired (§3.6, O8, O10) and deletes the sync account (§3.12).
//   - The API permission withdrawn (§4.9): the settings page's chrome.permissions is a stand-in (the e2e build declares
//     the permission as required, and automated tests cannot answer Chrome's real prompt: a manual check,
//     OWNER-DECISIONS/12); the page's own engine then sends nothing, the card says sync is paused, and "Allow again"
//     asks (in the click) and resumes.
// Every request on the wire: signed by a device, exactly application/json on bodies, no cookie, no referrer.
import { expect, test, type Page } from "@playwright/test";
import {
  addByPaste,
  AWS_URI,
  close,
  GITHUB_URI,
  launch,
  openFold,
  openPopup,
  type Profile,
  showSection,
  startFresh,
  STRONG,
} from "../e2e/harness";
import {
  answerRequestUi,
  enterPairingCodeUi,
  finishJoinUi,
  readSasUi,
  typoOf,
  newCodeUi,
  openSync,
  signInUi,
  startJoinUi,
  turnOffUi,
  turnOnUi,
} from "./m6-ui";
import { startSyncBackend, type SyncBackend } from "./sync-e2e";

let b: SyncBackend;
test.beforeAll(async () => {
  b = await startSyncBackend();
});
test.afterAll(async () => {
  await b?.stop();
});

const inbox = (e: string) => b.server.inbox(e);
const NEWER = "Z4n!Wq8#hK3$sY6@cD9e"; // a second strong master password
const issuersIn = async (p: Profile) => {
  const pop = await openPopup(p);
  await expect(pop.locator(".row").first()).toBeVisible();
  const names = (await pop.locator(".row .who b").allTextContents()).map((x) => x.trim()).sort();
  await pop.close();
  return names;
};
/** The requests since `from` (the backend serves every test of this file; its log is the whole file's). */
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

test("turned on in one profile, joined with the recovery code from a new one; a new code and password made in the first; turned off in the second", async () => {
  const email = `m6-code-${Date.now().toString(36)}@example.com`;
  const w0 = b.api.wire.length;
  const p1 = await launch();
  const p2 = await launch();
  try {
    const { recoveryCode } = await startFresh(p1);
    await addByPaste(p1, GITHUB_URI);
    const s1 = await openSync(p1);
    await expect(s1.locator("#rail-sync")).toHaveText(/Off/);
    await turnOnUi(s1, { password: STRONG, email, recoveryCode, name: "Profile one", inbox });
    await expect(s1.locator("#rail-sync")).toHaveText(/On/);
    // with sync on, the Security section's key changes point to Sync (Phase 0's are refused then)
    await showSection(s1, "security-keys");
    await expect(s1.locator("#sec-keys-in-sync")).toBeVisible();
    await expect(s1.locator("#new-code")).toHaveCount(0);
    expect(sent(w0, (w) => w.method === "POST" && w.target === "/v1/vault/init" && w.status === 201)).toBe(1);

    // a new profile: the wizard offers the join instead
    const pop = await openPopup(p2);
    const [opt] = await Promise.all([p2.ctx.waitForEvent("page"), pop.locator("#start-secure").click()]);
    await opt.waitForLoadState();
    await opt.locator("#fr-to-join").click();
    await expect(opt.locator("#sync-off-card")).toBeVisible();
    await startJoinUi(opt, { email, inbox, name: "Profile two" });
    await expect(opt.locator("#sync-join-since")).toContainText("1 device");
    await opt.locator("#sync-join-recovery").click();
    await opt.locator("#sync-join-rc").fill(recoveryCode.toLowerCase().replace(/-/g, " ")); // typed loosely
    await opt.locator("#sync-join-code-next").click();
    await expect(opt.locator("#sync-summary-what")).toBeVisible();
    await finishJoinUi(opt);
    expect(await issuersIn(p2)).toEqual(["GitHub"]);

    // an edit in profile one reaches profile two (its page runs a round on Sync now)
    const puts = () =>
      b.api.wire.filter((w) => w.method === "PUT" && w.target === "/v1/vault" && w.status === 200).length;
    const before = puts();
    await addByPaste(p1, AWS_URI);
    await expect.poll(puts, { timeout: 30_000 }).toBeGreaterThan(before);
    await opt.locator("#sync-act-sync_now").click();
    await expect.poll(() => issuersIn(p2), { timeout: 30_000 }).toEqual(["AWS", "GitHub"]);

    // a new recovery code made in profile one (shown first, two groups typed back); profile two keeps syncing
    await showSection(s1, "sync"); // the page is on Security since the check above
    await s1.locator("#sync-keyop-recovery").click();
    await s1.locator("#sync-keyop-pw").fill(STRONG);
    await s1.locator("#sync-keyop-next").click();
    expect(await newCodeUi(s1, "sync-keyop")).not.toBe(recoveryCode);
    await expect(s1.locator("#sync-keyop-done")).toBeVisible({ timeout: 30_000 });
    await s1.locator("#sync-keyop-close").click();
    await opt.locator("#sync-act-sync_now").click();
    await expect(opt.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 30_000 });

    // the master password changed in profile one: on profile two's lock screen the new one fails and the screen says
    // why (§6 P2), its old password still opens it, and its section takes the new one
    await s1.locator("#sync-keyop-password").click();
    await s1.locator("#sync-keyop-pw").fill(STRONG);
    await s1.locator("#sync-keyop-new-pw").fill(NEWER);
    await s1.locator("#sync-keyop-new-pw2").fill(NEWER);
    await s1.locator("#sync-keyop-next").click();
    await expect(s1.locator("#sync-keyop-done")).toBeVisible({ timeout: 30_000 });
    await opt.locator("#sync-act-sync_now").click();
    await expect(opt.locator("#sync-card[data-state=needs_new_password]")).toBeVisible({ timeout: 30_000 });
    const pop2 = await openPopup(p2);
    await pop2.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
    await expect(pop2.locator("#secret")).toBeVisible();
    await expect(pop2.locator("#lock-keys-elsewhere")).toHaveCount(0); // looked up only once an attempt fails
    await pop2.locator("#secret").fill(NEWER); // the new password does not open this device's keys yet
    await pop2.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect(pop2.locator("#lock-keys-elsewhere")).toContainText("changed on another device");
    await pop2.locator("#secret").fill(STRONG);
    await pop2.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect(pop2.locator(".row").first()).toBeVisible();
    await pop2.close();
    await opt.locator("#sync-act-adopt").click();
    await opt.locator("#sync-adopt-pw").fill(NEWER);
    await opt.locator("#sync-adopt-go").click();
    await expect(opt.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 30_000 });

    // turned off in profile two: revoked, the accounts stay, the explanation card again
    await turnOffUi(opt, NEWER);
    await expect(opt.locator("#sync-done-msg")).toBeVisible();
    await showSection(opt, "security-keys");
    await expect(opt.locator("#sec-keys-in-sync")).toHaveCount(0); // sync off: Phase 0's key changes again
    await openFold(opt, "fold-code");
    await expect(opt.locator("#new-code")).toBeVisible();
    expect(await issuersIn(p2)).toEqual(["AWS", "GitHub"]);
    expect(
      sent(w0, (w) => w.method === "POST" && /\/v1\/devices\/[^/]+\/revoke$/.test(w.target) && w.status === 200),
    ).toBe(1);
    const st = await opt.evaluate(async () =>
      Object.keys(await chrome.storage.local.get(["sk_sync_cfg", "sk_sync_state"])),
    );
    expect(st).toEqual([]);
    wireIsClean();
  } finally {
    await close(p1);
    await close(p2);
  }
});

test("joined by approval: the pairing code there typed here, the six digits here typed there; listed, revoked, the account deleted", async () => {
  const email = `m6-sas-${Date.now().toString(36)}@example.com`;
  const w0 = b.api.wire.length;
  const p1 = await launch();
  const p2 = await launch();
  try {
    const { recoveryCode } = await startFresh(p1);
    await addByPaste(p1, GITHUB_URI);
    const s1 = await openSync(p1);
    await turnOnUi(s1, { password: STRONG, email, recoveryCode, name: "Approver", inbox });

    const s2 = await openSync(p2, "#sync/join");
    await startJoinUi(s2, { email, inbox, name: "New laptop" });
    await s2.locator("#sync-join-approval").click();
    await expect(s2.locator("#sync-waiting")).toBeVisible();

    // the approving section: the master password, the request; then its pairing code, typed into the new profile
    const code = await answerRequestUi(s1, STRONG);
    const typo = await typoOf(code);
    const reveals = () => sent(w0, (w) => w.method === "POST" && w.target.endsWith("/reveal"));
    await enterPairingCodeUi(s2, typo, "type");
    await expect(s2.locator("#sync-pair-err")).toBeVisible(); // the check bits caught it, here
    expect(reveals()).toBe(0); // nothing was sent for it
    await enterPairingCodeUi(s2, code, "paste");
    const sas = await readSasUi(s2);
    await expect(s2.locator("#sync-sas-spoken")).toHaveText(sas.split("").join(" "));
    await expect(s1.locator("#sync-approve-claims")).toContainText("New laptop");
    await expect(s1.locator("#sync-approve-code")).toHaveCount(0); // the code left the approving screen at the reveal
    await s1.locator("#sync-approve-sas-in").fill(sas === "000000" ? "111111" : "000000");
    await s1.locator("#sync-approve-sas-next").click();
    await expect(s1.locator("#sync-approve-sas-err")).toContainText("2");
    await s1.locator("#sync-approve-sas-in").fill(sas);
    await s1.locator("#sync-approve-sas-next").click();
    await expect(s1.locator("#sync-approve-done")).toBeVisible({ timeout: 30_000 });
    await finishJoinUi(s2);
    expect(await issuersIn(p2)).toEqual(["GitHub"]);
    await s1.locator("#sync-approve-close").click();

    // both devices listed by name, this one marked; the new one revoked as retired
    await expect(s1.locator("#sync-devices li")).toHaveCount(2, { timeout: 30_000 });
    await expect(s1.locator("#sync-devices")).toContainText("Approver");
    const row = s1.locator("#sync-devices li", { hasText: "New laptop" });
    await row.locator("button[id^=sync-revoke-]").click();
    await s1.locator("#sync-revoke-pw").fill(STRONG);
    await s1.locator("#sync-revoke-pw-next").click();
    await expect(s1.locator("#sync-revoke-reason")).toBeVisible({ timeout: 30_000 });
    expect(await s1.locator("#sync-revoke-go").isDisabled()).toBe(true); // no reason chosen for the user
    await s1.locator("#sync-revoke-retired").check();
    await s1.locator("#sync-revoke-go").click();
    await expect(s1.locator("#sync-revoke-done")).toBeVisible({ timeout: 30_000 });
    expect(
      sent(w0, (w) => w.method === "POST" && /\/v1\/devices\/[^/]+\/revoke$/.test(w.target) && w.status === 200),
    ).toBe(1);
    await s1.locator("#sync-revoke-close").click();
    await expect(row).toHaveClass(/revoked/, { timeout: 30_000 });

    // the sync account deleted (§3.12): confirmed in the page, a fresh sign-in, the master password; sync is off here
    await s1.locator("#sync-advanced summary").click();
    await s1.locator("#sync-delete-open").click();
    await s1.locator("#sync-delete-next").click();
    await signInUi(s1, email, inbox);
    await s1.locator("#sync-delete-pw").fill(STRONG);
    await s1.locator("#sync-delete-go").click();
    await expect(s1.locator("#sync-delete-done")).toBeVisible({ timeout: 30_000 });
    expect(sent(w0, (w) => w.method === "DELETE" && w.target === "/v1/account" && w.status === 204)).toBe(1);
    await s1.locator("#sync-delete-close").click();
    await expect(s1.locator("#sync-off-card")).toBeVisible({ timeout: 30_000 });
    expect(
      await s1.evaluate(async () => Object.keys(await chrome.storage.local.get(["sk_sync_cfg", "sk_sync_state"]))),
    ).toEqual([]);
    expect(await issuersIn(p1)).toEqual(["GitHub"]);
    wireIsClean();
  } finally {
    await close(p1);
    await close(p2);
  }
});

test("joined with the recovery code by a user without the master password: a new one set with the code (§3.3 step 5)", async () => {
  const email = `m6-reset-${Date.now().toString(36)}@example.com`;
  const w0 = b.api.wire.length;
  const p1 = await launch();
  const p2 = await launch();
  try {
    const { recoveryCode } = await startFresh(p1);
    await addByPaste(p1, GITHUB_URI);
    const s1 = await openSync(p1);
    await turnOnUi(s1, { password: STRONG, email, recoveryCode, name: "Profile one", inbox });

    const s2 = await openSync(p2, "#sync/join");
    await startJoinUi(s2, { email, inbox, name: "Profile two" });
    await s2.locator("#sync-join-recovery").click();
    await s2.locator("#sync-join-rc").fill(recoveryCode);
    await s2.locator("#sync-join-code-next").click();
    await finishJoinUi(s2, { followUps: "stay" });
    await s2.locator("#sync-follow-new-password").click();
    await s2.locator("#sync-keyop-rc").fill(recoveryCode);
    await s2.locator("#sync-keyop-new-pw").fill(NEWER);
    await s2.locator("#sync-keyop-new-pw2").fill(NEWER);
    await s2.locator("#sync-keyop-next").click();
    const code2 = await newCodeUi(s2, "sync-keyop"); // the code that was typed is replaced too
    expect(code2).not.toBe(recoveryCode);
    await expect(s2.locator("#sync-keyop-done")).toBeVisible({ timeout: 30_000 });
    expect(sent(w0, (w) => w.method === "PUT" && w.target === "/v1/keys" && w.status === 200)).toBe(1); // the password and the code in one write
    await s2.locator("#sync-keyop-close").click(); // the page shows its usual sections again
    await expect(s2.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 30_000 });
    await expect(s2.locator("#rail-sync")).toHaveText(/On/);

    // the new password opens profile two; profile one hears of it
    const pop2 = await openPopup(p2);
    await pop2.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
    await pop2.locator("#secret").fill(NEWER);
    await pop2.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect(pop2.locator(".row").first()).toBeVisible();
    await pop2.close();
    await s1.locator("#sync-act-sync_now").click();
    await expect(s1.locator("#sync-card[data-state=needs_new_password]")).toBeVisible({ timeout: 30_000 });
    wireIsClean();
  } finally {
    await close(p1);
    await close(p2);
  }
});

/** The settings page with a stand-in chrome.permissions (granted or not), installed before its scripts run. */
async function withPermissionStandIn(p: Profile, granted: boolean, hash = "#sync"): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.addInitScript((start) => {
    let has = start;
    const real = chrome.permissions;
    const log: string[] = [];
    const fake = {
      contains: async () => has,
      request: async () => {
        log.push("request");
        has = true;
        return true;
      },
      remove: async () => {
        log.push("remove");
        has = false;
        return true;
      },
      getAll: () => real.getAll(),
      onAdded: real.onAdded,
      onRemoved: real.onRemoved,
    };
    Object.defineProperty(chrome, "permissions", { value: fake, configurable: true });
    Object.defineProperty(globalThis, "__permLog", { value: log });
  }, granted);
  await page.goto(`chrome-extension://${p.id}/options/index.html${hash}`);
  return page;
}

test("the API permission withdrawn: the card says paused; allowed again in the click, it resumes; turning off removes it last", async () => {
  const email = `m6-perm-${Date.now().toString(36)}@example.com`;
  const p1 = await launch();
  try {
    const { recoveryCode } = await startFresh(p1);
    await addByPaste(p1, GITHUB_URI);
    const s1 = await openSync(p1);
    await turnOnUi(s1, { password: STRONG, email, recoveryCode, inbox });
    await s1.close();

    const page = await withPermissionStandIn(p1, false);
    await expect(page.locator("#sync-card[data-state=permission_removed]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#sync-card")).toContainText("127.0.0.1:8787");
    await expect(page.locator("#rail-sync")).toHaveText(/Paused/);
    expect(await page.locator("#sync-act-sync_now").count()).toBe(0); // the only action is Allow again
    // (that the page's engine sends nothing without the permission is m5-api-permission's and m6-panel's: the worker,
    // which holds the e2e build's required permission, may send its own rounds meanwhile, signed the same way)
    await page.locator("#sync-act-grant").click();
    await expect(page.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => (globalThis as unknown as { __permLog: string[] }).__permLog)).toEqual([
      "request",
    ]);

    // turning off from here removes it last
    await turnOffUi(page, STRONG);
    expect(await page.evaluate(() => (globalThis as unknown as { __permLog: string[] }).__permLog)).toEqual([
      "request",
      "request",
      "remove",
    ]);
  } finally {
    await close(p1);
  }
});

test("a join refused at the code keeps the flow and the sign-in; cancelled, the permission is given back", async () => {
  const email = `m6-cancel-${Date.now().toString(36)}@example.com`;
  const p1 = await launch();
  const p2 = await launch();
  try {
    const { recoveryCode } = await startFresh(p1);
    const s1 = await openSync(p1);
    await turnOnUi(s1, { password: STRONG, email, recoveryCode, inbox });
    const page = await withPermissionStandIn(p2, false, "#sync/join");
    await expect(page.locator("#sync-off-card")).toBeVisible();
    await page.locator("#sync-join-start").click();
    await signInUi(page, email, inbox);
    await page.locator("#sync-join-recovery").click();
    await page.locator("#sync-join-rc").fill("0000 0000 0000 0000 0000 0000 0000");
    await page.locator("#sync-join-code-next").click();
    await expect(page.locator("#sync-join-rc-err")).toBeVisible();
    await page.locator("#sync-join-cancel").click();
    await expect(page.locator("#sync-off-card")).toBeVisible();
    expect(await page.evaluate(() => (globalThis as unknown as { __permLog: string[] }).__permLog)).toEqual([
      "request",
      "remove",
    ]);
  } finally {
    await close(p1);
    await close(p2);
  }
});
