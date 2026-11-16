// TOTP autofill Stage 2, patch 2: the sites, their grants and reconcile (docs/design/notes/AUTOFILL2-NOTES.md §7):
//   - core/autofill-sites.ts: which hosts may be turned on (https only, no IP address, no loopback name, no shared suffix,
//     not the API host, canonical only, at most 253 characters), the one pattern each asks for, a stored list read back;
//   - platform/autofill-sites.ts: the request (exactly one origin; the ask noted in the same synchronous run), the page's
//     and the worker's end of an ask (review M7: exactly that pattern, within a minute), Remove (Chrome's grant given back
//     only when Chrome lists exactly that pattern), the list's lock and its cap;
//   - platform/autofill-reconcile.ts: list ∩ granted, a site withdrawn in Chrome's own UI dropping out while the list
//     keeps it (review m4), the gate first (review m3: STORAGEGATE's storageClosed; one diagnostics line), runs one after
//     another with triggers joining a waiting run, a run given up after its time applying nothing, failures closed.
import { describe, expect, it } from "vitest";
import { MAX_SITES, readSites, siteHostOk, siteOfUrl, sitePattern } from "../../src/core/autofill-sites";
import { MemoryKV } from "../../src/core/storage/kv";
import { closedBy } from "../../src/platform/storage-access";
import { createReconciler, GATED_NOTE, reconcileOnce, type ReconcileDeps } from "../../src/platform/autofill-reconcile";
import {
  acceptPending,
  addSite,
  answered,
  API_HOST,
  laterList,
  LATER_KEY,
  notNow,
  PENDING_KEY,
  PENDING_MS,
  readList,
  removeSite,
  requestSite,
  siteGranted,
  SITES_KEY,
  type SitePermissions,
} from "../../src/platform/autofill-sites";
import { covers } from "../helpers/sw-world";

const API = "api.sixkey.app";
const pat = (h: string) => `https://${h}/*`;

/** chrome.permissions over a set of granted patterns, matched as Chrome matches them; every call logged. */
function grants(initial: string[] = []) {
  const set = new Set(initial);
  const log: [string, unknown][] = [];
  const p: SitePermissions = {
    contains: async (x) => {
      log.push(["contains", x]);
      return x.origins.every((a) => [...set].some((g) => covers(g, a)));
    },
    request: async (x) => {
      log.push(["request", x]);
      for (const o of x.origins) set.add(o);
      return true;
    },
    remove: async (x) => {
      log.push(["remove", x]);
      return x.origins.every((o) => set.delete(o));
    },
    getAll: async () => {
      log.push(["getAll", null]);
      return { origins: [...set] };
    },
  };
  return { p, set, log };
}

describe("core: which hosts may be turned on", () => {
  it("an exact, canonical https host name: not an IP address, a loopback name, a shared suffix or the API host", () => {
    expect(API_HOST).toBe(API); // the unbuilt code's origin: the store build's
    for (const h of ["github.com", "login.github.com", "alice.github.io", "xn--bcher-kva.example", "a_b.example.com"])
      expect(siteHostOk(h, API), h).toBe(true);
    for (const h of [
      "",
      "com",
      "localhost",
      "intranet",
      "127.0.0.1",
      "10.0.0.8",
      "[::1]",
      "co.uk",
      "github.io",
      "amazonaws.com", // above a shared suffix (s3.amazonaws.com)
      API,
      "GitHub.com",
      "github.com.",
      "github.com:8443",
      "*.github.com",
      "https://github.com",
      "github.com/x",
      "bücher.example",
      "a b.com",
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}.com`, // 257 characters
    ])
      expect(siteHostOk(h, API), h).toBe(false);
    expect(siteHostOk(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`, API)).toBe(true); // 253, the most
    for (const x of [undefined, null, 7, ["github.com"], { host: "github.com" }])
      expect(siteHostOk(x, API)).toBe(false);
  });

  it("the pattern is exactly https://<host>/* (no wildcard, no http, no port), and none for a host that may not be", () => {
    expect(sitePattern("github.com", API)).toBe("https://github.com/*");
    expect(sitePattern("login.github.com", API)).toBe("https://login.github.com/*");
    for (const h of ["*", "*.github.com", "localhost", "127.0.0.1", "co.uk", API, "GITHUB.COM"])
      expect(sitePattern(h, API), h).toBeNull();
  });

  it("a page offers its host only over https at the default port, without a user name", () => {
    expect(siteOfUrl("https://github.com/login?x=1#y", API)).toBe("github.com");
    expect(siteOfUrl("https://github.com:443/", API)).toBe("github.com"); // the parser drops the default port
    for (const u of [
      "http://github.com/",
      "https://github.com:8443/",
      "https://user:pw@github.com/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://github.io/",
      `https://${API}/`,
      "ftp://github.com/",
      "chrome://extensions/",
      "file:///etc/passwd",
      "",
      undefined,
      "not a url",
    ])
      expect(siteOfUrl(u, API), String(u)).toBeNull();
  });

  it("a stored list reads back as its valid hosts, once each, at most 32; anything else is none", () => {
    const hosts = Array.from({ length: 40 }, (_, i) => `s${i}.example.com`);
    expect(readSites({ v: 1, hosts }, API)).toEqual(hosts.slice(0, MAX_SITES));
    expect(readSites({ v: 1, hosts: ["a.com", "a.com", "http://b.com", API, "c.com", 7], extra: 1 }, API)).toEqual([
      "a.com",
      "c.com",
    ]);
    for (const raw of [
      undefined,
      null,
      [],
      "a.com",
      { hosts: ["a.com"] },
      { v: 2, hosts: ["a.com"] },
      { v: 1, hosts: "a.com" },
    ])
      expect(readSites(raw, API)).toEqual([]);
  });
});

describe("platform: asking Chrome for one site", () => {
  it("asks for exactly that one origin, then notes the ask, both before it returns", () => {
    const { p, log } = grants();
    const order: string[] = [];
    const session = new MemoryKV();
    const traced: SitePermissions = { ...p, request: (x) => (order.push("request"), p.request(x)) };
    const area = {
      get: (k: string[]) => session.get(k),
      set: (i: Record<string, unknown>) => (order.push("note"), session.set(i)),
      remove: (k: string[]) => session.remove(k),
    };
    void requestSite("github.com", traced, area, 1000);
    expect(order).toEqual(["request", "note"]); // the request first, both in the click's synchronous run
    // `scripting` with it, in the one request (optional since W1b: a site turned on before the first Fill gets it there)
    expect(log).toEqual([["request", { permissions: ["scripting"], origins: ["https://github.com/*"] }]]);
  });

  it("never asks for a host that may not be turned on", async () => {
    for (const h of ["localhost", "127.0.0.1", "co.uk", API, "*.github.com", "github.com:8443", "GitHub.com", ""]) {
      const { p, log } = grants();
      const session = new MemoryKV();
      expect(await requestSite(h, p, session, 1000), h).toBe(false);
      expect(log, h).toEqual([]);
      expect(session.data.size, h).toBe(0);
    }
  });

  it("a request that throws at once is a no, and notes nothing", async () => {
    const session = new MemoryKV();
    const p = {
      ...grants().p,
      request: () => {
        throw new Error("This function must be called during a user gesture");
      },
    } as SitePermissions;
    expect(await requestSite("github.com", p, session, 1000)).toBe(false);
    expect(session.data.size).toBe(0);
  });

  it("the page's end: granted, the site goes on the list and the note goes; refused, not offered again", async () => {
    const local = new MemoryKV();
    const session = new MemoryKV();
    const { p } = grants();
    await requestSite("github.com", p, session, 1000);
    expect(session.data.get(PENDING_KEY)).toEqual({ v: 1, host: "github.com", at: 1000 });
    expect(await answered("github.com", true, local, session)).toBe(true);
    expect(await readList(local)).toEqual(["github.com"]);
    expect(session.data.has(PENDING_KEY)).toBe(false);
    await requestSite("gitlab.com", p, session, 2000);
    expect(await answered("gitlab.com", false, local, session)).toBe(false);
    expect(await readList(local)).toEqual(["github.com"]);
    expect(await laterList(session)).toEqual(["gitlab.com"]);
    expect(session.data.has(PENDING_KEY)).toBe(false);
    await notNow("example.org", session);
    expect(await laterList(session)).toEqual(["gitlab.com", "example.org"]);
    expect(session.data.get(LATER_KEY)).toEqual({ v: 1, hosts: ["gitlab.com", "example.org"] });
  });

  it("the worker's end (review M7): exactly the asked pattern, within a minute; nothing else is ever added", async () => {
    const at = 50_000;
    const setup = async (pending: unknown) => {
      const local = new MemoryKV();
      const session = new MemoryKV();
      if (pending !== undefined) await session.set({ [PENDING_KEY]: pending });
      return { local, session };
    };
    const ask = { v: 1, host: "github.com", at };
    // the asked site, at 0 s and at exactly a minute
    for (const now of [at, at + PENDING_MS]) {
      const { local, session } = await setup(ask);
      expect(await acceptPending({ origins: ["https://github.com/*"] }, local, session, now)).toBe(true);
      expect(await readList(local)).toEqual(["github.com"]);
      expect(session.data.has(PENDING_KEY)).toBe(false);
    }
    const no: [string, unknown, string[], number][] = [
      ["a minute and a millisecond late", ask, ["https://github.com/*"], at + PENDING_MS + 1],
      ["a time before the ask", ask, ["https://github.com/*"], at - 1],
      ["On all sites, granted in Chrome's menu", ask, ["https://*/*"], at + 1],
      ["the sync API's origin (sync turned on)", ask, [`https://${API}/*`], at + 1],
      ["another site", ask, ["https://gitlab.com/*"], at + 1],
      ["a subdomain of the asked site", ask, ["https://gist.github.com/*"], at + 1],
      ["the asked site over http", ask, ["http://github.com/*"], at + 1],
      ["no ask at all", undefined, ["https://github.com/*"], at + 1],
      ["an ask of another shape", { ...ask, extra: 1 }, ["https://github.com/*"], at + 1],
      ["an ask for a host that may not be", { v: 1, host: API, at }, [`https://${API}/*`], at + 1],
    ];
    for (const [what, pending, origins, now] of no) {
      const { local, session } = await setup(pending);
      expect(await acceptPending({ origins }, local, session, now), what).toBe(false);
      expect(local.data.has(SITES_KEY), what).toBe(false);
    }
    // an ask no answer can finish any more is dropped
    const { local, session } = await setup(ask);
    await acceptPending({ origins: ["https://github.com/*"] }, local, session, at + PENDING_MS + 1);
    expect(session.data.has(PENDING_KEY)).toBe(false);
  });

  it("the list: no duplicate, no host that may not be on it, at most 32, and changes in parallel all land (one lock)", async () => {
    const local = new MemoryKV();
    expect(await addSite("github.com", local)).toBe(true);
    expect(await addSite("github.com", local)).toBe(true);
    for (const h of ["localhost", "127.0.0.1", API, "co.uk"]) expect(await addSite(h, local), h).toBe(false);
    const many = Array.from({ length: 40 }, (_, i) => `s${i}.example.com`);
    await Promise.all(many.map((h) => addSite(h, local)));
    const list = await readList(local);
    expect(list.length).toBe(MAX_SITES);
    expect(list[0]).toBe("github.com");
    expect(new Set(list).size).toBe(MAX_SITES);
    expect(await addSite("one-more.example.com", local)).toBe(false);
  });

  it("Remove: off the list, and Chrome's grant given back only when Chrome lists exactly that site's pattern", async () => {
    // exactly granted: removed, and only that pattern (never the API's)
    let local = new MemoryKV();
    await local.set({ [SITES_KEY]: { v: 1, hosts: ["github.com", "gitlab.com"] } });
    let g = grants([pat("github.com"), pat("gitlab.com"), `https://${API}/*`]);
    await removeSite("github.com", local, g.p);
    expect(await readList(local)).toEqual(["gitlab.com"]);
    expect(g.log.filter(([k]) => k === "remove")).toEqual([["remove", { origins: ["https://github.com/*"] }]]);
    expect([...g.set]).toEqual([pat("gitlab.com"), `https://${API}/*`]);
    // only "On all sites" covers it: the broad grant stays as the user chose it; the site is off the list anyway
    local = new MemoryKV();
    await local.set({ [SITES_KEY]: { v: 1, hosts: ["github.com"] } });
    g = grants(["https://*/*"]);
    await removeSite("github.com", local, g.p);
    expect(await readList(local)).toEqual([]);
    expect(g.log.some(([k]) => k === "remove")).toBe(false);
    expect([...g.set]).toEqual(["https://*/*"]);
    // a grant Chrome will not remove (a required one): the site is off the list all the same
    local = new MemoryKV();
    await local.set({ [SITES_KEY]: { v: 1, hosts: ["github.com"] } });
    g = grants([pat("github.com")]);
    const refusing = {
      ...g.p,
      remove: async () => Promise.reject(new Error("You cannot remove required permissions.")),
    };
    await removeSite("github.com", local, refusing);
    expect(await readList(local)).toEqual([]);
  });

  it("a site's grant: its pattern, covered exactly or by a broad grant; a failure to ask is a no", async () => {
    expect(await siteGranted("github.com", grants([pat("github.com")]).p)).toBe(true);
    expect(await siteGranted("github.com", grants(["https://*/*"]).p)).toBe(true);
    expect(await siteGranted("github.com", grants([pat("gist.github.com"), "http://github.com/*"]).p)).toBe(false);
    expect(await siteGranted("localhost", grants(["https://*/*"]).p)).toBe(false);
    const failing = { ...grants().p, contains: async () => Promise.reject(new Error("x")) };
    expect(await siteGranted("github.com", failing)).toBe(false);
  });
});

/** Reconcile's dependencies over a list and a grant set; `apply` records what it was given, and overlapping applies. */
function deps(o: { hosts?: string[]; granted?: string[]; gate?: boolean } = {}) {
  const state = { hosts: o.hosts ?? [], granted: new Set(o.granted ?? []), gate: o.gate ?? true };
  const applied: string[][] = [];
  const notes: string[] = [];
  const asked: string[] = [];
  let active = 0;
  let overlap = 0;
  const d: ReconcileDeps = {
    gate: async () => state.gate,
    hosts: async () => [...state.hosts],
    granted: async (h) => {
      asked.push(h);
      return [...state.granted].some((g) => covers(g, pat(h)));
    },
    apply: async (hosts) => {
      if (++active > 1) overlap++;
      await new Promise((r) => setTimeout(r, 5));
      applied.push(hosts);
      active--;
    },
    note: (line) => void notes.push(line),
  };
  return { d, state, applied, notes, asked, overlaps: () => overlap };
}

describe("the worker's gate: storageClosed's rule over this start's own answer (closedBy)", () => {
  it("both areas accepted, and only then; a refusal, a rejection or no answer in time is a no, never a rejection", async () => {
    expect(await closedBy(Promise.resolve({ local: true, session: true }))).toBe(true);
    for (const r of [
      { local: false, session: true },
      { local: true, session: false },
      { local: false, session: false },
    ])
      expect(await closedBy(Promise.resolve(r)), JSON.stringify(r)).toBe(false);
    expect(await closedBy(Promise.reject(new Error("x")))).toBe(false);
    expect(await closedBy(new Promise(() => undefined), 30)).toBe(false);
  });
});

describe("reconcile: the sites that count are the list ∩ Chrome's grants, behind the gate", () => {
  it("list ∩ granted, each site asked for its own pattern", async () => {
    const x = deps({ hosts: ["a.com", "b.com", "c.com"], granted: [pat("a.com"), pat("c.com"), pat("z.com")] });
    expect(await reconcileOnce(x.d)).toEqual({ k: "applied", hosts: ["a.com", "c.com"] });
    expect(x.asked).toEqual(["a.com", "b.com", "c.com"]);
    expect(x.applied).toEqual([["a.com", "c.com"]]);
  });

  it("a site withdrawn in Chrome's own UI stops counting at the next run; the list keeps it (no pruning)", async () => {
    const x = deps({ hosts: ["a.com", "b.com"], granted: [pat("a.com"), pat("b.com")] });
    const run = createReconciler(x.d);
    await run();
    x.state.granted.delete(pat("b.com")); // chrome://extensions › Site access: the site removed
    expect(await run()).toEqual({ k: "applied", hosts: ["a.com"] });
    expect(x.applied).toEqual([["a.com", "b.com"], ["a.com"]]);
    expect(x.state.hosts).toEqual(["a.com", "b.com"]);
    x.state.granted.add(pat("b.com")); // granted again
    expect(await run()).toEqual({ k: "applied", hosts: ["a.com", "b.com"] });
  });

  it('"On all sites" turns on nothing that is not on the list', async () => {
    const empty = deps({ granted: ["https://*/*"] });
    expect(await reconcileOnce(empty.d)).toEqual({ k: "applied", hosts: [] });
    const one = deps({ hosts: ["a.com"], granted: ["https://*/*"] });
    expect(await reconcileOnce(one.d)).toEqual({ k: "applied", hosts: ["a.com"] });
  });

  it("the gate closed: nothing counts, whatever the list and the grants; one line when the list has sites", async () => {
    const x = deps({ hosts: ["a.com"], granted: [pat("a.com")], gate: false });
    expect(await reconcileOnce(x.d)).toEqual({ k: "gated" });
    expect(x.applied).toEqual([[]]);
    expect(x.asked).toEqual([]); // not even asked
    expect(x.notes).toEqual([GATED_NOTE]);
    const none = deps({ gate: false });
    await reconcileOnce(none.d);
    expect(none.notes).toEqual([]);
    expect(none.applied).toEqual([[]]);
  });

  it("is idempotent: the same state gives the same sites", async () => {
    const x = deps({ hosts: ["a.com", "b.com"], granted: [pat("a.com")] });
    const run = createReconciler(x.d);
    await run();
    await run();
    expect(x.applied).toEqual([["a.com"], ["a.com"]]);
  });

  it("a failure applies none (closed when unsure)", async () => {
    for (const broken of ["gate", "hosts", "granted"] as const) {
      const x = deps({ hosts: ["a.com"], granted: [pat("a.com")] });
      x.d[broken] = async () => Promise.reject(new Error(broken));
      expect(await reconcileOnce(x.d), broken).toEqual({ k: "failed" });
      expect(x.applied, broken).toEqual([[]]);
    }
  });

  it("runs one after another: triggers that come together never overlap, and those that wait join one run", async () => {
    const x = deps({ hosts: ["a.com"], granted: [pat("a.com")] });
    let open!: () => void;
    const first = new Promise<boolean>((r) => (open = () => r(true)));
    let gates = 0;
    x.d.gate = () => (++gates === 1 ? first : Promise.resolve(true));
    const run = createReconciler(x.d);
    const runs = [run(), run()]; // two triggers in one tick: the run has read nothing yet, so it covers both
    expect(runs[1]).toBe(runs[0]);
    await new Promise((r) => setTimeout(r, 5)); // the run is out, waiting for the gate
    runs.push(run(), run(), run()); // onAdded, onRemoved and a list change meanwhile
    await new Promise((r) => setTimeout(r, 20));
    expect(gates).toBe(1); // they wait for their turn
    expect(runs[2]).not.toBe(runs[0]);
    expect(runs[3]).toBe(runs[2]); // and the waiting ones are one run
    expect(runs[4]).toBe(runs[2]);
    x.state.granted.clear();
    open();
    const outcomes = await Promise.all(runs);
    expect(gates).toBe(2);
    expect(x.overlaps()).toBe(0);
    expect(outcomes[2]).toEqual({ k: "applied", hosts: [] });
    expect(x.applied).toEqual([[], []]);
    // a trigger after the queue has drained starts a run of its own
    await run();
    expect(gates).toBe(3);
  });

  it("a run still out after its time is given up: the next run starts, and the late one applies nothing", async () => {
    const x = deps({ hosts: ["a.com", "b.com"], granted: [pat("a.com"), pat("b.com")] });
    let release!: () => void;
    const stuck = new Promise<boolean>((r) => (release = () => r(true)));
    let calls = 0;
    const granted = x.d.granted;
    x.d.granted = (h) => (++calls === 1 ? stuck : granted(h));
    const run = createReconciler(x.d, 40);
    const late = run();
    await new Promise((r) => setTimeout(r, 5)); // out, and stuck
    const next = run();
    expect(await late).toEqual({ k: "late" });
    expect(await next).toEqual({ k: "applied", hosts: ["a.com", "b.com"] });
    release(); // the given-up run carries on, and must apply nothing
    await new Promise((r) => setTimeout(r, 30));
    expect(x.applied).toEqual([["a.com", "b.com"]]);
  });
});
