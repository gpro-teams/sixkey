// A sustained outage of the real API server (its database stopped: every request is answered 503 with Retry-After 5)
// seen by the service worker (SYNC-DESIGN §4.8): every failure counts and the next try waits longer, nothing is sent
// before the stored end of the backoff, not even after the browser restarts (the state is in storage, the timers are
// not), and once the server is back the waiting edits go up.
import { expect, test } from "@playwright/test";
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

const state = async (page: import("@playwright/test").Page) =>
  (await syncState(page)) as
    { status?: string; failures?: number; backoffUntil?: number | null; lastErrorCode?: string | null } | undefined;

test("503 with Retry-After from the real server: the backoff grows, holds across a browser restart, and ends when the server is back", async () => {
  test.setTimeout(240_000);
  const email = `outage-${Date.now().toString(36)}@example.com`;
  let p = await launch();
  const dir = p.dir;
  try {
    const { recoveryCode } = await startFresh(p);
    await addByPaste(p, GITHUB_URI);
    const d = await openDevSync(p);
    await signIn(d, email, (e) => b.server.inbox(e));
    expect(await dev(d, "firstUpload", { password: STRONG, recoveryCode, deviceName: "Outage", email })).toBe("done");
    expect((await dev(d, "round")).status).toBe("ok");
    await d.close();

    b.server.stopDatabase();
    // an edit: its "sync soon" round fails with the server's 503
    await addByPaste(p, "otpauth://totp/One:x?secret=JBSWY3DPEHPK3PXA&issuer=One");
    const s = await storagePage(p);
    await expect.poll(async () => (await state(s))?.failures, { timeout: 30_000 }).toBe(1);
    const first = (await state(s))!;
    expect(first.lastErrorCode).toBe("unavailable");
    const gap1 = first.backoffUntil! - Date.now();
    expect(gap1).toBeGreaterThan(4_000); // at least Retry-After
    // another edit inside the backoff asks for a round too: none is sent before the backoff ends
    const n0 = b.api.wire.length;
    await addByPaste(p, "otpauth://totp/Two:x?secret=JBSWY3DPEHPK3PXB&issuer=Two");
    await new Promise((r) => setTimeout(r, Math.min(3_500, Math.max(0, first.backoffUntil! - Date.now() - 1_000))));
    expect(b.api.wire.length).toBe(n0);

    // the browser restarts inside the backoff: the new worker waits for the stored end, then tries (locked now: the
    // status query) and fails again, with a longer gap
    await s.close();
    await close(p, false);
    p = await launch(dir);
    const s2 = await storagePage(p);
    const restartedAt = Date.now();
    expect(b.api.wire.length).toBe(n0);
    await expect.poll(async () => (await state(s2))?.failures, { timeout: 60_000 }).toBe(2);
    expect(b.api.wire.slice(n0).every((w) => w.at >= first.backoffUntil! - 1_000)).toBe(true); // never before the stored end
    expect(b.api.wire.length - n0).toBe(1); // one status query: no retry inside the transport
    const second = (await state(s2))!;
    const gap2 = second.backoffUntil! - Math.max(restartedAt, first.backoffUntil!);
    expect(gap2).toBeGreaterThan(gap1);

    // the server is back: the next try succeeds and clears the backoff; unlocked, the edits go up
    b.server.startDatabase();
    await expect.poll(async () => (await state(s2))?.failures, { timeout: 90_000 }).toBe(0);
    expect((await state(s2))?.backoffUntil ?? null).toBeNull();
    const pop = await openPopup(p);
    await pop.locator("#secret").fill(STRONG);
    await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect(pop.locator(".row")).toHaveCount(3);
    await pop.close();
    const d2 = await openDevSync(p);
    // the popup showing the unlocked vault has asked the worker for a round (§4.8), which may still hold the sync lock:
    // this page's round then answers "busy" (the other context is syncing), and the next one runs
    await expect.poll(async () => (await dev(d2, "round")).status, { timeout: 30_000 }).toBe("ok");
    const puts = b.api.wire.filter((w) => w.method === "PUT" && w.target === "/v1/vault");
    expect(puts.length).toBeGreaterThan(0);
    await d2.close();
    await s2.close();
  } finally {
    b.server.startDatabase();
    await close(p);
  }
});
