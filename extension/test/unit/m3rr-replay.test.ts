// The M3 re-review's model replay (docs/audit/internal-reviews/M3-REREVIEW.md M3RR-13: seed 1041502085, 80 steps, three devices), adopted as a
// regression test. The run converges and passes the oracle, quiet, secret and violation checks; it trips watchServer's
// "absorb the head it replaced" check exactly once: a PUT delivered late after an honest PITR, accepted by if_version
// (the server's CAS does not bind the head). That is the server's restore fence (M4/M8, no client change; M3-NOTES §10);
// when the fence lands, the expectation below becomes "no problem" and this note goes.
import { expect, it } from "vitest";
import { modelBase, runModel } from "../helpers/m3-model";

const SEED = Number(process.env.SIXKEY_RR_REPLAY ?? 1041502085);
const STEPS = Number(process.env.SIXKEY_RR_REPLAY_STEPS ?? 80);

it(`the re-review's model replay (seed ${SEED}, ${STEPS} steps): converges; the one problem is M3RR-13's late PUT after a PITR`, async () => {
  await modelBase(3);
  const problems: string[] = [];
  const c = await runModel(SEED, STEPS, { watchProblems: problems });
  console.log(problems.map((p) => p.slice(0, 120)).join("\n"));
  expect(c.log).toContain("server rollback");
  expect(problems.length).toBeLessThanOrEqual(1);
  for (const p of problems) expect(p).toMatch(/^\/v1\/vault did not absorb the head it replaced/);
}, 600_000);
