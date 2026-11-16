// Wave 1b of the plugin platform: the rules about the source that keep autofill a built-in plugin
// (docs/design/proposals/MOD-PLATFORM.md §7.2 Option I; docs/design/notes/PLUGINS-W1B-NOTES.md). What it does is
// plugins-w1b-gate.test.ts's; these fail when the shape of the code that keeps a promise changes:
//   - the boundary: autofill's modules work out no code; the one way to one is the platform's gate, which reads the
//     verified record, checks the switch and the ceiling, logs, and only then works it out; every fill is given the gate;
//   - `scripting` is optional: every use of chrome.scripting is behind Chrome's answer; the first Fill click, a site turned
//     on and autofill turned on ask for it as the click's first statement; the shortcut opens Sixkey when it is missing;
//   - Off: the page writes the switch and gives back the sites' grants; the worker alone unregisters, then gives back
//     `scripting`, on the switch's write only; the page hint is written by the switch's modules only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../src");
/** The code without its comments and without white space, so a rule reads the same however the code is laid out. */
const stripComments = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\s+/g, "");
const files: { path: string; code: string }[] = [];
(function walk(dir: string) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(n))
      files.push({ path: relative(SRC, p).split("\\").join("/"), code: stripComments(readFileSync(p, "utf8")) });
  }
})(SRC);
const file = (p: string) => files.find((f) => f.path === p)!.code;
const using = (re: RegExp) =>
  files
    .filter((f) => re.test(f.code))
    .map((f) => f.path)
    .sort();
/** From `start` to the first `end` after it. */
const between = (c: string, start: string, end: string) => {
  const i = c.indexOf(start);
  if (i < 0) throw new Error(`no ${start}`);
  const j = c.indexOf(end, i + start.length);
  return c.slice(i, j < 0 ? undefined : j);
};

/**
 * A module's own imports, as paths under src/: static ones, re-exports (`export * from`, `export { x } from`), side-effect
 * imports and import() with a string or a template literal without substitutions (the W1b r2 review's G4); a type-only
 * import is erased, so it is no edge. A specifier is resolved as Vite and TypeScript's Bundler resolution do it: as it
 * is, with `.ts`/`.tsx`, as a folder's index, and with a `.js`/`.jsx`/`.mjs` ending read as `.ts`/`.tsx` (G5b). A
 * dynamic import whose specifier is computed (a template with `${`) is refused outright: no autofill module may have one.
 */
function importsOf(rel: string): string[] {
  const t = readFileSync(join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const out = new Set<string>();
  const re =
    /(?:\bimport|\bexport)\s*(type\s+)?[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*`([^`$]+)`\s*\)|\bimport\s*["']([^"']+)["']/g;
  for (const m of t.matchAll(re)) {
    if (m[1]) continue;
    const spec = (m[2] ?? m[3] ?? m[4] ?? m[5])!;
    if (!spec.startsWith(".")) continue;
    const base = resolve(SRC, dirname(rel), spec);
    const bare = base.replace(/\.(?:m?js|jsx)$/, "");
    const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), `${bare}.ts`, `${bare}.tsx`].find(
      (c) => /\.(ts|tsx)$/.test(c) && existsSync(c) && statSync(c).isFile(),
    );
    if (hit) out.add(relative(SRC, hit).split("\\").join("/"));
  }
  return [...out];
}
/** Whether a module has a dynamic import whose specifier is computed (not followable by the walk above). */
const computedImport = (rel: string) => /\bimport\s*\(\s*(?!["'][^"']*["']\s*\)|`[^`$]*`\s*\))/.test(file(rel));
/** Every module `from` reaches through imports, without going through `stop`; each with the module that imported it. */
function reach(from: readonly string[], stop: string): Map<string, string | null> {
  const seen = new Map<string, string | null>(from.map((f) => [f, null]));
  const queue = [...from];
  while (queue.length) {
    const f = queue.shift()!;
    if (f === stop) continue;
    for (const d of importsOf(f))
      if (!seen.has(d)) {
        seen.set(d, f);
        queue.push(d);
      }
  }
  return seen;
}
/** The modules that make codes: the HMAC, the list's code maker (codeAt) and its hooks (useCodes). */
const MAKERS = ["core/totp/hotp.ts", "ui/otp.ts", "ui/hooks.ts"];
/** Autofill's own modules: the finder, the content script, the platform's and the surfaces' fill code, the worker's. */
const AUTOFILL = [
  ...files.map((f) => f.path).filter((p) => /^inject\/|^platform\/autofill[\w-]*\.ts$/.test(p)),
  "platform/content-channel.ts",
  "platform/fill-request.ts",
  "background/fill-command.ts",
  "popup/main/Fill.tsx",
  "options/Misc.tsx",
];
const GATE = "platform/plugins/autofill-gate.ts";
/** The fill path: every autofill module but the Settings page, which lists the sites and draws the switch, and fills nothing. */
const FILL = AUTOFILL.filter((p) => p !== "options/Misc.tsx");

describe("the boundary (§7.2 Option I item 1): autofill reaches a code through the platform's gate only", () => {
  it("the walk's own list: every hand-written autofill module is in it, and the found ones are what they should be", () => {
    // (the r2 review's G8: a list that loses a module would lose that module's whole subtree from the rule)
    for (const p of [
      "platform/content-channel.ts",
      "platform/fill-request.ts",
      "background/fill-command.ts",
      "popup/main/Fill.tsx",
      "options/Misc.tsx",
      "platform/autofill.ts",
      "platform/autofill-sites.ts",
      "platform/autofill-register.ts",
      "platform/autofill-reconcile.ts",
      "inject/otp.ts",
      "inject/suggest.ts",
    ])
      expect(AUTOFILL, p).toContain(p);
    expect(AUTOFILL.length).toBeGreaterThanOrEqual(11);
  });

  it("the gate's module exports what the gate is, and nothing else: no maker can be taken from it (the r2 review's G6)", () => {
    const src = ts.createSourceFile(GATE, readFileSync(join(SRC, GATE), "utf8"), ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    for (const st of src.statements) {
      const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
      const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(st)) names.push(`export-from:${st.getText()}`);
      else if (ts.isExportAssignment(st)) names.push("export-default");
      else if (
        exported &&
        (ts.isFunctionDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st))
      )
        names.push(st.name!.text);
      else if (exported && ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations) names.push(d.name.getText());
    }
    expect(names.sort()).toEqual(["Allowed", "autofillAllowed", "gatedCode", "touchSwitch"]);
  });

  it("the textual rule too: no autofill module names a code maker or imports from one", () => {
    for (const p of AUTOFILL) {
      const c = file(p);
      expect(c, p).not.toMatch(/codeAt|hotp|counterAt|useCodes/);
      expect(c, p).not.toMatch(/from"[./]*core\/totp\/(?:hotp|base32)/);
      // of the list's code helpers, only what says whether an account makes codes, and how long the current one lasts
      for (const m of c.matchAll(/import\{([^}]*)\}from"[./]*ui\/otp(?:-time)?(?:\.js)?"/g))
        for (const name of m[1]!.split(",")) expect(["canGenerate", "remaining"], `${p}: ${name}`).toContain(name);
    }
  });

  it("none of autofill's modules reaches a module that makes codes, by any import path, but through the gate", () => {
    // the import graph from every autofill module (W1b review F-03): a re-export, a namespace import or a new module in
    // between is still an edge; the one way to a maker is the gate
    const seen = reach(AUTOFILL, GATE);
    for (const m of MAKERS) {
      const path: string[] = [];
      for (let at: string | null | undefined = m; at; at = seen.get(at)) path.unshift(at);
      expect(seen.has(m) ? path.join(" -> ") : "unreached", m).toBe("unreached");
    }
    expect(seen.has(GATE)).toBe(true); // (the walk is real: it gets to the gate)
    // no import the walk cannot follow, in anything it reached
    expect([...seen.keys()].filter(computedImport)).toEqual([]);
    // and nothing on the fill path makes a MAC of its own (a new code maker outside MAKERS: the r2 review's G7). The fill
    // path is every autofill module but the Settings page (options/Misc.tsx), which never fills (fillCand has two
    // callers, executeScript one module: autofill1-source-rules) and reaches the vault's service and the grant store as
    // every settings page does. The grant store's own MAC (core/plugins/grants.ts, its tag) is reached from the fill path
    // only through the gate, so this walk never meets it:
    const fill = reach(FILL, GATE);
    const crypto = [...fill.keys()].filter((p) =>
      /\bsubtle\b|["'`]HMAC["'`]|\bimportKey\b|\.sign\(/.test(readFileSync(join(SRC, p), "utf8")),
    );
    const via = crypto.map((p) => {
      const path: string[] = [];
      for (let at: string | null | undefined = p; at; at = fill.get(at)) path.unshift(at);
      return path.join(" -> ");
    });
    expect(via).toEqual([]);
    expect(fill.has(GATE)).toBe(true);
    expect(fill.has("core/plugins/grants.ts")).toBe(false);
    expect([...reach([GATE], "").keys()]).toContain("core/plugins/grants.ts");
    expect(seen.has("core/totp/time.ts")).toBe(true); // the window's arithmetic, which makes no code
    // the gate itself does reach the maker: that is the edge allowed
    expect([...reach([GATE], "").keys()]).toContain("ui/otp.ts");
    // and Fill's gate is the gate's module, by name
    expect(file("popup/main/Fill.tsx")).toMatch(
      /import\{gatedCode,touchSwitch\}from"\.\.\/\.\.\/platform\/plugins\/autofill-gate";/,
    );
  });

  it("fillCand has no code of its own: the gate's is required, and refused means nothing goes to the page", () => {
    const a = file("platform/autofill.ts");
    expect(a).toMatch(/exporttypeGatedCode=\(e:Entry,timeMs:number\)=>Promise<Gated>;/);
    expect(between(a, "exporttypeFillDeps={", "};")).not.toMatch(/\bcode\b/);
    expect(a).toMatch(
      /exportasyncfunctionfillCand\(tabId:number,entry:Entry,cand:Cand,d:FillDeps&\{code:GatedCode\},?\)/,
    );
    const f = between(a, "exportasyncfunctionfillCand(", "\n");
    expect(f).toMatch(
      /constgated=awaitd\.code\(live,now\(\)\);if\(!\("code"ingated\)\)return\{k:"failed",r:gated\.no\};/,
    );
  });

  it("every fill is given the gate: the popup's and the side panel's with their vault key, the shortcut's with the worker's", () => {
    expect(using(/[^n]gatedCode\(/)).toEqual(["background/sw.ts", "popup/main/Fill.tsx"]); // (not its definition)
    expect(file("background/sw.ts")).toMatch(
      /deps:\{code:gatedCode\(\(\)=>rt\.service\.grantKeys\(\)\),off:switchedOff\},/,
    );
    const fill = file("popup/main/Fill.tsx");
    expect(fill).toMatch(/constcode=\(e:Entry,at:number\)=>gatedCode\(keysOf\)\(e,at\);/);
    expect(fill.match(/fillCand\(/g)).toHaveLength(1);
    // (and the page's site rule's minLeft: AF3-3b)
    expect(between(fill, "awaitfillCand(", "waiting:")).toMatch(
      /^awaitfillCand\(s\.tabId,e,pick,\{code,minLeft:s\.minLeft,$/,
    );
    expect(file("popup/main/Main.tsx")).toMatch(/m\.connect\(\(\)=>rt\.service\.grantKeys\(\)\)/);
    // the shortcut's fillOnTab takes it from runShortcut's deps, which the worker gives (required, no default)
    const cmd = file("background/fill-command.ts");
    expect(cmd).toMatch(/deps:FillDeps&\{code:GatedCode;off:\(\)=>Promise<boolean>\};/);
    expect(cmd).not.toMatch(/codeAt|code:async|code:\(/);
  });

  it("the gate: the verified record, the switch, the official ceiling, the log, and only then the code", () => {
    const g = file("platform/plugins/autofill-gate.ts");
    const allowed = between(g, "exportasyncfunctionautofillAllowed(", "\n");
    expect(allowed).toMatch(
      // (wave 2a: the verified read with a fresh key after a key change, N2)
      /constr=awaitwithFreshKeys\(keys,switchRecord\);if\(!r\)return"locked";const\{plugins\}=r;if\(!autofillOn\(plugins\)\)return"off";/,
    );
    expect(allowed).toMatch(/trustOf\(catalog\(\),AUTOFILL_ID,null\)/);
    expect(allowed).toMatch(/constown=autofillEntry\(plugins\);/);
    expect(allowed).toMatch(/returntrust==="official"&&held\.includes\("codes\.forPage"\)\?"ok":"off";/);
    // the switch's record: the verified one, or where its tag fails the very reading the worker makes (OD-1)
    const sw = file("platform/plugins/autofill-switch.ts");
    expect(between(sw, "exportasyncfunctionswitchRecord(", "exportconstswitchedOff")).toMatch(
      /constv=awaitgrantStore\(\)\.read\(k\);returnv\.ok\?\{plugins:v\.plugins,verified:true\}:\{plugins:\(awaitgrantStore\(\)\.unverified\(\)\)\.plugins,verified:false\};/,
    );
    expect(sw).toMatch(
      /exportconstswitchedOff=async\(\):Promise<boolean>=>!autofillOn\(\(awaitgrantStore\(\)\.unverified\(\)\)\.plugins\);/,
    );
    const code = between(g, "exportfunctiongatedCode(", "\n");
    expect(code.indexOf("pluginSession()")).toBeGreaterThan(-1);
    expect(code.indexOf('pluginId:AUTOFILL_ID,type:"codes.forPage"')).toBeGreaterThan(-1);
    expect(code).toMatch(/returnallowed==="ok"\?\{code:awaitcodeAt\(e,timeMs\)\}:\{no:allowed\};/);
    expect(code.indexOf("codeAt(")).toBeGreaterThan(code.indexOf("autofillAllowed(keys)"));
  });

  it("the reserved ID: the catalog is the built-in's entry alone, and nothing else can claim it", () => {
    expect(file("platform/plugins/chrome.ts")).toMatch(
      /constCATALOG:Catalog=\{v:1,plugins:\[\.\.\.BUILTIN_CATALOG\]\};/,
    );
    // no build bundles another catalog, and nothing takes a plugin's ID from a message any more
    expect(file("platform/plugins/chrome.ts")).not.toMatch(/__PLUGIN_CATALOG__/);
  });
});

describe("`scripting` is optional (§7.2 Option I item 3)", () => {
  it("every chrome.scripting call is behind Chrome's answer (contains), never the namespace, which stays after a give-back", () => {
    const a = file("platform/autofill.ts");
    expect(between(a, "exportasyncfunctionscriptingHeld(", "\n")).toMatch(
      /returnawaitc\.permissions\.contains\(\{permissions:\["scripting"\]\}\);/,
    );
    const scan = between(a, "exportasyncfunctionscan(", "\n");
    expect(scan).toMatch(
      /^exportasyncfunctionscan\(tabId:number,hint:Hint\|null\|Promise<Hint\|null>=null\):Promise<Scan>\{if\(!\(awaitscriptingHeld\(\)\)\)return\{k:"ask"\};/,
    );
    const fill = between(a, "exportasyncfunctionfillCand(", "\n");
    expect(fill.indexOf('if(!(awaitscriptingHeld()))return{k:"failed",r:"ask"};')).toBeGreaterThan(-1);
    expect(fill.indexOf("scriptingHeld()")).toBeLessThan(fill.indexOf("executeScript"));
    // the registration: the namespace read when the call is made, an apply without it does nothing
    const reg = file("platform/autofill-register.ts");
    expect(reg).toMatch(/c:Registrar\|undefined=globalThis\.chrome\?\.scripting/);
    expect(reg).toMatch(/if\(!c\?\.getRegisteredContentScripts\)return;/);
    // the worker reconciles only while it holds it (autofill-reconcile.ts usable)
    expect(file("platform/autofill-reconcile.ts")).toMatch(
      /usable:async\(\)=>\(!\(awaitscriptingHeld\(\)\)\?"unscripted":\(awaitoff\(\)\)\?"off":"on"\),/,
    );
  });

  it("asked for as the first statement of the click: a Fill, a site turned on, autofill turned on", () => {
    const fill = file("popup/main/Fill.tsx");
    expect(fill).toMatch(
      /asyncfunctionpress\(e:Entry,o:PressOptions=\{\}\):Promise<void>\{constasked=askScripting\(!o\.resumed\);/,
    );
    const ask = between(fill, "functionaskScripting(gesture=true)", "letsiteHost");
    expect(ask).toMatch(
      /if\(offHint\(\)\)returnPromise\.resolve\("off"\);if\(held\)returnPromise\.resolve\("ok"\);if\(!gesture\)returnPromise\.resolve\("no"\);/,
    );
    // the one press without a click, the fill resumed after an unlock, says so; and never asks (W1b review F-09). Its three
    // forms are the one call of resumeFill: the popup's, the side panel's, and (the in-page suggestion's gate open, AUTOFILL2
    // patch 4a) a page's request, which also names its document
    expect(fill.match(/resumed:true/g)).toHaveLength(3);
    expect(between(fill, "asyncfunctionresumeFill(", "functionfocusFill(").match(/resumed:true/g)).toHaveLength(3);
    expect(fill).toMatch(/if\(!\(held=awaitscriptingHeld\(\)\)\)returnfocusFill\(\);/);
    expect(ask).toMatch(/asked=chrome\.permissions\.request\(\{permissions:\["scripting"\]\}\);/);
    expect(ask).not.toMatch(/await/);
    // every Fill button's click is a press (no fillCand without one)
    expect(fill.match(/onClick=\{\(\)=>voidpress\(/g)!.length).toBeGreaterThanOrEqual(3);
    // a site: one request, `scripting` with its pattern
    expect(file("platform/autofill-sites.ts")).toMatch(
      /asked=p\.request\(\{permissions:\["scripting"\],origins:\[pattern\]\}\);/,
    );
    // autofill: the click's first statement asks (scripting and the listed sites), the switch is written after
    const sw = file("options/AutofillSwitch.tsx");
    expect(sw).toMatch(/functionflip\(next:boolean\):void\{constasked=next\?askAutofillOn\(hosts\):null;/);
    expect(file("platform/plugins/autofill-switch.ts")).toMatch(
      /returnp\.request\(\{permissions:\["scripting"\],\.\.\.\(origins\.length\?\{origins\}:\{\}\)\}\)/,
    );
    // nowhere else is `scripting` asked for
    expect(using(/request\(\{permissions:\["scripting"\]/)).toEqual([
      "platform/autofill-sites.ts",
      "platform/plugins/autofill-switch.ts",
      "popup/main/Fill.tsx",
    ]);
  });

  it("the shortcut, without it: Sixkey opens at its Fill button (the shortcut's own gesture cannot be used for a request)", () => {
    const cmd = file("background/fill-command.ts");
    // locked first (W1b review F-04), then, right before the look, the switch and `scripting`
    const tab = between(cmd, "exportasyncfunctionfillOnTab(", "constfound=awaitscan(tab.id);");
    expect(tab.indexOf('if(all===null)return"locked";')).toBeGreaterThan(-1);
    expect(tab.indexOf('if(all===null)return"locked";')).toBeLessThan(tab.indexOf("awaitd.off()"));
    expect(tab).toMatch(
      /if\(awaitd\.off\(\)\.catch\(\(\)=>false\)\)return"ask";if\(!\(awaitscriptingHeld\(\)\)\)return"ask";$/,
    );
    expect(cmd).toMatch(/if\(r\.r==="off"\|\|r\.r==="ask"\)return"ask";/);
    expect(cmd).toMatch(/constNEEDS_SURFACE:ReadonlySet<Outcome>=newSet\(\["locked","choose","insecure","ask"\]\);/);
    expect(cmd).not.toMatch(/permissions\.request/);
    // the surface it opens stops at the button: no fill without a click while `scripting` is missing
    expect(file("popup/main/Fill.tsx")).toMatch(/if\(!\(held=awaitscriptingHeld\(\)\)\)returnfocusFill\(\);/);
    // switched off (the page hint), the popup does not look at the page either (W1b review F-07)
    // (nor reads the page's site rule, nor without `scripting`: AF3-3b)
    expect(file("popup/main/Fill.tsx")).toMatch(
      /construle=held&&!offHint\(\)\?ruleForPage\(tab\.url\):null;constr=offHint\(\)\?\(\{k:"ask"\}asconst\):awaitscan\(tab\.id,rule\?rule\.then\(\(x\)=>x\.hint\):null\);/,
    );
  });

  it("the worker reconciles on every event that names it, granted or given back", () => {
    const sw = file("background/sw.ts");
    expect(sw).toMatch(
      /constnamesScripting=\(p:\{permissions\?:string\[\]\}\)=>\(p\.permissions\?\?\[\]\)\.includes\("scripting"\);/,
    );
    expect(sw.match(/if\(mayBeSite\(p\)\|\|namesScripting\(p\)\)/g)).toHaveLength(2);
    // a grant of it is never followed by a clock (the r2 review's N-02): no timer anywhere in the follow
    const added = between(sw, "chrome.permissions.onAdded.addListener(", "watchList(");
    expect(added).not.toMatch(/switched|setTimeout/);
    expect(file("platform/autofill-reconcile.ts")).not.toMatch(/setTimeout\(\(\)=>void|FOLLOW_AFTER/);
    // instead, every Fill click that meets the gate's "off" writes the record again, unchanged, which the worker follows
    // like any switch write (autofill-gate.ts touchSwitch; W1b r3 S-1: whether or not the click got `scripting`)
    const fill = file("popup/main/Fill.tsx");
    expect(fill).toMatch(
      /if\(r\.r==="off"\)return\(setOffHint\(true\),voidtouchSwitch\(keysOf\)\.catch\(\(\)=>undefined\),fail\(ft\("afOffNow"\)\)\);/,
    );
    expect(between(fill, "functionaskScripting(gesture=true)", "letsiteHost")).toMatch(
      /\(ok\)=>\(\(held=ok\),ok\?"granted":"no"\)/,
    );
    expect(between(file(GATE), "exportasyncfunctiontouchSwitch(", "\n")).toMatch(
      /awaitwithFreshKeys\(keys,\(k\)=>grantStore\(\)\.write\(k,\(b\)=>b\)\);\}/,
    );
  });
});

describe("Off (§7.2 Option I item 2): the list kept, the worker unregisters before `scripting` goes", () => {
  it("the page writes the switch and the hint, nothing else; the worker gives back the sites' own grants", () => {
    const s = file("platform/plugins/autofill-switch.ts");
    const off = between(s, "exportasyncfunctionturnAutofillOff(", "exportasyncfunctiongiveBackSites(");
    expect(off).toMatch(
      /^exportasyncfunctionturnAutofillOff\(keys:GrantKeys\|null\):Promise<boolean>\{if\(!keys\)returnfalse;awaitgrantStore\(\)\.setAutofill\(keys,false\);setOffHint\(true\);returntrue;\}$/,
    );
    const sites = between(s, "exportasyncfunctiongiveBackSites(", "exportfunctionaskAutofillOn(");
    // the switch read again before each site (the r2 review's N-04), then an exact grant only
    expect(sites).toMatch(
      /for\(constpatternofpatternsOf\(await\(o\.hosts\?\?readList\)\(\)\)\)\{if\(!\(awaito\.off\(\)\)\)return;if\(awaitgrantedExactly\(pattern,p\)\.catch\(\(\)=>false\)\)awaitp\.remove\(\{origins:\[pattern\]\}\)/,
    );
    expect(sites).not.toMatch(/scripting|applyRegistration|writeList|removeSite/);
    expect(s).not.toMatch(/autofill-register/);
    expect(using(/giveBackSites\(/)).toEqual(["background/sw.ts", "platform/plugins/autofill-switch.ts"]);
  });

  it("the worker alone gives `scripting` back: after a run that unregistered, with the switch read again, on its write only", () => {
    expect(using(/remove\(\{permissions:\["scripting"\]\}\)/)).toEqual(["background/sw.ts"]);
    const r = file("platform/autofill-reconcile.ts");
    const follow = between(r, "exportasyncfunctionfollowSwitch(", "\n");
    expect(follow).toMatch(
      /constran=awaitreconcile\(\);if\(ran\.k!=="applied"\|\|ran\.hosts\.length>0\)return;if\(!\(awaitoff\(\)\)\)return;awaitgiveBack\.sites\(off\);if\(\(awaitheld\(\)\)&&\(awaitoff\(\)\)\)awaitgiveBack\.scripting\(\);/,
    );
    // the run waits for the unregister before it says "applied, none" (W1b review F-11)
    expect(r).toMatch(/if\(usable==="off"\)\{if\(live\(\)\)awaitd\.apply\(\[\]\);return\{k:"applied",hosts:\[\]\};\}/);
    const sw = file("background/sw.ts");
    expect(sw).toMatch(
      /constswitched=\(\)=>followSwitch\(reconcileSites,switchedOff,\{sites:\(off\)=>giveBackSites\(\{off\}\),scripting:\(\)=>chrome\.permissions\.remove\(\{permissions:\["scripting"\]\}\),\}\)\.catch\(\(\)=>undefined\);/,
    );
    expect(sw).toMatch(/watchSwitch\(chrome\.storage\.local,switched\);/);
    // declared, and given to the watcher: called nowhere else (not at the worker's start, not on a grant)
    expect(sw.match(/switched(?!Off)/g)).toHaveLength(2);
  });

  it("the page hint sk_af_off: one module's key, written only where the switch is shown or met", () => {
    expect(using(/"sk_af_off"/)).toEqual(["platform/autofill-sites.ts"]);
    expect(using(/setOffHint\(/)).toEqual([
      "options/AutofillSwitch.tsx",
      "platform/autofill-sites.ts",
      "platform/plugins/autofill-switch.ts",
      "popup/main/Fill.tsx",
    ]);
    // the popup reads it in a click, never at its open (perf.spec's six reads): Main has none of it
    expect(file("popup/main/Main.tsx")).not.toMatch(/offHint|sk_af_off/);
    const on = between(file("platform/plugins/autofill-switch.ts"), "exportasyncfunctionturnAutofillOn(", "\n");
    expect(on).toMatch(/setOffHint\(false\);awaitgrantStore\(\)\.setAutofill\(keys,true\);/); // cleared before the write
  });
});
