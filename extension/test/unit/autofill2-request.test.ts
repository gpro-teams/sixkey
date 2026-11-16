// AUTOFILL2 patch 1: the pending fill request R (src/platform/fill-request.ts) and the shortcut's part in it
// (src/background/sw.ts, fill-command.ts). R's exact shape; the take, a compare-and-delete that checks the nonce shown, the
// age (60 s), the lock epoch and that R's tab is the tab in front of the SURFACE'S OWN window at R's address; one use; R is
// written only for the outcomes the surface finishes, and before the popup is opened.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILL_REQ_KEY,
  forHere,
  peekRequest,
  putRequest,
  readRequest,
  REQ_MS,
  takeRequest,
  type FillReq,
  type Here,
} from "../../src/platform/fill-request";
import { needsRequest, type Outcome } from "../../src/background/fill-command";
import { NOT_OFF, TEST_CODE } from "../helpers/gate";

/** The tab in front of a focused window: what platform/autofill.ts inFront asks before every fill (AUTOFILL2 patch 3). */
const frontTab = async (id: number) => ({ id, active: true, windowId: 1 });
const frontWindows = { get: async () => ({ focused: true }) };

/** chrome.storage.session as far as R needs it, with a log of writes and removals. */
function sessionArea() {
  const data = new Map<string, unknown>();
  const log: string[] = [];
  return {
    data,
    log,
    async get(k: string) {
      return data.has(k) ? { [k]: structuredClone(data.get(k)) } : {};
    },
    async set(o: Record<string, unknown>) {
      for (const [k, v] of Object.entries(o)) (data.set(k, structuredClone(v)), log.push(`set ${k}`));
    },
    async remove(k: string) {
      data.delete(k);
      log.push(`remove ${k}`);
    },
  } as unknown as chrome.storage.StorageArea & { data: Map<string, unknown>; log: string[] };
}
const T0 = 1_800_000_000_000;
const URL1 = "https://github.com/sessions/two-factor";
/** Here: a clock, an epoch, and the tab in front of this surface's own window. */
const here = (
  o: Partial<{ now: number; epoch: number; front: { id?: number; url?: string } | undefined }> = {},
): Here => ({
  now: () => o.now ?? T0 + 1000,
  epoch: async () => o.epoch ?? 4,
  front: async () => ("front" in o ? o.front : { id: 7, url: URL1 }),
});
const put = (area: ReturnType<typeof sessionArea>, why: "locked" | "choose" | "insecure" = "locked") =>
  putRequest(area, { tabId: 7, windowId: 3, url: URL1, epoch: 4, why }, T0) as Promise<FillReq>;

afterEach(() => vi.unstubAllGlobals());

describe("R: its shape", () => {
  it("holds exactly the tab, its window, its address and host, when, the lock epoch and why; no secret, no account, no document", async () => {
    const area = sessionArea();
    const r = await put(area);
    expect(Object.keys(r).sort()).toEqual(["at", "epoch", "host", "nonce", "tabId", "url", "v", "why", "windowId"]);
    expect(r).toMatchObject({
      v: 1,
      tabId: 7,
      windowId: 3,
      url: URL1,
      host: "github.com",
      at: T0,
      epoch: 4,
      why: "locked",
    });
    expect(r.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(area.data.get(FILL_REQ_KEY)).toEqual(r);
    expect((await put(area)).nonce).not.toBe(r.nonce); // a new request replaces the last, with a new nonce
  });
  it("anything else read back is no R (an extra field, a missing one, a bad nonce, a bad address, an unknown reason)", async () => {
    const r = await put(sessionArea());
    expect(readRequest(r)).toEqual(r);
    for (const bad of [
      { ...r, extra: 1 },
      { ...r, documentId: "x" },
      { ...r, nonce: "zz" },
      { ...r, url: "javascript:alert(1)" },
      { ...r, why: "filled" },
      { ...r, tabId: -1 },
      { ...r, v: 2 },
      (({ epoch: _e, ...rest }) => rest)(r),
      null,
      "R",
    ])
      expect(readRequest(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("the take: compare-and-delete, for here only", () => {
  it("takes R with the nonce shown, once (a second take finds nothing)", async () => {
    const area = sessionArea();
    const r = await put(area);
    const first = await takeRequest(area, r.nonce, here());
    expect(first).toEqual({ ok: true, r });
    expect(area.data.has(FILL_REQ_KEY)).toBe(false);
    expect(await takeRequest(area, r.nonce, here())).toEqual({ ok: false, why: "gone" });
  });
  it("another nonce (a newer request replaced the one shown) takes nothing, and leaves R", async () => {
    const area = sessionArea();
    const old = await put(area);
    const now = await put(area);
    expect(await takeRequest(area, old.nonce, here())).toEqual({ ok: false, why: "gone" });
    expect(area.data.get(FILL_REQ_KEY)).toEqual(now);
  });
  it("60 s: at 59.999 s it is taken, at 60.001 s it is old; a time before it was made is old too", async () => {
    for (const [dt, ok] of [
      [REQ_MS - 1, true],
      [REQ_MS + 1, false],
      [-5, false],
    ] as const) {
      const area = sessionArea();
      const r = await put(area);
      const out = await takeRequest(area, r.nonce, here({ now: T0 + dt }));
      expect(out.ok, String(dt)).toBe(ok);
      if (!ok) expect(out).toEqual({ ok: false, why: "old" });
    }
  });
  it("a lock since (the epoch moved on) voids it; an unlock (the epoch as it was) does not", async () => {
    const area = sessionArea();
    const r = await put(area);
    expect(await takeRequest(area, r.nonce, here({ epoch: 5 }))).toEqual({ ok: false, why: "lock" });
    expect((await takeRequest(area, r.nonce, here({ epoch: 4 }))).ok).toBe(true);
  });
  it("only where its tab is the tab in front of this surface's own window, at its address", async () => {
    const area = sessionArea();
    const r = await put(area);
    // a second window: its own front tab is another tab (R's tab may still be the active tab of R's window, behind)
    expect(await takeRequest(area, r.nonce, here({ front: { id: 12, url: URL1 } }))).toEqual({ ok: false, why: "tab" });
    expect(await takeRequest(area, r.nonce, here({ front: undefined }))).toEqual({ ok: false, why: "tab" });
    // the same tab, another page (a navigation; the address is compared in full, as FU's `away` does)
    expect(await takeRequest(area, r.nonce, here({ front: { id: 7, url: `${URL1}?x` } }))).toEqual({
      ok: false,
      why: "page",
    });
    expect(await takeRequest(area, r.nonce, here({ front: { id: 7, url: undefined } }))).toEqual({
      ok: false,
      why: "page",
    });
    expect(area.data.get(FILL_REQ_KEY)).toEqual(r); // none of these took it
    expect((await takeRequest(area, r.nonce, here())).ok).toBe(true);
  });
  it("peek (the lock screen's line) applies the same checks but the nonce, and never writes", async () => {
    const area = sessionArea();
    const r = await put(area);
    area.log.length = 0;
    expect(await peekRequest(area, here())).toEqual(r);
    expect(await peekRequest(area, here({ front: { id: 12, url: URL1 } }))).toBeNull();
    expect(await peekRequest(area, here({ epoch: 9 }))).toBeNull();
    expect(await forHere(r, here({ now: T0 + REQ_MS + 1 }))).toBe("old");
    expect(area.log).toEqual([]);
  });
  it("two takes at once: one wins (the lock), the other finds nothing", async () => {
    const area = sessionArea();
    const r = await put(area);
    const [a, b] = await Promise.all([takeRequest(area, r.nonce, here()), takeRequest(area, r.nonce, here())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });
});

describe("which outcomes of the shortcut leave R", () => {
  it("exactly the ones the surface finishes; a final outcome leaves none (an R after a fill could fill a second time)", () => {
    const all: Outcome[] = [
      "filled",
      "nobox",
      "nosite",
      "locked",
      "choose",
      "blocked",
      "insecure",
      "failed",
      "unsure",
      "slow",
      "gated",
    ];
    expect(all.filter(needsRequest)).toEqual(["locked", "choose", "insecure"]);
  });
});

describe("the shortcut's run: the epoch first, R before the popup, and R only for what the surface finishes", () => {
  type Call = { target?: { documentIds?: string[] }; files?: string[]; args?: unknown[] };
  const found = { t: "0123456789abcdef", k: 0, n: 6, s: 70, sent: false, weak: false, lab: "" };
  const page = (c = [found]) => [
    { frameId: 0, documentId: "doc0", result: { o: "https://github.com", a: [], top: true, c, x: 0, z: 0 } },
  ];
  const entry = (id: string, domains = ["github.com"]) =>
    ({
      id,
      createdAt: 0,
      type: "totp",
      issuer: "GitHub",
      label: id,
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      domains,
      hlc: "",
      order: "a",
      phlc: "",
    }) as never;
  /** `lockDuring`: the vault locks while the shortcut runs (after the vault is read, the epoch is one more). */
  async function run(o: { entries: unknown[] | null; url?: string; lockDuring?: boolean }) {
    const area = sessionArea();
    const log: string[] = [];
    const calls: Call[] = [];
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: {
        local: { setAccessLevel: async () => undefined },
        session: { setAccessLevel: async () => undefined },
      },
      scripting: {
        executeScript: vi.fn(
          async (c: Call) => (
            calls.push(c),
            c.files ? [] : c.target?.documentIds ? [{ result: { ok: true, how: "single" } }] : page()
          ),
        ),
      },
    });
    let vaultRead = false;
    const { runShortcut } = await import("../../src/background/fill-command");
    const out = await runShortcut(
      { id: 7, windowId: 3, url: o.url ?? URL1 },
      {
        epoch: async () => {
          log.push("epoch");
          return o.lockDuring && vaultRead ? 5 : 4;
        },
        entries: async () => (log.push("vault"), (vaultRead = true), o.entries as never),
        session: area,
        chrome: {
          action: {
            setBadgeText: async () => undefined,
            setBadgeBackgroundColor: async () => undefined,
            setTitle: async () => undefined,
            getTitle: async () => "Sixkey",
            openPopup: async () => void log.push(`openPopup with R: ${area.data.has(FILL_REQ_KEY)}`),
          },
          i18n: { getMessage: () => "" },
        },
        opens: "popup",
        deps: { now: () => T0 + 10_000, code: TEST_CODE, off: NOT_OFF },
        sleep: async () => undefined,
      },
    );
    return { out, area, log, calls, r: readRequest(area.data.get(FILL_REQ_KEY)) };
  }
  it("locked: R (why locked, this tab, its window and address), written before the popup is opened", async () => {
    const { out, r, log, calls } = await run({ entries: null });
    expect(out).toBe("locked");
    expect(r).toMatchObject({ why: "locked", tabId: 7, windowId: 3, url: URL1, host: "github.com", epoch: 4 });
    expect(log).toEqual(["epoch", "vault", "openPopup with R: true"]);
    expect(calls).toEqual([]);
  });
  it("the epoch is the one when the key was pressed, read before the vault: a lock during the run (the epoch moves on) voids R", async () => {
    const { r } = await run({ entries: null, lockDuring: true });
    expect(r!.epoch).toBe(4);
    expect(await takeRequest(sessionArea(), r!.nonce, here({ epoch: 5 }))).toEqual({ ok: false, why: "gone" }); // (another area)
    const area = sessionArea();
    await area.set({ [FILL_REQ_KEY]: r });
    expect(await takeRequest(area, r!.nonce, here({ epoch: 5, now: r!.at + 1000 }))).toEqual({
      ok: false,
      why: "lock",
    });
    expect((await takeRequest(area, r!.nonce, here({ epoch: 4, now: r!.at + 1000 }))).ok).toBe(true);
  });
  it("several accounts, and a plain http page: R with its reason; the popup is opened after it", async () => {
    const two = await run({ entries: [entry("a"), entry("b")] });
    expect(two.out).toBe("choose");
    expect(two.r?.why).toBe("choose");
    expect(two.log.at(-1)).toBe("openPopup with R: true");
    const http = await run({ entries: [entry("a")], url: "http://github.com/login" });
    expect(http.out).toBe("insecure");
    expect(http.r).toMatchObject({ why: "insecure", url: "http://github.com/login" });
  });
  it("a final outcome writes no R: filled (one account, one box), no account for the site, no box, gated", async () => {
    const filled = await run({ entries: [entry("a")] });
    expect(filled.out).toBe("filled");
    expect(filled.calls.filter((c) => c.target?.documentIds)).toHaveLength(1);
    expect(filled.area.data.has(FILL_REQ_KEY)).toBe(false);
    const none = await run({ entries: [entry("a", ["other.org"])] });
    expect(none.out).toBe("nosite");
    expect(none.area.data.has(FILL_REQ_KEY)).toBe(false);
    const area = sessionArea();
    // `scripting` held (W1b: else the shortcut hands to the popup before any look), storage.local not closable
    vi.stubGlobal("chrome", {
      storage: { local: {}, session: { setAccessLevel: async () => undefined } },
      scripting: { executeScript: async () => [] },
    });
    const { runShortcut } = await import("../../src/background/fill-command");
    const gated = await runShortcut(
      { id: 7, windowId: 3, url: URL1 },
      {
        epoch: async () => 4,
        entries: async () => [entry("a")] as never,
        session: area,
        chrome: {
          action: {
            setBadgeText: async () => undefined,
            setBadgeBackgroundColor: async () => undefined,
            setTitle: async () => undefined,
            getTitle: async () => "Sixkey",
          },
          i18n: { getMessage: () => "" },
        },
        opens: "popup",
        deps: { code: TEST_CODE, off: NOT_OFF },
        sleep: async () => undefined,
      },
    );
    expect(gated).toBe("gated");
    expect(area.data.has(FILL_REQ_KEY)).toBe(false);
  });
});
