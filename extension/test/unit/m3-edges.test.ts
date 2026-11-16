// M3 edge cases each tied to a rule a plausible bug would break (docs/design/notes/M3-NOTES.md, the mutation list): a locked push that
// fails keeps its outbox; far-future stamps are clamped in the merge (F5); PROBE-2 through the engine (the pins settled
// before the key decision, M2R-1); a stale capability is evaluated again, never committed again (RR-1); RR-12's check
// after the first upload's 201 and on its resume; a real keys_conflict is "changed elsewhere" and commits nothing; the
// guard (§4.4) on the two merge paths other than the round's (an adoption of a new key, a rejoin into the same vault).
import { describe, expect, it } from "vitest";
import { setPassword } from "../../src/core/crypto/keyring";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { MergeBlocked } from "../../src/core/service/sync-flows";
import { commitJoin, firstUpload, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRotation,
  KeyOpError,
  prepareRecoveryCode,
  prepareRotation,
  turnSyncOff,
  type AdoptResult,
} from "../../src/core/sync/engine/keys";
import { MAX_FUTURE_DRIFT_MS, parseHlc } from "../../src/core/vault/hlc";
import { aliveEntries, isPurged } from "../../src/core/vault/model";
import { deleteEntry, editEntry, purgeEntry } from "../../src/core/vault/ops";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { createProtected } from "../helpers/vaults";
import { cj, contextOver, EMAIL, type Device, World, worldOf } from "../helpers/m3-world";

const NEW_PW = "violet-harbour-cinder-93";
const two = async (names = ["GitHub"]) => {
  const w = await worldOf(2, names);
  return { w, a: w.devices[0]! as Device, b: w.devices[1]! as Device };
};

class NoWrite implements KV {
  constructor(readonly inner: MemoryKV) {}
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

describe("§4.7: a locked push that fails keeps its outbox", () => {
  it("the PUT never reached the server: the outbox stays and the next wake pushes it", async () => {
    const { w, a, b } = await two();
    await a.add("pending");
    await a.lockNow();
    a.net.inject({ match: "PUT /v1/vault", kind: "fail_before" });
    expect((await a.engine.round()).status).toBe("offline");
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox)).toBeTruthy();
    expect((await a.engine.round({ explicit: true })).pushedOutbox).toBe(true);
    await b.engine.round();
    expect(aliveEntries(await b.vault()).map((e) => e.issuer)).toContain("pending");
    void w;
  });
});

describe("F5: the merge clamps stamps from the future", () => {
  it("a remote entry stamped 10 days ahead is stored clamped to now + 24 h, so an edit made here an hour later still wins", async () => {
    const { w, a } = await two();
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const v = await a.vault();
    const e = v.entries[0]!;
    const future = (h: string) => h.replace(/^\d{13}/, String(w.clock.now + 10 * 86_400_000).padStart(13, "0"));
    const evil = { ...v, entries: [{ ...e, label: "from the future", hlc: future(e.hlc), phlc: future(e.phlc) }] };
    await w.server.adminSetHead(
      (await uploadEnvelope(evil, vk, { vaultId, rev: w.server.account(EMAIL).vault!.version + 1 })).text,
    );
    await a.engine.round();
    const got = (await a.vault()).entries[0]!;
    expect(got.label).toBe("from the future");
    expect(parseHlc(got.hlc)!.wall).toBeLessThanOrEqual(w.clock.now + MAX_FUTURE_DRIFT_MS + 60_000);
    w.advance(3_600_000);
    await a.unlock();
    await a.svc.mutate((x, c) => editEntry(x, e.id, { label: "mine, later" }, c));
    await a.engine.round();
    expect((await a.vault()).entries[0]!.label).toBe("mine, later");
  });
});

describe("M2R-1 through the engine: the pins are settled before every key decision", () => {
  it("PROBE-2: this device changed the password and IndexedDB refuses the pin writes; the next round still finds the server's bundle in sync", async () => {
    const { a } = await two();
    // a context whose IndexedDB refuses writes: the commit's pins stay pending in storage.local
    const broken = contextOver({
      kv: a.disk.kv,
      mirror: a.disk.mirror,
      idb: new NoWrite(a.disk.idb),
      session: a.disk.session,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: a.net,
      clock: a.now,
    });
    await changePassword(broken.engine, "tulip-orbit-lantern-84", NEW_PW);
    expect((a.disk.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeDefined();
    const r = await broken.engine.round();
    expect(r.keyStatus).toBe("ok"); // not "rejected" (auth_without_password from a stale adopted.auth)
    expect(r.status).toBe("ok");
  });
});

describe("RR-1: a stale capability is evaluated again, never committed again", () => {
  it("another context commits the same adoption between this round's verdict and its commit: this commit is its retry (not stale) and the round is in sync", async () => {
    const { w, a, b } = await two();
    const h = await prepareRecoveryCode(a.engine, w.password);
    await commitRecoveryCode(a.engine, h);
    const page = contextOver({
      ...b.disk,
      lock: b.lock,
      identityLock: b.identityLock,
      syncLock: () => Promise.resolve({ ran: false as const }),
      transport: b.net,
      clock: b.now,
    });
    const flows = b.ctx.flows;
    const commit = flows.commitKeys.bind(flows);
    let raced = false;
    (b.ctx.engine.deps.flows as { commitKeys: typeof flows.commitKeys }).commitKeys = async (c) => {
      if (!raced) {
        raced = true;
        // the settings page adopts the same bundle first (its own evaluation and capability)
        const { evaluateSameVkBundle } = await import("../../src/core/sync/crypto/bundle-eval");
        const { parseBundleText } = await import("../../src/core/sync/crypto/keybundle");
        const id = (await page.local.settlePins()) as unknown as {
          maxSeenKver: number;
          adopted: { auth: { kdf: never }; digest: string };
        };
        const cur = await page.flows.current();
        const v = await evaluateSameVkBundle({
          bundle: parseBundleText(w.server.account(EMAIL).vault!.bundle),
          vk: cur.vk,
          local: cur.gen.keyring,
          maxSeenKver: id.maxSeenKver,
          expectedVaultId: cur.gen.keyring.vaultId,
          adoptedAuth: id.adopted.auth,
          adoptedDigest: id.adopted.digest,
        });
        if (v.kind !== "adopt") throw new Error(v.kind);
        await page.flows.commitKeys({ keys: v });
      }
      return commit(c);
    };
    const r = await b.engine.round();
    expect(raced).toBe(true);
    expect(r.status).toBe("ok");
    expect(r.keyStatus).toBe("ok");
    expect(cj((await b.generation()).keyring)).toBe(cj((await a.generation()).keyring));
  });
});

describe("RR-1: a capability made stale by another commit", () => {
  it("another context adopts a newer bundle between this round's verdict and its commit: refused as stale, evaluated again (never committed again), in sync", async () => {
    const { w, a, b } = await two();
    const h1 = await prepareRecoveryCode(a.engine, w.password);
    await commitRecoveryCode(a.engine, h1); // kver 2
    const page = contextOver({
      ...b.disk,
      lock: b.lock,
      identityLock: b.identityLock,
      syncLock: () => Promise.resolve({ ran: false as const }),
      transport: b.net,
      clock: b.now,
    });
    const flows = b.ctx.flows;
    const commit = flows.commitKeys.bind(flows);
    const calls: string[] = [];
    (b.ctx.engine.deps.flows as { commitKeys: typeof flows.commitKeys }).commitKeys = async (c) => {
      if (calls.length === 0) {
        calls.push("raced");
        // A changes the code again (kver 3) and the settings page here adopts that one first
        const h2 = await prepareRecoveryCode(a.engine, w.password);
        await commitRecoveryCode(a.engine, h2);
        const { evaluateSameVkBundle } = await import("../../src/core/sync/crypto/bundle-eval");
        const { parseBundleText } = await import("../../src/core/sync/crypto/keybundle");
        const id = (await page.local.settlePins()) as unknown as {
          maxSeenKver: number;
          adopted: { auth: { kdf: never }; digest: string };
        };
        const cur = await page.flows.current();
        const v = await evaluateSameVkBundle({
          bundle: parseBundleText(w.server.account(EMAIL).vault!.bundle),
          vk: cur.vk,
          local: cur.gen.keyring,
          maxSeenKver: id.maxSeenKver,
          expectedVaultId: cur.gen.keyring.vaultId,
          adoptedAuth: id.adopted.auth,
          adoptedDigest: id.adopted.digest,
        });
        if (v.kind !== "adopt") throw new Error(v.kind);
        await page.flows.commitKeys({ keys: v });
      }
      try {
        await commit(c);
        calls.push("committed");
      } catch (e) {
        calls.push(`refused:${(e as Error).message}`);
        throw e;
      }
    };
    const r = await b.engine.round();
    expect(calls).toEqual(["raced", "refused:stale"]); // the kver-2 capability once, refused; never again
    expect(r.status).toBe("ok");
    expect(r.keyStatus).toBe("ok");
    expect(w.server.account(EMAIL).vault!.kver).toBe(3);
    expect(cj((await b.generation()).keyring)).toBe(cj((await a.generation()).keyring));
  });
});

describe('RR-12: the first upload\'s "in sync" pins only for the keyring that was sent', () => {
  async function racedUpload(o: { lose: boolean }) {
    const w = new World();
    const a = w.device("A");
    w.code = (await createProtected(a.svc, w.password)).recoveryCode;
    await a.svc.openView();
    // a tab of a build without the sync_on check (or a store-level writer) changes the keyring while init is in flight
    w.server.fault({
      match: "POST /v1/vault/init",
      kind: "hook",
      fn: async () => {
        const g = await a.generation();
        const vk = await a.vk();
        const kr = await setPassword(g.keyring, vk, "another-strong-pass-77", {
          now: () => Math.floor(w.clock.now / 3_600_000) * 3_600_000,
        });
        await a.ctx.store.transact(async (cur) => ({ envelope: cur!.envelope, keyring: kr }));
      },
    });
    if (o.lose) a.net.inject({ match: "POST /v1/vault/init", kind: "lose_response", count: 3 });
    const r = await firstUpload(a.engine, {
      session: await w.server.session(EMAIL),
      password: w.password,
      recoveryCode: w.code,
      deviceName: "A",
      email: EMAIL,
    });
    return { w, a, r };
  }
  it('after the 201: the local keyring is no longer the one sent; no "in sync" pins, and nothing reverts the other tab\'s change', async () => {
    const { a, r } = await racedUpload({ lose: false });
    expect(r).toEqual({ kind: "done" });
    const id = (await a.local.settlePins()) as { adopted: unknown; state: string };
    expect(id.adopted).toBeNull();
    expect(id.state).toBe("enrolled");
    const kr = cj((await a.generation()).keyring);
    await a.engine.round();
    await a.engine.round();
    expect(cj((await a.generation()).keyring)).toBe(kr); // never adopted back
    // unpinned, but the identity knows its vault (the cloud restore's guard, §4.13; M3R-10 kept this write)
    expect(((await a.local.settlePins()) as { vaultId: string | null }).vaultId).toBe(
      (await a.generation()).keyring.vaultId,
    );
  });
  it("on the resume of a lost answer: the same check (the round pins it only for the keyring the server holds)", async () => {
    const { a, r } = await racedUpload({ lose: true });
    expect(r).toEqual({ kind: "unconfirmed" });
    const kr = cj((await a.generation()).keyring);
    await a.engine.round();
    await a.engine.round();
    const id = (await a.local.settlePins()) as { adopted: unknown };
    expect(id.adopted).toBeNull();
    expect(cj((await a.generation()).keyring)).toBe(kr);
  });
});

describe("§3.6.0: a real keys_conflict", () => {
  it("another device changed the keys before this one sent: changed_elsewhere; nothing committed; the shown code is not in effect", async () => {
    const { w, a, b } = await two();
    const before = cj((await a.generation()).keyring);
    const h = await prepareRecoveryCode(a.engine, w.password);
    const hb = await prepareRecoveryCode(b.engine, w.password); // B changes the recovery code first (the password stays)
    await commitRecoveryCode(b.engine, hb);
    const e = await commitRecoveryCode(a.engine, h).catch((x) => x);
    expect(e).toBeInstanceOf(KeyOpError);
    expect((e as KeyOpError).code).toBe("changed_elsewhere");
    expect(cj((await a.generation()).keyring)).toBe(before);
    expect(await a.engine.round()).toMatchObject({ keyStatus: "ok" }); // B's change is adopted (R2), A's shown code never took effect
    const { unlockWithRecoveryCode } = await import("../../src/core/crypto/keyring");
    expect(
      await unlockWithRecoveryCode((await a.generation()).keyring, h.recoveryCode).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  it("the password changed elsewhere meanwhile: the CAS answers before the proof (A5), so changed_elsewhere, not a wrong password; nothing committed", async () => {
    const { w, a, b } = await two();
    const before = cj((await a.generation()).keyring);
    const h = await prepareRecoveryCode(a.engine, w.password);
    await changePassword(b.engine, w.password, NEW_PW);
    await expect(commitRecoveryCode(a.engine, h)).rejects.toMatchObject({ code: "changed_elsewhere" });
    expect(cj((await a.generation()).keyring)).toBe(before);
    expect((await a.engine.view()).state.pendingRecoveryWrap ?? null).toBeNull(); // known not in effect: not pending
    expect(w.server.state(EMAIL).devices.every((d) => d.auth_failures === 0)).toBe(true); // no false "wrong password" banner
  });
});

describe("§4.4: the guard on every merge path, not only the round's", () => {
  async function erasedElsewhere() {
    const { w, a, b } = await two(["GitHub", "AWS"]);
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    return {
      w,
      a,
      b,
      aws,
      erase: async () => {
        w.advance(1000);
        await a.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c)); // erased in one step: B never saw it in the trash
        await a.engine.round();
      },
    };
  }
  it("adopting a rotation with the password: the new key's data would erase an account alive here; review_needed, nothing committed; [Apply] adopts it", async () => {
    const { w, a, b, aws, erase } = await erasedElsewhere();
    await erase();
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password));
    expect((await b.engine.round()).status).toBe("needs_password");
    const before = cj(await b.generation());
    const res = await adoptWithSecret(b.engine, { password: w.password });
    expect(res.kind).toBe("review_needed");
    const rv = res as Extract<AdoptResult, { kind: "review_needed" }>;
    expect(rv.report.purgedAlive).toEqual([aws]);
    expect(cj(await b.generation())).toBe(before); // nothing committed: neither the keys nor the data
    expect(
      await adoptWithSecret(b.engine, { password: w.password }, { answer: { seen: rv.seen, accept: [aws] } }),
    ).toEqual({ kind: "adopted", sameVk: false });
    expect(isPurged((await b.vault(await a.vk())).entries.find((e) => e.id === aws)!)).toBe(true);
    expect((await b.engine.round()).status).toBe("ok");
  });
  it("a rejoin by recovery code into the same vault: the cloud would erase an account alive here; MergeBlocked, the vault untouched; with the answer it joins", async () => {
    const { w, b, aws, erase } = await erasedElsewhere();
    await turnSyncOff(b.engine, w.password); // B keeps its vault (AWS alive)
    await erase();
    const before = cj(await b.generation());
    const go = async (answer?: Parameters<typeof joinWithRecoveryCode>[1]["answer"]) =>
      joinWithRecoveryCode(b.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: w.code,
        deviceName: "B again",
        email: EMAIL,
        ...(answer ? { answer } : {}),
      });
    const e = await go().catch((x) => x);
    expect(e).toBeInstanceOf(MergeBlocked);
    expect((e as MergeBlocked).report.purgedAlive).toEqual([aws]);
    expect(cj(await b.generation())).toBe(before);
    const plan = await go({ seen: (e as MergeBlocked).seen, accept: [aws] });
    expect(plan.prepared.mode).toBe("merged");
    expect(await commitJoin(plan)).toBe("enrolled");
    expect(isPurged((await b.vault()).entries.find((x) => x.id === aws)!)).toBe(true);
    expect((await b.engine.round()).status).toBe("ok");
  });
});
