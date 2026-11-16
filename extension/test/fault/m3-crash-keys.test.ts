// M3 crash matrix for the key operations with sync on (SYNC-DESIGN §3.6–§3.8, §3.9, §8.2 "改密码、换恢复码、轮换 … 任意
// await 点崩溃"): the device dies at every step of the operation's server-first, then-local half (each storage write and
// each request, before or after it), the browser restarts, and the user unlocks with what they hold. The promise kept at
// every step (§3.9 "永不被锁死"): of each set of credentials the user holds or was shown, at least one opens this device's
// vault, and after the recovery path (unlock, the round, adoptWithSecret where the round asks for it) every device and the
// server agree on the keys and the data, with nothing lost.
import { beforeAll, describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRotation,
  prepareRecoveryCode,
  prepareRotation,
  type PreparedCode,
  type PreparedRotation,
} from "../../src/core/sync/engine/keys";
import { canonicalJson } from "../../src/core/vault/merge";
import { aliveEntries } from "../../src/core/vault/model";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, EMAIL, quiesce, type Device, type World, worldOf } from "../helpers/m3-world";

const NEW_PW = "violet-harbour-cinder-93";
type Cred = { password: string } | { recoveryCode: string };
const opens = async (kr: Keyring, c: Cred) =>
  ("password" in c ? unlockWithPassword(kr, c.password) : unlockWithRecoveryCode(kr, c.recoveryCode)).then(
    (v: Vk) => v,
    () => null,
  );

let base: World;
beforeAll(async () => {
  base = await worldOf(2, ["GitHub", "AWS"]);
}, 60_000);

type KeyOp = {
  name: string;
  /** Healthy set-up on a clone (prepare, show the code); returns the dying operation and the credential sets the user holds. */
  setup: (
    w: World,
  ) => Promise<{ run: (a: Device) => (c: import("../helpers/m3-world").Context) => Promise<unknown>; sets: Cred[][] }>;
};

const OPS: KeyOp[] = [
  {
    name: "change the master password",
    setup: async (w) => ({
      run: () => (c) => changePassword(c.engine, w.password, NEW_PW),
      sets: [[{ password: w.password }, { password: NEW_PW }], [{ recoveryCode: w.code }]],
    }),
  },
  {
    name: "a new recovery code (after it was shown)",
    setup: async (w) => {
      const h: PreparedCode = await prepareRecoveryCode(w.devices[0]!.engine, w.password);
      return {
        run: () => (c) => commitRecoveryCode(c.engine, h),
        sets: [[{ password: w.password }], [{ recoveryCode: w.code }, { recoveryCode: h.recoveryCode }]],
      };
    },
  },
  {
    name: "rotate the vault key (after the new code was shown)",
    setup: async (w) => {
      const h: PreparedRotation = await prepareRotation(w.devices[0]!.engine, w.password);
      return {
        run: () => (c) => commitRotation(c.engine, h),
        sets: [[{ password: w.password }], [{ recoveryCode: w.code }, { recoveryCode: h.recoveryCode }]],
      };
    },
  },
];

/** The user's way back: unlock with the first credential that opens the local vault, then the rounds and adoptions. */
async function recover(w: World, d: Device, creds: Cred[]): Promise<void> {
  await d.restartBrowser();
  const kr = (await d.generation()).keyring;
  for (const c of creds) {
    if (!(await opens(kr, c))) continue;
    if ("password" in c) await d.svc.unlockWithPassword(c.password);
    else await d.svc.unlockWithRecoveryCode(c.recoveryCode);
    break;
  }
  for (let i = 0; i < 4; i++) {
    const r = await d.engine.round({ explicit: true });
    if (r.status === "ok" && r.keyStatus !== "needs_new_password") return;
    for (const c of creds) {
      const a = await adoptWithSecret(d.engine, c);
      if (a.kind === "adopted") break;
    }
  }
}

describe("M3 key operations die at every step; no credential set is ever locked out", () => {
  for (const op of OPS) {
    it(
      op.name,
      async () => {
        let rows = 0;
        for (const mode of ["before", "after"] as Mode[]) {
          for (let at = 1; at < 200; at++) {
            const w = cloneWorld(base);
            const [a, b] = w.devices as [Device, Device];
            const s = await op.setup(w);
            const data = canonicalJson(
              aliveEntries(await a.vault())
                .map((e) => e.id)
                .sort(),
            );
            const r = await runDying(a, at, mode, s.run(a));
            const label = `${op.name} @${at} ${mode}`;
            if (
              r.error !== undefined &&
              !(
                r.error instanceof Error &&
                /unconfirmed|network|changed_elsewhere|offline|not_synced/.test(String(r.error))
              )
            )
              throw r.error;
            // 1. after the restart, of every set at least one credential opens the local vault
            await a.restartBrowser();
            const kr = (await a.generation()).keyring;
            for (const set of s.sets) {
              const ok = await Promise.all(set.map((c) => opens(kr, c)));
              expect(
                ok.some((x) => x !== null),
                `${label}: one of ${set.map((c) => Object.keys(c)[0]).join("/")} opens the vault`,
              ).toBe(true);
            }
            // 2. the way back converges: keys and data, on both devices and the server
            const all = s.sets.flat();
            await recover(w, a, all);
            await recover(w, b, all);
            await quiesce(w, 8, [a, b]);
            const server = JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring as Keyring;
            expect(canonicalJson((await a.generation()).keyring), `${label}: A has the server's keyring`).toBe(
              canonicalJson(server),
            );
            expect(canonicalJson((await b.generation()).keyring), `${label}: B has the server's keyring`).toBe(
              canonicalJson(server),
            );
            for (const set of s.sets) {
              const ok = await Promise.all(set.map((c) => opens(server, c)));
              expect(
                ok.some((x) => x !== null),
                `${label}: the server's bundle opens with one of the set`,
              ).toBe(true);
            }
            expect(
              canonicalJson(
                aliveEntries(await a.vault())
                  .map((e) => e.id)
                  .sort(),
              ),
              `${label}: nothing lost`,
            ).toBe(data);
            expect(canonicalJson(await b.vault()), label).toBe(canonicalJson(await a.vault()));
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
