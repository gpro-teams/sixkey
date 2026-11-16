// TOTP autofill Stage 3, AF3-3a: the site rules' baseline bundle in the package (docs/design/notes/AUTOFILL3-NOTES.md §4).
//   - the reader the extension and the build share (src/core/rules/baseline.ts parseBaseline);
//   - the extension's read of its own package file (src/platform/package-data.ts readRules): the one path, once per
//     context (calls that come together share the read; a lost read is read again), bounded in size and time (the body's
//     too), null on anything wrong, nothing written anywhere, and called by nothing yet;
//   - what a build carries and how (scripts/rules-package.mjs): the bundle in bundle.mjs's form, its licence file, the
//     build's LICENSE.txt line, the data probes check-dist uses, and the store package's source gate.
// The builds themselves, and check-dist on them: autofill1-check-dist.test.ts and m5-check-dist-tamper.test.ts; the store
// package's gates on real runs: m5-build-guard.test.ts; Chrome's own read: test/e2e/rules-package.spec.ts.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { BASELINE_FILE, BASELINE_MAX_BYTES, parseBaseline } from "../../src/core/rules/baseline";
import {
  BASELINE_SOURCE,
  checkedBaseline,
  dataProbes,
  e2eBaselineText,
  extensionLicenceText,
  LICENCE_LINE,
  normalised,
  PACKAGED_BASELINE,
  PACKAGED_LICENCE,
  rulesLicenceText,
  sourceGate,
} from "../../scripts/rules-package.mjs";

const EXT = resolve(__dirname, "../..");
const REPO = resolve(EXT, "..");
const read = (p: string) => readFileSync(p, "utf8");
const COMMITTED = read(resolve(REPO, "rules/build/baseline.json"));
type J = Record<string, any>;
const changed = (f: (b: J) => void) => {
  const b = JSON.parse(COMMITTED);
  f(b);
  return `${JSON.stringify(b, null, 2)}\n`;
};

describe("the reader (core/rules/baseline.ts), the same in the build, check-dist and the extension", () => {
  it("reads the committed bundle, and the package holds it at the one path the extension asks for", () => {
    const r = parseBaseline(COMMITTED);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ kind: "baseline", version: JSON.parse(COMMITTED).version });
    expect(BASELINE_FILE).toBe("rules/baseline.json");
    expect(PACKAGED_BASELINE).toBe(BASELINE_FILE);
    expect(COMMITTED.length).toBeLessThan(BASELINE_MAX_BYTES / 10); // ~20 KB under a 1 MiB limit
  });
  it("refuses anything else: not JSON, too large, a live bundle, a bundle the format refuses", () => {
    expect(parseBaseline("{")).toEqual({ ok: false, error: "not JSON" });
    expect(parseBaseline(" ".repeat(BASELINE_MAX_BYTES + 1))).toEqual({
      ok: false,
      error: `larger than ${BASELINE_MAX_BYTES} bytes`,
    });
    expect(parseBaseline(changed((b) => (b.kind = "live"))).ok).toBe(false);
    expect(parseBaseline(changed((b) => (b.extra = 1))).ok).toBe(false);
    expect(parseBaseline(changed((b) => b.aliases.push({ s: ["github.io", "a-site.com"] }))).ok).toBe(false);
    expect(parseBaseline(changed((b) => b.aliases.push({ s: ["a.test", "b-site.com"] }))).ok).toBe(false); // reserved
  });
  it("reserved names only when asked (the e2e build's reader, for its test rules: AF3-3b), and nothing else let through", () => {
    const reserved = changed((b) => b.aliases.push({ s: ["a.test", "b-site.com"] }));
    expect(parseBaseline(reserved, { allowReserved: true }).ok).toBe(true);
    expect(parseBaseline(reserved, { allowReserved: false }).ok).toBe(false);
    expect(parseBaseline(reserved, {}).ok).toBe(false);
    expect(
      parseBaseline(
        changed((b) => b.aliases.push({ s: ["github.io", "a-site.com"] })),
        { allowReserved: true },
      ).ok,
    ).toBe(false);
    expect(
      parseBaseline(
        changed((b) => (b.kind = "live")),
        { allowReserved: true },
      ).ok,
    ).toBe(false);
  });
});

describe("the e2e build's bundle (rules-package.mjs e2eBaselineText): the committed one with its test rules", () => {
  const OVERLAY = resolve(EXT, "test/fixtures/rules");
  /** A copy of the overlay folder with `edit` made to it: its path. */
  const made: string[] = [];
  afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const overlay = (edit: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "sixkey-overlay-"));
    made.push(dir);
    cpSync(OVERLAY, dir, { recursive: true });
    edit(dir);
    return dir;
  };
  it("adds each test rule as bundle.mjs writes a rule, and the test appends host (AF3-5), all sorted; nothing else changes", async () => {
    const text = await e2eBaselineText(COMMITTED);
    expect(text.endsWith("}\n")).toBe(true);
    const b = JSON.parse(text);
    expect(b.rules).toEqual({
      "e2e-group": {
        pages: [{ path: "/rule/", field: "input.digit", segments: 6, fill: "chars" }],
        flags: ["sent"],
        minLeft: 20,
      },
      "e2e-one": { pages: [{ path: "/rule/", field: "#code-box", segments: 0, fill: "auto" }] },
    });
    expect(Object.keys(b.rules)).toEqual(["e2e-group", "e2e-one"]);
    expect(b.hosts).toEqual({ "rules.fix.test": "e2e-one", "rules2.fix.test": "e2e-group" });
    const base = JSON.parse(COMMITTED);
    // Apple's appends kept, the test host added among them (appends.json), sorted as bundle.mjs sorts them
    expect(base.appends).toEqual(["auth.redhat.com", "etrade.com", "usaa.com"]);
    expect(b.appends).toEqual(["append.fix.test", "auth.redhat.com", "etrade.com", "usaa.com"]);
    // and Apple's groups kept, the test group (aliases.json, AF3-4) among them, sorted as bundle.mjs sorts them
    const key = (g: unknown) => JSON.stringify(g);
    expect(b.aliases.filter((g: unknown) => !base.aliases.map(key).includes(key(g)))).toEqual([
      { f: ["old.alias.test"], t: ["new.alias.test"] },
    ]);
    expect(b.aliases.map(key)).toEqual([...b.aliases.map(key)].sort());
    expect(b.aliases).toHaveLength(base.aliases.length + 1);
    expect({ ...b, rules: base.rules, hosts: base.hosts, appends: base.appends, aliases: base.aliases }).toEqual(base);
    expect(`${JSON.stringify(b, null, 2)}\n`).toBe(text); // bundle.mjs's form
    // the e2e build's reader takes it; no other build's would (reserved names)
    expect(parseBaseline(text, { allowReserved: true }).ok).toBe(true);
    expect(parseBaseline(text)).toMatchObject({ ok: false, error: expect.stringMatching(/reserved name/) });
    await expect(checkedBaseline(text, "x", { allowReserved: true })).resolves.toMatchObject({ text });
    await expect(checkedBaseline(text, "x")).rejects.toThrow(/reserved name/);
  });
  /** aliases.json made `v` (an object, or text as it is). */
  const aliasesFile = (d: string, v: unknown) =>
    writeFileSync(join(d, "aliases.json"), typeof v === "string" ? v : JSON.stringify(v));
  /** appends.json made `v` (an object, or text as it is). */
  const appendsFile = (d: string, v: unknown) =>
    writeFileSync(join(d, "appends.json"), typeof v === "string" ? v : JSON.stringify(v));
  const appendsCases = (): [string, (d: string) => void, RegExp][] => [
    [
      "no appends.json",
      (d) => rmSync(join(d, "appends.json")),
      /the e2e build's test appends \(appends\.json\) are missing/,
    ],
    ["a list, not an object", (d) => appendsFile(d, ["append.fix.test"]), /appends\.json\): \{"hosts"/],
    ["no host", (d) => appendsFile(d, { hosts: [], note: "x" }), /appends\.json\): \{"hosts"/],
    ["no note", (d) => appendsFile(d, { hosts: ["a.fix.test"] }), /appends\.json\): \{"hosts"/],
    ["another field", (d) => appendsFile(d, { hosts: ["a.fix.test"], note: "x", live: true }), /\{"hosts"/],
    [
      "a host twice",
      (d) => appendsFile(d, { hosts: ["a.fix.test", "a.fix.test"], note: "x" }),
      /a\.fix\.test is there twice/,
    ],
    [
      "one of Apple's",
      (d) => appendsFile(d, { hosts: ["etrade.com"], note: "x" }),
      /etrade\.com is there twice, or already/,
    ],
    [
      "a host the format refuses (upper case)",
      (d) => appendsFile(d, { hosts: ["Append.fix.test"], note: "x" }),
      /the e2e build's bundle: bundle\.appends\[0\]/,
    ],
    [
      "a shared suffix",
      (d) => appendsFile(d, { hosts: ["github.io"], note: "x" }),
      /the e2e build's bundle: bundle\.appends\[\d\]/,
    ],
    ["not JSON", (d) => appendsFile(d, "{"), /JSON/],
    // the test alias groups (AF3-4): aliases.json, as {groups, note}, each group one the format accepts, new
    [
      "no aliases.json",
      (d) => rmSync(join(d, "aliases.json")),
      /the e2e build's test alias groups \(aliases\.json\) are missing/,
    ],
    ["groups as a list", (d) => aliasesFile(d, [{ s: ["a.test", "b.test"] }]), /aliases\.json\): \{"groups"/],
    ["no group", (d) => aliasesFile(d, { groups: [], note: "x" }), /aliases\.json\): \{"groups"/],
    [
      "another field",
      (d) => aliasesFile(d, { groups: [{ s: ["a.test", "b.test"] }], note: "x", live: 1 }),
      /\{"groups"/,
    ],
    [
      "a group twice",
      (d) => aliasesFile(d, { groups: [{ s: ["a.test", "b.test"] }, { s: ["a.test", "b.test"] }], note: "x" }),
      /is there twice, or already one of the bundle's/,
    ],
    [
      "one of Apple's",
      (d) => aliasesFile(d, { groups: [{ f: ["twitter.com"], t: ["x.com"] }], note: "x" }),
      /\{"f":\["twitter\.com"\],"t":\["x\.com"\]\} is there twice, or already one of the bundle's/,
    ],
    [
      "a group the format refuses (one member)",
      (d) => aliasesFile(d, { groups: [{ s: ["a.test"] }], note: "x" }),
      /the e2e build's bundle: bundle\.aliases\[\d+\]/,
    ],
    [
      "a group with an IP address",
      (d) => aliasesFile(d, { groups: [{ f: ["192.0.2.1"], t: ["a.test"] }], note: "x" }),
      /the e2e build's bundle: bundle\.aliases\[\d+\]/,
    ],
  ];
  it("refuses a test rule the format refuses, one not named after its id, a missing fixture, a host twice", async () => {
    const write = (d: string, f: string, fn: (r: J) => void) => {
      const p = join(d, "sites", f);
      const r = JSON.parse(readFileSync(p, "utf8"));
      fn(r);
      writeFileSync(p, JSON.stringify(r));
    };
    const cases: [string, (d: string) => void, RegExp][] = [
      [
        "a field the format refuses",
        (d) => write(d, "e2e-one.json", (r) => (r.pages[0].field = "a, b")),
        /e2e-one\.json: .*field/,
      ],
      [
        "a file not named after its id",
        (d) => {
          cpSync(join(d, "sites/e2e-one.json"), join(d, "sites/e2e-x.json"));
          rmSync(join(d, "sites/e2e-one.json"));
        },
        /e2e-x\.json: not named after its id/,
      ],
      [
        "no test rules at all (a copy of the extension without test/)",
        (d) => rmSync(join(d, "sites"), { recursive: true }),
        /the e2e build's test rules are missing \(.*sites\)/,
      ],
      [
        "a missing fixture",
        (d) => rmSync(join(d, "fixtures/e2e-one/one.html")),
        /fixture fixtures\/e2e-one\/one\.html is missing/,
      ],
      [
        "a host of another rule",
        (d) => write(d, "e2e-one.json", (r) => (r.hosts = ["rules2.fix.test"])),
        /rules2\.fix\.test is already a host of the rule e2e-group/,
      ],
      ["an unknown field", (d) => write(d, "e2e-group.json", (r) => (r.extra = 1)), /e2e-group\.json: /],
      // the test appends (AF3-5): appends.json, as {hosts, note}, each host one the e2e build's reader accepts, new
      ...appendsCases(),
    ];
    for (const [what, edit, msg] of cases)
      await expect(e2eBaselineText(COMMITTED, overlay(edit)), what).rejects.toThrow(msg);
  });
});

describe("readRules (platform/package-data.ts): the package file, once per context", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  /** A fresh module (a new context) with chrome.runtime and fetch stubbed; the calls and requests recorded. */
  async function context(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    const paths: string[] = [];
    vi.stubGlobal("chrome", {
      runtime: { getURL: (p: string) => (paths.push(p), `chrome-extension://abc/${p}`) },
    }); // nothing else of chrome: a use of chrome.storage would throw
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        inits.push(init);
        return respond(url, init);
      }),
    );
    vi.resetModules();
    const m = await import("../../src/platform/package-data");
    return { m, urls, inits, paths };
  }
  /** A response streaming `chunks`, how many it was asked for, and whether the reader cancelled it. */
  const streamed = (chunks: Uint8Array[]) => {
    const state = { cancelled: false, pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift();
        if (next) state.pulled++;
        if (next) c.enqueue(next);
        else c.close();
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { res: new Response(body), state };
  };
  /** An answer that never comes unless the request's signal aborts it (as a fetch whose answer was lost). */
  const lost = (_: string, init?: RequestInit) =>
    new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(init!.signal!.reason)));

  it("reads rules/baseline.json from the package, checked, once: every later call has the same answer", async () => {
    const { m, urls, inits, paths } = await context(() => new Response(COMMITTED));
    const a = await m.readRules();
    expect(a).toMatchObject({ kind: "baseline", aliases: expect.any(Array) });
    expect(await m.readRules()).toBe(a);
    expect(urls).toEqual(["chrome-extension://abc/rules/baseline.json"]);
    expect(paths).toEqual(["rules/baseline.json"]);
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal); // the time bound (READ_MS)
    expect(m.READ_MS).toBe(5000);
  });
  it("calls that come together in a fresh context share one read: one request, the same answer", async () => {
    // every request made is answered (a second read would get its own answer and its own object, not hang)
    const answers: ((r: Response) => void)[] = [];
    const { m, urls } = await context(() => new Promise<Response>((r) => answers.push(r)));
    const both = Promise.all([m.readRules(), m.readRules()]);
    const third = m.readRules();
    await new Promise((r) => setTimeout(r, 0));
    for (const a of answers) a(new Response(COMMITTED));
    const [x, y] = await both;
    expect(urls).toHaveLength(1);
    expect(x).not.toBeNull();
    expect(y).toBe(x);
    expect(await third).toBe(x);
    // and a file the format refuses: one request for both, and the same null after
    vi.unstubAllGlobals();
    const refusals: ((r: Response) => void)[] = [];
    const bad = await context(() => new Promise<Response>((r) => refusals.push(r)));
    const pair = Promise.all([bad.m.readRules(), bad.m.readRules()]);
    await new Promise((r) => setTimeout(r, 0));
    for (const a of refusals) a(new Response("{"));
    expect(await pair).toEqual([null, null]);
    expect(bad.urls).toHaveLength(1);
    const after = bad.m.readRules();
    for (const a of refusals.slice(1)) a(new Response("{")); // a further request, were one made, gets its answer
    expect(await after).toBeNull();
    expect(bad.urls).toHaveLength(1);
  });
  it("is null, and stays null in that context, for what the file says: an error status, a wrong body, a bundle the format refuses", async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ["404", () => new Response("", { status: 404 })],
      ["not JSON", () => new Response("{")],
      ["not UTF-8", () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]))],
      ["a live bundle", () => new Response(changed((b) => (b.kind = "live")))],
      ["an unknown field", () => new Response(changed((b) => (b.x = 1)))],
    ];
    for (const [what, respond] of cases) {
      const { m, urls } = await context(respond);
      expect(await m.readRules(), what).toBeNull();
      expect(await m.readRules(), what).toBeNull();
      expect(urls, what).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
  it("is null for a read that was lost (the request failed, or took too long), and the next call reads again", async () => {
    let fail = true;
    const { m, urls } = await context(() =>
      fail ? Promise.reject(new TypeError("Failed to fetch")) : new Response(COMMITTED),
    );
    expect(await m.readRules()).toBeNull();
    fail = false;
    const b = await m.readRules();
    expect(b).not.toBeNull();
    expect(await m.readRules()).toBe(b);
    expect(urls).toHaveLength(2);
  });
  it("stops reading past its byte limit, counting as the bytes arrive, and cancels the rest", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    const { res, state } = streamed(Array.from({ length: 64 }, () => chunk)); // 16 MiB on offer
    const { m, urls } = await context(() => res);
    expect(await m.readRules()).toBeNull();
    expect(state.cancelled).toBe(true);
    // it stopped at the first chunk past 1 MiB (the fifth of 256 KiB), with at most one more queued ahead of the read
    expect(state.pulled).toBeGreaterThanOrEqual(5);
    expect(state.pulled).toBeLessThanOrEqual(6);
    expect(await m.readRules()).toBeNull(); // what the file says: kept
    expect(urls).toHaveLength(1);
    // the limit itself is read: a bundle padded to exactly 1 MiB is accepted
    const padded = COMMITTED.replace(/\n$/, "") + " ".repeat(BASELINE_MAX_BYTES - COMMITTED.length) + "\n";
    expect(padded.length).toBe(BASELINE_MAX_BYTES);
    vi.unstubAllGlobals();
    const at = await context(() => new Response(padded));
    expect(await at.m.readRules()).not.toBeNull();
  });
  it("ends a read whose answer does not come (a lost answer is no answer), and reads again at the next call", async () => {
    const ctl = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctl.signal);
    try {
      let answered = false;
      const { m, urls } = await context((url, init) => (answered ? new Response(COMMITTED) : lost(url, init)));
      const answer = m.readRules();
      expect(timeout).toHaveBeenCalledWith(m.READ_MS);
      ctl.abort(new DOMException("timed out", "TimeoutError")); // what AbortSignal.timeout does after READ_MS
      expect(await answer).toBeNull(); // (without the signal, the answer never comes and this test times out)
      answered = true;
      expect(await m.readRules()).not.toBeNull();
      expect(urls).toHaveLength(2);
    } finally {
      timeout.mockRestore();
    }
  });
  it("ends a read whose body stops half way (Node's own fetch, from a local server that sends half the file)", async () => {
    const half = COMMITTED.slice(0, COMMITTED.length >> 1);
    let sent!: () => void;
    const wrote = new Promise<void>((r) => (sent = r));
    const server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(half, () => sent());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const ctl = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctl.signal);
    try {
      vi.stubGlobal("chrome", { runtime: { getURL: (p: string) => `http://127.0.0.1:${port}/${p}` } });
      vi.resetModules();
      const m = await import("../../src/platform/package-data");
      const answer = m.readRules();
      await wrote; // the head and half the body are out, and the server says no more
      await new Promise((r) => setTimeout(r, 100));
      ctl.abort(new DOMException("timed out", "TimeoutError")); // READ_MS later
      expect(await answer).toBeNull();
    } finally {
      timeout.mockRestore();
      server.closeAllConnections();
      server.close();
    }
  });
  it("its source: the one path, no storage of any kind, and two callers, the Fill paths' rule lookup (AF3-3b) and the same sign-in chunk (AF3-4)", () => {
    const src = read(resolve(EXT, "src/platform/package-data.ts"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bstorage\b|indexedDB|localStorage|sessionStorage|caches/);
    expect(src.match(/chrome\.runtime\.getURL\(/g)).toHaveLength(1);
    expect(src).toMatch(/chrome\.runtime\.getURL\(BASELINE_FILE\)/);
    expect(src).toMatch(/export function readRules\(\): Promise<Bundle \| null>/);
    const importers = (re: RegExp) => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = resolve(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(ts|tsx)$/.test(e.name) && re.test(read(p))) out.push(p.slice(EXT.length + 1));
        }
      };
      walk(resolve(EXT, "src"));
      return out.sort();
    };
    expect(importers(/from ["'][./]*(?:platform\/)?package-data["']/)).toEqual([
      "src/platform/site-rule.ts",
      "src/popup/main/aliases.ts",
    ]);
    expect(importers(/from ["'][./]*(?:core\/)?(?:rules\/)?baseline["']/)).toEqual(["src/platform/package-data.ts"]);
  });
});

describe("what a build carries (scripts/rules-package.mjs)", () => {
  it("the committed bundle, as bundle.mjs writes it and the extension's reader takes it", async () => {
    const c = await checkedBaseline();
    expect(c.text).toBe(COMMITTED);
    expect(BASELINE_SOURCE).toBe(resolve(REPO, "rules/build/baseline.json"));
    expect(c.maxBytes).toBe(BASELINE_MAX_BYTES);
  });
  it("refuses one the reader refuses, a hand edit, and a key written twice (not in bundle.mjs's form)", async () => {
    await expect(checkedBaseline(changed((b) => (b.kind = "live")))).rejects.toThrow(
      /not a baseline bundle the extension accepts/,
    );
    await expect(checkedBaseline(JSON.stringify(JSON.parse(COMMITTED)))).rejects.toThrow(
      /not in the form rules\/tools\/bundle\.mjs writes/,
    );
    await expect(checkedBaseline(COMMITTED.replace(/\n$/, ""))).rejects.toThrow(/not in the form/);
    const twice = COMMITTED.replace('"kind": "baseline",', '"kind": "baseline",\n  "kind": "baseline",');
    expect(parseBaseline(twice).ok).toBe(true); // JSON.parse keeps the last one: the reader cannot see it
    await expect(checkedBaseline(twice)).rejects.toThrow(/not in the form/);
  });
  it("rules/LICENSE.txt: rules/NOTICE (Apple's notice in it), then the AGPL-3.0 text; LICENSE.txt: the line, then the MPL", () => {
    const rules = rulesLicenceText();
    const notice = read(resolve(REPO, "rules/NOTICE"));
    expect(rules.startsWith(notice)).toBe(true);
    expect(rules.endsWith(read(resolve(REPO, "LICENSES/AGPL-3.0-or-later.txt")))).toBe(true);
    expect(rules).toContain("Copyright 2020 - 2026 Apple Inc.");
    expect(rules).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(PACKAGED_LICENCE).toBe("rules/LICENSE.txt");
    expect(extensionLicenceText()).toBe(`${LICENCE_LINE}\n\n${read(resolve(REPO, "LICENSES/MPL-2.0.txt"))}`);
    // the third-party parts keep their own licences (OFL-1.1 fonts, CC BY word lists, MIT code): "everything else" is
    // what is left (the AF3-3a review's MUST-2)
    expect(LICENCE_LINE).toBe(
      "The files under rules/ are under AGPL-3.0-or-later and MIT: see rules/LICENSE.txt. The third-party software and " +
        "data listed in THIRD-PARTY-NOTICES.txt keep their own licences. Everything else: the Mozilla Public License " +
        "2.0, below.",
    );
  });
  it("the data probes: each list of two hosts or more, read as every bundler writes it", () => {
    const probes = dataProbes(COMMITTED);
    const b = JSON.parse(COMMITTED);
    const lists = [...b.aliases.flatMap((g: J) => [g.s, g.f, g.t]), b.appends].filter((l) => l?.length > 1);
    expect(probes).toEqual([...new Set(lists.map((l) => JSON.stringify(l)))]);
    expect(probes).toContain('["chat.com","chatgpt.com","openai.com"]');
    expect(probes).toContain(JSON.stringify(b.appends));
    expect(probes.length).toBeGreaterThan(60);
    // no keys and no selectors: other code may have an `aliases` key or a rule's selector
    expect(probes.some((p) => p.includes("aliases") || p.includes("{"))).toBe(false);
    // the shapes Vite 8 writes an imported bundle in (the review's probe builds): the pages' minifier, the worker's
    // library build, a string of JSON, a single-quoted one; each reads as the probe, and so does today's code: never
    const group = ["chat.com", "chatgpt.com", "openai.com"];
    const shapes = [
      `window.__r={s:[${group.map((h) => `\`${h}\``).join(",")}]};`,
      `var __r = { s: [\n\t\t\t"${group.join('",\n\t\t\t"')}"\n\t\t] };`,
      `JSON.parse("{\\"s\\":[${group.map((h) => `\\"${h}\\"`).join(",")}]}")`,
      `JSON.parse('{"s":[${group.map((h) => `"${h}"`).join(", ")}]}')`,
    ];
    for (const s of shapes) expect(normalised(s), s).toContain('["chat.com","chatgpt.com","openai.com"]');
    const src: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) walk(resolve(d, e.name));
        else if (/\.(ts|tsx)$/.test(e.name)) src.push(normalised(read(resolve(d, e.name))));
    };
    walk(resolve(EXT, "src"));
    expect(src.length).toBeGreaterThan(100);
    expect(probes.filter((p) => src.some((t) => t.includes(p)))).toEqual([]);
  });
  it("the store package's source gate: no source while REPO_URL is empty; the bundle's source must be the one it gives", () => {
    // the committed bundle names the public repository's rules folder at its version's tag: the gate lets it through
    expect(JSON.parse(COMMITTED).source).toBe("https://github.com/gpro-teams/sixkey/tree/rules-v1/rules");
    expect(sourceGate()).toBeNull();
    expect(sourceGate(COMMITTED, "")).toMatch(
      /the site rules' bundle names no source: REPO_URL in scripts\/repo-url\.mjs is empty/,
    );
    expect(sourceGate(COMMITTED, "")).toMatch(/until the repository is public, and a store package/);
    expect(sourceGate(COMMITTED, "")).not.toMatch(/Q3|owner/);
    const T = "https://example.org/o/sixkey/tree/rules-v{version}/rules";
    expect(sourceGate(COMMITTED, T)).toMatch(
      /source is "https:\/\/github\.com\/gpro-teams\/sixkey\/tree\/rules-v1\/rules", not https:\/\/example\.org\/o\/sixkey\/tree\/rules-v1\/rules: rebuild it/,
    );
    // a bundle built before the address was set
    expect(
      sourceGate(
        changed((b) => (b.source = "")),
        T,
      ),
    ).toMatch(/source is "", not https:\/\/example\.org\/o\/sixkey\/tree\/rules-v1\/rules: rebuild it/);
    expect(
      sourceGate(
        changed((b) => (b.source = "https://example.org/o/sixkey/tree/rules-v1/rules")),
        T,
      ),
    ).toBeNull();
    expect(
      sourceGate(
        changed((b) => (b.source = "https://example.org/o/sixkey/tree/rules-v2/rules")),
        T,
      ),
    ).toMatch(/not https/);
    expect(sourceGate("{", T)).toMatch(/not JSON/);
    // an address the source cannot be made of is a reason too, not an exception (the review's NIT-4)
    for (const bad of ["git@example.org:o/sixkey.git/tree/rules-v{version}/rules", "https://example.org/o/sixkey"])
      expect(sourceGate(COMMITTED, bad), bad).toMatch(/RULES_SOURCE must be an https address with \{version\} in it/);
    // the package script asks it with the other gates, before it builds anything (its runs: m5-build-guard.test.ts)
    const pack = read(resolve(EXT, "scripts/package.mjs"));
    expect(pack).toMatch(/\[storeIdGate\(STORE_ID\), sourceGate\(\)\]/);
    expect(pack.indexOf("sourceGate()")).toBeLessThan(pack.indexOf("step(`the ${idDraft"));
  });
});
