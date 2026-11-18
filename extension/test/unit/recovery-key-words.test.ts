// The recovery code is called the recovery key (OWNER-DECISIONS/16, question C, 2026-10-23; scripts/i18n/recoverykey.py):
// "Recovery key" / "恢复密钥", its shares "Recovery key shares" / "恢复密钥分片". Only the words the person sees changed;
// storage keys, security-log kinds, error codes, message types, the contract and the code's names keep "recovery code",
// so this looks at the text only: every text of every fragment (scripts/i18n/*.py) and every catalog made from them.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const OLD = /恢复码|recovery[\s-]?codes?\b/i;

// base.py is frozen (no package edits it): its texts that say the old word are rewritten (recoverykey.py) or removed (a4.py)
// by a fragment. These are the only texts of the old word left in scripts/i18n/, and none of them reaches a catalog.
const BASE_SUPERSEDED = [
  "recoveryTitle",
  "recoveryLabel",
  "useRecovery",
  "wrongRecovery",
  "badRecoveryFormat",
  "lockHint",
  "passwordLossWarning",
  "newCodeTitle",
  "newCodeBody",
  "newCodeAction",
  "rotateBody",
  "recoveryShownTitle",
  "recoverySavedCheck",
  "stepRecovery",
  "newRecoveryTitle", // removed (a4.py)
  "newRecoveryBody", // removed (a4.py)
].sort();

type Tables = Record<string, Record<string, string> | string[]>;
/** Every fragment's tables, read by path with runpy, as scripts/messages.py reads them. */
function fragments(): Record<string, Tables> {
  const dir = join(EXT, "scripts/i18n");
  const paths = readdirSync(dir)
    .filter((n) => n.endsWith(".py"))
    .map((n) => join(dir, n));
  const py =
    "import json, os, runpy, sys\n" +
    "out = {}\n" +
    "for p in sys.argv[1:]:\n" +
    "    g = runpy.run_path(p)\n" +
    "    out[os.path.basename(p)] = {k: v for k, v in g.items() if k.isupper() and isinstance(v, (dict, list))}\n" +
    "print(json.dumps(out, ensure_ascii=False))\n";
  const r = spawnSync("python3", ["-I", "-c", py, ...paths], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, Tables>;
}
const texts = (t: Tables) =>
  Object.entries(t).flatMap(([table, d]) =>
    Array.isArray(d) || table === "PARTS" ? [] : Object.entries(d).map(([k, v]) => ({ table, k, v })),
  );

describe("the recovery key's name in the text", () => {
  const all = fragments();

  it("no fragment's text says “recovery code” or “恢复码”, but base.py's frozen texts that a fragment replaces", () => {
    expect(Object.keys(all).length).toBeGreaterThan(30); // not vacuous: every fragment was read
    const hits: string[] = [];
    for (const [file, t] of Object.entries(all))
      for (const { table, k, v } of texts(t)) if (OLD.test(v)) hits.push(`${file} ${table} ${k}`);
    const base = hits.filter((h) => h.startsWith("base.py "));
    expect(hits.filter((h) => !h.startsWith("base.py "))).toEqual([]);
    // the allowance is exactly base.py's texts of the old word: none hides elsewhere, none is left over
    expect([...new Set(base.map((h) => h.split(" ")[2]!))].sort()).toEqual(BASE_SUPERSEDED);
  });

  it("each of base.py's texts of the old word is rewritten in both languages, or removed, by a fragment", () => {
    const over = (lang: "EN" | "ZH") =>
      new Set(Object.values(all).flatMap((t) => Object.keys((t[`OVERRIDE_${lang}`] as Record<string, string>) ?? {})));
    const removed = new Set(Object.values(all).flatMap((t) => (t.REMOVE as string[] | undefined) ?? []));
    const en = over("EN");
    const zh = over("ZH");
    expect(BASE_SUPERSEDED.filter((k) => !removed.has(k) && !(en.has(k) && zh.has(k)))).toEqual([]);
  });

  it("no catalog made from them says it either: _locales and every catalogs/*.json, both languages", () => {
    const files = [
      "_locales/en/messages.json",
      "_locales/zh_CN/messages.json",
      ...readdirSync(join(EXT, "catalogs"))
        .filter((n) => n.endsWith(".json"))
        .map((n) => `catalogs/${n}`),
    ];
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const f of files)
      for (const [k, { message }] of Object.entries(
        JSON.parse(readFileSync(join(EXT, f), "utf8")) as Record<string, { message: string }>,
      ))
        if (OLD.test(message)) hits.push(`${f} ${k}`);
    expect(hits).toEqual([]);
  });

  it("the new words are there: the field's label, the shares' title, the printed share", () => {
    const cat = (f: string) => JSON.parse(readFileSync(join(EXT, f), "utf8")) as Record<string, { message: string }>;
    expect(cat("_locales/en/messages.json").recoveryLabel!.message).toBe("Recovery key");
    expect(cat("_locales/zh_CN/messages.json").recoveryLabel!.message).toBe("恢复密钥");
    expect(cat("_locales/en/messages.json").sharesFoldTitle!.message).toBe("Recovery key shares");
    expect(cat("_locales/zh_CN/messages.json").sharesFoldTitle!.message).toBe("恢复密钥分片");
    expect(cat("catalogs/shares-en.json").shPaperTitle!.message).toBe("Sixkey recovery key share $1 of $2");
    expect(cat("catalogs/shares-zh_CN.json").shPaperTitle!.message).toBe("Sixkey 恢复密钥分片 第 $1 份，共 $2 份");
  });

  it("the file a new recovery key is saved as is named for the key, in its one place (the settings page's shared box)", () => {
    const src = join(EXT, "src");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const found = walk(src)
      .filter((p) => /\.tsx?$/.test(p))
      .flatMap((p) =>
        [...readFileSync(p, "utf8").matchAll(/download\(\s*`(sixkey-recovery-[a-z]+)-/g)].map(
          (m) =>
            `${p
              .slice(src.length + 1)
              .split("\\")
              .join("/")}: ${m[1]}`,
        ),
      );
    // (the settings page's Sync section saved one too, until it went from every build: OWNER-DECISIONS/25)
    expect(found).toEqual(["options/shared.tsx: sixkey-recovery-key"]);
  });
});
