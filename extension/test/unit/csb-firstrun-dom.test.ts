// First run's parts of the backup in Chrome's sync storage (src/options/FirstRun.tsx with src/options/csb/), and
// Settings › Backup's "Choose file" with a downloaded copy, rendered by Preact into a minimal document over two
// computers' real services, stores and workers (test/helpers/csb-pages.ts): the copy one computer handed to its
// storage.sync is given to the other's as Chrome sync would deliver it.
//   - A copy found before the first step, or arriving while the page is open: "从 Chrome 同步恢复" first, "新建" kept.
//   - The last step's box: ticked for "only me", cleared for a shared profile, with what it costs; ticked, the backup
//     is turned on after "完成" (an empty vault is never written); cleared where it was ticked, recorded as the person's
//     turning it off (sk-csb-off, as the card's 关闭: the popup's 立即备份 then turns nothing on), and a backup that was
//     on already (a first run over data that could not be read) is turned off, another vault's copy kept; never ticked
//     (a shared profile), nothing is sent.
//   - The restore: by the master password and by the recovery key (a new master password first, under the same gate),
//     a wrong one and a mistyped key said; a copy still arriving waited for; adopted under the generation the restore
//     wrote, sent inside the store's lock; the worker's "not that generation" and "slot changed" each merged again once;
//     then, or for another vault's copy, a new copy of this computer's own; refused where the area
//     could not be closed to web pages, said.
//   - What it found, at the end (SetupReady): the lines that apply; the newer master password elsewhere.
//   - A downloaded copy chosen with no readable vault: its own words (none of Google Drive's), restored through first
//     run, the result's lines at the end, and the backup turned on (a file has no copy to continue).
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import csbEn from "../../catalogs/csb-en.json";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { openWithPassword } from "../../src/core/crypto/keyring";
import { aliveEntries } from "../../src/core/vault/model";
import { CSB_CFG_KEY, CSB_STATE_KEY, type CsbConfig, type CsbState } from "../../src/platform/csb-config";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice, t } from "../../src/ui/i18n";
import { FakeSyncArea } from "../helpers/fake-sync-area";
import { readSlots } from "../../src/core/cloud/slots";
import { account, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import { computer, STRONG, T0, type Computer } from "../helpers/csb-pages";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";

const cs = (k: keyof typeof csbEn, ...subs: (string | number)[]) =>
  csbEn[k].message.replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1]));
const NEW_PASSWORD = "Basalt#Meadow4!Quill9$Fern";
const CHROME = { userAgentData: { brands: [{ brand: "Google Chrome" }] } };
const proto = MiniElement.prototype as unknown as Record<string, unknown>;
proto.querySelector ??= () => null; // first run focuses each later step's heading
proto.scrollIntoView ??= () => undefined; // SetupReady brings itself into view

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
let FirstRun: typeof import("../../src/options/FirstRun").FirstRun;
let SetupReady: typeof import("../../src/options/FirstRun").SetupReady;
let Backup: typeof import("../../src/options/Backup").Backup;
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
  ({ FirstRun, SetupReady } = await import("../../src/options/FirstRun"));
  ({ Backup } = await import("../../src/options/Backup"));
});
beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body as MiniElement;
  Object.assign(dom.doc, { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
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
const shown = (id: string, timeout = 15_000) => vi.waitFor(() => expect(byId(id), id).not.toBeNull(), { timeout });
function click(id: string) {
  const el = byId(id);
  expect(el, id).not.toBeNull();
  act(() => void el!.dispatch("click"));
}
function type(id: string, value: string) {
  const el = byId(id)!;
  (el as unknown as { value: string }).value = value;
  act(() => void el.dispatch("input"));
}
function tick(id: string, on: boolean) {
  const el = byId(id)!;
  el.checked = on;
  act(() => void el.dispatch("change"));
}
function submit(id: string) {
  let form = byId(id)!.parentNode as MiniElement;
  while (form.localName !== "form") form = form.parentNode as MiniElement;
  act(() => void form.dispatch("submit"));
}

/** Computer A with a vault of `names`, its backup on and written: its storage.sync as it is then. */
async function written(...names: string[]) {
  const a = computer();
  const code = await a.makeVault();
  await a.add(...names);
  await a.worker.on();
  await a.worker.idle();
  return { a, code, items: a.area.snapshot() };
}
/** A fresh computer whose storage.sync already holds `items` (Chrome sync delivered them). */
function fresh(items: Record<string, unknown> = {}): Computer {
  return computer({ area: new FakeSyncArea({ items }) });
}

/** First run on computer `c`, from `start`; what it handed the page at its end. */
function firstRun(c: Computer, start: unknown, more: Record<string, unknown> = {}) {
  vi.stubGlobal("chrome", c.chrome);
  const done: Record<string, unknown>[] = [];
  act(() =>
    render(
      h(FirstRun, {
        rt: c.rt,
        start,
        onExit: () => undefined,
        onDone: (r: unknown) => void done.push(r as Record<string, unknown>),
        onRefresh: async () => undefined,
        onHolding: () => undefined,
        ...more,
      } as never),
      root as unknown as Element,
    ),
  );
  return { done };
}
/** The new vault's steps up to the last one: the master password, the recovery code confirmed saved. */
async function toLastStep() {
  await shown("fr-pw");
  type("fr-pw", STRONG);
  type("fr-pw2", STRONG);
  await vi.waitFor(() => expect(byId("fr-next")!.disabled).toBe(false), { timeout: 15_000 });
  submit("fr-pw");
  await shown("recovery-saved", 30_000);
  tick("recovery-saved", true);
  click("recovery-done");
  await shown("fr-solo");
}
const cfgOf = async (c: Computer) => (await c.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY] as CsbConfig | undefined;

describe("first run, a new vault", () => {
  it("back from the recovery code to the master password, and from the profile step to the code (owner, 2026-11-18)", async () => {
    const c = fresh();
    const { done } = firstRun(c, { mode: "create" }, { onSwitch: () => undefined });
    await shown("fr-pw");
    type("fr-pw", STRONG);
    type("fr-pw2", STRONG);
    await vi.waitFor(() => expect(byId("fr-next")!.disabled).toBe(false), { timeout: 15_000 });
    submit("fr-pw");
    await shown("recovery-saved", 30_000);
    const first = text("recovery-code");
    click("fr-back-password");
    await shown("fr-pw");
    expect(c.types()).toEqual([]); // nothing written going back
    type("fr-pw", NEW_PASSWORD);
    type("fr-pw2", NEW_PASSWORD);
    await vi.waitFor(() => expect(byId("fr-next")!.disabled).toBe(false), { timeout: 15_000 });
    submit("fr-pw");
    await shown("recovery-saved", 30_000);
    expect(text("recovery-code")).not.toBe(first); // new keys for the new password
    tick("recovery-saved", true);
    click("recovery-done");
    await shown("fr-solo");
    click("fr-back");
    await shown("recovery-saved");
    tick("recovery-saved", true);
    click("recovery-done");
    await shown("fr-solo");
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 15_000 });
    const gen = (await c.service.currentGeneration())!;
    expect((await openWithPassword(gen.keyring, NEW_PASSWORD)).vk.id).toBe(gen.keyring.vkId);
  }, 120_000);

  it("a copy in Chrome Sync, found above the first step: its restore first, a new vault kept", async () => {
    const { items } = await written("GitHub");
    const b = fresh(items);
    const switched: unknown[] = [];
    firstRun(b, { mode: "create" }, { onSwitch: (s: unknown) => void switched.push(s) });
    await shown("cs-found");
    expect(text("cs-found")).toMatch(/^Found a Sixkey backup in Chrome Sync \(latest .+\)\. Restore from Chrome Sync$/);
    expect(byId("fr-pw")).not.toBeNull(); // "新建" stays
    expect(byId("fr-to-restore")).not.toBeNull();
    click("cs-found-restore");
    expect(switched).toEqual([{ mode: "csb" }]);
    click("fr-to-csb"); // the restore from Chrome Sync is offered with nothing found too
    expect(switched).toEqual([{ mode: "csb" }, { mode: "csb" }]);
  }, 60_000);

  it("one that arrives while the page is open: said as just arrived", async () => {
    const { items } = await written("GitHub");
    const b = fresh();
    firstRun(b, { mode: "create" }, { onSwitch: () => undefined });
    await shown("fr-to-csb");
    await settle();
    expect(byId("cs-found")).toBeNull();
    b.area.remote.put(items);
    b.area.remote.deliverAll();
    await shown("cs-found");
    expect(text("cs-found")).toBe(`${cs("csArrived")} ${cs("csRestore")}`);
  }, 60_000);

  it("the last step's box: ticked for 'only me' with its cost, cleared for shared; ticked, the backup is on", async () => {
    const c = fresh();
    const { done } = firstRun(c, { mode: "create" }, { onSwitch: () => undefined });
    await toLastStep();
    await shown("fr-csb");
    expect(byId("fr-csb")!.checked).toBe(true);
    expect(text("fr-csb-cost")).toBe(`${cs("csCost")} ${cs("csHonest")}`);
    expect(byId("fr-csb-shared")).toBeNull();
    tick("fr-shared", true);
    await settle();
    expect(byId("fr-csb")!.checked).toBe(false); // a shared profile: not ticked
    expect(text("fr-csb-shared")).toBe(cs("csShared"));
    tick("fr-solo", true);
    await settle();
    expect(byId("fr-csb")!.checked).toBe(true);
    expect(c.types()).toEqual([]); // nothing before 完成
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 15_000 });
    expect(c.types()).toEqual(["sk-csb-on"]);
    expect(done[0]).toEqual({ backup: "on" });
    expect((await cfgOf(c))?.on).toBe(true);
    await c.worker.idle();
    // the owner's report of 2026-11-17: the vault, empty still, is handed over at once, so a second computer finds it
    expect(Object.keys(c.area.snapshot()).length).toBeGreaterThan(0);
  }, 90_000);

  it("the box cleared: recorded as the person's turning the backup off, nothing written; cleared by hand, a profile change leaves it so", async () => {
    const c = fresh();
    const { done } = firstRun(c, { mode: "create" }, { onSwitch: () => undefined });
    await toLastStep();
    await shown("fr-csb");
    tick("fr-csb", false);
    await settle();
    tick("fr-shared", true);
    tick("fr-solo", true);
    await settle();
    expect(byId("fr-csb")!.checked).toBe(false);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 15_000 });
    expect(c.types()).toEqual(["sk-csb-off"]); // as the card's 关闭: off, and turned off by the person
    expect(await cfgOf(c)).toEqual({ v: 1, on: false, opens: "both", declined: true, link: null });
    expect(c.area.snapshot()).toEqual({});
  }, 90_000);

  it("cleared, then the popup's 立即备份 after a week: the card it opens turns nothing on; ticked, the backup is on as before", async () => {
    const { CsbCard } = await import("../../src/options/csb/CsbCard");
    const c = fresh();
    const { done } = firstRun(c, { mode: "create" }, { onSwitch: () => undefined });
    await toLastStep();
    await shown("fr-csb");
    tick("fr-csb", false);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 15_000 });
    act(() => render(null, root as unknown as Element));
    await c.add("GitHub");
    await c.session.set({ sk_cloud_go: Date.now() }); // what the popup's footer leaves (src/popup/main/CsbPop.tsx)
    const vault = (await c.service.read()).vault;
    act(() =>
      render(h(CsbCard, { rt: c.rt, unlocked: true, vault, onSaveFile: () => undefined }), root as unknown as Element),
    );
    await settle();
    await vi.waitFor(async () => expect(await c.session.get(["sk_cloud_go"])).toEqual({})); // taken
    await settle();
    expect(c.types()).toEqual(["sk-csb-off"]); // nothing more: not turned on
    expect(await cfgOf(c)).toMatchObject({ on: false, declined: true });
  }, 90_000);

  it("a shared profile: the box never ticked, so finishing records nothing and sends nothing", async () => {
    const c = fresh();
    firstRun(c, { mode: "create" }, { onSwitch: () => undefined });
    await toLastStep();
    await shown("fr-csb");
    tick("fr-shared", true);
    await settle();
    expect(byId("fr-csb")!.checked).toBe(false);
    click("fr-finish");
    await shown("fr-clip-next", 15_000);
    await settle();
    expect(c.types()).toEqual([]);
    expect(await cfgOf(c)).toBeUndefined();
  }, 90_000);
});

describe("first run over data that could not be read, whose backup was on", () => {
  /** A computer with its backup on and written, whose data can then no longer be read. */
  async function lostWithBackup() {
    const c = computer();
    await c.makeVault();
    await c.add("GitHub");
    await c.worker.on();
    await c.worker.idle();
    for (const k of await c.kv.keys()) if (/^sk_(slot_|snap|keyring)/.test(k)) await c.kv.remove([k]);
    await c.kv.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } });
    expect((await c.service.status()).state).toBe("lost");
    return c;
  }

  it("started over with the box cleared: the backup is off, and the old vault's copy stays in Chrome Sync", async () => {
    const c = await lostWithBackup();
    const before = c.area.snapshot();
    const { done } = firstRun(c, { mode: "startOver" });
    await toLastStep();
    await shown("fr-csb");
    tick("fr-csb", false);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(c.types()).toEqual(["sk-csb-off"]);
    expect((await cfgOf(c))?.on).toBe(false);
    expect(c.area.snapshot()).toEqual(before); // perhaps the old vault's only copy: kept
  }, 90_000);

  it("restored from Chrome Sync over it with the box cleared: the backup is off, its copy left as it was", async () => {
    const c = await lostWithBackup();
    const before = c.area.snapshot();
    const { done } = firstRun(c, { mode: "csb" });
    await shown("cs-restore-secret");
    type("cs-restore-secret", STRONG);
    submit("cs-restore-secret");
    await shown("fr-csb", 20_000);
    tick("fr-csb", false);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(done[0]).toMatchObject({ restored: 1, backup: "off" });
    expect(c.types()).toEqual(["sk-csb-off"]); // no adoption, and off
    expect((await cfgOf(c))?.on).toBe(false);
    expect(c.area.snapshot()).toEqual(before);
  }, 90_000);

  it("a backup file restored over it with the box ticked: turned on, and the vault's copy written", async () => {
    const c = await lostWithBackup();
    const keys = await protectedKeys(STRONG);
    const created = Date.now();
    const vault = vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ")]);
    const { done } = firstRun(c, { mode: "restore", backup: { vault, created } });
    await toLastStep();
    await shown("fr-csb");
    expect(byId("fr-csb")!.checked).toBe(true);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(done[0]).toMatchObject({ restored: 1, backup: "on" });
    expect(c.types()).toEqual(["sk-csb-on"]);
    await c.worker.idle();
    const link = (await cfgOf(c))!.link!;
    expect(link.vaultId).toBe(vault.vaultId); // its own copy: the old vault's left as it was
  }, 90_000);
});

describe("first run, the restore from Chrome Sync", () => {
  it("Chrome Sync that cannot be read: said, not 'looking' for ever", async () => {
    const b = fresh();
    b.area.fail.get = ["the area is not there"];
    firstRun(b, { mode: "csb" });
    await shown("cs-read-failed");
    expect(text("cs-read-failed")).toBe(cs("csReadFailed"));
    expect(byId("cs-looking")).toBeNull();
  });

  it("by the master password: restored, and the copy continued under the generation the restore wrote", async () => {
    const { a, items } = await written("GitHub", "Proton");
    const b = fresh(items);
    const { done } = firstRun(b, { mode: "csb" });
    await shown("cs-found-n");
    expect(text("cs-found-n")).toBe(cs("csFound", 1));
    expect(byId("cs-restore-cost")).toBeNull(); // nothing promised before the last step's box
    expect(root.all((e) => e.localName === "li")[0]?.textContent).toBe(`1${cs("csStep")}`); // its number, its name
    type("cs-restore-secret", "not the password");
    submit("cs-restore-secret");
    await vi.waitFor(() => expect(text("cs-wrong")).toBe(cs("csWrong")), { timeout: 20_000 });
    type("cs-restore-secret", STRONG);
    submit("cs-restore-secret");
    await shown("fr-solo", 20_000);
    expect(byId("fr-pw")).toBeNull(); // the keys as restored
    await shown("fr-csb");
    expect(byId("fr-csb")!.checked).toBe(true);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(done[0]).toMatchObject({ restored: 2, backup: "adopted" });
    const m = b.sent.find((x) => x.type === "sk-csb-restored")!;
    const gen = (await b.service.currentGeneration())!;
    const aLink = (await cfgOf(a))!.link!;
    expect(m).toMatchObject({ slot: aLink.slot, gen: aLink.gen, seq: gen.seq, sum: gen.envelope.checksum });
    expect(m.dirty).toBe(false);
    expect(b.lockedAt[b.sent.indexOf(m)]).toBe(true); // sent from inside the store's lock that wrote the restore
    const link = (await cfgOf(b))!.link!;
    expect(link.slot).toBe(aLink.slot); // this computer goes on with the copy it came from
    expect((await b.kv.get([CSB_STATE_KEY]))[CSB_STATE_KEY]).toMatchObject({ seen: true });
    expect(
      aliveEntries((await b.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Proton"]);
    // the end says it goes on, now that the box was ticked and the copy taken
    act(() => render(h(SetupReady, { rt: b.rt, ...done[0] } as never), root as unknown as Element));
    await shown("cs-backup-note");
    expect(text("cs-backup-note")).toBe(cs("csAfter"));
  }, 90_000);

  it("by the recovery key: a new master password first, under the same gate; the copy continued with it", async () => {
    const { code, items } = await written("GitHub");
    const b = fresh(items);
    const { done } = firstRun(b, { mode: "csb" });
    await shown("cs-found-n");
    type("cs-restore-secret", code.slice(0, -1) + (code.endsWith("0") ? "1" : "0"));
    submit("cs-restore-secret");
    await vi.waitFor(() => expect(text("cs-wrong")).toBe(cs("csKeyTypo")), { timeout: 20_000 });
    type("cs-restore-secret", code);
    submit("cs-restore-secret");
    await shown("fr-pw", 20_000);
    // the copy had a master password: going on with it is offered first, a new one below (a forgotten password)
    await vi.waitFor(() => expect(text("cs-keep-line")).toBe(cs("csKeepPasswordLine")));
    expect(byId("cs-keep-password")).not.toBeNull();
    expect(byId("cs-need-password")).toBeNull();
    // the master password's gate, as a new vault's: below it, the button waits for "Use anyway"
    type("fr-pw", "password1");
    type("fr-pw2", "password1");
    await settle();
    expect(byId("fr-next")!.disabled).toBe(true);
    type("fr-pw", NEW_PASSWORD);
    type("fr-pw2", NEW_PASSWORD);
    await vi.waitFor(() => expect(byId("fr-next")!.disabled).toBe(false), { timeout: 15_000 });
    submit("fr-pw");
    await shown("fr-solo", 20_000);
    expect(byId("recovery-code")).toBeNull(); // no new recovery key
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(done[0]).toMatchObject({ restored: 1, backup: "adopted" });
    const gen = (await b.service.currentGeneration())!;
    expect((await openWithPassword(gen.keyring, NEW_PASSWORD)).vk.id).toBe(gen.keyring.vkId);
    expect(b.sent.find((x) => x.type === "sk-csb-restored")).toMatchObject({
      seq: gen.seq,
      sum: gen.envelope.checksum,
    });
  }, 120_000);

  it("by the recovery key, keeping the same master password: nothing to type, the copy's password opens it", async () => {
    const { code, items } = await written("GitHub");
    const b = fresh(items);
    const { done } = firstRun(b, { mode: "csb" });
    await shown("cs-found-n");
    type("cs-restore-secret", code);
    submit("cs-restore-secret");
    await shown("cs-keep-password", 20_000);
    click("cs-keep-password");
    await shown("fr-solo", 20_000);
    expect(byId("recovery-code")).toBeNull(); // no new recovery key
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(done[0]).toMatchObject({ restored: 1, backup: "adopted" });
    const gen = (await b.service.currentGeneration())!;
    // the same master password as the computer the copy came from (the owner's report of 2026-11-18)
    expect((await openWithPassword(gen.keyring, STRONG)).vk.id).toBe(gen.keyring.vkId);
  }, 120_000);

  it("only a copy still arriving: said, and the restore goes on once Chrome delivers the rest", async () => {
    const { items } = await written("GitHub");
    const b = fresh();
    b.area.remote.put(items);
    const manifest = Object.keys(items).find((k) => !/\.\d+$/.test(k))!;
    b.area.remote.deliver(manifest);
    firstRun(b, { mode: "csb" });
    await shown("cs-partial-only");
    expect(text("cs-partial-only")).toBe(cs("csPartialOnly"));
    expect(byId("cs-restore-secret")).toBeNull(); // nothing partial is ever used
    b.area.remote.deliverAll();
    await shown("cs-restore-secret");
    expect(byId("cs-partial-only")).toBeNull();
  }, 60_000);

  it("nothing there yet: said, with the step waiting for it", async () => {
    const b = fresh();
    firstRun(b, { mode: "csb" });
    await shown("cs-none");
    expect(text("cs-none")).toBe(cs("csNone"));
  });

  it("a copy still arriving beside a whole one: restored from the whole one, and the other said at the end", async () => {
    const { items } = await written("GitHub");
    const other = await written("Proton");
    const b = fresh(items);
    const half = Object.fromEntries(Object.entries(other.items).filter(([k]) => /\.\d+$/.test(k)));
    await b.area.set(half); // chunks with no manifest: still arriving
    const { done } = firstRun(b, { mode: "csb" });
    await shown("cs-partial");
    expect(text("cs-partial")).toBe(cs("csPartial", 1));
    type("cs-restore-secret", STRONG);
    submit("cs-restore-secret");
    await shown("fr-solo", 20_000);
    tick("fr-csb", false);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(b.types()).toEqual(["sk-csb-off"]); // the box cleared: no adoption, recorded as turned off
    act(() => render(h(SetupReady, { rt: b.rt, ...(done[0] as object) } as never), root as unknown as Element));
    await shown("cs-line-csPartial");
    expect(text("cs-line-csPartial")).toBe(cs("csPartial", 1));
  }, 90_000);
});

describe("the adoption's answers: once more each, then a new copy, never a loop", () => {
  async function restoreWith(answers: Record<string, unknown>[], o: { access?: boolean } = {}) {
    const { items } = await written("GitHub");
    const b = computer({ area: new FakeSyncArea({ items }), ...(o.access === false ? { access: false } : {}) });
    b.answer["sk-csb-restored"] = [...answers];
    const { done } = firstRun(b, { mode: "csb" });
    await shown("cs-restore-secret");
    type("cs-restore-secret", STRONG);
    submit("cs-restore-secret");
    await shown("fr-solo", 20_000);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 30_000 });
    return { b, done: done[0]!, adoptions: b.sent.filter((m) => m.type === "sk-csb-restored") };
  }

  it("the vault changed meanwhile: the restore merged again over it, and adopted under that generation", async () => {
    const { b, done, adoptions } = await restoreWith([{ ok: false, why: "not_that_generation" }]);
    expect(done.backup).toBe("adopted");
    expect(adoptions).toHaveLength(2);
    expect(adoptions[1]!.seq).toBeGreaterThan(adoptions[0]!.seq as number);
    const gen = (await b.service.currentGeneration())!;
    expect(adoptions[1]).toMatchObject({ seq: gen.seq, sum: gen.envelope.checksum });
    expect(adoptions.map((m) => b.lockedAt[b.sent.indexOf(m)])).toEqual([true, true]);
    expect((await cfgOf(b))?.link).not.toBeNull();
  }, 90_000);

  it("the copy changed meanwhile: read again, opened and merged, and adopted under the tag read now", async () => {
    const { done, adoptions } = await restoreWith([{ ok: false, why: "slot_changed" }]);
    expect(done.backup).toBe("adopted");
    expect(adoptions).toHaveLength(2);
    expect(adoptions[1]).toMatchObject({ slot: adoptions[0]!.slot, dirty: true });
  }, 90_000);

  it("an older copy put back before the worker takes it: the restore merged in again, so no account it brought is lost", async () => {
    // A before Proton: an older copy of the same vault, which the store could fall back to
    const a = computer();
    await a.makeVault();
    await a.add("GitHub");
    const older = (await a.service.currentGeneration())!;
    await a.add("Proton");
    await a.worker.on();
    await a.worker.idle();
    const b = fresh(a.area.snapshot());
    b.meanwhile["sk-csb-restored"] = [
      async () => {
        const ptr = (await b.kv.get(["sk_active"]))["sk_active"] as string;
        await b.kv.set({ [`sk_slot_${ptr}`]: { ...older, seq: older.seq + 50 } }); // put back, at a later counter
      },
    ];
    const { done } = firstRun(b, { mode: "csb" });
    await shown("cs-restore-secret");
    type("cs-restore-secret", STRONG);
    submit("cs-restore-secret");
    await shown("fr-solo", 20_000);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 30_000 });
    expect(done[0]).toMatchObject({ backup: "adopted" });
    expect(b.sent.filter((m) => m.type === "sk-csb-restored")).toHaveLength(2); // the worker refused the first
    expect(
      aliveEntries((await b.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Proton"]);
    await b.worker.idle();
    const mine = (await cfgOf(b))!.link!.slot;
    const own = (await readSlots(b.area.snapshot())).slots.find((s) => s.slot === mine)!;
    if (own.read.kind !== "ok") throw new Error("the copy is not whole");
    const [vault] = await b.service.openOwnGenerations([own.read.backup.generation]);
    expect(
      aliveEntries(vault!)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Proton"]); // what the first run wrote into the copy has it too
  }, 120_000);

  it("the copy written again meanwhile (another computer): read again, merged, and adopted under its new tag", async () => {
    const { a, items } = await written("GitHub");
    const first = (await cfgOf(a))!.link!.gen;
    const b = fresh(items);
    b.meanwhile["sk-csb-restored"] = [
      async () => {
        await a.add("Extra"); // the other computer writes its copy again, with one more account
        await a.worker.run();
        await a.worker.idle();
        await b.area.set(a.area.snapshot());
      },
    ];
    const { done } = firstRun(b, { mode: "csb" });
    await shown("cs-restore-secret");
    type("cs-restore-secret", STRONG);
    submit("cs-restore-secret");
    await shown("fr-solo", 20_000);
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 30_000 });
    expect(done[0]).toMatchObject({ backup: "adopted" });
    const adoptions = b.sent.filter((m) => m.type === "sk-csb-restored");
    const now = (await cfgOf(a))!.link!.gen;
    expect(now).not.toBe(first);
    expect(adoptions.map((m) => m.gen)).toEqual([first, now]); // the second under the tag read again
    expect((await cfgOf(b))!.link!.slot).toBe((await cfgOf(a))!.link!.slot); // (dirty: written again at once, its own tag)
    expect(
      aliveEntries((await b.service.read()).vault)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["Extra", "GitHub"]);
  }, 120_000);

  it("not taken twice, or another vault's copy: the backup goes on as a new copy, and the end says so", async () => {
    for (const answers of [
      [
        { ok: false, why: "not_that_generation" },
        { ok: false, why: "not_that_generation" },
      ],
      [{ ok: false, why: "other_vault" }],
    ]) {
      const { b, done, adoptions } = await restoreWith(answers);
      expect(done.backup).toBe("new_copy");
      expect(adoptions).toHaveLength(answers.length);
      expect(b.types().at(-1)).toBe("sk-csb-on");
      act(() => render(h(SetupReady, { rt: b.rt, ...done } as never), root as unknown as Element));
      await shown("cs-backup-note");
      expect(text("cs-backup-note")).toBe(cs("csNewCopy"));
      act(() => render(null, root as unknown as Element));
    }
  }, 180_000);

  it("this browser would not close the area to web pages: refused, nothing turned on, and the end says why", async () => {
    const { b, done, adoptions } = await restoreWith([], { access: false });
    expect(done.backup).toBe("unsafe");
    expect(adoptions).toHaveLength(1);
    expect((await cfgOf(b))?.on ?? false).toBe(false);
    act(() => render(h(SetupReady, { rt: b.rt, ...done } as never), root as unknown as Element));
    await shown("cs-backup-note");
    expect(text("cs-backup-note")).toBe(cs("csUnsafeArea"));
  }, 90_000);
});

describe("Settings › Backup › Choose file, a downloaded copy, with no readable vault", () => {
  /** Settings › Backup on a computer whose vault cannot be read, the copy chosen, `secret` typed: the setups asked. */
  async function choose(c: Computer, json: unknown, secret: string) {
    vi.stubGlobal("chrome", c.chrome);
    const setups: Record<string, unknown>[] = [];
    act(() =>
      render(
        h(Backup, {
          rt: c.rt,
          status: { state: "lost", events: [] } as never,
          vault: null,
          reload: async () => undefined,
          onSetup: (s: unknown) => void setups.push(s as Record<string, unknown>),
        } as never),
        root as unknown as Element,
      ),
    );
    await shown("cs-restore-start"); // the restore from Chrome Sync, where Google Drive's was
    const input = byId("backup-file")!;
    (input as unknown as { files: unknown[] }).files = [{ size: 2000, text: async () => JSON.stringify(json) }];
    act(() => void input.dispatch("change"));
    await shown("open-pw");
    type("open-pw", secret);
    submit("open-pw");
    await settle();
    return setups;
  }

  it("its own words, none of Google Drive's; a wrong secret and a mistyped key said; restored through first run", async () => {
    const { a, code } = await written("GitHub");
    const gen = (await a.service.currentGeneration())!;
    const file = await makeCloudBackup(gen, "both", "x");
    const c = computer();
    let setups = await choose(c, file, "not it");
    expect(root.textContent).toContain(cs("csFile"));
    expect(root.textContent).not.toMatch(/Drive/);
    await vi.waitFor(() => expect(text("backup-error")).toBe(cs("csWrongFile")), { timeout: 20_000 });
    act(() => render(null, root as unknown as Element));
    setups = await choose(c, file, code.slice(0, -1) + (code.endsWith("0") ? "1" : "0"));
    await vi.waitFor(() => expect(text("backup-error")).toBe(cs("csKeyTypo")), { timeout: 20_000 });
    act(() => render(null, root as unknown as Element));
    setups = await choose(c, file, STRONG);
    await vi.waitFor(() => expect(setups).toHaveLength(1), { timeout: 20_000 });
    expect(setups[0]).toMatchObject({ mode: "csb", opened: { slots: false, typed: STRONG } });
    act(() => render(null, root as unknown as Element));
    // first run with it: the step is a file's, the keys as restored; the backup turned on, not adopted
    const { done } = firstRun(c, setups[0]);
    await shown("fr-solo", 20_000);
    expect(root.all((e) => e.localName === "li")[0]?.textContent).toBe(t("frStepFile"));
    await shown("fr-csb");
    click("fr-finish");
    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 20_000 });
    expect(done[0]).toMatchObject({ restored: 1, backup: "on" });
    expect(c.types()).toEqual(["sk-csb-on"]);
    // the end: what the restore found and how the backup goes on, from the backup's own text
    act(() => render(h(SetupReady, { rt: c.rt, ...done[0] } as never), root as unknown as Element));
    await shown("cs-backup-note");
    expect(text("cs-after")).toBe(cs("csBackupOn"));
  }, 120_000);
});

describe("the end of a restore: what it found (CsbAfter)", () => {
  it("each line that applies, with its number; a newer master password elsewhere offered here, or later", async () => {
    const c = computer();
    await c.makeVault();
    vi.stubGlobal("chrome", c.chrome);
    const restore = {
      vault: (await c.service.read()).vault,
      olderKeys: 1,
      skipped: [
        { id: "s1", why: "secret" },
        { id: "s2", why: "damaged" },
      ],
      outdated: true,
      needsPassword: false,
    };
    const opened = { restore, typed: STRONG, partial: 2, unusable: 1, slots: true };
    act(() =>
      render(h(SetupReady, { rt: c.rt, restored: 0, opened, backup: "adopted" } as never), root as unknown as Element),
    );
    await shown("cs-after");
    expect(text("cs-line-csOlderKeys")).toBe(cs("csOlderKeys"));
    expect(text("cs-line-csPartial")).toBe(cs("csPartial", 2));
    expect(text("cs-line-csOtherSecret")).toBe(cs("csOtherSecret", 1));
    expect(text("cs-line-csDamaged")).toBe(cs("csDamaged", 2));
    expect(text("cs-backup-note")).toBe(cs("csAfter")); // adopted: it goes on with that copy
    expect(text("cs-outdated")).toContain(cs("csOutdated"));
    type("cs-pw", NEW_PASSWORD);
    type("cs-pw2", NEW_PASSWORD);
    await vi.waitFor(() => expect(byId("cs-set-new")!.disabled).toBe(false), { timeout: 15_000 });
    submit("cs-pw");
    await shown("cs-new-set", 20_000);
    const gen = (await c.service.currentGeneration())!;
    expect((await openWithPassword(gen.keyring, NEW_PASSWORD)).vk.id).toBe(gen.keyring.vkId);
  }, 60_000);

  it("after a recovery-key restore, a newer key elsewhere: one line, and no master password form", async () => {
    const c = computer();
    await c.makeVault();
    vi.stubGlobal("chrome", c.chrome);
    const restore = {
      vault: (await c.service.read()).vault,
      olderKeys: 0,
      skipped: [],
      outdated: true,
      needsPassword: true,
      keepsPassword: false,
    };
    act(() =>
      render(
        h(SetupReady, {
          rt: c.rt,
          restored: 0,
          opened: { restore, typed: "x", partial: 0, unusable: 0, slots: true },
        } as never),
        root as unknown as Element,
      ),
    );
    await shown("cs-after");
    expect(text("cs-line-csOutdatedKey")).toBe(cs("csOutdatedKey"));
    expect(byId("cs-outdated")).toBeNull();
  });
});

describe("what the one field holds (open.ts)", () => {
  it("a master password shaped like a recovery key opens the copies as one; the recovery key as itself", async () => {
    const SHAPED = "ablaze-abroad-accent-abide-acorn"; // Sixkey's own five-word kind, shaped like a recovery key
    const keys = await protectedKeys(SHAPED);
    const gen = await seal(keys, vaultOf(keys.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]), 3);
    const backup = await makeCloudBackup(gen, "both", "x");
    const { openBackups } = await import("../../src/options/csb/open");
    const copies = [{ id: "abcd1234", head: "0123456789abcdef", modified: T0, backup }];
    const o = { now: T0, device: "device01" };
    expect(await openBackups(copies, SHAPED, o)).toMatchObject({ needsPassword: false });
    expect(await openBackups(copies, keys.recoveryCode, o)).toMatchObject({
      needsPassword: false,
      keepsPassword: true,
    });
    expect(await openBackups(copies, "not it", o)).toBeNull();
  }, 60_000);
});
