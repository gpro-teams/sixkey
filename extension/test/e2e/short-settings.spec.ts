// The settings page is five groups, and shows one leaf of a group at a time (SHORT-SETTINGS-NOTES.md): the rail is the
// navigation of the groups, the row under the title that of the leaves, the address bar's hash is the choice, Back and
// Forward move between leaves, the heading takes the focus on a switch, every hash other pages open still lands where it
// did, and what was typed in a leaf does not outlive it. What the page holds above its leaves (a new recovery code, the
// outcome of an operation, the questions about deleting an imported file) survives them. The hash mapping itself is
// short-settings-route.test.ts's; the forms' wiping, short-settings-dom.test.ts's. The sync section's own deep links
// (#sync, #sync/join) are the sync specs'.
import { expect, test, type Page } from "@playwright/test";
import {
  close,
  launch,
  openFold,
  openOptions,
  openPopup,
  seedLegacyDeviceVault,
  showSection,
  startFresh,
  STRONG,
  writeTmp,
  type Profile,
} from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
  await startFresh(p);
});
test.afterEach(async () => {
  await close(p);
});

/** The panels drawn and visible right now (the sync section is mounted but hidden unless shown). */
const shown = (page: Page) => page.locator("main section.panel:visible").evaluateAll((els) => els.map((e) => e.id));
const group = (page: Page) => page.locator(".rail nav a[aria-current]");
const leaf = (page: Page) => page.locator('.subnav a[aria-current="page"]');
/** The page's own address, as the browser holds it. */
const hashOf = (page: Page) => page.evaluate(() => location.hash);
const OTHER_APP = "otpauth://totp/Handed:me?secret=JBSWY3DPEHPK3PXP&issuer=Handed";
const pick = (page: Page, name: string, text = OTHER_APP) =>
  page.locator("#backup-file").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
const lockFromPopup = async (page: Page) => {
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(page.locator("#unlock-pw")).toBeVisible();
  await pop.close();
};
const unlockHere = async (page: Page) => {
  await page.locator("#unlock-pw").fill(STRONG);
  await page.locator("#unlock-pw").press("Enter");
  await expect(page.locator("#unlock-pw")).toHaveCount(0);
};

/**
 * A settings page whose first vault read is held until `release()`: the page knows it is unlocked (status) and has not
 * read the vault yet, the moment Backup's hand-over and a lock can meet. A test seam in this page only (an init script
 * that holds the page's AES-GCM decryption, which only the vault read uses before anything is released), not in the
 * product. `done()`: how many held decryptions have finished since.
 */
async function openHeld(hash: string) {
  const page = await p.ctx.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __held: number; __done: number; __release: () => void };
    const subtle = crypto.subtle;
    const real = subtle.decrypt.bind(subtle);
    const waiting: (() => void)[] = [];
    let open = false;
    w.__held = 0;
    w.__done = 0;
    w.__release = () => {
      open = true;
      waiting.splice(0).forEach((go) => go());
    };
    Object.defineProperty(subtle, "decrypt", {
      configurable: true,
      value: async (...a: Parameters<SubtleCrypto["decrypt"]>) => {
        if (open) return real(...a);
        w.__held++;
        await new Promise<void>((go) => waiting.push(go));
        const out = await real(...a);
        w.__done++;
        return out;
      },
    });
  });
  await page.goto(`chrome-extension://${p.id}/options/index.html${hash}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __held: number }).__held)).toBeGreaterThan(0);
  await expect(page.locator(".status dd.num")).toHaveText("—"); // unlocked, and no vault read yet
  return {
    page,
    release: () => page.evaluate(() => (window as unknown as { __release: () => void }).__release()),
    done: () => page.evaluate(() => (window as unknown as { __done: number }).__done),
  };
}

test("opens on Security › Locking: five groups in the rail, the group marked, the leaves of a group under the title", async () => {
  const opt = await openOptions(p);
  await expect(opt.locator("#security")).toBeVisible();
  expect(await shown(opt)).toEqual(["security"]);
  await expect(opt.getByRole("navigation", { name: /Sections|分区/ })).toBeVisible();
  await expect(opt.locator(".rail nav a")).toHaveCount(5); // the e2e build has Sync; the plugin platform's group went
  await expect(group(opt)).toHaveCount(1);
  await expect(group(opt)).toHaveAttribute("href", "#security");
  await expect(group(opt)).toHaveAttribute("aria-current", "true"); // a group with leaves of its own
  await expect(opt.locator(".subnav a[href]")).toHaveCount(4); // with Autofill (AUTOFILL2 patch 2)
  await expect(leaf(opt)).toHaveAttribute("href", "#security");
  // a group that is one page has no row of leaves, and its link is the page
  await showSection(opt, "appearance");
  await expect(opt.locator(".subnav")).toHaveCount(0);
  await expect(group(opt)).toHaveAttribute("aria-current", "page");
  // an unknown hash, and the hashes that are not leaves, open the default one
  for (const hash of ["#nothing", "#install", "#security2"]) {
    const page = await openOptions(p, hash);
    await expect(page.locator("#security")).toBeVisible();
    expect(await shown(page), hash).toEqual(["security"]);
    await page.close();
  }
});

test("every hash the popup and the page open lands on its leaf, with its group and leaf marked", async () => {
  const cases: [hash: string, panel: string, group: string, leaf?: string][] = [
    ["#security", "security", "security", "security"],
    ["#security-keys", "security-keys", "security", "security-keys"],
    ["#security-log", "security-log", "security", "security-log"],
    ["#accounts", "add", "accounts", "add"],
    ["#add", "add", "accounts", "add"],
    ["#add-paste", "add", "accounts", "add"],
    ["#add-upload", "add", "accounts", "add"],
    ["#backup", "backup", "accounts", "backup"],
    ["#trash", "trash", "accounts", "trash"],
    ["#autofill", "autofill", "security", "autofill"], // the Security group's fourth leaf (AUTOFILL2 patch 2)
    ["#appearance", "appearance", "appearance"],
    ["#clipboard", "clipboard", "appearance"], // a panel of the Appearance leaf
    ["#advanced", "advanced", "advanced"],
    ["#guide", "security", "security", "security"], // the removed Guide panel's name: the default leaf
  ];
  for (const [hash, panel, grp, lf] of cases) {
    const page = await openOptions(p, hash);
    await expect(page.locator(`#${panel}`), hash).toBeVisible();
    await expect(group(page), hash).toHaveAttribute("href", `#${grp}`);
    if (lf) await expect(leaf(page), hash).toHaveAttribute("href", `#${lf}`);
    await page.close();
  }
});

test("a group's page is one leaf: Appearance holds the Clipboard panel, Advanced only its own", async () => {
  const opt = await openOptions(p, "#appearance");
  await expect(opt.locator("#clipboard")).toBeVisible();
  expect(await shown(opt)).toEqual(["appearance", "clipboard"]);
  await showSection(opt, "advanced");
  expect(await shown(opt)).toEqual(["advanced"]);
});

test("the links switch leaves, write the hash, move the focus to the heading and start at the top; Back and Forward follow", async () => {
  const opt = await openOptions(p);
  await opt.setViewportSize({ width: 1000, height: 500 });
  await expect(opt.locator("#security")).toBeVisible();
  const focus = () => opt.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.textContent}`);
  expect(await focus()).not.toMatch(/^H2/); // nothing took the focus when the page opened

  await opt.locator('.rail nav a[href="#accounts"]').click();
  await expect(opt.locator("#add")).toBeVisible();
  expect(await hashOf(opt)).toBe("#accounts");
  await expect(opt.locator("#add h2")).toBeFocused();
  await opt.locator('.subnav a[href="#backup"]').click();
  await expect(opt.locator("#backup")).toBeVisible();
  expect(await hashOf(opt)).toBe("#backup");
  expect(await shown(opt)).toEqual(["backup"]);
  await expect(leaf(opt)).toHaveAttribute("href", "#backup");
  await expect(group(opt)).toHaveAttribute("href", "#accounts");
  await expect(opt.locator("#backup h2")).toBeFocused();
  expect(await opt.evaluate(() => scrollY)).toBe(0);

  await opt.locator('.subnav a[href="#trash"]').click();
  await expect(opt.locator("#trash h2")).toBeFocused();

  await opt.goBack();
  await expect(opt.locator("#backup")).toBeVisible();
  await opt.goBack();
  await expect(opt.locator("#add")).toBeVisible();
  await opt.goBack(); // the page's first address, with no hash: the default
  await expect(opt.locator("#security")).toBeVisible();
  await expect(group(opt)).toHaveAttribute("href", "#security");
  await opt.goForward();
  await opt.goForward();
  await opt.goForward();
  await expect(opt.locator("#trash")).toBeVisible();
  expect(await shown(opt)).toEqual(["trash"]);
});

test("a leaf is shown from its top, whatever the one before was scrolled to", async () => {
  const opt = await openOptions(p, "#backup");
  await opt.setViewportSize({ width: 1000, height: 500 });
  await expect(opt.locator("#backup")).toBeVisible();
  await opt.evaluate(() => scrollTo(0, 300));
  expect(await opt.evaluate(() => scrollY)).toBeGreaterThan(100);
  await opt.evaluate(() => (location.hash = "#add")); // Add account is taller than the window too
  await expect(opt.locator("#add h2")).toBeFocused();
  expect(await opt.evaluate(() => scrollY)).toBe(0);
});

test("Back to an address that names no leaf shows the default leaf, as the address says (not the leaf last shown)", async () => {
  const opt = await openOptions(p, "#install");
  await expect(opt.locator("#security")).toBeVisible();
  await opt.locator('.rail nav a[href="#accounts"]').click();
  await opt.locator('.subnav a[href="#backup"]').click();
  await expect(opt.locator("#backup")).toBeVisible();
  await opt.goBack();
  await opt.goBack();
  expect(await hashOf(opt)).toBe("#install");
  await expect(opt.locator("#security")).toBeVisible();
  expect(await shown(opt)).toEqual(["security"]);
  await expect(group(opt)).toHaveAttribute("href", "#security");
});

test("a hash written in the page switches to its leaf (the sync section's actions, the rail's link, #security-log)", async () => {
  const opt = await openOptions(p, "#add");
  await expect(opt.locator("#add")).toBeVisible();
  await opt.evaluate(() => (location.hash = "#advanced")); // as the sync section's actions do
  await expect(opt.locator("#advanced")).toBeVisible();
  expect(await shown(opt)).toEqual(["advanced"]);
  await opt.evaluate(() => (location.hash = "#security-log"));
  await expect(opt.locator("#security-log")).toBeVisible();
  await expect(leaf(opt)).toHaveAttribute("href", "#security-log");
});

test("320 px: the groups wrap and the leaves wrap: nothing scrolls sideways, every link is in view", async () => {
  const opt = await openOptions(p, "#accounts");
  await opt.setViewportSize({ width: 320, height: 700 });
  await expect(opt.locator("#add")).toBeVisible();
  for (const nav of [opt.locator(".rail nav"), opt.locator(".subnav")]) {
    const m = await nav.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      right: el.getBoundingClientRect().right,
    }));
    expect(m.scroll, "no sideways scroll").toBeLessThanOrEqual(m.client);
    expect(m.right).toBeLessThanOrEqual(320);
  }
  for (const a of await opt.locator(".rail nav a, .subnav a").all()) {
    const box = (await a.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  expect(await opt.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("a short window: the rail scrolls by itself, so the language menu stays reachable", async () => {
  const opt = await openOptions(p);
  await opt.setViewportSize({ width: 1400, height: 420 });
  await expect(opt.locator("#security")).toBeVisible();
  const rail = await opt
    .locator(".rail")
    .evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, y: getComputedStyle(el).overflowY }));
  expect(rail.y).toBe("auto");
  expect(rail.client).toBeLessThanOrEqual(420);
  expect(rail.scroll).toBeGreaterThan(rail.client); // it does not fit: it scrolls
  await opt.locator("#lang-select").scrollIntoViewIfNeeded();
  const box = (await opt.locator("#lang-select").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  await expect(opt.locator("#lang-select")).toBeVisible();
});

test("the sync leaf takes the focus on its heading (the late arrival of its code is short-settings-sync-host.test.ts's)", async () => {
  const opt = await openOptions(p);
  await expect(opt.locator("#security")).toBeVisible();
  await opt.locator('.rail nav a[href="#sync"]').click();
  await expect(opt.locator("#sync .panel-body > *").first()).toBeVisible({ timeout: 20_000 }); // the section has loaded
  await expect(opt.locator("#sync h2")).toBeFocused();
});

test("#sync opens the sync section (this build has it); leaving it hides it but keeps it running", async () => {
  const opt = await openOptions(p, "#sync");
  await expect(opt.locator("#sync")).toBeVisible();
  expect(await shown(opt)).toEqual(["sync"]);
  await expect(group(opt)).toHaveAttribute("href", "#sync");
  await showSection(opt, "security");
  await expect(opt.locator("#sync")).toBeHidden();
  await expect(opt.locator("#sync")).toHaveCount(1); // still mounted: the rail's sync line and its rounds need it
  await expect(opt.locator("#rail-sync")).toBeVisible();
});

test("what was typed in the sync section does not wait there while another leaf is shown", async () => {
  const opt = await openOptions(p, "#sync");
  await opt.locator("#sync-turn-on").click();
  await opt.locator("#sync-pw").fill(STRONG);
  await showSection(opt, "trash");
  await showSection(opt, "sync");
  await expect(opt.locator("#sync-pw")).toHaveValue("");
});

test("a file under Backup that is not a Sixkey backup is handed over by following the message's link, and only then", async () => {
  const opt = await openOptions(p, "#backup");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/); // the vault is read
  const link = "otpauth://totp/Handed:me?secret=JBSWY3DPEHPK3PXP&issuer=Handed";
  await opt
    .locator("#backup-file")
    .setInputFiles({ name: "export.txt", mimeType: "text/plain", buffer: Buffer.from(link) });
  const msg = opt.locator("#backup-msg");
  await expect(msg).toBeVisible();
  await msg.getByRole("link").click();
  await expect(opt.locator("#add")).toBeVisible();
  await expect(opt.locator("#add-files .src")).toHaveCount(1);
  await expect(opt.locator("#add-files .src")).toContainText("export.txt");
  // leaving Add account drops what it read; the file is not read again on the next visit
  await showSection(opt, "backup");
  await showSection(opt, "add");
  await expect(opt.locator("#choose-file")).toBeEnabled();
  await expect(opt.locator("#add-files .src")).toHaveCount(0);
});

test("a file chosen under Backup and not followed to Add account is not left waiting for a later visit", async () => {
  const opt = await openOptions(p, "#backup");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/); // the vault is read
  const link = "otpauth://totp/Handed:me?secret=JBSWY3DPEHPK3PXP&issuer=Handed";
  await opt
    .locator("#backup-file")
    .setInputFiles({ name: "export.txt", mimeType: "text/plain", buffer: Buffer.from(link) });
  await expect(opt.locator("#backup-msg")).toBeVisible();
  await showSection(opt, "trash");
  await showSection(opt, "add");
  await expect(opt.locator("#choose-file")).toBeEnabled();
  await expect(opt.locator("#add-files .src")).toHaveCount(0);
});

test("a file handed over from Backup does not outlive a lock, nor a file still being read when it came", async () => {
  const opt = await openOptions(p, "#backup");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/); // the vault is read
  const link = "otpauth://totp/Handed:me?secret=JBSWY3DPEHPK3PXP&issuer=Handed";
  const lock = async () => {
    const pop = await openPopup(p);
    await pop.locator("#lock-now").click();
    await expect(opt.locator("#unlock-pw")).toBeVisible();
    await pop.close();
  };
  const unlock = async () => {
    await opt.locator("#unlock-pw").fill(STRONG);
    await opt.locator("#unlock-pw").press("Enter");
    await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  };
  // chosen, then a lock before the link is followed
  await opt
    .locator("#backup-file")
    .setInputFiles({ name: "export.txt", mimeType: "text/plain", buffer: Buffer.from(link) });
  await expect(opt.locator("#backup-msg a")).toBeVisible();
  await lock();
  await expect(opt.locator("#backup-msg")).toHaveCount(0); // its message, and its link, went with the lock
  await unlock();
  await showSection(opt, "add");
  await expect(opt.locator("#choose-file")).toBeEnabled();
  await expect(opt.locator("#add-files .src")).toHaveCount(0);
  // a lock while the file is being read (slow disk): it is not handed over after the unlock
  await showSection(opt, "backup");
  await opt.evaluate(() => {
    const real = Blob.prototype.text;
    Blob.prototype.text = function (this: Blob) {
      return new Promise((r) => setTimeout(() => r(real.call(this)), 1500));
    };
  });
  await opt
    .locator("#backup-file")
    .setInputFiles({ name: "race.txt", mimeType: "text/plain", buffer: Buffer.from(link) });
  await lock();
  await unlock();
  await opt.waitForTimeout(2000); // the read ends
  await expect(opt.locator("#backup-msg a")).toHaveCount(0);
  await showSection(opt, "add");
  await expect(opt.locator("#add-files .src")).toHaveCount(0);
});

test("Add account: what was pasted does not outlive the leaf", async () => {
  const opt = await openOptions(p, "#add");
  await opt.locator("#paste-box").fill("otpauth://totp/Pasted:me?secret=JBSWY3DPEHPK3PXP&issuer=Pasted");
  await expect(opt.locator("#preview")).toContainText(/1 to add|将添加 1/);
  await showSection(opt, "backup");
  await showSection(opt, "add");
  await expect(opt.locator("#paste-box")).toHaveValue("");
  await expect(opt.locator("#preview")).toHaveCount(0);
});

test("a question about deleting an imported file is kept when another leaf is shown, and drawn on it, until answered", async () => {
  const opt = await openOptions(p, "#add");
  await expect(opt.locator("#choose-file")).toBeEnabled();
  await opt
    .locator("#qr-file")
    .setInputFiles(writeTmp("export-asks.txt", "otpauth://totp/Asked:me?secret=JBSWY3DPEHPK3PXP&issuer=Asked\n"));
  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#del-ask .del-ok")).toBeVisible(); // no handle: the page says how to delete it by hand
  await showSection(opt, "backup");
  await expect(opt.locator("#del-ask .del-ok")).toBeVisible(); // still asked, wherever the person went
  await showSection(opt, "trash");
  await expect(opt.locator("#del-ask")).toBeVisible();
  await opt.locator("#del-ask .del-ok").click();
  await expect(opt.locator("#del-ask")).toHaveCount(0);
});

test("a file dropped anywhere on the page is not opened by the browser, from every leaf", async () => {
  const opt = await openOptions(p, "#trash");
  await expect(opt.locator("#trash")).toBeVisible();
  const prevented = await opt.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
    const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    document.body.dispatchEvent(over);
    return [ev.defaultPrevented, over.defaultPrevented];
  });
  expect(prevented).toEqual([true, true]);
  const text = await opt.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "just text");
    const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(text).toBe(false); // dropped text is the browser's
});

test("the password forms are closed, open in place with their own button, and what was typed does not outlive them", async () => {
  const opt = await openOptions(p, "#security-keys");
  await expect(opt.locator("#old-pw")).toHaveCount(0);
  const toggle = opt.locator("#fold-change-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveText(/Change master password|修改主密码/);
  await openFold(opt, "fold-change");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await opt.locator("#old-pw").fill(STRONG);
  await opt.locator("#change-pw").fill("A different Strong#Pass1word");
  // Escape inside it: closed, focus back on the button, nothing left when it opens again
  await opt.locator("#old-pw").press("Escape");
  await expect(opt.locator("#old-pw")).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await openFold(opt, "fold-change");
  await expect(opt.locator("#old-pw")).toHaveValue("");
  await expect(opt.locator("#change-pw")).toHaveValue("");
  // leaving the leaf drops it too
  await opt.locator("#old-pw").fill(STRONG);
  await showSection(opt, "trash");
  await showSection(opt, "security-keys");
  await expect(opt.locator("#old-pw")).toHaveCount(0);
  await openFold(opt, "fold-change");
  await expect(opt.locator("#old-pw")).toHaveValue("");
  // and the browser's Back does as well
  await opt.locator("#old-pw").fill(STRONG);
  await opt.goBack(); // to Trash, and forward again
  await opt.goForward();
  await expect(opt.locator("#security-keys")).toBeVisible();
  await openFold(opt, "fold-change");
  await expect(opt.locator("#old-pw")).toHaveValue("");
  // a hidden tab: nothing waits for whoever sits down next
  await opt.locator("#old-pw").fill(STRONG);
  await opt.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(opt.locator("#old-pw")).toHaveCount(0);
});

test("an answer of one form does not follow into another", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-code");
  await opt.locator("#code-pw").fill("Wrong#Guess9!Zebra4$Pine");
  await opt.locator("#new-code").click();
  await expect(opt.locator("#security-keys").getByRole("alert")).toContainText(/Wrong password|密码错误/);
  await openFold(opt, "fold-rotate");
  await expect(opt.getByRole("alert")).toHaveCount(0);
});

test("a lock from the popup closes an open form and empties it", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-code");
  await opt.locator("#code-pw").fill(STRONG);
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(opt.locator("#unlock-pw")).toBeVisible(); // the page shows itself locked
  await expect(opt.locator("#code-pw")).toHaveCount(0);
  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-pw").press("Enter");
  await expect(opt.locator("#fold-code-toggle")).toBeVisible();
  await expect(opt.locator("#fold-code-toggle")).toHaveAttribute("aria-expanded", "false");
  await openFold(opt, "fold-code");
  await expect(opt.locator("#code-pw")).toHaveValue("");
});

test("a vault that cannot be read opens on Backup, where the restore is, under the banner", async () => {
  await close(p); // a profile with no vault of its own, whose only slot is torn
  p = await launch();
  const seed = await openPopup(p);
  await seed.evaluate(() => chrome.storage.local.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } }));
  await seed.close();
  const opt = await openOptions(p);
  await expect(opt.getByRole("alert").first()).toContainText(/could not be read|无法读取/);
  await expect(opt.locator("#backup")).toBeVisible();
  expect(await shown(opt)).toEqual(["backup"]);
  // a hash still wins
  const adv = await openOptions(p, "#advanced");
  await expect(adv.locator("#so-go")).toBeVisible();
});

// ---- what the page holds above its leaves (F1): a recovery code that has committed is never lost ----

/** The recovery code is on screen (above the leaf), the rail holds no way to leave, and the page asks before it closes. */
async function codeIsHeld(page: Page): Promise<void> {
  await expect(page.locator("#recovery-code")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".rail nav a")).toHaveCount(0);
  await expect(page.locator("#lang-select")).toBeDisabled();
}

async function asksBeforeClosing(page: Page): Promise<void> {
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.type());
    void d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toEqual(["beforeunload"]);
  expect(page.isClosed()).toBe(false); // the person stayed: same page, same code
}

test("F1: a new recovery code is shown above whatever the person goes to, the rail is held, and closing asks first", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-code");
  await opt.locator("#code-pw").fill(STRONG);
  await opt.locator("#new-code").click();
  await codeIsHeld(opt);
  const code = (await opt.locator("#recovery-code").textContent())!.trim();
  // by the address (Back, Forward, a link in the page) to another leaf: the code is still there, the same one
  await opt.evaluate(() => (location.hash = "#trash"));
  await expect(opt.locator("#trash")).toBeVisible();
  await codeIsHeld(opt);
  expect((await opt.locator("#recovery-code").textContent())!.trim()).toBe(code);
  await opt.goBack();
  await expect(opt.locator("#security-keys")).toBeVisible();
  await codeIsHeld(opt);
  await asksBeforeClosing(opt);
  // saved: it goes, and the rail is back
  await expect(opt.locator("#recovery-done")).toBeDisabled();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await expect(opt.locator("#recovery-code")).toHaveCount(0);
  await expect(opt.locator(".rail nav a")).toHaveCount(5); // the five groups
});

test("F1: a key replaced: the code survives Back and Forward", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-rotate");
  await opt.locator("#rot-pw").fill(STRONG);
  await opt.locator("#rotate-key").click();
  await codeIsHeld(opt);
  await opt.evaluate(() => (location.hash = "#trash")); // a leaf of its own in the history
  await expect(opt.locator("#trash")).toBeVisible();
  await opt.goBack();
  await expect(opt.locator("#security-keys")).toBeVisible();
  await opt.goForward();
  await expect(opt.locator("#trash")).toBeVisible();
  await codeIsHeld(opt);
});

test("F1: a click on the rail the moment the new code is asked for still ends with the code shown (it committed)", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-code");
  await opt.locator("#code-pw").fill(STRONG);
  await opt.locator("#new-code").click();
  // the key derivation takes a moment: leave at once, the way a person who clicks twice does
  await opt.evaluate(() => (location.hash = "#trash"));
  await expect(opt.locator("#trash")).toBeVisible();
  await expect(opt.locator("#recovery-code")).toBeVisible({ timeout: 20_000 });
  await expect(opt.locator(".rail nav a")).toHaveCount(0);
});

test("F1: a device-key vault turns a master password on and leaves at once: the code is shown, and the page knows the vault changed", async () => {
  await close(p);
  p = await launch();
  await seedLegacyDeviceVault(p);
  const opt = await openOptions(p, "#security");
  await expect(opt.locator("#enable-pw")).toBeVisible();
  await expect(opt.locator(".status")).toContainText(/Device key|设备密钥|device/i);
  await opt.locator("#enable-pw").fill(STRONG);
  await opt.locator("#enable-pw2").fill(STRONG);
  await expect(opt.locator("#enable-password")).toBeEnabled();
  await opt.locator("#enable-password").click();
  await opt.evaluate(() => (location.hash = "#trash")); // leaves while the key is derived
  await expect(opt.locator("#recovery-code")).toBeVisible({ timeout: 20_000 });
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await expect(opt.locator("#recovery-code")).toHaveCount(0);
  await showSection(opt, "security");
  await expect(opt.locator("#enable-pw")).toHaveCount(0); // the page reloaded: it is no longer a device-key vault
  await showSection(opt, "security-keys");
  await expect(opt.locator("#fold-change-toggle")).toBeVisible();
});

test("the outcome of a password change that finished while the person was elsewhere is shown there", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-change");
  await opt.locator("#old-pw").fill(STRONG);
  await opt.locator("#change-pw").fill("Zk4#nW8!qR2@vL7$mT5x");
  await opt.locator("#change-pw2").fill("Zk4#nW8!qR2@vL7$mT5x");
  await opt.getByRole("button", { name: /^(Change password|修改密码)$/ }).click();
  await opt.evaluate(() => (location.hash = "#trash"));
  await expect(opt.locator("#trash")).toBeVisible();
  await expect(opt.getByText(/^(Password changed|密码已修改)$/)).toBeVisible({ timeout: 20_000 });
});

test("a file picked while the vault is still being read is handed over (Sixkey is unlocked), and never called not a backup", async () => {
  const { page, release } = await openHeld("#backup");
  await pick(page, "early.txt");
  await expect(page.locator("#backup-msg a")).toBeVisible();
  await expect(page.locator("#backup-error")).toHaveCount(0);
  await release();
  await expect(page.locator(".status dd.num")).toHaveText(/^\d+$/);
  await page.locator("#backup-msg a").click();
  await expect(page.locator("#add-files .src")).toContainText("early.txt");
});

test("N11: a file handed over while the vault was being read goes with a lock, and nothing chosen before reaches Add account", async () => {
  const { page, release, done } = await openHeld("#backup");
  await pick(page, "before-lock.txt");
  await expect(page.locator("#backup-msg a")).toBeVisible();
  await lockFromPopup(page); // the vault has still not been read
  await expect(page.locator("#backup-msg")).toHaveCount(0); // the message, and its link, went with the lock
  // the read that was under way ends after the lock: a locked page does not show the vault it read
  await release();
  await expect.poll(done).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(page.locator(".status dd.num")).toHaveText("—");
  await unlockHere(page);
  await expect(page.locator(".status dd.num")).toHaveText(/^\d+$/);
  await expect(page.locator("#backup-msg")).toHaveCount(0);
  await showSection(page, "add");
  await expect(page.locator("#choose-file")).toBeEnabled();
  await expect(page.locator("#add-files .src")).toHaveCount(0);
});

test("Backup says why a file is not handed over: locked when it was chosen, or locked while it was read", async () => {
  const opt = await openOptions(p, "#backup");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/);
  // chosen on a locked page
  await lockFromPopup(opt);
  await pick(opt, "locked.txt");
  await expect(opt.locator("#backup-error")).toContainText(/^(Unlock to manage this\.|解锁后才能管理。)$/);
  await expect(opt.locator("#backup-msg")).toHaveCount(0);
  await unlockHere(opt);
  // a lock while the file is read, still locked when the read ends; then a lock and an unlock while it is read
  await opt.evaluate(() => {
    const real = Blob.prototype.text;
    Blob.prototype.text = function (this: Blob) {
      return new Promise((r) => setTimeout(() => r(real.call(this)), 4000));
    };
  });
  const meanwhile = /locked while the file was being read|读取文件时 Sixkey 已锁定/;
  await pick(opt, "slow-1.txt");
  await lockFromPopup(opt);
  await expect(opt.locator("#backup-error")).toContainText(meanwhile, { timeout: 10_000 });
  await unlockHere(opt);
  await pick(opt, "slow-2.txt");
  await lockFromPopup(opt);
  await unlockHere(opt);
  await expect(opt.locator("#backup-error")).toContainText(meanwhile, { timeout: 10_000 }); // not "unlock" on an unlocked page
  await expect(opt.locator("#backup-msg")).toHaveCount(0);
  await showSection(opt, "add");
  await expect(opt.locator("#add-files .src")).toHaveCount(0);
});

test("a refusal from the password form that came while the person went to Locking is shown there, and back on its own leaf", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-change");
  await opt.locator("#old-pw").fill("Wrong#Guess9!Zebra4$Pine");
  await opt.locator("#change-pw").fill("Zk4#nW8!qR2@vL7$mT5x");
  await opt.locator("#change-pw2").fill("Zk4#nW8!qR2@vL7$mT5x");
  await opt.getByRole("button", { name: /^(Change password|修改密码)$/ }).click();
  await showSection(opt, "security"); // at once, before the answer
  await expect(opt.getByRole("alert")).toContainText(/Wrong password|密码错误/, { timeout: 20_000 });
  await showSection(opt, "security-keys");
  await expect(opt.locator("#security-keys").getByRole("alert")).toContainText(/Wrong password|密码错误/);
  // a next attempt (a fold opening) clears it
  await openFold(opt, "fold-code");
  await expect(opt.getByRole("alert")).toHaveCount(0);
});

test("a key operation under way asks before the page closes, and its code is still shown after the person stayed", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-code");
  await opt.locator("#code-pw").fill(STRONG);
  // the e2e build derives keys in a few milliseconds; a slow write makes the window the real one has (a second or more)
  await opt.evaluate(() => {
    const area = chrome.storage.local;
    const real = area.set.bind(area) as (items: unknown) => Promise<void>;
    Object.defineProperty(area, "set", {
      configurable: true,
      value: (items: unknown) => new Promise((r) => setTimeout(r, 1500)).then(() => real(items)),
    });
  });
  await opt.locator("#new-code").click();
  await expect(opt.locator("#new-code")).toBeDisabled(); // the operation is under way
  await expect(opt.locator("#recovery-code")).toHaveCount(0); // and no code yet
  // the page has taken the hold (a frame after the click)
  await expect
    .poll(() =>
      opt.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        dispatchEvent(e);
        return e.defaultPrevented;
      }),
    )
    .toBe(true);
  await asksBeforeClosing(opt);
  await expect(opt.locator("#recovery-code")).toBeVisible({ timeout: 20_000 });
});

test("a recovery code stays on screen while the page locks (above the unlock bar); Continue works locked", async () => {
  const opt = await openOptions(p, "#security-keys");
  await openFold(opt, "fold-code");
  await opt.locator("#code-pw").fill(STRONG);
  await opt.locator("#new-code").click();
  await expect(opt.locator("#recovery-code")).toBeVisible({ timeout: 20_000 });
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(opt.locator("#unlock-pw")).toBeVisible();
  await expect(opt.locator("#recovery-code")).toBeVisible(); // not lost to a lock: it was never saved
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await expect(opt.locator("#recovery-code")).toHaveCount(0);
});

test("#clipboard (Locking's 'Clear clipboard' link, or typed) brings the Clipboard panel into view, in a window of 900 px", async () => {
  const opt = await openOptions(p, "#security");
  await opt.setViewportSize({ width: 1400, height: 900 });
  await expect(opt.locator("#security")).toBeVisible();
  await opt.locator("#sm-clip").click();
  await expect(opt.locator("#clipboard")).toBeInViewport();
  await expect(opt.locator("#clipboard h2")).toBeFocused();
  // the person's own key (or wheel, or touch) ends the page's scrolling: it is not pulled back to the panel
  await opt.keyboard.press("Home");
  await opt.waitForTimeout(1200);
  expect(await opt.evaluate(() => scrollY)).toBeLessThan(50);
  // opened at #clipboard: the panel in view, the focus not taken on the first drawing (the unlock, reset and wizard
  // fields keep it when they are there)
  const typed = await openOptions(p, "#clipboard");
  await typed.setViewportSize({ width: 1400, height: 900 });
  await expect(typed.locator("#clipboard")).toBeInViewport();
  await expect(typed.locator("#clipboard h2")).not.toBeFocused();
  await opt.evaluate(() => (location.hash = "#appearance"));
  await opt.evaluate(() => scrollTo(0, 0));
  await opt.evaluate(() => (location.hash = "#clipboard")); // within the leaf already
  await expect(opt.locator("#clipboard")).toBeInViewport();
});

test("a locked page opened at #clipboard stays at its top, where the unlock bar is", async () => {
  const first = await openOptions(p, "#security");
  await lockFromPopup(first);
  const page = await openOptions(p, "#clipboard");
  await page.setViewportSize({ width: 420, height: 700 });
  await expect(page.locator("#unlock-pw")).toBeVisible();
  await page.waitForTimeout(1200); // past the page's repeated scroll
  await expect(page.locator("#unlock-pw")).toBeInViewport();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.close();
});

test("N12: at 320 px a refusal of the password form is brought into view", async () => {
  const opt = await openOptions(p, "#security-keys");
  await opt.setViewportSize({ width: 320, height: 700 });
  await openFold(opt, "fold-change");
  await opt.locator("#old-pw").fill("Wrong#Guess9!Zebra4$Pine");
  await opt.locator("#change-pw").fill("Zk4#nW8!qR2@vL7$mT5x");
  await opt.locator("#change-pw2").fill("Zk4#nW8!qR2@vL7$mT5x");
  await opt.getByRole("button", { name: /^(Change password|修改密码)$/ }).click();
  const refusal = opt.locator("#security-keys").getByRole("alert");
  await expect(refusal).toContainText(/Wrong password|密码错误/, { timeout: 20_000 });
  await expect(refusal).toBeInViewport();
});

test("a device-key vault's refusal on Locking is said once, in the box that turns the master password on", async () => {
  await close(p);
  p = await launch();
  await seedLegacyDeviceVault(p);
  const opt = await openOptions(p, "#security");
  await expect(opt.locator("#enable-pw")).toBeVisible();
  await opt.locator("#enable-pw").fill(STRONG);
  await opt.locator("#enable-pw2").fill(STRONG);
  await expect(opt.locator("#enable-password")).toBeEnabled();
  // the vault's write fails: nothing is changed, and the page says so
  await opt.evaluate(() => {
    const area = chrome.storage.local;
    const real = area.set.bind(area) as (items: Record<string, unknown>) => Promise<void>;
    Object.defineProperty(area, "set", {
      configurable: true,
      value: (items: Record<string, unknown>) =>
        Object.keys(items).some((k) => k.startsWith("sk_slot") || k === "sk_keyring")
          ? Promise.reject(new Error("disk full"))
          : real(items),
    });
  });
  await opt.locator("#enable-password").click();
  await expect(opt.getByRole("alert")).toHaveCount(1, { timeout: 20_000 });
  await expect(opt.locator("#recovery-code")).toHaveCount(0);
});
