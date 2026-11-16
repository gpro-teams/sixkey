// W2A-01 over a real runtime (the W2a review's RU-5, as a regression test; PLUGINS-W2A-NOTES.md §11): a Settings approval
// whose key was read before a rotation is refused (StaleKeyError), tried again with the new key while the rotation's
// cleanup has yet to re-tag the grant store (after committed() stored the new key in the session, before the store's own
// VkRecord), refused again (CleanupPendingError: nothing written), and lands once the cleanup has re-tagged the record.
// Both approvals survive, and nothing goes up for review. The store's own reading of the cleanup (VaultStore.
// cleanupPending, handed out with the keys) is true in that window and false once the change is finished.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantStore, withFreshKeys } from "../../src/core/plugins/store";
import { createMutex } from "../../src/core/storage/kv";
import { createRuntime } from "../../src/platform/runtime";
import { createProtected, NO_PAGE, STRONG } from "../helpers/vaults";
import { desc, OTHER, PID, TestGrantStore } from "../helpers/plugins";

function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}
beforeEach(() => vi.stubGlobal("chrome", { runtime: { sendMessage: async () => undefined } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("W2A-01 over a real runtime (RU-5)", () => {
  it("an approval raced with a rotation, tried again during its cleanup, lands after the re-tag; nothing is lost", async () => {
    const local = area();
    const session = area();
    const rt = createRuntime({
      local: local as unknown as chrome.storage.StorageArea,
      session: session as unknown as chrome.storage.StorageArea,
      mirror: null,
    });
    await createProtected(rt.service);
    const { ChromeLocalKV } = await import("../../src/platform/chrome-kv");
    const store = new TestGrantStore({
      local: new ChromeLocalKV(local as unknown as chrome.storage.StorageArea),
      session: new ChromeLocalKV(session as unknown as chrome.storage.StorageArea),
      lock: createMutex(),
      entries: "all",
    });
    const keys = async () => (await rt.service.grantKeys())!;
    const before = await keys();
    expect(before.cleanupPending).toBeTypeOf("function"); // handed out with the keys, as activeVkId is
    await store.approve(before, desc(PID), ["ui.slots", "env.read"]);
    // a new vault has no record of a finished check (sk_store_v) until its first open's housekeeping writes it, and that
    // alone is no unfinished key change (r3, the r2 review's R2-01)
    expect(await before.cleanupPending()).toBe(false);
    await rt.service.openView();
    expect(await before.cleanupPending()).toBe(false);

    const orig = GrantStore.prototype.reencrypt;
    const tried: string[] = [];
    const waits: number[] = [];
    let pendingThen: boolean | null = null;
    let approval: Promise<unknown> | null = null;
    let refused!: () => void;
    const seenRefused = new Promise<void>((r) => (refused = r));
    let retagged!: () => void;
    const reTag = new Promise<void>((r) => (retagged = r));
    vi.spyOn(GrantStore.prototype, "reencrypt").mockImplementation(async function (this: GrantStore, ...a) {
      if (!approval) {
        // Settings' Allow, its key read before the rotation committed: started here, not waited for by the cleanup
        let first = true;
        const get = async () => {
          const k = first ? before : await keys();
          first = false;
          tried.push(k.vk.id === before.vk.id ? "old" : "new");
          return k;
        };
        pendingThen = await (await keys()).cleanupPending();
        approval = withFreshKeys(
          get,
          (k) => store.approve(k, desc(OTHER), ["ui.slots", "env.read"]),
          async (ms) => {
            waits.push(ms);
            refused();
            await reTag;
          },
        );
        await Promise.race([seenRefused, approval]); // the approval has met the cleanup still to do, and waits
      }
      const r = await orig.apply(this, a as Parameters<GrantStore["reencrypt"]>);
      retagged();
      return r;
    });
    await rt.service.rotateKey(STRONG, NO_PAGE);
    await approval;
    vi.restoreAllMocks();

    expect(pendingThen).toBe(true);
    expect(tried).toEqual(["old", "new", "new"]);
    expect(waits).toEqual([100]);
    const now = await keys();
    expect(now.vk.id).not.toBe(before.vk.id);
    expect(await now.cleanupPending()).toBe(false);
    const v = await store.read(now);
    expect(v.ok).toBe(true);
    expect(v.ok && v.plugins.map((e) => e.pluginId).sort()).toEqual([OTHER, PID].sort());
    expect(v.review).toEqual([]);
    expect(local.data.has("sk_plugins_unverified")).toBe(false);
  });
});
