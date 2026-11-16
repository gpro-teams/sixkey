// H4 install-source check (PHASE0X-PLAN C3): the decision for every install type and ID, with and without a store ID,
// and the platform side: off unless the build turns it on, asked once per page, remembered for the next page's first
// frame, and a failed answer never clears what was known.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProblem, type InstallType } from "../../src/core/install-source";

const STORE = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const TYPES: InstallType[] = ["admin", "development", "normal", "sideload", "other"];

describe("installProblem", () => {
  it("without a store ID, only the install type counts", () => {
    for (const id of [STORE, OTHER]) {
      expect(installProblem({ id, installType: "normal" }, "")).toBeNull();
      expect(installProblem({ id, installType: "admin" }, "")).toBeNull();
      expect(installProblem({ id, installType: "development" }, "")).toBe("not_store");
      expect(installProblem({ id, installType: "sideload" }, "")).toBe("not_store");
      expect(installProblem({ id, installType: "other" }, "")).toBe("not_store");
    }
  });

  it("with a store ID: the store's copy is fine, a normal install with another ID is a mismatch", () => {
    expect(installProblem({ id: STORE, installType: "normal" }, STORE)).toBeNull();
    expect(installProblem({ id: OTHER, installType: "normal" }, STORE)).toBe("id_mismatch");
  });

  it("an administrator's install is never reported, whatever its ID (SYNC-DESIGN H-d)", () => {
    expect(installProblem({ id: STORE, installType: "admin" }, STORE)).toBeNull();
    expect(installProblem({ id: OTHER, installType: "admin" }, STORE)).toBeNull();
  });

  it("any other type is not_store, with the store ID or not, and so is a type this code does not know", () => {
    for (const installType of ["development", "sideload", "other", "", "futureType"]) {
      for (const id of [STORE, OTHER]) {
        expect(installProblem({ id, installType }, STORE), `${installType} ${id}`).toBe("not_store");
        expect(installProblem({ id, installType }, ""), `${installType} ${id}`).toBe("not_store");
      }
    }
  });

  it("the full table: exactly the cases above are reported", () => {
    const got = TYPES.flatMap((installType) =>
      [STORE, OTHER].flatMap((id) =>
        ["", STORE].map(
          (storeId) =>
            `${installType}/${id === STORE ? "store" : "other"}/${storeId ? "set" : "unset"}=${installProblem({ id, installType }, storeId)}`,
        ),
      ),
    );
    expect(got).toEqual([
      "admin/store/unset=null",
      "admin/store/set=null",
      "admin/other/unset=null",
      "admin/other/set=null",
      "development/store/unset=not_store",
      "development/store/set=not_store",
      "development/other/unset=not_store",
      "development/other/set=not_store",
      "normal/store/unset=null",
      "normal/store/set=null",
      "normal/other/unset=null",
      "normal/other/set=id_mismatch",
      "sideload/store/unset=not_store",
      "sideload/store/set=not_store",
      "sideload/other/unset=not_store",
      "sideload/other/set=not_store",
      "other/store/unset=not_store",
      "other/store/set=not_store",
      "other/other/unset=not_store",
      "other/other/set=not_store",
    ]);
  });
});

describe("platform check", () => {
  type G = Record<string, unknown>;
  const g = globalThis as G;
  let store: Map<string, string>;
  let getSelf: ReturnType<typeof vi.fn>;

  function fakeLocalStorage(): Storage {
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    };
  }

  /** A fresh copy of the module (it remembers its one check per page), built as `build` would make it. */
  async function load(build: { check?: boolean; storeId?: string }) {
    vi.resetModules();
    if (build.check !== undefined) g.__INSTALL_CHECK__ = build.check;
    if (build.storeId !== undefined) g.__STORE_ID__ = build.storeId;
    return import("../../src/platform/install-source");
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Map();
    getSelf = vi.fn(async () => ({ id: OTHER, installType: "development" }));
    g.localStorage = fakeLocalStorage();
    g.chrome = { management: { getSelf } };
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const k of ["__INSTALL_CHECK__", "__STORE_ID__", "localStorage", "chrome"]) delete g[k];
  });

  it("is off when the build does not turn it on (dev, e2e, unbuilt): no call, no banner, nothing stored", async () => {
    for (const build of [{}, { check: false }]) {
      const m = await load(build);
      store.set("sk_install", "not_store"); // even with a stale answer stored
      expect(m.lastInstallProblem()).toBeNull();
      expect(await m.checkInstallSource()).toBeNull();
      expect(m.storeId()).toBe("");
    }
    expect(getSelf).not.toHaveBeenCalled();
  });

  it("asks once per page, not before the page has had time to draw, and remembers the answer", async () => {
    const m = await load({ check: true, storeId: "" });
    expect(m.lastInstallProblem()).toBeNull();
    const a = m.checkInstallSource();
    const b = m.checkInstallSource();
    await vi.advanceTimersByTimeAsync(100);
    expect(getSelf).not.toHaveBeenCalled(); // not on the first frame's path
    await vi.advanceTimersByTimeAsync(400);
    expect(await a).toBe("not_store");
    expect(await b).toBe("not_store");
    expect(getSelf).toHaveBeenCalledTimes(1);
    expect(m.lastInstallProblem()).toBe("not_store"); // the next page draws it in its first frame
  });

  it("clears the remembered answer when the copy turns out fine, and uses the store ID it was built with", async () => {
    store.set("sk_install", "not_store");
    getSelf.mockImplementation(async () => ({ id: STORE, installType: "normal" }));
    let m = await load({ check: true, storeId: STORE });
    expect(m.storeId()).toBe(STORE);
    expect(m.lastInstallProblem()).toBe("not_store");
    const ok = m.checkInstallSource();
    await vi.advanceTimersByTimeAsync(500);
    expect(await ok).toBeNull();
    expect(store.has("sk_install")).toBe(false);

    getSelf.mockImplementation(async () => ({ id: OTHER, installType: "normal" }));
    m = await load({ check: true, storeId: STORE });
    const bad = m.checkInstallSource();
    await vi.advanceTimersByTimeAsync(500);
    expect(await bad).toBe("id_mismatch");
    expect(m.lastInstallProblem()).toBe("id_mismatch");
  });

  it("when the browser does not answer, the last known answer stands; junk in storage is ignored", async () => {
    store.set("sk_install", "not_store");
    getSelf.mockImplementation(async () => {
      throw new Error("no");
    });
    let m = await load({ check: true, storeId: "" });
    const p = m.checkInstallSource();
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe("not_store");
    expect(store.get("sk_install")).toBe("not_store");

    store.set("sk_install", "<b>junk</b>");
    m = await load({ check: true, storeId: "" });
    expect(m.lastInstallProblem()).toBeNull();
  });

  it("works without localStorage (it throws): no banner from memory, the check still answers", async () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const m = await load({ check: true, storeId: "" });
    expect(m.lastInstallProblem()).toBeNull();
    const p = m.checkInstallSource();
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe("not_store");
  });
});
