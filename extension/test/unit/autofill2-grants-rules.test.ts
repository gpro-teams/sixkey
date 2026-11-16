// TOTP autofill Stage 2, patch 2: the per-site grants' properties pinned in the source (AUTOFILL2-NOTES §7). Behaviour is
// tested in autofill2-sites.test.ts, autofill2-sync.test.ts and autofill2-sw.test.ts; these fail when the shape that keeps a
// promise changes:
//   - Chrome's prompt is the first statement of both clicks that ask (the Fill card's "Turn on", Settings' "Turn on
//     again"), and requestSite makes the request before anything else, with no await in it;
//   - the keys are spelled in one module, so the state is device-local by construction: no sync, backup or export code
//     can name it;
//   - nothing in the source asks for more than one site's pattern: no wildcard host, no http pattern, no <all_urls>;
//   - no content script is registered yet, and reconcile's seam does nothing in this patch;
//   - the worker reconciles on every permission event and on a change of the list.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { groupOf, leafOfHash, leavesOf, panelOfHash } from "../../src/options/route";

const SRC = join(__dirname, "../../src");
/** A source file with its comments removed (a rule is not satisfied or broken by what a comment says). */
const code = (rel: string) =>
  ts.transpileModule(readFileSync(join(SRC, rel), "utf8"), {
    fileName: rel,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts") ? [p] : [];
  });
const all = walk(SRC).map((p) => ({ path: relative(SRC, p), code: code(relative(SRC, p)) }));

/** The body of `function name(...) {...}`, through its closing brace at the start of a line. */
function body(src: string, header: RegExp): string {
  const m = header.exec(src);
  if (!m) throw new Error(`no ${header}`);
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n}\n/);
  return end < 0 ? rest : rest.slice(0, end);
}
/** The first statement of a function body. */
const first = (b: string) => b.trim().split("\n")[0]!.trim();

describe("the request is made in the click itself", () => {
  it("the Fill card's Turn on and Settings' Turn on again: requestSite is the first statement", () => {
    const fill = code("popup/main/Fill.tsx");
    expect(first(body(fill, /function turnOn\(o\)\s*\{/))).toBe("const asked = requestSite(o.host);");
    expect(fill).toMatch(/onClick:\s*\(\)\s*=>\s*turnOn\(o\)|onClick=\{\(\) => turnOn\(o\)\}/);
    const misc = code("options/Misc.tsx");
    expect(first(body(misc, /function again\(host\)\s*\{/))).toBe("const asked = requestSite(host);");
    expect(misc).toMatch(/onClick=\{\(\) => again\(r\.host\)\}/);
    // and nobody else asks for a site
    expect(
      all
        .filter((f) => /\brequestSite\(/.test(f.code))
        .map((f) => f.path)
        .sort(),
    ).toEqual(["options/Misc.tsx", "platform/autofill-sites.ts", "popup/main/Fill.tsx"]);
  });

  it("requestSite is not async and has no await; the request comes before the note of the ask", () => {
    const sites = code("platform/autofill-sites.ts");
    expect(sites).toMatch(/\nexport function requestSite\(/); // not `async`
    const b = body(sites, /export function requestSite\(.*\)\s*\{/);
    expect(b).not.toMatch(/\bawait\b|\.then\(/);
    expect(b.indexOf("p.request(")).toBeGreaterThan(0);
    expect(b.indexOf("p.request(")).toBeLessThan(b.indexOf("session?.set("));
  });
});

describe("what is asked for, and where the state lives", () => {
  it("no wildcard host, no http pattern and no <all_urls> is named in the code; a site's pattern is built in one place", () => {
    for (const f of all) {
      expect(f.code, f.path).not.toMatch(/<all_urls>|["'`]\*:\/\/|https?:\/\/\*/);
      if (f.path !== "core/autofill-sites.ts") expect(f.code, f.path).not.toMatch(/`https:\/\/\$\{/);
    }
    expect(code("core/autofill-sites.ts").match(/`https:\/\/\$\{host\}\/\*`/g)).toHaveLength(1);
  });

  it("the keys are spelled in platform/autofill-sites.ts alone (so no sync, backup or export code names them)", () => {
    expect(all.filter((f) => /sk_af_/.test(f.code)).map((f) => f.path)).toEqual(["platform/autofill-sites.ts"]);
    const sites = code("platform/autofill-sites.ts");
    expect(sites).toMatch(/SITES_KEY = "sk_af_sites"/);
    expect(sites).toMatch(/PENDING_KEY = "sk_af_pending"/);
    expect(sites).toMatch(/LATER_KEY = "sk_af_later"/);
    for (const f of all.filter((x) => /^(core\/(sync|backup)|options\/sync|platform\/sync)/.test(x.path)))
      expect(f.code, f.path).not.toMatch(/autofill-sites|SITES_KEY/);
  });

  it("the content script is registered in one module, which reconcile's seam calls (patch 3)", () => {
    for (const f of all.filter((x) => x.path !== "platform/autofill-register.ts"))
      expect(f.code, f.path).not.toMatch(/registerContentScripts|unregisterContentScripts|updateContentScripts/);
    expect(body(code("platform/autofill-reconcile.ts"), /export function workerReconciler\([^)]*\)[^{]*\{/)).toMatch(
      /apply: \(hosts\) => applyRegistration\(hosts\),/,
    );
  });
});

describe("the worker and the page", () => {
  it("every permission event that may be about a site reconciles, and a change of the list does", () => {
    const sw = code("background/sw.ts");
    const removed = sw.slice(sw.indexOf("chrome.permissions.onRemoved.addListener("));
    // and every event that names `scripting` (optional since W1b)
    // (with the sync release gate closed there is no API permission to tell apart: every event that names a host)
    expect(sw).toMatch(/const mayBeSite = SYNC_UI \? beyondApi : concernsApi;/);
    expect(removed.slice(0, removed.indexOf("});"))).toMatch(
      /if \(mayBeSite\(p\) \|\| namesScripting\(p\)\)\s*void reconcileSites\(\);/,
    );
    const added = sw.slice(sw.indexOf("chrome.permissions.onAdded.addListener("));
    expect(added.slice(0, added.indexOf("});"))).toMatch(
      /if \(mayBeSite\(p\) \|\| namesScripting\(p\)\)\s*void acceptPending\(p\)[\s\S]*reconcileSites\(\)/,
    );
    expect(sw).toMatch(/watchList\(chrome\.storage\.local, reconcileSites\);/);
    // the gate: this start's own access-level answer; and the switch (wave 1b) read without the key
    expect(sw).toMatch(/workerReconciler\(storageAccess, note, switchedOff\)/);
    // a write of the switch, and only that, follows it: unregistered first, then the sites' grants and `scripting` given
    // back (never at a worker start, or on a grant, which an On click's may be before its switch is written;
    // plugins-w1b-source-rules.test.ts holds the rest)
    expect(sw).toMatch(/const switched = \(\) =>\s*followSwitch\(reconcileSites, switchedOff, \{/);
    expect(sw).toMatch(/watchSwitch\(chrome\.storage\.local, switched\);/);
    expect(sw.match(/\bswitched\b/g)).toHaveLength(2); // declared, and given to the watcher: called nowhere else
    expect(sw).toMatch(/\nvoid reconcileSites\(\);\s*$/);
  });

  it("Settings › Security › Autofill: #autofill is the Security group's fourth leaf", () => {
    expect(leafOfHash("#autofill", leavesOf(true))).toBe("autofill");
    expect(leafOfHash("#autofill", leavesOf(false))).toBe("autofill"); // the store build too
    expect(groupOf("autofill")!.leaves).toEqual(["security", "security-keys", "security-log", "autofill"]);
    expect(leafOfHash("#security", leavesOf(true))).toBe("security"); // the group's own link: Locking, as before
    expect(leafOfHash("#appearance", leavesOf(true))).toBe("appearance"); // Appearance stays one page
    expect(panelOfHash("#autofill")).toBeNull();
  });
});
