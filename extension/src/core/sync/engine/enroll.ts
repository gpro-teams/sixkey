// Turning sync on and joining, the client halves that are not UI (SYNC-DESIGN §3.1, §3.2, §3.3, §3.5; M3): the first
// device's upload, the recovery-code enrolment, and both sides of the approval enrolment, driving M1's state machines
// (NewDeviceEnrollment, ApproverEnrollment) over the signed API. The screens (O2–O9) are M6; the account session comes
// from the page's OTP step and lives only in that page's memory (§4.9).
//
// The first upload (§3.1, revisions 13 and 14, RR-12), in this order:
//   step 4 (the page): the recovery code typed (checked here against the local keyring) or a new one shown before it is
//     written (SyncFlows.prepareUploadRecovery / commitUploadRecovery), then the createdAt truncation (SyncFlows
//     .truncateForUpload: a transact with the sync_on check);
//   step 5: a new device key; the identity written "pending" and sk_sync_cfg (the key's copy under the VK) BEFORE init,
//     so from here the Phase 0 key operations are refused (item 18) and an init whose answer is lost can be resumed;
//   step 6: init's bundle built from the keyring read AFTER step 5 (a key operation in another tab before it either
//     made no difference or left the keyring unaligned, which stops here with nothing sent and the local half undone);
//   step 7: on 201, and only if the local keyring is still the one sent, the pins "in sync" (setPins: maxSeenKver 1,
//     adopted = the bundle sent), the identity enrolled, the copy's state mirrored. An unknown answer is resolved by the
//     signed status query (200: created; the engine's round then pins it from GET /v1/keys, D4).
import { bs, randomBytes, toB64 } from "../../crypto/bytes";
import { openWithPassword, unlockWithRecoveryCode } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import { ServiceError } from "../../service/service-error";
import type { CurrentVault, MergeAnswer, PreparedJoin } from "../../service/sync-flows";
import { canonicalJson } from "../../vault/merge";
import { emptyVault } from "../../vault/model";
import { passwordProof, recoveryProof } from "../crypto/auth-proofs";
import { checkDeviceName, sealDeviceName } from "../crypto/device-name";
import { generateDeviceKey, newDeviceId, type DeviceKey } from "../crypto/device-key";
import {
  adoptedRecord,
  newBundleAuth,
  parseBundleText,
  sealBundle,
  truncateKeyringTimes,
  verifyReceivedBundle,
  wrapOf,
  type KeyBundle,
} from "../crypto/keybundle";
import { preSendCheck, type VerifiedServerBundle } from "../crypto/presend";
import { writeKey } from "../crypto/subkeys";
import { ApproverEnrollment, type ApproverView } from "../crypto/enroll-approver";
import { NewDeviceEnrollment, type EnrolledKeys, type NewDeviceView } from "../crypto/enroll-new-device";
import type { DeviceIdentity } from "../local/identity";
import { uploadEnvelope } from "../local/outbox";
import type { JoinAdded } from "../local/pins";
import { ApiError, type AccountSession, type DeviceSigner, type EnrollSigner, type RegistrationSigner } from "./api";
import type { SyncEngine } from "./engine";
import { KeyOpError, versionGate } from "./keys";
import { openRemote } from "./remote";
import { joinAddedOf, unparked } from "./state";
import { NetworkError } from "./transport";
import { SYNC_CONSTANTS } from "../crypto/constants";

export class EnrollError extends Error {
  /** For "unfinished_wait": how long until the old identity's last request can no longer land (ms). */
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(`enrolment: ${code}`);
    this.name = "EnrollError";
  }
}

/** M3RR-7: a request signed now can be accepted for the signature window around the server's clock; twice that, to be sure. */
const IN_FLIGHT_MS = 2 * SYNC_CONSTANTS.SIG_WINDOW_S * 1000;

/** The signing key for an enrolment that has not made its identity yet; kept only in this page's memory. */
type NewKey = { deviceId: string; key: DeviceKey; publicKey: CryptoKey };

async function newKey(e: SyncEngine): Promise<NewKey> {
  const key = await generateDeviceKey();
  const publicKey = await crypto.subtle.importKey("spki", bs(key.spki), { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
  return { deviceId: newDeviceId(e.deps.rng ?? randomBytes), key, publicKey };
}

/** §2.5: the identity of an enrolment, "pending" and with no pins (a new device's has none, §3.2). */
function pendingIdentity(e: SyncEngine, k: NewKey): DeviceIdentity {
  return {
    v: 1,
    deviceId: k.deviceId,
    keyPair: { privateKey: k.key.privateKey, publicKey: k.publicKey },
    apiOrigin: e.deps.origin,
    state: "pending",
    vkId: null,
    maxSeenVersion: 0,
    maxSeenKver: 0,
    vaultId: null,
    adopted: null,
  };
}

/**
 * Only from "off", or over an earlier enrolment's leftover: a pending identity that was never pinned and has no copy
 * (a page closed before its join wrote anything). Anything else is a device already in sync, or one to look at first.
 */
async function requireOff(e: SyncEngine, answer?: MergeAnswer): Promise<JoinAdded | null> {
  const st = await e.deps.local.status();
  if (st.kind === "off") return null;
  if (
    st.kind === "cfg_missing" &&
    st.identity.state === "pending" &&
    st.identity.vkId === null &&
    st.identity.adopted === null
  )
    return null;
  // M3R-9 (§3.5 "加入未完成"): a join or first upload whose server half never landed. The signed status says whether this
  // identity is known: unknown, its local half (the identity and the copy) is undone, the vault kept, and the new join
  // goes ahead (the same-vault merge keeps everything); known, the device is in sync already. Not while its last init or
  // complete may still land (M3RR-7: "unfinished_wait", with the time left); a revoked pending identity can never be
  // used again and is undone at once (M3RR-8).
  if (st.kind === "on" && st.identity.state === "pending") {
    const id = st.identity;
    // §3.5 (revision 24): the dedupe record of the join being undone, for the next join to carry (prepareJoin)
    const carried = joinAddedOf((await e.state.read()).state.joinAdded);
    const known = await e.api.status({ kind: "device", deviceId: id.deviceId, key: id.keyPair.privateKey }).then(
      () => "yes" as const,
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401 && err.code === "unknown_device") return "no" as const;
        if (err instanceof ApiError && err.status === 403 && err.code === "device_revoked") return "revoked" as const;
        return err instanceof NetworkError ? ("offline" as const) : ("other" as const);
      },
    );
    if (known === "revoked") {
      const why = await e.orphanLockedOut(answer); // §4.7: never an entry deleted unfolded (R3R-6: the join's own answer)
      if (why.refuse) throw new EnrollError(why.refuse);
      await e.deps.flows.turnOffSync({ folded: why.folded });
      return carried;
    }
    if (known === "no") {
      const sentAt = (await e.state.read()).state.enrollSentAt ?? null;
      const left = sentAt === null ? 0 : sentAt + IN_FLIGHT_MS - e.refNow();
      if (left > 0) throw new EnrollError("unfinished_wait", left);
      const why = await e.orphanLockedOut(answer);
      if (why.refuse) throw new EnrollError(why.refuse);
      await e.deps.flows.turnOffSync({ folded: why.folded });
      return carried;
    }
    if (known === "offline") throw new EnrollError("offline");
    if (known === "other") throw new EnrollError("status_failed"); // a 5xx or another refusal: nothing decided, nothing undone
  }
  throw new EnrollError(st.kind === "on" ? "already_on" : st.kind);
}

const reg = (k: NewKey): RegistrationSigner => ({ kind: "registration", deviceId: k.deviceId, key: k.key.privateKey });

/**
 * The join's fold (§3.5, §4.7; M3 revision 6, R5R-1). A join replaces this profile's vault, so every orphan entry must be
 * in the local vault before the join is prepared on it: an unparked entry left unfolded because this context is locked
 * stops the join ("locked": unlock first, nothing replaced), as `orphanLockedOut` stops the flows that delete the sync
 * records. A lost vault goes ahead (the user confirmed replacing it; the entries stay in the list, and the joined
 * keyring opens those of the same vault at the first round). A guard block throws MergeBlocked, as before.
 */
async function foldForJoin(e: SyncEngine, answer?: MergeAnswer): Promise<void> {
  const f = await e.foldForFlow(answer);
  if (f.status === "locked" && unparked((await e.state.read()).orphans).length) throw new EnrollError("locked");
}

/** Undo step 5 of an enrolment that cannot go on (nothing reached the server for it): the identity and the copy. */
async function undoLocal(e: SyncEngine): Promise<void> {
  await e.deps.flows.turnOffSync(); // folds nothing: every orphan entry is kept (R4R-1), the settings page's local fold takes them
}

// ---- §3.1 the first device -------------------------------------------------------------------------------------------

export type FirstUploadInput = {
  session: AccountSession;
  /** R3R-6: the answer to a guard block on the orphan fold of the undo of an unfinished first upload (as round({answer})). */
  answer?: MergeAnswer;
  /** The master password asked for at step 1 (password_verifier with the new auth salt; it must open the local keyring). */
  password: string;
  /** The recovery code of step 4: typed (checked against the local keyring) or the one just committed (show before commit). */
  recoveryCode: string;
  deviceName: string;
  email: string;
};
export type FirstUploadResult =
  | { kind: "done" }
  | { kind: "unconfirmed" } // the answer is lost: the engine's next round asks the server (D4) and finishes the local half
  | { kind: "vault_exists" } // another device made this account's vault: join it instead (§3.1 409)
  | { kind: "keyring_changed" }; // a key operation in another tab changed the keyring before step 5: start again

/** §3.1 steps 3–7 (step 4's code chosen by the page before this, the truncation done by SyncFlows.truncateForUpload). */
export async function firstUpload(e: SyncEngine, i: FirstUploadInput): Promise<FirstUploadResult> {
  const d = e.deps;
  const name = checkDeviceName(i.deviceName);
  if (!name.ok) throw new EnrollError("invalid_device_name");
  if ((await e.api.account(i.session)).has_vault) return { kind: "vault_exists" };
  await requireOff(e, i.answer);
  await d.flows.truncateForUpload(); // step 4's truncation (nothing written when aligned already)
  const before = await d.flows.current();
  // Step 1's master password, as typed or its generator spelling, as service.verifyPassword took it at step 2
  // (openWithPassword), resolved against the local keyring, which this first upload publishes. The verifier below is
  // derived from the spelling that opened it: the stored password, never the typed one.
  const opened = await openWithPassword(before.gen.keyring, i.password).catch(() => null);
  if (opened?.vk.id !== before.vk.id) throw new EnrollError("wrong_secret");
  const password = opened.password;
  if ((await unlockWithRecoveryCode(before.gen.keyring, i.recoveryCode).catch(() => null))?.id !== before.vk.id)
    throw new EnrollError("invalid_recovery_code");

  // step 5: the identity and its copy, before init
  const k = await newKey(e);
  await d.local.identity.put(pendingIdentity(e, k));
  await d.local.cfg.write(before.vk, { deviceId: k.deviceId, apiOrigin: d.origin, dsk: k.key.jwk, email: i.email });

  // step 6: from the keyring as it is now (RR-12)
  const cur = await d.flows.current();
  const kr = cur.gen.keyring;
  if (
    cur.vk.id !== before.vk.id ||
    canonicalJson(truncateKeyringTimes(kr)) !== canonicalJson(kr) ||
    canonicalJson(kr) !== canonicalJson(before.gen.keyring)
  ) {
    await undoLocal(e);
    return { kind: "keyring_changed" };
  }
  const vaultId = kr.vaultId;
  const now = Math.floor(Math.max(0, e.refNow()) / 3_600_000) * 3_600_000;
  const auth = newBundleAuth(wrapOf(kr, "password")!.kdf!.salt, d.rng);
  const sealed = await sealBundle(cur.vk, { vaultId, kver: 1, keyring: kr, auth, by: k.deviceId, now });
  const up = await uploadEnvelope(cur.vault, cur.vk, { vaultId, rev: 1 }, d.rng);
  const body = {
    vault_id: vaultId,
    envelope: up.text,
    bundle: sealed.raw,
    recovery_verifier: (await recoveryProof(i.recoveryCode)).recoveryVerifier,
    password_verifier: (await passwordProof(password, auth.kdf)).passwordVerifier,
    write_key: await writeKey(cur.vk),
    device: {
      device_id: k.deviceId,
      sig_pubkey: toB64(k.key.spki),
      name_ct: await sealDeviceName(cur.vk, { vaultId, deviceId: k.deviceId }, name.name, d.rng),
    },
  };
  for (let tries = 0; ; tries++) {
    try {
      await e.state.update(() => ({ enrollSentAt: e.refNow() })); // M3RR-7: it may land until two signature windows from now
      await e.api.init(i.session, reg(k), body); // the same text on every try: init is idempotent on it (D4)
      break;
    } catch (err) {
      if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
        if (tries < 2) continue;
        return { kind: "unconfirmed" };
      }
      if (err instanceof ApiError && err.code === "vault_exists") {
        // Ours after all (an earlier try landed with this very identity)? The signed status says; otherwise another's. An
        // unknown answer leaves the local half for the round to settle (P-3): undone now, a vault that is ours would be
        // left with a device row no client holds.
        const mine = await e.api.status({ kind: "device", deviceId: k.deviceId, key: k.key.privateKey }).then(
          () => "yes" as const,
          (x: unknown) =>
            x instanceof ApiError && x.status === 401 && x.code === "unknown_device"
              ? ("no" as const)
              : ("unknown" as const),
        );
        if (mine === "yes") break;
        if (mine === "unknown") return { kind: "unconfirmed" };
        await undoLocal(e);
        return { kind: "vault_exists" };
      }
      await undoLocal(e);
      throw err instanceof ApiError ? new EnrollError(err.code) : err;
    }
  }
  // step 7: the pins "in sync", only if the local keyring is still the one sent (RR-12); else the round decides.
  const after = await d.flows.current();
  if (canonicalJson(after.gen.keyring) === canonicalJson(sealed.bundle.keyring)) {
    await d.local.identity.setPins({
      vkId: kr.vkId,
      vaultId,
      maxSeenKver: 1,
      adopted: await adoptedRecord(sealed.bundle),
    });
  }
  await d.local.identity.update((x) => ({ ...x, state: "enrolled", maxSeenVersion: Math.max(x.maxSeenVersion, 1) }));
  await d.local.cfg.setState("enrolled");
  await e.state.update(() => ({ serverOffsetMs: e.serverOffset })); // M3R-5: local edits from now on stamp with the corrected clock
  return { kind: "done" };
}

/**
 * §3.1 D4: after a page that ran the first upload was closed with the answer unknown: the signed status query. 200: the
 * vault exists with this device (the engine's round pins it); 401 unknown_device: it was never made, so the local half is
 * undone and the user starts again.
 */
export async function resumeFirstUpload(e: SyncEngine): Promise<"created" | "not_created" | "unknown"> {
  const st = await e.deps.local.status();
  if (st.kind !== "on" || st.identity.state !== "pending") throw new EnrollError(st.kind);
  try {
    await e.api.status({ kind: "device", deviceId: st.identity.deviceId, key: st.identity.keyPair.privateKey });
    return "created";
  } catch (err) {
    if (err instanceof ApiError && err.code === "unknown_device") {
      if (st.identity.vkId === null && st.identity.adopted === null) await undoLocal(e);
      return "not_created";
    }
    return "unknown";
  }
}

// ---- §3.3 the recovery code ----------------------------------------------------------------------------------------

export type JoinPlan = { readonly prepared: PreparedJoin };
type JoinState = {
  e: SyncEngine;
  k: NewKey;
  rid: string;
  vk: Vk;
  vaultId: string;
  version: number;
  prepared: PreparedJoin;
  nameCt: { vkId: string; iv: string; ct: string } | null;
};
const joins = new WeakMap<JoinPlan, JoinState>();

/**
 * §3.3 steps 2–4: the code proves (recovery_auth) and opens the bundle the server returns; M1 checks it (vkId, MAC,
 * vaultId); the vault is decrypted; then §3.5's local half is prepared in memory (prepareJoin), nothing written. The page
 * shows the summary (added / skipped) and calls commitJoin.
 */
export async function joinWithRecoveryCode(
  e: SyncEngine,
  i: {
    session: AccountSession;
    recoveryCode: string;
    deviceName: string;
    email: string;
    confirmLost?: boolean;
    answer?: MergeAnswer;
  },
): Promise<JoinPlan> {
  const d = e.deps;
  const name = checkDeviceName(i.deviceName);
  if (!name.ok) throw new EnrollError("invalid_device_name");
  const carried = await requireOff(e, i.answer); // R3R-6: the join's own answer also answers a block on the undo's fold
  const proof = await recoveryProof(i.recoveryCode).catch(() => {
    throw new EnrollError("invalid_recovery_code");
  });
  const k = await newKey(e);
  await d.local.identity.put(pendingIdentity(e, k)); // commitJoin writes into the joining device's own identity (RR-3)
  let r;
  for (let tries = 0; ; tries++) {
    try {
      r = await e.api.enrollRecovery(i.session, reg(k), {
        device_id: k.deviceId,
        sig_pubkey: toB64(k.key.spki),
        recovery_auth: proof.recoveryAuth,
      });
      break;
    } catch (err) {
      if ((err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) && tries < 2) continue; // the same request: idempotent (§3.3)
      throw err instanceof ApiError ? new EnrollError(err.code) : err;
    }
  }
  let bundle: KeyBundle;
  let vk: Vk;
  try {
    vk = await unlockWithRecoveryCode(parseBundleText(r.bundle).keyring, i.recoveryCode);
    bundle = await verifyReceivedBundle(r.bundle, vk, r.vault_id); // M7's function (vkId, MAC, vaultId)
  } catch {
    throw new EnrollError("bad_bundle");
  }
  const remote = await openRemote(r.envelope, vk, r.vault_id);
  if (remote.kind === "newer_schema") throw new EnrollError("paused_newer");
  if (remote.kind !== "ok") throw new EnrollError("remote_unreadable");
  await foldForJoin(e, i.answer); // §3.5, §4.7 (rev. 19, 20): the entries into the local vault first (sk_prejoin and the added import see them)
  // refNow: the clock this enrolment's answers corrected (§4.14), not the stored offset: sync is off, none is stored
  const prepared = await d.flows.prepareJoin({
    bundle,
    vk,
    remote: remote.vault,
    device: { deviceId: k.deviceId, apiOrigin: d.origin, dsk: k.key.jwk, email: i.email },
    refNow: e.refNow(),
    ...(i.confirmLost ? { confirmLost: true } : {}),
    ...(i.answer ? { answer: i.answer } : {}),
    ...(carried ? { carriedJoinAdded: carried } : {}),
  });
  const plan: JoinPlan = Object.freeze({ prepared });
  joins.set(plan, {
    e,
    k,
    rid: r.request_id,
    vk,
    vaultId: r.vault_id,
    version: r.version,
    prepared,
    nameCt: await sealDeviceName(vk, { vaultId: r.vault_id, deviceId: k.deviceId }, name.name, d.rng),
  });
  return plan;
}

/**
 * §3.5 ③–⑥ then complete (§3.2 M7, §3.3 step 4): the local half (commitJoin: the vault, sk_prejoin, sk_sync_cfg, the
 * pins), then POST …/complete (idempotent; an unknown answer is settled later by the signed status query, D4), then the
 * identity enrolled and its copy mirrored. lastSynced is null: the first round is a full pull and merge (M8).
 */
export async function commitJoin(plan: JoinPlan): Promise<"enrolled" | "unconfirmed"> {
  const s = joins.get(plan);
  if (!s) throw new EnrollError("stale");
  const d = s.e.deps;
  await d.local.settlePins(); // a stale pending copy could make commitJoin refuse (M2-NOTES §7 item 16)
  await d.flows.commitJoin(s.prepared);
  joins.delete(plan);
  await d.local.identity.update((x) => ({ ...x, maxSeenVersion: Math.max(x.maxSeenVersion, s.version) }));
  const signer: EnrollSigner = { kind: "enroll", rid: s.rid, key: s.k.key.privateKey };
  let unknown = false;
  for (let tries = 0; ; tries++) {
    try {
      await s.e.state.update(() => ({ enrollSentAt: s.e.refNow() })); // M3RR-7
      await s.e.api.complete(signer, s.rid, s.nameCt ? { name_ct: s.nameCt } : {});
      break;
    } catch (err) {
      if ((err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) && tries < 2) {
        unknown = true;
        continue;
      }
      // A17: the first complete deletes the request, so after an unknown outcome a retry is 410; the status signed as
      // devN tells (200: enrolled, D4)
      if (
        unknown &&
        err instanceof ApiError &&
        err.status === 410 &&
        (await s.e.api.status({ kind: "device", deviceId: s.k.deviceId, key: s.k.key.privateKey }).then(
          () => true,
          () => false,
        ))
      )
        break;
      if (err instanceof NetworkError || err instanceof ApiError) return "unconfirmed"; // the round's status query settles it
      throw err;
    }
  }
  await d.local.identity.update((x) => ({ ...x, state: "enrolled" }));
  await d.local.cfg.setState("enrolled");
  await s.e.state.update(() => ({ serverOffsetMs: s.e.serverOffset })); // M3R-5: local edits from now on stamp with the corrected clock
  return "enrolled";
}

/** The summary the page shows before commitJoin (§3.5 ③). */
export const joinSummary = (plan: JoinPlan) => plan.prepared;

// ---- §3.2 approval: the new device -----------------------------------------------------------------------------------

export type NewDeviceStatus =
  | { kind: "waiting" }
  | { kind: "enter_code" } // the approving device shows its pairing code: ask for it (before the reveal, MUST 10)
  | { kind: "show_sas"; sas: string } // N shows it in large digits
  | { kind: "approved" } // the payload opened under K and held together: prepare() makes the join
  | { kind: "failed"; reason: string };

export type PairingCodeStatus =
  | { kind: "malformed" } // not 28 symbols: said here, nothing sent, no attempt used, the state unchanged
  | { kind: "wrong_code" } // the check bits do not match: the same
  | { kind: "show_sas"; sas: string } // the reveal was sent (or will be resent by the next poll)
  | { kind: "failed"; reason: string };

/**
 * The request's expiry as the server gave it, if it is a time the request can really end at (from now to its whole life
 * and a minute of rounding later); otherwise that latest time. Only the countdown reads it: what the server says about
 * time is untrusted, and the request ends when the server says so, whatever was shown.
 */
function expiryOf(at: unknown, now: number): number {
  const latest = now + (SYNC_CONSTANTS.ENROLL_TTL_S + 60) * 1000;
  return typeof at === "number" && Number.isSafeInteger(at) && at >= now - 60_000 && at <= latest ? at : latest;
}

/**
 * §3.2 N0–M8, the new device's side (enrolment v2). Never re-opens a request by itself (MUST 3): every failure is
 * terminal and the user starts a new one. The pairing code is asked for once the approver answered and before the
 * reveal; only a payload that opens under the key holding it is used (MUST 5, inside M1's machine). The pairing secret
 * never leaves the machine: it is not in any body, URL, log or record (MUST 5), and this object never holds it.
 * Polls and the code step run one at a time (one after the other, in the order called), so a poll that lands while
 * the code is being checked waits for it instead of tripping the machine's one-transition-at-a-time guard.
 */
export class ApprovalJoin {
  /** The reveal sent (M3R-6): resent, identical (A15: the server answers 200), while the server still says "responded". */
  private revealBody: { epk: string; nonce: string; name_ct: string } | null = null;
  /** What the opened payload gave, until prepare() takes it. */
  private keys: EnrolledKeys | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly e: SyncEngine,
    private readonly k: NewKey,
    private readonly machine: NewDeviceEnrollment,
    private readonly rid: string,
    private readonly email: string,
    private readonly answer: MergeAnswer | undefined,
    private readonly expires: number,
    private readonly confirmLost: boolean,
    private readonly carried: JoinAdded | null,
  ) {}

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendReveal(): Promise<void> {
    try {
      await this.e.api.reveal(this.signer, this.rid, this.revealBody!);
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err; // lost on the way: the next poll that still sees "responded" resends it
    }
  }

  /** N1/M1: a new identity (pending), the enrolment request (account session + the new key's signature). */
  /** `answer` (R3R-6): the answer to a guard block on the orphan fold of M3R-9's undo or the fold before the join. */
  /** `confirmLost` (§3.5): the user confirmed that the join replaces this profile's unreadable data, as joinWithRecoveryCode's. */
  static async start(
    e: SyncEngine,
    i: { session: AccountSession; deviceName: string; email: string; answer?: MergeAnswer; confirmLost?: boolean },
  ): Promise<ApprovalJoin> {
    const carried = await requireOff(e, i.answer);
    await foldForJoin(e, i.answer); // §3.5, §4.7 (rev. 19, 20): the entries into the local vault before the join prepares on it (R5R-1)
    const k = await newKey(e);
    await e.deps.local.identity.put(pendingIdentity(e, k));
    const { machine, request } = await NewDeviceEnrollment.start({
      deviceId: k.deviceId,
      dpk: k.key.spki,
      name: i.deviceName,
    });
    let r;
    try {
      r = await e.api.enrollCreate(i.session, reg(k), request);
    } catch (err) {
      await e.deps.local.identity.remove();
      throw err instanceof ApiError ? new EnrollError(err.code) : err;
    }
    machine.requestCreated(r.request_id);
    return new ApprovalJoin(
      e,
      k,
      machine,
      r.request_id,
      i.email,
      i.answer,
      expiryOf(r.expires_at, e.refNow()),
      i.confirmLost === true,
      carried,
    );
  }

  get requestId(): string {
    return this.rid;
  }

  /**
   * When the server lets the request expire (ms on the server's clock, a whole minute): the page's countdown (§6 O5).
   * Display only; a value the server sent that is not a time within the request's life is replaced by the latest it can be.
   */
  get expiresAt(): number {
    return this.expires;
  }

  private get signer(): EnrollSigner {
    return { kind: "enroll", rid: this.rid, key: this.k.key.privateKey };
  }

  /** Where the machine is, as the page shows it. */
  private status(): NewDeviceStatus {
    switch (this.machine.phase) {
      case "entering_code":
        return { kind: "enter_code" };
      case "showing_sas":
        return { kind: "show_sas", sas: this.machine.sas! };
      case "accepted":
        return this.keys ? { kind: "approved" } : { kind: "waiting" };
      case "failed":
        return { kind: "failed", reason: this.machine.failure! };
      default:
        return { kind: "waiting" };
    }
  }

  /** M3/M6: one poll (the page polls every 2 s, §4.8, not through the engine). */
  poll(): Promise<NewDeviceStatus> {
    return this.serial(async () => {
      if (this.machine.phase === "accepted" || this.machine.phase === "failed") return this.status();
      let view: Record<string, unknown>;
      try {
        view = await this.e.api.enrollGet(this.signer, this.rid);
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) {
          this.machine.abort("gone");
          return { kind: "failed", reason: "gone" };
        }
        throw err;
      }
      const step = await this.machine.onPoll(view as NewDeviceView);
      switch (step.kind) {
        case "wait":
          // M3R-6: the SAS is shown but the server never got the reveal: the same body again (the same epk, nonce and
          // name: MUST 2 holds, the SAS is not recomputed)
          if (this.machine.phase === "showing_sas" && view.state === "responded" && this.revealBody)
            await this.sendReveal();
          return this.status();
        case "enter_code":
          return { kind: "enter_code" };
        case "accepted":
          this.keys = step.keys;
          return { kind: "approved" };
        default:
          // M6: a payload that does not open under K (a server that does not know S made it) or does not hold together
          if (step.reason === "bad_payload") await this.giveUp();
          return { kind: "failed", reason: step.reason };
      }
    });
  }

  /**
   * M3: the pairing code typed or pasted off the approving device (MUST 10). A malformed one, or one whose check bits are
   * wrong, is said here and changes nothing; a good one makes the key, the SAS and the reveal, which is sent at once.
   */
  submitPairingCode(code: string): Promise<PairingCodeStatus> {
    return this.serial(async () => {
      const r = await this.machine.submitPairingCode(code);
      switch (r.kind) {
        case "malformed":
        case "wrong_code":
          return r;
        case "failed":
          return { kind: "failed", reason: r.reason };
        default:
          this.revealBody = r.body;
          await this.sendReveal();
          return { kind: "show_sas", sas: r.sas };
      }
    });
  }

  /**
   * M7: the join prepared (prepareJoin) with the keys M1 opened and verified; the page shows the summary and calls
   * commitJoin. A fold that refuses (locked, or a guard block: MergeBlocked) prepares and writes nothing.
   */
  prepare(): Promise<JoinPlan> {
    return this.serial(async () => {
      const keys = this.keys;
      this.keys = null;
      if (!keys) throw new EnrollError("stale");
      return this.prepareWith(keys);
    });
  }

  /** bad_payload (§3.2 M6): the request rejected and the pending identity cleared; nothing of the payload is used. */
  private async giveUp(): Promise<void> {
    await this.e.api.reject(this.signer, this.rid).catch(() => undefined);
    await this.e.deps.local.identity.remove();
  }

  private async prepareWith(keys: EnrolledKeys): Promise<JoinPlan> {
    // The approval payload carries the bundle, not the vault (§3.2 M5): the local half joins an empty cloud vault of that
    // id, and the first round pulls and merges the real one (M8). The added mode cannot dedupe here (M3-NOTES.md): the
    // join records the ids it adds, and the first round that goes through moves the duplicates to the trash (§3.5,
    // revision 24; engine.ts dedupeAfterJoin).
    // (M3 revision 6, R5R-1) the fold again: the page may have been unlocked since start() (whose fold could not open
    // what it found), or an entry may have come since. Refused (locked, or a guard block: MergeBlocked) nothing is
    // prepared or written; the page cancels and starts again (start() refuses or folds the same way, `answer` included)
    await foldForJoin(this.e, this.answer);
    const d = this.e.deps;
    const prepared = await d.flows.prepareJoin({
      bundle: keys.bundle,
      vk: keys.vk,
      remote: emptyVault(keys.vaultId),
      device: { deviceId: this.k.deviceId, apiOrigin: d.origin, dsk: this.k.key.jwk, email: this.email },
      refNow: this.e.refNow(),
      dedupeAfterFirstRound: true,
      ...(this.confirmLost ? { confirmLost: true } : {}),
      ...(this.carried ? { carriedJoinAdded: this.carried } : {}),
    });
    const plan: JoinPlan = Object.freeze({ prepared });
    joins.set(plan, {
      e: this.e,
      k: this.k,
      rid: this.rid,
      vk: keys.vk,
      vaultId: keys.vaultId,
      version: 0,
      prepared,
      nameCt: null,
    });
    return plan;
  }

  /** The user cancelled, or the page is closing: terminal (MUST 6, 7), at once, also over a step still in flight. */
  async cancel(): Promise<void> {
    this.machine.abort("cancelled");
    this.keys = null;
    await this.e.api.reject(this.signer, this.rid).catch(() => undefined);
  }
}

// ---- §3.2 approval: the approving device ---------------------------------------------------------------------------

/**
 * §3.2 M2–M5, the approver's side (enrolment v2). Each step that sends pw_auth runs the pre-send check first, in this
 * context (M1-19): respond with op "respond", approve with op "approve" (P9: this device is on the server's current key,
 * not behind). The pairing code exists only in M1's machine and on this device's screen: it is readable (pairingCode)
 * from the server's acceptance of respond until the new device's reveal, and is never sent (MUST 5).
 */
export class Approver {
  private constructor(
    private readonly e: SyncEngine,
    private readonly signer: DeviceSigner,
    private readonly machine: ApproverEnrollment,
    readonly rid: string,
  ) {}

  static async list(e: SyncEngine) {
    const st = await e.deps.local.status();
    if (st.kind !== "on") throw new EnrollError("not_enrolled");
    return e.api.enrollList({ kind: "device", deviceId: st.identity.deviceId, key: st.identity.keyPair.privateKey });
  }

  private static async checked(
    e: SyncEngine,
    op: "respond" | "approve" | "reject",
    password: string,
  ): Promise<{
    signer: DeviceSigner;
    verified: VerifiedServerBundle;
    proof: string;
    id: DeviceIdentity;
    cur: CurrentVault;
  }> {
    const st = await e.deps.local.status(); // settled
    if (st.kind !== "on") throw new EnrollError("not_enrolled");
    const id = st.identity;
    const signer: DeviceSigner = { kind: "device", deviceId: id.deviceId, key: id.keyPair.privateKey };
    let cur: CurrentVault;
    try {
      cur = await e.deps.flows.current();
    } catch (err) {
      throw err instanceof ServiceError ? new EnrollError(err.code) : err;
    }
    if (op !== "reject") {
      // M3R-3: an old client approves nothing (rejecting a request stays possible, like revoking)
      await versionGate(e, signer).catch((err: unknown) => {
        throw err instanceof KeyOpError ? new EnrollError(err.code) : err;
      });
    }
    const k = await e.api.getKeys(signer);
    const r = await preSendCheck({
      op,
      serverRaw: k.bundle,
      secret: { password },
      local: cur.gen.keyring,
      vk: cur.vk,
      maxSeenKver: id.maxSeenKver,
      expectedVaultId: cur.gen.keyring.vaultId,
      adoptedAuth: id.adopted?.auth ?? null,
      adoptedDigest: id.adopted?.digest ?? null,
    });
    if (!r.ok) throw new EnrollError(r.reason);
    if (!("password_auth" in r.proof)) throw new EnrollError("wrong_secret");
    return { signer, verified: r.verified, proof: r.proof.password_auth, id, cur };
  }

  /**
   * M2: the user picked request `rid` and typed the password: pinned, respond sent (epk_A only; the pairing secret is
   * drawn by the machine and stays there). Only once the server accepted respond may the pairing code be shown.
   */
  static async start(e: SyncEngine, rid: string, password: string): Promise<Approver> {
    const c = await Approver.checked(e, "respond", password);
    const view = await e.api.enrollGet(c.signer, rid);
    const { machine, respond } = await ApproverEnrollment.start({
      approverId: c.id.deviceId,
      rid,
      request: view as ApproverView,
      verified: c.verified,
    });
    // A lost answer is asked again (up to twice, the same body): the server may have committed `responded`, and the same
    // approver sending the same epk again gets 200, so the new device is not left waiting for a code nobody shows.
    for (let tries = 0; ; tries++) {
      try {
        await e.api.respond(c.signer, rid, { epk: respond.epk, password_auth: c.proof });
        break;
      } catch (err) {
        if ((err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) && tries < 2) continue;
        machine.abort("rejected"); // the pairing secret goes with it, never shown
        throw err instanceof ApiError ? new EnrollError(err.code) : err;
      }
    }
    machine.respondAccepted();
    return new Approver(e, c.signer, machine, rid);
  }

  /**
   * The pairing code to show (28 characters, 7 groups), for the user to type on the new device: from respond's 200
   * until the new device revealed; a request that is over, or past the reveal, has none (it throws enroll_state).
   */
  get pairingCode(): string {
    return this.machine.pairingCode;
  }

  /**
   * M4: one poll; "enter_sas" with the claimed name once the new device revealed. Whatever ends the request in this poll
   * is rejected here, with the password (pw_auth, S8), as three wrong SAS are, so that the new device stops waiting at
   * once (§3.2 M4 "拒绝并告警"): a claimed name that does not open under the key holding the pairing code
   * (pairing_mismatch, MUST 10), a reveal that does not open the commitment, a changed pinned value, a reflected key, a
   * state ahead of this side. A request the server no longer has (410) is not rejected again.
   */
  async poll(password: string) {
    const over = this.machine.phase === "failed";
    let step;
    try {
      step = await this.machine.onPoll((await this.e.api.enrollGet(this.signer, this.rid)) as ApproverView);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        this.machine.abort("gone");
        return { kind: "failed" as const, reason: "gone" };
      }
      throw err;
    }
    if (step.kind === "failed" && !over) await this.reject(password).catch(() => undefined);
    return step;
  }

  /**
   * M4/M5: the SAS typed off the new device; on a match the pre-send check again (op approve), the approval built and
   * sent. Three wrong SAS: the request is rejected.
   */
  async submitSas(
    sas: string,
    password: string,
  ): Promise<
    | { kind: "malformed" }
    | { kind: "retry"; attemptsLeft: number }
    | { kind: "failed"; reason: string }
    | { kind: "approved" }
  > {
    const over = this.machine.phase === "failed";
    const r = await this.machine.submitSas(sas);
    if (r.kind === "malformed" || r.kind === "retry") return r;
    if (r.kind === "failed") {
      if (!over) await this.reject(password).catch(() => undefined); // three wrong SAS, or anything else that ended it here
      return r;
    }
    const c = await Approver.checked(this.e, "approve", password);
    const b = await this.machine.buildApproval({ verified: c.verified, now: this.e.deps.now() });
    if (b.kind === "failed") {
      if (b.reason === "keys_changed") await this.reject(password).catch(() => undefined); // M1-18: void it, follow R3 first
      return b;
    }
    try {
      await this.e.api.approve(this.signer, this.rid, { ...b.body, password_auth: c.proof });
    } catch (err) {
      if (err instanceof NetworkError) {
        // MUST 8: no polling while approve is in flight; after a lost answer one poll tells whether it was committed
        const step = await this.poll(password);
        if (step.kind === "approved") return this.recorded(step);
      }
      this.machine.approveRefused();
      return { kind: "failed", reason: err instanceof ApiError ? err.code : "network" };
    }
    const a = await this.machine.approveAccepted();
    return a.kind === "approved" ? this.recorded(a) : { kind: "failed", reason: a.reason };
  }

  /** The approval the server accepted, in the security record (device_approved). */
  private async recorded<T>(approved: T): Promise<T> {
    await this.e.deps.flows.recordAction("device_approved");
    return approved;
  }

  /**
   * The page dropped this approval (a lock, the flow ending): the machine ends here and wipes the pairing secret, without
   * a request (MUST 6; the request expires on the server, or the page's own reject goes out with the password).
   */
  discard(): void {
    this.machine.abort("cancelled");
  }

  /**
   * The approver rejects the request (pw_auth, S8). The machine ends first, whatever the check below does (a lock, a
   * wrong password, the network): S and the ephemeral key go at once (MUST 6, MUST 10).
   */
  async reject(password: string): Promise<void> {
    this.machine.abort("rejected");
    const c = await Approver.checked(this.e, "reject", password);
    await this.e.api.reject(this.signer, this.rid, c.proof);
  }

  /** A request rejected from the list, without starting on it (pw_auth, S8; never gated, like revoking). */
  static async rejectRequest(e: SyncEngine, rid: string, password: string): Promise<void> {
    const c = await Approver.checked(e, "reject", password);
    try {
      await e.api.reject(c.signer, rid, c.proof);
    } catch (err) {
      throw err instanceof ApiError ? new EnrollError(err.code) : err;
    }
  }
}
