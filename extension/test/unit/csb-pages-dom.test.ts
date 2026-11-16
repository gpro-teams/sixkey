// Settings › Backup's card for the backup in Chrome's sync storage (src/options/csb/CsbCard.tsx, model.ts, merge.ts),
// rendered by Preact into a minimal document (test/helpers/mini-dom.ts) over the real service, store and worker
// (test/helpers/csb-pages.ts): every state the records can put it in, and that none of them claims more than that the
// copy was handed to Chrome Sync; what each button sends and what the worker then holds; the merges, while unlocked only:
// the held copy (with a key held here, or what was typed after a key change), another vault's copies, and every other
// copy when the space ran out, with their removal; the messages named by the generation the merge wrote, sent inside
// the store's lock; and the page's one retry when the worker answers that the vault or the copy changed meanwhile. The
// texts are the catalog's own (catalogs/csb-en.json), never retyped here. The real pages are test/e2e/csb-pages.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import csbEn from "../../catalogs/csb-en.json";
import csbZh from "../../catalogs/csb-zh_CN.json";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { rekey } from "../../src/core/crypto/keyring";
import { planSlot, readSlots, ROOM_BYTES } from "../../src/core/cloud/slots";
import { aliveEntries } from "../../src/core/vault/model";
import { CSB_CFG_KEY, CSB_STATE_KEY, NEW_CSB_CONFIG, NEW_CSB_STATE } from "../../src/platform/csb-config";
import type { CsbConfig, CsbState } from "../../src/platform/csb-config";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice } from "../../src/ui/i18n";
import { account, PASSWORD, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import { computer, STRONG, T0, type Computer } from "../helpers/csb-pages";
import { chromiumItemBytes } from "../helpers/fake-sync-area";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";

const cs = (k: keyof typeof csbEn, ...subs: (string | number)[]) =>
  csbEn[k].message.replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1]));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CHROME = { userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] } };
const EDGE = { userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }] } };

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
let CsbCard: typeof import("../../src/options/csb/CsbCard").CsbCard;
let model: typeof import("../../src/options/csb/model");
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
  ({ CsbCard } = await import("../../src/options/csb/CsbCard"));
  model = await import("../../src/options/csb/model");
});
beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body as MiniElement;
  vi.stubGlobal("navigator", CHROME);
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((r) => setTimeout(r, 4)));
};
const byId = (id: string) => root.byId(id);
const text = (id: string) => byId(id)?.textContent ?? null;
const state = () => byId("csb-card")?.getAttribute("data-state");
function click(id: string) {
  const el = byId(id);
  expect(el, id).not.toBeNull();
  expect(el!.disabled, `${id} enabled`).toBe(false);
  act(() => void el!.dispatch("click"));
}
function type(id: string, value: string) {
  const el = byId(id)!;
  (el as unknown as { value: string }).value = value;
  act(() => void el.dispatch("input"));
}
function submit(id: string) {
  let form = byId(id)!.parentNode as MiniElement;
  while (form.localName !== "form") form = form.parentNode as MiniElement;
  act(() => void form.dispatch("submit"));
}

/** The card on computer `c`'s Settings › Backup: unlocked with its vault, or locked. */
async function card(c: Computer, o: { unlocked?: boolean } = {}) {
  vi.stubGlobal("chrome", c.chrome);
  const unlocked = o.unlocked ?? true;
  const vault = unlocked ? (await c.service.read()).vault : null;
  const saved: number[] = [];
  act(() =>
    render(h(CsbCard, { rt: c.rt, unlocked, vault, onSaveFile: () => void saved.push(1) }), root as unknown as Element),
  );
  await settle();
  await vi.waitFor(() => expect(byId("csb-card")).not.toBeNull());
  return { saved };
}
/** The records as the worker writes them (the rest of the state a fresh one's). */
async function records(c: Computer, cfg: Partial<CsbConfig>, st: Partial<CsbState>) {
  await c.kv.set({ [CSB_CFG_KEY]: { ...NEW_CSB_CONFIG, ...cfg }, [CSB_STATE_KEY]: { ...NEW_CSB_STATE, ...st } });
}

describe("what the card says, as model.ts works it out", () => {
  const ON = { ...NEW_CSB_CONFIG, on: true };
  const st = (s: Partial<CsbState>): CsbState => ({ ...NEW_CSB_STATE, ...s });
  it("each state from the records, in its order of precedence", () => {
    const v = (cfg: CsbConfig, s: Partial<CsbState>) => model.cardView(cfg, st(s), T0);
    expect(v(NEW_CSB_CONFIG, { unsafe: true, err: "held" })).toEqual({ kind: "off" }); // off first
    expect(v(ON, { unsafe: true, err: "held" })).toEqual({ kind: "unsafe" }); // then this browser's refusal
    expect(v(ON, { err: "held" })).toEqual({ kind: "stopped", err: "held" });
    for (const err of ["too_large", "no_room", "no_password", "unreadable"] as const)
      expect(v(ON, { err, pendingSince: T0 - 9 * DAY })).toEqual({ kind: "stopped", err }); // before stale
    expect(v(ON, { err: "busy", pendingSince: T0 - 4 * DAY })).toEqual({ kind: "stale", days: 4, err: "busy" });
    expect(v(ON, { pendingSince: T0 - 3 * DAY })).toEqual({ kind: "stale", days: 3, err: null });
    expect(v(ON, { err: "other", lastOk: T0 - DAY })).toEqual({ kind: "failed", err: "other" });
    expect(v(ON, { lastOk: T0 - MIN, pendingSince: T0 - MIN })).toEqual({ kind: "waiting" });
    expect(v(ON, { lastOk: T0 - 3 * MIN })).toEqual({ kind: "ok", at: T0 - 3 * MIN });
    // nothing handed over yet: a run is due, or a run found no account to hand over
    expect(v(ON, { pendingSince: T0 })).toEqual({ kind: "saving" });
    expect(v(ON, {})).toEqual({ kind: "saving" });
    expect(v(ON, { lastRun: T0 - MIN })).toEqual({ kind: "empty" });
  });
  it("the space line: none below 60 %, the share to 85 %, then the accounts that still fit", () => {
    const at = (used: number, entries: number | null, bytes: number | null = null) =>
      model.usageLine(ON, st({ used, bytes }), entries);
    expect(model.usageLine(NEW_CSB_CONFIG, st({ used: 90_000 }), null)).toBeNull();
    expect(at(61_000, null)).toBeNull();
    expect(at(61_440, null)).toEqual({ kind: "usage", pct: 60, kb: 60 });
    expect(at(80_000, null)).toEqual({ kind: "usage", pct: 78, kb: 78 });
    // locked (no entries): a typical account's bytes
    expect(at(90_000, null)).toEqual({ kind: "near", more: Math.floor((ROOM_BYTES - 90_000) / 454) });
    // this vault's own: its copy's bytes, less what every copy holds, per entry
    expect(at(90_000, 40, 1_300 + 40 * 600)).toEqual({ kind: "near", more: Math.floor((ROOM_BYTES - 90_000) / 600) });
    expect(at(ROOM_BYTES + 50, 40, 30_000)).toEqual({ kind: "near", more: 0 });
  });
});

describe("Settings › Backup's card", () => {
  let c: Computer;
  beforeEach(async () => {
    c = computer();
    await c.makeVault();
  });

  it("off: one button, the body, the cost line, what 'handed over' means, the switch; no claim of any backup", async () => {
    await card(c);
    expect(state()).toBe("off");
    expect(text("cs-status")).toBeNull();
    expect(byId("cs-on")).not.toBeNull();
    expect(text("cs-cost")).toBe(cs("csCost"));
    expect(text("cs-honest")).toBe(cs("csHonest"));
    expect(byId("cs-opens")!.checked).toBe(false);
    expect(byId("cs-off")).toBeNull();
    expect(byId("cs-shared")).toBeNull(); // only me
    expect(root.textContent).not.toMatch(/backed up|Backed up/);
    expect(c.sent).toEqual([]); // a vault that exists is never turned on by itself
  });

  it("off in a profile declared shared: whose Google account it would go to, said before 开启", async () => {
    const s = computer();
    await s.makeVault(STRONG, "shared");
    await card(s);
    expect(text("cs-shared")).toBe(cs("csShared"));
  });

  it("开启 sends sk-csb-on, with no unlock, and the worker turns the backup on; 关闭 sends sk-csb-off", async () => {
    await c.add("GitHub");
    await card(c, { unlocked: false });
    click("cs-on");
    await settle();
    await c.worker.idle();
    await settle();
    expect(c.types()).toContain("sk-csb-on");
    const cfg = (await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig;
    expect(cfg.on).toBe(true);
    // written: the card says it was handed over, never that it is backed up
    await vi.waitFor(() => expect(state()).toBe("ok"));
    expect(text("cs-status")).toBe(cs("csOk", "now"));
    expect(text("cs-honest")).toBe(cs("csHonest"));
    expect(text("cs-off-hint")).toBe(cs("csOffHint"));
    expect(Object.keys(c.area.snapshot()).length).toBeGreaterThan(0);
    click("cs-off");
    await settle();
    expect(c.types().at(-1)).toBe("sk-csb-off");
    await vi.waitFor(() => expect(state()).toBe("off"));
    expect(c.area.snapshot()).toEqual({}); // this computer's own copy removed
  });

  it("立即备份 sends sk-csb-now; the switch sends sk-csb-opens; the cost line follows it", async () => {
    await records(c, { on: true }, { lastOk: T0 - 3 * MIN, lastRun: T0 - 3 * MIN });
    await card(c);
    expect(state()).toBe("ok");
    click("cs-now");
    await settle();
    expect(c.types()).toContain("sk-csb-now");
    const box = byId("cs-opens")!;
    box.checked = true;
    act(() => void box.dispatch("change"));
    await settle();
    expect(c.sent.find((m) => m.type === "sk-csb-opens")).toMatchObject({ opens: "recovery" });
    await vi.waitFor(() => expect(text("cs-cost")).toBe(cs("csCostRecovery")));
  });

  it("every state's line, its colour, and what goes with it; none says the backup is in the cloud", async () => {
    const at = T0 - 3 * MIN;
    const cases: [Partial<CsbConfig>, Partial<CsbState>, string, string | null, boolean][] = [
      [{ on: true }, { pendingSince: T0 }, "saving", cs("csSaving"), false],
      [{ on: true }, { lastRun: at }, "empty", cs("csEmpty"), false],
      [{ on: true }, { lastOk: at, lastRun: at }, "ok", cs("csOk", "3 minutes ago"), false],
      [{ on: true }, { lastOk: at, pendingSince: at }, "waiting", cs("csWaiting"), false],
      [{ on: true }, { lastOk: at, err: "busy" }, "failed", cs("csFailed", cs("csErrBusy")), true],
      [{ on: true }, { lastOk: at, err: "other" }, "failed", cs("csFailed", cs("csErrOther")), true],
      [{ on: true }, { err: "other", pendingSince: T0 - 5 * DAY }, "stale", cs("csStale", 5, cs("csErrOther")), true],
      [{ on: true }, { pendingSince: T0 - 4 * DAY }, "stale", cs("csStaleQuiet", 4), true],
      [{ on: true }, { err: "too_large" }, "too_large", cs("csTooLarge"), true],
      [
        { on: true },
        { err: "no_room", others: { n: 2, bytes: 97_000, otherVaults: 0, latest: null } },
        "no_room",
        cs("csNoRoom", 2, 95),
        true,
      ],
      [{ on: true }, { err: "held" }, "held", cs("csHeld"), true],
      [{ on: true }, { err: "no_password" }, "no_password", cs("csNoPassword"), true],
      [{ on: true }, { err: "unreadable" }, "unreadable", cs("csUnreadable"), true],
      [{ on: true }, { unsafe: true, lastOk: at }, "unsafe", cs("csUnsafeArea"), true],
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    try {
      for (const [cfg, st, kind, line, warn] of cases) {
        await records(c, cfg, st);
        await card(c);
        expect(state(), kind).toBe(kind);
        expect(text("cs-status"), kind).toBe(line);
        expect(byId("cs-status")!.getAttribute("class"), kind).toBe(
          warn ? "callout warn" : kind === "ok" ? "callout good" : "callout",
        );
        // what "handed over" means where the card says it was, or will be
        expect(text("cs-honest") !== null, kind).toBe(["saving", "empty", "ok", "waiting"].includes(kind));
        expect(byId("cs-off"), kind).not.toBeNull();
        // (nothing to hand over while the vault is empty: no 立即备份 then)
        expect(byId("cs-now") !== null, kind).toBe(
          (!warn && kind !== "empty") || kind === "failed" || kind === "stale",
        );
        expect(text("cs-cost"), kind).toBe(cs("csCost"));
        expect(root.textContent, kind).not.toMatch(/backed up to|Backed up|in the cloud/);
        act(() => render(null, root as unknown as Element));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("the fixes beside 关闭: the encrypted file for too large and full, a merge for held and full", async () => {
    await records(c, { on: true }, { err: "too_large" });
    const { saved } = await card(c);
    click("cs-save-file");
    expect(saved).toEqual([1]);
    expect(byId("cs-held-merge")).toBeNull();
    act(() => render(null, root as unknown as Element));
    await records(c, { on: true }, { err: "no_room" });
    await card(c);
    // the fix that removes nothing is the main button; the merge that removes copies is not
    expect(byId("cs-save-file")!.getAttribute("class")).toBe("btn");
    expect(byId("cs-merge-clean")!.getAttribute("class")).toBe("btn ghost sm");
    act(() => render(null, root as unknown as Element));
    await records(c, { on: true }, { err: "held" });
    await card(c);
    expect(byId("cs-held-merge")).not.toBeNull();
    expect(byId("cs-save-file")).toBeNull();
    expect(text("cs-off-hint")).toBe(cs("csOffHeld")); // 关闭 keeps a held copy
  });

  it("the merges need the vault open: locked, their buttons wait and the card says why", async () => {
    for (const st of [
      { err: "held" as const },
      { err: "no_room" as const },
      { lastOk: T0, others: { n: 1, bytes: 5_000, otherVaults: 1, latest: T0 } },
    ]) {
      await records(c, { on: true }, st);
      await card(c, { unlocked: false });
      expect(text("cs-unlock")).toBe(cs("csUnlockToMerge"));
      for (const id of ["cs-held-merge", "cs-merge-clean", "cs-merge-others"])
        if (byId(id)) expect(byId(id)!.disabled, id).toBe(true);
      act(() => render(null, root as unknown as Element));
    }
  });

  it("the evidence and the space: another computer's copy seen, the share used, nearly full", async () => {
    await records(c, { on: true }, { lastOk: T0, lastRun: T0, seen: true, used: 70_000 });
    await card(c);
    expect(text("cs-seen")).toBe(cs("csSeen"));
    expect(text("cs-usage")).toBe(cs("csUsage", 68, 68));
    act(() => render(null, root as unknown as Element));
    await records(c, { on: true }, { lastOk: T0, lastRun: T0, used: 95_000, bytes: null });
    await card(c, { unlocked: false });
    expect(text("cs-usage")).toBe(cs("csNearFull", Math.floor((ROOM_BYTES - 95_000) / 454)));
  });

  it("a browser that is not Google Chrome: 'browser sync', and that Sixkey does not know whether it syncs", async () => {
    vi.stubGlobal("navigator", EDGE);
    await records(c, { on: true }, { lastOk: Date.now() - 3 * MIN, lastRun: Date.now() });
    await card(c);
    expect(text("csb-card")).not.toContain("Chrome Sync");
    expect(byId("csb-card")!.all((e) => e.localName === "h3")[0]?.textContent).toBe("Automatic backup to browser sync");
    expect(text("cs-status")).toBe("Handed to browser sync · 3 minutes ago");
    expect(text("cs-honest")).toBe(cs("csBrowserUnknown"));
    expect(text("cs-cost")).toBe(cs("csCostOther"));
    // its account may be no Google account, and "this Chrome" is not this browser
    expect(text("csb-card")).not.toMatch(/Google|Chrome/);
    act(() => render(null, root as unknown as Element));
    await records(c, { on: false }, {});
    await c.settings.set({ ...(await c.settings.get()), profile: "shared" });
    await card(c);
    expect(text("csb-card")).not.toMatch(/Google|Chrome/);
    expect(text("cs-shared")).toBe(cs("csSharedOther"));
    expect(byId("csb-card")!.all((e) => e.localName === "p")[0]?.textContent).toBe(cs("csBodyOther"));
  });

  it("the words: none says the backup is done or in the cloud, in English or in Chinese; Chinese without its space", async () => {
    const all = (c: Record<string, { message: string }>) => Object.values(c).map((v) => v.message);
    for (const m of all(csbEn)) expect(m).not.toMatch(/backed up|in the cloud|1 backups|1 accounts/i);
    for (const m of all(csbZh)) expect(m).not.toMatch(/已备份|云端/);
    // another computer's copy seen once says what happened then, not that sync works now
    expect(csbEn.csSeen.message).not.toMatch(/\bis working|\bworks\b/i);
    expect(csbZh.csSeen.message).not.toMatch(/在工作|正常/);
    // another browser's word, in a Chinese line, takes the space before "Chrome" with it
    const { branded } = await import("../../src/ui/csb-text");
    expect(branded(csbZh.csOk.message.replace("$1", "3 分钟前"), false, "浏览器同步")).toBe(
      "已交给浏览器同步 · 3 分钟前",
    );
    expect(branded("Chrome Sync is busy", false, "browser sync")).toBe("Browser sync is busy");
    expect(branded("已交给 Chrome 同步", true, "浏览器同步")).toBe("已交给 Chrome 同步");
  });

  it("this browser refuses to close the area to web pages: 开启 is refused, said, and the worker's state says so after", async () => {
    c.access.ok = false;
    await card(c);
    click("cs-on");
    await settle();
    await vi.waitFor(() => expect(text("cs-unsafe")).toBe(cs("csUnsafeArea"))); // the off state, with the line
    expect(byId("cs-error")).toBeNull(); // said once, not twice
    expect(((await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig | undefined)?.on ?? false).toBe(false);
    // on from before, refused in this run of the worker: its routine writes it down, and the card shows it
    c.access.ok = true;
    await c.worker.on();
    await c.worker.idle();
    c.access.ok = false;
    await c.worker.routine(false);
    await vi.waitFor(() => expect(state()).toBe("unsafe"));
    expect(byId("cs-now")).toBeNull();
    click("cs-off"); // turning off needs nothing of the area's protection
    await settle();
    expect(c.types().at(-1)).toBe("sk-csb-off");
  });
});

describe("the popup's 立即备份, taken by the card as it loads (platform/cloud-go.ts)", () => {
  /** What the popup's footer leaves (src/popup/main/CsbPop.tsx): the click's time in storage.session. */
  const leave = (c: Computer, at = Date.now()) => c.session.set({ sk_cloud_go: at });
  const taken = async (c: Computer) => expect(await c.session.get(["sk_cloud_go"])).toEqual({});
  const cfgOf = async (c: Computer) => (await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig | undefined;

  it("left within its minute, the backup off and never turned off: the card turns it on, once, as its own button does", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await leave(c);
    await card(c);
    await c.worker.idle();
    await settle();
    expect(c.types()).toEqual(["sk-csb-on"]);
    expect((await cfgOf(c))!.on).toBe(true);
    await taken(c);
    expect(state()).not.toBe("off");
    // and the card loaded again later takes nothing more
    act(() => render(null, root as unknown as Element));
    await card(c);
    expect(c.types()).toEqual(["sk-csb-on"]);
  });

  it("locked: turned on all the same, as 开启 is (no unlock needed)", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await leave(c);
    await card(c, { unlocked: false });
    await c.worker.idle();
    await settle();
    expect(c.types()).toEqual(["sk-csb-on"]);
    expect((await cfgOf(c))!.on).toBe(true);
  });

  it("not where the person turned it off before, nor in a profile not theirs alone, nor when it is on already; taken either way", async () => {
    const declined = computer();
    await declined.makeVault();
    await records(declined, { declined: true }, {});
    await leave(declined);
    await card(declined);
    expect(declined.sent).toEqual([]);
    expect((await cfgOf(declined))!.on).toBe(false);
    await taken(declined);
    act(() => render(null, root as unknown as Element));

    const shared = computer();
    await shared.makeVault(STRONG, "shared");
    await leave(shared);
    await card(shared);
    expect(shared.sent).toEqual([]);
    expect(await cfgOf(shared)).toBeUndefined();
    await taken(shared);
    act(() => render(null, root as unknown as Element));

    const on = computer();
    await on.makeVault();
    await records(on, { on: true }, { lastOk: T0 });
    await leave(on);
    await card(on);
    expect(on.sent).toEqual([]);
    await taken(on);
  });

  it("left more than a minute ago, dated in the future (a clock set back), or not at all: nothing is sent", async () => {
    const old = computer();
    await old.makeVault();
    await leave(old, Date.now() - 61_000);
    await card(old);
    expect(old.sent).toEqual([]);
    await taken(old);
    act(() => render(null, root as unknown as Element));

    const ahead = computer();
    await ahead.makeVault();
    await leave(ahead, Date.now() + 5_000);
    await card(ahead);
    expect(ahead.sent).toEqual([]);
    await taken(ahead);
    act(() => render(null, root as unknown as Element));

    const none = computer();
    await none.makeVault();
    await card(none);
    expect(none.sent).toEqual([]);
  });
});

describe("the card's handoff where its records cannot be read", () => {
  it("the click's handoff is taken, and nothing is turned on (the card does not know whether the person turned it off)", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await c.session.set({ sk_cloud_go: Date.now() });
    const get = c.kv.get.bind(c.kv);
    let failed = 0;
    c.kv.get = (keys: string[]) =>
      keys.includes(CSB_CFG_KEY) && failed++ === 0 ? Promise.reject(new Error("unreadable")) : get(keys);
    vi.stubGlobal("chrome", c.chrome);
    act(() =>
      render(
        h(CsbCard, { rt: c.rt, unlocked: true, vault: null, onSaveFile: () => undefined }),
        root as unknown as Element,
      ),
    );
    await settle();
    await vi.waitFor(() => expect(failed).toBeGreaterThan(0));
    await settle();
    expect(c.sent).toEqual([]);
    expect(await c.session.get(["sk_cloud_go"])).toEqual({});
  });
});

describe("the settings page's rail: its backup line is no reminder while the backup in Chrome sync runs", () => {
  it("a week and more since the last backup: amber; the same, the backup running: neutral; none ever: the same", async () => {
    const { Rail } = await import("../../src/options/Rail");
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    const vault = (await c.service.read()).vault;
    const status = { state: "unlocked", passwordProtected: true, events: [] } as never;
    const off = { cfg: NEW_CSB_CONFIG, st: NEW_CSB_STATE };
    const runs = { cfg: { ...NEW_CSB_CONFIG, on: true }, st: { ...NEW_CSB_STATE, lastOk: Date.now() - MIN } };
    const draw = (lastBackup: number | null, csb: typeof off) => {
      act(() =>
        render(
          h(Rail, { sections: [], current: "backup", status, vault, lastBackup, csb }),
          root as unknown as Element,
        ),
      );
      return root.all((e) => (e.getAttribute("class") ?? "").split(" ").includes("fresh"))[0]!.getAttribute("class");
    };
    expect(draw(Date.now() - 8 * DAY, off)).toBe("fresh warn");
    expect(draw(Date.now() - 8 * DAY, runs)).toBe("fresh none");
    expect(draw(null, off)).toBe("fresh bad");
    expect(draw(null, runs)).toBe("fresh none");
    expect(draw(Date.now() - DAY, off)).toBe("fresh good");
    expect(draw(Date.now() - DAY, runs)).toBe("fresh good");
  });
});

describe("the merges, from the card", () => {
  it("held: the copy here may be newer, 合并并继续 merges it with a key held here and the backup goes on", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await c.worker.on();
    await c.worker.idle();
    await c.add("Proton");
    await c.worker.run();
    await c.worker.idle();
    // the store falls back to the generation before (the newest slot damaged): its recovery hook holds the link
    const ptr = (await c.kv.get(["sk_active"]))["sk_active"] as string;
    await c.kv.set({ [`sk_slot_${ptr}`]: { torn: "half a write" } });
    expect(aliveEntries((await c.service.read()).vault).map((e) => e.issuer)).toEqual(["GitHub"]);
    await c.worker.run();
    await c.worker.idle();
    await card(c);
    expect(state()).toBe("held");
    c.sent.length = 0;
    click("cs-held-merge");
    await vi.waitFor(() => expect(text("cs-result")).toBe(cs("csMerged") + " " + cs("csAdded", 1)), {
      timeout: 10_000,
    });
    expect(
      aliveEntries((await c.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Proton"]);
    // the message named the generation the merge wrote, sent from inside the store's lock that committed it, and the
    // worker took it
    const m = c.sent.find((x) => x.type === "sk-csb-merged")!;
    const gen = (await c.service.currentGeneration())!;
    expect(m).toMatchObject({ seq: gen.seq, sum: gen.envelope.checksum });
    expect(c.lockedAt[c.sent.indexOf(m)]).toBe(true);
    await c.worker.idle();
    const cfg = (await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig;
    expect(cfg.link?.held).toBeUndefined();
    await vi.waitFor(() => expect(state()).toBe("ok"));
  });

  it("held, the copy under a key not held here: what opens it is asked, a wrong one said, the right one merges", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await c.worker.on();
    await c.worker.idle();
    // the copy under this computer's slot and tag, written meanwhile under a key this computer does not hold (another
    // computer's, after a key change there), and the link held
    const link = ((await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig).link!;
    const keys = await protectedKeys(STRONG);
    const theirs = await makeCloudBackup(
      await seal(keys, vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ")]), 9),
      "both",
      "x",
    );
    const plan = await planSlot(theirs, link.slot, link.gen);
    if (plan.kind !== "plan") throw new Error("unexpected");
    await c.area.set(plan.items);
    await records(c, { on: true, link: { ...link, held: true } }, { err: "held" });
    await card(c);
    expect(state()).toBe("held");
    click("cs-held-merge");
    await vi.waitFor(() => expect(byId("cs-secret")).not.toBeNull(), { timeout: 10_000 });
    type("cs-secret", "not it");
    submit("cs-secret");
    await vi.waitFor(() => expect(text("cs-error")).toBe(cs("csWrong")), { timeout: 10_000 });
    type("cs-secret", STRONG);
    submit("cs-secret");
    await vi.waitFor(() => expect(text("cs-result")).toBe(cs("csMerged") + " " + cs("csAdded", 1)), {
      timeout: 10_000,
    });
    expect(
      aliveEntries((await c.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Proton"]);
    expect(c.sent.find((m) => m.type === "sk-csb-merged")).toMatchObject({ slot: link.slot, gen: link.gen });
    await c.worker.idle();
    expect(((await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig).link?.held).toBeUndefined();
  });

  it("held, and merged meanwhile from another page (not held any more): this merge is done too", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await c.worker.on();
    await c.worker.idle();
    const link = ((await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig).link!;
    await records(c, { on: true, link: { ...link, held: true } }, { err: "held" });
    await card(c);
    c.answer["sk-csb-merged"] = [{ ok: false, why: "not_held" }];
    click("cs-held-merge");
    await vi.waitFor(() => expect(text("cs-result")).toBe(cs("csMerged")), { timeout: 10_000 });
    expect(byId("cs-error")).toBeNull();
    expect(c.sent.filter((m) => m.type === "sk-csb-merged")).toHaveLength(1);
  });

  it("the worker's 'not that generation' and 'slot changed': merged once more each, then said, never a loop", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await c.worker.on();
    await c.worker.idle();
    await c.add("Proton");
    await c.worker.run();
    await c.worker.idle();
    const p2 = (await c.kv.get(["sk_active"]))["sk_active"] as string;
    await c.kv.set({ [`sk_slot_${p2}`]: { torn: "half a write" } });
    await c.service.read();
    await c.worker.run();
    await c.worker.idle();
    await card(c);
    const merges = () => c.sent.filter((m) => m.type === "sk-csb-merged");
    // the first answer: the vault changed meanwhile; the page merges again over the vault as it is, named anew
    c.answer["sk-csb-merged"] = [{ ok: false, why: "not_that_generation" }];
    click("cs-held-merge");
    await vi.waitFor(() => expect(text("cs-result")).toContain(cs("csMerged")), { timeout: 10_000 });
    expect(merges()).toHaveLength(2);
    expect(merges()[1]!.seq).toBeGreaterThan(merges()[0]!.seq as number);
    const gen = (await c.service.currentGeneration())!;
    expect(merges()[1]).toMatchObject({ seq: gen.seq, sum: gen.envelope.checksum });
    // twice in a row: said, after two tries
    act(() => render(null, root as unknown as Element));
    const was = (await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig;
    await records(c, { on: true, link: { ...was.link!, held: true } }, { err: "held" });
    c.sent.length = 0;
    c.answer["sk-csb-merged"] = [
      { ok: false, why: "slot_changed" },
      { ok: false, why: "not_that_generation" },
    ];
    await card(c);
    click("cs-held-merge");
    await vi.waitFor(() => expect(text("cs-error")).toBe(cs("csMergeAgain")), { timeout: 10_000 });
    expect(merges()).toHaveLength(2);
  });

  it("no room: every other copy opened with what was typed, merged, and removed under the tag it was read with", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub", "Proton");
    // another computer's copy of this vault (its sibling), and other data, so that this computer's copy does not fit
    const gen = (await c.service.currentGeneration())!;
    const backup = await makeCloudBackup(gen, "both", "Sixkey 0.0.0");
    const theirs = await planSlot(backup, "theirs01", "0123456789abcdef");
    const mine = await planSlot(backup, "zzzzzzzz", "fedcba9876543210");
    // and another vault's copy, which what is typed does not open: merged nothing of, removed never
    const keys = await protectedKeys("Other#Vault5!Pass9$Word");
    const stranger = await planSlot(
      await makeCloudBackup(
        await seal(keys, vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ")]), 2),
        "both",
        "x",
      ),
      "theirs02",
      "1111111111111111",
    );
    if (theirs.kind !== "plan" || mine.kind !== "plan" || stranger.kind !== "plan") throw new Error("unexpected");
    let pad = ROOM_BYTES - theirs.bytes - stranger.bytes - mine.bytes + 100;
    const pads: Record<string, string> = {};
    for (let i = 0; pad > 0; i++) {
      const v = "p".repeat(Math.min(pad, 7_000));
      pads[`pad.${i}`] = v;
      pad -= chromiumItemBytes(`pad.${i}`, v);
    }
    await c.area.set(theirs.items);
    await c.area.set(stranger.items);
    await c.area.set(pads);
    await c.worker.on();
    await c.worker.idle();
    expect((await c.kv.get([CSB_STATE_KEY]))[CSB_STATE_KEY]).toMatchObject({ err: "no_room" });
    await card(c);
    expect(state()).toBe("no_room");
    click("cs-merge-clean");
    expect(text("cs-merge-form")).toContain(cs("csMergeCleanHint"));
    type("cs-secret", STRONG);
    submit("cs-secret");
    await vi.waitFor(
      () => expect(text("cs-result")).toBe([cs("csMerged"), cs("csRemoved", 1), cs("csKept", 1)].join(" ")),
      { timeout: 20_000 },
    );
    const drop = c.sent.find((m) => m.type === "sk-csb-drop")!;
    expect(drop.slots).toEqual([{ slot: "theirs01", gen: "0123456789abcdef" }]); // the one that opened and was merged
    await c.worker.idle();
    // the room it freed: this computer's copy written, the other gone, the other data untouched
    const { slots } = await readSlots(c.area.snapshot());
    expect(slots.map((s) => s.slot)).not.toContain("theirs01");
    expect(slots.map((s) => s.slot)).toContain("theirs02");
    expect(
      aliveEntries((await c.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Proton"]);
    expect(
      Object.keys(c.area.snapshot())
        .filter((k) => k.startsWith("pad."))
        .sort(),
    ).toEqual(Object.keys(pads).sort());
    await vi.waitFor(() => expect(state()).toBe("ok"), { timeout: 10_000 });
  });

  it("another vault's copies: one line, merged into this computer with what opens them; then removed at a click", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    const keys = await protectedKeys();
    const backup = await makeCloudBackup(
      await seal(keys, vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ")]), 2),
      "both",
      "x",
    );
    const plan = await planSlot(backup, "theirs02", "fedcba9876543210");
    // and a later copy of that vault, after its key was replaced elsewhere (a new master password after its recovery
    // key): what is typed does not open it, so nothing of it is merged, and it is never removed
    const later = await rekey(keys.keyring, keys.vk, "Later#Pass5!Word9$Two", { iterations: TEST_KDF_ITERATIONS });
    const laterPlan = await planSlot(
      await makeCloudBackup(
        await seal(
          later,
          vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ"), account("Later", "JBSWY3DPEHPK3PXR")]),
          3,
        ),
        "both",
        "x",
      ),
      "theirs03",
      "0123012301230123",
    );
    if (plan.kind !== "plan" || laterPlan.kind !== "plan") throw new Error("unexpected");
    await c.area.set(plan.items);
    await c.area.set(laterPlan.items);
    const laterItems = laterPlan.items;
    await c.worker.on();
    await c.worker.idle();
    await card(c);
    expect(text("cs-others")).toBe(cs("csOthers", 2));
    click("cs-merge-others");
    type("cs-secret", PASSWORD);
    submit("cs-secret");
    await vi.waitFor(() => expect(text("cs-result")).toBe(cs("csMerged") + " " + cs("csAdded", 1)), {
      timeout: 10_000,
    });
    expect(c.types()).not.toContain("sk-csb-drop");
    expect(Object.keys(c.area.snapshot()).filter((k) => k.startsWith("bk1.theirs02")).length).toBeGreaterThan(0);
    expect(
      aliveEntries((await c.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Proton"]);
    // then removing them is the person's click: merged again in the removal's own commit, and removed
    expect(text("cs-drop-hint")).toBe(cs("csDropHint"));
    expect(byId("cs-drop-merged")!.getAttribute("class")).toBe("btn ghost sm"); // it removes: not the main button
    click("cs-drop-merged");
    await vi.waitFor(() => expect(text("cs-result")).toBe(cs("csMerged") + " " + cs("csRemoved", 1)), {
      timeout: 10_000,
    });
    const drop = c.sent.find((m) => m.type === "sk-csb-drop")!;
    const gen = (await c.service.currentGeneration())!;
    expect(drop).toMatchObject({ slots: [{ slot: "theirs02", gen: "fedcba9876543210" }], seq: gen.seq });
    expect(c.lockedAt[c.sent.indexOf(drop)]).toBe(true);
    expect(Object.keys(c.area.snapshot()).filter((k) => k.startsWith("bk1.theirs02"))).toEqual([]);
    // the copy that did not open: in no removal, every key of it as it was
    expect(drop.slots).toHaveLength(1);
    for (const [k, v] of Object.entries(laterItems)) expect(c.area.snapshot()[k], k).toEqual(v);
    expect(byId("cs-drop-merged")).toBeNull();
  });

  it("no room taken by another vault the same password opens: merged, none removed, as this computer still would not fit", async () => {
    const c = computer();
    await c.makeVault();
    await c.add(...Array.from({ length: 150 }, (_, i) => `Mine ${i}`));
    const keys = await protectedKeys(STRONG);
    const theirs = vaultOf(
      keys.keyring.vaultId,
      Array.from({ length: 150 }, (_, i) => account(`Theirs ${i}`, "JBSWY3DPEHPK3PXQ")),
    );
    const plan = await planSlot(
      await makeCloudBackup(await seal(keys, theirs, 2), "both", "x"),
      "theirs09",
      "9999999999999999",
    );
    if (plan.kind !== "plan") throw new Error("unexpected");
    await c.area.set(plan.items);
    await c.worker.on();
    await c.worker.idle();
    expect((await c.kv.get([CSB_STATE_KEY]))[CSB_STATE_KEY]).toMatchObject({ err: "no_room" });
    await card(c);
    click("cs-merge-clean");
    type("cs-secret", STRONG);
    submit("cs-secret");
    await vi.waitFor(
      () => expect(text("cs-error")).toBe([cs("csMerged"), cs("csAdded", 150), cs("csNotRemoved")].join(" ")),
      { timeout: 30_000 },
    );
    // the other vault's only copy in Chrome Sync stays; its accounts are in this vault too
    for (const [k, v] of Object.entries(plan.items)) expect(c.area.snapshot()[k], k).toEqual(v);
    expect(aliveEntries((await c.service.read()).vault)).toHaveLength(300);
  });

  it("the store falls back between a merge and its removal: none removed then; merged again, and removed", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    const keys = await protectedKeys();
    const backup = await makeCloudBackup(
      await seal(keys, vaultOf(keys.keyring.vaultId, [account("Theirs", "JBSWY3DPEHPK3PXQ")]), 2),
      "both",
      "x",
    );
    const plan = await planSlot(backup, "theirs08", "0808080808080808");
    if (plan.kind !== "plan") throw new Error("unexpected");
    await c.area.set(plan.items);
    await c.worker.on();
    await c.worker.idle();
    const before = (await c.service.currentGeneration())!; // the vault without the other's accounts
    await card(c);
    click("cs-merge-others");
    type("cs-secret", PASSWORD);
    submit("cs-secret");
    await vi.waitFor(() => expect(byId("cs-drop-merged")).not.toBeNull(), { timeout: 10_000 });
    // between the removal's commit and the worker: the store falls back to the vault before the merge
    c.meanwhile["sk-csb-drop"] = [
      async () => {
        const ptr = (await c.kv.get(["sk_active"]))["sk_active"] as string;
        await c.kv.set({ [`sk_slot_${ptr}`]: before });
      },
    ];
    click("cs-drop-merged");
    // the fallback lost the merged account: the second merge brings it in again, then the copy goes
    await vi.waitFor(
      () => expect(text("cs-result")).toBe([cs("csMerged"), cs("csAdded", 1), cs("csRemoved", 1)].join(" ")),
      { timeout: 10_000 },
    );
    const drops = c.sent.filter((m) => m.type === "sk-csb-drop");
    expect(drops).toHaveLength(2); // refused once (not that generation), merged again, sent again
    expect(drops.map((m) => c.lockedAt[c.sent.indexOf(m)])).toEqual([true, true]);
    expect(
      aliveEntries((await c.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Theirs"]);
    expect(Object.keys(c.area.snapshot()).filter((k) => k.startsWith("bk1.theirs08"))).toEqual([]);
  });

  it("started over over data that could not be read: the new vault gets its own copy; the old one stays, as another vault's", async () => {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await c.worker.on();
    await c.worker.idle();
    const old = ((await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig).link!;
    const before = c.area.snapshot();
    // the vault can no longer be read: no slot, no snapshot, no keyring copy
    for (const k of await c.kv.keys()) if (/^sk_(slot_|snap|keyring)/.test(k)) await c.kv.remove([k]);
    await c.kv.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } });
    expect((await c.service.status()).state).toBe("lost");
    await c.service.startOver(await c.service.prepareKeys(STRONG), { preset: "standard" });
    expect(((await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig).link?.held).toBe(true); // the recovery's mark
    await c.add("Proton");
    await c.worker.run();
    await c.worker.idle();
    await card(c);
    expect(state()).toBe("ok");
    expect(text("csb-card")).not.toContain(cs("csHeld"));
    expect(text("cs-others")).toBe(cs("csOthers", 1));
    const link = ((await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig).link!;
    expect(link.slot).not.toBe(old.slot);
    for (const [k, v] of Object.entries(before)) expect(c.area.snapshot()[k], k).toEqual(v);
  });
});

describe("the service's hook for the messages (importBackup's and mutate's `after`)", () => {
  it("is called inside the store's lock with the generation committed, also when sync's outbox cannot be written", async () => {
    const { VaultService } = await import("../../src/core/service/service");
    const { KvSettingsStore, MemorySession } = await import("../../src/core/service/types");
    const { VaultStore } = await import("../../src/core/storage/store");
    const { createMutex, MemoryKV } = await import("../../src/core/storage/kv");
    const { TEST_KDF_ITERATIONS } = await import("../helpers/kdf");
    const kv = new MemoryKV();
    const mutex = createMutex();
    let holding = 0;
    const lock = <T>(fn: () => Promise<T>) =>
      mutex(async () => {
        holding++;
        try {
          return await fn();
        } finally {
          holding--;
        }
      });
    const outbox: string[] = [];
    const svc = new VaultService({
      store: new VaultStore({ lock, kv, now: () => T0 }),
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
      now: () => T0,
      kdfIterations: TEST_KDF_ITERATIONS,
      // sync on, its outbox failing: the commit stands, and the page's message must still go from inside the lock
      sync: {
        context: async () => ({ offsetMs: 0 }),
        clearLastSynced: async () => undefined,
        afterCommit: async () => {
          outbox.push("tried");
          throw new Error("the outbox could not be written");
        },
      },
    } as never);
    await svc.create(await svc.prepareKeys(STRONG), {});
    const keys = await protectedKeys();
    const seen: { seq: number; locked: boolean }[] = [];
    await svc.importBackup(vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ")]), (gen) =>
      seen.push({ seq: gen.seq, locked: holding > 0 }),
    );
    expect(outbox).toEqual(["tried"]);
    const gen = (await svc.currentGeneration())!;
    expect(seen).toEqual([{ seq: gen.seq, locked: true }]);
  });
});
