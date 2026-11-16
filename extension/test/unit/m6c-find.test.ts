// M6C, "find accounts" (SYNC-DESIGN §6 O13, §4.4 D6, §4.6, §5.8; engine find.ts, SyncFlows.recoverAccounts, the Sync
// section's FindFlow): what another device deleted and erased for good comes back from the server's history or from
// this device's snapshots, by the user's choice, as one ordinary local edit that syncs. Only issuer and label leave the
// engine; nothing is sent but the edit's upload; what is alive now is never listed or doubled; a lock ends the flow.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { encryptVault } from "../../src/core/crypto/envelope";
import { KEYS, parseSnapshotIndex } from "../../src/core/storage/format";
import {
  dropFound,
  findSources,
  missingFrom,
  openFound,
  recoverFound,
  type FindSource,
  type Found,
} from "../../src/core/sync/engine/find";
import { commitRotation, KeyOpError, prepareRotation } from "../../src/core/sync/engine/keys";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, isAlive, trashEntries, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, editEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";
import { FindFlow } from "../../src/options/sync/find";
import { asking } from "../../src/options/sync/permission";
import { input, secretOf } from "../helpers/m2-world";
import { EMAIL, worldOf, type Device, type World } from "../helpers/m3-world";
import { click, kitOf, permissions, until, type PermFake, type TestKit } from "../helpers/m6-kit";

const issuers = (v: Vault) =>
  aliveEntries(v)
    .map((e) => e.issuer)
    .sort();
const idsOf = async (d: Device, names: string[]) =>
  (await d.vault()).entries.filter((e) => names.includes(e.issuer)).map((e) => e.id);

async function trash(d: Device, names: string[]): Promise<void> {
  const ids = await idsOf(d, names);
  await d.svc.mutate((v, c) => ids.reduce((x, id) => deleteEntry(x, id, c), v));
}

/** Two devices in sync; B deletes three accounts and erases them for good; A takes both rounds in. */
async function erasedElsewhere(): Promise<{ w: World; a: Device; b: Device; erased: string[] }> {
  const w = await worldOf(2, ["GitHub", "AWS", "Bank", "Mail"]);
  const [a, b] = w.devices as [Device, Device];
  const erased = ["AWS", "Bank", "GitHub"];
  w.advance(60_000);
  await trash(b, erased);
  await b.engine.round();
  await a.engine.round();
  w.advance(60_000);
  await b.svc.purgeForever(await idsOf(b, erased), w.password);
  await b.engine.round();
  await a.engine.round();
  expect(issuers(await a.vault())).toEqual(["Mail"]);
  return { w, a, b, erased };
}

/** The first source (server or local) whose found accounts include all of `names`. */
async function sourceWith(d: Device, list: readonly FindSource[], names: string[]): Promise<Found> {
  for (const src of list) {
    const f = await openFound(d.engine, src);
    if (f.status === "ok" && names.every((n) => f.accounts.some((x) => x.issuer === n))) return f;
    dropFound(f);
  }
  throw new Error(`no source holds ${names.join(", ")}`);
}

describe("find accounts: the engine", () => {
  it("another device deleted three accounts and erased them for good: the server's history still holds them; two come back as new entries, and reach the other device", async () => {
    const { w, a, b, erased } = await erasedElsewhere();
    const before = await a.vault();
    const sources = await findSources(a.engine);
    expect(sources.error).toBeNull();
    expect(sources.server!.length).toBeGreaterThan(1);
    expect(sources.local.length).toBeGreaterThan(0);
    const found = await sourceWith(a, sources.server!, erased);
    // only issuer and label leave the engine: no secret in what the page gets
    const shown = JSON.stringify(found);
    for (const n of erased) expect(shown).not.toContain(secretOf(n));
    expect(found.accounts.map((x) => x.issuer).sort()).toEqual(erased);
    const pick = found.accounts.filter((x) => x.issuer !== "Bank").map((x) => x.ref);
    const puts = w.server.requests.filter((r) => r.op === "PUT /v1/vault").length;
    expect(await recoverFound(a.engine, found, pick)).toBe(2);
    // nothing sent by the recovery itself: an ordinary local edit, which the next round uploads
    expect(w.server.requests.filter((r) => r.op === "PUT /v1/vault").length).toBe(puts);
    const after = await a.vault();
    expect(issuers(after)).toEqual(["AWS", "GitHub", "Mail"]);
    const purgedIds = new Set(
      before.entries.filter((e) => erased.includes(e.issuer) || e.secret === "").map((e) => e.id),
    );
    for (const e of aliveEntries(after).filter((x) => x.issuer !== "Mail")) {
      expect(purgedIds.has(e.id), "an erased entry is never brought back to life: a new one").toBe(false);
      expect(e.secret).toBe(secretOf(e.issuer));
    }
    expect((await a.engine.round()).uploaded).toBe(true);
    await b.engine.round();
    expect(issuers(await b.vault())).toEqual(["AWS", "GitHub", "Mail"]);
    // the handle is used: a second recovery from it is refused
    await expect(recoverFound(a.engine, found, pick)).rejects.toMatchObject({ code: "stale" });
  });

  it("this device's snapshots hold them too, and work offline; the server's history failing to load is said, not thrown", async () => {
    const { a, erased } = await erasedElsewhere();
    a.net.partition(true);
    const sources = await findSources(a.engine);
    expect(sources.server).toBeNull();
    expect(sources.error).toBe("offline");
    const found = await sourceWith(a, sources.local, erased);
    expect(await recoverFound(a.engine, found, [found.accounts.find((x) => x.issuer === "Bank")!.ref])).toBe(1);
    expect(issuers(await a.vault())).toEqual(["Bank", "Mail"]);
  });

  it("an account in the trash comes back under its own id, as that version had it", async () => {
    const w = await worldOf(1, ["GitHub", "Mail"]);
    const [a] = w.devices as [Device];
    const [id] = await idsOf(a, ["GitHub"]);
    w.advance(60_000);
    await a.svc.mutate((v, c) => editEntry(v, id!, { label: "renamed later" }, c));
    w.advance(60_000);
    await trash(a, ["GitHub"]);
    const sources = await findSources(a.engine);
    // the oldest snapshot that holds it: before the rename
    let found: Found | null = null;
    for (const src of [...sources.local].reverse()) {
      const f = await openFound(a.engine, src);
      if (f.accounts.some((x) => x.issuer === "GitHub")) {
        found = f;
        break;
      }
      dropFound(f);
    }
    const gh = found!.accounts.find((x) => x.issuer === "GitHub")!;
    expect(gh.ref).toBe(id);
    expect(gh.label).not.toBe("renamed later");
    expect(await recoverFound(a.engine, found!, [gh.ref])).toBe(1);
    const back = (await a.vault()).entries.find((e) => e.id === id)!;
    expect(isAlive(back)).toBe(true);
    expect(back.label).toBe(gh.label);
    expect(trashEntries(await a.vault())).toEqual([]);
  });

  it("re-checked inside the edit: an account brought back meanwhile is not doubled", async () => {
    const { a, erased } = await erasedElsewhere();
    const found = await sourceWith(a, (await findSources(a.engine)).server!, erased);
    await a.add("GitHub"); // the same account, typed in again since
    const refs = found.accounts.map((x) => x.ref);
    expect(await recoverFound(a.engine, found, refs)).toBe(2); // AWS and Bank; GitHub is there
    expect(issuers(await a.vault())).toEqual(["AWS", "Bank", "GitHub", "Mail"]);
  });

  it("locked: nothing is read and nothing written; a handle dropped is refused", async () => {
    const { a, erased } = await erasedElsewhere();
    const found = await sourceWith(a, (await findSources(a.engine)).local, erased);
    const gen = (await a.generation()).envelope.checksum;
    await a.lockNow();
    await expect(findSources(a.engine)).rejects.toMatchObject({ code: "locked" });
    await expect(openFound(a.engine, { kind: "local", id: "r1", at: 0 })).rejects.toMatchObject({ code: "locked" });
    await expect(recoverFound(a.engine, found, [found.accounts[0]!.ref])).rejects.toBeInstanceOf(KeyOpError);
    expect((await a.generation()).envelope.checksum).toBe(gen);
    await a.unlock();
    const again = await sourceWith(a, (await findSources(a.engine)).local, erased);
    dropFound(again);
    await expect(recoverFound(a.engine, again, [again.accounts[0]!.ref])).rejects.toMatchObject({ code: "stale" });
  });

  it("versions under a key this device does not hold are not offered; one that does not open is said as such", async () => {
    const { w, a } = await erasedElsewhere();
    const hist = w.server.account(EMAIL).history;
    hist.push({ ...hist[hist.length - 1]!, version: 999_999, vk_id: "00".repeat(8) });
    const s = await findSources(a.engine);
    expect(s.server!.some((x) => x.kind === "server" && x.version === 999_999)).toBe(false);
    // a head whose envelope is not under a key held here (a buggy or malicious holder of the VK)
    const foreign = await encryptVault(
      serializeVault(emptyVault((await a.vault()).vaultId)),
      {
        raw: new Uint8Array(32).fill(7),
        id: "77".repeat(8),
      },
      { vaultId: (await a.vault()).vaultId, rev: 1 },
    );
    const v = await w.server.adminSetHead(JSON.stringify(foreign));
    const listed = (await findSources(a.engine)).server!.find((x) => x.kind === "server" && x.version === v)!;
    expect((await openFound(a.engine, listed)).status).toBe("unreadable");
    // a version of another vault, under this device's key: the server's history is this vault's; not taken from there
    const other = addEntry(
      emptyVault("another-vault-1"),
      input("Planted", secretOf("Planted")),
      createClock("devtest1"),
    ).vault;
    const planted = await encryptVault(serializeVault(other), await a.vk(), { vaultId: other.vaultId, rev: 1 });
    const v2 = await w.server.adminSetHead(JSON.stringify(planted));
    const listed2 = (await findSources(a.engine)).server!.find((x) => x.kind === "server" && x.version === v2)!;
    expect(await openFound(a.engine, listed2)).toEqual({ status: "unreadable", accounts: [] });
  });

  it("an old vault's snapshot (kept from before a join, under the cloud key, its own vault id): its accounts come back as new entries", async () => {
    const w = await worldOf(1, ["Mail"]);
    const [a] = w.devices as [Device];
    const vk = await a.vk();
    const old = addEntry(
      emptyVault("old-vault-0001"),
      input("Personal", secretOf("Personal")),
      createClock("devtest1"),
    ).vault;
    const rec = {
      v: 1,
      meta: { id: "rold", kind: "rolling", at: 1000, seq: 0 },
      envelope: await encryptVault(serializeVault(old), vk, { vaultId: old.vaultId, rev: 0 }),
    };
    const idx = parseSnapshotIndex(a.disk.kv.data.get(KEYS.snapIndex));
    a.disk.kv.data.set(KEYS.snap("rold"), rec);
    a.disk.kv.data.set(KEYS.snapIndex, [...idx, rec.meta]);
    const src = (await findSources(a.engine)).local.find((x) => x.kind === "local" && x.id === "rold")!;
    const found = await openFound(a.engine, src);
    expect(found.accounts.map((x) => x.issuer)).toEqual(["Personal"]);
    expect(await recoverFound(a.engine, found, [found.accounts[0]!.ref])).toBe(1);
    const back = aliveEntries(await a.vault()).find((e) => e.issuer === "Personal")!;
    expect(back.id).not.toBe(old.entries[0]!.id); // the added mode: a new id in this vault
  });

  it("a snapshot record of a newer format, or a vault of a newer schema: not opened here (update Sixkey), nothing listed", async () => {
    const w = await worldOf(1, ["Mail"]);
    const [a] = w.devices as [Device];
    const vk = await a.vk();
    const vaultId = (await a.vault()).vaultId;
    const newer = new TextEncoder().encode(JSON.stringify({ schemaVersion: 99, vaultId, entries: [] }));
    const recs = {
      // a record of a later format whose envelope this build could open: still not read (its other members are unknown)
      rnewfmt: {
        v: 2,
        meta: { id: "rnewfmt", kind: "rolling", at: 1, seq: 0 },
        envelope: await encryptVault(
          serializeVault(
            addEntry(emptyVault(vaultId), input("Later", secretOf("Later")), createClock("devtest1")).vault,
          ),
          vk,
          { vaultId, rev: 0 },
        ),
      },
      rnewsch: {
        v: 1,
        meta: { id: "rnewsch", kind: "rolling", at: 2, seq: 0 },
        envelope: await encryptVault(newer, vk, { vaultId, rev: 0 }),
      },
    };
    const idx = parseSnapshotIndex(a.disk.kv.data.get(KEYS.snapIndex));
    for (const [id, r] of Object.entries(recs)) a.disk.kv.data.set(KEYS.snap(id), r);
    a.disk.kv.data.set(KEYS.snapIndex, [...idx, recs.rnewfmt.meta, recs.rnewsch.meta]);
    const local = (await findSources(a.engine)).local;
    const pick = (id: string) => local.find((x) => x.kind === "local" && x.id === id)!;
    expect(await openFound(a.engine, pick("rnewfmt"))).toEqual({ status: "unreadable", accounts: [] });
    expect(await openFound(a.engine, pick("rnewsch"))).toEqual({ status: "newer_schema", accounts: [] });
  });
});

describe("what a version holds that the vault does not (missingFrom)", () => {
  const c = createClock("devtest1");
  const base = (names: string[]) =>
    names.reduce((v, n) => addEntry(v, input(n, secretOf(n)), c).vault, emptyVault("vault-1"));
  it("alive now by id or as the same account under another id: not listed; the trash and erased ones are; each account once", () => {
    const then = base(["A", "B", "C", "D"]);
    const ids = Object.fromEntries(then.entries.map((e) => [e.issuer, e.id]));
    let now = deleteEntry(then, ids.B!, c); // B in the trash
    now = { ...now, entries: now.entries.filter((e) => e.id !== ids.C) }; // C not here at all
    now = addEntry(now, input("D", secretOf("D")), c).vault; // D again, under a new id: alive
    now = { ...now, entries: now.entries.filter((e) => e.id !== ids.D) };
    expect(
      missingFrom(then, now)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["B", "C"]);
    // alive by its id, renamed since (another key now): it is there, not listed
    const renamed = editEntry(then, ids.A!, { label: "renamed" }, c);
    expect(missingFrom(then, renamed).map((e) => e.issuer)).toEqual([]);
    const a = then.entries.find((e) => e.issuer === "A")!;
    const twice = { ...then, entries: [...then.entries, { ...a, id: "zz-twin" }] };
    expect(missingFrom(twice, emptyVault("vault-1")).filter((e) => e.issuer === "A")).toHaveLength(1);
    // another vault: by the account only
    const other = { ...then, vaultId: "vault-2" };
    expect(missingFrom(other, then)).toEqual([]);
  });
});

describe("find accounts: the flow (find.ts FindFlow)", () => {
  function begin(kit: TestKit, perm: PermFake): FindFlow {
    const f = new FindFlow(kit);
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    return f;
  }

  it("asked in the click; the versions; one opened; the ticked ones brought back; done", async () => {
    const { a, erased } = await erasedElsewhere();
    const perm = permissions(true);
    const kit = kitOf(a, perm);
    const f = begin(kit, perm);
    expect(perm.log).toEqual(["request"]);
    await until(() => f.state.at === "sources", "the sources");
    const s = f.state as Extract<FindFlow["state"], { at: "sources" }>;
    let opened = false;
    for (const src of s.sources.server!) {
      await f.open(src);
      const st = f.state as Extract<FindFlow["state"], { at: "accounts" }>;
      if (st.accounts.length === erased.length) {
        opened = true;
        break;
      }
      f.back();
    }
    expect(opened).toBe(true);
    const st = f.state as Extract<FindFlow["state"], { at: "accounts" }>;
    await f.recover([st.accounts[0]!.ref]);
    expect(f.state).toEqual({ at: "done", n: 1 });
    expect(kit.changes()).toBe(1);
    expect(issuers(await a.vault())).toHaveLength(2);
  });

  it("declined: the flow ends and reads nothing", async () => {
    const { w, a } = await erasedElsewhere();
    const perm = permissions(false);
    perm.answer = false;
    const n0 = w.server.requests.length;
    const f = begin(kitOf(a, perm), perm);
    await until(() => f.state.at === "failed", "the end");
    expect(f.state).toMatchObject({ failure: { code: "declined" } });
    expect(w.server.requests.length).toBe(n0);
  });

  it("a lock ends it at once; a lock during the edit waits for it, and the edit's outcome is said", async () => {
    const { a, erased } = await erasedElsewhere();
    const perm = permissions(true);
    const kit = kitOf(a, perm);
    const f = begin(kit, perm);
    await until(() => f.state.at === "sources", "the sources");
    await f.locked();
    expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
    // again, and the lock comes while the edit is under way
    const g = begin(kit, perm);
    await until(() => g.state.at === "sources", "the sources");
    const s = g.state as Extract<FindFlow["state"], { at: "sources" }>;
    for (const src of s.sources.local) {
      await g.open(src);
      const st = g.state as Extract<FindFlow["state"], { at: "accounts" }>;
      if (st.accounts.some((x) => erased.includes(x.issuer))) break;
      g.back();
    }
    const st = g.state as Extract<FindFlow["state"], { at: "accounts" }>;
    const run = g.recover([st.accounts[0]!.ref]);
    await g.locked();
    expect(g.state).toMatchObject({ at: "accounts", busy: true }); // the edit under way: waited for, not cut off
    await run;
    expect(g.state).toEqual({ at: "done", n: 1 });
  });
});

describe("find accounts: what tells a row or a version apart", () => {
  it("a row whose key is in the vault under another name, or whose name is in the vault with another key, says so", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device];
    w.advance(60_000);
    await trash(a, ["GitHub", "AWS"]);
    // GitHub's key again under another name; AWS's name again with another key
    await a.svc.mutate((v, c) => addEntry(v, { ...input("GitHub", secretOf("GitHub")), label: "renamed" }, c).vault);
    await a.add("AWS", secretOf("AWS-new"));
    const sources = await findSources(a.engine);
    let found: Found | null = null;
    for (const src of [...sources.local].reverse()) {
      const f = await openFound(a.engine, src);
      if (f.accounts.length >= 2) {
        found = f;
        break;
      }
      dropFound(f);
    }
    const byIssuer = Object.fromEntries(found!.accounts.map((x) => [x.issuer, x.note]));
    expect(byIssuer).toEqual({ GitHub: "same_key", AWS: "same_name" });
  });

  it("server versions under a key from before a rotation are marked as such; the newest is not", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const [a] = w.devices as [Device];
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    const server = (await findSources(a.engine)).server!.filter((x) => x.kind === "server");
    expect(server[0]).toMatchObject({ older: false });
    expect(server.slice(1).every((x) => x.kind === "server" && x.older)).toBe(true);
    expect(server.length).toBeGreaterThan(1);
  });

  it("a server that lists a very long history: the newest 64 versions are offered, not every one", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const [a] = w.devices as [Device];
    const hist = w.server.account(EMAIL).history;
    const last = hist[hist.length - 1]!;
    for (let i = 1; i <= 200; i++) hist.push({ ...last, version: last.version + i });
    const server = (await findSources(a.engine)).server!;
    expect(server).toHaveLength(64);
    expect(server[0]).toMatchObject({ version: last.version + 200 });
  });
});
