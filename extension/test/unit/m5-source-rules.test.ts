// M5's rules about the source (SYNC-DESIGN §4.9, §7): what holds by construction, so that no run-time test would notice a
// new line breaking it. Comments are not code.
//   - `fetch` in exactly the allowed places: the sync transport, one call, and the read of the extension's own package
//     file (TOTP autofill Stage 3, platform/package-data.ts: no network); only the service worker's wiring builds the
//     transport (the Google Drive backup's Google transport went with that path's code);
//   - the service worker builds its runtime as the worker's (its commits do not ask it for a round), pages as pages;
//   - the API origin has one value per build, the same in the build script, the check, the manifests and the source;
//   - check-dist's enrolment fingerprints really are enroll.ts's alone (else its prod gate would prove nothing);
//   - the developer sync page is reachable from no other page;
//   - host permissions are asked for, checked and removed in two modules: platform/api-permission.ts, always the build's
//     API origin, and (TOTP autofill Stage 2, patch 2) platform/autofill-sites.ts, always one site's own pattern;
//   - the worker's bridge imports nothing that signs or stores, and the three modules on that path say who signs in the
//     same words.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_ORIGINS, cspOf, hostPermissionOf } from "../../scripts/api-origin.mjs";
import { API_ORIGIN } from "../../src/platform/api-origin";

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
  it("`fetch` in exactly the allowed places: the sync transport, once, built by the service worker's wiring only", () => {
    const ident = () => /(?<![\w$.\-/"'`])fetch(?![\w$\-])/g; // the global, not a property, a path or another word
    const users = ts.filter((f) => ident().test(code(f.text))).map((f) => f.path);
    // the sync transport; and the site rules' bundle read from the package itself (AF3-3a), of the one package path it
    // names: no network, no other address; and the site rules' updater (AF3-U2, behind its release gate): its worker
    // module passes the global to its one read (rules-fetch.ts names it as a type only), which only that module imports
    expect(users).toEqual([
      "platform/fetch-transport.ts",
      "platform/package-data.ts",
      "platform/rules-fetch.ts",
      "platform/rules-live.ts",
    ]);
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
    expect(code(files.find((f) => f.path === "platform/fetch-transport.ts")!.text).match(ident())).toHaveLength(1);
    expect(importers(/fetch-transport$/)).toEqual(["platform/bridge-worker.ts", "platform/sync-worker.ts"]);
    expect(ts.filter((f) => /new FetchTransport\s*\(/.test(code(f.text))).map((f) => f.path)).toEqual([
      "platform/sync-worker.ts",
    ]);
    expect(importers(/sync-worker$/)).toEqual(["background/sw.ts"]);
    expect(importers(/bridge-worker$/)).toEqual(["background/sw.ts"]);
  });

  it("the service worker builds the worker's runtime; every page builds a page's (which asks the worker for a round after a commit)", () => {
    // the popup's is the same wiring with the part of the service it uses (createPopupRuntime, platform/runtime-base.ts)
    const calls = ts
      .flatMap((f) =>
        [...code(f.text).matchAll(/\b(createRuntime|createPopupRuntime|buildRuntime)\(([^)]*)\)/g)].map(
          (m) => `${f.path}: ${m[1]}(${m[2]})`,
        ),
      )
      .filter((c) => !c.startsWith("platform/runtime.ts: ") && !c.startsWith("platform/runtime-base.ts: "));
    expect(calls.sort()).toEqual([
      "background/sw.ts: createRuntime({ worker: true })",
      "devsync/main.ts: createRuntime()",
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

  it("the API origin: one value per build, the same in scripts/api-origin.mjs, check-dist, the manifests, and the source's unbuilt fallback", () => {
    expect(API_ORIGINS).toEqual({
      prod: "https://api.sixkey.app",
      dev: "http://127.0.0.1:8787",
      e2e: "http://127.0.0.1:8787",
    });
    const mine = /const API_ORIGIN = (\{[^}]+\})\[\s*flavour\s*\]/
      .exec(checkDist)![1]!
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":');
    expect(JSON.parse(mine)).toEqual(API_ORIGINS);
    const manifest = (f: string) => JSON.parse(readFileSync(join(EXT, f), "utf8"));
    const base = manifest("manifest.base.json");
    for (const [flavour, overlay] of [
      ["prod", {}],
      ["dev", manifest("manifest.dev.json")],
      ["e2e", manifest("manifest.e2e.json")],
    ] as const) {
      const m = { ...base, ...overlay };
      const origin = API_ORIGINS[flavour];
      for (const k of Object.keys(m)) if (m[k] === null) delete m[k]; // an overlay's null removes the key (build.mjs)
      // optional in prod and dev (granted when sync is turned on), required in e2e (its tests cannot answer the prompt)
      const [key, other] =
        flavour === "e2e"
          ? ["host_permissions", "optional_host_permissions"]
          : ["optional_host_permissions", "host_permissions"];
      // the API origin first where the file has it (the dev and e2e manifests; the prod file is the store build's with
      // the sync user interface out, which scripts/build.mjs gives the origin only when the gate is open); then
      // autofill's sites (AUTOFILL2 patch 2): https sites asked for one at a time in prod and dev, the two Stage 2
      // fixture hosts granted up front in e2e (scripts/check-dist.mjs holds the exact lists)
      const api = flavour === "prod" ? [] : [hostPermissionOf(origin)];
      expect(m[key].slice(0, api.length), flavour).toEqual(api);
      expect(m[key].slice(api.length), flavour).toEqual(
        flavour === "e2e" ? ["https://grantedtls.fix.test/*", "http://granted.fix.test/*"] : ["https://*/*"],
      );
      expect(other in m, flavour).toBe(false);
      // the API origin alone where the file has it, none in the prod file (the dev build's three Google paths went with
      // the Google Drive backup)
      expect(m.content_security_policy, flavour).toEqual({
        extension_pages: cspOf(flavour === "prod" ? null : origin),
      });
      expect(m.optional_permissions, flavour).not.toContain("identity");
    }
    expect(API_ORIGIN).toBe(API_ORIGINS.prod); // unbuilt code (these tests) sees the prod origin
    expect(base.version).toBe("0.1.0"); // M4's default min_client_version: an older version stops every round
  });

  it("the worker's bridge never signs and never stores: it imports nothing that could, and says so", () => {
    const own = files.find((f) => f.path === "platform/bridge-worker.ts")!.text;
    const imports = [...code(own).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]).sort(); // side-effect and dynamic imports too
    expect(imports).toEqual([
      "../core/sync/crypto/constants",
      "../core/sync/engine/transport",
      "./bridge-page",
      "./fetch-transport",
    ]);
    expect(own).toContain("It never signs, never stores what passes through");
    for (const f of ["platform/bridge-worker.ts", "platform/bridge-page.ts", "platform/sync-worker.ts"]) {
      expect(files.find((x) => x.path === f)!.text.replace(/\n\/\/ /g, " "), f).toContain(
        "a page signs its own requests, and the worker relays a finished request without signing it, storing it or inspecting it beyond four checks: the sender, the shape, the origin pin and the target exactly as signed. The worker signs only its own rounds, pushes and polls.",
      );
    }
  });

  it("host permissions go through platform/api-permission.ts (the build's API origin only) and platform/autofill-sites.ts (one site's own pattern only)", () => {
    expect(ts.filter((f) => /\borigins\b/.test(code(f.text))).map((f) => f.path)).toEqual([
      "platform/api-permission.ts",
      "platform/autofill-sites.ts",
      "platform/permission-grants.ts", // reads getAll's list only (it asks for nothing and removes nothing)
      "platform/plugins/autofill-switch.ts", // autofill's Off and On (wave 1b): the listed sites' own patterns only
    ]);
    expect(code(files.find((f) => f.path === "platform/permission-grants.ts")!.text)).not.toMatch(
      /\b(request|remove|contains)\(/,
    );
    const own = files.find((f) => f.path === "platform/api-permission.ts")!.text; // as written (its "/*" is no comment)
    expect([...own.matchAll(/origins:\s*\[([^\]]*)\]/g)].map((m) => m[1])).toEqual(["`${API_ORIGIN}/*`"]);
    // a site's pattern is core/autofill-sites.ts sitePattern's, exactly https://<host>/*: asked, checked, given back
    const sites = files.find((f) => f.path === "platform/autofill-sites.ts")!.text;
    expect([...sites.matchAll(/origins:\s*\[([^\]]*)\]/g)].map((m) => m[1])).toEqual(["pattern", "pattern", "pattern"]);
    expect([...sites.matchAll(/\bconst pattern = (.*);/g)].map((m) => m[1])).toEqual([
      "sitePattern(host, API_HOST)",
      "sitePattern(host, API_HOST)",
      "sitePattern(host, API_HOST)",
    ]);
    // autofill's switch: Off gives back each listed site's own pattern, On asks for them (the list's, sitePattern's)
    const sw = files.find((f) => f.path === "platform/plugins/autofill-switch.ts")!.text;
    expect([...sw.matchAll(/origins:\s*\[([^\]]*)\]/g)].map((m) => m[1])).toEqual(["pattern"]);
    expect(sw).toMatch(/hosts\.map\(\(h\) => sitePattern\(h, API_HOST\)\)/);
    expect(sw).toMatch(/for \(const pattern of patternsOf\(/);
    expect(sw).toMatch(/\.\.\.\(origins\.length \? \{ origins \} : \{\}\)/);
  });

  it("check-dist's enrolment fingerprints exist in enroll.ts, and otherwise only in the Sync section (which the release gate keeps out of the store build with it)", () => {
    const fps = JSON.parse(/const ENROLMENT_FINGERPRINTS = (\[[^\]]+\]);/.exec(checkDist)![1]!) as string[];
    expect(fps.length).toBeGreaterThanOrEqual(3);
    for (const fp of fps) {
      const where = files.filter((f) => f.text.includes(`"${fp}"`)).map((f) => f.path);
      expect(where, fp).toContain("core/sync/engine/enroll.ts");
      expect(
        where.filter((p) => p !== "core/sync/engine/enroll.ts" && !p.startsWith("options/sync/")),
        fp,
      ).toEqual([]);
    }
  });

  it("the developer sync page is linked from nowhere and imported by nothing; its marker is only in its own files", () => {
    expect(importers(/devsync/)).toEqual([]);
    expect(
      files.filter((f) => !f.path.startsWith("devsync/") && /devsync/.test(code(f.text))).map((f) => f.path),
    ).toEqual(["platform/bridge-worker.ts", "platform/sender-policy.ts"]); // the dev builds' page lists (bridge; every message's senders)
    expect(
      files
        .filter((f) => f.text.includes("sixkey-dev-sync"))
        .map((f) => f.path)
        .sort(),
    ).toEqual(["devsync/index.html", "devsync/main.ts"]);
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
