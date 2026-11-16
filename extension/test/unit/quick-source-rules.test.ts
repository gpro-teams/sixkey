// Rules about the source for the session PIN and the quick lock (QUICK-UNLOCK §7.1 "Source rules", §5.12), which hold
// by construction and which no run-time check would notice a new line breaking. Comments are not code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { popupKeys } from "../../scripts/catalog-keys.mjs";

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

describe("the session quick unlock's records", () => {
  it('"sk_quick" is spelled in platform/session.ts only, and only ChromeSessionCache reads or writes it, on its own area', () => {
    expect(where(/sk_quick/)).toEqual(["platform/session.ts"]);
    const s = file("platform/session.ts").code;
    expect(s.match(/QUICK_KEY/g)).toHaveLength(6); // the constant, get (twice), set, remove, and quickChanged's test
    for (const m of s.matchAll(/^.*QUICK_KEY.*$/gm)) {
      const line = m[0].trim();
      if (/^const QUICK_KEY = "sk_quick";$/.test(line)) continue;
      if (line.startsWith("export const quickChanged =")) {
        expect(line).toMatch(/=> QUICK_KEY in changes \|\| EPOCH_KEY in changes;$/); // reads a change set, writes nothing
        continue;
      }
      expect(line, line).toMatch(/this\.area\./);
    }
    // that area is chrome.storage.session: its default, and the one the runtime passes (RuntimeStorage.session)
    expect(s).toMatch(/constructor\(private readonly area: chrome\.storage\.StorageArea = chrome\.storage\.session\)/);
    // (in the wiring every context shares, platform/runtime-base.ts, since the budget relief)
    expect(where(/new ChromeSessionCache\(/)).toEqual(["platform/runtime-base.ts"]);
    expect(file("platform/runtime-base.ts").code).toMatch(/new ChromeSessionCache\(o\.session\)/);
    // the routed session hands sk_quick to that layer only: never to a page's memory
    const routed = s.slice(s.indexOf("export class RoutedSession"));
    for (const m of ["getQuick()", "setQuick(q: QuickSession)", "clearQuick()"]) {
      const body = routed.slice(routed.indexOf(`  ${m} {`), routed.indexOf("\n  }", routed.indexOf(`  ${m} {`)));
      expect(body, m).toMatch(/return this\.persistent\.\w+Quick\(/);
      expect(body, m).not.toMatch(/memory/);
    }
  });

  it('"sk_pin" is spelled in core/sync/local/keys.ts only; it is written only by pin-store.ts, under the vault lock', () => {
    expect(where(/"sk_pin"/)).toEqual(["core/sync/local/keys.ts"]);
    // the service names it for loadView's first read (its unlock side, service-core.ts), the PIN box to notice a change;
    // neither writes it
    expect(where(/\bPIN_KEY\b/).sort()).toEqual([
      "core/service/pin-store.ts",
      "core/service/service-core.ts",
      "options/PinBox.tsx",
    ]);
    expect(file("options/PinBox.tsx").code).not.toMatch(/\.(set|remove)\(\s*\{?\s*\[?PIN_KEY/);
    expect(file("core/service/service-core.ts").code.match(/PIN_KEY/g)!.length).toBeGreaterThan(0);
    expect(file("core/service/service-core.ts").code).not.toMatch(/\{\s*\[PIN_KEY\]\s*:|remove\(\[PIN_KEY/);
    const store = file("core/service/pin-store.ts").code;
    const writes = [...store.matchAll(/this\.kv\.(set|remove)\(/g)];
    expect(writes.length).toBeGreaterThanOrEqual(3);
    // every write sits inside a this.lock(...) section
    for (const m of ["write(rec: PinRecord)", "remove()", "reencrypt(current: Vk, held: readonly Vk[])"]) {
      const at = store.indexOf(`  ${m}`);
      const body = store.slice(at, store.indexOf("\n  }\n", at));
      expect(body, m).toMatch(/return this\.lock\(/);
    }
    expect(store.slice(0, store.indexOf("  write(rec"))).not.toMatch(/this\.kv\.(set|remove)\(/);
  });

  it("sk_quick (the gate's arming only, since the PIN is its record's: OWNER-DECISIONS/20, 2026-10-30) is written only by the service's own steps (service-core.ts and service.ts, device-admin.ts and pin-restart-steps.ts which reuse them), each inside the quick lock", () => {
    // arming is in the part of the service the popup builds (service-core.ts); the hard lock, the quiet end and the
    // expiry alarm's sweep only clear it, in VaultService (service.ts). The enrolment of a gate arms it (device-admin.ts:
    // the master password was just typed), and the device box's removal and choice of method clear it (device-admin.ts;
    // the device unlock ends an arming through the service's dropIfSame: device-unlock.ts writes it no more); the 5th
    // wrong PIN ends it (pin-restart-steps.ts: whatever ends the PIN ends the gate, OWNER-DECISIONS/17 Q1)
    const callers = where(/\.setQuick\(/).sort();
    expect(callers).toEqual(["core/service/device-admin.ts", "core/service/service-core.ts", "platform/session.ts"]);
    expect(where(/\.clearQuick\(/).sort()).toEqual([
      "core/service/device-admin.ts",
      "core/service/pin-restart-steps.ts",
      "core/service/service-core.ts",
      "core/service/service.ts",
      "platform/session.ts",
    ]);
    /** The spans of every call of the quick lock: `quickLock(` / `this.quick(` up to its matching parenthesis. */
    const locked = (c: string) => {
      const spans: [number, number][] = [];
      for (const m of c.matchAll(/(?:this\.quickLock|this\.quick|(?:this\.)?s\["quickLock"\])\(/g)) {
        let depth = 0;
        let end = m.index! + m[0].length - 1;
        for (; end < c.length; end++) {
          if (c[end] === "(") depth++;
          else if (c[end] === ")" && --depth === 0) break;
        }
        spans.push([m.index!, end]);
      }
      return spans;
    };
    const lockers = [
      "core/service/service-core.ts",
      "core/service/service.ts",
      "core/service/pin-admin.ts",
      "core/service/device-admin.ts",
      "core/service/device-unlock.ts",
      "core/service/pin-restart-steps.ts",
    ];
    let checked = 0;
    for (const p of lockers) {
      const c = file(p).code;
      const spans = locked(c);
      for (const m of c.matchAll(/\.(setQuick|clearQuick)\(/g)) {
        checked++;
        const line = c.slice(c.lastIndexOf("\n", m.index!) + 1, c.indexOf("\n", m.index!));
        expect(
          spans.some(([a, b]) => a < m.index! && m.index! < b),
          `${p}: ${line.trim()}`,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    // and a section under the quick lock touches the session cache and nothing else: never the store, the PIN store, the
    // settings or the security record, so the lock order stays vault, then quick (webLock is not re-entrant)
    let sections = 0;
    for (const p of lockers) {
      const c = file(p).code;
      for (const [a, b] of locked(c)) {
        const body = c.slice(a, b);
        if (body === 'this.s["quickLock"](fn') continue; // the admins' own forwarders; their callers are the sections
        sections++;
        expect(body, `${p}: ${body.slice(0, 80)}`).not.toMatch(/store|pins|settings|transact|\bkv\b|record\(|security/);
        expect(body, `${p}: ${body.slice(0, 80)}`).toMatch(/session/);
      }
    }
    expect(sections).toBeGreaterThanOrEqual(10);
  });

  it("verifyPassword is untouched by the PIN: it checks the password wrap and nothing else", () => {
    const s = file("core/service/service.ts").code;
    const at = s.indexOf("  async verifyPassword(");
    const body = s.slice(at, s.indexOf("\n  }\n", at));
    expect(body).toMatch(/openWithPassword\(keyring, password\)/); // the password wrap: as typed or its generator spelling
    expect(body).not.toMatch(/Pin|pin|quick|Quick/);
  });

  it("no new module writes to the console or the diagnostics log with what was typed", () => {
    for (const p of [
      "core/crypto/pin.ts",
      "core/crypto/pin-policy.ts",
      "core/service/pin-store.ts",
      "core/service/pin-admin.ts",
      "options/PinBox.tsx",
      "options/UnlockBar.tsx",
      "popup/screens/Locked.tsx",
    ]) {
      expect(file(p).code, p).not.toMatch(/console\./);
      for (const m of file(p).code.matchAll(/(?:logError|diag|onDiag)\(([^)]*)\)/g))
        expect(m[1]!.replace(/"[^"]*"/g, '""'), `${p}: ${m[0]}`).not.toMatch(/\b(pin|value|pw|input|password)\b/);
    }
  });
});

describe("the lock screen's PIN field (§6.4)", () => {
  it("one password-type field with numeric input, autocomplete off, a visible label and the tries-left line linked", () => {
    const l = file("popup/screens/Locked.tsx").code;
    // a password field; only the recovery code can be shown, by its own Show (ENROLL-V2-NOTES.md), never the PIN or password
    expect(l).toMatch(/type=\{shown \? "text" : "password"\}/);
    expect(l).toMatch(/const shown = mode === "recovery" && show;/);
    expect(l.match(/type=\{[^}]*"text"/g)).toHaveLength(1);
    expect(l).toMatch(/inputMode=\{pin \? "numeric" : undefined\}/);
    expect(l).toMatch(/autocomplete="off"/);
    expect(l).toMatch(/aria-describedby=\{pin \? "pin-tries" : undefined\}/);
    // (its id names the master password's grouped boxes, when the input hint shows them: PASSWORD-SETUP-NOTES §8.3)
    expect(l).toMatch(/<label for=\{pin \? "pin" : "secret"\} id="lock-label">/);
    expect(l).toMatch(/role="alert"/);
    expect(l).not.toMatch(/onPaste/); // paste is allowed
    // emptied the moment a PIN is submitted, before the answer
    const at = l.indexOf("async function tryPin(");
    expect(l.slice(at, l.indexOf("\n", l.indexOf("{", at) + 1) + 60)).toMatch(/setValue\(""\)/);
  });
});

describe("the quick lock (§5.12)", () => {
  it("the manifest declares the `lock` command with Alt+Shift+L and a description, beside Alt+Shift+K; no permission for it", () => {
    const m = JSON.parse(readFileSync(join(EXT, "manifest.base.json"), "utf8"));
    expect(m.commands).toEqual({
      _execute_action: { suggested_key: { default: "Alt+Shift+K" } },
      lock: { suggested_key: { default: "Alt+Shift+L" }, description: "__MSG_cmdLock__" },
      // TOTP autofill, Stage 1: the Fill shortcut (test/unit/autofill1-source-rules.test.ts)
      fill: { suggested_key: { default: "Alt+Shift+F" }, description: "__MSG_cmdFill__" },
    });
    // (sidePanel: the side panel mode, docs/design/notes/SIDEPANEL-NOTES.md; not the shortcut's)
    expect(m.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "activeTab",
      "alarms",
      "idle",
      "offscreen",
      "sidePanel",
    ]);
    // TOTP autofill's `scripting` (Stage 1): optional since wave 1b of the plugin platform (PLUGINS-W1B-NOTES.md)
    expect(m.optional_permissions).toContain("scripting");
  });
  it("the worker registers onCommand at the top level, and the command is the soft lock (lock()), never a hard one", () => {
    const sw = file("background/sw.ts").code;
    expect(sw).toMatch(/^chrome\.commands\.onCommand\.addListener\(/m);
    const at = sw.indexOf("chrome.commands.onCommand.addListener(");
    const body = sw.slice(at, sw.indexOf("});", at));
    expect(body).toMatch(/command === LOCK_COMMAND\) void rt\.service\.lock\(\)/);
    expect(body).not.toMatch(/hardLock|endQuick|clearQuick/);
    expect(sw).toMatch(/const LOCK_COMMAND = "lock";/);
  });
  it("open pages watch the lock epoch and drop what they show: the popup's list and the settings page", () => {
    for (const p of ["popup/App.tsx", "options/App.tsx"]) {
      const a = file(p).code;
      expect(a, p).toMatch(/LOCK_EPOCH_KEY in c/);
      expect(a, p).toMatch(/onChanged\.addListener\(changed\)/);
      expect(a, p).toMatch(/onChanged\.removeListener\(changed\)/);
    }
    expect(file("platform/session.ts").code).toMatch(/export const LOCK_EPOCH_KEY = EPOCH_KEY;/);
  });
});

describe("the popup's bundle", () => {
  let popup: { modules: string[] };
  beforeAll(() => {
    popup = popupKeys(EXT);
  });
  it("carries the unlock side only: not the PIN policy, not the PIN box's operations", () => {
    expect(popup.modules).toContain("src/core/crypto/pin.ts"); // not vacuous
    expect(popup.modules).toContain("src/core/service/service-core.ts");
    // nor the rest of the service: the hard lock, the expiry sweep and the settings page's operations (budget relief)
    expect(popup.modules).not.toContain("src/core/service/service.ts");
    expect(popup.modules).not.toContain("src/core/crypto/pin-policy.ts");
    expect(popup.modules).not.toContain("src/core/service/pin-admin.ts");
    expect(popup.modules).not.toContain("src/options/PinBox.tsx");
  });
});
