// A browser restart with the extension's IndexedDB gone (SYNC-DESIGN §2.5 identity_missing, §4.14; what some
// fingerprint browsers do at every stop), against the real API server: locked, the worker's rounds stop at
// identity_missing, sign and send nothing, and keep the stored server clock offset; after the unlock the identity comes
// back from its encrypted copy, with the same device ID (no new device, no enrolment), and the offset is learned again.
import { expect, test } from "@playwright/test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addByPaste, close, GITHUB_URI, launch, openPopup, startFresh, STRONG } from "../e2e/harness";
import { dev, openDevSync, signIn } from "../e2e/sync-helpers";
import { startSyncBackend, storagePage, syncState, type SyncBackend } from "./sync-e2e";

let b: SyncBackend;
test.beforeAll(async () => {
  b = await startSyncBackend();
});
test.afterAll(async () => {
  await b?.stop();
});

test("identity_missing after a browser restart: nothing sent while locked, the offset kept; restored with the same device ID once unlocked", async () => {
  const email = `restart-${Date.now().toString(36)}@example.com`;
  let p = await launch();
  const dir = p.dir;
  try {
    const { recoveryCode } = await startFresh(p);
    await addByPaste(p, GITHUB_URI);
    const d = await openDevSync(p);
    await signIn(d, email, (e) => b.server.inbox(e));
    expect(await dev(d, "firstUpload", { password: STRONG, recoveryCode, deviceName: "Restarted", email })).toBe(
      "done",
    );
    expect((await dev(d, "round")).status).toBe("ok");
    const device = b.api.wire.filter((w) => w.device).at(-1)!.device;
    // an offset learned earlier, recognisable (the real server's clock is this machine's)
    await d.evaluate(async () => {
      const s = (await chrome.storage.local.get("sk_sync_state")).sk_sync_state as Record<string, unknown>;
      await chrome.storage.local.set({ sk_sync_state: { ...s, serverOffsetMs: 90_000 } });
    });
    await d.close();
    const id = p.id;
    await close(p, false);
    for (const n of readdirSync(join(dir, "Default", "IndexedDB")))
      if (n.startsWith(`chrome-extension_${id}_0.indexeddb`))
        rmSync(join(dir, "Default", "IndexedDB", n), { recursive: true, force: true });

    p = await launch(dir); // locked: the browser restarted, storage.session is empty
    const n0 = b.api.wire.length;
    const s = await storagePage(p);
    await s.evaluate(() => chrome.runtime.sendMessage({ type: "sk-sync-soon" })); // as a page's commit would: a round 3 s later
    await expect.poll(async () => (await syncState(s))?.status, { timeout: 30_000 }).toBe("identity_missing");
    await new Promise((r) => setTimeout(r, 1000));
    expect(b.api.wire.length).toBe(n0); // nothing signed, nothing sent
    expect((await syncState(s))?.serverOffsetMs).toBe(90_000);

    // unlock in the popup: the page that shows the vault asks the worker for a round (the last success is over 30 s
    // old by then, §4.8), which restores the identity
    const lastOk = Number((await syncState(s))?.lastOkAt ?? 0);
    await new Promise((r) => setTimeout(r, Math.max(0, lastOk + 31_000 - Date.now())));
    const pop = await openPopup(p);
    await pop.locator("#secret").fill(STRONG);
    await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect(pop.locator("#q")).toBeVisible();
    await expect.poll(async () => (await syncState(s))?.status, { timeout: 30_000 }).toBe("ok");
    const after = b.api.wire.slice(n0);
    expect(after.length).toBeGreaterThan(0);
    expect(new Set(after.map((w) => w.device))).toEqual(new Set([device]));
    expect(after.filter((w) => w.target.startsWith("/v1/enroll"))).toEqual([]);
    expect(Math.abs(Number((await syncState(s))?.serverOffsetMs))).toBeLessThan(5_000);
    await pop.close();
    await s.close();
  } finally {
    await close(p);
  }
});
