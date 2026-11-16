// M2's write paths through every crash point, single faults and a lying disk (test/helpers/m2-crash.ts has the machinery,
// the operations and the invariants; the double faults are m2-crash-double.test.ts). Each operation's rows: every write of
// the operation, just before it lands, just after, and acknowledged but dropped (the process goes on), each with and
// without a browser restart.
import { describe, expect, it } from "vitest";
import { expectSound, LIE_RESIDUAL, matrix, OPS } from "../helpers/m2-crash";

describe.each(OPS.map((o) => [o.name, o] as const))("M2 crash matrix: %s", (name, op) => {
  it("every write, before and after it lands and dropped by a lying disk, with and without a browser restart", async () => {
    const rows = await matrix(op, ["before", "after", "lie"], [true, false]);
    expectSound(rows);
    // not vacuous: both outcomes are reached, and for a key commit or a join the D8 window too (the commit landed and the
    // IndexedDB pins did not), which the settle then closes
    expect(rows.some((r) => r.state === "new")).toBe(true);
    if (name !== "applyRemote") expect(rows.some((r) => r.state !== "new")).toBe(true); // old, or still lost
    if (name !== "applyRemote") expect(rows.some((r) => r.rawBehind && r.mode !== "lie")).toBe(true);
    // a lying disk breaks only the residual promises, and the join's sk_prejoin is never one of them (read back, M2R-14)
    const residual = rows.filter((r) => r.mode === "lie").flatMap((r) => r.violations);
    expect(residual.every((v) => LIE_RESIDUAL.some((x) => v.startsWith(x)))).toBe(true);
    expect(residual.some((v) => v.startsWith("no sk_prejoin"))).toBe(false);
  }, 600_000);
});
