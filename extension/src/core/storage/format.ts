// What is written to disk, and how to tell a usable copy from a damaged one without any key.
import { isEnvelopeIntact, validateEnvelope, type EncryptedVault } from "../crypto/envelope";
import { validateKeyring, type Keyring } from "../crypto/keyring";

export const KEYS = {
  active: "sk_active",
  slot: { a: "sk_slot_a", b: "sk_slot_b" },
  snapIndex: "sk_snap_idx",
  events: "sk_events",
  mirrorGen: "sk_mirror_gen",
  keyringCopy: "sk_keyring", // second copy of the current keyring, so snapshots stay openable if both slots are lost
  snap: (id: string) => `sk_snap_${id}`,
  /** "Old key material may be left, clean it up" (PHASE0X-PLAN A2). Written before a commit that changes the key; see store.ts. */
  keyChange: "sk_keychange",
  /** The last key under which every stored copy was checked and found current; see store.ts. */
  storeVersion: "sk_store_v",
} as const;

export type SlotName = "a" | "b";
export const other = (s: SlotName): SlotName => (s === "a" ? "b" : "a");

/** One complete, self-consistent saved state: the data and the keys that open it, written together. */
export type Generation = { v: 1; seq: number; savedAt: number; envelope: EncryptedVault; keyring: Keyring };

/** `seq` orders snapshots by how many saves came before them. The wall clock (`at`) can jump backwards, so it only breaks ties. */
export type SnapshotMeta = { id: string; kind: "rolling" | "daily"; at: number; seq: number; day?: string };
export const bySeq = (a: { seq: number; at: number }, b: { seq: number; at: number }) => b.seq - a.seq || b.at - a.at;
export type SnapshotRecord = { v: 1; meta: SnapshotMeta; envelope: EncryptedVault };

export type StorageEventKind =
  "slot_fallback" | "snapshot_restore" | "mirror_restore" | "decrypt_fallback" | "cloud_restore";
export type StorageEvent = {
  id: string;
  kind: StorageEventKind;
  at: number; // when the recovery happened
  restoredTo: number; // the time of the data that was restored (savedAt of the generation or snapshot)
  detail: string;
};

export const RETENTION = { rolling: 10, daily: 7, events: 20 } as const;

/**
 * `vkId` is the key the change moves to: once the cleanup has run, every stored copy is under it (or kept on purpose).
 * `mirror: true`: this store was found clean under `vkId` and only the mirror (IndexedDB) still has to be checked; that is
 * retried at unlock, not at every open (a mirror that keeps failing must not make every open scan again).
 */
export type KeyChangeMarker = { v: 1; vkId: string; at: number; mirror?: true };

/** A marker that says only the mirror is left, for the key `vkId`. Anything else that is present is a full marker. */
export function isMirrorOnlyMarker(x: unknown, vkId: string): boolean {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.v === 1 && o.mirror === true && o.vkId === vkId;
}

/**
 * Written only by a cleanup: every copy in this store was under `vkId` at that moment. A store without it (made before
 * PHASE0X-PLAN A2) gets one full check, and so does a damaged value. "newer": written by a newer version of Sixkey,
 * which owns the format; this version does not start a check on its account and never overwrites it.
 */
export type StoreVersion = { v: 2; vkId: string };
export function parseStoreVersion(x: unknown): StoreVersion | "newer" | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.v === "number" && o.v > 2) return "newer";
  return o.v === 2 && typeof o.vkId === "string" ? { v: 2, vkId: o.vkId } : null;
}

/**
 * A snapshot record in a format newer than this version knows (record or envelope version above ours, as after a
 * downgrade). It cannot be read here, and it is never counted as damaged or deleted: a newer version may need it.
 */
export function isNewerRecord(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.v === "number" && o.v > 1) return true;
  const e = o.envelope;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as Record<string, unknown>).formatVersion === "number" &&
    ((e as Record<string, unknown>).formatVersion as number) > 1
  );
}

/** Shape, checksum, and key/data agreement. Needs no key, so it also works while locked. */
export async function checkGeneration(x: unknown): Promise<Generation | null> {
  try {
    if (typeof x !== "object" || x === null) return null;
    const o = x as Record<string, unknown>;
    if (
      o.v !== 1 ||
      !Number.isSafeInteger(o.seq) ||
      (o.seq as number) < 0 ||
      typeof o.savedAt !== "number" ||
      !Number.isFinite(o.savedAt)
    )
      return null;
    const envelope = validateEnvelope(o.envelope);
    const keyring = validateKeyring(o.keyring);
    if (!(await isEnvelopeIntact(envelope))) return null;
    if (envelope.vkId !== keyring.vkId || envelope.vaultId !== keyring.vaultId) return null;
    return { v: 1, seq: o.seq as number, savedAt: o.savedAt, envelope, keyring };
  } catch {
    return null;
  }
}

export async function checkSnapshot(x: unknown): Promise<SnapshotRecord | null> {
  try {
    if (typeof x !== "object" || x === null) return null;
    const o = x as Record<string, unknown>;
    const m = o.meta as Record<string, unknown> | undefined;
    if (
      o.v !== 1 ||
      !m ||
      typeof m.id !== "string" ||
      (m.kind !== "rolling" && m.kind !== "daily") ||
      typeof m.at !== "number"
    )
      return null;
    const envelope = validateEnvelope(o.envelope);
    if (!(await isEnvelopeIntact(envelope))) return null;
    return {
      v: 1,
      meta: {
        id: m.id,
        kind: m.kind,
        at: m.at,
        seq: typeof m.seq === "number" ? m.seq : 0,
        ...(typeof m.day === "string" ? { day: m.day } : {}),
      },
      envelope,
    };
  } catch {
    return null;
  }
}

export type KeyringCopy = { v: 1; savedAt: number; keyring: Keyring };

export function checkKeyringCopy(x: unknown): KeyringCopy | null {
  try {
    if (typeof x !== "object" || x === null) return null;
    const o = x as Record<string, unknown>;
    if (o.v !== 1 || typeof o.savedAt !== "number") return null;
    return { v: 1, savedAt: o.savedAt, keyring: validateKeyring(o.keyring) };
  } catch {
    return null;
  }
}

export function parseSnapshotIndex(x: unknown): SnapshotMeta[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter(
      (m): m is SnapshotMeta =>
        !!m &&
        typeof m.id === "string" &&
        /^[A-Za-z0-9_-]{1,40}$/.test(m.id) &&
        (m.kind === "rolling" || m.kind === "daily") &&
        typeof m.at === "number",
    )
    .map((m) => ({ ...m, seq: typeof (m as { seq?: unknown }).seq === "number" ? m.seq : 0 }));
}

export function parseEvents(x: unknown): StorageEvent[] {
  if (!Array.isArray(x)) return [];
  return x.filter(
    (e): e is StorageEvent =>
      !!e &&
      typeof e.id === "string" &&
      typeof e.kind === "string" &&
      typeof e.at === "number" &&
      typeof e.restoredTo === "number",
  );
}

export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
