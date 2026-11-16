// The fifth M3 review: killers for the surviving mutants of the revision-5 delta that are real test gaps
// (M3-R5-REVIEW, "Mutants"; that report was not retained, its findings are in docs/design/notes/M3-NOTES.md §0). Each passes on revision 5 and fails on its mutant. Adopted into M3 revision 6
// unchanged.
import { describe, expect, it } from "vitest";
import { encryptVault } from "../../src/core/crypto/envelope";
import { utf8 } from "../../src/core/crypto/bytes";
import type { Vk } from "../../src/core/crypto/vk";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import { commitJoin, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import { revokeDevice } from "../../src/core/sync/engine/keys";
import { discardParkedOrphans, readParkedOrphans } from "../../src/core/sync/engine/orphans";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { serializeVault } from "../../src/core/vault/validate";
import { bulkEntries, EMAIL, worldOf, type Device } from "../helpers/m3-world";

const entries = (d: Device): Record<string, unknown>[] =>
  (d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: Record<string, unknown>[] } | undefined)?.items ?? [];
async function pushableOf(
  vault: Vault,
  vk: Vk,
  base: number,
  head: string,
  checksum: string,
): Promise<Record<string, unknown>> {
  const up = await uploadEnvelope(vault, vk, { vaultId: vault.vaultId, rev: base + 1 });
  const proof = await writeProof(vk, { vaultId: vault.vaultId, ifVersion: base, checksum: up.envelope.checksum });
  return { v: 1, base, head, from: { version: base, head, checksum: "planted" }, checksum, envelope: up.text, proof };
}

describe("M3-R5 review: killers", () => {
  it("R5V-10 killer: 'Advanced' with the checksums the notice listed refuses a list that changed to another entry of the same count", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          ...(await pushableOf(await a.vault(vk), vk, 1, "x", "shown")),
          parked: { reason: "schema", vkId: null, at: 1 },
        },
      ],
    });
    const shown = (await readParkedOrphans(a.disk.kv, a.lock))!;
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          ...(await pushableOf(await a.vault(vk), vk, 2, "y", "never-shown")),
          parked: { reason: "too_large", vkId: null, at: 2 },
        },
      ],
    });
    await expect(
      discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: shown.count, checksums: shown.checksums }),
    ).rejects.toMatchObject({ code: "bad_state" });
    expect(entries(a).map((e) => e.checksum)).toEqual(["never-shown"]);
  }, 60_000);

  it("R5V-16 killer: the revoked-pending undo (M3RR-8) keeps a parked entry: only what its fold folded goes with the records", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "lose_response" });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "fail_before", count: 2 });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    const nid = ((await n.local.identity.get()) as { deviceId: string }).deviceId;
    await revokeDevice(a.engine, nid, w.password);
    const vk = await n.vk();
    const vaultId = (await n.generation()).keyring.vaultId;
    const env = await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), vk, {
      vaultId,
      rev: 9,
    });
    n.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          v: 1,
          from: null,
          checksum: "parked-newer",
          envelope: JSON.stringify(env),
          parked: { reason: "schema", vkId: null, at: 1 },
        },
      ],
    });
    await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    }); // the undo, then the join's prepare
    expect(entries(n).map((e) => e.checksum)).toEqual(["parked-newer"]);
  }, 60_000);

  it("R5V-17 killer: an entry that brings the vault to exactly LIMITS.parsedEntries (50 000) is folded, not parked too_large", async () => {
    const w = await worldOf(2, ["GitHub"], [], { validateWire: false });
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const mine = await a.vault(vk);
    const full: Vault = {
      ...mine,
      entries: [...mine.entries, ...bulkEntries(50_000 - mine.entries.length, "full", w.clock.now - 1000)].sort(
        (x, y) => (x.id < y.id ? -1 : 1),
      ),
    };
    const env = await encryptVault(serializeVault(full), vk, { vaultId, rev: 70 });
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [{ v: 1, from: null, checksum: "full", envelope: JSON.stringify(env) }],
    });
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastSynced: null });
    await a.engine.round();
    expect(entries(a).every((e) => !e.parked)).toBe(true); // folded (the upload itself then pauses: too_large, §4.3)
    expect(aliveEntries(await a.vault(vk)).length).toBe(50_000);
  }, 300_000);
});
