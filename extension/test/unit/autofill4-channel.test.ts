// AUTOFILL2 patch 4a (docs/design/notes/AUTOFILL2-NOTES.md §12): the worker's end of the content script's messages with the
// in-page suggestion's release gate open (scripts/suggest-ui.mjs; the build's define, stood in for here by a global), and
// closed (the define absent, as in every test that does not set it):
//   - `cand` is answered {show: true, key} for the top frame, after every check of patch 3 and AFSWITCH, the same whether
//     Sixkey is locked or not, with no vault call; {show: false} for every refusal; closed, never answered;
//   - `open`: once per document, only for a document answered show: true, a token of the tab's bucket, the tab in front of
//     a focused window (M6); R v2 written before the popup; in panel mode the side panel opened before anything is
//     awaited, and only for a document this worker answered (a woken worker gives the badge, not the panel); closed, no
//     such message at all.
import { afterEach, describe, expect, it, vi } from "vitest";

const SELF = "abcdefghijklmnopabcdefghijklmnop";
const DOC = "0123456789ABCDEF0123456789ABCDEF";
const good = (o: { frameId?: number; documentId?: string; tab?: number } = {}) => ({
  id: SELF,
  url: "https://login.example.com/2fa",
  origin: "https://login.example.com",
  frameId: o.frameId ?? 0,
  documentId: o.documentId ?? DOC,
  documentLifecycle: "active",
  tab: { id: o.tab ?? 7, windowId: 3, url: "https://login.example.com/2fa", active: true, incognito: false },
});
const cand = { type: "sk-af-cand" };
const open = { type: "sk-af-open" };

afterEach(() => vi.unstubAllGlobals());

async function load(gate: boolean) {
  vi.resetModules();
  if (gate) vi.stubGlobal("__SUGGEST_UI__", true);
  return {
    channel: await import("../../src/platform/content-channel"),
    policy: await import("../../src/platform/sender-policy"),
  };
}

type St = {
  off: boolean;
  gate: boolean;
  sites: string[];
  granted: string[];
  front: boolean;
  opens: "popup" | "panel" | undefined;
  shown: Set<string>;
  opened: Set<string>;
  tokens: number;
  vaultCalls: number;
};
async function world(o: Partial<St> = {}, gate = true) {
  const { channel } = await load(gate);
  const st: St = {
    off: false,
    gate: true,
    sites: ["login.example.com"],
    granted: ["login.example.com"],
    front: true,
    opens: "popup",
    shown: new Set(),
    opened: new Set(),
    tokens: 2,
    vaultCalls: 0,
    ...o,
  };
  const log: string[] = [];
  const requests: unknown[] = [];
  let t = 1_000_000;
  const on = channel.createContentChannel({
    selfId: SELF,
    off: async () => (log.push("off"), st.off),
    gate: async () => (log.push("gate"), st.gate),
    sites: async () => (log.push("sites"), st.sites),
    granted: async (h) => (log.push(`granted:${h}`), st.granted.includes(h)),
    badge: async (tabId) => void log.push(`badge:${tabId}`),
    now: () => t,
    page: {
      key: async () => (log.push("key"), "Alt+Shift+F"),
      shown: {
        note: async (doc) => void (log.push(`note:${doc}`), st.shown.add(doc)),
        take: async (doc) => {
          log.push(`take:${doc}`);
          if (!st.shown.has(doc) || st.opened.has(doc)) return false;
          st.opened.add(doc);
          return true;
        },
      },
      token: async () => (log.push("token"), st.tokens > 0 ? (st.tokens--, true) : false),
      front: async () => (log.push("front"), st.front),
      epoch: async () => (log.push("epoch"), 5),
      request: async (r) => (log.push("request"), requests.push(r), r),
      opens: () => st.opens,
      openPanel: (w) => void log.push(`panel:${w}`),
      openPopup: async (w) => void log.push(`popup:${w}`),
    },
  });
  const ask = async (m: unknown, s: unknown = good()) => {
    const replies: unknown[] = [];
    const outcome = await on(m, s, (a) => void replies.push(a));
    return { outcome, replies };
  };
  return { on, st, log, requests, ask, tick: (ms: number) => void (t += ms) };
}

describe("cand, with the gate open: the answer", () => {
  it("{show: true, key} for the top frame, after every check; the document is recorded as answered", async () => {
    const w = await world();
    expect(await w.ask(cand)).toEqual({ outcome: "badge", replies: [{ show: true, key: "Alt+Shift+F" }] });
    expect(w.log).toEqual(["off", "gate", "sites", "granted:login.example.com", "badge:7", `note:${DOC}`, "key"]);
  });

  it("{show: false} for a frame, for each refusal, and over the rate limit; never more than one answer", async () => {
    const frame = { ...good({ frameId: 2 }) };
    expect((await (await world()).ask(cand, frame)).replies).toEqual([{ show: false }]);
    for (const o of [{ off: true }, { gate: false }, { sites: [] }, { granted: [] }])
      expect((await (await world(o)).ask(cand)).replies, JSON.stringify(o)).toEqual([{ show: false }]);
    const w = await world();
    for (let i = 0; i < 10; i++) await w.ask(cand);
    expect(await w.ask(cand)).toEqual({ outcome: "limited", replies: [{ show: false }] });
  });

  it("the same answer whatever the vault: the channel has no way to it (nothing locked, unlocked or accounts in its deps)", async () => {
    const a = await (await world()).ask(cand);
    const b = await (await world()).ask(cand);
    expect(a).toEqual(b);
    const { channel } = await load(true);
    const page = await import("../../src/platform/content-page");
    const worker = await import("../../src/platform/content-page-worker");
    // the dependencies a page message can reach: none opens the vault or touches activity (m6)
    const src = [channel.createContentChannel, page.pageChannel, worker.workerPage, worker.workerPageChannel]
      .map((f) => f.toString())
      .join("\n");
    expect(src).not.toMatch(/openView|unlock|grantKeys|lastActive|touch\(|entries/);
  });

  it("a sender the browser does not name as the content script gets no answer and nothing else", async () => {
    const w = await world();
    const page = { id: SELF, url: `chrome-extension://${SELF}/popup/index.html`, origin: `chrome-extension://${SELF}` };
    expect(await w.ask(cand, page)).toEqual({ outcome: "ignored", replies: [] });
    expect(w.log).toEqual([]);
  });
});

describe("open, with the gate open", () => {
  it("after show: true: R v2 for that document, written before the popup opens in that tab's window; never answered", async () => {
    const w = await world();
    await w.ask(cand);
    w.log.length = 0;
    const r = await w.ask(open);
    expect(r).toEqual({ outcome: "opened", replies: [] });
    expect(w.requests).toEqual([{ tabId: 7, windowId: 3, url: "https://login.example.com/2fa", epoch: 5, doc: DOC }]);
    expect(w.log).toEqual([
      "off",
      "gate",
      "sites",
      "granted:login.example.com",
      `take:${DOC}`,
      "token",
      "front",
      "epoch",
      "request",
      "popup:3",
      "badge:7",
    ]);
  });

  it("once per document; never for a document not answered show: true", async () => {
    const w = await world();
    expect((await w.ask(open)).outcome).toBe("unseen");
    await w.ask(cand);
    expect((await w.ask(open)).outcome).toBe("opened");
    expect((await w.ask(open)).outcome).toBe("unseen");
    expect(w.requests).toHaveLength(1);
  });

  it("refused for a frame, Autofill off, the gate closed, a site not on or not granted, a tab behind, no token", async () => {
    const cases: [Partial<St>, unknown, string][] = [
      [{}, good({ frameId: 1 }), "frame"],
      [{ off: true }, good(), "off"],
      [{ gate: false }, good(), "gated"],
      [{ sites: [] }, good(), "not-on"],
      [{ granted: [] }, good(), "not-on"],
      [{ front: false }, good(), "behind"],
      [{ tokens: 0 }, good(), "bucket"],
    ];
    for (const [o, s, why] of cases) {
      const w = await world({ ...o, shown: new Set([DOC]) });
      expect((await w.ask(open, s)).outcome, why).toBe(why);
      expect(w.requests, why).toEqual([]);
      expect(
        w.log.some((l) => l.startsWith("popup")),
        why,
      ).toBe(false);
    }
  });

  it("a refusal for want of a token keeps the badge on the tab (the pill has gone as used)", async () => {
    const w = await world({ tokens: 0 });
    await w.ask(cand);
    w.log.length = 0;
    expect((await w.ask(open)).outcome).toBe("bucket");
    expect(w.log).toContain("badge:7");
  });

  it("panel mode: the side panel is opened before anything is awaited, for a document this worker answered", async () => {
    const w = await world({ opens: "panel" });
    await w.ask(cand);
    w.log.length = 0;
    const p = w.on(open, good());
    // synchronously, in the message's own task: the panel first, before any check (the first of which has started:
    // the switch's read is called in the same task, and awaited after)
    expect(w.log[0]).toBe("panel:3");
    expect(w.log.filter((l) => /^(take|token|front|epoch|request)/.test(l))).toEqual([]);
    expect(await p).toBe("opened");
    expect(w.log).not.toContain("popup:3");
    expect(w.requests).toHaveLength(1);
  });

  it("panel mode, a worker started since the answer (no record in memory): no panel, but R and the badge", async () => {
    const w = await world({ opens: "panel", shown: new Set([DOC]) });
    const p = w.on(open, good());
    expect(w.log.some((l) => l.startsWith("panel"))).toBe(false);
    expect(await p).toBe("opened");
    expect(w.log.some((l) => l.startsWith("panel"))).toBe(false);
    expect(w.requests).toHaveLength(1);
    expect(w.log).toContain("badge:7");
  });

  it("panel mode: the synchronous open happens once per document, not for a document answered no", async () => {
    const w = await world({ opens: "panel" });
    await w.ask(cand, good({ frameId: 0 }));
    void w.on(open, good());
    void w.on(open, good());
    expect(w.log.filter((l) => l.startsWith("panel"))).toEqual(["panel:3"]);
    const refused = await world({ opens: "panel", granted: [] });
    await refused.ask(cand);
    refused.log.length = 0;
    void refused.on(open, good());
    expect(refused.log.some((l) => l.startsWith("panel"))).toBe(false);
  });
});

describe("the gate closed (the define absent: every build but dev and e2e until the flip)", () => {
  it("open is no content message; cand gets no answer and works as in patch 3", async () => {
    const { policy } = await load(false);
    expect(Object.keys(policy.CONTENT_MESSAGES)).toEqual(["sk-af-cand"]);
    expect(policy.contentType(open)).toBeNull();
    const w = await world({ shown: new Set([DOC]) }, false);
    expect(await w.ask(open)).toEqual({ outcome: "ignored", replies: [] });
    expect(await w.ask(cand)).toEqual({ outcome: "badge", replies: [] });
    expect(w.log.some((l) => /^(note|key|panel|popup|request)/.test(l))).toBe(false);
  });

  it("with the gate open, open is the content script's second message", async () => {
    const { policy } = await load(true);
    expect(Object.keys(policy.CONTENT_MESSAGES)).toEqual(["sk-af-cand", "sk-af-open"]);
    expect(policy.contentType(open)).toBe("sk-af-open");
  });
});
