// The settings page's rail (src/options/Rail.tsx) in both settings of the Sync section's release gate
// (scripts/sync-ui.mjs, __SYNC_UI__). Closed, as in the store build: no line of the live sync, and in its place the
// backup in Chrome sync's, in every state its card can be in (csb/model.ts cardView), in a few of the card's and the
// popup pill's words, with its tone. Open, as in dev and e2e builds: the live sync's line exactly as before, and none
// of the backup's. In both, the last backup's line keeps its date (lastBackup, as App reads it), but while the backup
// in Chrome sync runs, no date or an old one is neutral, not amber or red. Rendered by Preact into a minimal document
// (test/helpers/mini-dom.ts); the store build itself is test/e2e/store-rail.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enFull from "../../_locales/en/messages.json";
import zhFull from "../../_locales/zh_CN/messages.json";
import csbEn from "../../catalogs/csb-en.json";
import csbZh from "../../catalogs/csb-zh_CN.json";
import popEn from "../../catalogs/csb-popup-en.json";
import popZh from "../../catalogs/csb-popup-zh_CN.json";
import { NEW_CSB_CONFIG, NEW_CSB_STATE, type CsbConfig, type CsbState } from "../../src/platform/csb-config";
import { installMiniDom, type MiniElement } from "../helpers/mini-dom";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CHROME = { userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] } };
const EDGE = { userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }] } };
type Lang = "en" | "zh_CN";
type Full = Record<string, { message: string }>;
const full: Record<Lang, Full> = { en: enFull, zh_CN: zhFull };
const msg = (lang: Lang, k: string, ...subs: (string | number)[]) =>
  full[lang][k]!.message.replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1]));

/** One account, alive (any secret but a purged one's ""): the count is not zero, so the backup line has a tone. */
const VAULT = { entries: [{ id: "a", secret: "A", deleted: false, hlc: "1", order: 0 }] } as never;
const STATUS = { state: "unlocked", passwordProtected: true, events: [] } as never;

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body as MiniElement;
  vi.stubGlobal("navigator", CHROME);
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

type RailProps = {
  lastBackup: number | null;
  csb: { cfg: CsbConfig; st: CsbState } | null;
  syncLine?: { text: string; tone: "none" | "good" | "warn" | "bad" } | null;
};
/** The rail of a build whose gate is `gate`, in `lang`: a fresh copy of its modules, which read the gate. */
async function railOf(gate: boolean, lang: Lang = "en") {
  vi.resetModules();
  vi.stubGlobal("__SYNC_UI__", gate);
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice(lang);
  await i18n.loadCatalog(async (l) => full[l]);
  const { Rail } = await import("../../src/options/Rail");
  return (p: RailProps) =>
    act(() =>
      render(
        h(Rail, { sections: [], current: "backup", status: STATUS, vault: VAULT, ...p }),
        root as unknown as Element,
      ),
    );
}
const byClass = (c: string) => root.all((e) => (e.getAttribute("class") ?? "").split(" ").includes(c));
/** The rail's rows: [class, label, value]. */
const rows = () =>
  root
    .all((e) => e.localName === "div" && e.parentNode !== null && (e.parentNode as MiniElement).localName === "dl")
    .map((d) => {
      const [dt, dd] = d.all((e) => e.localName === "dt" || e.localName === "dd");
      return [d.getAttribute("class"), dt!.textContent, dd!.textContent];
    });
const freshClass = () => byClass("fresh")[0]!.getAttribute("class");

/** Each state of the card, by the records that put it there at `now`, and whether the backup then runs. */
function states(now: number): [string, Partial<CsbConfig>, Partial<CsbState>, boolean][] {
  const on = { on: true };
  return [
    ["off", {}, {}, false],
    ["off-unsafe", {}, { unsafe: true }, false],
    ["empty", on, { lastRun: now - MIN }, true],
    ["saving", on, { pendingSince: now }, true],
    ["ok", on, { lastOk: now - 3 * MIN, lastRun: now - 3 * MIN }, true],
    ["waiting", on, { lastOk: now - 9 * MIN, pendingSince: now - MIN }, true],
    ["failed", on, { lastOk: now - DAY, err: "busy", errSince: now - MIN, pendingSince: now - MIN }, true],
    ["stale", on, { lastOk: now - 5 * DAY, err: "other", errSince: now - 4 * DAY, pendingSince: now - 4 * DAY }, false],
    ["stale-quiet", on, { lastOk: now - 5 * DAY, pendingSince: now - 3 * DAY }, false],
    ["too_large", on, { err: "too_large", errSince: now }, false],
    ["no_room", on, { err: "no_room", errSince: now }, false],
    ["held", on, { err: "held", errSince: now }, false],
    ["no_password", on, { err: "no_password", errSince: now }, false],
    ["unreadable", on, { err: "unreadable", errSince: now }, false],
    ["unsafe", on, { unsafe: true, lastOk: now - DAY }, false],
  ];
}
const recs = (cfg: Partial<CsbConfig>, st: Partial<CsbState>) => ({
  cfg: { ...NEW_CSB_CONFIG, ...cfg },
  st: { ...NEW_CSB_STATE, ...st },
});
/** What the line says in each state, in English, and its tone. */
const WANT: Record<string, [string, string]> = {
  off: ["Off", "none"],
  "off-unsafe": ["Off", "none"],
  empty: ["On", "none"],
  saving: ["Handing over…", "none"],
  ok: ["Handed over · 3 minutes ago", "good"],
  waiting: ["Handing over soon", "none"],
  failed: ["Not handed over · will retry", "warn"],
  stale: ["Backup stopped", "warn"],
  "stale-quiet": ["Backup stopped", "warn"],
  too_large: ["Backup stopped", "warn"],
  no_room: ["Backup stopped", "warn"],
  held: ["Backup stopped", "warn"],
  no_password: ["Backup stopped", "warn"],
  unreadable: ["Backup stopped", "warn"],
  unsafe: ["Backup stopped", "warn"],
};

describe("the rail's words for the backup in Chrome sync", () => {
  it("are the popup pill's and the card's: its label, the browser's word, its stop, the act with when", () => {
    for (const [lang, pop, card] of [
      ["en", popEn, csbEn],
      ["zh_CN", popZh, csbZh],
    ] as const) {
      const f = full[lang];
      expect(f.railCsb!.message, lang).toBe(pop.cbPill.message);
      expect(f.railCsbBrowser!.message, lang).toBe(pop.cbBrowser.message);
      expect(f.railCsbBrowser!.message, lang).toBe(card.csBrowser.message);
      expect(f.railCsbStopped!.message, lang).toBe(pop.cbStopped.message);
      // off and on: the settings page's words for a switch's state (the clipboard's), each a key of the rail's own
      expect(f.railCsbOff!.message, lang).toBe(f.clipOff!.message);
      expect(f.railCsbOn!.message, lang).toBe(f.clipOn!.message);
      // a copy due: the card's "正在交给 Chrome 同步…" / "Handing to Chrome Sync…", its noun in the label beside it
      const head = (m: string) => m.split(/[ …]/)[0];
      expect(head(f.railCsbSaving!.message), lang).toBe(head(card.csSaving.message));
      expect(f.railCsbSaving!.message.endsWith("…") && card.csSaving.message.endsWith("…"), lang).toBe(true);
      // "已交给 · $1" / "Handed over · $1": the card's act ("已交给 Chrome 同步 · $1"), its noun in the label beside it
      expect(card.csOk.message.split(" ")[0], lang).toBe(f.railCsbOk!.message.split(" ")[0]);
      expect(f.railCsbOk!.message.endsWith(" · $1"), lang).toBe(true);
      expect(card.csOk.message.endsWith(" · $1"), lang).toBe(true);
    }
  });
  it("never say backed up, in the cloud, or name a Google account", () => {
    for (const lang of ["en", "zh_CN"] as const)
      for (const k of [
        "railCsb",
        "railCsbBrowser",
        "railCsbOff",
        "railCsbOn",
        "railCsbSaving",
        "railCsbOk",
        "railCsbSoon",
        "railCsbFailed",
        "railCsbStopped",
      ])
        expect(full[lang][k]!.message, `${lang} ${k}`).not.toMatch(/backed up|in the cloud|已备份|云端|Google/i);
  });
});

describe("the gate closed (the store build): the backup in Chrome sync's line, no live sync's", () => {
  it("every state of the card, in a few of its words, with its tone; never a line of the live sync", async () => {
    const draw = await railOf(false);
    const now = Date.now();
    for (const [name, cfg, st] of states(now)) {
      draw({ lastBackup: null, csb: recs(cfg, st), syncLine: { text: "On", tone: "good" } });
      const [text, tone] = WANT[name]!;
      expect(root.byId("rail-csb")?.textContent, name).toBe(text);
      expect(byClass("csb")[0]!.getAttribute("class"), name).toBe(`csb ${tone}`);
      expect(root.byId("rail-sync"), name).toBeNull();
      expect(byClass("sync"), name).toEqual([]);
      expect(
        rows().map((r) => r[1]),
        name,
      ).toEqual(["Accounts", "Last backup", "Chrome Sync"]);
    }
  });
  it("the records not read yet: the line waits, with no tone", async () => {
    const draw = await railOf(false);
    draw({ lastBackup: null, csb: null });
    expect(root.byId("rail-csb")!.textContent).toBe("…");
    expect(byClass("csb")[0]!.getAttribute("class")).toBe("csb none");
    expect(root.byId("rail-sync")).toBeNull();
  });
  it("in Chinese, the same states in the card's words", async () => {
    const draw = await railOf(false, "zh_CN");
    const now = Date.now();
    const said = (cfg: Partial<CsbConfig>, st: Partial<CsbState>) => {
      draw({ lastBackup: null, csb: recs(cfg, st) });
      return rows()[2];
    };
    const ago3 = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(-3, "minute");
    expect(said({}, {})).toEqual(["csb none", "Chrome 同步", "未开启"]);
    expect(said({ on: true }, { lastRun: now })).toEqual(["csb none", "Chrome 同步", "已开启"]);
    expect(said({ on: true }, { pendingSince: now })).toEqual(["csb none", "Chrome 同步", "正在交给…"]);
    expect(said({ on: true }, { lastOk: now - 9 * MIN, pendingSince: now - MIN })).toEqual([
      "csb none",
      "Chrome 同步",
      "稍后自动交给",
    ]);
    expect(said({ on: true }, { lastOk: now - 3 * MIN })).toEqual(["csb good", "Chrome 同步", `已交给 · ${ago3}`]);
    expect(said({ on: true }, { err: "other", errSince: now, pendingSince: now })).toEqual([
      "csb warn",
      "Chrome 同步",
      "没交给 · 会自动重试",
    ]);
    expect(said({ on: true }, { err: "held", errSince: now })).toEqual(["csb warn", "Chrome 同步", "备份已停"]);
    expect(msg("zh_CN", "railCsbOk", ago3)).toBe(`已交给 · ${ago3}`);
  });
  it("in a browser that is not Google Chrome, its own word for it, as the card and the pill say", async () => {
    vi.stubGlobal("navigator", EDGE);
    for (const [lang, label] of [
      ["en", "Browser sync"],
      ["zh_CN", "浏览器同步"],
    ] as const) {
      const draw = await railOf(false, lang);
      draw({ lastBackup: null, csb: recs({ on: true }, { lastOk: Date.now() - MIN }) });
      expect(rows()[2]![1], lang).toBe(label);
    }
  });
  it("the time goes on while the page is open: how long ago is drawn again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const draw = await railOf(false);
    draw({ lastBackup: null, csb: recs({ on: true }, { lastOk: Date.now() - 3 * MIN }) });
    expect(root.byId("rail-csb")!.textContent).toBe("Handed over · 3 minutes ago");
    act(() => void vi.advanceTimersByTime(2 * MIN));
    expect(root.byId("rail-csb")!.textContent).toBe("Handed over · 5 minutes ago");
    // and the state with it: changes waiting for three days are the stop
    draw({
      lastBackup: null,
      csb: recs({ on: true }, { lastOk: Date.now() - 4 * DAY, pendingSince: Date.now() - (3 * DAY - MIN) }),
    });
    expect(root.byId("rail-csb")!.textContent).toBe("Handing over soon");
    act(() => void vi.advanceTimersByTime(MIN));
    expect(root.byId("rail-csb")!.textContent).toBe("Backup stopped");
  });
  it("one timer while the backup is on, however often drawn; none once it is off, or the rail is gone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const draw = await railOf(false);
    const on = (lastOk: number) => draw({ lastBackup: null, csb: recs({ on: true }, { lastOk }) });
    draw({ lastBackup: null, csb: null });
    expect(vi.getTimerCount()).toBe(0); // the records not read yet
    on(Date.now() - 3 * MIN);
    expect(vi.getTimerCount()).toBe(1);
    for (let i = 0; i < 4; i++) on(Date.now() - i * MIN); // the records change (each run the worker makes)
    act(() => void vi.advanceTimersByTime(2 * MIN)); // and the rail draws itself again
    expect(vi.getTimerCount()).toBe(1);
    draw({ lastBackup: null, csb: recs({}, {}) }); // turned off
    expect(vi.getTimerCount()).toBe(0);
    on(Date.now() - MIN);
    expect(vi.getTimerCount()).toBe(1);
    act(() => render(null, root as unknown as Element)); // the page leaves the rail (the wizard, a reload)
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the gate open: the backup in Chrome sync's line is not drawn, so it keeps no timer", () => {
  it("none, the backup on and drawn again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const draw = await railOf(true);
    for (let i = 0; i < 3; i++) draw({ lastBackup: null, csb: recs({ on: true }, { lastOk: Date.now() - MIN }) });
    act(() => void vi.advanceTimersByTime(2 * MIN));
    expect(vi.getTimerCount()).toBe(0);
    expect(root.byId("rail-csb")).toBeNull();
  });
});

describe("the gate open (dev and e2e builds): the live sync's line exactly as before, none of the backup's", () => {
  it("off, not known yet, and the section's line with its tone, whatever the backup in Chrome sync does", async () => {
    const draw = await railOf(true);
    const now = Date.now();
    for (const [name, cfg, st] of states(now)) {
      const csb = recs(cfg, st);
      draw({ lastBackup: null, csb });
      expect(root.byId("rail-sync")?.textContent, name).toBe("Off · this device");
      expect(byClass("sync")[0]!.getAttribute("class"), name).toBe("sync");
      expect(root.byId("rail-csb"), name).toBeNull();
      expect(byClass("csb"), name).toEqual([]);
      expect(
        rows().map((r) => r[1]),
        name,
      ).toEqual(["Accounts", "Last backup", "Sync"]);
      draw({ lastBackup: null, csb, syncLine: null });
      expect(root.byId("rail-sync")?.textContent, name).toBe("…");
      expect(byClass("sync")[0]!.getAttribute("class"), name).toBe("sync");
      for (const tone of ["none", "good", "warn", "bad"] as const) {
        draw({ lastBackup: null, csb, syncLine: { text: "On · 2 devices", tone } });
        expect(root.byId("rail-sync")?.textContent, name).toBe("On · 2 devices");
        expect(byClass("sync")[0]!.getAttribute("class"), name).toBe(`sync ${tone}`);
      }
    }
  });
});

describe("the last backup's line: its own date, no reminder while the backup in Chrome sync runs", () => {
  for (const gate of [false, true])
    it(`never, an old date and a recent one, in every state (gate ${gate ? "open" : "closed"})`, async () => {
      const draw = await railOf(gate);
      const now = Date.now();
      for (const [name, cfg, st, runs] of states(now)) {
        const csb = recs(cfg, st);
        draw({ lastBackup: null, csb });
        expect(freshClass(), `${name}, never`).toBe(runs ? "fresh none" : "fresh bad");
        expect(rows()[1]![2], name).toBe("Never");
        draw({ lastBackup: now - 8 * DAY, csb });
        expect(freshClass(), `${name}, 8 days`).toBe(runs ? "fresh none" : "fresh warn");
        expect(rows()[1]![2], name).toBe("8 days ago");
        draw({ lastBackup: now - DAY, csb });
        expect(freshClass(), `${name}, a day`).toBe("fresh good");
      }
      // the records not read yet: as before, a reminder
      draw({ lastBackup: null, csb: null });
      expect(freshClass()).toBe("fresh bad");
    });
});
