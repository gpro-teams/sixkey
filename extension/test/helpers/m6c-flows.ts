// The Sync section's flows as M6C's tests drive them, in the order the page runs them (the views call these methods):
//   - revokeAsLost: the device list's Revoke, "lost or stolen" (options/sync/revoke.ts RevokeFlow): the password, the
//     reason, the new recovery code shown and two groups typed back, then the flow revokes and rotates in its own order;
//   - approvalJoin: a profile joins by approval (options/sync/join.ts JoinFlow), approved from another device's engine
//     (the approving section's steps, engine enroll.ts Approver), up to the join committed.
import { listDevices } from "../../src/core/sync/engine/devices";
import { Approver } from "../../src/core/sync/engine/enroll";
import { JoinFlow, type JoinState } from "../../src/options/sync/join";
import { summaryText } from "../../src/options/sync/model";
import { asking } from "../../src/options/sync/permission";
import { RevokeFlow } from "../../src/options/sync/revoke";
import { EMAIL, type Device, type World } from "./m3-world";
import { click, kitOf, permissions, until, type PermFake } from "./m6-kit";

/** Device `d` revokes `targetId` as lost through RevokeFlow (sync on: the permission held). Returns the rotation's code. */
export async function revokeAsLost(w: World, d: Device, targetId: string): Promise<string> {
  const perm = permissions(true);
  const kit = kitOf(d, perm);
  const target = (await listDevices(d.engine)).find((r) => r.id === targetId);
  if (!target) throw new Error("no such device");
  const f = new RevokeFlow(kit, { id: target.id, name: target.name }, [], { random: () => 0 });
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  await until(() => f.state.at === "password", "the password step");
  await f.submitPassword(w.password);
  f.setReason("lost");
  await f.confirm();
  const shown = f.state;
  if (shown.at !== "show") throw new Error(`revoke: ${shown.at}`);
  f.saved();
  const c = f.state;
  if (c.at !== "confirm") throw new Error(`revoke: ${c.at}`);
  const groups = shown.code.split("-");
  await f.confirmGroups([groups[c.groups[0]]!, groups[c.groups[1]]!]);
  if (f.state.at !== "done") throw new Error(`revoke: ${f.state.at}`);
  return shown.code;
}

/** The device id of `d`'s sync identity. */
export async function deviceIdOf(d: Device): Promise<string> {
  return ((await d.local.status()) as { identity: { deviceId: string } }).identity.deviceId;
}

/**
 * Profile `d` joins by approval, approved on `a`, through JoinFlow, up to the commit. Returns the summary's words and
 * the flow's end ("done", or what it stopped at).
 */
export async function approvalJoin(
  w: World,
  a: Device,
  d: Device,
  perm: PermFake,
  name = "B",
): Promise<{ words: ReturnType<typeof summaryText>; end: string }> {
  const kit = kitOf(d, perm);
  const j = new JoinFlow(kit);
  click(
    perm,
    asking(kit, (g) => void j.start(g)),
  );
  const st = (): JoinState => j.state;
  await until(() => st().at === "signin", "the sign-in");
  await j.signin.send(EMAIL);
  await j.signin.verify(w.server.inbox(EMAIL));
  await until(() => st().at === "choose", "the choice");
  j.setName(name);
  await j.chooseApproval();
  const [req] = await Approver.list(a.engine);
  const approver = await Approver.start(a.engine, req!.request_id, w.password);
  await j.pollOnce();
  if (st().at !== "code") throw new Error(`no code step: ${st().at}`);
  await j.submitCode(approver.pairingCode); // the code the approver shows, typed here
  const s = st();
  if (s.at !== "sas") throw new Error(`no sas: ${s.at}`);
  await approver.poll(w.password);
  const r = await approver.submitSas(s.sas, w.password);
  if (r.kind !== "approved") throw new Error("not approved");
  await j.pollOnce(); // approved: the payload opens under the code's key, the join is prepared
  const sum = st();
  if (sum.at !== "summary") throw new Error(`no summary: ${sum.at}`);
  const words = summaryText(sum.summary, sum.via);
  await j.commit();
  return { words, end: st().at };
}
