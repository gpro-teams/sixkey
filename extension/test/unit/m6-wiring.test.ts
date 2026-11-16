// The Sync section's views, read as source: the rule that Chrome is asked for the API permission as the first thing a
// click does (permission.ts asking) holds in the views' bindings, not only in the controllers the other tests drive.
// A handler that asked after an await (the gesture spent: Chrome refuses), or a button that starts something needing the
// network without asking, fails here:
//   1. every call that starts something needing the permission's answer (a flow's start, the panel's grant and turnOff,
//      the device list's rename, rejectAll and clearHistory) sits inside the callback of an asking(kit, ...) expression;
//   2. every asking(...) result is used as a handler directly (onClick={x}), or called in a handler with no await
//      before it in that handler;
//   3. the start handlers passed down as props (onEnable, onJoin, onHandOver, onJoinAgain, and the managing flows'
//      openers) are bound directly too.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(__dirname, "../../src/options/sync");
const views = readdirSync(DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ f, text: readFileSync(join(DIR, f), "utf8") }));

/** [start, end) of every `asking(` call's argument list (parentheses matched; no string in these files holds one). */
function askingSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\basking\(/g)) {
    let depth = 0;
    for (let i = m.index! + "asking".length; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        out.push([m.index!, i + 1]);
        break;
      }
    }
  }
  return out;
}

describe("the Sync section's permission wiring", () => {
  it("1. every start, grant, turn-off and device action call is inside an asking(...) callback", () => {
    const stray: string[] = [];
    let found = 0;
    for (const { f, text } of views) {
      const spans = askingSpans(text);
      for (const m of text.matchAll(
        /\b(?:flow|f|flow\.f)\.start\(|\bctl\.(?:grant|permit|turnOff|rename|rejectAll|clearHistory)\(|\bdevices\.(?:rename|rejectAll|clearHistory)\(/g,
      )) {
        found++;
        if (!spans.some(([a, b]) => m.index! > a && m.index! < b))
          stray.push(`${f}: ${text.slice(m.index!, m.index! + 40)}`);
      }
    }
    // enable/join start (section and both views), grant, turn-off; the managing flows' starts (six), rename, reject all,
    // clear history
    expect(found).toBeGreaterThanOrEqual(16);
    expect(stray).toEqual([]);
  });

  it("2. every asking(...) handler is bound directly, or called before any await of its handler", () => {
    const bad: string[] = [];
    for (const { f, text } of views) {
      const names = [...text.matchAll(/const (\w+) = (?:\([^)]*\) => )?asking\(/g)].map((m) => m[1]!);
      for (const n of names) {
        for (const m of text.matchAll(new RegExp(`\\b${n}\\b(?!\\s*=\\s*(?:\\([^)]*\\) => )?asking)`, "g"))) {
          const at = m.index!;
          const before = text.slice(Math.max(0, at - 160), at);
          // bound to a prop or a click, or handed on as an opener (`onApprove: startApprove` in the openers given down)
          const direct =
            /=\{\s*$/.test(before) ||
            /(?:onClick|onSubmit|onJoin|onEnable|onJoinAgain|onHandOver)=\{\s*$/.test(before) ||
            /\bon[A-Z]\w*:\s*$/.test(before);
          const called = text.slice(at + n.length, at + n.length + 2).startsWith("(");
          // called inside a handler: the handler's text from its last "=>" up to the call holds no await
          const handlerBody = before.slice(before.lastIndexOf("=>") + 2);
          if (!direct && !(called && !/\bawait\b|\.then\(/.test(handlerBody)))
            bad.push(`${f}: ${n} at ...${before.slice(-60)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("2b. no asking(...) is reached after an await in the function that reaches it", () => {
    const bad: string[] = [];
    for (const { f, text } of views) {
      for (const m of text.matchAll(/\basking\(/g)) {
        const before = text.slice(0, m.index!);
        if (/(?:=|\breturn|=>)\s*$/.test(before)) continue; // it makes a handler (assigned, returned): checked by 2
        const body = before.slice(before.lastIndexOf("=>") + 2);
        if (/\bawait\b|\.then\(/.test(body)) bad.push(`${f}: ...${before.slice(-80).replace(/\s+/g, " ")}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("3. the start handlers passed down are bound to a click directly", () => {
    const bad: string[] = [];
    for (const { f, text } of views) {
      for (const prop of [
        "onEnable",
        "onJoin",
        "onHandOver",
        "onJoinAgain",
        "onApprove",
        "onKeyOp",
        "onRevoke",
        "onRepair",
        "onFork",
        "onDelete",
        "onFind",
        "onNewCode",
        "onNewPassword",
        "onRotate",
      ]) {
        // the allowed forms: bound to a click (itself, through `open.`, or the handler a parametrised opener returns),
        // passed on as a prop (given a starter), destructured in the signature, typed, returned by act()
        const rest = text
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "")
          .replace(new RegExp(`onClick=\\{(?:open\\.)?${prop}(?:\\}|\\()`, "g"), "")
          .replace(new RegExp(`\\b${prop}=\\{open\\.${prop}\\}`, "g"), "")
          .replace(new RegExp(`\\b${prop}=\\{`, "g"), "")
          .replace(new RegExp(`\\b${prop}\\??: \\([^)]*\\) => (?:\\(\\) => )?void`, "g"), "")
          .replace(new RegExp(`\\b${prop}\\??: \\(\\(\\) => void\\) \\| undefined`, "g"), "")
          .replace(new RegExp(`return (?:open\\.)?${prop}(?: \\?\\?)?`, "g"), "")
          .replace(new RegExp(`\\b${prop}: start[A-Z]\\w*`, "g"), "")
          .replace(new RegExp(`([{,]\\s+)${prop}(?=\\s*[,}])`, "g"), "$1");
        for (const m of rest.matchAll(new RegExp(`\\b${prop}\\b`, "g")))
          bad.push(
            `${f}: ...${rest.slice(Math.max(0, m.index! - 40), m.index! + prop.length + 10).replace(/\s+/g, " ")}`,
          );
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("Phase 0's start over from the Sync section", () => {
  // Starting over erases what is left of an unreadable vault: Phase 0 puts it behind typing DELETE (options/Misc.tsx, the
  // Advanced section's box shown while the vault is lost). The lost-vault card's "Start over" leads there, so every way
  // into the wizard's start over is that confirmed button.
  it("only the Advanced section's confirmed button starts the start-over wizard; the card's leads to it", () => {
    const src = (p: string) => readFileSync(resolve(__dirname, "../../src/options", p), "utf8");
    const starts: string[] = [];
    for (const f of [
      "App.tsx",
      "Misc.tsx",
      "Backup.tsx",
      "Security.tsx",
      "SyncHost.tsx",
      "sync/StatusView.tsx",
      "sync/SyncSection.tsx",
    ]) {
      for (const m of src(f).matchAll(/mode:\s*"startOver"/g)) starts.push(`${f}@${m.index}`);
    }
    expect(starts.filter((x) => !x.startsWith("Misc.tsx@"))).toEqual([]);
    expect(src("Misc.tsx")).toMatch(
      /disabled=\{confirm !== "DELETE"\}[^>]*onClick=\{\(\) => onSetup\(\{ mode: "startOver" \}\)\}/,
    );
    expect(src("sync/StatusView.tsx")).toMatch(/case "start_over_vault":[\s\S]{0,300}location\.hash = "#advanced"/);
  });
});
