// TOTP autofill Stage 2, patch 2: Settings › Security › Autofill (src/options/Misc.tsx Autofill; AUTOFILL2-NOTES §7),
// rendered by Preact into a minimal document (test/helpers/mini-dom.ts) over a stand-in chrome.* whose permissions match
// patterns as Chrome does and answer a request only inside the click's synchronous run, as Chrome does: each listed site
// with its grant as Chrome says it now (On, or Turned off in Chrome with "Turn on again", whose request is made in the
// click itself), Remove (off the list; Chrome's grant given back only when listed exactly), the line about Chrome's list,
// and the Chrome 140 line where storage cannot be closed to pages (then nothing is asked of Chrome; Remove still works).
// The real page is autofill2-sites.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV } from "../../src/core/storage/kv";
import { Autofill } from "../../src/options/Misc";
import { SITES_KEY } from "../../src/platform/autofill-sites";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice, t } from "../../src/ui/i18n";
import { installMiniDom, type MiniElement } from "../helpers/mini-dom";
import { covers } from "../helpers/sw-world";
// the page needs a context since W1b (its switch, shown only while unlocked: not here)
const LOCKED_CTX = {
  rt: {} as never,
  status: { state: "locked" } as never,
  vault: null,
  reload: async () => undefined,
};

type Listener = (...a: unknown[]) => void;
let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
});

/** chrome.* for the panel: storage.local with its change event, storage.session, permissions over a grant set. */
function world(o: { hosts: string[]; grants: string[]; closable?: boolean }) {
  const local = Object.assign(new MemoryKV(), { onChanged: events() });
  const session = new MemoryKV();
  const set = new Set(o.grants);
  const log: string[] = [];
  let gesture = false;
  const added = events();
  const removed = events();
  const level = () => (o.closable === false ? undefined : async () => undefined);
  const chrome = {
    storage: {
      local: Object.assign(local, { setAccessLevel: level() }),
      session: Object.assign(session, { setAccessLevel: async () => undefined }),
    },
    permissions: {
      contains: async (x: { origins: string[] }) => x.origins.every((a) => [...set].some((g) => covers(g, a))),
      request: (x: { origins: string[] }) => {
        log.push(`${gesture ? "request" : "request-without-gesture"} ${x.origins.join()}`);
        if (!gesture) return Promise.reject(new Error("This function must be called during a user gesture"));
        for (const p of x.origins) set.add(p);
        void Promise.resolve().then(() => added.fire({ origins: x.origins }));
        return Promise.resolve(true);
      },
      remove: async (x: { origins: string[] }) => {
        log.push(`remove ${x.origins.join()}`);
        const ok = x.origins.every((p) => set.delete(p));
        if (ok) void Promise.resolve().then(() => removed.fire({ origins: x.origins }));
        return ok;
      },
      getAll: async () => ({ origins: [...set] }),
      onAdded: added,
      onRemoved: removed,
    },
  };
  return {
    chrome,
    local,
    set,
    log,
    /** Chrome's own settings withdraw a grant (chrome://extensions › Site access). */
    withdraw(p: string) {
      set.delete(p);
      removed.fire({ origins: [p] });
    },
    click(el: MiniElement) {
      gesture = true;
      try {
        act(() => void el.dispatch("click"));
      } finally {
        gesture = false;
      }
    },
    async seed() {
      await local.set({ [SITES_KEY]: { v: 1, hosts: o.hosts } });
    },
  };
}
function events() {
  const ls = new Set<Listener>();
  return {
    addListener: (l: Listener) => void ls.add(l),
    removeListener: (l: Listener) => void ls.delete(l),
    fire: (...a: unknown[]) => ls.forEach((l) => l(...a)),
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};
const row = (host: string) => root.all((e) => e.getAttribute("data-host") === host)[0];
const button = (host: string, cls: string) =>
  row(host)?.all((e) => e.localName === "button" && (e.getAttribute("class") ?? "").includes(cls))[0];
const text = () => root.textContent;

let w: ReturnType<typeof world>;
async function mount(o: Parameters<typeof world>[0]) {
  w = world(o);
  await w.seed();
  vi.stubGlobal("chrome", w.chrome);
  act(() => render(h(Autofill, LOCKED_CTX), root as unknown as Element));
  await settle();
}
beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body;
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.unstubAllGlobals();
});

describe("Settings › Security › Autofill", () => {
  it("each site with Chrome's grant as Chrome says it now, and the line about Chrome's own list", async () => {
    await mount({ hosts: ["a.example.com", "b.example.com"], grants: ["https://a.example.com/*"] });
    expect(row("a.example.com")!.textContent).toContain(t("clipOn"));
    expect(button("a.example.com", "afs-again")).toBeUndefined();
    expect(row("b.example.com")!.textContent).toContain(t("afsOff"));
    expect(button("b.example.com", "afs-again")).toBeDefined();
    expect(text()).toContain(t("afsChrome"));
    expect(text()).not.toContain(t("afsOld"));
    // withdrawn in Chrome's own settings: the row says so at once, and the list keeps the site
    w.withdraw("https://a.example.com/*");
    await settle();
    expect(row("a.example.com")!.textContent).toContain(t("afsOff"));
    expect((w.local.data.get(SITES_KEY) as { hosts: string[] }).hosts).toEqual(["a.example.com", "b.example.com"]);
  });

  it('"On all sites" in Chrome\'s menu shows the listed sites On, and lists no other', async () => {
    await mount({ hosts: ["a.example.com"], grants: ["https://*/*"] });
    expect(row("a.example.com")!.textContent).toContain(t("clipOn"));
    expect(root.all((e) => e.getAttribute("data-host") !== null)).toHaveLength(1);
  });

  it("Turn on again asks Chrome for exactly that site, in the click itself", async () => {
    await mount({ hosts: ["b.example.com"], grants: [] });
    w.click(button("b.example.com", "afs-again")!);
    await settle();
    expect(w.log).toEqual(["request https://b.example.com/*"]); // inside the gesture: no await came before it
    expect(row("b.example.com")!.textContent).toContain(t("clipOn"));
  });

  it("Remove: off the list, and Chrome's grant given back when Chrome lists exactly that site's pattern", async () => {
    await mount({
      hosts: ["a.example.com", "b.example.com"],
      grants: ["https://a.example.com/*", "https://api.sixkey.app/*"],
    });
    w.click(button("a.example.com", "afs-remove")!);
    await settle();
    expect(row("a.example.com")).toBeUndefined();
    expect(w.log).toEqual(["remove https://a.example.com/*"]);
    expect([...w.set]).toEqual(["https://api.sixkey.app/*"]); // sync's grant untouched
    w.click(button("b.example.com", "afs-remove")!);
    await settle();
    expect(w.log).toEqual(["remove https://a.example.com/*"]); // nothing granted for it: nothing to give back
    expect(text()).toContain(t("afsNone"));
    expect(w.local.data.get(SITES_KEY)).toEqual({ v: 1, hosts: [] });
  });

  it("where storage cannot be closed to pages (the second layer: before Chrome 140): the line says so, nothing is asked of Chrome, Remove works", async () => {
    await mount({ hosts: ["b.example.com"], grants: [], closable: false });
    expect(text()).toContain(t("afsOld"));
    expect(button("b.example.com", "afs-again")).toBeUndefined();
    w.click(button("b.example.com", "afs-remove")!);
    await settle();
    expect(row("b.example.com")).toBeUndefined();
    expect(w.log.filter((l) => l.startsWith("request"))).toEqual([]);
  });
});
