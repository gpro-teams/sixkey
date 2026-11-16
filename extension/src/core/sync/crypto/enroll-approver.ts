// The approving device's side of enrollment (§3.2 M2–M5; enrolment v2, revision 27) as an explicit state machine
// without I/O. It only starts from the VerifiedServerBundle that the §3.14 pre-send check returns for `respond`, and
// builds the approve body only from the one returned again for `approve` (F-09), so "the server's latest verified
// bundle, not keys_behind" is enforced here.
//
//   start (pins the request, draws the pairing secret S) --respondAccepted--> awaiting_reveal (S may be shown)
//   --poll: revealed, and the claimed name opens under K = HKDF(Z || S, h)--> verifying --SAS ok--> sas_ok
//   --buildApproval--> approving --approveAccepted, or a poll showing approved--> approved
//   any state --abort / inconsistency / a name that does not open / 3 wrong SAS / VK changed--> failed
//
// The §3.2 MUST rules are structure, not convention:
//   1  (rid, devN, dpk_N, C) are pinned before respond; any later difference or missing field aborts;
//   4  all three SAS attempts compare against the one SAS_A, and the ephemeral key never changes;
//   5  S is drawn here, never put in the respond body (or anything derived from it), and can be read (pairingCode) only
//      between the server accepting respond and the reveal; it is wiped once K is derived and at every end;
//   6  the ephemeral private key is dropped once K is derived, and K once the approve body is built;
//   7  a failure wins over a step in flight (epoch guard, as in enroll-new-device.ts);
//   8  in `approving`, a poll showing `approved` with every pinned value unchanged is the approve 200; before that it aborts;
//   10 a reveal whose name does not open under K ends the request (pairing_mismatch): the new device typed another code
//      (a typo past the check bits) or the reveal was tampered with; the caller rejects the request. There is no oracle:
//      nothing derived from S is ever sent, and a failure shows the server only that the request was rejected.
import { randomBytes, sha256, toB64, type Random } from "../../crypto/bytes";
import { formatPairingCode, generatePairingCode } from "../../crypto/pairing-code";
import { SYNC_CONSTANTS as C } from "./constants";
import { generateEphemeral, importDpk, importEpk, type Ephemeral } from "./device-key";
import { sealDeviceName, type NameCt } from "./device-name";
import {
  CODE_SPACE,
  PAIRING_SECRET_BYTES,
  commitment,
  enrollKey,
  normalizeCode,
  openRevealName,
  payloadText,
  sasOf,
  sealPayload,
  sharedSecret,
  transcriptHash,
} from "./enroll-crypto";
import type { EnrollOptions } from "./enroll-new-device";
import { DEVICE_ID_RE, UUID_RE, b64, bytesEqual } from "./encoding";
import { SyncCryptoError } from "./errors";
import { isVerifiedServerBundle, type VerifiedServerBundle } from "./presend";

export type ApproverPhase =
  "responding" | "awaiting_reveal" | "verifying" | "sas_ok" | "approving" | "approved" | "failed";
export type ApproverFailure =
  | "tampered" // a pinned value changed or is missing (MUST 1, F-10)
  | "commit_mismatch" // the reveal does not open the pinned commitment: "possibly tampered"
  | "unexpected_state"
  | "invalid_view"
  | "reflected_key"
  | "pairing_mismatch" // the claimed name does not decrypt under K (Z || S): another code typed there, or tampering (MUST 10)
  | "bad_name" // the claimed name decrypts but breaks §2.4
  | "sas_mismatch" // three wrong SAS: the request is void (POST …/reject)
  | "keys_changed" // the VK changed between the respond and approve checks: follow R3 first (§3.2 F-09)
  | "approve_refused" // the server did not accept approve
  | "rejected"
  | "expired"
  | "gone"
  | "cancelled";

/** GET /v1/enroll/requests/{rid} as the approving device sees it. */
export type ApproverView = {
  state: string;
  new_device_id?: unknown;
  new_sig_pubkey?: unknown;
  commit?: unknown;
  new_epk?: unknown;
  new_nonce?: unknown;
  new_name_ct?: unknown;
};

export type RespondBody = { epk: string }; // plus password_auth from the pre-send check; never S
export type ApproveBody = { transcript_hash: string; payload: string; name_ct: NameCt; sig_pubkey_sha256: string }; // plus password_auth

type Failed = { kind: "failed"; reason: ApproverFailure };
export type Approved = { kind: "approved" };
export type ApproverStep =
  | { kind: "wait" }
  | { kind: "enter_sas"; claimedName: string } // shown as "claims to be: …"
  | Approved // MUST 8: the poll saw approve committed
  | Failed;

export type SasResult = { kind: "malformed" } | { kind: "retry"; attemptsLeft: number } | Failed | { kind: "matched" }; // next: the pre-send check for approve, then buildApproval

export type ApproveResult = { kind: "approve"; body: ApproveBody } | Failed;

type Pinned = { rid: string; devN: string; dpkN: Uint8Array; commit: Uint8Array };
type Reveal = { epkN: Uint8Array; nN: Uint8Array; nameCt: string };

export class ApproverEnrollment {
  #phase: ApproverPhase = "responding";
  #failure: ApproverFailure | null = null;
  #epoch = 0;
  #busy = false;
  readonly #devA: string;
  readonly #pin: Pinned;
  readonly #epkA: Uint8Array;
  readonly #rng: Random;
  readonly #space: number;
  readonly #respondVkId: string;
  #esk: CryptoKey | null;
  /** S and its 28-character text: in this object's memory only, until the reveal or the end (MUST 5, 10). */
  #s: Uint8Array | null;
  #code: string | null;
  #reveal: Reveal | null = null;
  #h: Uint8Array | null = null;
  #k: CryptoKey | null = null;
  #sas: string | null = null;
  #claimedName: string | null = null;
  #attemptsLeft = 0;
  #approve: ApproveBody | null = null;

  private constructor(
    devA: string,
    pin: Pinned,
    eph: Ephemeral,
    pairing: { secret: Uint8Array; text: string },
    rng: Random,
    space: number,
    respondVkId: string,
  ) {
    this.#devA = devA;
    this.#pin = pin;
    this.#esk = eph.privateKey;
    this.#epkA = eph.raw;
    this.#s = pairing.secret;
    this.#code = pairing.text;
    this.#rng = rng;
    this.#space = space;
    this.#respondVkId = respondVkId;
  }

  /**
   * M2: the user picked a pending request, and the pre-send check passed for `respond` (not keys_behind). The request's
   * (rid, devN, dpk_N, C) are pinned now; a missing or malformed one refuses. The pairing secret S is drawn here, from
   * the platform's random source (the `pairingSecret` seam only in tests); the respond body carries only epk_A.
   */
  static async start(
    input: { approverId: string; rid: string; request: ApproverView; verified: VerifiedServerBundle },
    opts: EnrollOptions = {},
  ): Promise<{ machine: ApproverEnrollment; respond: RespondBody }> {
    const v = input.verified;
    if (!isVerifiedServerBundle(v) || v.op !== "respond" || v.keysBehind)
      throw new SyncCryptoError("invalid_argument", "respond needs the pre-send check for respond");
    const r = input.request;
    let pin: Pinned;
    try {
      if (!DEVICE_ID_RE.test(input.approverId) || !UUID_RE.test(input.rid) || r.state !== "pending")
        throw new Error("request");
      if (
        typeof r.new_device_id !== "string" ||
        !DEVICE_ID_RE.test(r.new_device_id) ||
        r.new_device_id === input.approverId
      )
        throw new Error("device");
      const dpkN = b64(r.new_sig_pubkey);
      await importDpk(dpkN);
      pin = { rid: input.rid, devN: r.new_device_id, dpkN, commit: b64(r.commit, 32) };
    } catch {
      throw new SyncCryptoError("invalid_argument", "incomplete or malformed enrollment request");
    }
    const eph = opts.ephemeral ?? (await generateEphemeral());
    // the machine owns S from here and wipes it (a test's seam array included, so a test can see that it does)
    let pairing: { secret: Uint8Array; text: string };
    if (opts.pairingSecret) {
      if (opts.pairingSecret.length !== PAIRING_SECRET_BYTES)
        throw new SyncCryptoError("invalid_argument", "pairing secret");
      pairing = { secret: opts.pairingSecret, text: await formatPairingCode(opts.pairingSecret) };
    } else pairing = await generatePairingCode(randomBytes);
    const machine = new ApproverEnrollment(
      input.approverId,
      pin,
      eph,
      pairing,
      opts.rng ?? randomBytes,
      opts.codeSpace ?? CODE_SPACE,
      v.vk.id,
    );
    return { machine, respond: { epk: toB64(eph.raw) } };
  }

  get phase(): ApproverPhase {
    return this.#phase;
  }
  get failure(): ApproverFailure | null {
    return this.#failure;
  }
  /**
   * The pairing code to show in large type (7 groups of 4) for the user to type on the new device: only once the server
   * accepted respond, and only until the new device revealed (MUST 5). Anywhere else it does not exist.
   */
  get pairingCode(): string {
    if (this.#phase !== "awaiting_reveal" || this.#code === null)
      throw new SyncCryptoError("enroll_state", "no pairing code outside awaiting_reveal");
    return this.#code;
  }
  /** The approve body again, byte for byte, for a resend. */
  get approveBody(): ApproveBody | null {
    return this.#phase === "approving" ? this.#approve : null;
  }

  /** The server answered respond with 200 (CAS pending → responded): from now on the pairing code may be shown. */
  respondAccepted(): { kind: "show_code"; code: string } | Failed {
    if (this.#phase === "failed") return this.#failed();
    this.#guard("responding");
    this.#phase = "awaiting_reveal";
    return { kind: "show_code", code: this.#code! };
  }

  /** M4 (and MUST 8 in approving): one poll result. */
  async onPoll(view: ApproverView): Promise<ApproverStep> {
    if (this.#phase === "failed") return this.#failed();
    if (this.#phase === "approved") return { kind: "wait" };
    if (this.#phase === "responding") throw new SyncCryptoError("enroll_state", "respond not accepted yet");
    return this.#run(async (epoch) => {
      if (!this.#samePinned(view)) return this.#fail("tampered");
      switch (this.#phase) {
        case "awaiting_reveal":
          if (view.state === "pending" || view.state === "responded") return { kind: "wait" };
          if (view.state !== "revealed") return this.#fail("unexpected_state");
          return this.#onReveal(view, epoch);
        case "approving":
          if (!this.#sameReveal(view)) return this.#fail("tampered");
          if (view.state === "approved") return this.#accept(epoch); // MUST 8: approve was committed
          return view.state === "revealed" ? { kind: "wait" } : this.#fail("unexpected_state");
        default: // verifying, sas_ok: approve has not been sent
          if (!this.#sameReveal(view)) return this.#fail("tampered");
          return view.state === "revealed" ? { kind: "wait" } : this.#fail("unexpected_state");
      }
    });
  }

  /** M4: the digits the user read off the new device. */
  async submitSas(input: string): Promise<SasResult> {
    if (this.#phase === "failed") return this.#failed();
    this.#guard("verifying");
    const code = normalizeCode(input, this.#space);
    if (code === null) return { kind: "malformed" };
    if (code !== this.#sas) {
      this.#attemptsLeft--;
      return this.#attemptsLeft > 0 ? { kind: "retry", attemptsLeft: this.#attemptsLeft } : this.#fail("sas_mismatch");
    }
    this.#phase = "sas_ok";
    return { kind: "matched" };
  }

  /**
   * M5: P carries the text of the bundle the pre-send check just verified again for `approve` (N7, F-09), encrypted
   * under K; the device name is re-encrypted under K_name for the device row. `now` is exact ms and only the new device
   * sees it. Random draws: payload iv, then name iv. A VK change since respond ends the request (keys_changed).
   */
  async buildApproval(material: { verified: VerifiedServerBundle; now: number }): Promise<ApproveResult> {
    if (this.#phase === "failed") return this.#failed();
    this.#guard("sas_ok");
    const v = material.verified;
    if (!isVerifiedServerBundle(v) || v.op !== "approve" || v.keysBehind)
      throw new SyncCryptoError("invalid_argument", "approve needs the pre-send check for approve");
    if (v.vk.id !== this.#respondVkId) return this.#fail("keys_changed");
    return this.#run(async (epoch) => {
      const h = this.#h!;
      const k = this.#k;
      if (!k) return this.#failed();
      const text = payloadText({
        vaultId: v.bundle.vaultId,
        vk: v.vk,
        bundleRaw: v.raw,
        approver: this.#devA,
        at: material.now,
      });
      const payload = await sealPayload(k, h, text, this.#rng);
      const nameCt = await sealDeviceName(
        v.vk,
        { vaultId: v.bundle.vaultId, deviceId: this.#pin.devN },
        this.#claimedName!,
        this.#rng,
      );
      const body: ApproveBody = {
        transcript_hash: toB64(h),
        payload,
        name_ct: nameCt,
        sig_pubkey_sha256: toB64(await sha256(this.#pin.dpkN)),
      };
      if (this.#epoch !== epoch) return this.#failed(); // MUST 7: a cancel during the awaits wins, no body
      this.#approve = body;
      this.#k = null;
      this.#phase = "approving";
      return { kind: "approve", body };
    });
  }

  /** The server answered approve with 200. Idempotent after MUST 8's poll. */
  async approveAccepted(): Promise<Approved | Failed> {
    if (this.#phase === "failed") return this.#failed();
    if (this.#phase === "approved") return { kind: "approved" };
    this.#guard("approving");
    return this.#run((epoch) => this.#accept(epoch));
  }

  /** The server refused approve (409, 410): terminal. */
  approveRefused(): void {
    if (this.#phase === "failed") return;
    this.#guard("approving");
    this.#fail("approve_refused");
  }

  abort(reason: "rejected" | "expired" | "gone" | "cancelled"): void {
    if (this.#phase !== "approved" && this.#phase !== "failed") this.#fail(reason);
  }

  async #accept(epoch: number): Promise<Approved | Failed> {
    if (this.#epoch !== epoch) return this.#failed();
    this.#phase = "approved";
    this.#approve = null;
    return { kind: "approved" };
  }

  async #onReveal(view: ApproverView, epoch: number): Promise<ApproverStep> {
    if (view.new_epk === undefined || view.new_nonce === undefined || view.new_name_ct === undefined)
      return this.#fail("tampered"); // F-10
    let reveal: Reveal;
    let epkKey: CryptoKey;
    try {
      reveal = { epkN: b64(view.new_epk, 65), nN: b64(view.new_nonce, 32), nameCt: view.new_name_ct as string };
      if (typeof reveal.nameCt !== "string") throw new Error("name");
      epkKey = await importEpk(reveal.epkN);
    } catch {
      return this.#fail("invalid_view");
    }
    if (bytesEqual(reveal.epkN, this.#epkA)) return this.#fail("reflected_key");
    const p = this.#pin;
    if (!bytesEqual(await commitment(p.devN, p.dpkN, reveal.epkN, reveal.nN), p.commit))
      return this.#fail("commit_mismatch");
    const esk = this.#esk;
    const s = this.#s;
    if (!esk || !s || this.#epoch !== epoch) return this.#failed();
    const h = await transcriptHash({
      rid: p.rid,
      devN: p.devN,
      devA: this.#devA,
      dpkN: p.dpkN,
      epkN: reveal.epkN,
      epkA: this.#epkA,
      nN: reveal.nN,
    });
    // S goes into K and is wiped: from here on nothing on this device can show or derive it again
    this.#s = null;
    this.#code = null;
    let k: CryptoKey;
    try {
      k = await enrollKey(await sharedSecret(esk, epkKey), s, h);
    } finally {
      s.fill(0); // enrollKey wipes it as well; this also covers an ECDH that threw
    }
    let name: string;
    try {
      name = await openRevealName(k, h, reveal.nameCt);
    } catch (e) {
      // MUST 10: a name that does not decrypt under K means the new device used another S (or the reveal was changed)
      return this.#fail(e instanceof SyncCryptoError && e.code === "decrypt_failed" ? "pairing_mismatch" : "bad_name");
    }
    const sas = await sasOf(h, this.#space); // computed once (MUST 4)
    if (this.#epoch !== epoch) return this.#failed();
    this.#esk = null;
    this.#reveal = reveal;
    this.#h = h;
    this.#k = k;
    this.#sas = sas;
    this.#claimedName = name;
    this.#attemptsLeft = C.SAS_ATTEMPTS;
    this.#phase = "verifying";
    return { kind: "enter_sas", claimedName: name };
  }

  #samePinned(view: ApproverView): boolean {
    try {
      return (
        view.new_device_id === this.#pin.devN &&
        bytesEqual(b64(view.new_sig_pubkey), this.#pin.dpkN) &&
        bytesEqual(b64(view.commit, 32), this.#pin.commit)
      );
    } catch {
      return false;
    }
  }

  /** The pinned reveal, present and unchanged; the state is checked by the caller. */
  #sameReveal(view: ApproverView): boolean {
    const r = this.#reveal!;
    try {
      return (
        bytesEqual(b64(view.new_epk, 65), r.epkN) &&
        bytesEqual(b64(view.new_nonce, 32), r.nN) &&
        view.new_name_ct === r.nameCt
      );
    } catch {
      return false;
    }
  }

  #guard(phase: ApproverPhase): void {
    if (this.#busy || this.#phase !== phase) throw new SyncCryptoError("enroll_state", "not allowed in this state");
  }

  async #run<T>(fn: (epoch: number) => Promise<T>): Promise<T | Failed> {
    if (this.#busy) throw new SyncCryptoError("enroll_state", "a transition is in progress");
    this.#busy = true;
    const epoch = this.#epoch;
    try {
      return await fn(epoch);
    } catch (e) {
      if (this.#epoch !== epoch) return this.#failed(); // aborted while in flight: the abort is the result
      this.#fail("invalid_view");
      throw e;
    } finally {
      this.#busy = false;
    }
  }

  #failed(): Failed {
    return { kind: "failed", reason: this.#failure! };
  }

  /** The first failure wins and is final. Everything secret goes with it, S included (MUST 6, MUST 10 lifetime). */
  #fail(reason: ApproverFailure): Failed {
    if (this.#phase === "failed") return this.#failed();
    this.#phase = "failed";
    this.#failure = reason;
    this.#epoch++;
    this.#esk = null;
    this.#s?.fill(0);
    this.#s = null;
    this.#code = null;
    this.#k = null;
    this.#approve = null;
    return this.#failed();
  }
}
