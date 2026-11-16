// The pins catch up with the commit (SYNC-DESIGN §0.0i item 17, §2.5; M2R-1). A key commit or a join writes its pins
// twice:
//   1. inside its transact, before the commit, as sk_sync_state.pendingPins = {vkId, vaultId, maxSeenKver, adopted,
//      deviceId, prev} (ids, hashes, KDF parameters and a count: no secret), in the SAME storage.local write that clears
//      lastSynced and the outbox (begin). It is in the same LevelDB as the keyring and written before the pointer, so
//      whenever the commit landed it is there; a lost storage.local tail (GM2-5) drops both. `deviceId` is the device
//      identity it was written for (null with none, RR-3), `prev` that identity's pinCount when the commit began (null
//      with none): its place in the order of pin writes, which maxSeenKver alone cannot give (RR-4);
//   2. after the commit, still in the lock, into the identity in IndexedDB (one write), read back, then pendingPins is
//      cleared (commit). Guarded by the caller: a crash, an IndexedDB that fails or one that drops the write (RR-7) leaves
//      pendingPins.
// settle() runs before every adoption or pre-send decision (M3, in the service worker or the settings page, never the
// popup; SyncLocal.status() does it). A pending copy is applied to IndexedDB only if it names the active keyring (its
// adopted digest is that keyring's under the pending auth) and moves the pins forward: written for this identity, the
// same vault, and either no pins yet, a higher maxSeenKver, or an identity still at `prev` (nothing pinned since that
// commit began, whatever the digests: an older copy under pins that went A -> B -> A is not mistaken for current). A copy that does not name the active keyring (its commit never landed) or would move the pins back (the
// identity is already further, the GM2-5 state, also at an equal maxSeenKver) is dropped. settle returns the identity as
// decisions must see it: while IndexedDB keeps failing, or with no readable keyring to check the copy against, the
// pending pins laid over the stored ones when they move forward. Without this, M1's "adopted back by digest" rule would
// read a stale `adopted` and silently revert this device's own key change (PROBE-1), or refuse every round (PROBE-2).
// Only the contexts that sync load this (SyncLocal); the popup never does.
import type { Keyring } from "../../crypto/keyring";
import type { KV, Lock } from "../../storage/kv";
import { adoptedRecord, type KeyBundle } from "../crypto/keybundle";
import { parsePins, type DeviceIdentity, type IdentityStore, type Pins } from "./identity";
import { SYNC_KEYS } from "./keys";
import { activeKeyring } from "./records";
import { clearingItems } from "./state";

type Identity = DeviceIdentity | "damaged" | null;

/** A pending copy: the pins, the device identity they are for, and that identity's pinCount when the commit began. */
export type PendingPins = Pins & { deviceId: string | null; prev: number | null };

/**
 * What an approval join records for its dedupe after the first round (SYNC-DESIGN §3.5, revision 24), as
 * sk_sync_state.joinAdded: the vault it joined, the ids of the accounts it added there without seeing that vault's own
 * (ids only: no content, no name), and when.
 */
export type JoinAdded = { vaultId: string; ids: string[]; at: number };

/**
 * What the pins are, given the active keyring (null: none readable): `identity` as decisions see it, `stored` the
 * identity as it is in IndexedDB, and what settling does with pendingPins: "apply" it to IndexedDB, "drop" it, "keep" it
 * (no identity to pin yet, or no keyring to check it against), or "none" (there is none).
 */
export type PinsView = {
  identity: Identity;
  stored: Identity;
  pending: PendingPins | null;
  action: "none" | "apply" | "drop" | "keep";
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const samePins = (a: Pins, b: Pins) =>
  a.vkId === b.vkId &&
  a.vaultId === b.vaultId &&
  a.maxSeenKver === b.maxSeenKver &&
  a.adopted.digest === b.adopted.digest;

/** A pending copy as stored, checked; null for anything else (an unknown deviceId or prev reads as null: it never applies). */
export function parsePending(x: unknown): PendingPins | null {
  const p = parsePins(x);
  if (!p || !isObject(x)) return null;
  return {
    ...p,
    deviceId: typeof x.deviceId === "string" ? x.deviceId : null,
    prev: Number.isSafeInteger(x.prev) ? (x.prev as number) : null,
  };
}

/** What a commit about to pin `p` writes as its pending copy, given the identity as stored when it begins. */
export function pendingFor(p: Pins, stored: DeviceIdentity | "damaged" | null, deviceId?: string): PendingPins {
  const id = stored === null || stored === "damaged" ? null : stored;
  return { ...p, deviceId: deviceId ?? id?.deviceId ?? null, prev: id ? (id.pinCount ?? 0) : null };
}

/** `pending` moves `id`'s pins forward (see the header); the overlay is what they become. */
function forward(id: DeviceIdentity, pending: PendingPins): boolean {
  if (id.deviceId !== pending.deviceId) return false; // written for another identity (one turned off since, RR-3)
  if (id.vaultId !== null && id.vaultId !== pending.vaultId) return false;
  return id.vkId === null || pending.maxSeenKver > id.maxSeenKver || (id.pinCount ?? 0) === pending.prev;
}
const overlay = (id: DeviceIdentity, p: Pins): DeviceIdentity => ({
  ...id,
  vkId: p.vkId,
  vaultId: p.vaultId,
  maxSeenKver: Math.max(id.maxSeenKver, p.maxSeenKver),
  adopted: p.adopted,
});

export class PinsLedger {
  constructor(
    private readonly kv: KV,
    private readonly identity: IdentityStore,
    private readonly vaultLock: Lock,
  ) {}

  /**
   * Inside a key commit's or a join's transact, before its commit: lastSynced and the outbox cleared (D1, §4.1) and
   * pendingPins written, in one write, always (also when lastSynced is already null). A failure fails the commit.
   * `joinAdded` (a join only): its record for the approval join's dedupe after the first round (SYNC-DESIGN §3.5,
   * revision 24), or null to clear one, in that same write; the engine clears it once the dedupe ran (engine/state.ts).
   */
  async begin(p: PendingPins, o: { joinAdded?: JoinAdded | null } = {}): Promise<void> {
    const r = await this.kv.get([SYNC_KEYS.state, SYNC_KEYS.outbox]);
    const items = clearingItems(r);
    const st = items[SYNC_KEYS.state] ?? r[SYNC_KEYS.state];
    items[SYNC_KEYS.state] = {
      ...(isObject(st) ? st : { v: 1, lastSynced: null }),
      pendingPins: p,
      ...(o.joinAdded !== undefined ? { joinAdded: o.joinAdded } : {}),
    };
    await this.kv.set(items);
  }

  /**
   * After the commit, in the same lock: the pins into IndexedDB, read back, then pendingPins cleared. False when there is
   * no identity to pin (the pending copy stays for the settle once there is one). Throws when a write fails or does not
   * read back (callers guard it; the pending copy stays).
   */
  async commit(p: Pins): Promise<boolean> {
    if (!(await this.identity.setPins(p))) return false;
    if (!(await this.landed(p))) throw new Error("the pins did not read back");
    await this.clear(p);
    return true;
  }

  /** The pins as decisions must see them, the caller holding the vault lock (`active`: the keyring it read there). Reads only. */
  async view(active: Keyring | null): Promise<PinsView> {
    const st = await this.state();
    const pending = parsePending(isObject(st) ? st.pendingPins : undefined);
    const stored = await this.identity.get();
    const id = stored === null || stored === "damaged" ? null : stored;
    const v = (identity: Identity, action: PinsView["action"]): PinsView => ({ identity, stored, pending, action });
    if (!pending) return v(stored, "none");
    // No readable keyring to check it against (the cloud restore): kept, and laid over when it moves forward. Every
    // pending copy names a bundle the server held (published after it accepted, or adopted from it), RR-9.
    if (!active) return v(id && forward(id, pending) ? overlay(id, pending) : stored, "keep");
    const named =
      active.vkId === pending.vkId &&
      active.vaultId === pending.vaultId &&
      (await adoptedRecord({ keyring: active, auth: pending.adopted.auth } as KeyBundle)).digest ===
        pending.adopted.digest;
    if (!named) return v(stored, "drop"); // its commit never landed (or a recovery went back past it)
    if (!id) return v(stored, "keep");
    if (!forward(id, pending)) return v(stored, "drop"); // further already (GM2-5), or another identity's: never move it back
    return v(overlay(id, pending), "apply");
  }

  /**
   * §0.0i item 17: settle pendingPins (view, then apply or drop it) under the vault lock, and return the identity as
   * decisions must see it. Never call it while holding the vault lock (it is not re-entrant). Reads that throw propagate;
   * a write that fails, or does not read back, does not (the pending copy is settled again next time, and the identity
   * returned overlays it).
   */
  settle(): Promise<Identity> {
    return this.vaultLock(async () => {
      const st = await this.state();
      if (!isObject(st) || st.pendingPins === undefined) return this.identity.get(); // the usual case: one read more
      let active: Keyring | null = null;
      try {
        active = await activeKeyring(this.kv);
      } catch {
        // no readable active keyring: nothing to check pendingPins against, so it stays
      }
      const v = await this.view(active);
      try {
        if (v.action === "apply" && (await this.identity.setPins(v.pending!))) {
          const back = await this.landed(v.pending!);
          if (back) {
            await this.clear(v.pending!);
            return back; // as stored now
          }
        } else if (v.action === "drop") await this.clear(v.pending!);
      } catch {
        // IndexedDB (or storage.local) refused the write: decisions read the overlay, the next settle tries again
      }
      return v.identity;
    });
  }

  /** The identity read back, if it carries `p` (RR-7: a write IndexedDB acknowledged and dropped must not clear the pending copy). */
  private async landed(p: Pins): Promise<DeviceIdentity | null> {
    const id = await this.identity.get();
    return id !== null &&
      id !== "damaged" &&
      id.vkId === p.vkId &&
      id.vaultId === p.vaultId &&
      id.adopted?.digest === p.adopted.digest &&
      id.maxSeenKver >= p.maxSeenKver
      ? id
      : null;
  }

  private async state(): Promise<unknown> {
    return (await this.kv.get([SYNC_KEYS.state]))[SYNC_KEYS.state];
  }

  /** pendingPins removed, if it is still `p`; every other member kept. */
  private async clear(p: Pins): Promise<void> {
    const st = await this.state();
    if (!isObject(st)) return;
    const cur = parsePins(st.pendingPins);
    if (st.pendingPins === undefined || (cur !== null && !samePins(cur, p))) return;
    const { pendingPins: _, ...rest } = st;
    await this.kv.set({ [SYNC_KEYS.state]: rest });
  }
}
