// The device identity (SYNC-DESIGN §2.5; M2): IndexedDB `sixkey-identity`, usable while locked (status polls, the
// outbox push and the badge sign with it). The pins it holds are this device's witness of the key state it last
// committed, kept apart from chrome.storage.local on purpose: a storage.local that is rolled back or replaced on its own
// (a power loss, a vendor that syncs only storage.local, an old copy) is exactly what they must still testify against.
//
// Write order (§2.5, §0.0f M2 req. 1-5, GM2-5, §0.0i item 17): the local keyring transact first; only once it has
// committed are vkId, vaultId, maxSeenKver and adopted written, all four in ONE IndexedDB write. The same four go into
// storage.local first, inside the transact and before its commit (pins.ts, pendingPins), so a pin write that is lost
// (a crash between the two, an IndexedDB that fails) is caught up by settlePins() before the next decision: the pins
// are never left behind a commit that landed. Two LevelDBs losing their tails apart can still leave them ahead (D8's
// second direction: needs_password, M1 afterLocal's pin_ahead). Pins are never written for "in sync".
import type { Lock } from "../../storage/kv";
import type { KV } from "../../storage/kv";
import { createMutex } from "../../storage/kv";
import type { AdoptedRecord } from "../crypto/keybundle";
import { DEVICE_ID_RE, ID_RE } from "../crypto/encoding";
import { IDENTITY_KEY } from "./keys";

export type IdentityState = "pending" | "enrolled" | "rejected_by_server";

export type DeviceIdentity = {
  v: 1;
  deviceId: string; // 16 random bytes, base64url (22 characters)
  keyPair: CryptoKeyPair; // ECDSA P-256; the private key is non-extractable
  apiOrigin: string; // the API origin it was made for: dev and prod are never mixed up
  state: IdentityState;
  vkId: string | null; // the pinned current VK (F7): written only after the local keyring has committed
  maxSeenVersion: number;
  maxSeenKver: number;
  vaultId: string | null; // this account's vault id: the "same vault" check when the local keyring is gone (F-03)
  adopted: AdoptedRecord | null; // the last bundle adopted or published here (F-06, F-07); null right after a restore
  pinCount?: number; // how many times setPins wrote the pins (absent: 0): orders a pending copy against them (pins.ts, RR-4)
}; // no email (d7)

/** What a key commit writes, all at once (one IndexedDB write). */
export type Pins = { vkId: string; vaultId: string; maxSeenKver: number; adopted: AdoptedRecord };

const HEX16 = /^[0-9a-f]{16}$/;
const isKey = (k: unknown): k is CryptoKey => typeof CryptoKey !== "undefined" && k instanceof CryptoKey;
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const isAdopted = (a: unknown): a is AdoptedRecord => {
  if (a === null || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  return (
    typeof o.digest === "string" &&
    typeof o.auth === "object" &&
    o.auth !== null &&
    typeof (o.auth as Record<string, unknown>).kdf === "object"
  );
};

/** Pins as stored (pins.ts keeps a pending copy in storage.local), checked; null for anything else. */
export function parsePins(x: unknown): Pins | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  const ok =
    typeof o.vkId === "string" &&
    HEX16.test(o.vkId) &&
    typeof o.vaultId === "string" &&
    ID_RE.test(o.vaultId) &&
    isCount(o.maxSeenKver) &&
    isAdopted(o.adopted);
  return ok
    ? {
        vkId: o.vkId as string,
        vaultId: o.vaultId as string,
        maxSeenKver: o.maxSeenKver as number,
        adopted: o.adopted as AdoptedRecord,
      }
    : null;
}

/**
 * The record as stored, checked. Damaged (or of an unknown version) is "damaged", not null: a damaged identity is not a
 * missing one (identity_missing restores from the copy; a damaged one must be looked at, not silently replaced).
 */
export function parseIdentity(x: unknown): DeviceIdentity | "damaged" | null {
  if (x === undefined) return null;
  if (typeof x !== "object" || x === null) return "damaged";
  const o = x as Record<string, unknown>;
  const kp = o.keyPair as Record<string, unknown> | undefined;
  const ok =
    o.v === 1 &&
    typeof o.deviceId === "string" &&
    DEVICE_ID_RE.test(o.deviceId) &&
    typeof o.apiOrigin === "string" &&
    (o.state === "pending" || o.state === "enrolled" || o.state === "rejected_by_server") &&
    !!kp &&
    isKey(kp.privateKey) &&
    isKey(kp.publicKey) &&
    (o.vkId === null || (typeof o.vkId === "string" && HEX16.test(o.vkId))) &&
    (o.vaultId === null || (typeof o.vaultId === "string" && ID_RE.test(o.vaultId))) &&
    isCount(o.maxSeenVersion) &&
    isCount(o.maxSeenKver) &&
    (o.adopted === null || isAdopted(o.adopted)) &&
    (o.pinCount === undefined || isCount(o.pinCount));
  return ok ? (o as unknown as DeviceIdentity) : "damaged";
}

/**
 * The identity record in its own store (production: IdbKV("sixkey-identity")), under its own lock for read-modify-write
 * (production: webLock("sixkey-identity")). A caller holding the vault lock may take this one; nothing holding this one
 * takes the vault lock. Reads that throw propagate.
 */
export class IdentityStore {
  private readonly lock: Lock;
  constructor(
    private readonly kv: KV,
    lock?: Lock,
  ) {
    this.lock = lock ?? createMutex();
  }

  async get(): Promise<DeviceIdentity | "damaged" | null> {
    return parseIdentity((await this.kv.get([IDENTITY_KEY]))[IDENTITY_KEY]);
  }

  /** Write a whole identity (a new one). */
  async put(id: DeviceIdentity): Promise<void> {
    if (parseIdentity(id) === "damaged") throw new Error("not a valid device identity");
    await this.lock(() => this.kv.set({ [IDENTITY_KEY]: id }));
  }

  /**
   * An identity restored from its copy (§2.5 identity_missing): written only if, under the lock, there is still none and
   * `still()` holds (its copy is still there). turnOff removes both under the same lock, so a restore racing "turn sync
   * off" in another context never brings the identity back (M2R-6). False, writing nothing, otherwise.
   */
  async putIfAbsent(id: DeviceIdentity, still: () => Promise<boolean>): Promise<boolean> {
    if (parseIdentity(id) === "damaged") throw new Error("not a valid device identity");
    return this.lock(async () => {
      if ((await this.get()) !== null || !(await still())) return false;
      await this.kv.set({ [IDENTITY_KEY]: id });
      return true;
    });
  }

  /**
   * The pins after a key commit, in one write: vkId, vaultId, maxSeenKver (never lowered) and adopted together (§0.0f M2
   * req. 2), and pinCount one up. False, writing nothing, when there is no identity (or a damaged one) to pin.
   */
  async setPins(p: Pins): Promise<boolean> {
    return this.lock(async () => {
      const cur = await this.get();
      if (cur === null || cur === "damaged") return false;
      const next: DeviceIdentity = {
        ...cur,
        vkId: p.vkId,
        vaultId: p.vaultId,
        maxSeenKver: Math.max(cur.maxSeenKver, p.maxSeenKver),
        adopted: p.adopted,
        pinCount: (cur.pinCount ?? 0) + 1,
      };
      await this.kv.set({ [IDENTITY_KEY]: next });
      return true;
    });
  }

  /**
   * Any other change, as a read-modify-write under the lock: state, maxSeenVersion, and D8's forward vkId after a settle.
   * Never adopted, vaultId or maxSeenKver: those go through setPins, whose pinCount orders a pending copy against them
   * (pins.ts, RR-4); changed here, an older pending copy could still look current and be applied over them.
   */
  async update(fn: (cur: DeviceIdentity) => DeviceIdentity): Promise<boolean> {
    return this.lock(async () => {
      const cur = await this.get();
      if (cur === null || cur === "damaged") return false;
      const next = fn(cur);
      if (parseIdentity(next) === "damaged") throw new Error("not a valid device identity");
      await this.kv.set({ [IDENTITY_KEY]: next });
      return true;
    });
  }

  /** Remove it; `first` (turning sync off's storage.local half) runs under the same lock, before (M2R-6). */
  async remove(first?: () => Promise<void>): Promise<void> {
    await this.lock(async () => {
      if (first) await first();
      await this.kv.remove([IDENTITY_KEY]);
    });
  }
}
