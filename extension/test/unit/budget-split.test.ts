// The budget relief (docs/design/notes/BUDGET-NOTES.md), held in place:
//   1. The service is two classes. ServiceCore (core/service/service-core.ts) is all the popup builds
//      (platform/runtime-base.ts createPopupRuntime); VaultService (core/service/service.ts) extends it with everything
//      else and is what every other context builds (platform/runtime.ts createRuntime), with the very methods it had.
//      Neither VaultService nor the runtime that builds it is in the popup's module graph.
//   2. The settings page's text is in parts: catalogs/settings-<part>-<lang>.json, which key in which part being data (the
//      fragments' PARTS, scripts/messages.py). Here the data is held to the code: the key collector works out which keys
//      each part can show (scripts/catalog-keys.mjs settingsKeys, rule 6), and every key a part's code uses must be in the
//      core or in that part, and every placed key must be used there. Each part is drawn only through its wrapper in
//      src/options/parts.tsx, which loads its text first; the page loads only the core before it draws anything.
// scripts/build.mjs and scripts/check-dist.mjs check the built files by other means (test/unit/budget-check-dist.test.ts).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  popupKeys,
  readCatalogs,
  SETTINGS_PARTS,
  settingsKeys,
  viewKeys,
  type Collected,
} from "../../scripts/catalog-keys.mjs";
import { ServiceCore } from "../../src/core/service/service-core";
import { VaultService } from "../../src/core/service/service";
import * as serviceModule from "../../src/core/service/service";

const EXT = resolve(__dirname, "../..");
const SRC = join(EXT, "src");
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = sources().map((p) => ({ path: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
const file = (p: string) => files.find((f) => f.path === p)!.text;
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
type Cat = Record<string, { message: string }>;
const json = (p: string) => JSON.parse(readFileSync(join(EXT, p), "utf8")) as Cat;

// ---- 1. the service ----------------------------------------------------------------------------------------------

/** The methods and accessors a class itself declares (TypeScript's private ones included: they are ordinary members). */
const own = (cls: { prototype: object }) =>
  Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== "constructor");
// what the popup's service has: opening, the three unlocks, editing, the acknowledgement of events, locking, the touch,
// and the steps these take
const CORE_MEMBERS = [
  "also",
  "openView",
  "unlockedView",
  "currentVk",
  "sessionVk",
  "requireVk",
  // the grant store's tag (src/core/plugins/store.ts): the popup's lazy chunk
  "grantKeys",
  "startSession",
  "touch",
  "lock",
  "unlockWithPassword",
  "unlockWithRecoveryCode",
  "unlockWith",
  "noteFormat",
  "saveFormat",
  "finishUnlock",
  "arm",
  "quickUsable",
  "dropIfSame",
  "lockScreenGate",
  "devicePlan",
  "hasGate",
  "vkOf",
  "housekeeping",
  "finishKeyChanges",
  "record",
  "mutate",
  "ackEvents",
];
// everything else VaultService had before the split, in its order: the settings page's and the service worker's
const FULL_MEMBERS = [
  "ctx",
  "status",
  "hardLock",
  "endQuickQuietly",
  "enforceQuickExpiry",
  "enforceAutoLock",
  "getSettings",
  "updateSettings",
  // its own step, which the first-run answer takes inside the vault's transact (the PIN after a restart: PIN-RESTART-NOTES)
  "saveSettings",
  "prepareKeys",
  "keysOf",
  "saveChoice",
  "makeVault",
  "dropStalePin",
  "dropStalePrf",
  "dropRestart", // the PIN after a restart's record, removed by a new vault (PIN-RESTART-NOTES.md §5)
  "create",
  "guarding",
  "verifyPassword",
  "requireMasterPassword",
  "confirmSecret", // the PIN or the master password typed again (OWNER-DECISIONS/26)
  "recordExport",
  "clearSecurityLog",
  "read",
  "requirePolicy",
  "enableMasterPassword",
  "rotateKey",
  "capped",
  "unlockWith2",
  "scrubQuietly",
  "scrub",
  "committed",
  "changePassword",
  "prepareReset",
  "commitReset",
  "newRecoveryCode",
  // recovery code shares (docs/design/notes/SHAMIR-NOTES.md §3): the settings page's, not the popup's
  "prepareShares",
  "recoveryKeyFrom",
  "confirmShares",
  "unremind",
  "checkRecoveryCode",
  "browserStarted",
  "restoreBackup",
  "importBackup",
  // the cloud backup's restore and merge (CLOUDBK patch 5)
  "prepareRestoredKeys",
  "openOwnGenerations",
  "purgeForever",
  "lastBackupAt",
  "markBackedUp",
  "startOver",
  "methods",
  "currentGeneration",
];
// The popup's service, as a type: every public member of ServiceCore is one of these, so a method added to it for another
// page is a decision this list records, not a few bytes nobody saw go in. This is a type-level check: `npm run typecheck`
// fails on a missing entry (CI runs it); under vitest, which erases types, `allListed` is always true.
const POPUP_API = [
  "openView",
  "touch",
  "lock",
  "unlockWithPassword",
  "unlockWithRecoveryCode",
  "mutate",
  "ackEvents",
  "grantKeys",
] as const satisfies readonly (keyof ServiceCore)[];
type NotListed = Exclude<keyof ServiceCore, (typeof POPUP_API)[number]>;
const allListed: [NotListed] extends [never] ? true : false = true;

describe("the service in two classes", () => {
  it("VaultService extends ServiceCore and has every member it had before; ServiceCore has the popup's only", () => {
    expect(Object.getPrototypeOf(VaultService.prototype)).toBe(ServiceCore.prototype);
    expect(allListed).toBe(true);
    expect(own(ServiceCore).sort()).toEqual([...CORE_MEMBERS].sort());
    expect(own(VaultService).sort()).toEqual([...FULL_MEMBERS].sort());
    // the whole facade, through the prototype chain: the 66 members from before the split and confirmSecret, none twice
    const chain = new Set([...own(VaultService), ...own(ServiceCore)]);
    expect(chain.size).toBe(CORE_MEMBERS.length + FULL_MEMBERS.length);
    for (const m of POPUP_API) expect(typeof ServiceCore.prototype[m], m).toBe("function");
  });

  it("service.ts exports what it exported before, the moved helpers and types included", () => {
    expect(Object.keys(serviceModule).sort()).toEqual(
      ["ALWAYS_MODE_MAX_IDLE_MINUTES", "ServiceError", "StorageError", "VaultService", "isSessionExpired"].sort(),
    );
    const s = code(file("core/service/service.ts"));
    for (const t of [
      "OpenView",
      "PinUnlock",
      "QuickView",
      "ServiceDeps",
      "UnlockedView",
      "UnlockResult",
      "VkRecord",
      "VkRecordResult",
    ])
      expect(s, t).toMatch(new RegExp(`\\btype ${t},`));
    for (const t of [
      "ServiceStatus",
      "CodeDelivery",
      "PreparedReset",
      "PreparedKeys",
      "FirstRunChoice",
      "ShareSetup",
      "PreparedShares",
    ])
      expect(s, t).toMatch(new RegExp(`export type ${t}\\b`));
  });

  it("VaultService declares no fields (with class-field semantics they would be set again, empty, after ServiceCore's constructor), and only the members its methods use are protected", () => {
    const s = code(file("core/service/service.ts"));
    const body = s.slice(s.indexOf("export class VaultService extends ServiceCore {"));
    expect(body.length).toBeGreaterThan(1000);
    expect(body).not.toMatch(/^ {2}(?:(?:private|protected|public|readonly|static|declare) )*[A-Za-z_$][\w$]*[?!]?:/m);
    expect(body).not.toMatch(/^ {2}constructor\(/m);
    const core = code(file("core/service/service-core.ts"));
    expect([...core.matchAll(/^ {2}protected (?:readonly |async )?([A-Za-z]+)/gm)].map((m) => m[1]).sort()).toEqual(
      [
        "store",
        "session",
        "settings",
        "now",
        "rng",
        "iterations",
        "diag",
        "security",
        "vkRecords",
        "pins",
        "prfs", // the device unlock's record (QUICK-UNLOCK Stage 2): VaultService drops a stale one with a new vault
        "quickLock",
        "currentVk",
        "requireVk",
        "startSession",
        "saveFormat",
        "record",
        "finishKeyChanges",
      ].sort(),
    );
    // the one-shot handles and the "landed" marker stay single, in service.ts (no second copy in the core)
    for (const m of [
      "const preparedKeys = new WeakMap",
      "const preparedResets = new WeakMap",
      "const preparedShares = new WeakMap",
      'const LANDED = new Error("landed")',
    ]) {
      expect(s.split(m).length - 1, m).toBe(1);
      expect(core, m).not.toContain(m);
    }
  });

  it("ServiceCore is extended by VaultService only, and VaultService by nothing: no other class reaches the protected members", () => {
    // (the members made protected for VaultService include the session cache, which hands out the raw vault key; element
    // access to the service's steps is allowed in the service's admins only, m2-source-rules.test.ts)
    const at = (re: RegExp) => files.filter((f) => re.test(code(f.text))).map((f) => f.path);
    expect(at(/\bextends\s+ServiceCore\b/)).toEqual(["core/service/service.ts"]);
    expect(at(/\bextends\s+VaultService\b/)).toEqual([]);
    expect(at(/import\s*\{[^}]*\bServiceCore\b[^}]*\}\s*from/).sort()).toEqual([
      "core/service/service.ts",
      "platform/runtime-base.ts",
    ]);
  });

  it("the popup builds ServiceCore through the shared wiring; VaultService is built in platform/runtime.ts only", () => {
    const at = (re: RegExp) => files.filter((f) => re.test(code(f.text))).map((f) => f.path);
    expect(at(/new VaultService\s*\(/)).toEqual(["platform/runtime.ts"]);
    expect(at(/new ServiceCore\s*\(/)).toEqual(["platform/runtime-base.ts"]);
    expect(at(/\bcreatePopupRuntime\s*\(/).sort()).toEqual(["platform/runtime-base.ts", "popup/App.tsx"]);
    // nothing in the popup's folder imports the whole service or its runtime
    for (const f of files.filter((x) => x.path.startsWith("popup/")))
      expect(code(f.text), f.path).not.toMatch(/from\s+["'][^"']*(?:core\/service\/service|platform\/runtime)["']/);
  });

  it("the popup's module graph has the core and the shared wiring, and none of the settings page's key operations", () => {
    const popup = popupKeys(EXT);
    for (const m of ["src/core/service/service-core.ts", "src/platform/runtime-base.ts"])
      expect(popup.modules).toContain(m);
    for (const m of [
      "src/core/service/service.ts",
      "src/platform/runtime.ts",
      "src/core/crypto/password-policy.ts", // the master password's policy: VaultService.requirePolicy
      "src/core/service/presets.ts", // the first run's answer
      "src/core/crypto/cap-previous.ts", // the rotation's cap on previous keys
      "src/core/service/pin-admin.ts",
      "src/options/MasterField.tsx", // the settings page's prompts (their hint reader): the popup draws the boxes alone
    ])
      expect(popup.modules, m).not.toContain(m);
    // the grouped input of a generated password, shared with the settings page from src/ui (PASSWORD-SETUP-NOTES §8.3)
    expect(popup.modules).toContain("src/ui/PasswordGroups.tsx");
    expect(popup.modules.filter((m) => m.startsWith("src/options/"))).toEqual([]);
  });
});

// ---- 2. the settings page's text, in parts -------------------------------------------------------------------------

const PARTS = ["core", ...Object.keys(SETTINGS_PARTS)];
const full = readCatalogs(EXT) as Record<"en" | "zh_CN", Cat>;
const placed = Object.fromEntries(PARTS.map((p) => [p, Object.keys(json(`catalogs/settings-${p}-en.json`))])) as Record<
  string,
  string[]
>;
const partOf = new Map(Object.entries(placed).flatMap(([p, ks]) => ks.map((k) => [k, p] as const)));
let used: { core: Collected; parts: Record<string, Collected> };
beforeAll(() => {
  used = settingsKeys(EXT); // the release gate open: everything the page can show (throws, listing every problem)
}, 120_000);

describe("the settings page's text parts", () => {
  it("every key a part's code can show is in the core or in that part, and the page's frame needs only the core", () => {
    const out: string[] = [];
    for (const k of used.core.keys)
      if (partOf.get(k) !== "core") out.push(`core uses ${k}, placed in ${partOf.get(k) ?? "no part"}`);
    for (const [p, r] of Object.entries(used.parts))
      for (const k of r.keys)
        if (partOf.get(k) !== "core" && partOf.get(k) !== p)
          out.push(`${p} uses ${k}, placed in ${partOf.get(k) ?? "no part"}`);
    // (to move one: scripts/i18n/<fragment>.py PARTS; node scripts/catalog-keys.mjs --settings says where each is used)
    expect(out).toEqual([]);
    expect(used.core.keys.length).toBeGreaterThan(50); // not vacuous
    for (const r of Object.values(used.parts)) expect(r.keys.length).toBeGreaterThan(10);
  });

  it("every placed key is used where it is placed: a part's by that part, the core's somewhere on the page", () => {
    const anywhere = new Set([...used.core.keys, ...Object.values(used.parts).flatMap((r) => r.keys)]);
    const dead: string[] = [];
    for (const k of placed.core!) if (!anywhere.has(k)) dead.push(`core: ${k}`);
    for (const [p, r] of Object.entries(used.parts))
      for (const k of placed[p]!) if (!r.keys.includes(k)) dead.push(`${p}: ${k}`);
    expect(dead).toEqual([]);
  });

  it("every string is still reachable: a key in no settings part is the popup's, the View menu's, or Chrome's (the manifests, getMessage)", () => {
    const popup = new Set([...popupKeys(EXT).keys, ...viewKeys(EXT).keys]);
    const chrome = new Set<string>();
    for (const n of readdirSync(EXT).filter((x) => /^manifest.*\.json$/.test(x)))
      for (const [, k] of readFileSync(join(EXT, n), "utf8").matchAll(/__MSG_(\w+)__/g)) chrome.add(k!);
    for (const f of files) for (const [, k] of f.text.matchAll(/\bi18n\.getMessage\(\s*"(\w+)"/g)) chrome.add(k!);
    expect([...chrome].sort()).toEqual([
      "afCanFill", // the toolbar tooltip on a site the user turned on (AUTOFILL2 patch 3: platform/content-channel.ts)
      "afCanFillOpen",
      "afSugFill", // the in-page suggestion's words (AUTOFILL2 patch 4b: inject/suggest-ui.ts, the release gate open)
      "afSugNo",
      "afSugWait", // its cue after a click refused as too early (4B-FU)
      "appDesc",
      "appName",
      "cmdFill",
      "cmdLock",
      "fillTitleAsk", // the shortcut without `scripting` (wave 1b: background/fill-command.ts)
      "fillTitleBlocked",
      "fillTitleChoose",
      "fillTitleFailed",
      "fillTitleInsecure",
      "fillTitleLocked",
      "fillTitleNoBox",
      "fillTitleNoSite",
      "fillTitleOk",
      "fillTitleOld",
      "fillTitleSlow",
      "fillTitleUnsure",
    ]);
    const orphans = Object.keys(full.en).filter((k) => !partOf.has(k) && !popup.has(k) && !chrome.has(k));
    expect(orphans).toEqual([]);
  });

  it("each part is the same keys in both languages, the full catalog's text, and the parts share no key", () => {
    const seen = new Set<string>();
    for (const p of PARTS) {
      const en = json(`catalogs/settings-${p}-en.json`);
      const zh = json(`catalogs/settings-${p}-zh_CN.json`);
      expect(Object.keys(zh), p).toEqual(Object.keys(en));
      for (const k of Object.keys(en)) {
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
        expect(en[k], k).toEqual(full.en[k]);
        expect(zh[k], k).toEqual(full.zh_CN[k]);
      }
    }
    expect(
      readdirSync(join(EXT, "catalogs"))
        .filter((n) => n.startsWith("settings-"))
        .sort(),
    ).toEqual(PARTS.flatMap((p) => [`settings-${p}-en.json`, `settings-${p}-zh_CN.json`]).sort());
  });

  it("the parts are the same everywhere: the collector's, messages.py's, check-dist's (with the same budgets), parts.tsx's", () => {
    const py = readFileSync(join(EXT, "scripts/messages.py"), "utf8");
    const pyParts = /^SETTINGS_PARTS = \[([^\]]*)\]/m
      .exec(py)![1]!
      .match(/"([a-z]+)"/g)!
      .map((x) => x.slice(1, -1));
    expect(pyParts).toEqual(PARTS);
    const budgets = py.slice(py.indexOf("BUDGETS = {"), py.indexOf("\n}\n", py.indexOf("BUDGETS = {")));
    const pyBudgets = Object.fromEntries(
      [...budgets.matchAll(/^ {4}"([a-z-]+)": (\d+),$/gm)].map((m) => [m[1], +m[2]!]),
    );
    expect(Object.keys(pyBudgets)).toEqual([
      ...PARTS.map((p) => `settings-${p}`),
      "view",
      "plugins",
      "autofill",
      "shares",
      "device",
      "restart",
      "rules",
      "csb",
      "csb-popup",
    ]);
    // the backup in Chrome's sync storage's catalog: the same limit in both places
    expect(pyBudgets.csb).toBe(
      +/^const CSB_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    // and its popup's
    expect(pyBudgets["csb-popup"]).toBe(
      +/^const CSB_POPUP_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    // the site rules' updater's switch's (AF3-U2): the same limit in both places
    expect(pyBudgets.rules).toBe(
      +/^const RULES_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    // the plugin platform's catalogs (PLUGINS-W1A-NOTES.md §6; the popup's since PLUGINS-W2A-NOTES.md §2): the same
    // limit in both places
    expect(pyBudgets.plugins).toBe(
      +/^const PLUGINS_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    // (the popup's and the change list's went with the plugin platform: no budget, no limit)
    expect(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8")).not.toMatch(
      /PLUGINS_(?:POPUP|CHANGES)_CATALOG_GZ/,
    );
    // the device unlock's catalog (PRF-NOTES.md): the same limit in both places
    expect(pyBudgets.device).toBe(
      +/^const DEVICE_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    // the PIN record's catalog (PIN-RESTART-NOTES.md §8; its lock screen's went on 2026-10-30): the same limit in both
    // places
    expect(pyBudgets.restart).toBe(
      +/^const RESTART_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    // the recovery code shares' catalog (SHAMIR-NOTES.md §6): the same limit in both places
    expect(pyBudgets.shares).toBe(
      +/^const SHARES_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    // the View menu's catalog (QUICKVIEW-NOTES.md): the same limit in both places
    expect(pyBudgets.view).toBe(
      +/^const VIEW_CATALOG_GZ = (\d+);$/m.exec(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))![1]!,
    );
    const dist = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
    const block = /const SETTINGS_CATALOG_GZ = \{([^}]*)\}/.exec(dist)![1]!;
    const distBudgets = Object.fromEntries([...block.matchAll(/([a-z]+): (\d+)/g)].map((m) => [m[1], +m[2]!]));
    expect(Object.keys(distBudgets)).toEqual(PARTS);
    for (const p of PARTS) expect(pyBudgets[`settings-${p}`], p).toBe(distBudgets[p]);
    // (the Sync section's two catalogs went with the section, from every build: no budget, no limit)
    expect(dist).not.toMatch(/SYNC_CATALOG_GZ/);
    // none above the 12 KB the full catalog had, none so tight that the next string fails (1.5 KB was the target)
    for (const [name, b] of Object.entries(pyBudgets)) expect(b, name).toBeLessThanOrEqual(12 * 1024);
    const parts = code(file("options/parts.tsx"));
    expect(
      /export type Part = ([^;]*);/
        .exec(parts)![1]!
        .match(/"([a-z]+)"/g)!
        .map((x) => x.slice(1, -1)),
    ).toEqual(PARTS);
  });

  it("parts.tsx: each part's text is its own two files, and each part is drawn only through a wrapper of its own part", () => {
    const parts = code(file("options/parts.tsx"));
    // the sources: exactly two literal imports per part, of that part's files
    const sources = parts.slice(parts.indexOf("const SOURCES"), parts.indexOf("};", parts.indexOf("const SOURCES")));
    for (const p of PARTS) {
      const entry = sources.slice(
        sources.indexOf(`  ${p}: async`),
        sources.indexOf(",\n  ", sources.indexOf(`  ${p}: async`) + 1),
      );
      expect(
        [...entry.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]),
        p,
      ).toEqual([`../../catalogs/settings-${p}-zh_CN.json`, `../../catalogs/settings-${p}-en.json`]);
    }
    expect([...sources.matchAll(/import\(/g)]).toHaveLength(PARTS.length * 2);
    expect(parts).not.toMatch(/_locales|catalog-full/);
    // the wrappers: every component imported from a part's entry is wrapped for that part, once, and exported only so
    const importedFrom = new Map<string, string>(); // local name -> module
    for (const m of parts.matchAll(/^import \{([^}]*)\} from "\.\/(\w+)";$/gm))
      for (const spec of m[1]!
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)) {
        const [, local] = /(?:\w+ as )?(\w+)$/.exec(spec)!;
        importedFrom.set(local!, `src/options/${m[2]}.tsx`);
      }
    const wrapped = [...parts.matchAll(/^export const (\w+) = gated\("([a-z]+)", (\w+)(?:, "([a-z-]+)")?\);$/gm)];
    expect(wrapped.length).toBe(16); // AUTOFILL2 patch 2 added Autofill (misc); the Guide panel (general) went; Groups (backup)
    for (const [, , part, local] of wrapped)
      expect(SETTINGS_PARTS[part!], `${local} in ${part}`).toContain(importedFrom.get(local!));
    expect(wrapped.map((w) => w[3]).sort()).toEqual([...importedFrom.keys()].sort());
    for (const p of Object.keys(SETTINGS_PARTS))
      expect(
        wrapped.some((w) => w[2] === p),
        p,
      ).toBe(true);
    // and the wrapper draws the component only once its part's text is in (else nothing, or the section's empty frame)
    const gate = parts.slice(
      parts.indexOf("function gated<"),
      parts.indexOf("\n}\n", parts.indexOf("function gated<")),
    );
    expect(gate).toMatch(
      /return function Gated\(props: P\) \{\n\s*if \(usePart\(part\)\) return <Component \{\.\.\.props\} \/>;\n\s*return section \? <section id=\{section\} class="panel" aria-busy="true" \/> : null;\n\s*\};/,
    );
    expect(gate.match(/<Component/g)).toHaveLength(1);
    const use = parts.slice(
      parts.indexOf("function usePart("),
      parts.indexOf("\n}\n", parts.indexOf("function usePart(")),
    );
    expect(use).toMatch(/const isReady = ready\.has\(p\);/);
    expect(use).toMatch(/return isReady;$/);
    // a section's empty frame keeps the section's id (the rail's highlight and links into the page find it)
    for (const [, name, , local, id] of wrapped)
      if (id) expect(file(importedFrom.get(local!)!.slice("src/".length)), name).toContain(`<Panel id="${id}"`);
  });

  it("only parts.tsx imports a part's entry (but for types), and no part imports another part's entry", () => {
    const entries = new Set(Object.values(SETTINGS_PARTS).flat());
    const valueImports = (f: { path: string; text: string }) =>
      [...code(f.text).matchAll(/^import (?!type\b)[^;]*?from "(\.{1,2}\/[^"]+)";/gm)].map(
        (m) => `src/${join(f.path, "..", m[1]!).split("\\").join("/")}.tsx`,
      );
    const importers = new Map<string, string[]>();
    for (const f of files)
      for (const target of valueImports(f))
        if (entries.has(target)) importers.set(target, [...(importers.get(target) ?? []), `src/${f.path}`]);
    for (const e of entries) expect(importers.get(e), e).toEqual(["src/options/parts.tsx"]);
  });

  it("the page draws nothing before its core text, and each view's parts before that view (no part is loaded up front); a lock waits for nothing", () => {
    const main = code(file("options/main.tsx"));
    expect([...main.matchAll(/loadParts\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['["core"]']);
    expect(main).toMatch(/void loadParts\(\["core"\]\)\.then\(\(\) => render\(<App \/>/);
    const app = code(file("options/App.tsx"));
    // the state's parts before the state is shown, awaited only when they are not in yet: a page with a vault has the
    // lock's part from the start (partsFor), so after a lock setStatus follows status() with nothing awaited between
    expect(app).toMatch(
      /const st = await rt\.service\.status\(\);\n\s*const view = partsFor\(st\.state\);\n\s*if \(!partsReady\(view\)\) await loadParts\(view\);\n\s*setStatus\(st\);/,
    );
    expect(app).toMatch(
      /const view = partsFor\("locked"\);\n\s*if \(!partsReady\(view\)\) await loadParts\(view\);\n\s*setStatus\(\{ state: "locked", events: \[\] \}\);/,
    );
    expect(app.match(/loadParts\(/g)).toHaveLength(2);
    expect(app.match(/setStatus\(/g)).toHaveLength(2); // and no other way to show a state
    // nothing else loads a part (the wrappers in parts.tsx load their own)
    const callers = files
      .filter((f) => /\bloadParts\(/.test(code(f.text)))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual(["options/App.tsx", "options/main.tsx", "options/parts.tsx"]);
  });

  it("partsFor: the wizard's text with no vault; with one, whatever its state, the sections' and the lock's", async () => {
    const { partsFor } = await import("../../src/options/parts");
    const vault = ["security", "accounts", "backup", "misc", "general", "unlock"];
    expect(partsFor("empty")).toEqual(["firstrun"]);
    for (const state of ["lost", "unlocked", "locked"] as const) expect(partsFor(state), state).toEqual(vault);
  });

  it("what a view loads together is held to the old 12 KB, in check-dist and messages.py alike: partsFor's parts after the core, and every part", async () => {
    const { partsFor } = await import("../../src/options/parts");
    const dist = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
    const block = /const SETTINGS_VIEWS = \{([^}]*)\};/.exec(dist)![1]!;
    const distViews = Object.fromEntries(
      [...block.matchAll(/^ {2}"([^"]+)": \[([^\]]*)\],$/gm)].map((m) => [
        m[1],
        m[2]!.match(/"([a-z]+)"/g)!.map((x) => x.slice(1, -1)),
      ]),
    ) as Record<string, string[]>;
    expect(distViews).toEqual({
      "with no vault": ["core", ...partsFor("empty")],
      "with a vault": ["core", ...partsFor("unlocked")],
      "every part": PARTS,
    });
    for (const state of ["lost", "locked"] as const)
      expect(["core", ...partsFor(state)]).toEqual(distViews["with a vault"]);
    expect(dist).toMatch(/if \(flavour !== "dev" && gz > FULL_CATALOG_GZ\)/);
    expect(dist).toMatch(/^const FULL_CATALOG_GZ = 12 \* 1024;$/m);
    const py = readFileSync(join(EXT, "scripts/messages.py"), "utf8");
    const agg = py.slice(py.indexOf("AGGREGATES = {"), py.indexOf("\n}\n", py.indexOf("AGGREGATES = {")));
    const pyList = (name: string) => {
      const at = agg.indexOf(`"${name}": [`);
      expect(at, name).toBeGreaterThan(0);
      return agg
        .slice(at, agg.indexOf("]", at))
        .match(/"(settings-[a-z]+)"/g)!
        .map((x) => x.slice(1, -1));
    };
    expect(pyList("settings page with no vault")).toEqual(distViews["with no vault"]!.map((p) => `settings-${p}`));
    expect(pyList("settings page with a vault")).toEqual(distViews["with a vault"]!.map((p) => `settings-${p}`));
    expect(agg).toMatch(/"settings page, every part": \["settings-" \+ p for p in SETTINGS_PARTS\],/);
    expect(agg).not.toMatch(/Sync section/);
    expect(py).toMatch(/^VIEW_LIMIT = 12288$/m);
  });

  it("loadParts: the page's catalog gets each part's text when it is loaded, and nothing before", async () => {
    const { loadParts } = await import("../../src/options/parts");
    const { loadCatalog, setLangChoice, t } = await import("../../src/ui/i18n");
    setLangChoice("en");
    await loadCatalog(async () => ({}));
    const coreKey = placed.core![0]!;
    const backupKey = placed.backup![0]!;
    await loadParts(["core"]);
    expect(t(coreKey)).toBe(full.en[coreKey]!.message);
    expect(t(backupKey)).toBe(backupKey); // not loaded: the key shows itself (the e2e guard reports it)
    await Promise.all([loadParts(["backup"]), loadParts(["backup", "security"])]);
    expect(t(backupKey)).toBe(full.en[backupKey]!.message);
    expect(t(placed.security![0]!)).toBe(full.en[placed.security![0]!]!.message);
    expect(t(coreKey)).toBe(full.en[coreKey]!.message); // and nothing lost on the way
  });
});

// ---- 3. scripts/messages.py ----------------------------------------------------------------------------------------

describe("scripts/messages.py: the placement and the budgets", () => {
  const top = mkdtempSync(join(tmpdir(), "sixkey-messages-"));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  let n = 0;
  /** messages.py in a copy of what it reads, with `alter` applied first. */
  function run(alter: (dir: string) => void = () => undefined) {
    const dir = join(top, `m${++n}`);
    for (const p of [
      "scripts/messages.py",
      "scripts/i18n",
      "manifest.base.json",
      "manifest.dev.json",
      "manifest.e2e.json",
      "src",
    ])
      cpSync(join(EXT, p), join(dir, p), { recursive: true });
    alter(dir);
    const r = spawnSync("python3", ["scripts/messages.py"], { cwd: dir, encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`, dir };
  }
  const fragment = (dir: string, name: string, body: string) => writeFileSync(join(dir, "scripts/i18n", name), body);

  it("on this tree: writes exactly the catalogs the tree has, and reports every catalog within its budget", () => {
    const r = run();
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/catalogs, gzipped \(Node\): settings-core 1\d\d keys, \d+ of 5120 B;/);
    for (const n of readdirSync(join(EXT, "catalogs")))
      expect(readFileSync(join(r.dir, "catalogs", n), "utf8"), n).toBe(readFileSync(join(EXT, "catalogs", n), "utf8"));
    expect(readdirSync(join(r.dir, "catalogs")).sort()).toEqual(readdirSync(join(EXT, "catalogs")).sort());
    for (const l of ["en", "zh_CN"])
      expect(readFileSync(join(r.dir, `_locales/${l}/messages.json`), "utf8")).toBe(
        readFileSync(join(EXT, `_locales/${l}/messages.json`), "utf8"),
      );
  });

  it.each([
    [
      "a key placed twice",
      `PARTS = {"backup": ["cancel"]}\n`,
      /PARTS places 'cancel', which scripts\/i18n\/budget\.py places too \(in 'core'\)/,
    ],
    [
      "a part that does not exist",
      `PARTS = {"nowhere": ["cancel"]}\n`,
      /PARTS names 'nowhere', which is not a part of the settings page/,
    ],
    ["a key that was removed", `PARTS = {"core": ["syncLabel"]}\n`, /PARTS places 'syncLabel', which is removed/],
    ["a key that does not exist", `PARTS = {"core": ["noSuchKey"]}\n`, /PARTS places 'noSuchKey', which is not a key/],
    [
      // the Sync section's catalogs are gone from every build (OWNER-DECISIONS/25): a fragment cannot add to them
      "a table of the removed Sync section's catalogs",
      `SYNC_EN = {"syncZz": "x"}\nSYNC_ZH = {"syncZz": "x"}\n`,
      /scripts\/i18n\/zz\.py: unexpected name\(s\) \['SYNC_EN', 'SYNC_ZH'\]/,
    ],
  ])("refuses %s", (_name, body, message) => {
    const r = run((d) => fragment(d, "zz.py", body));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });

  it("refuses a catalog over its budget (here the unlock part's, with 3 KB of new text that does not compress)", () => {
    const noise = Array.from({ length: 2600 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 20000))).join("");
    const r = run((d) =>
      fragment(d, "zz.py", `EN = {"zzBig": "${noise}"}\nZH = {"zzBig": "${noise}"}\nPARTS = {"unlock": ["zzBig"]}\n`),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/catalog settings-unlock is \d+ B gzipped, over its budget of 3072 B/);
  });

  /** Text that does not compress (and differs from any other call's, so two of them do not compress against each other). */
  const noise = (length: number, seed: number) =>
    Array.from({ length }, (_, i) => String.fromCharCode(0x4e00 + ((seed * 104729 + i * 7919) % 20000))).join("");

  it("refuses what a view loads together over 12 KB, though every part is within its own budget", () => {
    const [a, b] = [noise(700, 1), noise(700, 2)];
    const r = run((d) =>
      fragment(
        d,
        "zz.py",
        `EN = {"zzA": "${a}", "zzB": "${b}"}\nZH = {"zzA": "${a}", "zzB": "${b}"}\nPARTS = {"security": ["zzA"], "backup": ["zzB"]}\n`,
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.out).not.toMatch(/over its budget/);
    expect(r.out).toMatch(/what the settings page with a vault loads together is \d+ B gzipped, over the 12288 B/);
    expect(r.out).toMatch(/nothing was written/);
    expect(readdirSync(r.dir)).not.toContain("catalogs"); // refused before it wrote anything
  });

  it("refuses a manifest name or a getMessage key with no text", () => {
    const m = run((d) =>
      writeFileSync(
        join(d, "manifest.dev.json"),
        readFileSync(join(d, "manifest.dev.json"), "utf8").replace(/\{/, '{"short_name": "__MSG_noSuchName__",'),
      ),
    );
    expect(m.ok).toBe(false);
    expect(m.out).toMatch(/'noSuchName' is named by a manifest or chrome\.i18n\.getMessage but has no text/);
    const g = run((d) => writeFileSync(join(d, "src/zz.ts"), 'chrome.i18n.getMessage("noSuchBadge");\n'));
    expect(g.ok).toBe(false);
    expect(g.out).toMatch(/'noSuchBadge' is named by a manifest or chrome\.i18n\.getMessage but has no text/);
  });
});
