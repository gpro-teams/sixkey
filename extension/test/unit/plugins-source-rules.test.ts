// What is left of the plugin platform, removed on 2026-11-12, held in the source: no way for another extension or a web
// page to reach Sixkey (no listener of their messages or ports, no port or message to another extension, no
// `management` but getSelf, which needs no permission, no externally_connectable), no embedded page, none of the
// platform's surfaces left (Settings › Plugins, the popup's and the side panel's plugin module, the trash's marks), and
// the grant store, which now holds autofill's switch alone, written by its own module only and never synced, backed up
// or exported. scripts/check-dist.mjs holds the built files to the same.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
const file = (p: string) => files.find((f) => f.path === p)!;
const using = (re: RegExp) =>
  files
    .filter((f) => re.test(f.code))
    .map((f) => f.path)
    .sort();

const EXT = resolve(SRC, "..");
const manifests = ["manifest.base.json", "manifest.dev.json", "manifest.e2e.json"].map((m) => ({
  name: m,
  json: JSON.parse(readFileSync(resolve(EXT, m), "utf8")) as Record<string, unknown>,
}));

describe("no other extension and no web page reaches Sixkey", () => {
  it("no file listens to another extension's messages or ports, opens a port, or messages another extension", () => {
    expect(using(/\bon(?:MessageExternal|ConnectExternal)\b/)).toEqual([]);
    expect(using(/runtime\.connect\(/)).toEqual([]);
    // runtime.sendMessage with an extension ID first: a string literal or a variable before the message
    expect(using(/runtime\.sendMessage\((?:"[a-p]{32}"|[A-Za-z_$][\w$]*,)/)).toEqual([]);
  });
  it("the management API only for getSelf (no permission needed), and no manifest asks for `management`", () => {
    for (const f of files)
      for (const [, call] of f.code.matchAll(/\bmanagement\??\.([A-Za-z_$][\w$]*)/g))
        expect(call, f.path).toBe("getSelf");
    for (const m of manifests) {
      expect(m.json.optional_permissions ?? [], m.name).not.toContain("management");
      expect(m.json.permissions ?? [], m.name).not.toContain("management");
    }
  });
  it("no manifest has externally_connectable or web-accessible resources, and no file draws a frame", () => {
    for (const m of manifests) {
      expect("externally_connectable" in m.json, m.name).toBe(false);
      expect("web_accessible_resources" in m.json, m.name).toBe(false);
    }
    expect(files.filter((f) => /<iframe|createElement\(["']iframe/i.test(f.code)).map((f) => f.path)).toEqual([]);
  });
});

describe("the removed surfaces stay removed", () => {
  it("no Settings › Plugins leaf, route or rail entry; no popup plugin module; no trash marks", () => {
    for (const p of [
      "options/Plugins.tsx",
      "options/PluginApproval.tsx",
      "options/PluginsHost.tsx",
      "popup/main/Plugins.tsx",
      "popup/main/ChangeList.tsx",
      "ui/plugins/trash-marks.ts",
      "ui/plugins/popup-text.ts",
      "platform/plugins/worker.ts",
      "platform/plugins/proposals.ts",
    ])
      expect(
        files.some((f) => f.path === p),
        p,
      ).toBe(false);
    expect(file("options/route.ts").code).not.toMatch(/"plugins"/);
    expect(file("options/App.tsx").code).not.toMatch(/grpPlugins|PluginsHost/);
    expect(file("popup/main/Main.tsx").code).not.toMatch(/import\("\.\/Plugins"\)|sk_plugins_any|sk_plugin_seen/);
    expect(file("options/Misc.tsx").code).not.toMatch(/trashBy|trash-marks/);
  });
});

describe("the grant store's records", () => {
  it("the grant store's records are written by its module only; nothing that syncs, backs up or exports names them", () => {
    for (const k of [
      "sk_plugins",
      "sk_plugins_overlay",
      "sk_plugins_unverified",
      "sk_plugin_pauses",
      "sk_plugins_epoch",
    ]) {
      const named = files.filter((f) => f.code.includes(`"${k}"`)).map((f) => f.path);
      expect(
        named.filter((p) => p !== "core/plugins/grants.ts"),
        k,
      ).toEqual([]);
    }
    for (const f of files.filter(
      (x) => /^(core\/sync|core\/backup|options\/sync)\//.test(x.path) || x.path === "options/Backup.tsx",
    ))
      expect(f.code, f.path).not.toMatch(/sk_plugin/);
  });
  it("the request log holds protocol words only: autofill's gate logs the type and the outcome", () => {
    const c = file("core/plugins/session.ts").code;
    expect(c).toMatch(/constLOG_WORD=\/\^\[a-z\]\[a-z\.-\]\{0,31\}\$\/;/);
    for (const p of ["platform/plugins/autofill-gate.ts"]) {
      const c = file(p).code;
      let n = 0;
      for (let i = c.indexOf(".record({"); i !== -1; i = c.indexOf(".record({", i + 1)) {
        n++;
        // the object's own keys, at its top level: its items split at the commas outside any bracket
        let depth = 0;
        let item = "";
        const items: string[] = [];
        for (const ch of c.slice(i + ".record(".length)) {
          if (ch === "{" || ch === "(" || ch === "[") depth++;
          if (ch === "}" || ch === ")" || ch === "]") depth--;
          if (depth === 0) break;
          if (depth === 1 && ch === ",") {
            items.push(item);
            item = "";
          } else if (!(depth === 1 && ch === "{" && !item)) item += ch;
        }
        items.push(item);
        const keys = items.filter(Boolean).map((x) => x.split(":")[0]); // (a trailing comma leaves an empty item)
        expect(keys, p).toEqual(["at", "pluginId", "type", "outcome"]);
      }
      expect(n, p).toBeGreaterThan(0);
    }
  });
  it("the switch's write refused while a key change is finished says try again, and loses nothing", () => {
    const sw = file("options/AutofillSwitch.tsx").code;
    expect(sw).toMatch(
      /\}catch\(e\)\{if\(!\(einstanceofCleanupPendingError\)\)throwe;setRetry\(true\);voidrunPendingCleanup\(rt\);\}/,
    );
    expect(sw.match(/runPendingCleanup\(/g)).toHaveLength(1);
    expect(using(/runPendingCleanup\(/)).toEqual(["core/plugins/store.ts", "options/AutofillSwitch.tsx"]);
    expect(sw).toMatch(/\{retry&&<pclass="calloutwarn">\{px\("pxTryAgain"\)\}<\/p>\}/);
    // every tagged write of a page goes through withFreshKeys, which alone tries again
    expect(using(/newCleanupPendingError\(/)).toEqual(["core/plugins/store.ts"]);
  });
});
