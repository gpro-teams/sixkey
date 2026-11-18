// Phase 0's start over, read as source. Starting over erases what is left of an unreadable vault: Phase 0 puts it behind
// typing DELETE (options/Misc.tsx, the Advanced section's box shown while the vault is lost), so every way into the
// wizard's start over is that confirmed button. (The settings page's Sync section, whose views M6 held to the same rule
// here, and whose lost-vault card led to that button, is gone from every build: OWNER-DECISIONS/25.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(__dirname, "../../src/options");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

describe("Phase 0's start over", () => {
  it("only the Advanced section's confirmed button starts the start-over wizard", () => {
    const starts: string[] = [];
    for (const f of files(DIR))
      for (const m of readFileSync(f, "utf8").matchAll(/mode:\s*"startOver"/g))
        starts.push(
          `${f
            .slice(DIR.length + 1)
            .split("\\")
            .join("/")}@${m.index}`,
        );
    // the wizard's own type names the mode (FirstRun.tsx SetupStart); Misc.tsx's button is the one start
    expect(starts.filter((x) => !x.startsWith("Misc.tsx@") && !x.startsWith("FirstRun.tsx@"))).toEqual([]);
    expect(starts.filter((x) => x.startsWith("Misc.tsx@"))).toHaveLength(1);
    expect(readFileSync(join(DIR, "Misc.tsx"), "utf8")).toMatch(
      /disabled=\{confirm !== "DELETE"\}[^>]*onClick=\{\(\) => onSetup\(\{ mode: "startOver" \}\)\}/,
    );
    expect(readFileSync(join(DIR, "FirstRun.tsx"), "utf8")).toMatch(/\| \{ mode: "startOver" \}/);
  });
});
