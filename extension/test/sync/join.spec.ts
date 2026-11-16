// Two Chrome profiles and the real API server (SYNC-DESIGN §8.6): one turns sync on (§3.1), the other, which already
// has an account of its own, joins with the recovery code (§3.3, the added mode), and edits made in each profile's
// settings page reach the other through the service workers. Every request on the wire is checked: exactly
// application/json on bodies, no cookie, no referrer, signed by a device of the account.
// And the approval join of enrolment v2 (§3.2, revision 27), through both settings pages: the pairing code read off
// profile one and put into profile two (a typo the check bits catch first, then pasted), the six digits back; before
// that, a code that passes its check bits but is not profile one's ends the request on both sides.
import { expect, test } from "@playwright/test";
import {
  addByPaste,
  AWS_URI,
  close,
  GITHUB_URI,
  launch,
  openPopup,
  startFresh,
  STRONG,
  type Profile,
} from "../e2e/harness";
import { dev, openDevSync, signIn } from "../e2e/sync-helpers";
import {
  answerRequestUi,
  enterPairingCodeUi,
  finishJoinUi,
  openSync,
  otherValidCode,
  readSasUi,
  signInUi,
  startJoinUi,
  turnOnUi,
  typoOf,
} from "./m6-ui";
import { startSyncBackend, syncState, type SyncBackend } from "./sync-e2e";

let b: SyncBackend;
test.beforeAll(async () => {
  b = await startSyncBackend();
});
test.afterAll(async () => {
  await b?.stop();
});

const STRIPE = "otpauth://totp/Stripe:ops?secret=JBSWY3DPEHPK3PXQ&issuer=Stripe";
const issuersIn = async (p: Profile) => {
  const pop = await openPopup(p);
  await expect(pop.locator(".row").first()).toBeVisible();
  const names = (await pop.locator(".row .who b").allTextContents()).map((x) => x.trim()).sort();
  await pop.close();
  return names;
};

test("a second profile joins with the recovery code, and edits in each reach the other", async () => {
  const email = `join-${Date.now().toString(36)}@example.com`;
  const p1 = await launch();
  const p2 = await launch();
  try {
    // P1: a vault with GitHub, then sync on
    const { recoveryCode } = await startFresh(p1);
    await addByPaste(p1, GITHUB_URI);
    const d1 = await openDevSync(p1);
    await signIn(d1, email, (e) => b.server.inbox(e));
    expect(await dev(d1, "firstUpload", { password: STRONG, recoveryCode, deviceName: "Profile one", email })).toBe(
      "done",
    );
    expect((await dev(d1, "round")).status).toBe("ok");

    // P2: its own vault with AWS, then joins P1's (its AWS is added to the synced vault)
    await startFresh(p2);
    await addByPaste(p2, AWS_URI);
    const d2 = await openDevSync(p2);
    await signIn(d2, email, (e) => b.server.inbox(e));
    expect(await dev(d2, "joinWithRecoveryCode", { recoveryCode, deviceName: "Profile two", email })).toBe("enrolled");
    expect((await dev(d2, "round")).status).toBe("ok");
    expect((await dev(d1, "round")).status).toBe("ok");
    expect(await issuersIn(p1)).toEqual(["AWS", "GitHub"]);
    expect(await issuersIn(p2)).toEqual(["AWS", "GitHub"]);

    // an edit in P1's settings page: the page asks its worker for a round, which uploads it (no page runs the engine)
    const puts = () =>
      b.api.wire.filter((w) => w.method === "PUT" && w.target === "/v1/vault" && w.status === 200).length;
    const before = puts();
    await addByPaste(p1, STRIPE);
    await expect.poll(puts, { timeout: 30_000 }).toBeGreaterThan(before);
    // P2 has it after a round: its own worker's (a commit there asked for one, and it may already have pulled), or this one
    expect((await dev(d2, "round")).status).toBe("ok");
    expect(await issuersIn(p2)).toEqual(["AWS", "GitHub", "Stripe"]);
    const s2 = await syncState(d2);
    expect([s2?.status, s2?.failures ?? 0]).toEqual(["ok", 0]);

    // the wire: two devices, every request as it should be
    const devices = new Set(b.api.wire.map((w) => w.device).filter((x) => x !== null));
    expect(devices.size).toBe(2);
    for (const w of b.api.wire) {
      expect(w.cookie, w.target).toBe(false);
      expect(w.referer, w.target).toBe(false);
      expect(w.contentType, w.target).toBe(w.method === "GET" ? null : "application/json");
      const path = w.target.split("?")[0];
      if (path !== "/v1/auth/otp" && path !== "/v1/auth/verify" && path !== "/v1/account")
        expect(w.signer, w.target).not.toBeNull();
    }
    await d1.close();
    await d2.close();
  } finally {
    await close(p1);
    await close(p2);
  }
});

test("a second profile joins by approval: the code from profile one typed into two, the six digits back; a wrong code ends both sides first", async () => {
  const email = `join-pair-${Date.now().toString(36)}@example.com`;
  const inbox = (e: string) => b.server.inbox(e);
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
    await s2.locator("#sync-join-approval").click();
    await expect(s2.locator("#sync-waiting")).toBeVisible();

    // 1. a code that passes its check bits but is not profile one's (a typo past them): profile one cannot open the
    //    name (pairing_mismatch) and rejects; profile two only sees the request end
    await answerRequestUi(s1, STRONG);
    // the scam warning beside the code on both screens (§6 O9, §7)
    await expect(s1.locator("#sync-approve-pair .callout")).toContainText(/scam|诈骗/);
    await expect(s2.locator("#sync-pair .callout")).toContainText(/scam|诈骗/, { timeout: 30_000 });
    await enterPairingCodeUi(s2, await otherValidCode(), "paste");
    await readSasUi(s2); // revealed: this side cannot know the code was wrong
    await expect(s1.locator("#sync-approve-mismatch")).toBeVisible({ timeout: 30_000 });
    await expect(s1.locator("#sync-approve-code")).toHaveCount(0);
    await expect(s2.locator("#sync-join-failed")).toContainText(/pairing code was mistyped|配对码输错/, {
      timeout: 30_000,
    });
    await s1.locator("#sync-approve-mismatch-close").click();

    // 2. again, from the start (a new sign-in: one request per session): a typo first, said here, then the code pasted
    await s2.locator("#sync-start-again").click();
    await signInUi(s2, email, inbox);
    await expect(s2.locator("#sync-join-choose")).toBeVisible();
    await s2.locator("#sync-name").fill("Profile two");
    await s2.locator("#sync-join-approval").click();
    await expect(s2.locator("#sync-waiting")).toBeVisible();
    const code = await answerRequestUi(s1, STRONG);
    const reveals = () =>
      b.api.wire.slice(w0).filter((w) => w.method === "POST" && w.target.endsWith("/reveal")).length;
    const before = reveals();
    await enterPairingCodeUi(s2, await typoOf(code), "type");
    await expect(s2.locator("#sync-pair-err")).toBeVisible();
    expect(reveals()).toBe(before); // a typo the check bits catch sends nothing
    await expect(s2.locator("#sync-pair-in")).toBeVisible(); // the step stays, nothing used up
    await enterPairingCodeUi(s2, code, "paste");
    const sas = await readSasUi(s2);
    // the code is on no screen once the step is over: not in either page's DOM
    for (const page of [s1, s2]) {
      await expect(page.locator("#sync-pair-in, #sync-approve-code")).toHaveCount(0, { timeout: 30_000 });
      const html = await page.content();
      expect([html.includes(code), html.includes(code.replace(/-/g, ""))]).toEqual([false, false]);
    }
    await s1.locator("#sync-approve-sas-in").fill(sas);
    await s1.locator("#sync-approve-sas-next").click();
    await expect(s1.locator("#sync-approve-done")).toBeVisible({ timeout: 30_000 });
    await finishJoinUi(s2);
    expect(await issuersIn(p2)).toEqual(["GitHub"]);

    // S on no URL, and in nothing either profile stored
    for (const w of b.api.wire.slice(w0)) expect(w.target.includes(code.replace(/-/g, "")), w.target).toBe(false);
    for (const page of [s1, s2]) {
      const all = JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)));
      expect([all.includes(code), all.includes(code.replace(/-/g, ""))]).toEqual([false, false]);
    }
    for (const w of b.api.wire.slice(w0)) {
      expect(w.cookie, w.target).toBe(false);
      expect(w.referer, w.target).toBe(false);
    }
  } finally {
    await close(p1);
    await close(p2);
  }
});
