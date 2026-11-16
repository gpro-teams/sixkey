// TOTP-AUTOFILL §4.2 items 2 and 3: storage.local and storage.session are set to TRUSTED_CONTEXTS (extension pages and the
// service worker only) as the very first thing the service worker does, so a content script cannot read the vault slots,
// the keyring or the PIN record. Checked: the exact call, that both areas get it and neither waits for the other, that it
// is made before any listener or storage access of the worker, that a failure does not stop the worker and is written
// down, and (reading the source) that the other level is never passed and nothing else calls setAccessLevel. And
// storage.sync, the backup in Chrome's sync storage's area (CSB-2's restrictSyncAccess, called at the start since CSB-3:
// the maintainers' C7): the same call, right after the other two, its failure one line of its own, autofill's gate
// unaffected.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATE_MS, restrictStorageAccess, restrictSyncAccess } from "../../src/platform/storage-access";
import { loadWorker, unload, wait } from "../helpers/sw-world";

const LEVEL = { accessLevel: "TRUSTED_CONTEXTS" };

describe("restrictStorageAccess", () => {
  const area = (how: "ok" | "reject" | "throw" | "hang") => {
    const calls: unknown[] = [];
    return {
      calls,
      setAccessLevel(o: never) {
        calls.push(o);
        if (how === "throw") throw new Error("x");
        if (how === "reject") return Promise.reject(new Error("x"));
        return how === "hang" ? new Promise<void>(() => undefined) : Promise.resolve();
      },
    };
  };

  it("calls local and session with exactly TRUSTED_CONTEXTS, once each, and reports both as done", async () => {
    const local = area("ok");
    const session = area("ok");
    expect(await restrictStorageAccess({ local, session })).toEqual({ local: true, session: true });
    expect(local.calls).toEqual([LEVEL]);
    expect(session.calls).toEqual([LEVEL]);
  });

  it("makes both calls before returning to the caller: neither waits for the other, so a hung or failed one costs the other nothing", () => {
    const local = area("hang");
    const session = area("ok");
    void restrictStorageAccess({ local, session }); // not awaited: the calls are made synchronously
    expect(local.calls).toEqual([LEVEL]);
    expect(session.calls).toEqual([LEVEL]);
    const l2 = area("throw");
    const s2 = area("ok");
    void restrictStorageAccess({ local: l2, session: s2 });
    expect([l2.calls.length, s2.calls.length]).toEqual([1, 1]);
  });

  it("a failure in one area is reported for that area only; a throw, a rejection, a missing function and a missing area all count as failed", async () => {
    expect(await restrictStorageAccess({ local: area("reject"), session: area("ok") })).toEqual({
      local: false,
      session: true,
    });
    expect(await restrictStorageAccess({ local: area("ok"), session: area("throw") })).toEqual({
      local: true,
      session: false,
    });
    expect(await restrictStorageAccess({ local: {} as never, session: area("ok") })).toEqual({
      local: false,
      session: true,
    });
    expect(await restrictStorageAccess({ session: area("ok") })).toEqual({ local: false, session: true });
    expect(await restrictStorageAccess(undefined)).toEqual({ local: false, session: false });
  });
});

describe("restrictSyncAccess (the backup in Chrome's sync storage; the maintainers' C7)", () => {
  const area = (how: "ok" | "reject" | "throw" | "hang" | "late") => {
    const calls: unknown[] = [];
    return {
      calls,
      setAccessLevel(o: never) {
        calls.push(o);
        if (how === "throw") throw new Error("x");
        if (how === "hang") return new Promise<void>(() => undefined);
        if (how === "late") return new Promise<void>((r) => setTimeout(r, 80));
        return how === "reject" ? Promise.reject(new Error("x")) : Promise.resolve();
      },
    };
  };

  it("calls storage.sync once with exactly TRUSTED_CONTEXTS, and nothing else; true when the browser accepts", async () => {
    const local = area("ok");
    const session = area("ok");
    const sync = area("ok");
    expect(await restrictSyncAccess({ local, session, sync })).toBe(true);
    expect(sync.calls).toEqual([LEVEL]);
    expect([local.calls, session.calls]).toEqual([[], []]);
  });

  it("a rejection, a throw, a missing function, a missing area or no storage at all: false, never a throw", async () => {
    expect(await restrictSyncAccess({ sync: area("reject") })).toBe(false);
    expect(await restrictSyncAccess({ sync: area("throw") })).toBe(false);
    expect(await restrictSyncAccess({ sync: {} as never })).toBe(false);
    expect(await restrictSyncAccess({ local: area("ok"), session: area("ok") })).toBe(false);
    expect(await restrictSyncAccess(undefined)).toBe(false);
    const getterThrows = Object.defineProperty({}, "sync", {
      get: () => {
        throw new Error("a strange host");
      },
    });
    expect(await restrictSyncAccess(getterThrows as never)).toBe(false);
  });

  it("no answer within its time (GATE_MS, as closedBy waits): false, and no later true", async () => {
    expect(GATE_MS).toBe(5000);
    const hung = area("hang");
    const t0 = Date.now();
    expect(await restrictSyncAccess({ sync: hung }, 30)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(hung.calls).toEqual([LEVEL]);
    // an answer after the limit is still a no: the call has ended
    expect(await restrictSyncAccess({ sync: area("late") }, 20)).toBe(false);
    // and one within it a yes
    expect(await restrictSyncAccess({ sync: area("late") }, 2000)).toBe(true);
  });

  it("the other two, and so autofill's gate, never touch storage.sync: a browser that refuses it loses no autofill", async () => {
    const sync = area("reject");
    expect(await restrictStorageAccess({ local: area("ok"), session: area("ok"), sync })).toEqual({
      local: true,
      session: true,
    });
    expect(sync.calls).toEqual([]);
  });
});

describe("the service worker's start", () => {
  afterEach(unload);

  // This shows what the SOURCE does under vitest, where modules run asynchronously and a deferred call can still come
  // first. The order of the BUILT bundle is checked by scripts/check-dist.mjs (scripts/sw-order.mjs), and the source
  // shape by the rules below.
  it("the module calls first: before any listener is added, any storage read or write, any other work", async () => {
    const w = await loadWorker();
    const first = w.log.slice(0, 3);
    expect(first.slice(0, 2).sort()).toEqual(["local.setAccessLevel", "session.setAccessLevel"]);
    expect(first[2]).toBe("sync.setAccessLevel"); // the backup in Chrome sync's area, apart and right after (C7)
    expect(w.log.length).toBeGreaterThan(3); // and the worker did start
    expect(w.log.filter((e) => e.endsWith("setAccessLevel"))).toHaveLength(3); // once each per start
    expect(w.levels.local).toEqual([LEVEL]);
    expect(w.levels.session).toEqual([LEVEL]);
    expect(w.levels.sync).toEqual([LEVEL]);
    expect(w.log.findIndex((e) => e.startsWith("addListener"))).toBeGreaterThanOrEqual(3);
  });

  it("each worker start repeats it (the setting's persistence is unverified, probe P1): a second start calls all three again", async () => {
    const a = await loadWorker();
    const b = await loadWorker();
    expect([a.levels, b.levels].flatMap((l) => [l.local.length, l.session.length, l.sync.length])).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
  });

  for (const how of ["reject", "throw", "absent"] as const)
    it(`storage.sync ${how}: the worker still starts with every listener, one line of its own, autofill's areas set and unreported`, async () => {
      const w = await loadWorker({ sync: how });
      expect(w.listeners.message).toHaveLength(4);
      expect(w.listeners.alarm).toHaveLength(1);
      await vi.waitFor(() => expect(lines(w)).toEqual(["storage access level not restricted: sync"]));
      expect([w.levels.local, w.levels.session]).toEqual([[LEVEL], [LEVEL]]);
    });

  it("storage.sync and storage.local both refused: two lines, each its own", async () => {
    const w = await loadWorker({ local: "reject", sync: "reject" });
    await vi.waitFor(() =>
      expect(lines(w).sort()).toEqual([
        "storage access level not restricted: local",
        "storage access level not restricted: sync",
      ]),
    );
  });

  it("storage.sync that never answers: no listener waits for it; after GATE_MS it is a refusal, written down", async () => {
    const w = await loadWorker({ sync: "hang" });
    expect(w.listeners.message).toHaveLength(4);
    expect(w.badges).toEqual([""]); // sync's start ran
    expect(lines(w)).toEqual([]);
    await vi.waitFor(() => expect(lines(w)).toEqual(["storage access level not restricted: sync"]), {
      timeout: GATE_MS + 5_000,
      interval: 100,
    });
  }, 15_000);

  it("with both calls accepted nothing is written to the diagnostics log", async () => {
    const w = await loadWorker();
    expect(w.local.data.get("sk_diag")).toBeUndefined();
  });

  const lines = (w: { local: { data: Map<string, unknown> } }) =>
    ((w.local.data.get("sk_diag") ?? []) as { message: string }[]).map((d) => d.message);

  for (const how of ["reject", "throw", "absent"] as const)
    it(`${how}: the worker still starts and registers every listener, and the failure is written to the diagnostics log`, async () => {
      const w = await loadWorker({ local: how });
      expect(w.listeners.message).toHaveLength(4); // the pages', the bridge's, the cloud backup's (CLOUDBK patch 4), the content script's
      expect(w.listeners.alarm).toHaveLength(1);
      await wait();
      expect(lines(w)).toEqual(["storage access level not restricted: local"]);
      expect(w.levels.session).toEqual([LEVEL]); // session was not skipped because local failed
    });

  it("session failing is reported as session, and local is still set", async () => {
    const w = await loadWorker({ session: "reject" });
    await wait();
    expect(lines(w)).toEqual(["storage access level not restricted: session"]);
    expect(w.levels.local).toEqual([LEVEL]);
  });

  for (const how of ["reject", "throw", "absent"] as const)
    it(`${how} for both areas: ONE line names both (two writes in one tick would lose one, diag.ts has no lock)`, async () => {
      const w = await loadWorker({ local: how, session: how });
      await wait();
      expect(lines(w)).toEqual(["storage access level not restricted: local, session"]);
    });

  it("a refusal that repeats at every worker start takes one line, and the other lines stay in the 50", async () => {
    const other = Array.from({ length: 48 }, (_, i) => ({ at: i, message: `other ${i}` }));
    const w1 = await loadWorker({ local: "reject", session: "reject", seedLocal: { sk_diag: other } });
    await wait();
    expect(lines(w1)).toHaveLength(49);
    let kept = w1.local.data.get("sk_diag");
    for (let i = 0; i < 5; i++) {
      unload();
      const w = await loadWorker({ local: "reject", session: "reject", seedLocal: { sk_diag: kept } });
      await wait();
      kept = w.local.data.get("sk_diag");
    }
    expect((kept as { message: string }[]).map((d) => d.message)).toEqual([
      ...other.map((o) => o.message),
      "storage access level not restricted: local, session",
    ]);
  });

  it("a different refusal later is a new line; nothing is written when both calls are accepted", async () => {
    const w1 = await loadWorker({ local: "reject" });
    await wait();
    unload();
    const w2 = await loadWorker({ session: "reject", seedLocal: { sk_diag: w1.local.data.get("sk_diag") } });
    await wait();
    expect(lines(w2)).toEqual([
      "storage access level not restricted: local",
      "storage access level not restricted: session",
    ]);
    unload();
    const w3 = await loadWorker({ seedLocal: { sk_diag: w2.local.data.get("sk_diag") } });
    await wait();
    expect(lines(w3)).toHaveLength(2);
  });

  it("a call that never settles does not hold the worker back: its listeners and its work run", async () => {
    const w = await loadWorker({ local: "hang", session: "hang", sync: "hang" });
    expect(w.listeners.message).toHaveLength(4); // the pages', the bridge's, the backup in Chrome sync's (CSB-3), the content script's
    expect(w.badges).toEqual([""]); // sync's start ran
  });
});

// Source rules.
const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(EXT, "src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
const code = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const files = walk(SRC).map((p) => ({
  path: relative(SRC, p).split("\\").join("/"),
  code: code(readFileSync(p, "utf8")),
}));
const file = (path: string) => files.find((f) => f.path === path)!;

describe("source rules for the access level", () => {
  it("only platform/storage-access.ts calls setAccessLevel", () => {
    expect(files.filter((f) => /\bsetAccessLevel\b/.test(f.code)).map((f) => f.path)).toEqual([
      "platform/storage-access.ts",
    ]);
    expect(file("platform/storage-access.ts").code.match(/\.setAccessLevel\(/g)).toHaveLength(1);
  });

  it("the only level in the source is TRUSTED_CONTEXTS; the other (TRUSTED_AND_UNTRUSTED_CONTEXTS) is nowhere in code", () => {
    const levels = files.flatMap((f) =>
      [...f.code.matchAll(/accessLevel\s*:\s*([^,}\s]+)/g)].map((m) => `${f.path} ${m[1]}`),
    );
    // the parameter's type and the call: both the same single level
    expect(levels).toEqual([
      'platform/storage-access.ts "TRUSTED_CONTEXTS"',
      'platform/storage-access.ts "TRUSTED_CONTEXTS"',
    ]);
    expect(files.filter((f) => /TRUSTED_AND_UNTRUSTED/i.test(f.code)).map((f) => f.path)).toEqual([]);
    expect(files.filter((f) => /\bAccessLevel\b/.test(f.code)).map((f) => f.path)).toEqual([]); // no enum member in its place
  });

  it("both areas go through the same function, and nothing else mentions another area's level", () => {
    const c = file("platform/storage-access.ts").code;
    expect(c).toMatch(/restrict\(storage\?\.local\)/);
    expect(c).toMatch(/restrict\(storage\?\.session\)/);
    expect(c).toMatch(/Promise\.all\(\[restrict\(/); // neither is awaited before the other is started
    // and storage.sync (the backup in Chrome's sync storage) through it too, apart from them: not in autofill's gate
    expect(c).toMatch(
      /^export async function restrictSyncAccess\([^)]*\): Promise<boolean> \{[\s\S]*?return await Promise\.race\(\[restrict\(storage\?\.sync\), late\]\);/m,
    );
    expect(c.match(/restrict\(storage\?\.\w+\)/g)).toEqual([
      "restrict(storage?.local)",
      "restrict(storage?.session)",
      "restrict(storage?.sync)",
    ]);
  });

  it("sw.ts imports the module that makes the calls FIRST, and that module is imported by nothing else and calls at load", () => {
    const sw = file("background/sw.ts").code;
    const imports = [...sw.matchAll(/^import .*? from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports[0]).toBe("./storage-access-first");
    expect(files.filter((f) => /storage-access-first/.test(f.code)).map((f) => f.path)).toEqual(["background/sw.ts"]);
    expect(file("background/storage-access-first.ts").code).toMatch(
      /^export const storageAccess = restrictStorageAccess\(\);\nexport const syncAccess = restrictSyncAccess\(\);$/m,
    );
    // sw.ts reports a failure; nothing in it awaits the promise before registering a listener
    expect(sw).toMatch(/void storageAccess\.then\(/);
    expect(sw).not.toMatch(/await storageAccess/);
    // storage.sync's answer: its own line, and the backup's gate for this worker's life (csb-worker.ts), awaited by
    // nothing at the top level
    expect(sw).toMatch(
      /void syncAccess\.then\(\(ok\) => \{\s*if \(!ok\) note\("storage access level not restricted: sync"\);\s*\}\);/,
    );
    expect(sw).toMatch(/^ {2}access: \(\) => syncAccess,$/m);
    expect(sw.match(/\bsyncAccess\b/g)).toHaveLength(3); // the import, its line, the backup's gate
    expect(sw).not.toMatch(/await syncAccess/);
  });

  it("the worker's top-level code does not depend on the order of the calls: every listener is registered at the top level", () => {
    const sw = file("background/sw.ts").code;
    for (const m of sw.matchAll(/^[ \t]+(chrome\.\w+\.\w+\.addListener)\(/gm))
      expect(m[1], "indented addListener").toBeUndefined();
  });

  it("nothing reads storage.local through a content-script-reachable path: no content_scripts, the one registered script behind the gate, and injection only in the one platform module (TOTP autofill, Stages 1 and 2)", () => {
    const m = JSON.parse(readFileSync(join(EXT, "manifest.base.json"), "utf8"));
    expect(m.content_scripts).toBeUndefined();
    // `scripting` came with Stage 1 (docs/design/notes/AUTOFILL1-NOTES.md) and is optional since wave 1b of the plugin
    // platform (PLUGINS-W1B-NOTES.md): the Fill button and shortcut inject src/inject/otp.js on the user's action, from
    // platform/autofill.ts alone (test/unit/autofill1-source-rules.test.ts holds that module to its three calls). Stage 2
    // (AUTOFILL2-NOTES.md §9) registers one script for the sites the user turned on, from platform/autofill-register.ts
    // alone, which asks the storage gate before it registers anything.
    expect(m.permissions).not.toContain("scripting");
    expect(m.optional_permissions).toContain("scripting");
    expect(
      files.filter((f) => /registerContentScripts|\.insertCSS\b|declarativeContent/.test(f.code)).map((f) => f.path),
    ).toEqual(["platform/autofill-register.ts"]);
    expect(files.filter((f) => /chrome\??\.scripting|\.executeScript\b/.test(f.code)).map((f) => f.path)).toEqual([
      "platform/autofill-register.ts",
      "platform/autofill.ts",
    ]);
    expect(files.find((f) => f.path === "platform/autofill-register.ts")!.code).toMatch(/\(await gate\(\)\)/);
  });
});
