// M3 model test (SYNC-DESIGN §8.2): three devices with clocks two days apart, random interleavings of every kind of edit
// (add, rename, move, group, delete, restore, erase, HOTP), rounds, locks, offline periods, network faults (lost answers,
// duplicates, late deliveries, failures), crashes at a random step of a round with worker or browser restarts, server
// restarts and honest rollbacks (PITR), and the odd new recovery code. Seeded (fast-check), so a failure replays
// (SIXKEY_M3_SEED, SIXKEY_M3_RUNS, SIXKEY_M3_STEPS; SIXKEY_M3_FAMILY_* for the review's families). The machinery and
// the checks: test/helpers/m3-model.ts.
import fc from "fast-check";
import { beforeAll, describe, it } from "vitest";
import { modelBase, runModel } from "../helpers/m3-model";

const RUNS = Number(process.env.SIXKEY_M3_RUNS ?? 40);
const STEPS = Number(process.env.SIXKEY_M3_STEPS ?? 60);
const FAMILY_RUNS = Number(process.env.SIXKEY_M3_FAMILY_RUNS ?? 15);
const FAMILY_STEPS = Number(process.env.SIXKEY_M3_FAMILY_STEPS ?? 50);

beforeAll(async () => {
  await modelBase(3);
  await modelBase(4);
}, 240_000);

describe("M3 model: three devices, random edits, faults, crashes, skew and rollbacks converge without loss", () => {
  it(`${RUNS} seeded runs of ${STEPS} steps`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
        await runModel(seed, STEPS);
      }),
      { numRuns: RUNS, seed: Number(process.env.SIXKEY_M3_SEED ?? 20261017), endOnFailure: true },
    );
  }, 1_800_000);

  // The review's families (M3R-1's tears with a worker round, hooks inside the device's own PUT, password changes), four
  // devices; no PITR with tears (test/helpers/m3-model.ts).
  it(`four devices with tears, hooks and password changes: ${FAMILY_RUNS} seeded runs of ${FAMILY_STEPS} steps`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
        await runModel(seed, FAMILY_STEPS, { families: ["tear", "hook", "pw"] });
      }),
      { numRuns: FAMILY_RUNS, seed: Number(process.env.SIXKEY_M3_FAMILY_SEED ?? 20261018), endOnFailure: true },
    );
  }, 1_800_000);
});
