// The third M3 review: departure 1 (R3 and the cloud restore fold the orphan just after commitKeys, in their own
// transact). The adoption dies at every step (each storage write and each request, before or after it) with an orphan
// holding the only copy of a save; after a browser restart the user unlocks with the password (the adoption again where
// the round asks for it), and the save must be in the vault of both devices and in the head.
import { beforeAll, describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { adoptWithSecret, commitRotation, prepareRotation } from "../../src/core/sync/engine/keys";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { aliveEntries } from "../../src/core/vault/model";
import { tear } from "../helpers/faulty-kv";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, quiesce, type Device, type World, worldOf } from "../helpers/m3-world";

const SAVE = "only in the orphan";
const names = async (d: Device, vk?: Vk) => aliveEntries(await d.vault(vk)).map((e) => e.issuer);

function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}

/** A: a save, locked, the slot torn (the orphan under VK1). B rotated meanwhile. A is now needs_password (R3). */
let r3Base: World;
/** A: a save, locked, every copy of the vault lost (the outbox still there): the cloud restore. */
let lostBase: World;
beforeAll(async () => {
  r3Base = await worldOf(2, ["GitHub", "AWS"]);
  {
    const [a, b] = r3Base.devices as [Device, Device];
    r3Base.advance(1000);
    await a.add(SAVE);
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    if (!a.disk.kv.data.get(SYNC_KEYS.orphan)) throw new Error("no orphan");
    await commitRotation(b.engine, await prepareRotation(b.engine, r3Base.password));
    if ((await a.engine.round()).status !== "needs_password") throw new Error("not R3");
  }
  lostBase = await worldOf(2, ["GitHub", "AWS"]);
  {
    const [a] = lostBase.devices as [Device, Device];
    lostBase.advance(1000);
    await a.add(SAVE);
    await a.lockNow();
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) a.disk.kv.data.set(k, { torn: "x" });
    for (const k of [...a.disk.kv.data.keys()]) if (k.startsWith("sk_snap")) a.disk.kv.data.delete(k);
    a.disk.mirror.data.clear();
    a.restartWorker();
    if ((await a.svc.status()).state !== "lost") throw new Error("not lost");
  }
}, 120_000);

async function wayBack(w: World, d: Device): Promise<void> {
  await d.restartBrowser();
  for (let i = 0; i < 6; i++) {
    const st = await d.svc.status().catch(() => null);
    if (st && st.state === "locked") await d.svc.unlockWithPassword(w.password).catch(() => undefined);
    const r = await d.engine.round({ explicit: true });
    if (r.status === "ok") return;
    if (r.status === "review_needed" && r.blocked) {
      await d.engine.round({
        explicit: true,
        answer: { seen: r.blocked.seen, accept: [...r.blocked.report.secretChanged, ...r.blocked.report.purgedAlive] },
      });
      continue;
    }
    const ad = await adoptWithSecret(d.engine, { password: w.password }).catch((e: unknown) => ({
      kind: `threw ${String(e)}`,
    }));
    if (ad.kind === "local") await d.svc.unlockWithPassword(w.password);
  }
}

describe("M3-R3 review: the adoption's fold after commitKeys, dying at every step", () => {
  for (const [label, base] of [
    ["R3 (a rotated server, the orphan under the old key)", () => r3Base],
    ["the cloud restore over a lost vault", () => lostBase],
  ] as const) {
    it(
      label,
      async () => {
        let rows = 0;
        for (const mode of ["before", "after"] as Mode[]) {
          for (let at = 1; at < 200; at++) {
            const w = cloneWorld(base());
            const [a, b] = w.devices as [Device, Device];
            const r = await runDying(a, at, mode, (c) => adoptWithSecret(c.engine, { password: w.password }));
            await wayBack(w, a);
            await wayBack(w, b);
            await quiesce(w, 8, [a, b]);
            const vk = await b.vk();
            expect(await names(a, vk), `${label} @${at} ${mode}: A has the save`).toContain(SAVE);
            expect(await names(b, vk), `${label} @${at} ${mode}: B has the save`).toContain(SAVE);
            expect(
              aliveEntries((await w.serverVault(vk))!).map((e) => e.issuer),
              `${label} @${at} ${mode}: the head has it`,
            ).toContain(SAVE);
            expect(
              a.disk.kv.data.get(SYNC_KEYS.orphan) ?? null,
              `${label} @${at} ${mode}: the orphan retired`,
            ).toBeNull();
            rows++;
            if (!r.reached) break;
          }
        }
        expect(rows).toBeGreaterThan(10);
      },
      1_200_000,
    );
  }
});
