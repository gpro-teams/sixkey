// Rules about the source for the PIN's record (OWNER-DECISIONS/20 and its 2026-10-30 notes; PIN-RESTART-NOTES.md), which
// hold by construction and which no run-time check would notice a new line breaking. Comments are not code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { popupKeys } from "../../scripts/catalog-keys.mjs";
import { PBKDF2_MAX_ITERATIONS, PBKDF2_MIN_ITERATIONS } from "../../src/core/crypto/kdf";
import { QUICK_TRIES, wrapsTag } from "../../src/core/crypto/pin";
import { RESTART_TRIES } from "../../src/core/service/pin-restart-steps";
import { RESTART_KEY } from "../../src/core/service/pin-store";
import { SETTINGS_KEY } from "../../src/core/service/types";

const EXT = resolve(__dirname, "../..");
const ROOT = join(EXT, "src");
function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const files = sources().map((p) => {
  const text = readFileSync(p, "utf8");
  return { path: relative(ROOT, p).split("\\").join("/"), text, code: code(text) };
});
const where = (re: RegExp) => files.filter((f) => re.test(f.code)).map((f) => f.path);
const file = (p: string) => files.find((f) => f.path === p)!;
/** The value imports of a module (type-only ones are erased and load nothing). */
const imports = (p: string) =>
  [...file(p).code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]!);
/** The spans of every call of `fn(`, up to its matching parenthesis. */
const spans = (c: string, fn: RegExp) => {
  const out: [number, number][] = [];
  for (const m of c.matchAll(fn)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < c.length; end++) {
      if (c[end] === "(") depth++;
      else if (c[end] === ")" && --depth === 0) break;
    }
    out.push([m.index!, end]);
  }
  return out;
};

/**
 * The modules the popup and the side panel load for the record outside their counted bundle, which import nothing of the
 * popup's main chunk (PIN-RESTART-NOTES.md §8: SHAMIR-NOTES.md §7's lesson): only each other, the leaf crypto-error.ts,
 * preact and the lazy helpers. The rules of the main chunk reach them as the kit the lock screen hands them (pin-kit.ts).
 * pin-restart-count.ts is in the lock screen's own chunk (imported by it), the others are lazy chunks.
 */
const LAZY = {
  "core/service/pin-restart-count.ts": [],
  "core/crypto/pin-restart-wrap.ts": ["./crypto-error"],
  "core/service/pin-restart-steps.ts": ["../crypto/crypto-error", "../crypto/pin-restart-wrap"],
};

describe("the PIN record's sources", () => {
  it('"sk_pin_restart" is spelled in local-keys.ts (and restated in the lock screens\' steps); written only in the vault lock', () => {
    expect(where(/"sk_pin_restart"/).sort()).toEqual([
      "core/service/pin-restart-count.ts",
      "core/service/pin-restart-steps.ts",
      "core/storage/local-keys.ts",
    ]);
    for (const p of ["core/service/pin-restart-steps.ts", "core/service/pin-restart-count.ts"])
      expect(file(p).code, p).toMatch(/^const KEY = "sk_pin_restart";$/m);
    expect(RESTART_KEY).toBe("sk_pin_restart");
    // the writers: the lock screens' steps (the record's own unlock and note), the settings page's admin; nothing else,
    // and nothing of the popup's counted bundle (the PIN store only names the key); what the PIN offers writes nothing
    const names = files.filter((f) => /\bRESTART_KEY\b/.test(f.code) || /const KEY = "sk_pin_restart";/.test(f.code));
    const writers = names
      .filter((f) => /\[(RESTART_KEY|KEY)\]\s*:/.test(f.code) || /remove\(\[(RESTART_KEY|KEY)\]\)/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(writers).toEqual(["core/service/pin-restart-admin.ts", "core/service/pin-restart-steps.ts"]);
    // each write sits inside a lock(...) section: the PIN store's own (this.lock), or its lock taken by element access
    let checked = 0;
    for (const p of writers) {
      const c = file(p).code;
      const locked = spans(c, /\b(?:this\.lock|store\.lock|lock)\(/g);
      for (const m of c.matchAll(/kv\.(set|remove)\(\s*(?:\{\s*\[(?:RESTART_KEY|KEY)\]|\[(?:RESTART_KEY|KEY)\])/g)) {
        checked++;
        expect(
          locked.some(([a, b]) => a < m.index! && m.index! < b),
          `${p}: ${c.slice(m.index!, m.index! + 60)}`,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it("the lazy modules import nothing of the popup's main chunk (only each other, the leaf crypto-error.ts and helpers)", () => {
    for (const [p, allowed] of Object.entries(LAZY)) expect(imports(p).sort(), p).toEqual([...allowed].sort());
    // the steps take the service's own steps by element access, and pin.ts's rules from the kit, not by import
    const steps = file("core/service/pin-restart-steps.ts").code;
    expect(steps).toMatch(/s\["finishUnlock"\]/);
    expect(steps).toMatch(/kit\.derivePinKek\(/);
    expect(steps).toMatch(/kit\.restartState\(/);
    // the kit is made where the popup's counted bundle is not: the screens' lazy chunk and the settings page
    const kitters = files.filter((f) => imports(f.path).some((m) => m.endsWith("/pin-kit"))).map((f) => f.path);
    expect(kitters.sort()).toEqual(["options/UnlockBar.tsx", "popup/screens/Locked.tsx"]);
  });

  it("the pages load it by import() only: the lock screens the unlock, the settings page the PIN box's lazy part", () => {
    for (const [p, chunk] of [
      ["popup/screens/Locked.tsx", "../../core/service/pin-restart-steps"],
      ["options/UnlockBar.tsx", "../core/service/pin-restart-steps"],
      ["options/PinBox.tsx", "./PinRestartBox"],
      ["options/SecurityCard.tsx", "./PinRestartBox"],
    ] as const) {
      expect(file(p).code, p).toContain(`import("${chunk}")`);
      expect(imports(p), p).not.toContain(chunk);
    }
    expect(where(/from\s+"[^"]*PinRestartBox"/)).toEqual([]);
    expect(where(/from\s+"[^"]*pin-restart-steps"/)).toEqual([]);
    // what the PIN offers (no crypto) comes with the popup's lock screen, imported by it only (the settings page's unlock
    // bar has it from PinAdmin.state)
    expect(where(/from\s+"[^"]*pin-restart-count"/).sort()).toEqual(["popup/screens/Locked.tsx"]);
    expect(where(/from\s+"[^"]*pin-restart-admin"/).sort()).toEqual([
      "core/service/pin-admin.ts",
      "core/service/service.ts",
      "options/PinRestartBox.tsx",
    ]);
    // its text, the settings page's only (the lock screen's line is the main catalog's lockPinWaiting since 2026-10-30)
    expect(where(/from\s+"[^"]*restart-popup-text"/)).toEqual([]);
    expect(where(/from\s+"[^"]*restart-text"/)).toEqual(["options/PinRestartBox.tsx"]);
  });

  it("the restated constants agree with their sources", () => {
    const wrap = file("core/crypto/pin-restart-wrap.ts").code;
    expect(+/^const MIN_ITERATIONS = ([\d_]+);$/m.exec(wrap)![1]!.replace(/_/g, "")).toBe(PBKDF2_MIN_ITERATIONS);
    expect(+/^const MAX_ITERATIONS = ([\d_]+);$/m.exec(wrap)![1]!.replace(/_/g, "")).toBe(PBKDF2_MAX_ITERATIONS);
    expect(+/^const TRIES = (\d+);$/m.exec(wrap)![1]!).toBe(QUICK_TRIES);
    expect(RESTART_TRIES).toBe(QUICK_TRIES);
    const count = file("core/service/pin-restart-count.ts").code;
    expect(+/^const TRIES = (\d+);$/m.exec(count)![1]!).toBe(QUICK_TRIES);
    expect(/^const SETTINGS = "([^"]+)";$/m.exec(count)![1]).toBe(SETTINGS_KEY);
    // no 14 days (OWNER-DECISIONS/20, 2026-10-30): nothing of the PIN's record counts a time
    expect(count).not.toMatch(/DAYS_14|86_400_000/);
    // the steps' wraps tag: one function (pin.ts wrapsTag), handed in the kit; the lazy side never computes it itself
    expect(file("core/service/pin-restart-steps.ts").code).not.toMatch(/\.wrapped\)\.join/);
    expect(file("core/service/pin-restart-steps.ts").code).toMatch(/kit\.wrapsTag\(/);
    expect(wrapsTag({ wraps: [{ wrapped: "A" }, { wrapped: "B" }] })).toBe("A,B");
  });

  it("no floor of its own on the PIN's length (OWNER-DECISIONS/20, 2026-10-30): its modules never compare one", () => {
    // the PIN's rule is its policy's alone (pin-policy.ts checkPinPolicy, pin.ts normalizePin: 4 to 8 digits), with the
    // switch on as off: nothing of the switch, the record, its steps, the PIN box or the PIN's admin weighs its digits
    const mine = [
      "core/crypto/pin-restart.ts",
      "core/crypto/pin-restart-wrap.ts",
      "core/service/pin-restart-admin.ts",
      "core/service/pin-restart-count.ts",
      "core/service/pin-restart-steps.ts",
      "core/service/pin-admin.ts",
      "options/PinBox.tsx",
      "options/PinRestartBox.tsx",
      "popup/screens/Locked.tsx",
      "options/UnlockBar.tsx",
    ];
    for (const p of mine) {
      expect(file(p), p).toBeDefined();
      expect(file(p).code, p).not.toMatch(/\b(?:digits|pin\.length)\s*[<>]=?/);
      expect(file(p).code, p).not.toMatch(/_DIGITS\b|digitsOk|short_pin|rsSix/);
    }
  });

  it("nothing in its modules writes to the console or the diagnostics log with a secret", () => {
    for (const p of [
      ...Object.keys(LAZY),
      "core/crypto/pin-restart.ts",
      "core/service/pin-restart-admin.ts",
      "core/service/pin-kit.ts",
      "core/service/pin-store.ts",
      "options/PinRestartBox.tsx",
    ]) {
      expect(file(p).code, p).not.toMatch(/console\./);
      for (const m of file(p).code.matchAll(/(?:logError|diag|onDiag)\(([^)]*)\)/g))
        expect(m[1]!.replace(/"[^"]*"/g, '""'), `${p}: ${m[0]}`).not.toMatch(
          /\b(pin|input|pinKek|kek|vk|raw|secret|typed|password)\b/,
        );
    }
  });

  it("verifyPassword knows nothing of it, and the service never loads a chunk for it", () => {
    const s = file("core/service/service.ts").code;
    const at = s.indexOf("  async verifyPassword(");
    expect(s.slice(at, s.indexOf("\n  }\n", at))).not.toMatch(/restart|Restart/);
    for (const p of ["core/service/service.ts", "core/service/service-core.ts"])
      expect(file(p).code, p).not.toMatch(/import\(/);
  });

  it("one PIN, one way (OWNER-DECISIONS/20, its second 2026-10-30 note): the lock screens ask the record only; no session PIN", () => {
    for (const p of ["popup/screens/Locked.tsx", "options/UnlockBar.tsx"])
      expect(file(p).code, p).toMatch(
        /\(await pinSteps\(\)\)\.unlock\((?:rt|ctx\.rt)\.service, (?:pin|value), pinKit\)/,
      );
    expect(where(/\bunlockWithPin\b|\bsessionTry\b|\bsealQuick\b|\bopenQuick\b/)).toEqual([]);
    // sk_quick is the gate's alone: nothing seals a PIN's arming in it
    expect(file("core/crypto/pin.ts").code).not.toMatch(/method: "pin"|triesLeft/);
  });

  it("the popup's counted bundle knows only the record's key: its main chunk's modules import none of its rules or steps", () => {
    for (const p of [
      "core/service/service-core.ts",
      "core/service/pin-store.ts",
      "platform/runtime-base.ts",
      "popup/load.ts",
      "popup/App.tsx",
    ])
      for (const m of imports(p)) expect(/pin-restart|pin-kit/.test(m), `${p} imports ${m}`).toBe(false);
    // openView only keeps what it read (seen): the PIN's rules are the lock screen's chunk's
    const c = file("core/service/service-core.ts").code;
    expect(c).toMatch(/this\.seen = r;/);
    expect(c).not.toMatch(/restartState|parsePinRecord/);
  });
});

describe("the popup's own module graph", () => {
  let popup: { modules: string[] };
  beforeAll(() => {
    popup = popupKeys(EXT);
  }, 30_000);
  it("can load the record's steps (lazily), but not the PIN box's lazy part, its admin or its text", () => {
    expect(popup.modules).toContain("src/core/service/pin-restart-steps.ts");
    expect(popup.modules).not.toContain("src/options/PinRestartBox.tsx");
    expect(popup.modules).not.toContain("src/core/service/pin-restart-admin.ts");
    expect(popup.modules).not.toContain("src/ui/restart-text.ts");
  });
});
