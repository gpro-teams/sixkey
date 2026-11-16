// Driving the settings page's Sync section (src/options/sync/) in a real profile, as a user does: the buttons, fields and
// steps by their ids (the e2e contract of the section, like the rest of the page's, PHASE0X-PLAN Appendix D).
import { expect, type Page } from "@playwright/test";
import { formatPairingCode, parsePairingCode } from "../../src/core/crypto/pairing-code";
import { openOptions, type Profile } from "../e2e/harness";

/** The settings page at its Sync section, loaded (the section's chunk and text). */
export async function openSync(p: Profile, hash = "#sync"): Promise<Page> {
  const page = await openOptions(p, hash);
  await expect(page.locator("#sync .panel-body > *").first()).toBeVisible();
  return page;
}

/** The email step, then the code the server's inbox received. */
export async function signInUi(page: Page, email: string, inbox: (email: string) => string): Promise<void> {
  await page.locator("#sync-email").fill(email);
  await page.locator("#sync-send-code").click();
  await expect(page.locator("#sync-otp-in")).toBeVisible();
  await page.locator("#sync-otp-in").fill(inbox(email));
  await page.locator("#sync-verify").click();
}

/** Turns sync on with the recovery code the user has (O1–O3), up to the card saying it is in sync. */
export async function turnOnUi(
  page: Page,
  o: { password: string; email: string; recoveryCode: string; name?: string; inbox: (email: string) => string },
): Promise<void> {
  await page.locator("#sync-turn-on").click();
  await page.locator("#sync-pw").fill(o.password);
  await page.locator("#sync-pw-next").click();
  await signInUi(page, o.email, o.inbox);
  await expect(page.locator("#sync-name")).toBeVisible();
  if (o.name) await page.locator("#sync-name").fill(o.name);
  await page.locator("#sync-name-next").click();
  await page.locator("#sync-have-code").click();
  await page.locator("#sync-rc").fill(o.recoveryCode);
  await page.locator("#sync-rc-next").click();
  await expect(page.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 60_000 });
}

/** The join's first screens: the click, the sign-in, the warning card (O4). */
export async function startJoinUi(
  page: Page,
  o: { email: string; inbox: (email: string) => string; name?: string },
): Promise<void> {
  await page.locator("#sync-join-start").click();
  await signInUi(page, o.email, o.inbox);
  await expect(page.locator("#sync-join-choose")).toBeVisible();
  if (o.name) await page.locator("#sync-name").fill(o.name);
}

/**
 * The summary's Continue, then the card saying it is in sync. A join with the recovery code shows its follow-ups first
 * (O7): "Later" closes them, unless `followUps: "stay"` leaves them on screen for the caller.
 */
export async function finishJoinUi(page: Page, o: { followUps?: "later" | "stay" } = {}): Promise<void> {
  await expect(page.locator("#sync-summary")).toBeVisible();
  await page.locator("#sync-join-commit").click();
  await expect(page.locator("#sync-card[data-state=ok], #sync-join-followups").first()).toBeVisible({
    timeout: 60_000,
  });
  if (await page.locator("#sync-join-followups").count()) {
    if (o.followUps === "stay") return;
    await page.locator("#sync-join-done-ok").click();
  }
  await expect(page.locator("#sync-card[data-state=ok]")).toBeVisible({ timeout: 60_000 });
}

/** Turning sync off on this device (§3.10) with the master password. */
export async function turnOffUi(page: Page, password: string): Promise<void> {
  await page.locator("#sync-off-open").click();
  await page.locator("#sync-off-pw").fill(password);
  await page.locator("#sync-off-go").click();
  await expect(page.locator("#sync-off-card")).toBeVisible({ timeout: 60_000 });
}

/**
 * A new recovery code's two steps (show before commit, A4): the code read off the screen, "I saved it", then the two
 * groups the page asks for typed back. Returns the code.
 */
export async function newCodeUi(page: Page, idPrefix: string): Promise<string> {
  await expect(page.locator("#sync-recovery-code")).toBeVisible({ timeout: 30_000 });
  const code = (await page.locator("#sync-recovery-code").innerText()).replace(/\s/g, "");
  const groups = code.split("-");
  await page.locator(`#${idPrefix}-code-saved`).click();
  for (const n of ["g1", "g2"]) {
    const label = await page.locator(`label[for=${idPrefix}-${n}]`).innerText();
    const at = Number(/\d+/.exec(label)![0]) - 1;
    await page.locator(`#${idPrefix}-${n}`).fill(groups[at]!);
  }
  await page.locator(`#${idPrefix}-groups-next`).click();
  return code;
}

// ---- the approval join (§3.2, enrolment v2; O5, O9) --------------------------------------------------------------------

/** The approving section opened with the master password, the one waiting request chosen: the pairing code it shows. */
export async function answerRequestUi(page: Page, password: string): Promise<string> {
  await page.locator("#sync-approve-open").click();
  await page.locator("#sync-approve-pw").fill(password);
  await page.locator("#sync-approve-pw-next").click();
  const approve = page.locator("#sync-approve-list button[id^=sync-approve-]").first();
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await approve.click();
  return readPairingCode(page);
}

/** The pairing code the approving section shows (O9), as the user reads it: seven groups of four joined by "-". */
export async function readPairingCode(page: Page): Promise<string> {
  await expect(page.locator("#sync-approve-code")).toBeVisible({ timeout: 30_000 });
  const code = (await page.locator("#sync-approve-code > span[aria-hidden]").innerText()).replace(/\s/g, "");
  // screen readers get the same symbols, one by one, a pause between the groups
  const spoken = await page.locator("#sync-approve-code .vh").innerText();
  expect(spoken.replace(/[\s,]/g, "")).toBe(code.replace(/-/g, ""));
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
  return code;
}

/**
 * The new profile takes the code (O5): pasted (the whole text in one input event, as a paste is; Playwright's
 * insertText sends no key events) or typed key by key, then Continue.
 */
export async function enterPairingCodeUi(page: Page, code: string, how: "paste" | "type" = "paste"): Promise<void> {
  const field = page.locator("#sync-pair-in");
  await expect(field).toBeVisible({ timeout: 30_000 });
  expect(await field.getAttribute("type")).toBe("password"); // masked until the user ticks Show
  await field.fill("");
  if (how === "paste") {
    await field.focus();
    await page.keyboard.insertText(code);
  } else await field.pressSequentially(code);
  await page.locator("#sync-pair-next").click();
}

/** The six digits read off the new profile (O5), typed on the approving one (O9). */
export async function readSasUi(page: Page): Promise<string> {
  await expect(page.locator("#sync-sas")).toBeVisible({ timeout: 30_000 });
  const sas = (await page.locator("#sync-sas").innerText()).replace(/\D/g, "");
  expect(sas).toMatch(/^\d{6}$/);
  return sas;
}

/** The code with one symbol changed so that its check bits catch it (searched: about 1 in 4096 typos would pass them). */
export async function typoOf(code: string): Promise<string> {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "-") continue;
    for (const c of A) {
      if (c === code[i]) continue;
      const t = code.slice(0, i) + c + code.slice(i + 1);
      const r = await parsePairingCode(t).then(
        () => "accepted",
        (e: { code?: string }) => e.code,
      );
      if (r === "pairing_checksum") return t;
    }
  }
  throw new Error("no typo the check bits catch");
}

/** A pairing code that passes its check bits but is not the approver's: what a typo past them looks like. */
export const otherValidCode = (): Promise<string> => formatPairingCode(crypto.getRandomValues(new Uint8Array(16)));
