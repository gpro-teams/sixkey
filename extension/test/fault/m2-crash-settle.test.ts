// The settle itself through every crash point (docs/audit/internal-reviews/M2-REREVIEW.md, "the settle matrix"): a Published commit landed and
// its IndexedDB pins did not (pendingPins kept); then settlePins dies at each of its writes, just before or just after
// the write lands, or the disk acknowledges the write and drops it (a lying disk), and possibly a second settle dies at
// its write 1 or 2 (an SW restart mid-settle, twice). Afterwards a clean settle runs. Hard, on every row, lying disk
// included since RR-7 (the pin write is read back before the pending copy is cleared): the pending copy is gone only when
// IndexedDB has the pins, and after the clean settle the pins are the commit's. And three contexts at once, one of them
// with an IndexedDB that refuses writes.
import { describe, expect, it } from "vitest";
import { decryptVault } from "../../src/core/crypto/envelope";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { adoptedRecord } from "../../src/core/sync/crypto/keybundle";
import type { DeviceIdentity } from "../../src/core/sync/local/identity";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { createClock } from "../../src/core/vault/hlc";
import { canonicalJson } from "../../src/core/vault/merge";
import { aliveEntries } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import {
  adoptByUnlock,
  bundleFor,
  factsOf,
  input,
  m2World,
  newCode,
  publishedOf,
  rotated,
  secretOf,
  steadyState,
  vaultWith,
} from "../helpers/m2-world";
import { STRONG } from "../helpers/vaults";

class Dead extends Error {}
/** A process that dies at write `at` ("before" it lands, "after"), or whose disk drops it ("lie") and goes on. */
class Proc {
  calls = 0;
  dead = false;
  constructor(
    public at: number,
    public mode: "before" | "after" | "lie",
  ) {}
  hit() {
    if (this.dead) throw new Dead();
    this.calls++;
    if (this.calls === this.at) {
      if (this.mode === "lie") return false;
      this.dead = true;
      return this.mode === "after";
    }
    return true;
  }
}
class ProcKV implements KV {
  constructor(
    private inner: MemoryKV,
    private p: Proc,
  ) {}
  async get(k: string[]) {
    if (this.p.dead) throw new Dead();
    return this.inner.get(k);
  }
  async keys() {
    return this.inner.keys();
  }
  async set(i: Record<string, unknown>) {
    const l = this.p.hit();
    if (l) await this.inner.set(i);
    if (this.p.dead) throw new Dead();
  }
  async remove(k: string[]) {
    const l = this.p.hit();
    if (l) await this.inner.remove(k);
    if (this.p.dead) throw new Dead();
  }
}
class NoWriteKV implements KV {
  constructor(private inner: MemoryKV) {}
  get(k: string[]) {
    return this.inner.get(k);
  }
  keys() {
    return this.inner.keys();
  }
  async set(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
  async remove(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
}
const cloneKv = (m: MemoryKV) => {
  const n = new MemoryKV();
  for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
  return n;
};

async function enrolled() {
  const w = m2World();
  await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
  const st = await steadyState(w, 3);
  w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 5, head: "h", checksum: "c" } });
  return { w, st, keyring: (await w.active()).keyring };
}

describe("settlePins through every crash point", () => {
  it("dying (or lied to) at each of its writes, then again at a second settle's write 1 or 2: the pending copy goes only once IndexedDB has the pins, and a clean settle then has them", async () => {
    const { w, st, keyring } = await enrolled();
    const r = await newCode(keyring, st.vk);
    const bundle = await bundleFor(st.vk, r.keyring, 4, st.bundle.auth);
    const keys = await publishedOf({
      server: st.bundle,
      local: keyring,
      vk: st.vk,
      op: "change_recovery",
      sent: bundle,
      sentVk: st.vk,
      sentSecret: { recoveryCode: r.recoveryCode },
    });
    await w.flows(w.svc(), w.local(w.kv, new NoWriteKV(w.idb))).commitKeys({ keys }); // landed, pins pending
    expect((w.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeDefined();
    const digest = (await adoptedRecord(bundle)).digest;
    let rows = 0;
    for (let at = 1; at <= 3; at++)
      for (const mode of ["before", "after", "lie"] as const)
        for (const second of [0, 1, 2]) {
          const kv = cloneKv(w.kv);
          const idb = cloneKv(w.idb);
          const p = new Proc(at, mode);
          await w
            .local(new ProcKV(kv, p), new ProcKV(idb, p))
            .settlePins()
            .catch(() => undefined);
          if (second) {
            const p2 = new Proc(second, "before");
            await w
              .local(new ProcKV(kv, p2), new ProcKV(idb, p2))
              .settlePins()
              .catch(() => undefined);
          }
          const where = `@${at} ${mode} second=${second}`;
          const raw = (await w.local(kv, idb).identity.get()) as DeviceIdentity;
          const pending = (kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins;
          if (pending === undefined)
            expect(raw.adopted?.digest, `${where}: the pending copy went without the pins`).toBe(digest);
          const settled = (await w.local(kv, idb).settlePins()) as DeviceIdentity;
          expect(settled.adopted?.digest, `${where}: behind after a clean settle`).toBe(digest);
          expect(((await w.local(kv, idb).identity.get()) as DeviceIdentity).adopted?.digest, where).toBe(digest);
          rows++;
        }
    expect(rows).toBe(27);
  }, 300_000);
});

describe("three contexts at once, one of them with IndexedDB refusing writes", () => {
  it("the SW's applyRemote, the page's R3 commit (its pins fail) and a third context's settle and status: all land, and the next settle catches the pins up", async () => {
    const { w, keyring, st } = await enrolled();
    const mine = deserializeVault(await decryptVault((await w.active()).envelope, st.vk));
    const c = createClock("bbbb", { now: () => w.t.now + 10_000 });
    for (const e of mine.entries) c.observe(e.hlc);
    const remote = addEntry(mine, input("FromServer", secretOf("FromServer")), c).vault;
    const r = await rotated(keyring, st.vk);
    const b2 = await bundleFor(r.vk, r.keyring, 6);
    const keys = await adoptByUnlock({
      ...(await factsOf(w.local(), keyring.vaultId)),
      secret: { password: STRONG },
      local: keyring,
      remote: b2,
      needsPassword: true,
    });
    const res = await Promise.allSettled([
      w.flows(w.svc(), w.local()).applyRemote(remote),
      w.flows(w.svc(), w.local(w.kv, new NoWriteKV(w.idb))).commitKeys({ keys, record: "keys_adopted" }),
      w.local().settlePins(),
      w.local().status(),
    ]);
    expect(res[1].status).toBe("fulfilled");
    expect(await w.local().settlePins()).toMatchObject({ vkId: r.vk.id, adopted: await adoptedRecord(b2) });
    const a = await w.active();
    expect(canonicalJson(a.keyring)).toBe(canonicalJson(b2.keyring));
    if (res[0].status === "fulfilled")
      expect(aliveEntries(deserializeVault(await decryptVault(a.envelope, r.vk))).map((e) => e.issuer)).toContain(
        "FromServer",
      );
  }, 120_000);
});
