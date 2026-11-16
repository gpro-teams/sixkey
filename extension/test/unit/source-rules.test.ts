// Rules about where things may be called from (PHASE0X-PLAN A4; SYNC-DESIGN §0.0i M2 req. 3 and 5; docs/audit/internal-reviews/GM2-REVIEW.md
// GM2-1, GM2-11, GM2-13). They hold by construction in the code, and nothing at run time would notice a new call site
// that breaks them, so the source is read here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";

const ROOT = join(__dirname, "../../src");
function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = sources().map((p) => ({ path: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
/** Every match of `re` in src/, as "file: line". Comments are not code: lines starting with // or * are skipped. */
function sites(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((line, i) => {
      const code = line.trimStart();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (re.test(line)) out.push(`${f.path}:${i + 1}`);
    });
  }
  return out;
}

/** The files that may name chrome.storage.sync (the backup in Chrome's sync storage, CSB-2). */
const CSB_FILES = ["platform/csb-area.ts", "platform/csb-read.ts", "platform/storage-access.ts"];
/**
 * The CSB rule over a tree of sources: what breaks it, one line each (empty: none). It reads the code (comments taken
 * out) for the area written as `storage.sync`, `storage?.sync` or `storage["sync"]`, and for `chrome.storage`; a text rule
 * cannot see a name built at run time (`chrome["sto" + "rage"]`), which no ordinary code writes.
 *   - The area is named in the three files only; used as a value (not through one of its members) once in each: the
 *     two modules' own handles (csb-area.ts chromeSync, csb-read.ts chromeSyncReader) and storage-access.ts's access level.
 *   - chrome.storage itself is a value only in storage-access.ts's two default parameters; nothing destructures it, or
 *     chrome.storage.sync, anywhere.
 *   - Each handle is used in its own file only, not exported, and only as a default area (`X | undefined = handle()`, or
 *     csb-read.ts's `o.area : handle()`).
 *   - The writer has one `.set(` and one `.remove(`, as written below, and no clear or access level; the page's reader
 *     no write and one get(null), and does not name the writer; the worker's backup (platform/csb-worker.ts) alone
 *     imports the writer (CSB-3), with one static import of named functions, and no page imports the worker.
 */
function csbSyncRule(src: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  const strip = (t: string) =>
    t
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
      .join("\n");
  const AREA = /\bstorage\s*(?:\?\.|\.)\s*sync\b|\bstorage\s*(?:\?\.)?\[\s*["'`]sync["'`]\s*\]/g;
  const WHOLE = /\bchrome\s*\??\.\s*storage\b/g;
  const member = (c: string, end: number) => /^\s*(?:\?\.|\.(?!\.)|\[)/.test(c.slice(end, end + 8));
  // what a string says is not code: every string emptied (but "sync" itself, which `storage["sync"]` needs)
  const unquoted = (c: string) =>
    c.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`/g, (q) =>
      q.slice(1, -1) === "sync" ? q : `${q[0]}${q[0]}`,
    );
  const values = (c: string, re: RegExp) => [...c.matchAll(re)].filter((m) => !member(c, m.index! + m[0].length));
  const HANDLES: [string, string][] = [
    ["chromeSync", "platform/csb-area.ts"],
    ["chromeSyncReader", "platform/csb-read.ts"],
  ];
  const code = new Map(src.map((f) => [f.path, strip(f.text)]));
  for (const [path, c] of code) {
    const named = [...c.matchAll(AREA)];
    if (named.length && !CSB_FILES.includes(path)) out.push(`${path}: reaches storage.sync`);
    const asValue = values(unquoted(c), AREA).length;
    if (CSB_FILES.includes(path) && asValue !== 1)
      out.push(`${path}: storage.sync as a value ${asValue} times, not once`);
    const whole = values(unquoted(c), WHOLE).length;
    if (whole !== (path === "platform/storage-access.ts" ? 2 : 0)) out.push(`${path}: chrome.storage as a value`);
    if (
      /\{[^{}]*\}\s*=\s*\(?\s*(?:globalThis\s*\??\.\s*)?chrome\s*\??\.\s*storage(?:\s*\??\.\s*sync)?\b(?!\s*(?:\?\.|\.)\s*\w)/.test(
        c,
      ) ||
      /\{[^{}]*\bsync\b[^{}]*\}\s*=\s*[^;\n]*\bstorage\b/.test(c)
    )
      out.push(`${path}: destructures chrome.storage or its sync area`);
    for (const [name, home] of HANDLES) {
      const uses = [...c.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
      if (path !== home) {
        if (uses.length) out.push(`${path}: ${name}, ${home.split("/").pop()}'s own handle`);
        continue;
      }
      for (const m of uses) {
        const before = c.slice(Math.max(0, m.index! - 40), m.index!);
        const after = c.slice(m.index! + name.length, m.index! + name.length + 4);
        const declared = /(?:^|\n)const $/.test(before) && after.startsWith(" = (");
        const asDefault =
          after.startsWith("()") && (/\|\s*undefined\s*=\s*$/.test(before) || /\?\s*o\.area\s*:\s*$/.test(before));
        if (!declared && !asDefault) out.push(`${path}: ${name} used other than as a default area`);
      }
    }
    if (path !== "platform/csb-worker.ts" && /["'`][^"'`]*\/csb-area(?:\.ts)?["'`]/.test(c))
      out.push(`${path}: imports csb-area`);
    if (
      /^(?:options|popup|sidepanel|ui|devsync|offscreen|inject)\//.test(path) &&
      /["'`][^"'`]*\/csb-worker(?:\.ts)?["'`]/.test(c)
    )
      out.push(`${path}: a page imports the worker's backup`);
  }
  const worker = code.get("platform/csb-worker.ts") ?? "";
  const named = /^import \{[^}*]*\} from "\.\/csb-area";$/m;
  if ((worker.match(/["'`][^"'`]*\/csb-area(?:\.ts)?["'`]/g)?.length ?? 0) !== 1 || !named.test(worker))
    out.push("platform/csb-worker.ts: not one import of csb-area's named functions");
  for (const p of CSB_FILES) if (!code.has(p)) out.push(`${p}: missing`);
  const area = code.get("platform/csb-area.ts") ?? "";
  const sets = area.match(/\.set\(/g)?.length ?? 0;
  const removes = area.match(/\.remove\(/g)?.length ?? 0;
  if (sets !== 1 || !/await area\.set\(items\);/.test(area)) out.push(`platform/csb-area.ts: ${sets} calls of .set(`);
  if (removes !== 1 || !/await area\.remove\(\[\.\.\.keys\]\);/.test(area))
    out.push(`platform/csb-area.ts: ${removes} calls of .remove(`);
  if (/\.clear\(|setAccessLevel/.test(area)) out.push("platform/csb-area.ts: clears the area or sets its level");
  const read = code.get("platform/csb-read.ts") ?? "";
  if (/\.set\(|\.remove\(|\.clear\(|setAccessLevel|csb-area/.test(read))
    out.push("platform/csb-read.ts: writes the area");
  if ((read.match(/\.get\(null\)/g)?.length ?? 0) !== 1) out.push("platform/csb-read.ts: not one get(null)");
  const access = code.get("platform/storage-access.ts") ?? "";
  if (!/restrict\(storage\?\.sync\)/.test(access) || (access.match(AREA)?.length ?? 0) !== 1)
    out.push("platform/storage-access.ts: reaches the area other than for its level");
  return out;
}

/**
 * Where the worker's backup writes storage.sync and removes from it (platform/csb-worker.ts): one place per kind, each
 * in its own function (the worker's inner functions are two spaces deep, so a body ends at the first line that is
 * "  }"). The run (decideAndWrite) makes the one writeSlot of a run and the only
 * removeLeftovers, a shrunk slot's chunks and those a stopped worker left beside its own intact slot; it never removes a
 * slot. removeSlot is called twice: by "turn off" (turnOff, the maintainers' C3) and by a merge's "remove them"
 * (dropSlots, C12), which checks the tags again under the lock; nowhere else. csb-area's functions are imported by name,
 * never renamed, so a call reads as what it is.
 */
/** The worker's code (platform/csb-worker.ts) without its comments, and the body of one of its inner functions. */
function workerCode(src: readonly { path: string; text: string }[]) {
  const text = src.find((f) => f.path === "platform/csb-worker.ts")?.text ?? "";
  const c = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  const body = (name: string): string => {
    const at = c.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
    if (at < 0) return "";
    const end = c.indexOf("\n  }\n", at);
    return end < 0 ? "" : c.slice(at, end);
  };
  return { c, body };
}

function csbWriteRule(src: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  const { c, body } = workerCode(src);
  const imp = /^import \{([^}]*)\} from "\.\/csb-area";$/m.exec(c)?.[1] ?? "";
  if (/\bas\b/.test(imp)) out.push("platform/csb-worker.ts: renames a function of csb-area on import");
  const calls = (s: string, fn: string) => s.match(new RegExp(`\\b${fn}\\(`, "g"))?.length ?? 0;
  const where: [string, Record<string, number>][] = [
    ["writeSlot", { decideAndWrite: 1 }],
    ["removeLeftovers", { decideAndWrite: 2 }],
    ["removeSlot", { turnOff: 1, dropSlots: 1 }],
  ];
  for (const [fn, want] of where) {
    const total = calls(c, fn);
    const sum = Object.values(want).reduce((a, n) => a + n, 0);
    if (total !== sum) out.push(`platform/csb-worker.ts: ${fn} called ${total} times, not ${sum}`);
    for (const [f, n] of Object.entries(want))
      if (calls(body(f), fn) !== n) out.push(`platform/csb-worker.ts: ${fn} not called ${n} times in ${f}`);
  }
  for (const f of ["once", "decideAndWrite", "recordRun"])
    if (body(f) === "") out.push(`platform/csb-worker.ts: no function ${f}`);
    else if (calls(body(f), "removeSlot")) out.push(`platform/csb-worker.ts: the run (${f}) removes a slot`);
  if (!body("decideAndWrite").includes("removeLeftovers(") || calls(body("once"), "decideAndWrite") !== 1)
    out.push("platform/csb-worker.ts: the run is not once() through decideAndWrite");
  return out;
}

/**
 * What a run does outside the records' lock (platform/csb-worker.ts): the store's load, once, in once() before it takes
 * that lock (the load may walk the store's recovery ladder, whose hook takes the same lock), and the card's numbers
 * (statsOf, which hashes every slot), once, in once() after it lets the lock go, so that a recovery's hook waiting for
 * that lock is not held up by them. once() takes the lock for decideAndWrite alone.
 */
function csbRunRule(src: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  const { c, body } = workerCode(src);
  const once = body("once");
  const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
  const loads = count(c, /\bd\.load\(/g);
  if (loads !== 1 || count(once, /\bd\.load\(/g) !== 1)
    out.push(`platform/csb-worker.ts: the store's load called ${loads} times, not once in once()`);
  const lock = once.search(/\.lock\(/);
  if (count(once, /\.lock\(/g) !== 1 || !once.includes(".lock(() => decideAndWrite(loaded.gen))"))
    out.push("platform/csb-worker.ts: once() takes the records' lock other than for decideAndWrite alone");
  if (lock < 0 || once.search(/\bd\.load\(/) > lock)
    out.push("platform/csb-worker.ts: the store's load is not before the records' lock in once()");
  const stats = count(c, /\bstatsOf\(/g) - count(c, /function statsOf\(/g);
  if (stats !== 1 || count(once, /\bstatsOf\(/g) !== 1 || once.search(/\bstatsOf\(/) < lock)
    out.push("platform/csb-worker.ts: the card's numbers not worked out once, in once(), after the records' lock");
  return out;
}

describe("source rules", () => {
  it("finds the sources (so the rules below are not vacuous)", () => {
    expect(files.some((f) => f.path === "core/storage/store.ts")).toBe(true);
    expect(files.some((f) => f.path === "platform/runtime.ts")).toBe(true);
    // the wiring every context shares, and the part of the service the popup builds alone (budget relief)
    expect(files.some((f) => f.path === "platform/runtime-base.ts")).toBe(true);
    expect(files.some((f) => f.path === "core/service/service-core.ts")).toBe(true);
    expect(files.length).toBeGreaterThan(40);
  });

  it("GM2-11: StoreOptions.lock is required (npm run typecheck fails on a store without one)", () => {
    // @ts-expect-error a VaultStore without the cross-context lock must not type-check (never called: it has no lock)
    const withoutLock = () => new VaultStore({ kv: new MemoryKV() });
    expect(typeof withoutLock).toBe("function");
  });

  it("GM2-11: a VaultStore is built only in platform/runtime-base.ts (the wiring every context shares), with the cross-context lock", () => {
    expect(sites(/new VaultStore\s*\(/).map((s) => s.split(":")[0])).toEqual(["platform/runtime-base.ts"]);
    // the constructor call's own arguments (parentheses matched, however they are laid out) carry the lock
    const runtime = files.find((f) => f.path === "platform/runtime-base.ts")!.text;
    const at = runtime.indexOf("new VaultStore(");
    let end = at + "new VaultStore".length;
    for (let depth = 0; end < runtime.length; end++) {
      if (runtime[end] === "(") depth++;
      else if (runtime[end] === ")" && --depth === 0) break;
    }
    expect(runtime.slice(at, end)).toContain('lock: webLock("sixkey-vault")');
    expect(sites(/extends VaultStore\b/)).toEqual([]);
  });

  it("§0.0i req. 5: the store's finishKeyChange is called from one place, the service's cleanup entry point; rewriteForKeyChange only by the purge", () => {
    const calls = sites(/\.finishKeyChange\s*\(/);
    expect(calls).toHaveLength(1);
    // the identifier itself, however it is reached (.call, brackets, destructuring): its definition and that one call
    expect(
      sites(/\bfinishKeyChange\b/)
        .map((x) => x.split(":")[0])
        .sort(),
    ).toEqual(["core/service/service-core.ts", "core/storage/store.ts"]);
    // the entry point is in the part of the service the popup builds too (service-core.ts); the purge and the cleanup
    // after the settings page's own key changes are VaultService's (service.ts)
    const core = files.find((f) => f.path === "core/service/service-core.ts")!.text;
    const service = files.find((f) => f.path === "core/service/service.ts")!.text;
    const entry = core.slice(core.indexOf("protected async finishKeyChanges("));
    expect(core.indexOf("protected async finishKeyChanges(")).toBeGreaterThan(0);
    const body = entry.slice(0, entry.indexOf("\n  }\n"));
    expect(body).toMatch(/this\.store\.finishKeyChange\(/);
    expect(calls[0]!.startsWith("core/service/service-core.ts:")).toBe(true);
    // and both cleanups go through it
    for (const [text, m] of [
      [core, "private async housekeeping("],
      [service, "private async scrub("],
    ] as const) {
      expect(text.indexOf(m), m).toBeGreaterThan(0);
      const at = text.slice(text.indexOf(m));
      expect(at.slice(0, at.indexOf("\n  }\n")), m).toMatch(/this\.finishKeyChanges\(/);
    }
    const purge = sites(/\.rewriteForKeyChange\s*\(/);
    expect(purge).toHaveLength(1);
    const p = service.slice(service.indexOf("async purgeForever("));
    expect(p.slice(0, p.indexOf("\n  }\n"))).toMatch(/this\.store\.rewriteForKeyChange\(/);
  });

  it("GM2-1(b): every page that makes a new recovery code takes it through onCode, so it is shown before the cleanup", () => {
    const pages = files.filter((f) => /^(?:popup|options|ui)\//.test(f.path)); // ui/: what both pages draw
    const calls: string[] = [];
    for (const f of pages) {
      for (const m of f.text.matchAll(/\.(rotateKey|enableMasterPassword|newRecoveryCode)\(([^;]*)/g)) {
        calls.push(`${f.path}: ${m[1]}`);
        expect(m[2], `${f.path}: ${m[1]}`).toMatch(/\{ onCode: setCode \}/); // the page's own setter, nothing in between
      }
    }
    expect(calls.length).toBe(3); // enable, new code, rotate (options/Security.tsx)
  });

  it("A4R-1: the popup does not reset; its button opens the settings tab, where the code is shown before anything is written", () => {
    const popup = files.filter((f) => f.path.startsWith("popup/"));
    expect(
      popup.filter((f) => /\.(prepareReset|commitReset|resetPasswordWithRecovery)\(/.test(f.text)).map((f) => f.path),
    ).toEqual([]);
    expect(popup.find((f) => f.path === "popup/screens/Locked.tsx")!.text).toMatch(/openOptions\("#reset"\)/);
    expect(sites(/resetPasswordWithRecovery/)).toEqual([]); // no one-call reset left anywhere (A4R-5)
    const reset = files.find((f) => f.path === "options/Reset.tsx")!.text;
    expect(reset.match(/\.prepareReset\(/g)).toHaveLength(1);
    expect(reset.match(/\.commitReset\(/g)).toHaveLength(1);
    const body = (name: string) => {
      const at = reset.slice(reset.indexOf(name));
      return at.slice(0, at.indexOf("\n  };\n"));
    };
    expect(body("const prepare = ")).toMatch(/\.prepareReset\(/);
    expect(body("const prepare = ")).not.toMatch(/commitReset/); // Continue on the form only prepares
    expect(body("const commit = ")).toMatch(/\.commitReset\(/);
    expect(reset).toMatch(/<RecoveryCodeBox code=\{pending\.recoveryCode\} onDone=\{\(\) => void commit\(\)\} \/>/); // confirmed saved, then written
    expect(reset).toMatch(/<PasswordFields\s/); // the new password typed twice
  });

  it("CSB: chrome.storage.sync is written only by platform/csb-area.ts (one set, one remove, no clear), which only the worker's backup imports; a page only reads it (platform/csb-read.ts); the area itself is never handed around", () => {
    expect(csbSyncRule(files)).toEqual([]);
    // and the rule is not vacuous: each file it names is there and reaches the area
    for (const p of CSB_FILES)
      expect(
        files.some((f) => f.path === p && /storage\??\.sync/.test(f.text)),
        p,
      ).toBe(true);
  });

  // Ways round a rule that counted only the area's name, and their kin: each one is caught.
  const page = (text: string) => [...files, { path: "options/Rogue.tsx", text }];
  const edited = (path: string, edit: (t: string) => string) =>
    files.map((f) => (f.path === path ? { path, text: edit(f.text) } : f));
  it.each<[string, () => { path: string; text: string }[], RegExp]>([
    [
      "a page keeps chrome.storage in a variable, then clears the area",
      () => page("const st = chrome.storage;\nvoid st.sync.clear();\n"),
      /options\/Rogue\.tsx: chrome\.storage as a value/,
    ],
    [
      "a page takes csb-read.ts's handle, then clears the area",
      () =>
        page(
          'import { chromeSyncReader } from "../platform/csb-read";\nvoid (chromeSyncReader() as unknown as { clear(): Promise<void> }).clear();\n',
        ),
      /options\/Rogue\.tsx: chromeSyncReader, csb-read\.ts's own handle/,
    ],
    [
      "the worker takes csb-area.ts's handle, then removes past removeLeftovers",
      () => [...files, { path: "platform/csb-worker.ts", text: "void chromeSync()!.remove(keys);\n" }],
      /platform\/csb-worker\.ts: chromeSync, csb-area\.ts's own handle/,
    ],
    [
      "storage.sync kept in a variable",
      () => page("const s = globalThis.chrome?.storage?.sync;\n"),
      /options\/Rogue\.tsx: reaches storage\.sync/,
    ],
    [
      "storage.sync handed to a function",
      () => page("watch(chrome.storage.sync);\n"),
      /options\/Rogue\.tsx: reaches storage\.sync/,
    ],
    [
      "chrome.storage handed to a function",
      () => page("restrictAll(chrome.storage);\n"),
      /options\/Rogue\.tsx: chrome\.storage as a value/,
    ],
    [
      "chrome.storage destructured",
      () => page("const { sync } = chrome.storage;\n"),
      /options\/Rogue\.tsx: destructures/,
    ],
    [
      "chrome.storage.sync destructured",
      () => page("const { get, set } = chrome.storage.sync;\n"),
      /options\/Rogue\.tsx: destructures/,
    ],
    [
      "csb-read.ts exports its handle again",
      () => edited("platform/csb-read.ts", (t) => `${t}\nexport const area = chromeSyncReader;\n`),
      /platform\/csb-read\.ts: chromeSyncReader used other than as a default area/,
    ],
    [
      "csb-read.ts exports the handle itself",
      () =>
        edited("platform/csb-read.ts", (t) =>
          t.replace("const chromeSyncReader = ", "export const chromeSyncReader = "),
        ),
      /platform\/csb-read\.ts: chromeSyncReader used other than as a default area/,
    ],
    [
      "csb-area.ts returns its area",
      () => edited("platform/csb-area.ts", (t) => `${t}\nexport const area = () => chromeSync();\n`),
      /platform\/csb-area\.ts: chromeSync used other than as a default area/,
    ],
    [
      "csb-area.ts sets through its handle, past writeSlot",
      () => edited("platform/csb-area.ts", (t) => `${t}\nvoid chromeSync()!.set({});\n`),
      /platform\/csb-area\.ts: (?:chromeSync used other than as a default area|2 calls of \.set\()/,
    ],
    ["a page imports the writer", () => page('import "../platform/csb-area";\n'), /imports csb-area/],
    [
      "another module of the worker imports the writer",
      () => [...files, { path: "platform/csb-extra.ts", text: 'import { removeSlot } from "./csb-area";\n' }],
      /platform\/csb-extra\.ts: imports csb-area/,
    ],
    [
      "a page imports the worker's backup",
      () => page('import { createCsbWorker } from "../platform/csb-worker";\nvoid createCsbWorker;\n'),
      /options\/Rogue\.tsx: a page imports the worker's backup/,
    ],
    [
      "the worker imports the writer a second time, lazily",
      () => edited("platform/csb-worker.ts", (t) => `${t}\nvoid import("./csb-area");\n`),
      /platform\/csb-worker\.ts: not one import of csb-area's named functions/,
    ],
    [
      "the worker imports the writer whole",
      () =>
        edited("platform/csb-worker.ts", (t) =>
          t.replace(/^import \{[^}]*\} from "\.\/csb-area";$/m, 'import * as area from "./csb-area";'),
        ),
      /platform\/csb-worker\.ts: not one import of csb-area's named functions/,
    ],
  ])("%s: refused", (_, tree, says) => {
    expect(csbSyncRule(tree()).join("\n")).toMatch(says);
  });

  it("CSB: the worker's backup and the store's recovery hook take the same lock, under the same name (cloud-mark.ts); the store's lock is the store's", () => {
    const text = (p: string) => files.find((f) => f.path === p)!.text;
    expect(text("background/sw.ts")).toMatch(/^ {2}lock: webLock\("sixkey-csb"\), \/\/ the records' lock/m);
    // the handlers that lift or replace a hold take the store's own lock first: the name the store is built with
    expect(text("background/sw.ts")).toMatch(/^ {2}vaultLock: webLock\("sixkey-vault"\), \/\/ the store's own/m);
    expect(text("platform/runtime-base.ts")).toMatch(/await markCsbHeld\(local, webLock\("sixkey-csb"\)\);/);
    expect(sites(/webLock\("sixkey-csb"\)/).map((s) => s.split(":")[0])).toEqual([
      "background/sw.ts",
      "platform/runtime-base.ts",
    ]);
  });

  it("CSB: the worker's backup writes once a run, removes leftovers in the run alone, and removes a slot only to turn off and in a merge's removal", () => {
    expect(csbWriteRule(files)).toEqual([]);
    expect(files.find((f) => f.path === "platform/csb-worker.ts")?.text).toMatch(/async function turnOff\(/);
  });

  it("CSB: a run loads the vault before the records' lock and works out the card's numbers after it, once each", () => {
    expect(csbRunRule(files)).toEqual([]);
  });

  const worker = (edit: (t: string) => string) => edited("platform/csb-worker.ts", edit);
  it.each<[string, () => { path: string; text: string }[], RegExp]>([
    [
      "the run removes its own slot instead of its leftovers",
      () =>
        worker((t) =>
          t.replace(
            "    if (left.length) noteRefusal(await removeLeftovers(plan.slot, plan.manifest.n, left, d.area));",
            "    if (left.length) noteRefusal(await removeSlot(plan.slot, d.area));",
          ),
        ),
      /removeSlot called 3 times, not 2[\s\S]*the run \(decideAndWrite\) removes a slot/,
    ],
    [
      "a merge's handler removes the held slot",
      () =>
        worker((t) =>
          t.replace(
            "      await putCfg({ ...cfg, link: next });",
            "      await removeSlot(link.slot, d.area);\n      await putCfg({ ...cfg, link: next });",
          ),
        ),
      /removeSlot called 3 times, not 2/,
    ],
    [
      "turning off removes through another function",
      () =>
        worker((t) =>
          t.replace(
            "      return (await removeSlot(link.slot, d.area)).ok;",
            "      return (await dropOwn(link.slot)).ok;",
          ),
        ),
      /removeSlot not called 1 times in turnOff/,
    ],
    [
      "the run writes twice (a retry of the set)",
      () =>
        worker((t) =>
          t.replace(
            "    const w = await writeSlot(plan, d.area);",
            "    let w = await writeSlot(plan, d.area);\n    if (!w.ok) w = await writeSlot(plan, d.area);",
          ),
        ),
      /writeSlot called 2 times, not 1/,
    ],
    [
      "removeSlot renamed on import",
      () => worker((t) => t.replace("removeSlot, writeSlot,", "removeSlot as drop, writeSlot,")),
      /renames a function of csb-area on import/,
    ],
  ])("%s: refused", (_, tree, says) => {
    const t = tree().find((f) => f.path === "platform/csb-worker.ts")!.text;
    expect(t).not.toBe(files.find((f) => f.path === "platform/csb-worker.ts")!.text); // the counter-example does alter
    expect(csbWriteRule(tree()).join("\n")).toMatch(says);
  });

  it.each<[string, (t: string) => string, RegExp]>([
    [
      "the load under the records' lock",
      (t) => t.replace("await d.load().catch(", "await d.lock(() => d.load()).catch("),
      /once\(\) takes the records' lock other than for decideAndWrite alone[\s\S]*load is not before the records' lock/,
    ],
    [
      "a second load, in the decision",
      (t) =>
        t.replace(
          '    const cfg = await cfgOf();\n    if (!cfg.on) return { kind: "off" };',
          (m) => `${m}\n    await d.load();`,
        ),
      /the store's load called 2 times, not once in once\(\)/,
    ],
    [
      "the numbers worked out under the lock",
      (t) =>
        t.replace(
          ".lock(() => decideAndWrite(loaded.gen))",
          '.lock(async () => { const o = await decideAndWrite(loaded.gen); if (o.kind === "wrote") await statsOf(o.view); return o; })',
        ),
      /once\(\) takes the records' lock other than for decideAndWrite alone[\s\S]*numbers not worked out once/,
    ],
    [
      "the numbers worked out in the decision",
      (t) =>
        t.replace(
          '      return { kind: "skipped", view: view(area, link) };',
          '      await statsOf(view(area, link));\n      return { kind: "skipped", view: view(area, link) };',
        ),
      /the card's numbers not worked out once, in once\(\), after the records' lock/,
    ],
  ])("%s: refused", (_, edit, says) => {
    const tree = worker(edit);
    expect(tree.find((f) => f.path === "platform/csb-worker.ts")!.text).not.toBe(
      files.find((f) => f.path === "platform/csb-worker.ts")!.text,
    );
    expect(csbRunRule(tree).join("\n")).toMatch(says);
  });
});
