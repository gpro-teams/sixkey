// M5's rules about the source (SYNC-DESIGN §4.9, §7) that still hold since the server sync's client went (OWNER-DECISIONS/25,
// DV-0b): what holds by construction, so that no run-time test would notice a new line breaking it. Comments are not code.
//   - `fetch` in exactly the allowed places: the read of the extension's own package file (TOTP autofill Stage 3,
//     platform/package-data.ts: no network) and the site rules' updater's one read (behind its release gate); the sync
//     transport, the one other, went with its client (the Google Drive backup's Google transport with that path's code);
//   - every context builds its runtime the one way (the worker's no longer differs: its sync rounds went);
//   - no API origin anywhere: not in the build script, the check, the manifests or the source;
//   - check-dist's enrolment fingerprints are in no source (else its gate would prove nothing about the history);
//   - the developer sync page is gone, and nothing names it;
//   - host permissions are asked for, checked and removed in platform/autofill-sites.ts (TOTP autofill Stage 2, patch 2)
//     and its switch's module only, always one site's own pattern (the API's permission module went with the client).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cspOf } from "../../scripts/csp.mjs";

const EXT = resolve(__dirname, "../..");
const ROOT = join(EXT, "src");
function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|html)$/.test(n) ? [p] : [];
  });
}
const files = sources().map((p) => ({ path: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const ts = files.filter((f) => !f.path.endsWith(".html"));
const importers = (re: RegExp) =>
  ts
    .filter((f) => [...code(f.text).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].some((m) => re.test(m[1]!)))
    .map((f) => f.path)
    .sort();
const checkDist = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");

describe("M5 source rules", () => {
  it("`fetch` in exactly the allowed places: the package file's read and the site rules' updater's, no transport", () => {
    const ident = () => /(?<![\w$.\-/"'`])fetch(?![\w$\-])/g; // the global, not a property, a path or another word
    const users = ts.filter((f) => ident().test(code(f.text))).map((f) => f.path);
    // the site rules' bundle read from the package itself (AF3-3a), of the one package path it names: no network, no
    // other address; and the site rules' updater (AF3-U2, behind its release gate): its worker module passes the global
    // to its one read (rules-fetch.ts names it as a type only), which only that module imports
    expect(users).toEqual(["platform/package-data.ts", "platform/rules-fetch.ts", "platform/rules-live.ts"]);
    const updater = code(files.find((f) => f.path === "platform/rules-live.ts")!.text);
    expect(updater.match(ident())).toHaveLength(2); // its deps' type, and the one call
    expect(updater).toMatch(/get: typeof fetch;/);
    expect(updater).toMatch(/get: \(url, init\) => fetch\(url, init\),/);
    const read = code(files.find((f) => f.path === "platform/rules-fetch.ts")!.text);
    expect(read.match(ident())).toHaveLength(1);
    expect(read).toMatch(/get: typeof fetch\)/); // a type: the read uses what it is given
    expect(importers(/rules-fetch$/)).toEqual(["platform/rules-live.ts"]);
    const own = code(files.find((f) => f.path === "platform/package-data.ts")!.text);
    expect(own.match(ident())).toHaveLength(1);
    expect(own).toMatch(
      /await fetch\(chrome\.runtime\.getURL\(BASELINE_FILE\), \{ signal: AbortSignal\.timeout\(READ_MS\) \}\)/,
    );
    expect(importers(/fetch-transport$|sync-worker$|bridge-(?:worker|page)$|api-permission$|api-origin$/)).toEqual([]);
  });

  it("every context builds its runtime the one way: the worker as a page does", () => {
    // the popup's is the same wiring with the part of the service it uses (createPopupRuntime, platform/runtime-base.ts)
    const calls = ts
      .flatMap((f) =>
        [...code(f.text).matchAll(/\b(createRuntime|createPopupRuntime|buildRuntime)\(([^)]*)\)/g)].map(
          (m) => `${f.path}: ${m[1]}(${m[2]})`,
        ),
      )
      .filter((c) => !c.startsWith("platform/runtime.ts: ") && !c.startsWith("platform/runtime-base.ts: "));
    expect(calls.sort()).toEqual([
      "background/sw.ts: createRuntime()",
      "options/App.tsx: createRuntime()",
      "popup/App.tsx: createPopupRuntime()",
    ]);
    // and each passes `o` on unchanged to the one wiring, with its service class
    expect(code(files.find((f) => f.path === "platform/runtime.ts")!.text)).toMatch(
      /return buildRuntime\(o, \(deps\) => new VaultService\(deps\)\);/,
    );
    expect(code(files.find((f) => f.path === "platform/runtime-base.ts")!.text)).toMatch(
      /return buildRuntime\(o, \(deps\) => new ServiceCore\(deps\)\);/,
    );
  });

  it("no API origin anywhere: not in the source, the build script, check-dist's expectations or the manifests", () => {
    const gone = ["api.sixkey.app", "127.0.0.1:8787", "__API_ORIGIN__", "__SERVER_SYNC__"];
    for (const word of gone)
      expect(
        files.filter((f) => f.text.includes(word)).map((f) => f.path),
        word,
      ).toEqual([]);
    const build = readFileSync(join(EXT, "scripts/build.mjs"), "utf8");
    // (its graph guard names the old modules' paths, api-origin.ts among them, to refuse them: not the script)
    expect(code(build)).not.toMatch(
      /api\.sixkey\.app|127\.0\.0\.1:8787|__API_ORIGIN__|__SERVER_SYNC__|api-origin\.mjs/,
    );
    // check-dist names the API's addresses once, in the list it refuses in every shipped file (GONE_API)
    expect(code(checkDist).match(/api\.sixkey\.app/g)).toHaveLength(1);
    expect(code(checkDist)).toMatch(/const GONE_API = \["api\.sixkey\.app", "127\.0\.0\.1:8787"\];/);
    const manifest = (f: string) => JSON.parse(readFileSync(join(EXT, f), "utf8"));
    const base = manifest("manifest.base.json");
    for (const [flavour, overlay] of [
      ["prod", {}],
      ["dev", manifest("manifest.dev.json")],
      ["e2e", manifest("manifest.e2e.json")],
    ] as const) {
      const m = { ...base, ...overlay };
      for (const k of Object.keys(m)) if (m[k] === null) delete m[k]; // an overlay's null removes the key (build.mjs)
      // optional in prod and dev, required in e2e (its tests cannot answer the prompt)
      const [key, other] =
        flavour === "e2e"
          ? ["host_permissions", "optional_host_permissions"]
          : ["optional_host_permissions", "host_permissions"];
      // autofill's sites alone (AUTOFILL2 patch 2): https sites asked for one at a time in prod and dev, the two Stage 2
      // fixture hosts granted up front in e2e (scripts/check-dist.mjs holds the exact lists)
      expect(m[key], flavour).toEqual(
        flavour === "e2e" ? ["https://grantedtls.fix.test/*", "http://granted.fix.test/*"] : ["https://*/*"],
      );
      expect(other in m, flavour).toBe(false);
      // connect-src 'none' in every file (the site rules' updater's one path is the build's to add, with its gate open)
      expect(m.content_security_policy, flavour).toEqual({ extension_pages: cspOf() });
      expect(m.optional_permissions, flavour).not.toContain("identity");
      expect(JSON.stringify(m), flavour).not.toMatch(/api\.sixkey\.app|127\.0\.0\.1/);
    }
  });

  it("host permissions go through platform/autofill-sites.ts and autofill's switch (one site's own pattern only)", () => {
    expect(ts.filter((f) => /\borigins\b/.test(code(f.text))).map((f) => f.path)).toEqual([
      "background/sw.ts", // reads a permission event's origins (mayBeSite), asks for nothing and removes nothing
      "platform/autofill-sites.ts",
      "platform/permission-grants.ts", // reads getAll's list only (it asks for nothing and removes nothing)
      "platform/plugins/autofill-switch.ts", // autofill's Off and On (wave 1b): the listed sites' own patterns only
    ]);
    expect(code(files.find((f) => f.path === "platform/permission-grants.ts")!.text)).not.toMatch(
      /\b(request|remove|contains)\(/,
    );
    // a site's pattern is core/autofill-sites.ts sitePattern's, exactly https://<host>/*: asked, checked, given back
    const sites = files.find((f) => f.path === "platform/autofill-sites.ts")!.text;
    expect([...sites.matchAll(/origins:\s*\[([^\]]*)\]/g)].map((m) => m[1])).toEqual(["pattern", "pattern", "pattern"]);
    expect([...sites.matchAll(/\bconst pattern = (.*);/g)].map((m) => m[1])).toEqual([
      "sitePattern(host)",
      "sitePattern(host)",
      "sitePattern(host)",
    ]);
    // autofill's switch: Off gives back each listed site's own pattern, On asks for them (the list's, sitePattern's)
    const sw = files.find((f) => f.path === "platform/plugins/autofill-switch.ts")!.text;
    expect([...sw.matchAll(/origins:\s*\[([^\]]*)\]/g)].map((m) => m[1])).toEqual(["pattern"]);
    expect(sw).toMatch(/hosts\.map\(\(h\) => sitePattern\(h\)\)/);
    expect(sw).toMatch(/for \(const pattern of patternsOf\(/);
    expect(sw).toMatch(/\.\.\.\(origins\.length \? \{ origins \} : \{\}\)/);
  });

  it("check-dist's enrolment fingerprints are in no source (enroll.ts, their one place, went with the server sync's client)", () => {
    const fps = JSON.parse(/const ENROLMENT_FINGERPRINTS = (\[[^\]]+\]);/.exec(checkDist)![1]!) as string[];
    expect(fps.length).toBeGreaterThanOrEqual(3);
    for (const fp of fps)
      expect(
        files.filter((f) => f.text.includes(`"${fp}"`)).map((f) => f.path),
        fp,
      ).toEqual([]);
  });

  it("the developer sync page is gone (OWNER-DECISIONS/25): imported by nothing, its files, its path and its marker nowhere", () => {
    expect(importers(/devsync/)).toEqual([]);
    expect(files.filter((f) => f.path.startsWith("devsync/")).map((f) => f.path)).toEqual([]);
    expect(files.filter((f) => /devsync/.test(code(f.text))).map((f) => f.path)).toEqual([]);
    expect(files.filter((f) => f.text.includes("sixkey-dev-sync")).map((f) => f.path)).toEqual([]);
  });

  it("the Google Drive backup's code is gone: no source names Google's API or OAuth endpoints, its developer page or its messages", () => {
    for (const word of [
      "googleapis.com",
      "accounts.google.com/o/oauth2",
      "chrome.identity",
      "sixkey-dev-cloud",
      "devcloud/",
      "sk-cloud-",
    ])
      expect(
        files.filter((f) => f.text.includes(word)).map((f) => f.path),
        word,
      ).toEqual([]);
  });
});
