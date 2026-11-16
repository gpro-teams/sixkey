// W2a round 3 (PLUGINS-W2A-NOTES.md §12; the r2 review's R2-01, R2-03), over real runtimes on shared storage and a shared
// vault lock, as Chrome's pages and worker share them (navigator.locks):
//   - (a) cleanupPending is a key change of this vault whose clean-up has yet to re-tag its records: a full marker, or
//     sk_store_v naming one of this keyring's previous keys; never the lack of sk_store_v alone, nor a mirror-only marker;
//   - (b) a new vault (the first run, a backup restored onto an empty store or over unreadable data, of the same vault or
//     another, Start over) sets aside the grant record left beside it, which its new key never verifies: the first
//     approval then lands at once, the user's Off of the built-in autofill is kept (N-01), and a record that verifies is
//     never touched. The runtime's store is the extension's (the default: the built-in's entries alone), which keeps
//     nothing aside since the plugin platform was removed: a new record takes the old one's place, and a record kept
//     aside before goes with it (plugins-retired.test.ts). The page's store here keeps every plugin's entries, as the
//     store's own tests do, so a write of its own over a failed record still lists that record's plugins for review;
//   - a (b) cut short leaves what (a) and write() handle: a write lands, or waits for the clean-up an open (or Settings'
//     runPendingCleanup) runs, and nothing is lost;
//   - two contexts running the same clean-up at once (an open in each, or one of them Settings' runPendingCleanup) re-tag
//     once and fail neither; runPendingCleanup does nothing while locked;
//   - the cloud plugin's follow-up (CLOUD-PLUGIN-NOTES.md §3.5, the review's open variant of A-2): a (b) cut short
//     leaves the old vault's record in place, but none of its approvals is honoured by a reader that cannot check the
//     tag (unverified: hello and env.get): they were withdrawn
//     through the overlay before the new vault was committed; the review list and the built-in autofill's Off are kept,
//     and so is its On after an Off (the second review's N2-3), on a clock behind the approvals' too; and nothing is
//     withdrawn once a vault is there after all, which the slots, read under the lock, say (its N2-2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autofillOn } from "../../src/core/plugins/builtin";
import { GRANTS_KEY, grantKey, OVERLAY_KEY, parseRecord, UNVERIFIED_KEY, verify } from "../../src/core/plugins/grants";
import {
  CleanupPendingError,
  runPendingCleanup,
  GrantStore,
  withFreshKeys,
  type GrantKeys,
} from "../../src/core/plugins/store";
import { KEYS } from "../../src/core/storage/format";
import { noReadableVault } from "../../src/core/storage/active-keyring";
import { emptyVault } from "../../src/core/vault/model";
import { webLock } from "../../src/platform/locks";
import { createRuntime } from "../../src/platform/runtime";
import { createProtected, NO_PAGE, STRONG } from "../helpers/vaults";
import { desc, LISTED, OTHER, PID, TestGrantStore } from "../helpers/plugins";

type Area = ReturnType<typeof area>;
function area() {
  const data = new Map<string, unknown>();
  /** A key whose write fails while this is set (a storage error at that step). */
  const failing = { key: null as string | null };
  return {
    data,
    failing,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      if (failing.key !== null && failing.key in items) throw new Error(`storage: ${failing.key} not written`);
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}
/** Web Locks as the browser shares them between a profile's pages and worker: one queue per name. */
function sharedLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name: string, _o: unknown, fn: () => Promise<unknown>) {
      const run = (tails.get(name) ?? Promise.resolve()).then(fn, fn);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}
beforeEach(() => {
  vi.stubGlobal("chrome", { runtime: { sendMessage: async () => undefined } });
  vi.stubGlobal("navigator", { locks: sharedLocks() });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** One profile's storage, a context's runtime over it (more with `context()`), and a grant store as a page has one. */
async function profile() {
  const local = area();
  const session = area();
  const context = () =>
    createRuntime({
      local: local as unknown as chrome.storage.StorageArea,
      session: session as unknown as chrome.storage.StorageArea,
      mirror: null,
    });
  const rt = context();
  const { ChromeLocalKV } = await import("../../src/platform/chrome-kv");
  const kv = new ChromeLocalKV(local as unknown as chrome.storage.StorageArea);
  /** A grant store as a page has one; `now`: its clock, if not this one. */
  const grantStore = (now?: () => number) =>
    new TestGrantStore({
      local: kv,
      session: new ChromeLocalKV(session as unknown as chrome.storage.StorageArea),
      lock: webLock("sixkey-vault"),
      ...(now ? { now } : {}),
      entries: "all",
    });
  const store = grantStore();
  const keys = async () => (await rt.service.grantKeys())!;
  const ids = async () => {
    const v = await store.read(await keys());
    return {
      ok: v.ok,
      plugins: v.ok ? v.plugins.map((e) => e.pluginId).sort() : [],
      review: v.review.map((e) => e.pluginId).sort(),
    };
  };
  return { local, session, rt, store, keys, ids, context, kv, grantStore };
}
type Profile = Awaited<ReturnType<typeof profile>>;
const pending = async (p: Profile) => (await p.keys()).cleanupPending();
/** Settings' Allow: the tagged write with withFreshKeys, its tries counted. */
async function allow(p: Profile, id: string) {
  let tries = 0;
  const r = await withFreshKeys(
    async () => (tries++, p.keys()),
    (k) => p.store.approve(k, desc(id), ["ui.slots"]),
    async () => undefined, // the waits, at once
  ).then(
    () => "written",
    (e) => (e instanceof CleanupPendingError ? "refused" : String(e)),
  );
  return { r, tries };
}
/** The stored data unreadable (both slots damaged), the plugin records kept: what Start over and a restore over it meet. */
function lose(local: Area) {
  for (const k of [...local.data.keys()]) if (!k.startsWith("sk_plugins")) local.data.delete(k);
  local.data.set(KEYS.active, "a");
  local.data.set(KEYS.slot.a, "garbage");
  local.data.set(KEYS.slot.b, { torn: "half a write" });
}
/** The store emptied but for the plugin records (a profile whose vault was cleared, then the first run again). */
function empty(local: Area) {
  for (const k of [...local.data.keys()]) if (!k.startsWith("sk_plugins")) local.data.delete(k);
}

describe("(a) cleanupPending: an unfinished key change of this vault, nothing else (R2-01, R2-03)", () => {
  it("a new vault: not due though it has no sk_store_v; a full or damaged marker: due; a mirror-only one: not", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    const vkId = (await p.keys()).vk.id;
    expect(p.local.data.has(KEYS.storeVersion)).toBe(false); // none until the first open's check
    expect(p.local.data.has(KEYS.keyChange)).toBe(false);
    expect(await pending(p)).toBe(false);
    await p.rt.service.openView(); // its housekeeping writes sk_store_v
    expect(p.local.data.get(KEYS.storeVersion)).toEqual({ v: 2, vkId });
    expect(await pending(p)).toBe(false);
    for (const [marker, due] of [
      [{ v: 1, vkId, at: 1 }, true],
      ["damaged", true],
      [{ v: 1, vkId, at: 1, mirror: true }, false], // the clean-up did the records first: only the mirror is left
      [{ v: 1, vkId: "another-key-id", at: 1, mirror: true }, true], // a mirror-only marker of another key is a full one
    ] as const) {
      p.local.data.set(KEYS.keyChange, marker);
      expect(await pending(p), JSON.stringify(marker)).toBe(due);
    }
  });
  it("sk_store_v naming one of this keyring's previous keys (a key change without a marker): due; another or newer: not", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    const old = (await p.keys()).vk.id;
    await p.rt.service.rotateKey(STRONG, NO_PAGE);
    expect(p.local.data.has(KEYS.keyChange)).toBe(false); // the clean-up finished
    expect(await pending(p)).toBe(false);
    for (const [version, due] of [
      [{ v: 2, vkId: old }, true],
      [{ v: 2, vkId: "not-a-key-of-this-vault" }, false],
      [{ v: 3 }, false],
      [undefined, false],
    ] as const) {
      if (version === undefined) p.local.data.delete(KEYS.storeVersion);
      else p.local.data.set(KEYS.storeVersion, version);
      expect(await pending(p), JSON.stringify(version)).toBe(due);
    }
  });
  it("R2-03: with only the mirror left, a record that does not verify is a failed one: the write lands, the old aside", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    await p.rt.service.openView();
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    const rec = p.local.data.get(GRANTS_KEY) as Record<string, unknown>;
    p.local.data.set(GRANTS_KEY, { ...rec, tag: "A".repeat(43) }); // damaged, or written by another vault's key
    p.local.data.set(KEYS.keyChange, { v: 1, vkId: (await p.keys()).vk.id, at: 1, mirror: true });
    expect(await allow(p, OTHER)).toEqual({ r: "written", tries: 1 });
    expect(await p.ids()).toEqual({ ok: true, plugins: [OTHER], review: [PID] });
  });
});

describe("(b) a new vault sets aside the grant record left beside it (R2-01)", () => {
  const ways = [
    [
      "the first run, beside a record left",
      "empty",
      (p: Profile) => p.rt.service.prepareKeys(STRONG).then((k) => p.rt.service.create(k)),
    ],
    [
      "a backup restored onto an empty store",
      "empty",
      async (p: Profile, vaultId: string) =>
        p.rt.service.restoreBackup(emptyVault(vaultId), await p.rt.service.prepareKeys(STRONG, { vaultId })),
    ],
    [
      "Start over, over unreadable data",
      "lost",
      (p: Profile) => p.rt.service.prepareKeys(STRONG).then((k) => p.rt.service.startOver(k)),
    ],
    [
      "the same vault's backup restored over unreadable data",
      "lost",
      async (p: Profile, vaultId: string) =>
        p.rt.service.restoreBackup(emptyVault(vaultId), await p.rt.service.prepareKeys(STRONG, { vaultId })),
    ],
    [
      "another vault's backup restored over unreadable data",
      "lost",
      async (p: Profile) =>
        p.rt.service.restoreBackup(
          emptyVault("vault-another-0001"),
          await p.rt.service.prepareKeys(STRONG, { vaultId: "vault-another-0001" }),
        ),
    ],
  ] as const;
  for (const [name, from, make] of ways)
    it(`${name}: the first approval lands at once; the old record replaced, nothing kept aside`, async () => {
      const p = await profile();
      await createProtected(p.rt.service);
      const before = await p.keys();
      const vaultId = (await p.rt.service.currentGeneration())!.keyring.vaultId;
      await p.store.approve(before, desc(PID), ["ui.slots"]);
      await p.store.approve(before, desc(LISTED), ["ui.slots"]);
      const old = p.local.data.get(GRANTS_KEY);
      if (from === "lost") lose(p.local);
      else empty(p.local);
      await make(p, vaultId);
      const now = await p.keys();
      // a new vault key, always (the same vault's id kept or not), which the old record never verifies under
      expect(now.vk.id).not.toBe(before.vk.id);
      const parsed = parseRecord(old);
      expect(parsed !== null && parsed !== "damaged" && (await verify(await grantKey(now.vk.raw), parsed))).toBe(false);
      if (from === "lost") expect(p.local.data.has(KEYS.keyChange)).toBe(true); // (a) alone would refuse here
      // set aside: a new record under the new key in its place, nothing kept
      expect(p.local.data.has(UNVERIFIED_KEY)).toBe(false);
      const rec = parseRecord(p.local.data.get(GRANTS_KEY));
      expect(rec !== null && rec !== "damaged" && (await verify(await grantKey(now.vk.raw), rec))).toBe(true);
      expect(rec !== null && rec !== "damaged" && rec.plugins).toEqual([]);
      // the user's next write: written at the first try, none of the old ones in it or listed
      expect(await allow(p, OTHER)).toEqual({ r: "written", tries: 1 });
      expect(await p.ids()).toEqual({ ok: true, plugins: [OTHER], review: [] });
    });
  it("the user's Off of the built-in autofill stays off in the new record (N-01)", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    await p.store.setAutofill(await p.keys(), false);
    empty(p.local);
    await p.rt.service.create(await p.rt.service.prepareKeys(STRONG));
    const v = await p.store.read(await p.keys());
    expect(v.ok).toBe(true);
    expect(v.ok && autofillOn(v.plugins)).toBe(false);
  });
  it("a record that verifies is left as it is, byte for byte; none is none; a damaged one is set aside too", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    const k = await p.keys();
    expect(await p.store.newVault(k)).toBe("absent");
    await p.store.approve(k, desc(PID), ["ui.slots"]);
    const before = JSON.stringify([...p.local.data.entries()]);
    expect(await p.store.newVault({ vk: k.vk, activeVkId: k.activeVkId })).toBe("current");
    expect(JSON.stringify([...p.local.data.entries()])).toBe(before);
    p.local.data.set(GRANTS_KEY, "not a record");
    expect(await p.store.newVault({ vk: k.vk, activeVkId: k.activeVkId })).toBe("set aside");
    expect(p.local.data.get(UNVERIFIED_KEY)).toBe("not a record");
  });
  it("a record kept aside before goes with the old record; the overlay is merged and removed", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    // a record of an earlier vault kept for review already (LISTED's), then this vault's own approvals (PID's)
    await p.store.approve(await p.keys(), desc(LISTED), ["ui.slots"]);
    const listed = (parseRecord(p.local.data.get(GRANTS_KEY)) as { plugins: { pluginId: string }[] }).plugins.find(
      (e) => e.pluginId === LISTED,
    );
    await p.store.remove(await p.keys(), LISTED);
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    p.local.data.set(UNVERIFIED_KEY, { v: 1, plugins: [listed] });
    p.local.data.set(OVERLAY_KEY, { v: 1, entries: [{ pluginId: PID, action: "disable", at: Date.now() }] });
    empty(p.local);
    await p.rt.service.create(await p.rt.service.prepareKeys(STRONG));
    expect(p.local.data.has(OVERLAY_KEY)).toBe(false); // merged and removed with the old record
    expect(p.local.data.has(UNVERIFIED_KEY)).toBe(false);
    expect(await p.ids()).toEqual({ ok: true, plugins: [], review: [] });
  });
});

describe("(b) cut short: what is left, (a) and write() handle, and nothing is lost", () => {
  for (const [name, from] of [
    ["the first run", "empty"],
    ["Start over", "lost"],
  ] as const)
    // (the runtime's store writes no sk_plugins_unverified: the record's write is the one that can fail)
    for (const failing of [GRANTS_KEY])
      it(`${name}, the write of ${failing} failing: the vault is made; the approval lands, after the clean-up if one is due`, async () => {
        const p = await profile();
        await createProtected(p.rt.service);
        await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
        const old = p.local.data.get(GRANTS_KEY);
        if (from === "lost") lose(p.local);
        else empty(p.local);
        p.local.failing.key = failing; // (b)'s set-aside fails at that step
        const keys = await p.rt.service.prepareKeys(STRONG);
        // never fails on its account: asserted, so a hook whose error escapes fails here by an assertion (W2b, R3-03)
        const made = await (from === "lost" ? p.rt.service.startOver(keys) : p.rt.service.create(keys)).then(
          () => "made",
          (e: unknown) => `threw: ${String(e)}`,
        );
        expect(made).toBe("made");
        p.local.failing.key = null;
        expect((await p.rt.service.status()).state).toBe("unlocked");
        expect(p.local.data.get(GRANTS_KEY)).toEqual(old); // the old record still there
        if (from === "empty") {
          // no clean-up due: the first write sets the old record aside itself
          expect(await allow(p, OTHER)).toEqual({ r: "written", tries: 1 });
        } else {
          // Start over's marker: refused until the clean-up an open runs; Settings runs it once after the refusal
          expect((await allow(p, OTHER)).r).toBe("refused");
          await runPendingCleanup(p.rt);
          expect(p.local.data.has(KEYS.keyChange)).toBe(false);
          expect(await allow(p, OTHER)).toEqual({ r: "written", tries: 1 });
        }
        expect(await p.ids()).toEqual({ ok: true, plugins: [OTHER], review: [PID] });
      });
});

describe("a list kept aside before: a new vault takes it out with the old record; a later failed record is merged in", () => {
  for (const [name, from] of [
    ["the first run", "empty"],
    ["Start over", "lost"],
  ] as const)
    it(`${name}: the list kept before goes with the old record, none of it merged or kept`, async () => {
      const p = await profile();
      await createProtected(p.rt.service);
      // a record of an earlier vault kept for review already (OTHER's), then this vault's own approval (PID's)
      await p.store.approve(await p.keys(), desc(OTHER), ["ui.slots"]);
      const other = (parseRecord(p.local.data.get(GRANTS_KEY)) as { plugins: { pluginId: string }[] }).plugins.find(
        (e) => e.pluginId === OTHER,
      );
      await p.store.remove(await p.keys(), OTHER);
      await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
      p.local.data.set(UNVERIFIED_KEY, { v: 1, plugins: [other] });
      if (from === "lost") lose(p.local);
      else empty(p.local);
      const keys = await p.rt.service.prepareKeys(STRONG);
      const made = await (from === "lost" ? p.rt.service.startOver(keys) : p.rt.service.create(keys)).then(
        () => "made",
        (e: unknown) => `threw: ${String(e)}`,
      );
      expect(made).toBe("made");
      expect(p.local.data.has(UNVERIFIED_KEY)).toBe(false);
      // the first tagged write lands at once, over the new record: none of the old plugins in it or listed
      expect(await allow(p, LISTED)).toEqual({ r: "written", tries: 1 });
      expect(await p.ids()).toEqual({ ok: true, plugins: [LISTED], review: [] });
    });
  it("a later failed record is merged into the kept list, never in its place (W2a kept only the first)", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    const fail = (t: string) =>
      p.local.data.set(GRANTS_KEY, { ...(p.local.data.get(GRANTS_KEY) as object), tag: t.repeat(43) });
    fail("A");
    expect(await allow(p, OTHER)).toEqual({ r: "written", tries: 1 }); // PID's record kept aside, as it is
    expect(await p.ids()).toEqual({ ok: true, plugins: [OTHER], review: [PID] });
    fail("B");
    expect(await allow(p, LISTED)).toEqual({ r: "written", tries: 1 });
    expect(await p.ids()).toEqual({ ok: true, plugins: [LISTED], review: [OTHER, PID].sort() });
  });
});

describe("W2b r2 (the review's Q30): a plugin in both the kept list and the newer failed record", () => {
  it("the failed record's entry, the newer, is the one kept for review", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    const older = (parseRecord(p.local.data.get(GRANTS_KEY)) as { plugins: { pluginId: string }[] }).plugins.find(
      (e) => e.pluginId === PID,
    );
    await p.store.approve(await p.keys(), desc(PID, { version: "2.0.0" }), ["ui.slots"]);
    p.local.data.set(UNVERIFIED_KEY, { v: 1, plugins: [older] }); // an earlier record's entry, kept before
    p.local.data.set(GRANTS_KEY, { ...(p.local.data.get(GRANTS_KEY) as object), tag: "C".repeat(43) });
    expect(await allow(p, LISTED)).toEqual({ r: "written", tries: 1 });
    const kept = (
      p.local.data.get(UNVERIFIED_KEY) as { plugins: { pluginId: string; descriptor: { version: string } }[] }
    ).plugins;
    expect(kept.filter((e) => e.pluginId === PID).map((e) => e.descriptor.version)).toEqual(["2.0.0"]);
  });
});

describe("the clean-up run twice at once, and runPendingCleanup (the maintainers' r3 condition)", () => {
  it("two contexts' opens finish one cut-short key change together: one re-tag, no failure, the approval kept", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    await p.rt.service.openView();
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    const epoch = (parseRecord(p.local.data.get(GRANTS_KEY)) as { epoch: number }).epoch;
    // the rotation's clean-up is cut short at the grant store's part (a storage error there): its marker stays
    const orig = GrantStore.prototype.reencrypt;
    const results: string[] = [];
    let cut = true;
    vi.spyOn(GrantStore.prototype, "reencrypt").mockImplementation(async function (this: GrantStore, ...a) {
      if (cut) {
        cut = false;
        throw new Error("storage: cut short");
      }
      const r = await orig.apply(this, a as Parameters<GrantStore["reencrypt"]>);
      results.push(r);
      return r;
    });
    await p.rt.service.rotateKey(STRONG, NO_PAGE);
    expect(p.local.data.has(KEYS.keyChange)).toBe(true);
    expect(await pending(p)).toBe(true);
    // the popup and the settings page (runPendingCleanup is its open) at once, each a context of its own, same storage
    const other = p.context();
    await Promise.all([other.service.openView(), p.rt.service.openView()]);
    expect(results.sort()).toEqual(["current", "rewritten"]); // both ran it: one re-tagged, the other found it done
    expect(p.local.data.has(KEYS.keyChange)).toBe(false);
    expect(await pending(p)).toBe(false);
    const rec = parseRecord(p.local.data.get(GRANTS_KEY)) as { epoch: number };
    expect(rec.epoch).toBe(epoch + 1); // re-tagged once
    expect(await p.ids()).toEqual({ ok: true, plugins: [PID], review: [] });
  });
  it("runPendingCleanup: nothing while locked, one open while unlocked; it never throws", async () => {
    const opened = vi.fn(async () => ({ state: "unlocked" }));
    const keys = { vk: { id: "k" } } as unknown as GrantKeys;
    await runPendingCleanup({ service: { grantKeys: async () => null, openView: opened } });
    expect(opened).not.toHaveBeenCalled();
    await runPendingCleanup({ service: { grantKeys: async () => keys, openView: opened } });
    expect(opened).toHaveBeenCalledTimes(1);
    await expect(
      runPendingCleanup({
        service: {
          grantKeys: async () => keys,
          openView: async () => {
            throw new Error("storage");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the old vault's approvals are never honoured after a new vault, a (b) cut short included (CLOUD-PLUGIN §3.5)", () => {
  for (const [name, from] of [
    ["the first run", "empty"],
    ["Start over", "lost"],
  ] as const)
    // (the runtime's store writes no sk_plugins_unverified: the record's write is the one that can fail)
    for (const failing of [null, GRANTS_KEY])
      it(`${name}${failing ? `, the set-aside's write of ${failing} failing` : ""}: unverified() holds none of them`, async () => {
        const p = await profile();
        await createProtected(p.rt.service);
        // the old vault: a plugin approved with two capabilities, another with one, and the built-in autofill turned
        // off
        await p.store.approve(await p.keys(), desc(PID), ["ui.slots", "env.read"]);
        await p.store.approve(await p.keys(), desc(OTHER), ["ui.slots"]);
        await p.store.setAutofill(await p.keys(), false);
        const before = await p.store.unverified();
        expect(before.plugins.find((e) => e.pluginId === PID)).toMatchObject({ state: "approved" });
        const old = p.local.data.get(GRANTS_KEY);
        if (from === "lost") lose(p.local);
        else empty(p.local);
        p.local.failing.key = failing; // newVault cut short at that step: the old record stays where it was
        const keys = await p.rt.service.prepareKeys(STRONG);
        await (from === "lost" ? p.rt.service.startOver(keys) : p.rt.service.create(keys));
        p.local.failing.key = null;
        expect((await p.rt.service.status()).state).toBe("unlocked");
        if (failing) expect(p.local.data.get(GRANTS_KEY)).toEqual(old); // the record of the old vault, untagged here
        // what a locked reader sees: no approval of the old vault's, the built-in autofill still off
        const now = await p.store.unverified();
        expect(now.plugins.filter((e) => e.pluginId === PID || e.pluginId === OTHER)).toEqual([]);
        expect(autofillOn(now.plugins)).toBe(false);
        // the new vault's first approval lands. Cut short, the old record is still there, and this page's write sets it
        // aside (its store keeps every plugin's entries): its plugins listed for review, never honoured. Whole, the new
        // vault's record took its place, and nothing was kept
        if (from === "lost" && failing) await runPendingCleanup(p.rt); // Start over's marker: the clean-up first
        expect(await allow(p, LISTED)).toEqual({ r: "written", tries: 1 });
        // (the built-in autofill's Off is an entry of the new record: "a" 32 times, its reserved ID)
        expect(await p.ids()).toEqual({
          ok: true,
          plugins: ["a".repeat(32), LISTED].sort(),
          review: failing ? [OTHER, PID].sort() : [],
        });
        expect(autofillOn((await p.store.unverified()).plugins)).toBe(false);
        expect(p.local.data.has(OVERLAY_KEY)).toBe(false); // merged into the new record and taken out
      });
  it("a record that verifies under the new key is left alone, byte for byte (none in practice: a new vault, a new key)", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    const k = await p.keys();
    const slots = vi.fn(async () => true);
    expect(await p.store.beforeNewVault(k.vk, slots)).toBe("absent");
    await p.store.approve(k, desc(PID), ["ui.slots"]);
    const was = JSON.stringify([...p.local.data.entries()]);
    expect(await p.store.beforeNewVault(k.vk, slots)).toBe("current");
    expect(JSON.stringify([...p.local.data.entries()])).toBe(was);
    expect(slots).not.toHaveBeenCalled(); // nothing to withdraw: the slots are not even read
  });

  it("autofill turned off and on again stays on through Start over, whole or cut short (the second review's N2-3, RR2)", async () => {
    for (const failing of [null, GRANTS_KEY]) {
      const p = await profile();
      await createProtected(p.rt.service);
      await p.store.approve(await p.keys(), desc(PID), ["ui.slots", "env.read"]);
      await p.store.setAutofill(await p.keys(), false);
      await p.store.setAutofill(await p.keys(), true);
      // an entry of its own now, approved: the one the built-ins' filter keeps out of the withdrawal
      const own = (await p.store.unverified()).plugins.find((e) => e.pluginId === "a".repeat(32));
      expect(own).toMatchObject({ state: "approved" });
      lose(p.local);
      p.local.failing.key = failing; // newVault cut short at its tagged write: the overlay is all that is left
      await p.rt.service.startOver(await p.rt.service.prepareKeys(STRONG));
      p.local.failing.key = null;
      const now = await p.store.unverified();
      expect(autofillOn(now.plugins), `${failing}`).toBe(true);
      expect(
        now.plugins.filter((e) => e.pluginId === PID),
        `${failing}`,
      ).toEqual([]); // the old vault's withdrawn
      if (!failing) {
        const v = await p.store.read(await p.keys()); // the new record, under the new key
        expect(v.ok && autofillOn(v.plugins)).toBe(true);
      }
    }
  });

  it("a clock behind the old approvals still withdraws them: the removal is dated after each (N2-3, RR4)", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    // approved on a clock an hour ahead (a profile moved, or its clock set back since)
    const ahead = p.grantStore(() => Date.now() + 3_600_000);
    await ahead.approve(await p.keys(), desc(PID), ["ui.slots", "env.read"]);
    const approvedAt = (await p.store.unverified()).plugins.find((e) => e.pluginId === PID)!.approvedAt;
    expect(approvedAt).toBeGreaterThan(Date.now());
    lose(p.local);
    p.local.failing.key = GRANTS_KEY; // newVault cut short: the removal alone withdraws it
    await p.rt.service.startOver(await p.rt.service.prepareKeys(STRONG));
    p.local.failing.key = null;
    expect((await p.store.unverified()).plugins.filter((e) => e.pluginId === PID)).toEqual([]);
    const overlay = p.local.data.get(OVERLAY_KEY) as { entries: { pluginId: string; at: number }[] };
    expect(overlay.entries.find((o) => o.pluginId === PID)!.at).toBe(approvedAt + 1);
  });
});

describe("a vault there after all: nothing withdrawn (the second review's N2-2)", () => {
  /** A vault key that does not open this profile's record: another profile's. */
  async function otherVk() {
    const q = await profile();
    await createProtected(q.rt.service);
    return (await q.keys()).vk;
  }
  it("the slots, read under the vault lock, decide: a vault there, nothing written; empty or lost, withdrawn", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    const next = await otherVk();
    const was = JSON.stringify([...p.local.data.entries()]);
    let other = false; // a vault-lock request made while the slots are read runs only after: they are read under it
    const slots = async () => {
      void navigator.locks.request("sixkey-vault", {}, async () => void (other = true));
      await new Promise((go) => setTimeout(go, 20));
      expect(other).toBe(false);
      return noReadableVault(p.kv);
    };
    expect(await p.store.beforeNewVault(next, slots)).toBe("vault");
    expect(JSON.stringify([...p.local.data.entries()])).toBe(was); // byte for byte
    for (const gone of [lose, empty]) {
      const q = await profile();
      await createProtected(q.rt.service);
      await q.store.approve(await q.keys(), desc(PID), ["ui.slots"]);
      gone(q.local);
      expect(await q.store.beforeNewVault(next, () => noReadableVault(q.kv)), gone.name).toBe("withdrawn");
      expect(
        (await q.store.unverified()).plugins.filter((e) => e.pluginId === PID),
        gone.name,
      ).toEqual([]);
    }
  });

  it("a read of the slots that fails is no 'no vault': it propagates, and nothing is withdrawn (MV3)", async () => {
    const fails = { get: async () => Promise.reject(new Error("storage: read failed")) } as unknown as Parameters<
      typeof noReadableVault
    >[0];
    await expect(noReadableVault(fails)).rejects.toThrow(/read failed/);
    const p = await profile();
    await createProtected(p.rt.service);
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]);
    const next = await otherVk();
    const was = JSON.stringify([...p.local.data.entries()]);
    await expect(p.store.beforeNewVault(next, () => noReadableVault(fails))).rejects.toThrow(/read failed/);
    expect(JSON.stringify([...p.local.data.entries()])).toBe(was);
  });

  it("another page makes a vault and approves a plugin while this one's first run is under way: that approval stands", async () => {
    const p = await profile();
    await createProtected(p.rt.service);
    await p.store.approve(await p.keys(), desc(PID), ["ui.slots"]); // the old vault's
    empty(p.local);
    // page A: its first run looks (empty), then, before it withdraws anything, page B (the profile's runtime) makes a
    // vault of its own and approves a plugin under it
    const a = p.context();
    const keysA = await a.service.prepareKeys(STRONG);
    const store = (a.service as unknown as { store: { load: () => Promise<unknown> } }).store;
    const load = store.load.bind(store);
    vi.spyOn(store, "load").mockImplementationOnce(async () => {
      const seen = await load();
      await p.rt.service.create(await p.rt.service.prepareKeys(STRONG));
      expect(await allow(p, LISTED)).toEqual({ r: "written", tries: 1 });
      return seen;
    });
    await expect(a.service.create(keysA)).rejects.toThrow(/a vault appeared meanwhile/);
    // B's approval is honoured by every reader, the locked ones included; A withdrew nothing
    expect((await p.store.unverified()).plugins.find((e) => e.pluginId === LISTED)).toMatchObject({
      state: "approved",
    });
    // (B's new vault replaced the old record, keeping nothing aside: the old vault's plugin is not listed either)
    expect(await p.ids()).toEqual({ ok: true, plugins: [LISTED], review: [] });
    expect(p.local.data.has(OVERLAY_KEY)).toBe(false);
  });
});
