// Which message keys can a page show? Worked out from the syntax tree (TypeScript's parser and checker) of every module
// the page can load, so the popup ships a catalog of only those keys (scripts/build.mjs) while the settings page keeps
// the full one. A key the popup can show but its catalog lacks would appear on screen as its raw name, so every rule
// here errs towards keeping a key, and anything it cannot follow stops the build instead of guessing.
//
// 1. Modules. From each <script type="module" src> of the page, every static import, re-export and import() (lazy
//    chunks), transitively. Only `import type` / `export type` are skipped (erased; with verbatimModuleSyntax any other
//    import stays in the bundle). An import() of a computed specifier fails. Packages (node_modules) are not scanned:
//    they cannot call t(), and a value they hand back cannot be traced (rule 3), so it fails there. A full catalog
//    (_locales/*.json) imported by the page's code fails: the page could load it. CSS and other assets are skipped.
// 2. Mentions, the safe fallback. Every string literal, template text, JSX text and JSX attribute string, every
//    identifier that names an object-literal property, class field or enum member (Object.keys, `for in` and `k in T`
//    turn those into strings), and every string in an imported JSON file, that equals a key, is kept. Without a proof
//    that a mentioned key never reaches the catalog it cannot be called unused, so it stays.
// 3. Lookups. Every read of the catalog (`catalog[key]` in src/ui/i18n.ts, which is t(); any wrapper of t() is just
//    another caller) is traced back: through parameters to every call site and JSX use of their function (and through
//    .map / .forEach ... callbacks to the array's elements), constants, `let` variables nobody reassigns, object and
//    array literals (tables, kind -> key maps), destructuring, conditionals, ?? / || / &&, function return values,
//    Object.keys / values / entries, for-of and for-in. What it ends in:
//      - a string: must be a key (else the page would show that string);
//      - a template literal or a + concatenation: its whole family is kept, every key that matches it with each ${...}
//        (or unknown operand) standing for any run of key characters. A family that matches no key fails, and so does
//        one with no fixed text at all (`${a}${b}` could be any key);
//      - anything it cannot follow (a value from storage, a message, a library, a string method, a function used as a
//        value, a name the checker cannot resolve, a cycle) fails the build, unless `allow` lists that exact expression
//        with the keys or families it can hold.
//    A function's uses are the identifiers with one of its names that resolve to it (or to a symbol it declares, as
//    o.f does for an object's method). Any other identifier of that name the checker cannot resolve, or that could be
//    it (a callable or untyped member of another object, a destructured name, x["name"]), is a use it cannot see: fail
//    closed. A function nothing in the page uses cannot run there, so its lookups need no key.
//    Not seen: writes into a table through another name or inside a function it is passed to.
// 4. An `allow` entry that matched nothing fails, so the list cannot go stale.
// 5. The in-page suggestion's release gate (scripts/suggest-ui.mjs), when the build's is closed (`suggestUi: false`):
//    `SUGGEST_UI && <expression>`, where SUGGEST_UI is a constant of that module declared as the gate is read
//    (typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__; test/unit/suggest-ui-gate.test.ts), is dead code the
//    bundler drops; the expression's mentions and uses are not the page's. Only that form; anything else is read as
//    usual. scripts/build.mjs checks the bundle afterwards: a key the shipped code still names and the catalog lacks
//    fails the build.
// 6. Parts of a page (the settings page's text is in parts, docs/design/notes/BUDGET-NOTES.md): `stop` lists modules the
//    walk does not enter (the parts' entries, for the page's own core), and `part: true` reads the entries as a part's,
//    whose exported components are rendered from outside its graph: a lookup that reaches a parameter of a function an
//    entry exports (directly, or as a member of an object or class it exports) fails, since what the page passes it cannot
//    be seen. `pageCatalogs` names the page's own catalog files (JSON imported by its text loader): text, not code, so
//    neither read nor mentioned.
//
// collectKeys() returns the keys (in catalog order) and the modules it read; it throws CatalogKeysError listing every
// problem. Unit tests: test/unit/i18n-collector.test.ts (fixtures) and test/unit/i18n-popup.test.ts (this tree).
import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

/** What a message key may contain (test/unit/i18n.test.ts holds the catalogs to it). */
const KEY_CHAR = "[A-Za-z0-9_]";
const KEY = /^[A-Za-z0-9_]+$/;
/** The popup imports its catalog as virtual:popup-catalog/<lang> (src/popup/main.tsx); scripts/build.mjs serves it. */
export const POPUP_CATALOG_PREFIX = "virtual:popup-catalog/";

/**
 * Expressions the tracer cannot follow, with what they can hold, for the popup. Each entry: { file (relative to
 * extension/), code (the expression's exact source text, white space collapsed), keys?: string[], families?: string[]
 * (a family is a key pattern where * stands for any run of key characters, e.g. "err*"), why: string }. None are needed
 * today: every lookup in the popup's code traces back to literals.
 */
export const POPUP_ALLOW = [];

export class CatalogKeysError extends Error {
  constructor(problems) {
    super(`catalog keys: ${problems.length} problem(s)\n - ${problems.join("\n - ")}`);
    this.problems = problems;
  }
}

const HOLE = Symbol("any key characters");
const ANY = Symbol("any member");
const ASSET = new Set([
  ".css",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".ico",
  ".wasm",
]);
const CODE = /\.(?:[mc]?[jt]sx?)$/;
/** Callbacks whose first parameter is an element of the array they are called on. */
const ELEMENT_CALLBACKS = new Set([
  "map",
  "forEach",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
]);
/** Array methods whose result holds (some of) the same elements. */
const SAME_ELEMENTS = new Set(["filter", "slice", "reverse", "sort", "toSorted", "toReversed"]);
/** Array methods that return one of the elements. */
const ONE_ELEMENT = new Set(["find", "findLast", "at", "pop", "shift"]);

/** Module script sources of an HTML page, as absolute paths. */
export function moduleEntriesOfHtml(htmlFile) {
  const html = readFileSync(htmlFile, "utf8");
  const out = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) out.push(resolve(dirname(htmlFile), src));
  }
  if (!out.length) throw new CatalogKeysError([`${htmlFile}: no <script type="module" src> to start from`]);
  return out;
}

/** Compiler options of a tsconfig.json (the checker needs the same libs and types as the real typecheck). */
export function tsOptions(tsconfig) {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error)
    throw new CatalogKeysError([`${tsconfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`]);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig), undefined, tsconfig); // types resolve from the tsconfig's folder
  return { ...parsed.options, noEmit: true };
}

/**
 * @param {object} o
 * @param {string} o.root               paths in the results and messages are relative to it
 * @param {string[]} o.entries          module entry files
 * @param {string[]} o.keys             every key of the full catalog
 * @param {string} o.catalogModule      the module that holds the catalog (src/ui/i18n.ts)
 * @param {string} [o.catalogBinding]   the catalog variable's name in it
 * @param {object[]} [o.allow]          see POPUP_ALLOW
 * @param {string[]} [o.catalogImports] specifier prefixes that are the page's own catalog (not code)
 * @param {ts.CompilerOptions} [o.compilerOptions] default: root/tsconfig.json
 * @param {boolean} [o.suggestUi]       the in-page suggestion's release gate; false: rule 5 applies
 */
export function collectKeys(o) {
  const root = resolve(o.root);
  // rule 5: each closed gate's constant name, and the text its declaration must have
  const closedGates = new Map([
    ...(o.suggestUi === false ? [["SUGGEST_UI", squash('typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__')]] : []),
  ]);
  const gateClosed = closedGates.size > 0;
  const keyList = [...o.keys];
  const keySet = new Set(keyList);
  const allow = (o.allow ?? []).map((a) => ({ ...a, code: squash(a.code), used: false }));
  const catalogImports = o.catalogImports ?? [];
  const stop = new Set((o.stop ?? []).map((f) => resolve(root, f)));
  const pageCatalog = o.pageCatalogs ?? (() => false);
  const options = o.compilerOptions ?? tsOptions(resolve(root, "tsconfig.json"));
  const problems = [];
  const rel = (f) => relative(root, f).split(sep).join("/");
  const where = (node) => {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${rel(sf.fileName)}:${line + 1}:${character + 1}`;
  };
  const snippet = (node) => {
    const s = squash(node.getText());
    return s.length > 80 ? s.slice(0, 77) + "..." : s;
  };

  // ---- 1. modules -------------------------------------------------------------------------------------------------
  const files = [];
  const jsonFiles = [];
  const seen = new Set();
  const queue = o.entries.map((e) => resolve(root, e));
  for (const e of queue) if (!existsSync(e)) problems.push(`entry ${rel(e)} does not exist`);
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    files.push(file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, scriptKind(file));
    for (const { spec, node } of importsOf(sf)) {
      const at = () => `${rel(file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
      if (spec === null) {
        problems.push(`${at()}: import() of a computed specifier; the modules it can load cannot be listed`);
        continue;
      }
      if (catalogImports.some((p) => spec.startsWith(p))) continue;
      const r = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
      if (!r) {
        const bare = spec.split("?")[0];
        if (!spec.includes("?") && ASSET.has(extname(bare).toLowerCase())) continue;
        if (extname(bare) === ".json" && existsSync(resolve(dirname(file), bare))) {
          noteJson(resolve(dirname(file), bare), at);
          continue;
        }
        problems.push(`${at()}: cannot resolve ${JSON.stringify(spec)}`);
        continue;
      }
      const target = resolve(r.resolvedFileName);
      if (r.isExternalLibraryImport || target.split(sep).includes("node_modules")) continue;
      if (target.endsWith(".json")) {
        noteJson(target, at);
        continue;
      }
      if (target.endsWith(".d.ts") || !CODE.test(target)) continue;
      if (stop.has(target)) continue; // rule 6: another part's entry
      queue.push(target);
    }
  }
  function noteJson(file, at) {
    if (pageCatalog(file)) return; // rule 6: the page's own catalogs are text
    if (file.split(sep).includes("_locales"))
      problems.push(`${at()}: imports the full catalog ${rel(file)}; the page would load it (use its own catalog)`);
    else jsonFiles.push(file);
  }

  // ---- the checker ------------------------------------------------------------------------------------------------
  const program = ts.createProgram({ rootNames: files, options });
  const checker = program.getTypeChecker();
  const inGraph = new Set(files);
  const sources = files.map((f) => program.getSourceFile(f)).filter(Boolean);
  // rule 6: what a part's entries export (as the symbols their uses resolve to), worked out on first use
  const entryFiles = new Set(o.entries.map((e) => resolve(root, e)));
  let entryExports = null;
  const isEntryExport = (sym) => {
    if (!entryExports) {
      entryExports = new Set();
      for (const sf of sources) {
        if (!entryFiles.has(sf.fileName)) continue;
        const ms = checker.getSymbolAtLocation(sf);
        for (const x of ms ? checker.getExportsOfModule(ms) : []) {
          entryExports.add(x);
          const n = norm(x);
          if (n) entryExports.add(n);
        }
      }
    }
    return !!sym && entryExports.has(sym);
  };
  /** A function a part's entry exports: itself, or a member of an object literal or class it exports (rule 6). */
  const exportedByEntry = (fn, nameNode, sym) => {
    if (!entryFiles.has(fn.getSourceFile().fileName)) return false;
    if (isEntryExport(sym)) return true;
    const d = nameNode.parent;
    if (!(ts.isPropertyAssignment(d) || ts.isMethodDeclaration(d) || ts.isPropertyDeclaration(d))) return false;
    let c = d.parent;
    if (ts.isClassLike(c)) return !!c.name && isEntryExport(norm(checker.getSymbolAtLocation(c.name)));
    while (
      c.parent &&
      (ts.isParenthesizedExpression(c.parent) || ts.isAsExpression(c.parent) || ts.isSatisfiesExpression(c.parent))
    )
      c = c.parent;
    return (
      ts.isVariableDeclaration(c.parent) &&
      ts.isIdentifier(c.parent.name) &&
      isEntryExport(norm(checker.getSymbolAtLocation(c.parent.name)))
    );
  };
  const norm = (s) => {
    if (!s) return s;
    if (s.flags & ts.SymbolFlags.Alias) {
      try {
        s = checker.getAliasedSymbol(s);
      } catch {
        return undefined;
      }
    }
    try {
      return checker.getExportSymbolOfSymbol(s);
    } catch {
      return s;
    }
  };
  const symbolOf = (id) =>
    norm(
      ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(id.parent)
        : checker.getSymbolAtLocation(id),
    );

  // ---- 2. mentions, and an index of every identifier ---------------------------------------------------------------
  const mentioned = new Set();
  const mention = (s) => {
    if (keySet.has(s)) mentioned.add(s);
  };
  const refs = new Map(); // symbol -> identifiers that use it
  const aliasNames = new Map(); // symbol -> names it is imported or exported under
  const unresolved = new Map(); // name -> identifiers the checker gave no symbol
  const byName = new Map(); // name -> every identifier outside types with that text, declarations included
  const isGate = (n) => {
    if (!ts.isIdentifier(n) || !closedGates.has(n.text)) return false;
    const d = checker.getSymbolAtLocation(n)?.valueDeclaration;
    return (
      !!d &&
      ts.isVariableDeclaration(d) &&
      !!d.initializer &&
      (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) !== 0 &&
      d.getSourceFile() === n.getSourceFile() &&
      squash(d.initializer.getText()) === closedGates.get(n.text)
    );
  };
  for (const sf of sources) {
    const visit = (node, inType) => {
      // rule 5: the gate closed, `SUGGEST_UI && x` is the gate alone
      if (
        gateClosed &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        isGate(node.left)
      )
        return visit(node.left, inType);
      const extendsClause =
        ts.isExpressionWithTypeArguments(node) &&
        ts.isHeritageClause(node.parent) &&
        node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        ts.isClassLike(node.parent.parent);
      if (!extendsClause && (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)))
        inType = true;
      // x["name"]: the checker may not tie it to a declaration, so it counts as a use of that name it cannot see
      if (!inType && ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        const n = node.argumentExpression.text;
        (unresolved.get(n) ?? unresolved.set(n, []).get(n)).push(node.argumentExpression);
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) mention(node.text);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) mention(node.text);
      else if (ts.isJsxText(node)) mention(node.text.trim());
      else if (ts.isIdentifier(node)) {
        const p = node.parent;
        if (
          p &&
          p.name === node &&
          (ts.isPropertyAssignment(p) ||
            ts.isShorthandPropertyAssignment(p) ||
            ts.isMethodDeclaration(p) ||
            ts.isPropertyDeclaration(p) ||
            ts.isEnumMember(p) ||
            ts.isGetAccessorDeclaration(p) ||
            ts.isSetAccessorDeclaration(p))
        )
          mention(node.text);
        if (!inType) {
          (byName.get(node.text) ?? byName.set(node.text, []).get(node.text)).push(node);
          indexIdentifier(node);
        }
      }
      ts.forEachChild(node, (c) => visit(c, inType));
    };
    visit(sf, false);
  }
  for (const f of jsonFiles) {
    const walk = (v) => {
      if (typeof v === "string") mention(v);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (mention(k), walk(x));
    };
    try {
      walk(JSON.parse(readFileSync(f, "utf8")));
    } catch {
      problems.push(`${rel(f)}: not valid JSON`);
    }
  }
  function indexIdentifier(id) {
    const p = id.parent;
    if (!p) return;
    if (
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isNamespaceExport(p)
    ) {
      if (p.name === id) {
        const s = norm(checker.getSymbolAtLocation(id));
        if (s) (aliasNames.get(s) ?? aliasNames.set(s, new Set()).get(s)).add(id.text);
      }
      return;
    }
    if (isDeclarationName(id) || ts.isJsxAttribute(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p))
      return;
    if (ts.isBindingElement(p) && p.propertyName === id) return;
    if (ts.isPropertyAssignment(p) && p.name === id) return;
    const s = symbolOf(id);
    if (!s) (unresolved.get(id.text) ?? unresolved.set(id.text, []).get(id.text)).push(id);
    else (refs.get(s) ?? refs.set(s, []).get(s)).push(id);
  }

  // ---- 3. lookups -------------------------------------------------------------------------------------------------
  const memo = new Map();
  const busy = new Map();
  let depth = 0;
  const str = (s, at) => ({ k: "str", s, at });
  const other = { k: "other" };
  function open(why, at) {
    const file = at && rel(at.getSourceFile().fileName);
    const code = at && squash(at.getText());
    const hits = allow.filter((a) => a.file === file && a.code === code);
    if (hits.length) {
      const out = [];
      for (const a of hits) {
        a.used = true;
        for (const k of a.keys ?? []) out.push(str(k, at));
        for (const f of a.families ?? [])
          out.push({
            k: "fam",
            parts: f
              .split("*")
              .flatMap((x, i) => (i ? [HOLE, x] : [x]))
              .filter((x) => x !== ""),
            at,
            allowed: true,
          });
      }
      return out;
    }
    return [{ k: "open", why, at }];
  }
  /** Memoised per (what, node); a value that depends on itself, or a trace deeper than 60 steps, cannot be followed. */
  const once = (what, node, fn) => {
    const m = memo.get(what) ?? memo.set(what, new Map()).get(what);
    if (m.has(node)) return m.get(node);
    const b = busy.get(what) ?? busy.set(what, new Set()).get(what);
    if (b.has(node)) return open("its value depends on itself (a cycle)", node);
    if (depth > 60) return open("the trace is too deep", node);
    b.add(node);
    depth++;
    try {
      const v = fn();
      m.set(node, v);
      return v;
    } finally {
      depth--;
      b.delete(node);
    }
  };

  function ev(node) {
    return once("value", node, () => evNow(node));
  }
  function evNow(n) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [str(n.text, n)];
    if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text];
      for (const span of n.templateSpans) parts.push(HOLE, span.literal.text);
      return [family(parts, n)];
    }
    if (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      ts.isAwaitExpression(n)
    )
      return ev(n.expression);
    if (ts.isConditionalExpression(n)) return [...ev(n.whenTrue), ...ev(n.whenFalse)];
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
        return [...ev(n.left), ...ev(n.right)];
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) return ev(n.right); // && gives the right side or a falsy left one
      if (op === ts.SyntaxKind.PlusToken) return concat(n);
      if (op === ts.SyntaxKind.EqualsToken) return ev(n.right);
      if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)
        return open("a compound assignment", n);
      return [other]; // comparisons, arithmetic, instanceof, in: not strings
    }
    if (
      ts.isNumericLiteral(n) ||
      ts.isBigIntLiteral(n) ||
      ts.isRegularExpressionLiteral(n) ||
      ts.isPrefixUnaryExpression(n) ||
      ts.isPostfixUnaryExpression(n) ||
      ts.isTypeOfExpression(n) ||
      ts.isVoidExpression(n) ||
      ts.isDeleteExpression(n)
    )
      return [other];
    if (
      n.kind === ts.SyntaxKind.TrueKeyword ||
      n.kind === ts.SyntaxKind.FalseKeyword ||
      n.kind === ts.SyntaxKind.NullKeyword
    )
      return [other];
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return [other];
    if (ts.isObjectLiteralExpression(n)) return [{ k: "obj", node: n }];
    if (ts.isArrayLiteralExpression(n)) return [{ k: "arr", node: n }];
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return [{ k: "fn", node: n }];
    if (ts.isIdentifier(n)) return identifier(n);
    if (ts.isPropertyAccessExpression(n))
      return n.name.text === "length" ? [other] : member(ev(n.expression), n.name.text, n);
    if (ts.isElementAccessExpression(n)) return elementAccess(n);
    if (ts.isCallExpression(n)) return call(n);
    return open(`cannot follow ${ts.SyntaxKind[n.kind]}`, n);
  }

  function family(parts, at) {
    const merged = [];
    for (const p of parts) {
      if (p === "") continue;
      if (p !== HOLE && typeof merged.at(-1) === "string") merged[merged.length - 1] += p;
      else if (!(p === HOLE && merged.at(-1) === HOLE)) merged.push(p);
    }
    if (!merged.includes(HOLE)) return str(merged.join(""), at);
    return { k: "fam", parts: merged, at };
  }
  function concat(n) {
    const side = (x) => {
      const v = ev(x);
      const strs = v.filter((y) => y.k === "str");
      const fams = v.filter((y) => y.k === "fam");
      const stringy = strs.length + fams.length > 0;
      if (v.length === 1 && strs.length === 1) return { stringy, parts: [strs[0].s] };
      if (v.length === 1 && fams.length === 1) return { stringy, parts: fams[0].parts };
      return { stringy, parts: [HOLE], opens: v.filter((y) => y.k === "open") };
    };
    const l = side(n.left);
    const r = side(n.right);
    if (!l.stringy && !r.stringy) {
      const opens = [...(l.opens ?? []), ...(r.opens ?? [])];
      return opens.length ? open("a + of values it cannot trace", n) : [other];
    }
    return [family([...l.parts, ...r.parts], n)];
  }

  function identifier(id) {
    if (id.text === "undefined" || id.text === "NaN" || id.text === "Infinity") return [other];
    const s = symbolOf(id);
    if (!s) return open(`the checker cannot resolve ${id.text}`, id);
    const decl = s.valueDeclaration ?? s.declarations?.[0];
    if (!decl) return open(`${id.text} has no declaration`, id);
    if (!inGraph.has(decl.getSourceFile().fileName))
      return open(`${id.text} comes from outside the page's code (${rel(decl.getSourceFile().fileName)})`, id);
    return once("declared", decl, () => declared(decl, s, id));
  }
  function declared(decl, sym, at) {
    if (ts.isVariableDeclaration(decl)) {
      if (!ts.isIdentifier(decl.name)) return open("a destructured declaration", at);
      return variable(decl, sym, at);
    }
    if (ts.isBindingElement(decl)) return binding(decl, at);
    if (ts.isParameter(decl)) return parameter(decl, at);
    if (ts.isFunctionDeclaration(decl)) return [{ k: "fn", node: decl }];
    if (ts.isEnumMember(decl)) return decl.initializer ? ev(decl.initializer) : [other];
    if (ts.isShorthandPropertyAssignment(decl)) return identifier(decl.name);
    return open(`cannot follow a ${ts.SyntaxKind[decl.kind]}`, at);
  }
  /** const, or let / var that nothing reassigns; and the variables of for-of and for-in. */
  function variable(decl, sym, at) {
    const list = decl.parent;
    const loop = list?.parent;
    if (loop && ts.isForOfStatement(loop) && loop.initializer === list) return member(ev(loop.expression), ANY, at);
    if (loop && ts.isForInStatement(loop) && loop.initializer === list) return namesOf(ev(loop.expression), at);
    if (ts.isCatchClause(list)) return open("a caught exception", at);
    const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
    if (!isConst) {
      const assigned = (refs.get(sym) ?? []).find((r) => isWrite(r));
      if (assigned) return open(`${decl.name.text} is reassigned at ${where(assigned)}`, at);
      if (hasUnresolved(sym, decl.name.text)) return open(`cannot see every use of ${decl.name.text}`, at);
    }
    if (!decl.initializer) return open(`${decl.name.text} has no initial value`, at);
    const v = ev(decl.initializer);
    if (!v.some((x) => x.k === "obj" || x.k === "arr")) return v;
    const extra = writesInto(sym, decl.name.text, at);
    return extra.length
      ? v.map((x) => (x.k === "obj" || x.k === "arr" ? { ...x, extra: [...(x.extra ?? []), ...extra] } : x))
      : v;
  }
  /**
   * What is put into a table after it is made, through its own name: T.x = v, T[k] = v, T.push(v), T.unshift(v),
   * T.splice(i, n, v), T.fill(v), Object.assign(T, src). Any of these counts as a member of every name.
   */
  function writesInto(sym, name, at) {
    const out = [];
    for (const r of refs.get(sym) ?? []) {
      let e = r;
      while (ts.isParenthesizedExpression(e.parent) || ts.isNonNullExpression(e.parent) || ts.isAsExpression(e.parent))
        e = e.parent;
      const p = e.parent;
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e) {
        const q = p.parent;
        if (ts.isBinaryExpression(q) && q.left === p && q.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          out.push(...ev(q.right));
        else if (
          ts.isBinaryExpression(q) &&
          q.left === p &&
          q.operatorToken.kind >= ts.SyntaxKind.FirstCompoundAssignment &&
          q.operatorToken.kind <= ts.SyntaxKind.LastCompoundAssignment
        )
          out.push(...open(`${name} gets a compound assignment`, q));
        else if (ts.isPropertyAccessExpression(p) && ts.isCallExpression(q) && q.expression === p) {
          const m = p.name.text;
          const args = q.arguments;
          if (m === "push" || m === "unshift" || m === "fill")
            out.push(...args.flatMap((a) => (ts.isSpreadElement(a) ? member(ev(a.expression), ANY, a) : ev(a))));
          else if (m === "splice")
            out.push(
              ...args.slice(2).flatMap((a) => (ts.isSpreadElement(a) ? member(ev(a.expression), ANY, a) : ev(a))),
            );
          else if (m === "set" || m === "copyWithin") out.push(...open(`${name}.${m}()`, q));
        }
      } else if (
        ts.isCallExpression(p) &&
        p.arguments[0] === e &&
        ts.isPropertyAccessExpression(p.expression) &&
        ts.isIdentifier(p.expression.expression) &&
        p.expression.expression.text === "Object" &&
        p.expression.name.text === "assign"
      ) {
        for (const a of p.arguments.slice(1)) out.push(...member(ev(a), ANY, a));
      }
    }
    if (hasUnresolved(sym, name)) out.push(...open(`cannot see every use of ${name}`, at));
    return out;
  }
  /** A name inside a destructuring pattern: the value it is taken from, then the path into it. */
  function binding(be, at) {
    const path = [];
    let node = be;
    while (ts.isBindingElement(node)) {
      const pattern = node.parent;
      if (node.dotDotDotToken) path.unshift(ts.isArrayBindingPattern(pattern) ? ANY : null);
      else if (ts.isArrayBindingPattern(pattern)) path.unshift(pattern.elements.indexOf(node));
      else {
        const name = node.propertyName ?? node.name;
        path.unshift(ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : ANY);
      }
      node = pattern.parent;
    }
    let v;
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const loop = list?.parent;
      if (loop && ts.isForOfStatement(loop) && loop.initializer === list) v = member(ev(loop.expression), ANY, at);
      else if (node.initializer) v = ev(node.initializer);
      else return open("a destructured declaration without a value", at);
    } else if (ts.isParameter(node)) v = parameter(node, at);
    else return open("a destructuring it cannot follow", at);
    for (const step of path) v = step === null ? v : member(v, step, at); // an object rest keeps the remaining members
    return be.initializer ? [...v, ...ev(be.initializer)] : v;
  }
  function parameter(param, at) {
    return once("parameter", param, () => {
      if (param.dotDotDotToken) return open("a rest parameter", at);
      const fn = param.parent;
      const i = fn.parameters.indexOf(param);
      const out = param.initializer ? [...ev(param.initializer)] : [];
      const uses = usesOf(fn);
      if (uses.open) return [...out, ...open(uses.open, param)];
      if (uses.callbackOf) {
        if (i === 0) out.push(...member(ev(uses.callbackOf), ANY, at));
        else if (i === 2) out.push(...ev(uses.callbackOf));
        else out.push(other);
        return out;
      }
      for (const c of uses.calls) {
        const args = c.arguments;
        if (args.slice(0, i + 1).some((a) => ts.isSpreadElement(a))) out.push(...open("a spread argument", c));
        else if (args[i]) out.push(...ev(args[i]));
        else out.push(other);
      }
      for (const attrs of uses.jsx) out.push(i === 0 ? { k: "jsx", node: attrs } : other);
      return out;
    });
  }
  /** Where a function is called from: the calls and JSX elements that use it, or why that cannot be known. */
  function usesOf(fn) {
    let p = fn.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p))) p = p.parent;
    if (p && ts.isCallExpression(p) && p.arguments.some((a) => skipOuter(a) === fn)) {
      const callee = p.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ELEMENT_CALLBACKS.has(callee.name.text) &&
        skipOuter(p.arguments[0]) === fn
      )
        return { callbackOf: callee.expression };
      return { open: `a callback passed to ${snippet(callee)}` };
    }
    let nameNode;
    if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) nameNode = fn.name;
    else if (p && ts.isVariableDeclaration(p) && skipOuter(p.initializer) === fn) nameNode = p.name;
    else if (p && ts.isPropertyAssignment(p) && skipOuter(p.initializer) === fn) nameNode = p.name;
    if (!nameNode || !ts.isIdentifier(nameNode)) return { open: "a function without a name it can look up" };
    const sym = norm(checker.getSymbolAtLocation(nameNode));
    if (!sym) return { open: `the checker cannot resolve ${nameNode.text}` };
    const name = nameNode.text;
    if (o.part && exportedByEntry(fn, nameNode, sym))
      return {
        open: `${name} is exported by the part's entry ${rel(fn.getSourceFile().fileName)} and drawn from outside the part: what it is passed cannot be seen (rule 6)`,
      };
    if (hasUnresolved(sym, name))
      return { open: `cannot see every use of ${name} (${unresolvedOf(sym, name).map(where).join(", ")})` };
    // Its uses: every identifier with one of its names that resolves to it, or to a symbol declared by it (the checker
    // gives o.f a symbol of its own for an object literal's member). One that could be it but resolves elsewhere (a
    // member of a typed object, a destructured name, any callable or untyped lookalike) is a use it cannot see.
    const declNode = nameNode.parent;
    const isIt = (s) => !!s && (s === sym || (s.declarations ?? []).some((d) => d === declNode || d === fn));
    const calls = [];
    const jsx = [];
    for (const n of namesFor(sym, name)) {
      for (const id of byName.get(n) ?? []) {
        if (id === nameNode) continue;
        const p = id.parent;
        if (
          ts.isImportSpecifier(p) ||
          ts.isExportSpecifier(p) ||
          ts.isImportClause(p) ||
          ts.isNamespaceImport(p) ||
          ts.isNamespaceExport(p)
        )
          continue; // its uses are under that name
        if (ts.isBindingElement(p) && (p.propertyName === id || (p.name === id && !p.propertyName))) {
          if (callableOrUnknown(id)) return { open: `${name} may be taken out of an object at ${where(id)}` };
          continue;
        }
        if (
          isDeclarationName(id) ||
          ts.isJsxAttribute(p) ||
          (ts.isPropertyAssignment(p) && p.name === id) ||
          ts.isLabeledStatement(p) ||
          ts.isBreakOrContinueStatement(p)
        )
          continue; // another thing of the same name
        const s = symbolOf(id);
        if (!isIt(s)) {
          const propertyLike =
            (ts.isPropertyAccessExpression(p) && p.name === id) ||
            (!!s && (s.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Accessor)) !== 0);
          if (!s || (propertyLike && callableOrUnknown(id)))
            return { open: `cannot see every use of ${name}: ${where(id)} may be it` };
          continue;
        }
        const e = ts.isPropertyAccessExpression(p) && p.name === id ? p : id;
        const q = e.parent;
        if (ts.isCallExpression(q) && q.expression === e) calls.push(q);
        else if ((ts.isJsxOpeningElement(q) || ts.isJsxSelfClosingElement(q)) && q.tagName === e)
          jsx.push(q.attributes);
        else if (ts.isJsxClosingElement(q)) continue;
        else return { open: `${name} is used as a value at ${where(id)}` };
      }
    }
    return { calls, jsx };
  }
  /** Whether a name's value could be a function: callable, or a type the checker cannot vouch for. */
  function callableOrUnknown(id) {
    let type;
    try {
      type = checker.getTypeAtLocation(id);
    } catch {
      return true;
    }
    const parts = type.isUnion() ? type.types : [type];
    return parts.some(
      (x) =>
        (x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
        x.getCallSignatures().length > 0 ||
        x.getConstructSignatures().length > 0,
    );
  }
  const skipOuter = (n) => {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)))
      n = n.expression;
    return n;
  };
  const namesFor = (sym, name) => new Set([name, sym.name, ...(aliasNames.get(sym) ?? [])]);
  const unresolvedOf = (sym, name) => [...namesFor(sym, name)].flatMap((n) => unresolved.get(n) ?? []);
  const hasUnresolved = (sym, name) => unresolvedOf(sym, name).length > 0;
  function isWrite(id) {
    let e = id;
    while (ts.isParenthesizedExpression(e.parent)) e = e.parent;
    const p = e.parent;
    if (
      ts.isBinaryExpression(p) &&
      p.left === e &&
      p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      return true;
    if (
      (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return true;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === e) return true;
    return ts.isArrayLiteralExpression(p) || ts.isShorthandPropertyAssignment(p) ? isDestructuringTarget(p) : false;
  }
  function isDestructuringTarget(n) {
    let e = n;
    while (
      e.parent &&
      (ts.isArrayLiteralExpression(e.parent) ||
        ts.isObjectLiteralExpression(e.parent) ||
        ts.isPropertyAssignment(e.parent) ||
        ts.isShorthandPropertyAssignment(e.parent) ||
        ts.isSpreadElement(e.parent) ||
        ts.isSpreadAssignment(e.parent))
    )
      e = e.parent;
    return (
      !!e.parent &&
      ts.isBinaryExpression(e.parent) &&
      e.parent.left === e &&
      e.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    );
  }

  function elementAccess(n) {
    const a = n.argumentExpression;
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return member(ev(n.expression), a.text, n);
    if (ts.isNumericLiteral(a)) return member(ev(n.expression), Number(a.text), n);
    return member(ev(n.expression), ANY, n);
  }
  /** A member of each value: a property of an object literal, an element of an array literal, a JSX attribute. */
  function member(vals, name, at) {
    const out = [];
    for (const v of vals) {
      if (v.k === "open")
        out.push(...(at && at !== v.at ? open(v.why, at) : [v])); // anchored at the access: what an allowlist entry names
      else if (v.k === "obj") out.push(...objectMember(v.node, name, at), ...(v.extra ?? []));
      else if (v.k === "arr")
        out.push(...arrayMember(v.node, name, at), ...(typeof name === "string" ? [] : (v.extra ?? [])));
      else if (v.k === "jsx") out.push(...jsxMember(v.node, name, at));
      else if (v.k === "list") out.push(...(typeof name === "string" ? [other] : v.items));
      else if (v.k === "tuple")
        out.push(...(name === ANY ? v.items.flat() : typeof name === "number" ? (v.items[name] ?? [other]) : [other]));
      else out.push(other); // a member of a string, a number, a function: never a key here
    }
    return out;
  }
  function objectMember(obj, name, at) {
    const out = [];
    let found = false;
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        out.push(...member(ev(p.expression), name, at));
        found = true;
        continue;
      }
      const pn = p.name;
      let names;
      if (ts.isComputedPropertyName(pn)) {
        const v = ev(pn.expression);
        names = v.every((x) => x.k === "str") ? v.map((x) => x.s) : ANY;
      } else names = [pn.text];
      if (name !== ANY && names !== ANY && !names.includes(String(name))) continue;
      found = true;
      if (ts.isPropertyAssignment(p)) out.push(...ev(p.initializer));
      else if (ts.isShorthandPropertyAssignment(p)) out.push(...identifier(p.name));
      else if (ts.isMethodDeclaration(p)) out.push({ k: "fn", node: p });
      else out.push(...open("an accessor", p));
    }
    if (!found) out.push(other); // no such property: undefined
    return out;
  }
  function arrayMember(arr, name, at) {
    const els = arr.elements;
    const all = () =>
      els.flatMap((e) =>
        ts.isSpreadElement(e) ? member(ev(e.expression), ANY, at) : ts.isOmittedExpression(e) ? [other] : ev(e),
      );
    if (name === ANY) return all();
    if (typeof name === "number") {
      if (els.slice(0, name + 1).some((e) => ts.isSpreadElement(e))) return all();
      const e = els[name];
      return !e || ts.isOmittedExpression(e) ? [other] : ev(e);
    }
    return [other]; // .length, methods
  }
  function jsxMember(attrs, name, at) {
    const out = [];
    let found = false;
    for (const a of attrs.properties) {
      if (ts.isJsxSpreadAttribute(a)) {
        out.push(...member(ev(a.expression), name, at));
        found = true;
        continue;
      }
      if (name !== ANY && a.name.getText() !== name) continue;
      found = true;
      if (!a.initializer) out.push(other);
      else if (ts.isStringLiteral(a.initializer)) out.push(str(a.initializer.text, a.initializer));
      else if (ts.isJsxExpression(a.initializer))
        out.push(...(a.initializer.expression ? ev(a.initializer.expression) : [other]));
      else out.push(other);
    }
    if (name === "children" || name === ANY) {
      const el = attrs.parent;
      if (ts.isJsxOpeningElement(el) && el.parent.children.length) return [...out, ...open("JSX children", el)];
    }
    if (!found) out.push(other);
    return out;
  }
  /** The property names of each object literal (Object.keys, for-in). */
  function namesOf(vals, at) {
    const out = [];
    for (const v of vals) {
      if (v.k === "open") out.push(v);
      else if (v.k === "obj") {
        if (v.extra?.length) out.push(...open("the names of a table that is written to later", at));
        for (const p of v.node.properties) {
          if (ts.isSpreadAssignment(p)) out.push(...namesOf(ev(p.expression), at));
          else if (ts.isComputedPropertyName(p.name)) out.push(...ev(p.name.expression));
          else out.push(str(p.name.text, p.name));
        }
      } else if (v.k === "jsx") out.push(...open("the names of JSX attributes", at));
      else out.push(other); // array indices, or nothing
    }
    return out;
  }

  function call(n) {
    const callee = skipOuter(n.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return [other];
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      const target = callee.expression;
      if (
        ts.isIdentifier(target) &&
        target.text === "Object" &&
        ["keys", "values", "entries"].includes(m) &&
        !inGraphSymbol(target)
      ) {
        const arg = n.arguments[0];
        if (!arg) return [other];
        const v = ev(arg);
        if (m === "keys") return [{ k: "list", items: namesOf(v, n) }];
        if (m === "values") return [{ k: "list", items: member(v, ANY, n) }];
        return [{ k: "list", items: [{ k: "tuple", items: [namesOf(v, n), member(v, ANY, n)] }] }];
      }
      const base = ev(target);
      if (base.length && base.every((b) => b.k === "arr" || b.k === "list" || b.k === "tuple")) {
        if (SAME_ELEMENTS.has(m)) return base;
        if (ONE_ELEMENT.has(m)) return member(base, ANY, n);
        if (m === "concat") return [...base, ...n.arguments.flatMap((a) => ev(a))];
        if ((m === "map" || m === "flatMap") && n.arguments[0]) {
          const items = ev(n.arguments[0]).flatMap((f) =>
            f.k === "fn" ? returns(f.node) : open("a callback it cannot follow", n.arguments[0]),
          );
          return [{ k: "list", items: m === "flatMap" ? [...items, ...member(items, ANY, n)] : items }];
        }
        return open(`the result of .${m}()`, n);
      }
      if (base.some((b) => b.k === "str" || b.k === "fam")) return open(`a string built by .${m}()`, n);
      const fns = member(base, m, callee);
      return fns.flatMap((f) =>
        f.k === "fn" ? returns(f.node) : open(f.k === "open" ? f.why : `a call of ${snippet(callee)}`, n),
      );
    }
    const fns = ev(callee);
    return fns.flatMap((f) =>
      f.k === "fn" ? returns(f.node) : open(f.k === "open" ? f.why : `a call of ${snippet(callee)}`, n),
    );
  }
  function inGraphSymbol(id) {
    const d = symbolOf(id)?.valueDeclaration;
    return !!d && inGraph.has(d.getSourceFile().fileName);
  }
  function returns(fn) {
    return once("returns", fn, () => {
      if (!fn.body) return open("a function without a body", fn);
      if (!ts.isBlock(fn.body)) return ev(fn.body);
      const out = [];
      const visit = (n) => {
        if (n !== fn.body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
        if (ts.isReturnStatement(n)) out.push(...(n.expression ? ev(n.expression) : [other]));
        ts.forEachChild(n, visit);
      };
      visit(fn.body);
      return out.length ? out : [other];
    });
  }

  // The catalog and its reads.
  const catalogFile = resolve(root, o.catalogModule);
  const catalogName = o.catalogBinding ?? "catalog";
  const lookups = [];
  const catalogSf = sources.find((s) => s.fileName === catalogFile);
  if (!catalogSf) problems.push(`${rel(catalogFile)} (the catalog's module) is not among the page's modules`);
  else {
    let decl;
    for (const st of catalogSf.statements)
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === catalogName) decl = d;
    if (!decl) problems.push(`${rel(catalogFile)}: no top-level variable ${catalogName}`);
    else {
      const sym = norm(checker.getSymbolAtLocation(decl.name));
      if (hasUnresolved(sym, catalogName)) problems.push(`${rel(catalogFile)}: cannot see every use of ${catalogName}`);
      for (const r of refs.get(sym) ?? []) {
        const p = r.parent;
        if (ts.isElementAccessExpression(p) && p.expression === r) lookups.push(p.argumentExpression);
        else if (ts.isBinaryExpression(p) && p.left === r && p.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          continue;
        else
          problems.push(
            `${where(r)}: the catalog is used in a way this collector cannot follow (only ${catalogName}[key] reads and ${catalogName} = ... writes)`,
          );
      }
      if (!lookups.length) problems.push(`${rel(catalogFile)}: no read of ${catalogName}[key] found`);
    }
  }

  const traced = new Set();
  const families = [];
  for (const k of lookups) {
    for (const v of ev(k)) {
      if (v.k === "str") {
        if (keySet.has(v.s)) traced.add(v.s);
        else problems.push(`${where(v.at)}: ${JSON.stringify(v.s)} reaches the catalog but is not a message key`);
      } else if (v.k === "fam") {
        const fixed = v.parts.filter((p) => p !== HOLE).join("");
        const shown = v.parts.map((p) => (p === HOLE ? "*" : p)).join("");
        if (!fixed) {
          problems.push(
            `${where(v.at)}: ${snippet(v.at)} could be any key; use literal keys, or list it in the allowlist with its keys`,
          );
          continue;
        }
        const re = new RegExp("^" + v.parts.map((p) => (p === HOLE ? `${KEY_CHAR}*` : escapeRe(p))).join("") + "$");
        const hit = keyList.filter((k) => re.test(k));
        if (!hit.length) problems.push(`${where(v.at)}: ${snippet(v.at)} (keys like ${shown}) matches no message key`);
        for (const h of hit) traced.add(h);
        families.push({ at: where(v.at), pattern: shown, keys: hit });
      } else if (v.k === "open")
        problems.push(`${where(v.at)}: cannot tell which message keys ${snippet(v.at)} can hold: ${v.why}`);
      else if (v.k !== "other")
        problems.push(`${where(k)}: a ${v.k === "fn" ? "function" : "non-string value"} can reach the catalog`);
    }
  }
  for (const a of allow)
    if (!a.used) problems.push(`allowlist entry ${a.file}: ${JSON.stringify(a.code)} matched nothing (remove it)`);
  for (const a of allow)
    for (const k of a.keys ?? [])
      if (!keySet.has(k)) problems.push(`allowlist entry ${a.file}: ${k} is not a message key`);

  if (problems.length) throw new CatalogKeysError([...new Set(problems)]);
  const keep = new Set([...mentioned, ...traced]);
  return {
    keys: keyList.filter((k) => keep.has(k)),
    modules: files.map(rel).sort(),
    lookups: lookups.length,
    traced: keyList.filter((k) => traced.has(k)),
    mentioned: keyList.filter((k) => mentioned.has(k)),
    families,
  };
}

function scriptKind(file) {
  return file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.[mc]?js$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
}
/** Static imports, re-exports and import() calls; spec is null for an import() whose specifier is not a literal. */
function importsOf(sf) {
  const out = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) {
      if (!n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier))
        out.push({ spec: n.moduleSpecifier.text, node: n });
    } else if (ts.isExportDeclaration(n)) {
      if (!n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier))
        out.push({ spec: n.moduleSpecifier.text, node: n });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (!n.isTypeOnly) out.push({ spec: ts.isStringLiteral(e) ? e.text : null, node: n });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      out.push({
        spec: a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null,
        node: n,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
function isDeclarationName(id) {
  const p = id.parent;
  if (!p || p.name !== id) return false;
  return (
    ts.isVariableDeclaration(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isParameter(p) ||
    ts.isBindingElement(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isClassDeclaration(p) ||
    ts.isClassExpression(p) ||
    ts.isEnumMember(p) ||
    ts.isEnumDeclaration(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodSignature(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isTypeParameterDeclaration(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) ||
    ts.isModuleDeclaration(p)
  );
}
const squash = (s) => String(s).replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A catalog with only `keys`, in the catalog's own order; throws if one of them has no text. */
export function subsetCatalog(catalog, keys, lang = "?") {
  const want = new Set(keys);
  const out = {};
  for (const [k, v] of Object.entries(catalog)) if (want.has(k)) out[k] = v;
  const missing = keys.filter((k) => !Object.hasOwn(out, k));
  if (missing.length) throw new CatalogKeysError([`${lang}: no text for ${missing.join(", ")}`]);
  return out;
}

/** The languages in _locales, and each one's full catalog. */
export function readCatalogs(root) {
  const dir = resolve(root, "_locales");
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((lang) => [lang, JSON.parse(readFileSync(resolve(dir, lang, "messages.json"), "utf8"))]),
  );
}

/** The keys of the full catalogs, which every language must have the same of (scripts/messages.py also checks). */
function fullKeys(catalogs) {
  const langs = Object.keys(catalogs);
  const first = Object.keys(catalogs[langs[0]]);
  for (const l of langs) {
    const ks = Object.keys(catalogs[l]);
    if (ks.length !== first.length || ks.some((k) => !Object.hasOwn(catalogs[langs[0]], k)))
      throw new CatalogKeysError([
        `_locales/${l} and _locales/${langs[0]} have different keys; run python3 scripts/messages.py`,
      ]);
  }
  if (first.some((k) => !KEY.test(k))) throw new CatalogKeysError(["a catalog key is not a valid chrome.i18n name"]);
  return first;
}

/**
 * The pages that draw the popup's screens and load its catalog: the toolbar popup and the side panel, which reuses them
 * (docs/design/notes/SIDEPANEL-NOTES.md). The catalog holds the keys of both, so a key only the panel's own code uses
 * is counted in the popup's budget too; scripts/build.mjs checks both pages' graphs against it.
 */
/** The Fill button's catalog files (scripts/messages.py AUTOFILL_EN / AUTOFILL_ZH): imported by src/popup/main/fill-text.ts only. */
const AUTOFILL_CATALOG = /[\\/]catalogs[\\/]autofill-[A-Za-z_]+\.json$/;
/** The device unlock's catalog files (scripts/messages.py DEVICE_EN / DEVICE_ZH): imported by src/ui/device-text.ts only. */
const DEVICE_CATALOG = /[\\/]catalogs[\\/]device-[A-Za-z_]+\.json$/;
/** The PIN record's catalog files (scripts/messages.py RESTART): imported by src/ui/restart-text.ts only. */
const RESTART_CATALOG = /[\\/]catalogs[\\/]restart-[A-Za-z_]+\.json$/;
/** The backup in Chrome sync's popup catalog files (scripts/messages.py CSB_POPUP): imported by src/ui/csb-popup-text.ts only. */
const CSB_POPUP_CATALOG = /[\\/]catalogs[\\/]csb-popup-[A-Za-z_]+\.json$/;
/** The autofill switch's catalog files (scripts/messages.py PLUGINS): imported by src/ui/plugins/text.ts only. */
const PLUGINS_CATALOG = /[\\/]catalogs[\\/]plugins-[A-Za-z_]+\.json$/;
export const POPUP_PAGES = ["src/popup/index.html", "src/sidepanel/index.html"];

/**
 * The popup's View menu (docs/design/notes/QUICKVIEW-NOTES.md): a module the popup loads when the menu opens, with its
 * text in a catalog of its own (catalogs/view-<lang>.json, scripts/messages.py VIEW), loaded with it and merged over
 * the popup's. The popup's walk does not enter it (rule 6, as the settings page's parts), so its keys are not in the
 * counted popup catalog; viewKeys works out what it can show. No other module imports it except through import().
 */
export const VIEW_ENTRIES = ["src/popup/main/View.tsx"];
export const VIEW_CATALOG_FILE = /[\\/]catalogs[\\/]view-([A-Za-z_]+)\.json(?:\?.*)?$/;

/**
 * The popup's keys in this tree: the modules of POPUP_PAGES, the catalog read in src/ui/i18n.ts, POPUP_ALLOW.
 * Every language must have the same keys (scripts/messages.py also checks). `o.suggestUi`: the in-page suggestion's
 * release gate (rule 5; open unless it is false).
 */
export function popupKeys(root, catalogs = readCatalogs(root), o = {}) {
  const first = fullKeys(catalogs);
  return collectKeys({
    root,
    entries: POPUP_PAGES.flatMap((page) => moduleEntriesOfHtml(resolve(root, page))),
    keys: first,
    ...(o.suggestUi === false ? { suggestUi: false } : {}),
    catalogModule: "src/ui/i18n.ts",
    catalogBinding: "catalog",
    allow: POPUP_ALLOW,
    catalogImports: [POPUP_CATALOG_PREFIX],
    // the Fill button's, the device unlock's and the PIN record's own catalogs
    // (src/popup/main/fill-text.ts, src/ui/device-text.ts, src/ui/restart-text.ts): text, loaded with
    // their lazy chunks, not the popup's keys
    pageCatalogs: (f) =>
      AUTOFILL_CATALOG.test(f) ||
      DEVICE_CATALOG.test(f) ||
      RESTART_CATALOG.test(f) ||
      CSB_POPUP_CATALOG.test(f) ||
      PLUGINS_CATALOG.test(f),
    stop: VIEW_ENTRIES, // rule 6: loaded when the View menu opens, with a catalog of its own (viewKeys)
  });
}

/**
 * The keys the View menu can show, in this tree (rule 6, as a settings part): from its own module, whose exported
 * functions are called from outside its graph. The catalogs/ files it imports are text, not code. `o.suggestUi`: rule 5.
 */
export function viewKeys(root, catalogs = readCatalogs(root), o = {}) {
  const own = resolve(root, "catalogs") + sep;
  return collectKeys({
    root,
    entries: VIEW_ENTRIES,
    keys: fullKeys(catalogs),
    ...(o.suggestUi === false ? { suggestUi: false } : {}),
    catalogModule: "src/ui/i18n.ts",
    catalogBinding: "catalog",
    catalogImports: [POPUP_CATALOG_PREFIX],
    pageCatalogs: (f) => f.startsWith(own),
    part: true,
  });
}

/**
 * The settings page's text parts (docs/design/notes/BUDGET-NOTES.md): each part's entry modules. A part's text is a catalog
 * of its own, catalogs/settings-<part>-<lang>.json (scripts/messages.py writes it from the fragments' PARTS tables),
 * loaded before the part is drawn (src/options/parts.tsx); "core" is the rest of the page (its entry, without these
 * modules: the frame, the rail, the words every part shares), loaded before anything is drawn. A part's entries are
 * drawn only through parts.tsx, and no part imports another's entry (test/unit/budget-split.test.ts).
 */
export const SETTINGS_PARTS = {
  security: ["src/options/Security.tsx"],
  accounts: ["src/options/AddAccounts.tsx"],
  backup: ["src/options/Backup.tsx", "src/options/Groups.tsx"],
  misc: ["src/options/Misc.tsx"],
  general: ["src/options/Appearance.tsx"],
  firstrun: ["src/options/FirstRun.tsx"],
  unlock: ["src/options/UnlockBar.tsx", "src/options/Reset.tsx"],
};

/**
 * Which keys each part of the settings page can show, in this tree (rule 6): `core` from the page's entry with every
 * part's entries left out, and each part from its own entries. The settings catalogs (catalogs/settings-*.json) are the
 * page's own text, not code. `o.suggestUi`: the in-page suggestion's release gate (rule 5).
 */
export function settingsKeys(root, catalogs = readCatalogs(root), o = {}) {
  const keys = fullKeys(catalogs);
  const own = resolve(root, "catalogs") + sep;
  const common = {
    root,
    keys,
    catalogModule: "src/ui/i18n.ts",
    catalogBinding: "catalog",
    pageCatalogs: (f) => f.startsWith(own),
    ...(o.suggestUi === false ? { suggestUi: false } : {}),
  };
  const core = collectKeys({
    ...common,
    entries: moduleEntriesOfHtml(resolve(root, "src/options/index.html")),
    stop: Object.values(SETTINGS_PARTS).flat(),
  });
  const parts = Object.fromEntries(
    Object.entries(SETTINGS_PARTS).map(([name, entries]) => [name, collectKeys({ ...common, entries, part: true })]),
  );
  return { core, parts };
}

if (isAbsolute(process.argv[1] ?? "") && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
  if (process.argv.includes("--settings")) {
    // node scripts/catalog-keys.mjs --settings: where the settings page's code uses each key, and so the part to place it
    // in (scripts/i18n/<fragment>.py PARTS): core when the page's frame or two or more parts use it
    const { core, parts } = settingsKeys(root);
    const users = new Map();
    for (const k of core.keys) users.set(k, ["core"]);
    for (const [name, r] of Object.entries(parts))
      for (const k of r.keys) users.set(k, [...(users.get(k) ?? []), name]);
    for (const [k, u] of users)
      console.log(`${k}: ${u.length === 1 ? u[0] : "core"}${u.length > 1 ? ` (${u.join(", ")})` : ""}`);
    process.exit(0);
  }
  // node scripts/catalog-keys.mjs: print what the popup keeps
  const r = popupKeys(root);
  console.log(
    `${r.keys.length} keys (${r.traced.length} traced from ${r.lookups} catalog read(s), ${r.mentioned.length} mentioned) from ${r.modules.length} modules`,
  );
  for (const f of r.families) console.log(`family ${f.pattern} at ${f.at}: ${f.keys.join(", ")}`);
  if (process.argv.includes("--keys")) console.log(r.keys.join("\n"));
}
