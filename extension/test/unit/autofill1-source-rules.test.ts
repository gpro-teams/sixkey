// TOTP autofill, Stage 1: the security properties, pinned in the source (TOTP-AUTOFILL §4, §9, §11.3). Behaviour is tested
// elsewhere; these tests fail when the shape of the code that keeps a promise changes, so a later edit cannot drop one without
// a test saying so:
//   - the code is the only secret that leaves the extension for a page, in one call, to one document;
//   - the finder re-checks the page's origin, host and frames before it writes, writes only values (never submits, clicks or
//     presses a key), only into a box that is no password, search, e-mail, phone or card field, and holds no secret;
//   - only the registered tier is filled; "possibly related" never is;
//   - nothing logs, stores, copies or sends a code; no content script is registered; no host access is requested.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const EXT = join(__dirname, "../..");
const SRC = join(EXT, "src");
/** A source file with its comments removed (so a rule is not satisfied or broken by what a comment says). */
const code = (rel: string) =>
  ts.transpileModule(readFileSync(join(SRC, rel), "utf8"), {
    fileName: rel,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "preact",
    },
  }).outputText;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts") ? [p] : [];
  });
const all = walk(SRC).map((p) => ({ path: relative(SRC, p), code: code(relative(SRC, p)) }));

/** `src` has nothing that matches `re` (a short message when it does: the file's text is long). */
const none = (src: string, re: RegExp, where = "") => {
  const m = re.exec(src);
  expect(m ? `${where}${re} matches ${JSON.stringify(src.slice(Math.max(0, m.index - 30), m.index + 60))}` : "ok").toBe(
    "ok",
  );
};

/** The text of `function name(...) {...}` through its closing brace at the start of a line. */
function fn(src: string, header: RegExp): string {
  const m = header.exec(src);
  if (!m) throw new Error(`no ${header}`);
  const rest = src.slice(m.index);
  const end = rest.search(/\n}\n/);
  return end < 0 ? rest : rest.slice(0, end + 2);
}

describe("the finder (src/inject/otp.ts): what it may not do", () => {
  const engine = code("inject/otp.ts");
  it("imports nothing and uses no extension API, network, storage, message, timer-loop or dynamic code", () => {
    expect(engine).not.toMatch(/^\s*import\s/m);
    for (const re of [
      /\bchrome\b/,
      /\bbrowser\b/,
      /\bfetch\b/,
      /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bimportScripts\b/,
      /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\b|\bcookie\b/,
      /\bpostMessage\b|\bBroadcastChannel\b|\bMessageChannel\b|\bsendMessage\b|\.connect\(/,
      /\beval\s*\(|\bnew\s+Function\b|\bsetInterval\b/,
      /\bconsole\b/,
      /\bnavigator\b/,
      /\bwindow\.open\b|\blocation\.(?:href|assign|replace)\b|\bhistory\./,
    ])
      none(engine, re);
    // no global is read or written but window.top (is this the top page?) and, read once, its own name: the copy of the same
    // build already in this world (one finder per page); the build's `var __skOtp =` is the only write
    const own = /\bglobalThis\.__skOtp\b/g; // (the source as compiled: type casts removed)
    expect(engine.match(own)?.length).toBe(1);
    none(engine.replace(own, ""), /\bglobalThis\b|\bself\b|\bwindow\.(?!top\b)\w+|__skOtp\s*=/);
  });
  it("never submits, clicks or presses a key, and never touches the clipboard", () => {
    for (const re of [
      /\.submit\s*\(|\brequestSubmit\b|\.click\s*\(|\.dispatchEvent\(\s*new\s+(?:Mouse|Pointer|Keyboard|Wheel|Touch|Submit)/,
      /["'`]Enter["'`]|["'`]keydown["'`]|["'`]keyup["'`]|["'`]keypress["'`]|["'`]click["'`]/,
      /\bwriteText\b|\breadText\b|\bexecCommand\b|\bclipboard\b(?!Data)/,
      /\.form\b|\bclosest\(\s*["'`]form/,
    ])
      none(engine, re);
  });
  it("creates only three kinds of event: input, change, and a paste carrying its own DataTransfer", () => {
    const made = [...engine.matchAll(/new\s+(\w*Event)\(\s*["'`](\w+)["'`]/g)].map((m) => `${m[1]}:${m[2]}`).sort();
    expect(made).toEqual(["ClipboardEvent:paste", "Event:change", "InputEvent:input"]);
    expect([...engine.matchAll(/new\s+(\w*Event)\(/g)]).toHaveLength(3);
    expect(engine).toMatch(/new DataTransfer\(\)/);
  });
  it("changes nothing in the page but values: no elements made, inserted or removed, no attributes, classes or styles written", () => {
    for (const re of [
      /\bcreateElement\b|\bappendChild\b|\binsertBefore\b|\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\.remove\s*\(|\.append\s*\(|\.prepend\s*\(/,
      /\bsetAttribute\b|\bremoveAttribute\b|\bclassList\b|\.style\b|\.className\s*=(?!=)|\.textContent\s*=(?!=)|\.innerText\s*=(?!=)|\.id\s*=(?!=)/,
      /\battachShadow\b|\bcustomElements\b|\bMutationObserver\b|\baddEventListener\b|\bonclick\b/,
    ])
      none(engine, re);
    // the only assignments to a box are its value (and the native setter's) and a focus call
    expect([...engine.matchAll(/\bel\.(\w+)\s*=[^=]/g)].map((m) => m[1])).toEqual(["value"]);
  });
  it("fill() checks arguments, origin, host, frames, the box and the digits BEFORE it writes anything", () => {
    const f = fn(engine, /async function fill\(/);
    const first = Math.min(
      ...[f.indexOf("put(els"), f.indexOf("put(el,"), f.indexOf("put(el ,")].filter((i) => i >= 0),
    );
    const checks: [string, RegExp][] = [
      ["the code is 6 to 8 digits", /\\d\{6,8\}/],
      ["the origin is http(s)", /\^https\?/],
      ["the domain is a host name", /\{1,253\}/],
      ["the page's own origin is the one the extension matched", /location\.origin\s*!==\s*origin/],
      ["the page's host is covered by the account's domain", /!covered\(location\.hostname,\s*domain\)/],
      ["a top page is the one the extension looked at", /top\s*!==\s*location\.origin/],
      ["a frame's top page is that one", /a\[a\.length\s*-\s*1\]\s*!==\s*top/],
      ["every ancestor of a frame is covered", /!covered\(hostOfOrigin\(x\),\s*domain\)/],
      ["the box is still there, connected, visible and usable", /isConnected\s*&&\s*usable\(e\)/],
      ["the box is seen by the deep test (ancestors, ink, what is on top)", /usable\(e\)\s*&&\s*look\(e\)\s*>\s*0/],
      // every box of a group, not only the first (TOTP autofill Stage 3, S1), and for a rule's entry no box it may not promote
      ["every box is still no vetoed field", /els\.map\(\(e\) => score\(featOf\(e, [^)]*\)\)\)/],
      ["the veto is read for each of them", /scs\.some\(\(x, i\) => x\.veto \|\|/],
      ["a rule's entry: none of its boxes is one a rule may not promote", /entry\.kind === "r" && !boostable\(/],
      ["a box a rule groups is not filled alone", /o\.kind === "r" && o\.els\.length > 1 && els\.some\(/],
      ["the code fits", /maxLength\s*<\s*code\.length/],
    ];
    for (const [what, re] of checks) {
      const at = f.search(re);
      expect(at, `${what}: ${re}`).toBeGreaterThanOrEqual(0);
      expect(at, `${what} comes before the first write`).toBeLessThan(first);
    }
  });
  it("the box token is used once, tokens are stable across looks, and nothing is returned but enums", () => {
    const f = fn(engine, /async function fill\(/);
    expect(f).toMatch(/live\.delete\(t\)/);
    expect(engine).not.toMatch(/live\.clear\(\)/); // tokens are stable across looks (a second look must not take them away)
    expect(engine).toMatch(/const ids = new WeakMap\(\)/);
    // the code never appears in a returned value
    for (const m of f.matchAll(/return\s*\{[^}]*\}/g)) expect(m[0], m[0]).not.toMatch(/\bcode\b/);
  });
  it("the code goes to exactly two places: the value of a box and a paste event's own DataTransfer", () => {
    const f = fn(engine, /async function fill\(/);
    const body = f.slice(f.indexOf("\n"));
    const callees = [...body.matchAll(/\b([\w.]+)\(([^()]*\bcode\b[^()]*)\)/g)].map((m) => m[1]);
    expect(callees.length).toBeGreaterThan(0);
    for (const callee of callees) expect(["test", "put", "dt.setData", "els[i]", "forEach"], callee).toContain(callee);
    expect(f).toMatch(/dt\.setData\(\s*["'`]text\/plain["'`],\s*code\s*\)/);
  });
  it("writes with the native value setter, not the element's own property (a framework's wrapper would swallow it)", () => {
    expect(engine).toMatch(/Object\.getOwnPropertyDescriptor\(HTMLInputElement\.prototype,\s*["'`]value["'`]\)/);
    expect(engine).toMatch(/set\.call\(el,\s*v\)/);
  });
  it("what inspect() reads of a page is shapes and short text: it reads no value of a box", () => {
    const f = fn(engine, /function inspect\(/);
    expect(f).not.toMatch(/\.value\b/);
    expect(engine.match(/\.value\b/g)?.length).toBeLessThanOrEqual(8); // put(), readBack, the fill's comparison, data-* attribute values
  });
  it("search, e-mail, URL, password, phone, card and captcha boxes are vetoed or heavily negative, in the scoring", () => {
    const s = fn(engine, /export function score\(/);
    for (const re of [
      /"search"/,
      /"email"/,
      /"url"/,
      /AC_NOT\.test\(ac\)/,
      /ID_PASSWORD/,
      /captcha/,
      /ID_NOT/,
      /NOT_CODE/,
    ])
      expect(s, String(re)).toMatch(re);
    expect(engine).toMatch(/current-password\|new-password\|username\|email\|tel/);
  });
});

describe("the platform module (src/platform/autofill.ts): three calls, one secret", () => {
  const src = code("platform/autofill.ts");
  /** The one import of the storage gate (platform/storage-access.ts): the module's only mention of storage. */
  const GATE_IMPORT = /import \{ storageClosed \} from "\.\/storage-access";/g;
  const calls = [...src.matchAll(/chrome\.scripting\.executeScript\(/g)];
  it("calls executeScript exactly three times, and nothing else of chrome.scripting", () => {
    expect(calls).toHaveLength(3);
    expect([...src.matchAll(/chrome\.scripting\.(\w+)/g)].map((m) => m[1])).toEqual([
      "executeScript",
      "executeScript",
      "executeScript",
    ]);
    expect(src).not.toMatch(/registerContentScripts|insertCSS|unregisterContentScripts|updateContentScripts|removeCSS/);
  });
  it("the finder is installed with files and inspected with a function and its one argument, the hint (or null)", () => {
    expect(src).toMatch(
      /executeScript\(\{\s*target:\s*\{\s*tabId,\s*allFrames:\s*true\s*\},\s*files:\s*\[ENGINE_FILE\]\s*\}\)/,
    );
    expect(src).toMatch(
      /executeScript\(\{\s*target:\s*\{\s*tabId,\s*allFrames:\s*true\s*\},\s*func:\s*inspectStub,\s*args:\s*\[h\]\s*\}\)/,
    );
    // `h`: the hint, once read (the Fill chunk passes the rule still being read: AF3-3b), alongside the install; a read
    // that fails is no hint
    expect(src).toMatch(
      /const \[installed, h\] = await Promise\.all\(\[\s*within\(chrome\.scripting\.executeScript\(\{\s*target:\s*\{\s*tabId,\s*allFrames:\s*true\s*\},\s*files:\s*\[ENGINE_FILE\]\s*\}\)\),\s*Promise\.resolve\(hint\)\.catch\(\(\) => null\),?\s*\]\);/,
    );
    // the stub hands the argument on as it is: the finder tells a Fill path's look (one argument) from the content
    // script's (none), and a look with an argument owns the rule-made entries (AUTOFILL3-NOTES §3, R3-1)
    expect(src).toMatch(/const inspectStub = \(hint\) => globalThis\.__skOtp\?\.inspect\(hint\);/);
    expect(src).toMatch(/export async function scan\(tabId, hint = null\) \{/);
  });
  it("the content script looks with no argument at all, and only the Fill paths' stub passes one (AF3-2's review, N4)", () => {
    // the finder tells the looks apart by their argument count: a look with one (even undefined) owns the rule's entries
    const calls = all.flatMap((f) => [...f.code.matchAll(/\.inspect\(([^)]*)\)/g)].map((m) => `${f.path}: ${m[0]}`));
    expect(calls).toEqual(["inject/suggest-core.ts: .inspect()", "platform/autofill.ts: .inspect(hint)"]);
    expect(all.filter((f) => /\binspect\b/.test(f.code)).map((f) => f.path)).toEqual([
      "inject/otp.ts",
      "inject/suggest-core.ts",
      "platform/autofill.ts",
    ]);
  });
  it("the popup's and the side panel's look takes the page's site rule; the shortcut's none (AF3-3b, the maintainers' C27)", () => {
    // the modules that import scan from the platform module (Main.tsx has a scan of its own: the QR scanner)
    const callers = all.filter((f) => /import \{[^}]*\bscan\b[^}]*\} from "[./]+\/platform\/autofill"/.test(f.code));
    expect(callers.map((f) => f.path)).toEqual(["background/fill-command.ts", "popup/main/Fill.tsx"]);
    const [cmd, fill] = callers.map((f) => f.code);
    expect([...cmd!.matchAll(/(?<![\w.])scan\(([^()]*)\)/g)].map((m) => m[1])).toEqual(["tab.id"]);
    expect(cmd).not.toMatch(/site-rule|package-data|readRules/);
    // one look, the same function: its hint the page's rule, still being read
    expect(fill!.match(/(?<![\w.])scan\(/g)).toHaveLength(1);
    expect(fill!.replace(/\s+/g, "")).toMatch(/awaitscan\(tab\.id,rule\?rule\.then\(\(x\)=>x\.hint\):null\)/);
  });
  it("the fill call targets one document by ID: no allFrames, no frameIds, no tab-wide target", () => {
    const at = src.lastIndexOf("chrome.scripting.executeScript(");
    let depth = 0;
    let end = at;
    for (let i = src.indexOf("(", at); i < src.length; i++) {
      if (src[i] === "(") depth++;
      if (src[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    const call = src.slice(at, end + 1);
    expect(call).not.toMatch(/\bworld\b/); // never the page's own world (a page could define __skOtp there and take the code)
    expect(call).toMatch(/target:\s*\{\s*tabId,\s*documentIds:\s*\[cand\.documentId\]\s*\}/);
    expect(call).not.toMatch(/allFrames|frameIds|files:/);
    expect(call).toMatch(/args:\s*\[code,\s*cand\.origin,\s*cand\.domain,\s*cand\.top,\s*cand\.found\.t\]/);
  });
  it("the code comes into fillCand from the platform's gate, after the wait, from the account, and nowhere else in the module", () => {
    // W1b: no code of its own (no codeAt, no default): `d.code` is the gate's (platform/plugins/autofill-gate.ts gatedCode)
    expect(src).not.toMatch(/\bcodeAt\b/);
    const f = fn(src, /export async function fillCand\(/);
    // (the typed source: `code()` is the emitted JS)
    expect(readFileSync(join(SRC, "platform/autofill.ts"), "utf8")).toMatch(
      /fillCand\(\s*tabId: number,\s*entry: Entry,\s*cand: Cand,\s*d: FillDeps & \{ code: GatedCode \},?\s*\)/,
    );
    expect(f.indexOf("sleep")).toBeGreaterThan(-1);
    expect(f.indexOf("const gated = await d.code(live, now());")).toBeGreaterThan(f.indexOf("sleep"));
    expect(f.indexOf("const gated =")).toBeGreaterThan(f.indexOf("cancelled?.()"));
    // refused ("off", "locked"): nothing goes to the page
    expect(f).toMatch(
      /if \(!\("code" in gated\)\)\s*return \{ k: "failed", r: gated\.no \};\s*const code = gated\.code;/,
    );
    expect(f.match(/\bcode\b/g)!.length).toBeLessThanOrEqual(6); // the dep, the answer's, declared, passed in args
  });
  it("only the registered tier is filled (M1, M2), by an account that can generate a code (M4 follows)", () => {
    const f = fn(src, /export function candidatesFor\(/);
    expect(f).toMatch(/!canFill\(entry\)/);
    expect(f).toMatch(/matchTier\(entry,\s*host\)\s*!==\s*["'`]registered["'`]/);
    expect(f).not.toMatch(/related/);
    expect(src).toMatch(/export const canFill = \(e\) => canGenerate\(e\)/);
  });
  it("a frame needs the same domain for itself and every page above it, and the tab's own origin on top (M4)", () => {
    const f = fn(src, /export function candidatesFor\(/);
    expect(f).toMatch(/top \? o !== topOrigin : a\[a\.length - 1\] !== topOrigin/);
    expect(f).toMatch(/domains\.find\(\(d\) => hosts\.every\(\(h\) => coveredBy\(h, d\)\)\)/);
  });
  it("no injection in this module names a world: every one runs in the isolated world", () => {
    expect(src).not.toMatch(/\bworld\b/);
    expect(all.filter((f) => /\bworld\s*:/.test(f.code)).map((f) => f.path)).toEqual([]);
  });
  it("logs, stores and sends nothing", () => {
    for (const re of [
      /\bconsole\b/,
      /\bstorage\b/,
      /\bsendMessage\b/,
      /\bclipboard\b/,
      /\bfetch\b/,
      /localStorage|sessionStorage|indexedDB/,
    ])
      none(src.replace(GATE_IMPORT, ""), re); // (the one import of the storage gate, below)
  });
  it("STORAGEGATE: every function that injects asks the gate first, with nothing passed to it, and nothing else asks it", () => {
    expect(src.match(GATE_IMPORT)).toHaveLength(1);
    expect(src.match(/chrome\.scripting\.executeScript\(/g)).toHaveLength(3);
    for (const [name, calls] of [
      ["scan", 2],
      ["fillCand", 1],
    ] as const) {
      const f = fn(src, new RegExp(`export async function ${name}\\(`));
      const gate = f.indexOf("await storageClosed()");
      expect(gate, name).toBeGreaterThan(-1);
      expect(f.match(/chrome\.scripting\.executeScript\(/g), name).toHaveLength(calls);
      expect(gate, `${name}: the gate comes before its first injection`).toBeLessThan(
        f.indexOf("chrome.scripting.executeScript("),
      );
      // a refusal returns at once: the line of the gate is a return
      expect(f).toMatch(/if \(!\(await storageClosed\(\)\)\)\s*return \{/);
    }
    expect(src.match(/storageClosed\(/g)).toHaveLength(2); // the two gates, and no call with an argument
    expect(all.filter((x) => /\bstorageClosed\b/.test(x.code)).map((x) => x.path)).toEqual([
      "options/Misc.tsx", // AUTOFILL2 patch 2: Settings › Autofill says the Chrome 140 line from the gate; it injects nothing
      "platform/autofill-register.ts", // AUTOFILL2 patch 3: asked again before the content script is registered
      "platform/autofill.ts",
      "platform/storage-access.ts",
    ]);
  });
  it("the stubs that run in the page use nothing of the module (they are serialised)", () => {
    for (const name of ["inspectStub", "fillStub"]) {
      const m = new RegExp(`const ${name} = [\\s\\S]*?;\\n`).exec(src)!;
      const body = m[0];
      // only globalThis, the stub's own parameters and literals
      const idents = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((x) => x[1]!);
      const allowed = new Set([
        name,
        "const",
        "globalThis",
        "__skOtp",
        "inspect",
        "fill",
        "ok",
        "r",
        "gone",
        "false",
        "code",
        "origin",
        "domain",
        "top",
        "token",
        "hint",
        "string",
        "unknown",
        "as",
        "Engine",
        "undefined",
        "Promise",
        "void",
        "a",
      ]);
      for (const id of idents) expect(allowed.has(id), `${name}: ${id}`).toBe(true);
    }
  });
});

describe("who calls what", () => {
  it("chrome.scripting is used in platform/autofill.ts (the injections) and platform/autofill-register.ts (Stage 2's one registration) only", () => {
    expect(all.filter((f) => /chrome\??\.scripting|\.executeScript\b/.test(f.code)).map((f) => f.path)).toEqual([
      "platform/autofill-register.ts",
      "platform/autofill.ts",
    ]);
    expect(all.filter((f) => /\.executeScript\b/.test(f.code)).map((f) => f.path)).toEqual(["platform/autofill.ts"]);
  });
  it("only autofill-register.ts registers the script that runs by itself (AUTOFILL2 patch 3), and nothing uses declarativeContent, webNavigation or tabs events", () => {
    expect(
      all
        .filter((f) => /registerContentScripts|updateContentScripts|unregisterContentScripts/.test(f.code))
        .map((f) => f.path),
    ).toEqual(["platform/autofill-register.ts"]);
    expect(
      all
        .filter((f) => /declarativeContent|webNavigation|chrome\.tabs\.on[A-Z]\w*\.addListener/.test(f.code))
        .map((f) => f.path),
    ).toEqual([]);
  });
  it("the toolbar tooltip is reset with a string Chrome accepts (a null or missing title is refused, an empty one is kept), and every deep visibility test is made again at the fill", () => {
    const c = all.find((f) => f.path === "background/fill-command.ts")!.code;
    expect(c).not.toMatch(/title:\s*(null|undefined)/);
    expect(c).toMatch(/getTitle\(\{\}\)/);
    expect(c).toMatch(/setTitle\(\{\s*tabId,\s*title:\s*back\s*\}\)/);
    const f = fn(all.find((x) => x.path === "inject/otp.ts")!.code, /async function fill\(/);
    // before the write, and the read-backs: one box's, and a group's after whichever strategy kept the code (AF3-2: the
    // strategies are tried in the entry's order, and the one read-back follows the one that worked)
    expect(f.match(/\blook\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(f).toMatch(/return look\(el\) > 0 \? \{ ok: true, how: "single" \}/);
    expect(f).toMatch(/if \(await way\(\)\)\s*return els\.every\(\(e\) => look\(e\) > 0\) \? \{ ok: true, how \}/);
  });
  it("fillCand is called by the popup's Fill chunk and the worker's shortcut only (the chunk's with its rule's minLeft: AF3-3b)", () => {
    expect(
      all
        .filter((f) => /\bfillCand\(/.test(f.code) && f.path !== "platform/autofill.ts")
        .map((f) => f.path)
        .sort(),
    ).toEqual(["background/fill-command.ts", "popup/main/Fill.tsx"]);
  });
  it("neither of them computes a code itself, copies it, stores it or logs it", () => {
    for (const p of ["background/fill-command.ts", "popup/main/Fill.tsx"]) {
      const c = all.find((f) => f.path === p)!.code;
      expect(c, p).not.toMatch(/\bcodeAt\b|\bsecret\b/);
      for (const re of [
        /\bconsole\b/,
        /clipboard|writeText/,
        /\blocalStorage\b|\bsessionStorage\b|storage\.(?:local|session)/,
        /\bsendMessage\b/,
      ])
        none(c, re, `${p}: `);
    }
  });
  it("the Fill chunk looks at a page only for an account that can make a code, and Main loads the chunk only when the list has a registered account", () => {
    const fill = all.find((f) => f.path === "popup/main/Fill.tsx")!.code;
    expect(fill).toMatch(/const any = entries\.some\(canFill\)/);
    expect(fill).not.toMatch(/canGenerate/); // one predicate: platform/autofill.ts canFill
    expect(fill).toMatch(/if \(any\)\s*void lookIfNew\(host\)/);
    expect(fill.match(/\bscan\(/g)).toHaveLength(1); // the one look, in scanPage
    const main = all.find((f) => f.path === "popup/main/Main.tsx")!.code;
    // ... or when this popup's own unlock was made for a pending fill request (AUTOFILL2 patch 1: the chunk then says what it
    // could not fill, even where the list has no account for the page; it looks at the page only for an account, as above)
    expect(main).toMatch(/if \(\(site \|\| resume\) && !fillMod\)\s*void fillView\(\)/);
    expect(main).toMatch(/const site = sections\[0\]\?\.key === "site" \? sections\[0\] : undefined/);
    // a card gets the button only in the "This site" section
    expect(all.find((f) => f.path === "popup/main/List.tsx")!.code).toMatch(
      /s\.key === "site" && p\.rowExtra\?\.\(e, ri\)/,
    );
  });
  it("the finder's file is named in one module, and the finder's source is imported by types only", () => {
    expect(all.filter((f) => f.code.includes("inject/otp")).map((f) => f.path)).toEqual([
      "platform/autofill-register.ts", // the registration's files: the finder, then the content script (AUTOFILL2 patch 3)
      "platform/autofill.ts",
    ]);
    for (const f of all.filter((f) =>
      /from ["']\.\.?\/(?:\.\.\/)*inject\/otp["']/.test(readFileSync(join(SRC, f.path), "utf8")),
    ))
      expect(readFileSync(join(SRC, f.path), "utf8"), f.path).toMatch(
        /import type \{[^}]*\} from ["'][./]+inject\/otp["']/,
      );
  });
  it("no new message type: the shortcut is a command, not a message (the sender policy is unchanged)", () => {
    const sw = all.find((f) => f.path === "background/sw.ts")!.code;
    expect(sw).toMatch(/command === FILL_COMMAND/);
    expect(all.filter((f) => /["'`]sk-fill|["'`]sk-autofill/.test(f.code))).toEqual([]);
  });
});

describe("the manifest", () => {
  const m = JSON.parse(readFileSync(join(EXT, "manifest.base.json"), "utf8")) as Record<string, unknown>;
  it("offers scripting (optional since W1b), and asks for no host access at install and no script of its own", () => {
    expect(m.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "activeTab",
      "alarms",
      "idle",
      "offscreen",
      "sidePanel",
    ]);
    expect(m.optional_permissions).toContain("scripting");
    expect(m.host_permissions).toBeUndefined();
    // (Stage 2 patch 2) https sites, asked for one at a time; the sync API's origin only in a build with the sync user
    // interface, which scripts/build.mjs puts in front of it
    expect(m.optional_host_permissions).toEqual(["https://*/*"]);
    for (const k of [
      "content_scripts",
      "web_accessible_resources",
      "externally_connectable",
      "declarative_net_request",
      "devtools_page",
    ])
      expect(m[k], k).toBeUndefined();
  });
  it("has the fill command with its own key and no global scope", () => {
    expect((m.commands as Record<string, unknown>).fill).toEqual({
      suggested_key: { default: "Alt+Shift+F" },
      description: "__MSG_cmdFill__",
    });
    expect(JSON.stringify(m.commands)).not.toMatch(/global/);
  });
});
