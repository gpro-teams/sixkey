// Settings > Add account (IMPORT-FILE-NOTES.md): a file chosen (the owner's shape: one otpauth:// link per line),
// other apps' exports, an encrypted export and a Sixkey backup, the Backup section handing an export over, the delete
// prompt (without a handle: the instructions; with one: Delete file through a real handle, refused, or the file
// changed), and the camera with Chromium's fake device playing QR codes, one link and a three-code Google export.
import { expect, test, type Page } from "@playwright/test";
import { close, launch, openOptions, openPopup, type Profile, showSection, startFresh, writeTmp } from "./harness";
import {
  closeWith,
  FAKE_CAMERA,
  launchWith,
  opfsHas,
  opfsTouch,
  qrVideo,
  recordTracks,
  stubPicker,
  trackStates,
} from "./import-helpers";
import {
  AEGIS_ENCRYPTED,
  aegisEntry,
  aegisPlain,
  K1,
  K2,
  link,
  migration,
  SAMPLE_LIST,
} from "../helpers/import-fixtures";

const SAMPLE_NAME = "authenticator-uris-2026-10-20.txt";

async function rows(p: Profile): Promise<number> {
  const pop = await openPopup(p);
  await expect(pop.locator("#q")).toBeVisible();
  const n = await pop.locator(".row").count();
  await pop.close();
  return n;
}
/** Settings at #add (or `hash`), once the vault is read: before that the page takes no file. */
async function addPage(p: Profile, hash = "#add"): Promise<Page> {
  const opt = await openOptions(p, hash);
  await expect(opt.locator("#choose-file")).toBeEnabled();
  return opt;
}
const noSecretsOnScreen = async (page: Page, secrets: string[]) => {
  const text = await page.locator("#add").innerText();
  for (const s of secrets) expect(text).not.toContain(s);
};

test.describe("files", () => {
  let p: Profile;
  test.beforeEach(async () => {
    p = await launch();
    await startFresh(p);
  });
  test.afterEach(async () => {
    await close(p);
  });

  test("the owner's file: ten links, shown by name, added, then the delete prompt without a handle says how", async () => {
    const opt = await addPage(p);
    await expect(opt.locator("#add-hint")).toBeVisible(); // "Add" with nothing to add says what to do
    await opt.locator("#qr-file").setInputFiles(writeTmp(SAMPLE_NAME, SAMPLE_LIST));
    await expect(opt.locator("#add-files .src b")).toHaveText(SAMPLE_NAME);
    await expect(opt.locator("#preview")).toContainText(/10 to add|将添加 10/);
    await expect(opt.locator("#paste-box")).toHaveValue(""); // the file's keys are not put on screen
    await noSecretsOnScreen(
      opt,
      SAMPLE_LIST.match(/secret=([A-Z2-7]+)/g)!.map((s) => s.slice(7)),
    );
    await opt.locator("#add-confirm").click();
    await expect(opt.locator("#add-done")).toContainText(/10/);
    await expect(opt.locator("#add-files")).toHaveCount(0); // what was read is gone

    const ask = opt.locator("#del-ask");
    await expect(ask).toContainText(SAMPLE_NAME);
    await expect(ask).toContainText(/Trash or Recycle Bin|废纸篓或回收站/);
    await expect(ask).not.toContainText(/Delete it now|现在删除/); // no handle: no question it offers no answer to
    await expect(ask.locator(".del-yes")).toHaveCount(0); // no handle: nothing Sixkey could delete
    await ask.locator(".del-ok").click();
    await expect(ask).toHaveCount(0);
    expect(await rows(p)).toBe(10);

    // the same file again: everything is a duplicate, nothing to add, and no prompt after nothing was added
    await opt.locator("#qr-file").setInputFiles(writeTmp(SAMPLE_NAME, SAMPLE_LIST));
    await expect(opt.locator("#preview")).toContainText(/0 to add|将添加 0/);
    await expect(opt.locator("#pv-dup")).toContainText("10");
    await expect(opt.locator("#add-confirm")).toBeDisabled();
    await opt.locator("#add-cancel").click();
    await expect(opt.locator("#add-files")).toHaveCount(0);
    await expect(opt.locator("#del-ask")).toHaveCount(0);
  });

  test("other exports: Aegis read, Steam counted; an encrypted export and a Sixkey backup are explained", async () => {
    const opt = await addPage(p);
    const aegis = aegisPlain([
      aegisEntry({ name: "alice", issuer: "GitHub", secret: K1 }),
      aegisEntry({ type: "steam", name: "me", issuer: "Steam", secret: K2, info: { digits: 5 } }),
    ]);
    await opt
      .locator("#qr-file")
      .setInputFiles([
        writeTmp("aegis-export.json", aegis),
        writeTmp("aegis-encrypted.json", AEGIS_ENCRYPTED),
        writeTmp("sixkey-backup.json", JSON.stringify({ format: "sixkey-backup", v: 1, created: 1, ciphertext: "x" })),
      ]);
    await expect(opt.locator("#add-files .src")).toHaveCount(3);
    await expect(opt.locator("#add-files")).toContainText(/Steam/);
    await expect(opt.locator("#add-files")).toContainText(/encrypted Aegis|加密的 Aegis/);
    await expect(opt.locator("#add-files a[href='#backup']")).toBeVisible();
    await expect(opt.locator("#preview")).toContainText(/1 to add|将添加 1/);
    await opt.locator("#add-confirm").click();
    await expect(opt.locator("#add-done")).toBeVisible();
    // only the file that added an account is offered for deletion, and it says its Steam account was not imported
    await expect(opt.locator("#del-ask .del-row")).toHaveCount(1);
    await expect(opt.locator("#del-ask")).toContainText("aegis-export.json");
    await expect(opt.locator("#del-ask .del-left")).toContainText(/not imported: 1|未导入的账户：1/);
  });

  test("Backup hands another app's export over to Add account", async () => {
    const opt = await openOptions(p, "#backup");
    await expect(opt.locator("#backup-file")).toBeAttached();
    await opt
      .locator("#backup-file")
      .setInputFiles(writeTmp("aegis.json", aegisPlain([aegisEntry({ name: "a", issuer: "Hand", secret: K1 })])));
    // the file waits for Add account, which is another section: the message links to it
    await expect(opt.locator("#backup-msg")).toBeVisible();
    await opt.locator("#backup-msg a").click();
    await expect(opt.locator("#choose-file")).toBeEnabled();
    await expect(opt.locator("#add-files .src b")).toHaveText("aegis.json");
    await expect(opt.locator("#preview")).toContainText(/1 to add|将添加 1/);
    // any other file goes there too, and Add account says what it is
    await showSection(opt, "backup");
    await opt.locator("#backup-file").setInputFiles(writeTmp("notes.txt", "just some notes"));
    await expect(opt.locator("#backup-error")).toHaveCount(0);
    await opt.locator("#backup-msg a").click();
    await expect(opt.locator("#add-files .src", { hasText: "notes.txt" })).toContainText(
      /No accounts found|没有找到账户/,
    );
  });

  test("Delete file through a real handle: deleted; refused; changed after it was read", async () => {
    const opt = await addPage(p);
    const text = `${link("Opfs", "a", K1)}\n`;
    // granted (a real handle of the extension's private file system): the file is gone
    await stubPicker(opt, "export-1.txt", text);
    await opt.locator("#choose-file").click();
    await expect(opt.locator("#preview")).toContainText(/1 to add|将添加 1/);
    await opt.locator("#add-confirm").click();
    await opt.locator("#del-ask .del-yes").click();
    await expect(opt.locator("#del-ask .del-row")).toHaveAttribute("data-state", "deleted");
    expect(await opfsHas(opt, "export-1.txt")).toBe(false);
    await opt.locator("#del-ask .del-ok").click();

    // the user does not allow it: the file stays, and the page says how to delete it by hand
    await stubPicker(opt, "export-2.txt", `${link("Opfs", "b", K2)}\n`, "denied");
    await opt.locator("#choose-file").click();
    await opt.locator("#add-confirm").click();
    await opt.locator("#del-ask .del-yes").click();
    await expect(opt.locator("#del-ask .del-row")).toHaveAttribute("data-state", "denied");
    await expect(opt.locator("#del-ask")).toContainText(/Trash|废纸篓/);
    expect(await opfsHas(opt, "export-2.txt")).toBe(true);
    await opt.locator("#del-ask .del-ok").click();

    // Keep it: nothing happens to the file
    await stubPicker(opt, "export-3.txt", `${link("Opfs", "c", "MFRGGZDFMZTWQ2LKMFRGGZDF")}\n`);
    await opt.locator("#choose-file").click();
    await opt.locator("#add-confirm").click();
    await opt.locator("#del-ask .del-keep").click();
    await expect(opt.locator("#del-ask")).toHaveCount(0);
    expect(await opfsHas(opt, "export-3.txt")).toBe(true);

    // the file changed after Sixkey read it: not deleted
    await stubPicker(opt, "export-4.txt", `${link("Opfs", "d", "NBSWY3DPO5XXE3DENBSWY3DP")}\n`);
    await opt.locator("#choose-file").click();
    await opt.locator("#add-confirm").click();
    await opfsTouch(opt, "export-4.txt", "something else, written later\n");
    await opt.locator("#del-ask .del-yes").click();
    await expect(opt.locator("#del-ask .del-row")).toHaveAttribute("data-state", "changed");
    expect(await opfsHas(opt, "export-4.txt")).toBe(true);
    expect(await rows(p)).toBe(4);
  });

  test("two links on one line are both read; a word run into a secret is refused, in a file and in the paste box", async () => {
    const opt = await addPage(p);
    const two = `${link("One", "a", K1)},${link("Two", "b", K2)}\n`;
    const runOn = `otpauth://totp/RunOn?secret=${K1.replace(/[A-Z]/, "B")} work\n`;
    await opt.locator("#qr-file").setInputFiles([writeTmp("two.txt", two), writeTmp("run-on.txt", runOn)]);
    await expect(opt.locator("#preview")).toContainText(/2 to add|将添加 2/);
    await expect(opt.locator("#add-files .src", { hasText: "run-on.txt" })).toContainText(/not valid|无效|不正确/);
    await opt.locator("#add-cancel").click();
    await opt.locator("#paste-box").fill(runOn.trim());
    await expect(opt.locator("#preview")).toContainText(/0 to add|将添加 0/);
    await expect(opt.locator("#preview")).toContainText(/not valid|无效|不正确/);
  });

  test("a picker that fails falls back to the file input: Choose file never does nothing twice", async () => {
    const opt = await addPage(p);
    await opt.evaluate(() => {
      (window as unknown as { showOpenFilePicker: () => Promise<never> }).showOpenFilePicker = () =>
        Promise.reject(new DOMException("not here", "SecurityError"));
    });
    const first = opt.waitForEvent("filechooser", { timeout: 2000 }).catch(() => null);
    await opt.locator("#choose-file").click();
    let chooser = await first;
    if (!chooser) {
      // the input opened after the failed picker was refused (no user activation left): the next click opens it at once
      const second = opt.waitForEvent("filechooser");
      await opt.locator("#choose-file").click();
      chooser = await second;
    }
    await chooser.setFiles(writeTmp(SAMPLE_NAME, SAMPLE_LIST));
    await expect(opt.locator("#preview")).toContainText(/10 to add|将添加 10/);
  });

  test("a lock drops what was read: the file's accounts and the paste box", async () => {
    const opt = await addPage(p);
    await opt.locator("#qr-file").setInputFiles(writeTmp(SAMPLE_NAME, SAMPLE_LIST));
    await opt.locator("#paste-box").fill(link("Typed", "x", K1));
    await expect(opt.locator("#preview")).toContainText(/11 to add|将添加 11/);
    const pop = await openPopup(p);
    await pop.locator("#lock-now").click();
    await expect(opt.locator("#add .callout")).toBeVisible();
    await expect(opt.locator("#add-files")).toHaveCount(0);
    await expect(opt.locator("#paste-box")).toHaveValue("");
    await expect(opt.locator("#paste-box")).toBeDisabled(); // nothing is pasted into a locked page
    await expect(opt.locator("#choose-file")).toBeDisabled();
  });

  test("two files with handles: nothing is deleted before a click, and a click deletes its own row's file only", async () => {
    const opt = await addPage(p);
    await stubPicker(opt, [
      { name: "first.txt", text: `${link("One", "a", K1)}\n` },
      { name: "second.txt", text: `${link("Two", "b", K2)}\notpauth://steam/S:me?secret=${K2}\n` },
    ]);
    await opt.locator("#choose-file").click();
    await expect(opt.locator("#add-files .src")).toHaveCount(2);
    await opt.locator("#add-confirm").click();
    await expect(opt.locator("#del-ask .del-row")).toHaveCount(2);
    expect([await opfsHas(opt, "first.txt"), await opfsHas(opt, "second.txt")]).toEqual([true, true]);
    const second = opt.locator("#del-ask .del-row", { hasText: "second.txt" });
    // its Steam account was not imported: it says so, and Keep it comes first
    await expect(second.locator(".del-left")).toBeVisible();
    await expect(second.locator(".row2 button").first()).toHaveClass(/del-keep/);
    await second.locator(".del-yes").click();
    await expect(second).toHaveAttribute("data-state", "deleted");
    expect([await opfsHas(opt, "first.txt"), await opfsHas(opt, "second.txt")]).toEqual([true, false]);
    const first = opt.locator("#del-ask .del-row", { hasText: "first.txt" });
    await expect(first).toHaveAttribute("data-state", "ask");
    await expect(first.locator(".row2 button").first()).toHaveClass(/del-yes/);
  });
});

test.describe("camera", () => {
  test("a link held up to the camera: read, the camera stops, the account is added", async () => {
    const video = writeTmp("one.y4m", qrVideo([link("Camera", "cam@example.com", K1)]));
    const p = await launchWith([...FAKE_CAMERA, `--use-file-for-fake-video-capture=${video}`]);
    try {
      await recordTracks(p);
      await startFresh(p);
      const opt = await addPage(p);
      await opt.bringToFront();
      await opt.locator("#cam-start").click();
      await expect(opt.locator("#preview")).toContainText(/1 to add|将添加 1/, { timeout: 20_000 });
      await expect(opt.locator("#cam-live")).toHaveCount(0); // stopped once read
      await expect.poll(() => trackStates(opt)).toEqual(["ended"]);
      await expect(opt.locator("#add-scanned-row")).toBeVisible(); // a row of its own:
      await expect(opt.locator("#paste-box")).toHaveValue(""); // the code is never written out on screen
      expect(await opt.evaluate(() => document.querySelector("video")?.srcObject ?? null)).toBeNull();
      await opt.locator("#add-confirm").click();
      await expect(opt.locator("#add-done")).toBeVisible();
      await expect(opt.locator("#del-ask")).toHaveCount(0); // no file: nothing to delete
    } finally {
      await closeWith(p);
    }
  });

  test("a Steam code held up to the camera is checked as a file's would be: counted, never a 6-digit TOTP", async () => {
    const steam = `otpauth://totp/Steam:bob?secret=${K1}&issuer=Steam&encoder=steam`;
    const video = writeTmp("steam.y4m", qrVideo([steam]));
    const p = await launchWith([...FAKE_CAMERA, `--use-file-for-fake-video-capture=${video}`]);
    try {
      await startFresh(p);
      const opt = await addPage(p);
      await opt.bringToFront();
      await opt.locator("#cam-start").click();
      await expect(opt.locator("#add-scanned-row")).toContainText(/Steam/, { timeout: 20_000 });
      await expect(opt.locator("#cam-live")).toHaveCount(0);
      await expect(opt.locator("#add-confirm")).toBeDisabled();
      await expect(opt.locator("#preview")).toHaveCount(0);
    } finally {
      await closeWith(p);
    }
  });

  test("a Google Authenticator export of three codes: collected across reads until every code is in", async () => {
    const codes = [0, 1, 2].map((index) =>
      migration([{ seed: index + 1, name: `Acct${index}:user${index}`, issuer: `Acct${index}` }], {
        size: 3,
        index,
        id: 4242,
      }),
    );
    const video = writeTmp("three.y4m", qrVideo(codes, { frames: 12 }));
    const p = await launchWith([...FAKE_CAMERA, `--use-file-for-fake-video-capture=${video}`]);
    try {
      await startFresh(p);
      const opt = await addPage(p);
      await opt.bringToFront();
      await opt.locator("#cam-start").click();
      await expect(opt.locator("#cam-live")).toContainText(/of 3|\/ 3/, { timeout: 20_000 });
      await expect(opt.locator("#cam-live")).toHaveCount(0, { timeout: 30_000 }); // stops when the third is in
      await expect(opt.locator("#preview")).toContainText(/3 to add|将添加 3/);
      await expect(opt.locator("#preview")).not.toContainText(/Still needed|还缺/);
      await expect(opt.locator("#add-scanned-row")).toContainText("3");
      await expect(opt.locator("#paste-box")).toHaveValue("");
    } finally {
      await closeWith(p);
    }
  });

  test("Sixkey locked while the camera is on: the page shows it locked and every camera track stops", async () => {
    const p = await launchWith(FAKE_CAMERA); // the fake device's moving test picture: no code in it, so the camera stays on
    try {
      await recordTracks(p);
      await startFresh(p);
      const opt = await addPage(p);
      await opt.bringToFront();
      await opt.locator("#cam-start").click();
      await expect(opt.locator("#cam-live video.on")).toBeVisible();
      expect(await trackStates(opt)).toEqual(["live"]);
      // a lock as every lock looks to a page: the unlocked key gone from session storage, and the lock epoch moved
      await opt.evaluate(async () => {
        await chrome.storage.session.remove("sk_session");
        await chrome.storage.session.set({ sk_lock_epoch: Date.now() });
      });
      await expect(opt.locator("#add .callout")).toBeVisible();
      await expect(opt.locator("#cam-live")).toHaveCount(0);
      await expect.poll(() => trackStates(opt)).toEqual(["ended"]);
      await expect(opt.locator("#cam-start")).toBeDisabled();
    } finally {
      await closeWith(p);
    }
  });

  test("the camera refused or missing: said in words, with a way to choose a screenshot instead", async () => {
    const p = await launchWith(FAKE_CAMERA);
    try {
      await startFresh(p);
      const opt = await addPage(p);
      for (const [name, re] of [
        ["NotAllowedError", /is not allowed to use the camera|没有使用摄像头的权限/],
        ["NotFoundError", /could not be started|无法启动摄像头/],
        ["NotReadableError", /could not be started|无法启动摄像头/],
      ] as const) {
        await opt.evaluate((n) => {
          navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("x", n));
        }, name);
        await opt.locator("#cam-start").click();
        await expect(opt.locator("#cam-error")).toContainText(re);
        await expect(opt.locator("#cam-file")).toBeVisible();
      }
    } finally {
      await closeWith(p);
    }
  });
});
