// The invariants every M3 fault test checks once the world is quiet (SYNC-DESIGN §8.2 "不变量"):
//   - convergence: every device and the server's head hold the same vault (canonicalJson);
//   - nothing lost, nothing invented: that vault is exactly the join (mergeVaults) of every state any device committed
//     (an oracle the test keeps): an account is never lost, and a deleted or erased one never comes back unless a later
//     edit says so (tombstones are kept, merge is LWW per register);
//   - lastSynced never lies: when a device's active generation is the one lastSynced names, the server's version
//     lastSynced.version has exactly lastSynced.head and holds exactly that vault (otherwise a later "!needPull && dirty"
//     round would upload a state that was never merged with the server's, D1);
//   - the server's history only moves forward: every accepted write holds everything of the head it replaced (no upload
//     from a rolled-back or unmerged head), checked as it happens by watchServer.
import { expect } from "vitest";
import { decryptVault } from "../../src/core/crypto/envelope";
import type { Vk } from "../../src/core/crypto/vk";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { headOf } from "../../src/core/sync/engine/state";
import { canonicalJson, mergeVaults } from "../../src/core/vault/merge";
import type { Vault } from "../../src/core/vault/model";
import { deserializeVault } from "../../src/core/vault/validate";
import { EMAIL, type Device, type World } from "./m3-world";

export const cj = (v: unknown) => canonicalJson(v);
/**
 * One Phase 0 wrinkle the checks set aside: purgeEntry drops an erased HOTP entry's counter, while mergeEntry keeps the
 * highest counter (for associativity), so a counter seen only before the erasure may or may not come back. An erased
 * entry's counter is no data (its secret, label and issuer are gone); everything else is compared exactly.
 */
export const noErasedCounters = (v: Vault): Vault => ({
  ...v,
  entries: v.entries.map((e) => (e.secret === "" ? { ...e, counter: undefined } : e)),
});
const open = async (text: string, vk: Vk): Promise<Vault> => deserializeVault(await decryptVault(JSON.parse(text), vk));

/** The join of committed states (the oracle). */
export class Oracle {
  vault: Vault | null = null;
  fold(v: Vault): void {
    this.vault = this.vault ? mergeVaults(this.vault, v) : v;
  }
  async foldDevice(d: Device, vk: Vk): Promise<void> {
    this.fold(await d.vault(vk));
  }
}

/**
 * Every PUT /v1/vault and POST /v1/keys/rotate the server accepts must absorb the head it replaces. The replaced head opens
 * with its own key and the new head with its own (a rotation changes the key: `keyOf` resolves a VK id; by default only
 * `vk()`'s). A write whose key is not known yet is kept and checked by settle() (a test that rotates learns VK2 after
 * the commit, then settles; `unverified` counts what no key opened by then).
 */
export function watchServer(w: World, vk: () => Vk, o: { keyOf?: (vkId: string) => Vk | undefined } = {}) {
  type Write = {
    target: string;
    version: number;
    before: { text: string; vkId: string };
    after: { text: string; vkId: string };
  };
  const waiting: Write[] = [];
  const keyOf = (id: string): Vk | undefined => o.keyOf?.(id) ?? (vk().id === id ? vk() : undefined);
  const check = async (x: Write): Promise<boolean> => {
    const k0 = keyOf(x.before.vkId);
    const k1 = keyOf(x.after.vkId);
    if (!k0 || !k1) return false;
    let a: Vault;
    let b: Vault;
    try {
      [a, b] = [await open(x.before.text, k0), await open(x.after.text, k1)];
    } catch {
      return true; // the replaced head did not open (an attack test's bad head): nothing to compare
    }
    out.checked++;
    // noErasedCounters: a device that erased a HOTP entry uploads it without the counter the head still had (Phase 0).
    if (cj(noErasedCounters(mergeVaults(b, a))) !== cj(noErasedCounters(b))) {
      const m = mergeVaults(b, a);
      const diff = m.entries
        .filter((e) => cj(e) !== cj(b.entries.find((y) => y.id === e.id)))
        .map((e) => {
          const x0 = b.entries.find((y) => y.id === e.id);
          const f = (y: typeof e | undefined) =>
            y
              ? {
                  hlc: y.hlc,
                  phlc: y.phlc,
                  dhlc: y.dhlc,
                  deleted: y.deleted,
                  counter: y.counter,
                  purged: y.secret === "",
                }
              : null;
          return { id: e.id, merged: f(e), uploaded: f(x0) };
        });
      out.problems.push(
        `${x.target} did not absorb the head it replaced (version ${x.version}) ${JSON.stringify(diff)}`,
      );
    }
    return true;
  };
  const out = {
    problems: [] as string[],
    checked: 0,
    get unverified(): number {
      return waiting.length;
    },
    /** Check the writes whose keys were not known when they landed. */
    async settle(): Promise<void> {
      for (const x of [...waiting]) if (await check(x)) waiting.splice(waiting.indexOf(x), 1);
    },
  };
  const send = w.server.send.bind(w.server);
  w.server.send = async (req) => {
    const write =
      (req.method === "PUT" && req.target === "/v1/vault") ||
      (req.method === "POST" && req.target === "/v1/keys/rotate");
    const row = write ? w.server.account(EMAIL).vault : null;
    const before = row ? { text: row.envelope, vkId: row.vk_id, version: row.version } : null;
    const res = await send(req);
    if (!write || res.status !== 200 || !before) return res;
    const now = w.server.account(EMAIL).vault!;
    if (now.version === before.version) return res; // an idempotent replay: nothing replaced
    const x: Write = {
      target: req.target,
      version: now.version,
      before: { text: before.text, vkId: before.vkId },
      after: { text: now.envelope, vkId: now.vk_id },
    };
    if (!(await check(x))) waiting.push(x);
    return res;
  };
  return out;
}

export async function checkQuiet(
  w: World,
  vk: Vk,
  o: { devices?: Device[]; oracle?: Oracle; label?: string } = {},
): Promise<void> {
  const devices = o.devices ?? w.devices;
  const label = o.label ?? "";
  const server = await open(w.server.account(EMAIL).vault!.envelope, vk);
  for (const d of devices)
    expect(cj(await d.vault(vk)), `${label} ${d.name} converged with the server`).toBe(cj(server));
  if (
    o.oracle?.vault &&
    cj(noErasedCounters(server)) !== cj(noErasedCounters(o.oracle.vault)) &&
    process.env.SIXKEY_M3_TRACE
  ) {
    const ov = o.oracle.vault;
    const ids = new Set([...server.entries.map((e) => e.id), ...ov.entries.map((e) => e.id)]);
    const f = (x: Vault["entries"][number] | undefined) =>
      x
        ? {
            hlc: x.hlc,
            phlc: x.phlc,
            dhlc: x.dhlc,
            deleted: x.deleted,
            counter: x.counter,
            purged: x.secret === "",
            label: x.label,
            group: x.group,
            order: x.order,
          }
        : null;
    for (const id of ids) {
      const a = server.entries.find((e) => e.id === id);
      const b = ov.entries.find((e) => e.id === id);
      if (cj(a) !== cj(b)) console.log("DIFF", id, JSON.stringify({ final: f(a), oracle: f(b) }));
    }
  }
  if (o.oracle?.vault)
    expect(cj(noErasedCounters(server)), `${label} the join of every committed state`).toBe(
      cj(noErasedCounters(o.oracle.vault)),
    );
  for (const d of devices) await checkLastSynced(w, d, vk, label);
}

export async function checkLastSynced(w: World, d: Device, vk: Vk, label = ""): Promise<void> {
  const ls = lastSyncedOf(d.disk.kv.data.get(SYNC_KEYS.state));
  if (!ls) return;
  const g = await d.generation();
  if (g.envelope.checksum !== ls.checksum) return; // dirty: it says nothing about this generation
  const acct = w.server.account(EMAIL);
  const h = acct.history.find((x) => x.version === ls.version);
  expect(h, `${label} ${d.name}: lastSynced.version ${ls.version} exists`).toBeDefined();
  expect(await headOf(h!.envelope), `${label} ${d.name}: lastSynced.head is that version's`).toBe(ls.head);
  expect(cj(await open(h!.envelope, vk)), `${label} ${d.name}: the in-sync generation holds exactly that version`).toBe(
    cj(await d.vault(vk)),
  );
}
