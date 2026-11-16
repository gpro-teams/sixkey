// M2's write paths through every crash point with a double fault (docs/audit/internal-reviews/M2-REVIEW.md Appendix C): the two adoptions (R2,
// R3); the other operations are in m2-crash-double-other.test.ts and m2-crash-double-published.test.ts (three files, so
// they run side by side). The operation dies at write N (before or after it lands), then the browser restarts and that
// restart's own selfCheck, open and unlock die at their write M (1-6), then the user unlocks. Same invariants as
// m2-crash-matrix.test.ts (test/helpers/m2-crash.ts), all hard.
import { describe, expect, it } from "vitest";
import { expectSound, matrix, OPS } from "../helpers/m2-crash";

describe.each(
  OPS.filter((o) => o.name.startsWith("commitKeys: same VK") || o.name.startsWith("commitKeys: another VK")).map(
    (o) => [o.name, o] as const,
  ),
)("M2 crash matrix, double fault: %s", (_name, op) => {
  it("every write, before and after it lands, then a restart that dies at its own write 1-6", async () => {
    const rows = await matrix(op, ["before", "after"], [1, 2, 3, 4, 5, 6]);
    expectSound(rows);
    expect(rows.some((r) => r.state === "new")).toBe(true);
  }, 600_000);
});
