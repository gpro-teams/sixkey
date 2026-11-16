// Sync's local side in one object (SYNC-DESIGN §2.5, §4.1; M2): what the store and the service are given, and what the
// engine (M3) and the platform wiring (M5) build on. No network, no key operation of its own beyond the two records.
//
// §2.5's four combinations, all first-class (status()):
//   identity | storage.local (sk_sync_cfg) | state
//   yes      | yes                         | "on"
//   no       | yes                         | "identity_missing": unlocked, restoreIdentity() rebuilds it from the copy
//                                             (pins: vkId and vaultId from the local keyring, adopted null, maxSeenKver 0;
//                                             the state the copy mirrors, M2R-7)
//   yes      | no                          | "cfg_missing": the identity can still sign; with the local vault lost too this is
//                                             the cloud-restore path (§4.13, the identity's pins guard it)
//   no       | no                          | "off": a new install as far as sync goes
// A damaged identity or configuration is reported as such, never as missing (a missing one is restored or replaced).
// The identity status() reports is the settled one (pins.ts): every decision M3 makes reads it, or settlePins()'s.
import type { Random } from "../../crypto/bytes";
import type { Keyring } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import { checkGeneration, KEYS } from "../../storage/format";
import type { KV, Lock } from "../../storage/kv";
import type { VkRecord } from "../../service/service";
import { newDeviceId as newHlcDeviceId } from "../../vault/hlc";
import type { SyncLocalPort } from "../../service/sync-flows";
import { importDeviceKey } from "../crypto/device-key";
import { IdentityStore, type DeviceIdentity } from "./identity";
import { SYNC_KEYS, SYNC_OFF_KEYS } from "./keys";
import { PinsLedger } from "./pins";
import { PrejoinWriter, SyncCfgCopy } from "./record-writers";
import { keptAtTurnOff } from "./kept-at-turn-off";
import type { CfgPlain } from "./records";
import { SyncStateStore, type SyncContext } from "./state";

export type LocalSyncStatus =
  | { kind: "off" }
  | { kind: "on"; identity: DeviceIdentity }
  | { kind: "identity_missing" }
  | { kind: "cfg_missing"; identity: DeviceIdentity }
  | { kind: "damaged"; what: "identity" | "cfg" };

export type SyncLocalOptions = {
  /** chrome.storage.local (the sync keys live beside the vault's). */
  local: KV;
  /** IndexedDB sixkey-identity. */
  identity: KV;
  /** The vault lock (webLock("sixkey-vault")): the records' critical sections (A4R-4). */
  vaultLock: Lock;
  /** The identity's own lock (webLock("sixkey-identity")). */
  identityLock?: Lock;
  rng?: Random;
};

/** The whole local side; SyncFlows' port (core/service/sync-flows.ts). Built by the contexts that sync (M5), not the popup. */
export class SyncLocal implements SyncLocalPort {
  readonly state: SyncStateStore;
  readonly identity: IdentityStore;
  readonly cfg: SyncCfgCopy;
  readonly prejoin: PrejoinWriter;
  readonly pins: PinsLedger;
  private readonly local: KV;
  private readonly vaultLock: Lock;

  constructor(o: SyncLocalOptions) {
    this.local = o.local;
    this.vaultLock = o.vaultLock;
    this.state = new SyncStateStore(o.local);
    this.identity = new IdentityStore(o.identity, o.identityLock);
    this.cfg = new SyncCfgCopy(o.local, o.vaultLock, o.rng);
    this.prejoin = new PrejoinWriter(o.local, o.vaultLock, o.rng);
    this.pins = new PinsLedger(o.local, this.identity, o.vaultLock);
  }

  /** The VkRecords for the service's one cleanup entry point (§0.0i req. 5). An open list (R5: the YubiKey records join it). */
  get records(): VkRecord[] {
    return [this.cfg, this.prejoin];
  }

  /** For local edits: null when sync is off (one read). */
  context(): Promise<SyncContext | null> {
    return this.state.context();
  }

  /** The store's beforeRecoveryWrite, and every flow that must end in a full pull (D1). */
  clearLastSynced(): Promise<void> {
    return this.state.clearLastSynced();
  }

  /**
   * §0.0i item 17: the identity as every adoption or pre-send decision must see it, its pins caught up with the last commit
   * that landed (pins.ts). M3 calls it (or status()) before each such decision and at every unlock, never while holding
   * the vault lock, and feeds M1 its vkId, vaultId, maxSeenKver and adopted.
   */
  settlePins(): Promise<DeviceIdentity | "damaged" | null> {
    return this.pins.settle();
  }

  /**
   * Which of §2.5's four combinations this profile is in, with the identity settled (settlePins). Reads that throw
   * propagate (an IndexedDB that fails is not "missing").
   */
  async status(): Promise<LocalSyncStatus> {
    const [id, cfg] = await Promise.all([this.settlePins(), this.cfg.read()]);
    if (id === "damaged") return { kind: "damaged", what: "identity" };
    if (cfg === "damaged") return { kind: "damaged", what: "cfg" };
    if (id && cfg) return { kind: "on", identity: id };
    if (cfg) return { kind: "identity_missing" };
    if (id) return { kind: "cfg_missing", identity: id };
    return { kind: "off" };
  }

  /**
   * §2.5 identity_missing, once unlocked: the identity rebuilt from sk_sync_cfg's copy, opened with the current key or
   * one of `held` (a key change not yet cleaned up). The signing key goes back non-extractable. Its state is the one the
   * copy mirrors ("pending" when it says none: M3 confirms with a signed status query before treating it as enrolled,
   * M2R-7). Pins: vkId and vaultId from the local keyring, maxSeenVersion as given (the server's current version, or 0),
   * adopted null and maxSeenKver 0 (N27: a device that is only behind is not misread as "the server is older than me");
   * a pending pin copy of the last commit is laid over them at the next settle. Refused unless the identity really is
   * missing, then again under the identity's lock just before the write, with the copy still there (a "turn sync off" in
   * another context meanwhile wins, M2R-6). The caller records identity_restored.
   */
  async restoreIdentity(
    vk: Vk,
    keyring: Keyring,
    o: { held?: readonly Vk[]; maxSeenVersion?: number } = {},
  ): Promise<DeviceIdentity> {
    const st = await this.status();
    if (st.kind !== "identity_missing") throw new Error(`no identity to restore (${st.kind})`);
    const { cfg, plain } = await this.cfg.open(keyring.vaultId, vk, o.held ?? []);
    const privateKey = await importDeviceKey(plain.dsk);
    const { kty, crv, x, y } = plain.dsk;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty, crv, x, y },
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const id: DeviceIdentity = {
      v: 1,
      deviceId: cfg.deviceId,
      keyPair: { privateKey, publicKey },
      apiOrigin: cfg.apiOrigin,
      state: cfg.state ?? "pending",
      vkId: keyring.vkId,
      vaultId: keyring.vaultId,
      maxSeenVersion: o.maxSeenVersion ?? 0,
      maxSeenKver: 0,
      adopted: null,
    };
    const still = async () => {
      const now = await this.cfg.read();
      return now !== null && now !== "damaged" && now.deviceId === cfg.deviceId;
    };
    if (!(await this.identity.putIfAbsent(id, still))) throw new Error("no identity to restore (changed meanwhile)");
    return id;
  }

  /**
   * §4.10 "make this profile a separate device", the local half once the server made the new device (POST
   * /v1/devices/fork, which the original identity signed): under the vault lock, sk_sync_cfg written for the new device
   * (its signing key's copy under `vk`, the same email), lastSynced and the outbox cleared (the next round is a full pull
   * and merge), and sk_device, the device suffix of this profile's own edits, made anew (so that the two copies' edits
   * no longer look like one device's); then the IndexedDB identity replaced by the new device's, `next`, and the copy's
   * state set to it. A crash between the two writes leaves the copy of the new device beside the old identity: the old
   * one still signs (its server row is still there), and an identity restored from the copy is the new one; either way
   * a valid device of this account. Never call it while holding the vault lock.
   */
  async switchIdentity(vk: Vk, vaultId: string, cfg: CfgPlain, next: DeviceIdentity): Promise<void> {
    await this.vaultLock(async () => {
      await this.cfg.writeInLock(vk, vaultId, cfg);
      await this.state.clearLastSynced();
      await this.local.set({ sk_device: newHlcDeviceId() }); // Phase 0's SettingsStore.deviceId reads it (the HLC suffix)
    });
    await this.identity.put(next);
    await this.cfg.setState(next.state);
  }

  /**
   * "Turn sync off" / "remove the sync identity", the local half (D11; the caller has revoked this device first where
   * that applies). sk_sync_cfg, sk_sync_state, the outbox and staged go first, in one remove, then the identity, both
   * under the vault lock and the identity's (vault, then identity: the one order), so neither a restore (M2R-6) nor a key
   * commit or a join in flight in another context (RR-3) can land in between or after it with stale pins or a copy. In
   * that order a crash between the two leaves an identity without its copy ("cfg_missing", which a second call
   * finishes), never a copy that the next unlock would turn back into the identity just removed. sk_prejoin, sk_prf and
   * sk_oath stay (R5). Never call it while holding the vault lock. The caller records sync_off.
   *
   * The orphan list (§4.7) keeps every entry the calling flow did not report in `folded` (those are in the vault now),
   * and the live outbox is moved into it, not deleted, unless the active generation on disk provably holds it (M3
   * revision 6, R5R-2): the active slot passes its integrity check and its envelope checksum is the outbox's, the rule
   * of retirement 3. So a slot torn after the flow loaded the vault (during a revoke) cannot take the only copy of a save
   * with it. sk_sync_orphan is deleted only when nothing is left in it.
   */
  async turnOff(o: { folded?: readonly { checksum: string; envelope: string }[] } = {}): Promise<void> {
    await this.vaultLock(() =>
      this.identity.remove(async () => {
        // §4.7 (revisions 20, R3R-2; M3 revision 5, R4R-1): the orphan list keeps every entry the calling flow did not
        // report folded (`folded`: those are in the vault now). Not by the parked mark: a flow that folds nothing (the
        // first upload's undo) or an entry appended meanwhile (a recovery during the revoke) must not lose a save. With
        // sync off the settings page's local fold folds what is kept. The live outbox is kept the same way unless the
        // active slot holds it (M3 revision 6, R5R-2): written into the list here, before the remove. The key goes only
        // when no entry is left.
        const keep = await keptAtTurnOff(this.local, o.folded ?? [], (checksum) => this.activeHolds(checksum));
        if (keep.length) await this.local.set({ [SYNC_KEYS.orphan]: { v: 1, items: keep } });
        await this.local.remove(SYNC_OFF_KEYS.filter((k) => !(keep.length && k === SYNC_KEYS.orphan)));
      }),
    );
  }

  /** The active generation on disk is intact (shape, checksum, key/data agreement: no key needed) and is `checksum`'s. */
  private async activeHolds(checksum: string): Promise<boolean> {
    const ptr = (await this.local.get([KEYS.active]))[KEYS.active];
    if (ptr !== "a" && ptr !== "b") return false;
    const gen = await checkGeneration((await this.local.get([KEYS.slot[ptr]]))[KEYS.slot[ptr]]);
    return gen !== null && gen.envelope.checksum === checksum;
  }
}
