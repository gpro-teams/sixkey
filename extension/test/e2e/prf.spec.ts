// QUICK-UNLOCK Stage 2 end to end (docs/design/notes/PRF-NOTES.md), with Chrome's virtual authenticator (CDP WebAuthn,
// QUICK-UNLOCK §7.2) standing in for Touch ID / Windows Hello: enrolment in Settings › Security and how it classifies
// what the authenticator returned (PRF or gate, synced or not, the opt-in), the lock screen's button, a browser restart
// (chrome.storage.session cleared, which is all a restart does to Sixkey's state), a failed user verification, a passkey
// removed from the OS, a key change and "turn back on", the shared preset, the settings page's unlock bar.
// Scope (§7.2 "Scope caveat"): a new browser process has no virtual authenticator, so the restart is simulated in the same
// tab, and enrolment and unlock run in the same tab, navigated between the settings page and the popup's page. Every test
// removes its authenticator. The real toolbar popup, the small window and real hardware are the owner's manual checks.
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { addByPaste, close, GITHUB_URI, launch, openFold, type Profile, startFresh, STRONG } from "./harness";
import { failedCount, guessWrong } from "./security-helpers";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

type Va = { page: Page; cdp: CDPSession; id: string; done: () => Promise<void> };
/** A tab with a virtual platform authenticator: user verification, resident keys, PRF unless told otherwise. */
async function withAuthenticator(options: Record<string, unknown> = {}): Promise<Va> {
  const page = await p.ctx.newPage();
  const cdp = await p.ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: false,
      defaultBackupState: false,
      ...options,
    },
  } as never)) as { authenticatorId: string };
  const done = async () => {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.send("WebAuthn.disable");
  };
  return { page, cdp, id: authenticatorId, done };
}
const settings = (page: Page) => page.goto(`chrome-extension://${p.id}/options/index.html#security`);
const popup = (page: Page) => page.goto(`chrome-extension://${p.id}/popup/index.html`);

/** Settings › Security › Unlock with Touch ID: the master password, the opt-in if asked, Use Touch ID. */
async function enrol(page: Page, o: { optIn?: boolean } = {}): Promise<void> {
  await settings(page);
  await expect(page.locator(".status dd.num")).toHaveText(/^\d+$/); // loaded
  await expect(page.locator("#device-box")).toBeVisible();
  await openFold(page, "device-box");
  await page.locator("#device-pw").fill(STRONG);
  if (o.optIn) {
    await expect(page.locator("#device-optin-notice")).toHaveCount(0);
    await page.locator("#device-optin").check();
    await expect(page.locator("#device-optin-notice")).toBeVisible(); // the plain-language notice comes with the box (Q2)
  }
  await page.locator("#device-add").click();
  await expect(page.locator("#device-msg")).toBeVisible();
}
/** The popup's page in this tab, Lock now: the lock screen. */
async function lockedPopup(page: Page): Promise<void> {
  await popup(page);
  await expect(page.locator("#q")).toBeVisible();
  await page.locator("#lock-now").click();
  await expect(page.locator("#secret, #pin").first()).toBeVisible();
}
const kinds = (page: Page) =>
  page.evaluate(async () => {
    const r = (await chrome.storage.local.get("sk_security_log")).sk_security_log as { entries?: { kind: string }[] };
    return (r?.entries ?? []).map((e) => e.kind);
  });
/** A browser restart, as far as Sixkey's state goes. */
const restart = async (page: Page) => {
  await page.evaluate(() => chrome.storage.session.clear());
  await page.reload();
};

test("a passkey with PRF: enrolled with one touch more, opens Sixkey from the lock screen, also after a restart", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  await expect(page.locator("#device-msg")).toContainText(/Turned on/);
  await expect(page.locator("#device-list li")).toHaveCount(1);
  await expect(page.locator("#device-list")).toContainText(/Also after a restart/);
  await expect(page.locator("#device-list li")).toHaveAttribute("data-mode", "prf");
  await expect(page.locator("#device-list")).toContainText(
    /A copy of this browser profile still needs your master password/,
  );
  expect(await kinds(page)).toContain("prf_enrolled");
  const local = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  expect(local).toContain("sk_prf");
  expect(local).not.toContain("sk_quick");

  await lockedPopup(page);
  const go = page.locator("#device-unlock-go");
  await expect(go).toBeVisible();
  await expect(go).toHaveText(/^Unlock with /);
  await expect(go).toBeFocused(); // Enter starts it (§6.4); it never starts by itself
  await expect(page.locator("#device-unlock-note")).toContainText("chrome-extension");
  await page.keyboard.press("Enter");
  await expect(page.locator("#q")).toBeVisible();
  await expect(page.locator(".row")).toHaveCount(1);

  await restart(page);
  await expect(page.locator("#device-unlock-go")).toBeVisible(); // the persistent unlock survives the restart
  await expect(page.locator("#pin")).toHaveCount(0); // and no session method is offered
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();
  await va.done();
});

test("a passkey without PRF: the gate, until the browser closes; after a restart only the master password, which arms it again", async () => {
  await startFresh(p);
  const va = await withAuthenticator({ hasPrf: false });
  const page = va.page;
  await enrol(page);
  await expect(page.locator("#device-msg")).toContainText(/Turned on/);
  await expect(page.locator("#device-list")).toContainText(/Until the browser closes/);
  await expect(page.locator("#device-list li")).toHaveAttribute("data-mode", "gate");
  await expect(page.locator("#device-list")).toContainText(/not programs on it/); // the honest label
  await lockedPopup(page);
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();

  await restart(page);
  await expect(page.locator("#secret")).toBeVisible();
  await expect(page.locator("#device-unlock-go")).toHaveCount(0);
  await expect(page.locator("#device-unlock-waiting")).toBeVisible(); // why: the master password once
  await page.locator("#secret").fill(STRONG);
  await page.locator("#secret").press("Enter");
  await expect(page.locator("#q")).toBeVisible();
  await page.locator("#lock-now").click();
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();
  await va.done();
});

test("a failed user verification opens nothing and records nothing; the master password's field takes the focus", async () => {
  await startFresh(p);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  await lockedPopup(page);
  await va.cdp.send("WebAuthn.setUserVerified", { authenticatorId: va.id, isUserVerified: false });
  const before = await kinds(page);
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#secret")).toBeFocused();
  await expect(page.locator("#q")).toHaveCount(0);
  expect(await kinds(page)).toEqual(before);
  await va.done();
});

test("an assertion without user verification is refused by Sixkey's own check, whatever the browser passes on", async () => {
  await startFresh(p);
  const va = await withAuthenticator({ hasPrf: false });
  const page = va.page;
  await enrol(page);
  await lockedPopup(page);
  const set = await va.cdp
    .send("WebAuthn.setResponseOverrideBits", { authenticatorId: va.id, isBadUV: true } as never)
    .then(
      () => true,
      () => false,
    );
  test.skip(!set, "this Chromium has no WebAuthn.setResponseOverrideBits (the unit tests cover the clause)");
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#secret")).toBeFocused();
  await expect(page.locator("#q")).toHaveCount(0);
  await va.done();
});

test("a synced passkey: a gate without the opt-in (and why); with it, the persistent unlock marked Synced", async () => {
  await startFresh(p);
  const va = await withAuthenticator({ defaultBackupEligibility: true, defaultBackupState: true });
  const page = va.page;
  await enrol(page);
  await expect(page.locator("#device-msg")).toContainText(
    /This passkey syncs, so it works only until the browser closes/,
  ); // prfSyncedRefused
  await expect(page.locator("#device-list li")).toHaveAttribute("data-mode", "gate");
  await expect(page.locator("#device-list .dv-tag")).toHaveText("Synced");
  const id = await page.evaluate(
    async () => ((await chrome.storage.local.get("sk_prf")).sk_prf as { creds: { id: string }[] }).creds[0]!.id,
  );
  await openFold(page, "device-box");
  await page.locator("#device-pw").fill(STRONG);
  await page.locator(`#device-remove-${id}`).click();
  await expect(page.locator("#device-msg")).toContainText(/still in/);
  await expect(page.locator("#device-list")).toHaveCount(0);
  await enrol(page, { optIn: true });
  await expect(page.locator("#device-msg")).toContainText(/Turned on/);
  await expect(page.locator("#device-list li")).toHaveAttribute("data-mode", "prf");
  await expect(page.locator("#device-list")).toContainText(/that account plus a copy of this browser profile/);
  await va.done();
});

test("a passkey deleted in the OS: the master password still opens Sixkey, and the box removes the credential", async () => {
  await startFresh(p);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  const { credentials } = (await va.cdp.send("WebAuthn.getCredentials", { authenticatorId: va.id })) as {
    credentials: { credentialId: string }[];
  };
  expect(credentials).toHaveLength(1);
  await va.cdp.send("WebAuthn.removeCredential", {
    authenticatorId: va.id,
    credentialId: credentials[0]!.credentialId,
  });
  await lockedPopup(page);
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#secret")).toBeFocused(); // a removed passkey looks like a cancel, by design
  await page.locator("#secret").fill(STRONG);
  await page.locator("#secret").press("Enter");
  await expect(page.locator("#q")).toBeVisible();
  await settings(page);
  await openFold(page, "device-box");
  await expect(page.locator("#device-box-body")).toContainText(/Not working here/);
  await page.locator("#device-pw").fill(STRONG);
  await page.locator("[id^=device-remove-]").click();
  await expect(page.locator("#device-list")).toHaveCount(0);
  expect(await kinds(page)).toContain("prf_removed");
  await va.done();
});

test("a key change pauses it; one confirmation turns it back on", async () => {
  await startFresh(p);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  await page.goto(`chrome-extension://${p.id}/options/index.html#security-keys`);
  await openFold(page, "fold-rotate");
  await page.locator("#rot-pw").fill(STRONG);
  await page.locator("#rotate-key").click();
  await expect(page.locator("#recovery-code")).toBeVisible();
  await lockedPopup(page);
  await expect(page.locator("#device-unlock-paused")).toBeVisible();
  await expect(page.locator("#device-unlock-go")).toHaveCount(0);
  await page.locator("#secret").fill(STRONG);
  await page.locator("#secret").press("Enter");
  await expect(page.locator("#q")).toBeVisible();
  await settings(page);
  await expect(page.locator("#device-list li")).toHaveAttribute("data-paused", "1");
  await openFold(page, "device-box");
  await page.locator("#device-pw").fill(STRONG);
  await page.locator("[id^=device-on-]").click();
  await expect(page.locator("#device-msg")).toContainText(/Turned on/);
  await lockedPopup(page);
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();
  await va.done();
});

test("the shared preset ends the gate, and the box says why it is not used there", async () => {
  await startFresh(p);
  const va = await withAuthenticator({ hasPrf: false });
  const page = va.page;
  await enrol(page);
  expect(await page.evaluate(async () => !!(await chrome.storage.session.get("sk_quick")).sk_quick)).toBe(true);
  await page.locator("#sm-shared").check();
  await expect
    .poll(() => page.evaluate(async () => (await chrome.storage.session.get("sk_quick")).sk_quick))
    .toBeUndefined();
  await expect(page.locator("#device-list")).toContainText(/Not used in this security mode/);
  await popup(page);
  await expect(page.locator("#secret")).toBeVisible();
  await expect(page.locator("#device-unlock-go")).toHaveCount(0);
  await va.done();
});

test("the settings page's unlock bar offers the device unlock too", async () => {
  await startFresh(p);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  await page.evaluate(() => chrome.storage.session.remove("sk_session")); // locked, as after an idle lock
  await page.reload();
  await expect(page.locator("#unlock-pw")).toBeVisible();
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#unlock-pw")).toHaveCount(0);
  await va.done();
});

test("the 14 days restart when the master password unlocks the lock screen, not when the recovery key does", async () => {
  const { recoveryCode } = await startFresh(p);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  const timeOf = () =>
    page.evaluate(
      async () => ((await chrome.storage.local.get("sk_prf")).sk_prf as { lastPasswordAt: number }).lastPasswordAt,
    );
  const setBack = (days: number) =>
    page.evaluate(async (d) => {
      const r = (await chrome.storage.local.get("sk_prf")).sk_prf as { lastPasswordAt: number };
      await chrome.storage.local.set({ sk_prf: { ...r, lastPasswordAt: Date.now() - d * 864e5 } });
    }, days);
  await setBack(2);
  const old = await timeOf();
  await lockedPopup(page);
  await page.locator("#secret").fill(STRONG);
  await page.locator("#secret").press("Enter");
  await expect(page.locator("#q")).toBeVisible();
  await expect.poll(timeOf).toBeGreaterThan(old + 864e5); // written again, by the lock screen's device chunk
  await setBack(2);
  const again = await timeOf();
  await page.locator("#lock-now").click();
  await page.getByRole("button", { name: /recovery/i }).click();
  await page.locator("#secret").fill(recoveryCode);
  await page.locator("#secret").press("Enter");
  await expect(page.locator("#q")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await timeOf()).toBe(again); // a recovery key unlock does not restart them
  await va.done();
});

test('a gate with no PIN: the device box offers "End quick unlock and lock" too, and it ends the gate (REVIEW S9)', async () => {
  await startFresh(p);
  const va = await withAuthenticator({ hasPrf: false });
  const page = va.page;
  await enrol(page);
  await expect(page.locator("#device-quick-end")).toHaveText(/End quick unlock and lock/); // the PIN box's own words
  await page.locator("#device-quick-end").click();
  await expect(page.locator("#unlock-pw")).toBeVisible(); // a hard lock: this page is locked too
  expect(await kinds(page)).toContain("quick_ended");
  await popup(page);
  await expect(page.locator("#secret")).toBeVisible();
  await expect(page.locator("#device-unlock-go")).toHaveCount(0); // the gate's arming is gone: the master password
  await va.done();
});

test("a device unlock shows the wrong-password notice but never takes its count off; the master password does (REVIEW S5)", async () => {
  await startFresh(p);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  await lockedPopup(page);
  await guessWrong(page, 2);
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();
  await expect(page.locator("#sec-notice")).toContainText(/\b2\b/);
  await page.waitForTimeout(800); // what an ack would have taken
  expect(await failedCount(page)).toBe(2); // shown, not acked: only someone who typed the master password acks it
  await page.locator("#lock-now").click();
  await page.locator("#secret").fill(STRONG);
  await page.locator("#secret").press("Enter");
  await expect(page.locator("#sec-notice")).toContainText(/\b2\b/);
  await expect.poll(() => failedCount(page)).toBe(0);
  await va.done();
});

test("a PIN and the gate at once: the lock screen offers both, either opens (OWNER-DECISIONS/17 Q1)", async () => {
  await startFresh(p);
  const va = await withAuthenticator({ hasPrf: false });
  const page = va.page;
  await enrol(page);
  // the PIN, set in the PIN box beside it (the master password typed: both armed from now)
  await openFold(page, "pin-box");
  await page.locator("#pin-pw").fill(STRONG);
  await page.locator("#pin-new").fill("246813");
  await page.locator("#pin-new2").fill("246813");
  await page.locator("#pin-set").click();
  await expect(page.locator("#pin-info")).toBeVisible();
  await lockedPopup(page);
  await expect(page.locator("#pin")).toBeVisible();
  await expect(page.locator("#device-unlock-go")).toBeVisible(); // both offered
  await expect(page.locator("#pin")).toBeFocused(); // the PIN keeps the focus
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();
  await page.locator("#lock-now").click();
  await page.locator("#pin").fill("246813"); // sends itself at its length
  await expect(page.locator("#q")).toBeVisible();
  await va.done();
});

test("right after the key change, one touch turns it back on, with no master password again (OWNER-DECISIONS/17 Q3)", async () => {
  await startFresh(p);
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  await page.goto(`chrome-extension://${p.id}/options/index.html#security-keys`);
  await openFold(page, "fold-rotate");
  await page.locator("#rot-pw").fill(STRONG);
  await page.locator("#rotate-key").click();
  await expect(page.locator("#recovery-code")).toBeVisible();
  await page.locator("#recovery-saved").check();
  await page.locator("#recovery-done").click();
  await expect(page.locator("#device-after-key")).toContainText(/turn .* back on/);
  await page.locator("[id^=device-after-on-]").click();
  await expect(page.locator("#device-after-key")).toContainText(/Turned on/);
  await lockedPopup(page);
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();
  await va.done();
});

test("a synced gate made one that also works after a restart, in place, after the notice (OWNER-DECISIONS/17 Q4)", async () => {
  await startFresh(p);
  const va = await withAuthenticator({ defaultBackupEligibility: true, defaultBackupState: true });
  const page = va.page;
  await enrol(page);
  await expect(page.locator("#device-msg")).toContainText(/choose “Also after a restart” beside it/); // dvSyncedRefused
  const id = await page.evaluate(
    async () => ((await chrome.storage.local.get("sk_prf")).sk_prf as { creds: { id: string }[] }).creds[0]!.id,
  );
  await page.locator("#device-pw").fill(STRONG);
  await expect(page.locator("#device-also-notice")).toHaveCount(0);
  await page.locator(`#device-also-${id}`).click();
  await expect(page.locator("#device-also-notice")).toContainText(/company's cloud/); // the synced notice first (Q2)
  await page.locator("#device-also-go").click();
  await expect(page.locator("#device-msg")).toContainText(/Turned on/);
  await expect(page.locator("#device-list li")).toHaveAttribute("data-mode", "prf");
  await expect(page.locator("#device-list")).toContainText(/that account plus a copy of this browser profile/);
  expect(
    await page.evaluate(async () =>
      ((await chrome.storage.local.get("sk_prf")).sk_prf as { creds: { id: string }[] }).creds.map((c) => c.id),
    ),
  ).toEqual([id]); // the same credential, no second passkey
  await restart(page);
  await popup(page);
  await page.locator("#device-unlock-go").click();
  await expect(page.locator("#q")).toBeVisible();
  await va.done();
});

test("after the key change, each paused credential is turned back on by itself, with its own answer (REVIEW-r2 G4)", async () => {
  await startFresh(p);
  const gone = await withAuthenticator(); // a first computer's passkey, whose authenticator is then gone
  await enrol(gone.page);
  await gone.done();
  const va = await withAuthenticator();
  const page = va.page;
  await enrol(page);
  const [a, b] = await page.evaluate(async () =>
    ((await chrome.storage.local.get("sk_prf")).sk_prf as { creds: { id: string }[] }).creds.map((c) => c.id),
  );
  await page.goto(`chrome-extension://${p.id}/options/index.html#security-keys`);
  await openFold(page, "fold-rotate");
  await page.locator("#rot-pw").fill(STRONG);
  await page.locator("#rotate-key").click();
  await expect(page.locator("#recovery-code")).toBeVisible();
  await page.locator("#recovery-saved").check();
  await page.locator("#recovery-done").click();
  await expect(page.locator(`#device-after-${a}`)).toBeVisible();
  await expect(page.locator(`#device-after-${b}`)).toBeVisible();
  await page.locator(`#device-after-on-${a}`).click(); // its passkey is not here: nothing saved, said for it
  await expect(page.locator(`#device-after-${a}`)).toContainText(/Nothing was saved/);
  await page.locator(`#device-after-on-${b}`).click();
  await expect(page.locator(`#device-after-${b}`)).toContainText(/Turned on/);
  await expect(page.locator(`#device-after-${a}`)).toContainText(/Nothing was saved/); // the first answer is still shown
  await va.done();
});
