// Where the grant store's text and code can load (scripts/check-dist.mjs), read from the built files alone. One catalog
// since the plugin platform was removed: the autofill switch's (plugins), one text chunk per language, which the
// settings page reaches through its lazy chunks and the popup and the side panel never do; and no page's static graph
// holds the grant store or a port. A page's reach: its own scripts (script src, modulepreload href), then every chunk a
// reached chunk imports statically, or names at all (a dynamic import, a preload list, a string). Kept apart from
// check-dist.mjs so that a test holds it to small builds made up for it (test/unit/check-dist-plugin-pages.test.ts)
// without building Sixkey. A kind may also name the one view (`from`) whose chunks alone may name its text, as the
// change list's did while the platform was there.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const SETTINGS_PAGE = ["options/index.html"];
export const POPUP_PAGES = ["popup/index.html", "sidepanel/index.html"];
/** The kinds of text held here: the pages each is for, and the pages that must never reach it. */
export const PLUGIN_TEXT_KINDS = [{ name: "plugins", pages: SETTINGS_PAGE, not: POPUP_PAGES }];

/**
 * What is wrong with where the plugin platform can load in the build at `dist`, one line each (check-dist's fail()).
 * `textsOf`: each kind's text chunks, by file name in assets/ (one per language).
 */
export function pluginPageProblems(dist, textsOf, kinds = PLUGIN_TEXT_KINDS) {
  const problems = [];
  const js = readdirSync(resolve(dist, "assets")).filter((n) => n.endsWith(".js"));
  const at = (n) => resolve(dist, "assets", n);
  const pageScripts = (page) => {
    const html = resolve(dist, page);
    if (!existsSync(html)) return null;
    return [...readFileSync(html, "utf8").matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js)"/g)]
      .map((x) => x[1])
      .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
      .map((u) => resolve(dirname(html), u));
  };
  const walk = (start, follow) => {
    const seen = new Set();
    const todo = [...start];
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      todo.push(...follow(f, readFileSync(f, "utf8")));
    }
    return seen;
  };
  const staticOf = (f, text) =>
    [...text.matchAll(/\b(?:import|export)\s*(?:[\w$*{][^"';]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)].map((m) =>
      resolve(dirname(f), m[1]),
    );
  const reachOf = (_, text) => js.filter((n) => text.includes(n)).map(at);
  // a kind loaded by one view only (`from`): every chunk that names its text is that view's, and none of that view's
  // chunks is in a page's static graph (checked with the pages below)
  for (const kind of kinds) {
    if (!kind.from) continue;
    const views = js.filter((n) => n.startsWith(kind.from));
    if (!views.length) problems.push(`no ${kind.from}*.js chunk: the view that loads the ${kind.name} text`);
    for (const n of textsOf.get(kind.name) ?? [])
      for (const f of js)
        if (f !== n && !f.startsWith(kind.from) && readFileSync(at(f), "utf8").includes(n))
          problems.push(`${f} names ${n}; only the view ${kind.from}*.js loads the ${kind.name} text`);
  }
  for (const page of [...POPUP_PAGES, ...SETTINGS_PAGE]) {
    const refs = pageScripts(page);
    if (!refs) continue;
    const statics = walk(refs, staticOf);
    const reach = walk(refs, reachOf);
    for (const kind of kinds)
      for (const n of textsOf.get(kind.name) ?? []) {
        if (statics.has(at(n)))
          problems.push(`${page} loads ${n} statically; the plugins' text loads with their lazy chunks`);
        if (kind.pages.includes(page) && !reach.has(at(n)))
          problems.push(`${page} cannot load ${n} (the plugins' entries)`);
        // the other kind of page's words are never this page's: what a vault's page can hold is counted above (W2a)
        if (kind.not.includes(page) && reach.has(at(n)))
          problems.push(`${page} can load ${n}, another kind of page's plugin text`);
      }
    for (const kind of kinds)
      if (kind.from)
        for (const f of statics)
          if (basename(f).startsWith(kind.from))
            problems.push(`${page} loads ${basename(f)} statically; the change list's view loads lazily`);
    for (const f of statics) {
      const text = readFileSync(f, "utf8");
      if (text.includes("sk_plugins_overlay") || /\bruntime\.connect\(/.test(text))
        problems.push(`${page} loads the plugin platform statically (${basename(f)}); it loads lazily`);
    }
  }
  return problems;
}
