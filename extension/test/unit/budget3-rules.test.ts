// Budget work 3's rules about the source and the text (docs/design/notes/BUDGET3-NOTES.md), which no run-time check would
// notice a new line breaking. Comments are not code.
//   1. The security record's kinds by name are security-kinds.ts's, which no page's bundle carries: no module imports it
//      but for its types, so the popup and the side panel hold no list of names (their record knows a kind by its form);
//      every kind a call records is one of them, and every one of them is recorded somewhere (no reservation nobody
//      writes, as oath_on and oath_off were); the settings page's card has a label for each, in its part's text.
//   2. The four merged keys: gone, their one use drawing a key with their very text in both languages (no word changed);
//      "ungrouped" stays itself (not the rail's group name: another meaning).
//   (A third, the Trash's marks, went with the plugin platform.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { popupKeys } from "../../scripts/catalog-keys.mjs";
import { SECURITY_KINDS } from "../../src/core/service/security-kinds";

const EXT = resolve(__dirname, "../..");
const SRC = join(EXT, "src");
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
/** The code without its comments (m2-source-rules.test.ts's way). */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const files = sources().map((p) => {
  const text = readFileSync(p, "utf8");
  return { path: relative(SRC, p).split("\\").join("/"), text, code: code(text) };
});
const file = (p: string) => files.find((f) => f.path === p)!;
const json = (p: string) => JSON.parse(readFileSync(join(EXT, p), "utf8")) as Record<string, { message: string }>;

describe("1. the security record's kinds: by name on the settings page only", () => {
  it("the popup's and the side panel's module graphs hold the record, and not the list of its kinds' names", () => {
    const popup = popupKeys(EXT);
    expect(popup.modules).toContain("src/core/service/security-log.ts");
    expect(popup.modules).not.toContain("src/core/service/security-kinds.ts");
  });

  it("no module imports security-kinds.ts but for its types (no value of it in any page's bundle)", () => {
    const at = files.filter((f) => /["'][^"']*\/security-kinds["']/.test(f.code)).map((f) => f.path);
    expect(at.sort()).toEqual(["core/service/security-log.ts", "options/SecurityCard.tsx"]);
    for (const p of at) {
      const c = file(p).code;
      const typeOnly = /^\s*(?:import|export) type \{[^}]*\} from "[^"]*\/security-kinds";\s*$/;
      for (const m of c.matchAll(/^.*["'][^"']*\/security-kinds["'].*$/gm)) expect(m[0], p).toMatch(typeOnly);
      expect(c, p).not.toMatch(/import\(\s*["'][^"']*security-kinds/);
    }
  });

  /**
   * The typed parameters a call passes on, each from quoted names at its callers (TypeScript holds them to the list
   * there), by module; the recordExport one is checked in recordExport itself (service.ts).
   */
  const PASSED: Record<string, string[]> = {
    "core/service/service.ts": ["failed", "`export_${kind}`", "kind"], // in the order they are written
    "core/service/service-core.ts": ["failed", "used", "kind"], // the last: record()'s own append
    "core/service/pin-admin.ts": ["kind"],
    // (the server sync's flows and engine passed theirs too, until its client went: DV-0b)
  };
  /**
   * The first argument of every call of record(…), the element access ["record"](…), recordAction(…), guarding(…) and
   * the record's own security.append(…), in every module. Not a kind: a definition's typed parameter (`kind: …`), and an
   * object literal, the plugin platform's log entry (PluginSession.record({ at, … }), its own log, the only record()
   * there is in core/plugins, platform/plugins and ui/plugins besides).
   */
  const CALL = /\b(?:record(?:"\])?|recordAction|guarding|security\??\.append)\??\.?\(\s*([^,)]*)/g;
  const calls = () => {
    const out: { at: string; arg: string }[] = [];
    for (const f of files)
      for (const m of f.code.matchAll(CALL)) {
        const arg = m[1]!.trim();
        if (!/^\w+\??:/.test(arg) && !arg.startsWith("{")) out.push({ at: f.path, arg });
      }
    return out;
  };
  /** The name the whole argument is, in quotes; undefined for anything else (a template, an identifier, a cast ...). */
  const quoted = (arg: string) => {
    const m = /^"([^"]*)"$|^'([^']*)'$/.exec(arg);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  it("every call names a kind of the list in quotes, or passes on one of the few typed parameters listed (not vacuous)", () => {
    const all = calls();
    expect(all.length).toBeGreaterThan(25); // (the server sync's flows and engine had a few more, until DV-0b)
    const seen: Record<string, string[]> = {};
    for (const c of all) {
      const name = quoted(c.arg);
      // a template literal, an identifier, a cast or anything else: only the ones listed above
      if (name === undefined) (seen[c.at] ??= []).push(c.arg);
      else expect(SECURITY_KINDS as readonly string[], `${c.at}: ${c.arg}`).toContain(name);
    }
    expect(seen).toEqual(PASSED); // and none listed is gone, so the list cannot go stale
    for (const k of ["unlock_failed", "recovery_failed"]) expect(SECURITY_KINDS as readonly string[]).toContain(k);
    // the PIN switch's two lines went with the switch (OWNER-DECISIONS/20, its second 2026-10-30 note): no call names them
    const where = (k: string) => [...new Set(all.filter((c) => quoted(c.arg) === k).map((c) => c.at))].sort();
    expect(where("pin_restart_on")).toEqual([]);
    expect(where("pin_restart_off")).toEqual([]);
    expect(SECURITY_KINDS as readonly string[]).not.toContain("pin_restart_on");
    expect(SECURITY_KINDS as readonly string[]).not.toContain("pin_restart_off");
  });

  it("every name is recorded somewhere: named in a module other than the list and the card", () => {
    const named = (k: string) =>
      files.some(
        (f) =>
          f.path !== "core/service/security-kinds.ts" &&
          f.path !== "options/SecurityCard.tsx" &&
          new RegExp(`["'\`]${k}["'\`]`).test(f.code),
      );
    // the exports' three are recorded by recordExport, as `export_${kind}`
    const exports = /this\.record\(`export_\$\{kind\}`\)/.test(file("core/service/service.ts").code);
    expect(exports).toBe(true);
    for (const k of SECURITY_KINDS)
      expect(named(k) || (exports && /^export_(encrypted|plain|subset)$/.test(k)), k).toBe(true);
    expect(SECURITY_KINDS as readonly string[]).not.toContain("oath_on");
    expect(SECURITY_KINDS as readonly string[]).not.toContain("oath_off");
  });

  it("the card has a label for every name and for nothing else, each in its part's text (security or core)", () => {
    const c = file("options/SecurityCard.tsx").code;
    const table = c.slice(c.indexOf("const KIND_LABEL"), c.indexOf("};", c.indexOf("const KIND_LABEL")));
    const labels: Record<string, string> = Object.fromEntries(
      [...table.matchAll(/^\s+([a-z_]+): "(\w+)",/gm)].map((m) => [m[1]!, m[2]!]),
    );
    expect(Object.keys(labels).sort()).toEqual([...SECURITY_KINDS].sort());
    for (const loc of ["en", "zh_CN"]) {
      const text = { ...json(`catalogs/settings-core-${loc}.json`), ...json(`catalogs/settings-security-${loc}.json`) };
      for (const [k, key] of Object.entries(labels)) expect(text[key]?.message, `${loc} ${k}`).toBeTruthy();
    }
    // the list shows only an own property of the table (never Object's: "constructor" is a kind's form)
    expect(c).toMatch(/Object\.hasOwn\(KIND_LABEL, e\.kind\)/);
  });
});

describe("2. the four merges: the same words, one key each", () => {
  /** The key gone, the key drawn in its place, that key's text (the gone one's, word for word), and where. */
  type Merge = [gone: string, now: string, en: string, zh: string, where: string, drawn: RegExp];
  const MERGED: Merge[] = [
    ["protPassword", "passwordLabel", "Master password", "主密码", "options/Rail.tsx", /\[3, "passwordLabel", /],
    ["restoreAction", "restore", "Restore", "恢复", "options/Backup.tsx", /t\(canRestore \? "restore" : /],
    ["afsOn", "clipOn", "On", "已开启", "options/Misc.tsx", /r\.on \? t\("clipOn"\) : t\("afsOff"\)/],
  ];
  it.each(MERGED)("%s is gone; its one use draws %s, with the very same text", (gone, now, en, zh, where, drawn) => {
    for (const [loc, text] of [
      ["en", en],
      ["zh_CN", zh],
    ] as const) {
      const full = json(`_locales/${loc}/messages.json`);
      expect(full[gone], `${loc} ${gone}`).toBeUndefined();
      expect(full[now]?.message, `${loc} ${now}`).toBe(text);
    }
    expect(file(where).code).toMatch(drawn);
    expect(files.filter((f) => new RegExp(`["'\`]${gone}["'\`]`).test(f.code)).map((f) => f.path)).toEqual([]);
  });

  it("not merged: the export picker's heading for accounts without a group stays its own key (another meaning)", () => {
    expect(file("options/SubsetPicker.tsx").code).toMatch(/t\("ungrouped"\)/);
    expect(json("catalogs/settings-backup-en.json").ungrouped).toBeDefined();
  });

  it("the YubiKey reservation's labels are gone with it", () => {
    for (const loc of ["en", "zh_CN"])
      for (const k of ["secKOathOn", "secKOathOff"])
        expect(json(`_locales/${loc}/messages.json`)[k], k).toBeUndefined();
  });
});

describe("4. what the 15,360 B check of a vault's page counts (the comments say so: BUDGET3-NOTES.md §6)", () => {
  const py = readFileSync(join(EXT, "scripts/messages.py"), "utf8");
  const dist = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
  const VAULT = ["core", "security", "accounts", "backup", "misc", "general", "unlock"];
  it("messages.py: a vault's view (the core and six parts) with the three lazy catalogs, not the first-run part", () => {
    const vault = py.slice(py.indexOf("VAULT_VIEW = ["), py.indexOf("]", py.indexOf("VAULT_VIEW = [")));
    expect([...vault.matchAll(/"([a-z-]+)"/g)].map((m) => m[1])).toEqual(VAULT.map((p) => `settings-${p}`));
    expect(py).toMatch(/^DEVICE_VIEW = VAULT_VIEW \+ \["device"\]$/m);
    expect(py).toMatch(/^PLUGINS_VIEW = DEVICE_VIEW \+ \["plugins", "restart"\]$/m);
    expect(py).toMatch(/^LAZY_PAGE_LIMIT = 15360$/m);
  });
  it("check-dist: the same catalogs, in the same order, held to the same 15,360 B", () => {
    const at = dist.indexOf("// a vault's page with the plugins' text and every other lazy catalog in, as one gzip");
    const block = dist.slice(at, dist.indexOf("if (names.some", at));
    expect(block).toContain(`...[${VAULT.map((p) => `"${p}"`).join(", ")}].map((part) =>`);
    expect([...block.matchAll(/`([a-z]+)-locale-\$\{loc\}-`/g)].map((m) => m[1])).toEqual([
      "device",
      "plugins",
      "restart",
    ]);
    expect(code(block)).not.toContain("firstrun"); // its comment says so; its code counts none of it
    expect(dist).toMatch(/^const LAZY_PAGE_GZ = 15 \* 1024;$/m);
  });
});
