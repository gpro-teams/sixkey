// The grant store after the plugin platform was removed (2026-11-12; src/core/plugins/store.ts builtinOnly): what an
// earlier version stored for other plugins (approvals in the tagged record, overlay entries, pauses, a failed record's
// plugins kept aside) still reads safely, so the record verifies and autofill's switch is read from it as before; none of
// it is returned by any read, so nothing honours or draws it; and the next record written leaves it out, as it leaves
// out whatever a write's change adds for another plugin, while a failed record an earlier version kept aside is removed
// then and none is kept. Nothing in the extension can grant it either: the catalog is the built-in's entry alone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOFILL_ID, autofillOn, autofillSwitched } from "../../src/core/plugins/builtin";
import {
  approved,
  emptyBody,
  GRANTS_KEY,
  grantKey,
  OVERLAY_KEY,
  PAUSES_KEY,
  parseRecord,
  seal,
  UNVERIFIED_KEY,
  verify,
  type GrantBody,
  type GrantRecord,
} from "../../src/core/plugins/grants";
import { GrantStore } from "../../src/core/plugins/store";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { desc, keysOf, LISTED, newVk, PID, world as allWorld } from "../helpers/plugins";

/** A grant store as the extension builds one (src/platform/plugins/chrome.ts): no `entries`, so the default. */
function world() {
  const local = new MemoryKV();
  const session = new MemoryKV();
  return { local, session, store: new GrantStore({ local, session, lock: createMutex(), now: () => 1_000 }) };
}

afterEach(() => vi.unstubAllGlobals());

/** The record an earlier version wrote: two plugins approved (one of them for the account list), and autofill off. */
async function earlier(vk: Awaited<ReturnType<typeof newVk>>): Promise<GrantRecord> {
  let body: GrantBody = { ...emptyBody(), epoch: 3 };
  body = approved(body, { descriptor: desc(PID), granted: ["ui.slots", "env.read"], now: 10 });
  body = approved(body, { descriptor: desc(LISTED), granted: ["ui.slots", "accounts.read"], now: 11 });
  body = autofillSwitched(body, false, 12);
  return seal(await grantKey(vk.raw), body);
}
const ids = (es: readonly { pluginId: string }[]) => es.map((e) => e.pluginId);

describe("an earlier version's plugin data, after the plugin platform went", () => {
  it("the record still verifies and autofill's Off is read from it; no read returns another plugin", async () => {
    const w = world();
    const vk = await newVk();
    const rec = await earlier(vk);
    await w.local.set({ [GRANTS_KEY]: rec });
    expect(await verify(await grantKey(vk.raw), rec)).toBe(true); // as stored: the tag covers every entry
    const v = await w.store.read(keysOf(vk));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(ids(v.plugins)).toEqual([AUTOFILL_ID]);
    expect(autofillOn(v.plugins)).toBe(false); // the user's Off holds
    expect(v.review).toEqual([]);
    const u = await w.store.unverified();
    expect(ids(u.plugins)).toEqual([AUTOFILL_ID]);
    expect(autofillOn(u.plugins)).toBe(false);
  });

  it("the next record written leaves the other plugins out, tagged under the vault key", async () => {
    const w = world();
    const vk = await newVk();
    await w.local.set({ [GRANTS_KEY]: await earlier(vk) });
    await w.store.setAutofill(keysOf(vk), true);
    const stored = parseRecord((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]);
    expect(stored && stored !== "damaged").toBe(true);
    if (!stored || stored === "damaged") return;
    expect(ids(stored.plugins)).toEqual([AUTOFILL_ID]);
    expect(autofillOn(stored.plugins)).toBe(true);
    expect(await verify(await grantKey(vk.raw), stored)).toBe(true);
    expect(stored.epoch).toBeGreaterThan(3);
  });

  it("an overlay entry and a pause for another plugin: neither is returned, and the overlay goes at the merge", async () => {
    const w = world();
    const vk = await newVk();
    await w.local.set({
      [GRANTS_KEY]: await earlier(vk),
      [OVERLAY_KEY]: { v: 1, entries: [{ pluginId: PID, action: "suspend", reason: "changed", at: 20 }] },
    });
    await w.session.set({ [PAUSES_KEY]: { v: 1, pauses: [{ pluginId: LISTED, since: 30 }] } });
    const v = await w.store.read(keysOf(vk));
    expect(v.ok && ids(v.plugins)).toEqual([AUTOFILL_ID]);
    expect(v.pauses).toEqual([]);
    expect((await w.store.unverified()).pauses).toEqual([]);
    // the read merged the pending overlay (a tagged write): the record holds autofill alone, the overlay is gone
    const l = await w.local.get([GRANTS_KEY, OVERLAY_KEY]);
    expect(l[OVERLAY_KEY]).toBeUndefined();
    const stored = parseRecord(l[GRANTS_KEY]);
    expect(stored && stored !== "damaged" && ids(stored.plugins)).toEqual([AUTOFILL_ID]);
  });

  it("a record whose tag fails: autofill's Off still read tighten-only, nothing of the others listed or honoured", async () => {
    const w = world();
    const vk = await newVk();
    const rec = await earlier(vk);
    await w.local.set({
      [GRANTS_KEY]: { ...rec, tag: (rec.tag[0] === "A" ? "B" : "A") + rec.tag.slice(1) },
      [UNVERIFIED_KEY]: { v: 1, plugins: rec.plugins }, // kept aside by an earlier version's write
    });
    const v = await w.store.read(keysOf(vk));
    expect(v.ok).toBe(false);
    expect(ids(v.review)).not.toContain(PID); // listed for nothing: no screen reviews another plugin any more
    expect(ids(v.review)).not.toContain(LISTED);
    const u = await w.store.unverified();
    expect(ids(u.plugins)).toEqual([AUTOFILL_ID]);
    expect(autofillOn(u.plugins)).toBe(false);
    // a flip writes a new record, the Off carried into it until the user's On; the others are not in it, and the
    // record kept aside is removed, none kept in its place
    await w.store.setAutofill(keysOf(vk), true);
    const l = await w.local.get([GRANTS_KEY, UNVERIFIED_KEY]);
    const stored = parseRecord(l[GRANTS_KEY]);
    expect(stored && stored !== "damaged" && ids(stored.plugins)).toEqual([AUTOFILL_ID]);
    expect(l[UNVERIFIED_KEY]).toBeUndefined();
  });

  it("no write keeps another plugin's entry, whatever its change adds: written without it, returned without it", async () => {
    const vk = await newVk();
    const approveOther = (b: GrantBody) => approved(b, { descriptor: desc(PID), granted: ["ui.slots"], now: 50 });
    const w = world();
    const rec = await w.store.write(keysOf(vk), (b) => approveOther(autofillSwitched(b, false, 40)));
    expect(ids(rec.plugins)).toEqual([AUTOFILL_ID]);
    const stored = parseRecord((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]);
    expect(stored && stored !== "damaged" && ids(stored.plugins)).toEqual([AUTOFILL_ID]);
    expect(JSON.stringify([...w.local.data.values()])).not.toContain(PID);
    // a book-keeping write whose only change is another plugin's entry changes nothing: nothing is written
    const before = (await w.local.get([GRANTS_KEY]))[GRANTS_KEY];
    expect(await w.store.write(keysOf(vk), approveOther, { onlyVerifiedChange: true })).toBeNull();
    expect((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]).toEqual(before);
    // nor is another plugin's entry in what `change` is given: an earlier record's are left out before it runs
    const e = world();
    await e.local.set({ [GRANTS_KEY]: await earlier(vk) });
    let given: string[] = [];
    await e.store.write(keysOf(vk), (b) => ((given = ids(b.plugins)), b));
    expect(given).toEqual([AUTOFILL_ID]);
    // the same write where every plugin's entries are kept (the store's own tests) keeps it: the default is the rule
    const all = allWorld(() => 1_000, "all");
    await all.store.write(keysOf(vk), approveOther);
    const kept = parseRecord((await all.local.get([GRANTS_KEY]))[GRANTS_KEY]);
    expect(kept && kept !== "damaged" && ids(kept.plugins)).toEqual([PID]);
  });

  it("a failed record an earlier version kept aside is removed at the next tagged write, and none is kept", async () => {
    const vk = await newVk();
    const rec = await earlier(vk);
    // beside a record that verifies: removed by the next write, whatever it changes
    const w = world();
    await w.local.set({ [GRANTS_KEY]: rec, [UNVERIFIED_KEY]: { v: 1, plugins: rec.plugins } });
    await w.store.write(keysOf(vk), (b) => b);
    expect((await w.local.get([UNVERIFIED_KEY]))[UNVERIFIED_KEY]).toBeUndefined();
    // a record that fails, nothing kept yet: the new record takes its place, keeping autofill's Off; nothing kept
    const f = world();
    await f.local.set({ [GRANTS_KEY]: rec });
    await f.store.write(keysOf(await newVk()), (b) => b);
    const l = await f.local.get([GRANTS_KEY, UNVERIFIED_KEY]);
    expect(l[UNVERIFIED_KEY]).toBeUndefined();
    const stored = parseRecord(l[GRANTS_KEY]);
    expect(stored && stored !== "damaged" && ids(stored.plugins)).toEqual([AUTOFILL_ID]);
    expect(stored && stored !== "damaged" && autofillOn(stored.plugins)).toBe(false);
    // a new vault over a record of the old one, and a record kept aside before: neither is left
    const n = world();
    await n.local.set({ [GRANTS_KEY]: rec, [UNVERIFIED_KEY]: { v: 1, plugins: rec.plugins } });
    const nv = await newVk();
    expect(await n.store.newVault(keysOf(nv))).toBe("set aside");
    const after = await n.local.get([GRANTS_KEY, UNVERIFIED_KEY]);
    expect(after[UNVERIFIED_KEY]).toBeUndefined();
    const fresh = parseRecord(after[GRANTS_KEY]);
    expect(fresh && fresh !== "damaged" && (await verify(await grantKey(nv.raw), fresh))).toBe(true);
    expect(fresh && fresh !== "damaged" && ids(fresh.plugins)).toEqual([AUTOFILL_ID]);
    expect(JSON.stringify([...n.local.data.values()])).not.toContain(PID);
  });

  it("nothing can grant them: the catalog of every build is the built-in's entry alone", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: {}, session: {} },
      runtime: { getManifest: () => ({ version: "0.1.0" }) },
    });
    const { catalog } = await import("../../src/platform/plugins/chrome");
    expect(catalog().plugins.map((p) => p.id)).toEqual([AUTOFILL_ID]);
  });
});
