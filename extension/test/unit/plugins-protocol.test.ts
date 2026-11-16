// The removed plugin platform's message protocol (src/core/plugins/protocol.ts, kept): what is dropped and
// what is answered, the fixed order of checks with the first failure answered, the sender kinds from the browser's
// fields only, hello's negotiation and its descriptor changes, env.get, the limits, and what a P0 plugin can learn
// (nothing of the lock state).
import { describe, expect, it } from "vitest";
import { readDescriptor } from "../../src/core/plugins/descriptor";
import { tightened, type GrantEntry, type GrantReason } from "../../src/core/plugins/grants";
import { parseCatalog, type Catalog, type Install } from "../../src/core/plugins/policy";
import {
  createRate,
  dispatch,
  isDeclaredWorker,
  LIMITS,
  requestIdOf,
  senderKind,
  type Channel,
  type Deps,
  type Hello,
  type Response,
  type Sender,
} from "../../src/core/plugins/protocol";
import { BLOCKED, descriptor, LISTED, OFFICIAL, PID, OTHER } from "../helpers/plugins";
import { contributionsHash } from "../../src/core/plugins/descriptor";

const catalogWith = async (): Promise<Catalog> => {
  const d = readDescriptor(descriptor(LISTED));
  if (!d.ok) throw new Error();
  return parseCatalog({
    v: 1,
    plugins: [
      {
        id: LISTED,
        trust: "listed",
        name: "Reviewed",
        publisher: "Example",
        store: `https://chromewebstore.google.com/detail/${LISTED}`,
        ceiling: ["ui.slots", "env.read", "accounts.add"],
        contributionsHash: await contributionsHash(d.descriptor),
      },
      { id: BLOCKED, trust: "blocked", name: "Bad", publisher: "Bad", reason: "No." },
    ],
  });
};
const worker = (id: string): Sender => ({ id, url: `chrome-extension://${id}/sw.js` });
const page = (id: string): Sender => ({
  id,
  url: `chrome-extension://${id}/page.html`,
  origin: `chrome-extension://${id}`,
  tab: { url: `chrome-extension://${id}/page.html` },
});
const content = (id: string): Sender => ({
  id,
  url: "https://github.com/login",
  origin: "https://github.com",
  tab: { url: "https://github.com/login" },
});
const msg = (type: string, body: unknown = {}, o: { sdk?: number; id?: string } = {}) => ({
  sdk: o.sdk ?? 1,
  id: o.id ?? "req-00000001",
  type,
  body,
});
const stored = (id: string, over: Partial<GrantEntry> = {}): GrantEntry => {
  const d = readDescriptor(descriptor(id));
  if (!d.ok) throw new Error();
  return {
    pluginId: id,
    state: "approved",
    descriptor: d.descriptor,
    granted: ["ui.slots", "env.read"],
    approvedAt: 1,
    trashed: [],
    ...over,
  };
};

type World = {
  deps: Deps;
  seen: Hello[];
  changed: GrantReason[];
  set(e: GrantEntry | undefined): void;
};
async function world(
  o: { entry?: GrantEntry; install?: Install; waitingFull?: boolean; now?: number } = {},
): Promise<World> {
  const seen: Hello[] = [];
  const changed: GrantReason[] = [];
  const deps: Deps = {
    catalog: await catalogWith(),
    install: o.install ?? null,
    now: o.now ?? 1_000_000,
    rate: createRate(),
    sixkeyVersion: "0.1.0",
    entry: o.entry,
    pauses: [],
    seen: async (h) => {
      if (o.waitingFull) return false;
      seen.push(h);
      return true;
    },
    changed: async (r) => {
      changed.push(r);
      if (deps.entry) deps.entry = tightened(deps.entry, "suspended", r);
    },
    env: async () => ({ theme: "dark", locale: "zh_CN", sixkeyVersion: "0.1.0" }),
  };
  return { deps, seen, changed, set: (e) => void (deps.entry = e) };
}
const ask = (w: World, m: unknown, id = LISTED, ch: Channel = { kind: "message", sender: page(id) }) =>
  dispatch(m, id, ch, w.deps) as Promise<Response>;
const err = (r: Response | null) => (r && !r.ok ? r.error.code : r?.ok ? "ok" : null);

describe("what is dropped silently (§5.4)", () => {
  it("not an object, no valid request ID, or page.candidate (never answered): no answer at all", async () => {
    const w = await world();
    for (const m of [
      null,
      "hello",
      7,
      [],
      { type: "hello" },
      { id: "short", type: "hello" },
      { id: 5 },
      msg("page.candidate"),
    ])
      expect(await dispatch(m, LISTED, { kind: "message", sender: page(LISTED) }, w.deps), JSON.stringify(m)).toBe(
        null,
      );
    expect(requestIdOf(msg("hello"))).toBe("req-00000001");
  });
});

describe("the sender kind, from the browser's fields only (§10.2)", () => {
  it("worker, page, content script; anything that does not add up is none", () => {
    expect(senderKind(worker(PID), PID)).toBe("worker");
    expect(senderKind(page(PID), PID)).toBe("page");
    expect(senderKind({ ...page(PID), tab: undefined }, PID)).toBe("page"); // a popup has no tab
    expect(senderKind(content(PID), PID)).toBe("contentScript");
    expect(senderKind(worker(PID), OTHER)).toBe(null); // the ID is the browser's: another plugin's sender
    expect(senderKind(content(PID), OTHER)).toBe(null); // another extension's content script, on any page
    expect(senderKind({ id: PID, url: `chrome-extension://${OTHER}/sw.js` }, PID)).toBe(null);
    expect(senderKind({ ...page(PID), origin: `chrome-extension://${OTHER}` }, PID)).toBe(null);
    expect(senderKind({ ...page(PID), tab: { url: "https://evil.example/" } }, PID)).toBe(null);
    expect(senderKind({ id: PID, url: "https://x.example/", origin: "https://x.example" }, PID)).toBe(null); // no tab
  });
  it("the declared worker, both normalised with new URL()", () => {
    const d = readDescriptor(descriptor(PID, { worker: "/bg/sw.js" }));
    if (!d.ok) throw new Error();
    expect(isDeclaredWorker({ id: PID, url: `chrome-extension://${PID}/bg/sw.js` }, PID, d.descriptor)).toBe(true);
    expect(isDeclaredWorker({ id: PID, url: `chrome-extension://${PID}/bg/../bg/sw.js` }, PID, d.descriptor)).toBe(
      true,
    );
    expect(isDeclaredWorker({ id: PID, url: `chrome-extension://${PID}/other.js` }, PID, d.descriptor)).toBe(false);
    expect(isDeclaredWorker(page(PID), PID, d.descriptor)).toBe(false);
  });
  it("hello and env.get from a content script are refused `sender`; codes.arm only from the declared worker", async () => {
    const w = await world({ entry: stored(LISTED) });
    expect(
      err(
        await ask(w, msg("hello", { descriptor: descriptor(LISTED) }), LISTED, {
          kind: "message",
          sender: content(LISTED),
        }),
      ),
    ).toBe("sender");
    expect(err(await ask(w, msg("env.get"), LISTED, { kind: "message", sender: content(LISTED) }))).toBe("sender");
    expect(
      err(await ask(w, msg("codes.arm", { tab: 1, docs: ["d"] }), LISTED, { kind: "message", sender: page(LISTED) })),
    ).toBe("sender");
    expect(
      err(await ask(w, msg("codes.forPage", { room: 6 }), LISTED, { kind: "message", sender: worker(LISTED) })),
    ).toBe("sender");
    expect(
      err(
        await ask(w, msg("accounts.add", { accounts: [{ uri: "otpauth://totp/x" }], source: "x" }), LISTED, {
          kind: "port",
        }),
      ),
    ).toBe("sender"); // P2 never on a port
  });
});

describe("the order of checks (§10.6), and the first failure answered", () => {
  it("an unknown plugin gets `not-approved` for everything but hello", async () => {
    const w = await world();
    for (const t of ["env.get", "accounts.list", "codes.get", "made.up"])
      await expect(ask(w, msg(t, t === "codes.get" ? { handle: "a".repeat(16) } : {})), t).resolves.toMatchObject({
        ok: false,
        error: { code: "not-approved" },
      });
  });
  it("the approval state comes before the schema: a disabled plugin's malformed request is `disabled`", async () => {
    const w = await world({ entry: stored(LISTED, { state: "disabled", reason: "user" }) });
    expect(err(await ask(w, { sdk: 1, id: "req-00000001", type: "env.get", body: { extra: 1 }, junk: true }))).toBe(
      "disabled",
    );
    w.set(stored(LISTED, { state: "suspended", reason: "changed" }));
    expect(err(await ask(w, msg("env.get")))).toBe("suspended");
    expect(err(await ask(w, msg("env.get"), BLOCKED, { kind: "message", sender: page(BLOCKED) }))).toBe("blocked");
  });
  it("the schema: strict envelopes, strict bodies, the negotiated version, the size", async () => {
    const w = await world({ entry: stored(LISTED) });
    expect(err(await ask(w, { ...msg("env.get"), extra: 1 }))).toBe("invalid");
    expect(err(await ask(w, msg("env.get", { a: 1 })))).toBe("invalid");
    expect(err(await ask(w, msg("env.get", {}, { sdk: 2 })))).toBe("version");
    expect(err(await ask(w, msg("accounts.update", { changes: [{ handle: "a".repeat(16) }] })))).toBe("invalid"); // minProperties
    expect(err(await ask(w, msg("accounts.add", { accounts: [{ uri: "x".repeat(300_000) }], source: "s" })))).toBe(
      "invalid",
    );
    expect(err(await ask(w, msg("accounts.trash", { handles: new Array(20_000).fill("a".repeat(16)) })))).toBe(
      "too-large",
    );
  });
  it("a capability never granted is `not-granted`, as is one its level cannot hold", async () => {
    const w = await world({ entry: stored(LISTED, { granted: ["ui.slots"] }) });
    expect(err(await ask(w, msg("env.get")))).toBe("not-granted");
    // granted by a stored record, but no listed plugin's level holds them in version 1 (sites.propose is official-only;
    // codes.* come later)
    w.set(stored(LISTED, { granted: ["ui.slots", "env.read", "sites.propose", "codes.read"] }));
    expect(err(await ask(w, msg("sites.propose", { handle: "a".repeat(16), host: "example.com" })))).toBe(
      "not-granted",
    );
    expect(err(await ask(w, msg("codes.get", { handle: "a".repeat(16) })))).toBe("not-granted");
    // an unlisted plugin asking for P1: developer mode, which wave 1 does not have
    const u = await world({ entry: stored(PID) });
    expect(err(await ask(u, msg("accounts.list"), PID, { kind: "port" }))).toBe("developer-mode");
  });
  it("the rate: 60 a minute per plugin, with retryAfterMs; another plugin and the next minute are free", async () => {
    const w = await world({ entry: stored(LISTED) });
    for (let i = 0; i < 60; i++)
      expect(err(await ask(w, msg("env.get", {}, { id: `req-${String(i).padStart(8, "0")}` })))).toBe("ok");
    const r = await ask(w, msg("env.get"));
    expect(r.ok === false && r.error).toEqual({ code: "rate", retryAfterMs: 60_000 });
    w.deps.now += 60_001;
    expect(err(await ask(w, msg("env.get")))).toBe("ok");
    expect(LIMITS.all).toEqual([[60, 60_000]]);
    const rate = createRate();
    for (let i = 0; i < 4; i++) expect(rate.take(PID, ["code"], 0)).toEqual({ ok: true });
    expect(rate.take(PID, ["code"], 0)).toEqual({ retryAfterMs: 60_000 });
    expect(rate.take(OTHER, ["code"], 0)).toEqual({ ok: true });
  });
});

describe("hello (§5)", () => {
  it("a listed plugin not approved yet: pending, nothing more; its descriptor kept for the approval", async () => {
    const w = await world();
    const r = await ask(
      w,
      msg("hello", {
        descriptor: descriptor(LISTED),
        keys: { _execute_action: "Alt+Shift+P", x: "Type PIN in next window" },
      }),
    );
    expect(r).toEqual({ sdk: 1, re: "req-00000001", ok: true, body: { state: "pending", sdkVersion: 1 } });
    expect(w.seen[0]!.descriptor.id).toBe(LISTED);
    expect(w.seen[0]!.keys).toEqual({ _execute_action: "Alt+Shift+P" }); // the free text is ignored, never drawn
  });
  it("approved: its trust, its grants, what it could not use, Sixkey's version", async () => {
    const w = await world({ entry: stored(LISTED) });
    const d = descriptor(LISTED, {
      capabilities: [...(descriptor(LISTED).capabilities as unknown[]), { name: "codes.read", reason: "later" }],
      future: 1,
    });
    const r = await ask(w, msg("hello", { descriptor: d }));
    // asking for more than this Sixkey offers is not a change of what it was approved for: codes.read (P3, not offered
    // in wave 2b) is dropped
    expect(r.ok && r.body).toEqual({
      state: "approved",
      sdkVersion: 1,
      trust: "listed",
      granted: ["ui.slots", "env.read"],
      unavailable: ["capability:codes.read"],
      sixkey: { version: "0.1.0" },
    });
  });
  it("a version-2 plugin that speaks 1 negotiates; one that does not is `version` with what Sixkey supports", async () => {
    const w = await world({ entry: stored(LISTED) });
    const v2 = descriptor(LISTED, { sdkVersion: 2, sdkMin: 1, unknownTopLevel: { x: 1 } });
    // a stored descriptor normalises sdkVersion and sdkMin too: a new pair is a change (it suspends); here, a fresh plugin
    const fresh = await world();
    expect((await ask(fresh, msg("hello", { descriptor: v2 }, { sdk: 2 }))).ok).toBe(true);
    const r = await ask(w, msg("hello", { descriptor: descriptor(LISTED, { sdkVersion: 2 }) }, { sdk: 2 }));
    expect(r.ok === false && r.error).toEqual({ code: "version", supported: { min: 1, max: 1 } });
    expect(err(await ask(w, msg("hello", { descriptor: descriptor(LISTED) }, { sdk: 2 })))).toBe("version"); // the wrong sdk
  });
  it("the descriptor must be the sender's, and a strict body", async () => {
    const w = await world();
    expect(err(await ask(w, msg("hello", { descriptor: descriptor(OTHER) })))).toBe("invalid");
    expect(err(await ask(w, msg("hello", { descriptor: descriptor(LISTED), more: 1 })))).toBe("invalid");
    expect(err(await ask(w, msg("hello", { descriptor: { ...descriptor(LISTED), name: "" } })))).toBe("invalid");
  });
  it("a change outside the allow-list suspends (`changed`); a harmless one does not; a listed plugin's pin is held", async () => {
    const w = await world({ entry: stored(LISTED) });
    expect(
      (await ask(w, msg("hello", { descriptor: descriptor(LISTED, { version: "1.1", description: "new" }) }))).ok &&
        w.changed,
    ).toEqual([]);
    const r = await ask(w, msg("hello", { descriptor: descriptor(LISTED, { publisher: { name: "Someone else" } }) }));
    expect(r.ok && r.body).toEqual({ state: "suspended", sdkVersion: 1 });
    expect(w.changed).toEqual(["changed"]);
    // a contribution added: outside the allow-list and outside the pin; the first reason suspends
    const l = await world({ entry: stored(LISTED) });
    const more = descriptor(LISTED, {
      contributions: [
        ...(descriptor(LISTED).contributions as unknown[]),
        { id: "x", slot: "popup.menu", title: "X", icon: { builtin: "star" } },
      ],
    });
    expect((await ask(l, msg("hello", { descriptor: more }))).ok).toBe(true);
    expect(l.changed).toEqual(["changed"]);
  });
  it("a listed plugin whose stored contributions no longer give the catalog's pin is suspended (changed since review)", async () => {
    const e = stored(LISTED);
    const w = await world({ entry: { ...e, descriptor: { ...e.descriptor, contributions: [] } } });
    const r = await ask(w, msg("hello", { descriptor: descriptor(LISTED, { contributions: [] }) }));
    expect(r.ok && r.body).toEqual({ state: "suspended", sdkVersion: 1 });
    expect(w.changed).toEqual(["changed-since-review"]); // written down, not only computed (a release that fixes the pin needs approval)
    expect(err(await ask(w, msg("env.get")))).toBe("suspended");
  });
  it("with management, a third-party plugin's new version is a change to approve only if it holds more than P0 (OD-2)", async () => {
    const install = { installType: "normal", version: "1.1", name: "Reviewed", enabled: true };
    const p0 = await world({ entry: stored(LISTED), install });
    const r = await ask(p0, msg("hello", { descriptor: descriptor(LISTED, { version: "1.1" }) }));
    expect(r).toMatchObject({ ok: true, body: { state: "approved" } });
    expect(p0.changed).toEqual([]); // P0 only: nothing paused (Settings › Plugins says it was updated)
    const more = await world({ entry: stored(LISTED, { granted: ["ui.slots", "env.read", "accounts.add"] }), install });
    const s = await ask(more, msg("hello", { descriptor: descriptor(LISTED, { version: "1.1" }) }));
    expect(s).toMatchObject({ ok: true, body: { state: "suspended" } });
    expect(more.changed).toEqual(["changed"]);
  });
  it("minVersion is held to the version the plugin has now: its hello's, or Chrome's with management (F5)", async () => {
    const cat = parseCatalog({
      v: 1,
      plugins: [
        {
          id: OFFICIAL,
          trust: "official",
          name: "Official",
          publisher: "Sixkey",
          ceiling: ["ui.slots", "env.read"],
          minVersion: "1.2",
        },
      ],
    });
    const at10 = stored(OFFICIAL); // approved at 1.0.0
    const w = await world({ entry: at10 });
    w.deps.catalog = cat;
    const hi = (version: string, id = "req-00000001") =>
      ask(w, msg("hello", { descriptor: descriptor(OFFICIAL, { version }) }, { id }), OFFICIAL, {
        kind: "message",
        sender: worker(OFFICIAL),
      });
    expect(await hi("1.1.0")).toMatchObject({ ok: true, body: { state: "suspended" } }); // still below
    expect(await hi("1.2.0", "req-00000002")).toMatchObject({ ok: true, body: { state: "approved" } }); // updated
    // with management, Chrome's version counts, whatever the hello says
    w.deps.install = { installType: "normal", version: "1.0.0", name: "Official", enabled: true };
    expect(await hi("1.2.0", "req-00000003")).toMatchObject({ ok: true, body: { state: "suspended" } });
  });
  it("too many plugins waiting: `rate` (§5.4)", async () => {
    const w = await world({ waitingFull: true });
    expect(err(await ask(w, msg("hello", { descriptor: descriptor(LISTED) })))).toBe("rate");
  });
  it("a blocked plugin's hello says blocked, nothing more", async () => {
    const w = await world();
    const r = await ask(w, msg("hello", { descriptor: descriptor(BLOCKED) }), BLOCKED, {
      kind: "message",
      sender: page(BLOCKED),
    });
    expect(r.ok && r.body).toEqual({ state: "blocked", sdkVersion: 1 });
  });
  it("a not-approved plugin learns no version, trust, grant or lock state", async () => {
    for (const entry of [
      undefined,
      stored(LISTED, { state: "disabled", reason: "user" }),
      stored(LISTED, { state: "suspended", reason: "changed" }),
    ]) {
      const w = await world({ ...(entry ? { entry } : {}) });
      const r = await ask(w, msg("hello", { descriptor: descriptor(LISTED) }));
      expect(r.ok && Object.keys(r.body).sort()).toEqual(["sdkVersion", "state"]);
    }
  });
});

describe("env.get, and what a P0 plugin can learn (§6.3, §10.6)", () => {
  it("env.get answers the theme, the language and Sixkey's version", async () => {
    const w = await world({ entry: stored(LISTED) });
    const r = await ask(w, msg("env.get"));
    expect(r.ok && r.body).toEqual({ theme: "dark", locale: "zh_CN", sixkeyVersion: "0.1.0" });
  });
  it("the answers depend on nothing but the stored record: the deps hold no lock state, and the answers never say `locked`", async () => {
    const w = await world({ entry: stored(LISTED) });
    // Deps has no lock state at all: what hello and env.get read is the record, the overlay and the pauses (§6.6 item 3)
    expect(Object.keys(w.deps).sort()).toEqual(
      ["catalog", "changed", "entry", "env", "install", "now", "pauses", "rate", "seen", "sixkeyVersion"].sort(),
    );
    const codes = new Set<string>();
    for (const t of ["hello", "env.get", "accounts.list", "codes.get", "codes.forPage", "accounts.add", "made.up"]) {
      const r = await ask(w, msg(t, t === "hello" ? { descriptor: descriptor(LISTED) } : {}));
      codes.add(err(r)!);
    }
    expect(codes.has("locked")).toBe(false);
    expect(codes.has("unavailable")).toBe(false);
  });
});
