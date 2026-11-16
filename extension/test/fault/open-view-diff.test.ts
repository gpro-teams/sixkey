// PHASE0X-PLAN A2, §0.2 rule 4: the new read path must agree with the old one under injected faults. The new path is the
// popup's: loadScreen -> openView (one read of pointer + events + marker, one slot read, the settings, the generation reused).
// The reference is the popup's loader before A2, kept verbatim below: status(), then read(), then lastBackupAt().
// Each case clones one damaged disk into two independent worlds, so neither path's repairs can feed the other.
//   1. Random damage (fast-check): slots, pointer, keyring copy, snapshot index and records, mirror, events, the session,
//      the marker and sk_store_v, old key material left over; including copies that pass their checksum but do not
//      decrypt (decrypt fallback) and data from a newer schema. The two screens must be identical.
//   2. A crash at every write the new path makes (the store.test fault matrix: before, after, partial, torn) while it
//      repairs: after a restart the old path still shows the same accounts, and the new path agrees with it.
//   3. A read that throws, once, for any one key: the new path either gives the old path's screen or fails (only where
//      it reads that key together with others that the old path read alone and tolerated). It never shows something
//      else, what it leaves on disk opens the same way as what the old path leaves, and no snapshot record that was
//      valid before is gone unless the old path removed it too (a cleanup must not delete on account of a failed read).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromB64, toB64, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { unlockWithDevice, type Keyring } from "../../src/core/crypto/keyring";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { checkSnapshot, KEYS, parseSnapshotIndex } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { ServiceError, VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { canonicalJson } from "../../src/core/vault/merge";
import { addEntry } from "../../src/core/vault/ops";
import { VaultError } from "../../src/core/vault/validate";
import { loadScreen, type Screen } from "../../src/popup/load";
import { CrashError, FaultyKV, tear, type CrashMode } from "../helpers/faulty-kv";
import { legacyDeviceVault, STRONG, NO_PAGE } from "../helpers/vaults";

const t = { now: 1_700_000_000_000 };
const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

type World = { kv: MemoryKV; mirror: MemoryKV; session: MemorySession; withMirror: boolean };
const clone = (w: World): World => {
  const c = (m: MemoryKV) => {
    const n = new MemoryKV();
    for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
    return n;
  };
  const session = new MemorySession();
  session.data = w.session.data ? { ...w.session.data } : null;
  session.epoch = w.session.epoch;
  return { kv: c(w.kv), mirror: c(w.mirror), session, withMirror: w.withMirror };
};
const svcOver = (w: World, kv: KV = w.kv) =>
  new VaultService({
    store: new VaultStore({ lock: createMutex(), kv, ...(w.withMirror ? { mirror: w.mirror } : {}), now: () => t.now }),
    session: w.session,
    settings: new KvSettingsStore(kv),
    now: () => t.now,
  });

/** The popup's loader before PHASE0X-PLAN A2, verbatim: the reference implementation. */
async function oldLoadScreen(svc: VaultService): Promise<Screen> {
  try {
    const st = await svc.status();
    if (st.state === "empty") return { k: "welcome" };
    if (st.state === "lost") return { k: "lost" };
    if (st.state === "locked") return { k: "locked" };
    const { vault, recovered } = await svc.read();
    return {
      k: "main",
      vault,
      events: recovered ? [...st.events, recovered] : st.events,
      protected: st.passwordProtected,
      lastBackup: await svc.lastBackupAt(),
    } as Screen;
  } catch (e) {
    if (e instanceof VaultError && e.code === "newer_schema") return { k: "newer" };
    if (e instanceof ServiceError && e.code === "locked") return { k: "locked" };
    return { k: "error", code: e instanceof Error ? e.name : "unknown" };
  }
}
const newLoadScreen = (svc: VaultService) => loadScreen({ service: svc });

/** What the user sees, comparable across the two paths (the new screen also carries the settings, checked separately). */
const norm = (s: Screen, w: World) => ({
  ...(s.k === "main"
    ? { k: s.k, vault: canonicalJson(s.vault), events: s.events, protected: s.protected, lastBackup: s.lastBackup }
    : s),
  sessionKept: w.session.data !== null,
});

// ---- the worlds the damage is applied to -------------------------------------------------------------------------------

type Base = { w: World; vk: Vk; keyring: Keyring; residue: World; kind: "password" | "device" };

/** password: a Phase 0 vault upgraded with enableMasterPassword (with the pre-upgrade copy kept, to plant as residue). */
async function makeBase(kind: "password" | "device"): Promise<Base> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession(), withMirror: true };
  await legacyDeviceVault(new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now }));
  const svc = svcOver(w);
  for (const n of ["GitHub", "AWS", "Stripe", "Bank"]) {
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input(n), c).vault);
  }
  await new VaultStore({
    lock: createMutex(),
    kv: w.kv,
    mirror: w.mirror,
    now: () => t.now,
    dayKey: () => "2026-01-01",
  }).ensureDailySnapshot();
  const residue = clone(w);
  if (kind === "password") {
    await svc.enableMasterPassword(STRONG, NO_PAGE);
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input("Mail"), c).vault);
    await new VaultStore({
      lock: createMutex(),
      kv: w.kv,
      mirror: w.mirror,
      now: () => t.now,
      dayKey: () => "2026-01-02",
    }).ensureDailySnapshot();
    await svc.ackEvents();
  }
  const keyring = (await svc.currentGeneration())!.keyring;
  const vk = kind === "password" ? await vkFromRaw(fromB64(w.session.data!.vk)) : await unlockWithDevice(keyring);
  return { w, vk, keyring, residue, kind };
}

const SLOT_TARGETS = ["active", "other"] as const;
const TARGETS = [
  ...SLOT_TARGETS,
  "pointer",
  "keyringCopy",
  "snapIndex",
  "snapNewest",
  "snapAny",
  "mirrorGen",
  "mirrorIndex",
  "mirrorSnap",
  "events",
  "wipePrimary",
  "wipeMirror",
] as const;
const KINDS = ["delete", "tear", "garbage", "null", "flip", "junk", "newer", "older"] as const;
type Fault = { target: (typeof TARGETS)[number]; kind: (typeof KINDS)[number]; pick: number };
const SESSIONS = ["alive", "none", "expired", "lockedElsewhere", "otherKey"] as const;
const MARKERS = ["steady", "marker", "garbled", "noVersion"] as const;
type Knobs = {
  kind: "password" | "device";
  session: (typeof SESSIONS)[number];
  marker: (typeof MARKERS)[number];
  residue: boolean;
  withMirror: boolean;
  faults: Fault[];
};

async function envelopeOf(b: Base, plain: string, rev: number) {
  return encryptVault(utf8(plain), b.vk, { vaultId: b.keyring.vaultId, rev });
}

/** Apply the knobs to a clone of the base world. Every damage is something a disk, a crash or an old version can leave. */
async function damaged(b: Base, k: Knobs): Promise<World> {
  const w = clone(b.w);
  w.withMirror = k.withMirror;
  const s = w.session;
  if (k.kind === "password" && s.data) {
    if (k.session === "none") s.data = null;
    else if (k.session === "expired") s.data = { ...s.data, lastActive: t.now - 16 * 60_000 };
    else if (k.session === "lockedElsewhere") s.epoch = (s.data.epoch ?? 0) + 1;
    else if (k.session === "otherKey") s.data = { ...s.data, vk: toB64(new Uint8Array(32).fill(7)) };
  }
  if (k.marker === "marker") w.kv.data.set(KEYS.keyChange, { v: 1, vkId: b.keyring.vkId, at: 1 });
  else if (k.marker === "garbled") w.kv.data.set(KEYS.keyChange, "garbage");
  else if (k.marker === "noVersion") w.kv.data.delete(KEYS.storeVersion);
  if (k.residue && k.kind === "password") {
    // the pre-upgrade other slot and snapshots, as an interrupted cleanup leaves them
    const ptr = w.kv.data.get(KEYS.active) as "a" | "b";
    const otherKey = KEYS.slot[ptr === "a" ? "b" : "a"];
    w.kv.data.set(otherKey, structuredClone(b.residue.kv.data.get(KEYS.slot.a) ?? b.residue.kv.data.get(KEYS.slot.b)));
    const old = parseSnapshotIndex(b.residue.kv.data.get(KEYS.snapIndex)).map((m) => ({ ...m, id: `${m.id}o` }));
    for (const m of old) {
      const rec = structuredClone(b.residue.kv.data.get(KEYS.snap(m.id.slice(0, -1)))) as { meta: { id: string } };
      rec.meta.id = m.id;
      w.kv.data.set(KEYS.snap(m.id), rec);
    }
    w.kv.data.set(KEYS.snapIndex, [...parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)), ...old]);
  }
  for (const f of k.faults) await applyFault(b, w, f);
  return w;
}

async function applyFault(b: Base, w: World, f: Fault): Promise<void> {
  if (f.target === "wipePrimary") {
    const keep = new Map([...w.kv.data].filter(([key]) => key === "sk_settings"));
    w.kv.data.clear();
    for (const [key, v] of keep) w.kv.data.set(key, v);
    return;
  }
  if (f.target === "wipeMirror") {
    w.mirror.data.clear();
    return;
  }
  const ptr = (w.kv.data.get(KEYS.active) === "b" ? "b" : "a") as "a" | "b";
  const snaps = (m: MemoryKV) => parseSnapshotIndex(m.data.get(KEYS.snapIndex)).sort((x, y) => y.seq - x.seq);
  let m = w.kv;
  let key: string;
  switch (f.target) {
    case "active":
      key = KEYS.slot[ptr];
      break;
    case "other":
      key = KEYS.slot[ptr === "a" ? "b" : "a"];
      break;
    case "pointer":
      key = KEYS.active;
      break;
    case "keyringCopy":
      key = KEYS.keyringCopy;
      break;
    case "snapIndex":
      key = KEYS.snapIndex;
      break;
    case "snapNewest": {
      const s = snaps(w.kv)[0];
      if (!s) return;
      key = KEYS.snap(s.id);
      break;
    }
    case "snapAny": {
      const all = snaps(w.kv);
      if (!all.length) return;
      key = KEYS.snap(all[f.pick % all.length]!.id);
      break;
    }
    case "mirrorGen":
      m = w.mirror;
      key = KEYS.mirrorGen;
      break;
    case "mirrorIndex":
      m = w.mirror;
      key = KEYS.snapIndex;
      break;
    case "mirrorSnap": {
      m = w.mirror;
      const s = snaps(w.mirror)[0];
      if (!s) return;
      key = KEYS.snap(s.id);
      break;
    }
    case "events":
      key = KEYS.events;
      break;
  }
  const cur = m.data.get(key) as any;
  const isGen = key === KEYS.slot.a || key === KEYS.slot.b || key === KEYS.mirrorGen;
  const isSnap = key.startsWith("sk_snap_") && key !== KEYS.snapIndex;
  switch (f.kind) {
    case "delete":
      m.data.delete(key);
      return;
    case "tear":
      if (cur !== undefined) m.data.set(key, tear(cur));
      return;
    case "null":
      m.data.set(key, null);
      return;
    case "garbage":
      m.data.set(key, "garbage");
      return;
    case "flip":
      if ((isGen || isSnap) && cur?.envelope) {
        const g = structuredClone(cur);
        const by = fromB64(g.envelope.ciphertext);
        by[3]! ^= 1;
        g.envelope.ciphertext = toB64(by);
        m.data.set(key, g);
      } else if (key === KEYS.active)
        m.data.set(key, ptr === "a" ? "b" : "a"); // the pointer names the older slot
      else if (key === KEYS.events)
        m.data.set(key, [{ id: "1-0-slot_fallback", kind: "slot_fallback", at: 1, restoredTo: 1, detail: "earlier" }]);
      return;
    case "junk":
    case "newer": {
      // passes every check that needs no key, but does not open (junk) or is from a newer version (newer)
      if (!(isGen || isSnap) || !cur?.envelope) return;
      const plain =
        f.kind === "junk"
          ? "this is not a vault"
          : JSON.stringify({ schemaVersion: 99, vaultId: b.keyring.vaultId, entries: [] });
      const envelope = await envelopeOf(b, plain, cur.envelope.rev + 50);
      m.data.set(
        key,
        isGen
          ? {
              ...structuredClone(cur),
              envelope,
              keyring: isGen && cur.keyring?.vkId === b.keyring.vkId ? cur.keyring : b.keyring,
            }
          : { ...structuredClone(cur), envelope },
      );
      return;
    }
    case "older":
      // an older, valid copy: the other slot's generation in the active slot, or the oldest snapshot in place of the newest
      if (isGen && m === w.kv) {
        const o = w.kv.data.get(KEYS.slot[key === KEYS.slot.a ? "b" : "a"]);
        if (o !== undefined) m.data.set(key, structuredClone(o));
      } else if (isSnap) {
        const all = snaps(m);
        const oldest = all.at(-1);
        if (oldest) {
          const rec = structuredClone(m.data.get(KEYS.snap(oldest.id))) as any;
          if (rec?.meta) {
            rec.meta = { ...cur?.meta };
            m.data.set(key, rec);
          }
        }
      }
      return;
  }
}

const knobs = (kinds: ("password" | "device")[]) =>
  fc.record({
    kind: fc.constantFrom(...kinds),
    session: fc.constantFrom(...SESSIONS),
    marker: fc.constantFrom(...MARKERS),
    residue: fc.boolean(),
    withMirror: fc.boolean(),
    faults: fc.array(
      fc.record({ target: fc.constantFrom(...TARGETS), kind: fc.constantFrom(...KINDS), pick: fc.nat(100) }),
      { maxLength: 4 },
    ),
  });

// ---- 1. random damage ---------------------------------------------------------------------------------------------------

describe("openView agrees with status() + read() on any damaged disk", () => {
  it("the same screen: state, accounts (canonical JSON), events, protection, last backup, and whether the session survives", async () => {
    const bases = { password: await makeBase("password"), device: await makeBase("device") };
    let mains = 0;
    const kinds = new Set<string>();
    await fc.assert(
      fc.asyncProperty(knobs(["password", "device"]), async (k) => {
        const b = bases[k.kind];
        const disk = await damaged(b, k);
        const a = clone(disk);
        const n = clone(disk);
        const oldScreen = await oldLoadScreen(svcOver(a));
        const svc = svcOver(n);
        const newScreen = await newLoadScreen(svc);
        expect(norm(newScreen, n), JSON.stringify(k)).toEqual(norm(oldScreen, a));
        kinds.add(newScreen.k === "error" ? `error:${newScreen.code}` : newScreen.k);
        if (newScreen.k === "main") {
          mains++;
          expect(newScreen.settings).toEqual(await svc.getSettings());
        }
        // and what the new path left on disk opens, by the old path, the same way again
        expect(norm(await oldLoadScreen(svcOver(n)), n), `again ${JSON.stringify(k)}`).toEqual(norm(newScreen, n));
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 250) },
    );
    // the generator reaches the interesting branches, not only the healthy one
    expect(mains).toBeGreaterThan(20);
    expect([...kinds]).toEqual(expect.arrayContaining(["main", "locked"])); // the rarer branches: the fixed cases below
  }, 120_000);

  // Each recovery branch at least once, deterministically (the random run above may or may not hit each).
  const BRANCHES: [string, Partial<Knobs>][] = [
    ["healthy", {}],
    ["active slot damaged -> other slot (slot_fallback)", { faults: [{ target: "active", kind: "tear", pick: 0 }] }],
    ["pointer garbled -> newest slot wins", { faults: [{ target: "pointer", kind: "garbage", pick: 0 }] }],
    ["pointer names the older slot", { faults: [{ target: "pointer", kind: "flip", pick: 0 }] }],
    [
      "both slots damaged -> newest snapshot (snapshot_restore)",
      {
        faults: [
          { target: "active", kind: "tear", pick: 0 },
          { target: "other", kind: "garbage", pick: 0 },
        ],
      },
    ],
    [
      "both slots and the newest snapshot damaged -> an older snapshot",
      {
        faults: [
          { target: "active", kind: "null", pick: 0 },
          { target: "other", kind: "delete", pick: 0 },
          { target: "snapNewest", kind: "tear", pick: 0 },
        ],
      },
    ],
    [
      "primary wiped, only the mirror left (mirror_restore)",
      { faults: [{ target: "wipePrimary", kind: "delete", pick: 0 }] },
    ],
    [
      "primary wiped and no mirror -> empty",
      { withMirror: false, faults: [{ target: "wipePrimary", kind: "delete", pick: 0 }] },
    ],
    [
      "slots and keyring copy gone, nothing to open -> lost",
      {
        withMirror: false,
        faults: [
          { target: "active", kind: "garbage", pick: 0 },
          { target: "other", kind: "garbage", pick: 0 },
          { target: "keyringCopy", kind: "delete", pick: 0 },
        ],
      },
    ],
    [
      "active copy passes its checksum but does not decrypt (decrypt_fallback)",
      { faults: [{ target: "active", kind: "junk", pick: 0 }] },
    ],
    [
      "active copy and the other slot both junk -> a snapshot opens",
      {
        faults: [
          { target: "active", kind: "junk", pick: 0 },
          { target: "other", kind: "junk", pick: 0 },
        ],
      },
    ],
    ["data from a newer schema is never recovered around", { faults: [{ target: "active", kind: "newer", pick: 0 }] }],
    ["unacknowledged events from before", { faults: [{ target: "events", kind: "flip", pick: 0 }] }],
    ["garbage events", { faults: [{ target: "events", kind: "garbage", pick: 0 }] }],
    ["key-change marker pending, with old material", { marker: "marker", residue: true }],
    ["store from before the marker, with old material", { marker: "noVersion", residue: true }],
    [
      "marker pending and the active slot damaged",
      { marker: "marker", residue: true, faults: [{ target: "active", kind: "tear", pick: 0 }] },
    ],
    ["session expired", { session: "expired" }],
    ["locked from another context", { session: "lockedElsewhere" }],
    ["session holds another key", { session: "otherKey" }],
    ["no session", { session: "none" }],
  ];
  it.each(BRANCHES)(
    "%s",
    async (_name, partial) => {
      const k: Knobs = {
        kind: "password",
        session: "alive",
        marker: "steady",
        residue: false,
        withMirror: true,
        faults: [],
        ...partial,
      };
      for (const kind of ["password", "device"] as const) {
        const b = await makeBase(kind);
        const disk = await damaged(b, { ...k, kind });
        const a = clone(disk);
        const n = clone(disk);
        const oldScreen = await oldLoadScreen(svcOver(a));
        const newScreen = await newLoadScreen(svcOver(n));
        expect(norm(newScreen, n), kind).toEqual(norm(oldScreen, a));
        expect(newScreen.k, kind).not.toBe("error");
      }
    },
    60_000,
  );
});

// ---- 2. a crash at every write the new path makes while it repairs ----------------------------------------------------

describe("a crash at any write of the new path's repairs loses nothing", () => {
  const STATES: [string, Partial<Knobs>][] = [
    ["slot fallback", { faults: [{ target: "active", kind: "tear", pick: 0 }] }],
    [
      "snapshot restore",
      {
        faults: [
          { target: "active", kind: "tear", pick: 0 },
          { target: "other", kind: "garbage", pick: 0 },
        ],
      },
    ],
    ["mirror restore", { faults: [{ target: "wipePrimary", kind: "delete", pick: 0 }] }],
    ["decrypt fallback", { faults: [{ target: "active", kind: "junk", pick: 0 }] }],
    ["key-change cleanup", { marker: "marker", residue: true }],
  ];
  const MODES: CrashMode[] = ["before", "after", "partial", "torn"];
  it.each(STATES)(
    "%s",
    async (_name, partial) => {
      const b = await makeBase("password");
      const disk = await damaged(b, {
        kind: "password",
        session: "alive",
        marker: "steady",
        residue: false,
        withMirror: true,
        faults: [],
        ...partial,
      });
      // what a fault-free open shows, and how many writes it makes
      const probe = clone(disk);
      const pk = new FaultyKV(probe.kv);
      const expected = await newLoadScreen(svcOver(probe, pk));
      expect(expected.k).toBe("main");
      const writes = pk.calls;
      expect(writes).toBeGreaterThan(0);
      const want = expected.k === "main" ? canonicalJson(expected.vault) : "";

      for (let at = 1; at <= writes; at++) {
        for (const mode of MODES) {
          const where = `${mode} at write ${at}/${writes}`;
          const w = clone(disk);
          const faulty = new FaultyKV(w.kv, { at, mode });
          const s = await newLoadScreen(svcOver(w, faulty));
          expect(faulty.crashed, where).toBe(true);
          expect(s.k === "main" || s.k === "error", where).toBe(true);
          if (s.k === "error") expect(s.code, where).toBe(new CrashError().name);
          // restart: the old path shows the same accounts, and the new path agrees with it
          const after = clone(w);
          const oldAfter = await oldLoadScreen(svcOver(w));
          expect(oldAfter.k, where).toBe("main");
          expect(oldAfter.k === "main" && canonicalJson(oldAfter.vault), where).toBe(want);
          const newAfter = await newLoadScreen(svcOver(after));
          expect(norm(newAfter, after), where).toEqual(norm(oldAfter, w));
        }
      }
    },
    120_000,
  );
});

// ---- 3. a read that throws -----------------------------------------------------------------------------------------------

/** A store whose first read of `key` (alone or together with others) throws, once. */
class FailFirstReadOf implements KV {
  failed = false;
  constructor(
    readonly inner: KV,
    private key: string,
  ) {}
  async get(keys: string[]) {
    if (!this.failed && keys.includes(this.key)) {
      this.failed = true;
      throw Object.assign(new Error("IO error: transient"), { name: "IOError" });
    }
    return this.inner.get(keys);
  }
  set(i: Record<string, unknown>) {
    return this.inner.set(i);
  }
  remove(k: string[]) {
    return this.inner.remove(k);
  }
  keys() {
    return this.inner.keys();
  }
}

// The keys the new path reads together in one call, where the old path read them alone and tolerated a failure: the
// events (and the marker and sk_store_v, which it did not read at all); for a device-key vault also the settings,
// which the old path never read for one. A failure of one of these may fail the new open; of any other key, not.
const READ_TOGETHER = {
  password: new Set<string>([KEYS.events, KEYS.keyChange, KEYS.storeVersion]),
  device: new Set<string>([KEYS.events, KEYS.keyChange, KEYS.storeVersion, "sk_settings"]),
};
/** Snapshot records that pass their check, by key. */
async function validRecords(m: MemoryKV): Promise<string[]> {
  const out: string[] = [];
  for (const [k, v] of m.data)
    if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex && (await checkSnapshot(v))) out.push(k);
  return out;
}

describe("a read that throws is never repaired over, and never shows something the old path would not", () => {
  const STATES: [string, Partial<Knobs>][] = [
    ["healthy", {}],
    ["slot fallback", { faults: [{ target: "active", kind: "tear", pick: 0 }] }],
    [
      "snapshot restore",
      {
        faults: [
          { target: "active", kind: "tear", pick: 0 },
          { target: "other", kind: "garbage", pick: 0 },
        ],
      },
    ],
    ["mirror restore", { faults: [{ target: "wipePrimary", kind: "delete", pick: 0 }] }],
    ["decrypt fallback", { faults: [{ target: "active", kind: "junk", pick: 0 }] }],
    ["key-change cleanup", { marker: "marker", residue: true }],
    ["store from before the marker", { marker: "noVersion", residue: true }],
  ];
  it.each(STATES)(
    "%s",
    async (_name, partial) => {
      for (const kind of ["password", "device"] as const) {
        const b = await makeBase(kind);
        const disk = await damaged(b, {
          kind,
          session: "alive",
          marker: "steady",
          residue: false,
          withMirror: true,
          faults: [],
          ...partial,
        });
        const keys = new Set([
          ...disk.kv.data.keys(),
          KEYS.keyChange,
          KEYS.storeVersion,
          KEYS.events,
          "sk_settings",
          "sk_last_backup",
          KEYS.keyringCopy,
        ]);
        const beforeLocal = await validRecords(disk.kv);
        const beforeMirror = await validRecords(disk.mirror);
        for (const key of keys) {
          const where = `${kind}, the first read of ${key} fails`;
          const a = clone(disk);
          const n = clone(disk);
          const oldScreen = await oldLoadScreen(svcOver(a, new FailFirstReadOf(a.kv, key)));
          const newScreen = await newLoadScreen(svcOver(n, new FailFirstReadOf(n.kv, key)));
          if (newScreen.k === "error") {
            // allowed: the old path failed too, or the key is one the new path reads together with others
            if (oldScreen.k !== "error")
              expect(READ_TOGETHER[kind].has(key), `${where}: the new path failed where the old did not`).toBe(true);
          } else {
            expect(norm(newScreen, n), where).toEqual(norm(oldScreen, a));
          }
          // nothing deleted on account of the failed read: a record valid before is gone only if the old path removed it too
          for (const [label, before, nm, am] of [
            ["local", beforeLocal, n.kv, a.kv],
            ["mirror", beforeMirror, n.mirror, a.mirror],
          ] as const) {
            const lost = before.filter((k) => !nm.data.has(k) && am.data.has(k));
            expect(lost, `${where}: ${label} records removed by the new path only`).toEqual([]);
          }
          // and nothing was repaired over the failed read: both disks open the same way afterwards
          expect(norm(await oldLoadScreen(svcOver(n)), n), `${where}, afterwards`).toEqual(
            norm(await oldLoadScreen(svcOver(a)), a),
          );
        }
      }
    },
    120_000,
  );
});
