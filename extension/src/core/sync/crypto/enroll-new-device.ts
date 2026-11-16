// The new device's side of approval enrollment (§3.2 N1–M7; enrolment v2, revision 27) as an explicit state machine.
// It does no I/O: the caller sends the bodies it returns, feeds it each poll result and what the user types, and acts on
// the steps it reports.
//
//   requesting --requestCreated--> waiting --poll: responded (pins devA, epk_A)--> entering_code
//   --submitPairingCode: 28 symbols with the right check bits; T, h, Z, K = HKDF(Z || S, h), the SAS, the reveal body-->
//   showing_sas --poll: approved, and the payload opens under K and holds together--> accepted
//   any state --abort / inconsistency / a payload that does not open (bad_payload)--> failed (terminal)
//
// The §3.2 MUST rules are structure, not convention:
//   2  (devA, epk_A) are pinned from the first `responded`, the SAS is computed once, any later different value aborts;
//   3  nothing leads back to a new request: every failure is terminal, and only the user starts a new machine;
//   5  only a payload that opens under K is used, and K holds S, which the server does not know: a payload the server
//      made never opens (bad_payload), and nothing of it is trusted or returned;
//   6  the ephemeral private key is dropped once K is derived, and K when the machine ends;
//   7  a failure wins over a step in flight: each step computes into locals and commits in one synchronous block only if
//      no failure happened meanwhile (an epoch that every failure bumps), else it returns the failure and nothing else;
//   10 the pairing code is asked for before the reveal, so the device name sent is under S too. A code that is not 28
//      symbols, or whose check bits are wrong, is answered here and changes nothing: no attempt is used, the state stays.
//      S itself is wiped as soon as K is derived and is never part of anything this machine returns.
// A transition started while another is still running is refused, so two polls can never compute two SASes.
import { CryptoError, randomBytes, toB64, type Random } from "../../crypto/bytes";
import { parsePairingCode } from "../../crypto/pairing-code";
import type { Vk } from "../../crypto/vk";
import { generateEphemeral, importEpk, isSpkiP256, type Ephemeral } from "./device-key";
import { checkDeviceName } from "./device-name";
import {
  CODE_SPACE,
  commitment,
  enrollKey,
  openPayload,
  parsePayloadText,
  sasOf,
  sealRevealName,
  sharedSecret,
  transcriptHash,
} from "./enroll-crypto";
import { DEVICE_ID_RE, UUID_RE, b64, bytesEqual } from "./encoding";
import { SyncCryptoError } from "./errors";
import { verifyReceivedBundle, type KeyBundle } from "./keybundle";

/**
 * Test seams (adversary simulation, known-answer vectors). The public index does not expose them. `pairingSecret` is the
 * approver's S (ApproverEnrollment.start); without it S comes from the platform's random source, never from `rng`.
 */
export type EnrollOptions = { rng?: Random; ephemeral?: Ephemeral; codeSpace?: number; pairingSecret?: Uint8Array };

export type NewDevicePhase = "requesting" | "waiting" | "entering_code" | "showing_sas" | "accepted" | "failed";
export type NewDeviceFailure =
  | "tampered" // a pinned value changed or a field the view must carry is missing (MUST 2, F-10): abort and warn
  | "unexpected_state" // the server reported a state this side has not reached
  | "invalid_view" // malformed server data
  | "reflected_key" // the server handed back this device's own epk
  | "bad_payload" // the payload does not open under K, or does not hold together: POST …/reject, clear the identity
  | "rejected"
  | "expired"
  | "gone"
  | "cancelled"; // ended from outside (abort)

export type EnrollRequestBody = { device_id: string; sig_pubkey: string; commit: string };
export type RevealBody = { epk: string; nonce: string; name_ct: string };
/** GET /v1/enroll/requests/{rid} as the new device sees it. */
export type NewDeviceView = { state: string; approver_device_id?: unknown; approver_epk?: unknown; payload?: unknown };

export type EnrolledKeys = {
  vk: Vk;
  vaultId: string;
  bundle: KeyBundle;
  bundleRaw: string;
  approver: string;
  at: number;
};

type Failed = { kind: "failed"; reason: NewDeviceFailure };
export type NewDeviceStep =
  | { kind: "wait" }
  | { kind: "enter_code" } // ask for the pairing code the approving device shows
  | { kind: "accepted"; keys: EnrolledKeys } // the payload opened under K: now write locally (§3.5), then POST …/complete
  | Failed;

export type PairingCodeResult =
  | { kind: "malformed" } // not 28 symbols once read the Crockford way: nothing changed, no attempt used
  | { kind: "wrong_code" } // the check bits do not match (a typo, or a recovery code): nothing changed, no attempt used
  | { kind: "reveal"; body: RevealBody; sas: string } // POST …/reveal, then show the SAS in large digits
  | Failed;

export class NewDeviceEnrollment {
  #phase: NewDevicePhase = "requesting";
  #failure: NewDeviceFailure | null = null;
  #epoch = 0;
  #busy = false;
  readonly #devN: string;
  readonly #dpkN: Uint8Array;
  readonly #name: string;
  readonly #epkN: Uint8Array;
  readonly #nN: Uint8Array;
  readonly #rng: Random;
  readonly #space: number;
  #esk: CryptoKey | null;
  #rid: string | null = null;
  #devA: string | null = null;
  #epkA: Uint8Array | null = null;
  #epkAKey: CryptoKey | null = null;
  #h: Uint8Array | null = null;
  #k: CryptoKey | null = null;
  #sas: string | null = null;
  #reveal: RevealBody | null = null;

  private constructor(
    devN: string,
    dpkN: Uint8Array,
    name: string,
    eph: Ephemeral,
    nN: Uint8Array,
    rng: Random,
    space: number,
  ) {
    this.#devN = devN;
    this.#dpkN = dpkN;
    this.#name = name;
    this.#esk = eph.privateKey;
    this.#epkN = eph.raw;
    this.#nN = nN;
    this.#rng = rng;
    this.#space = space;
  }

  /** N1: fresh ephemeral key and nonce, the commitment, and the body of POST /v1/enroll/requests. */
  static async start(
    input: { deviceId: string; dpk: Uint8Array; name: string },
    opts: EnrollOptions = {},
  ): Promise<{ machine: NewDeviceEnrollment; request: EnrollRequestBody }> {
    if (!DEVICE_ID_RE.test(input.deviceId) || !isSpkiP256(input.dpk))
      throw new SyncCryptoError("invalid_argument", "bad device id or key");
    const name = checkDeviceName(input.name);
    if (!name.ok) throw new SyncCryptoError("invalid_device_name", name.problem);
    const rng = opts.rng ?? randomBytes;
    const eph = opts.ephemeral ?? (await generateEphemeral());
    const nN = rng(32);
    const c = await commitment(input.deviceId, input.dpk, eph.raw, nN);
    const machine = new NewDeviceEnrollment(
      input.deviceId,
      input.dpk,
      name.name,
      eph,
      nN,
      rng,
      opts.codeSpace ?? CODE_SPACE,
    );
    return { machine, request: { device_id: input.deviceId, sig_pubkey: toB64(input.dpk), commit: toB64(c) } };
  }

  get phase(): NewDevicePhase {
    return this.#phase;
  }
  get failure(): NewDeviceFailure | null {
    return this.#failure;
  }
  /** The one SAS of this request, while it is shown. */
  get sas(): string | null {
    return this.#phase === "showing_sas" ? this.#sas : null;
  }
  /** The reveal body again, byte for byte, for a resend. */
  get revealBody(): RevealBody | null {
    return this.#phase === "showing_sas" ? this.#reveal : null;
  }

  /** M1 answered with request_id (lowercase hyphenated UUID). */
  requestCreated(rid: string): void {
    this.#guard("requesting");
    if (typeof rid !== "string" || !UUID_RE.test(rid)) {
      this.#fail("invalid_view");
      return;
    }
    this.#rid = rid;
    this.#phase = "waiting";
  }

  /** M3 / M6: one poll result. */
  async onPoll(view: NewDeviceView): Promise<NewDeviceStep> {
    if (this.#phase === "failed") return this.#failed();
    if (this.#phase === "accepted") return { kind: "wait" };
    if (this.#phase === "requesting") throw new SyncCryptoError("enroll_state", "no request id yet");
    return this.#run(async (epoch) => {
      switch (this.#phase) {
        case "waiting":
          return this.#first(view, epoch);
        case "entering_code":
          // the approver answered and shows its code; this device has not revealed, so nothing may be further along
          if (!this.#samePinned(view)) return this.#fail("tampered");
          return view.state === "responded" ? { kind: "wait" } : this.#fail("unexpected_state");
        default: // showing_sas
          if (!this.#samePinned(view)) return this.#fail("tampered");
          if (view.state === "responded" || view.state === "revealed") return { kind: "wait" };
          if (view.state !== "approved" || typeof view.payload !== "string")
            return this.#fail(view.state === "approved" ? "tampered" : "unexpected_state");
          return this.#approved(view.payload, epoch);
      }
    });
  }

  /**
   * M3: the pairing code the user read off (or pasted from) the approving device. Not 28 symbols, or check bits that do
   * not match, are answered here and change nothing (MUST 10). A good one gives K over Z and S, the SAS, and the reveal
   * body: S is wiped at once and is in nothing returned.
   */
  async submitPairingCode(input: string): Promise<PairingCodeResult> {
    if (this.#phase === "failed") return this.#failed();
    this.#guard("entering_code");
    return this.#run(async (epoch) => {
      let s: Uint8Array;
      try {
        s = await parsePairingCode(typeof input === "string" ? input : "");
      } catch (e) {
        if (!(e instanceof CryptoError)) throw e;
        return e.code === "pairing_checksum" ? { kind: "wrong_code" } : { kind: "malformed" }; // local and free
      }
      try {
        const esk = this.#esk;
        const epkKey = this.#epkAKey;
        if (!esk || !epkKey || this.#epoch !== epoch) return this.#failed();
        const devA = this.#devA!;
        const epkA = this.#epkA!;
        const h = await transcriptHash({
          rid: this.#rid!,
          devN: this.#devN,
          devA,
          dpkN: this.#dpkN,
          epkN: this.#epkN,
          epkA,
          nN: this.#nN,
        });
        const k = await enrollKey(await sharedSecret(esk, epkKey), s, h);
        const sas = await sasOf(h, this.#space); // the only SAS this request will ever show
        const reveal = {
          epk: toB64(this.#epkN),
          nonce: toB64(this.#nN),
          name_ct: await sealRevealName(k, h, this.#name, this.#rng),
        };
        if (this.#epoch !== epoch) return this.#failed(); // MUST 7: an abort during the awaits wins
        this.#esk = null;
        this.#epkAKey = null;
        this.#h = h;
        this.#k = k;
        this.#sas = sas;
        this.#reveal = reveal;
        this.#phase = "showing_sas";
        return { kind: "reveal", body: reveal, sas };
      } finally {
        s.fill(0); // enrollKey wipes it too; this covers every other way out
      }
    });
  }

  /** Rejected, expired (410), network failure or the user leaving: terminal, also for a step still in flight (MUST 7). */
  abort(reason: "rejected" | "expired" | "gone" | "cancelled"): void {
    if (this.#phase !== "accepted" && this.#phase !== "failed") this.#fail(reason);
  }

  async #first(view: NewDeviceView, epoch: number): Promise<NewDeviceStep> {
    if (view.state === "pending") return { kind: "wait" };
    if (view.state !== "responded") return this.#fail("unexpected_state");
    if (view.approver_device_id === undefined || view.approver_epk === undefined) return this.#fail("tampered"); // F-10: always present from responded on
    let epkA: Uint8Array;
    let epkKey: CryptoKey;
    try {
      if (typeof view.approver_device_id !== "string" || !DEVICE_ID_RE.test(view.approver_device_id))
        throw new Error("id");
      epkA = b64(view.approver_epk, 65);
      epkKey = await importEpk(epkA);
    } catch {
      return this.#fail("invalid_view");
    }
    if (bytesEqual(epkA, this.#epkN)) return this.#fail("reflected_key");
    if (this.#epoch !== epoch) return this.#failed(); // MUST 7
    this.#devA = view.approver_device_id as string; // MUST 2: pinned from here on
    this.#epkA = epkA;
    this.#epkAKey = epkKey;
    this.#phase = "entering_code";
    return { kind: "enter_code" };
  }

  /** M6 / M7: only a payload that opens under K (and so was made by a holder of S) and holds together is used. */
  async #approved(payload: string, epoch: number): Promise<NewDeviceStep> {
    const k = this.#k;
    const h = this.#h;
    const devA = this.#devA;
    if (!k || !h || !devA) return this.#failed();
    let keys: EnrolledKeys | null = null;
    try {
      const p = await parsePayloadText(await openPayload(k, h, payload));
      if (p.approver === devA) {
        const bundle = await verifyReceivedBundle(p.bundleRaw, p.vk, p.vaultId); // vkId, vaultId, MAC (§3.2 M7)
        keys = { vk: p.vk, vaultId: p.vaultId, bundle, bundleRaw: p.bundleRaw, approver: p.approver, at: p.at };
      }
    } catch {
      keys = null;
    }
    if (this.#epoch !== epoch) return this.#failed();
    if (!keys) return this.#fail("bad_payload");
    this.#phase = "accepted";
    this.#drop();
    return { kind: "accepted", keys };
  }

  #samePinned(view: NewDeviceView): boolean {
    try {
      return view.approver_device_id === this.#devA && bytesEqual(b64(view.approver_epk, 65), this.#epkA!);
    } catch {
      return false;
    }
  }

  #guard(phase: NewDevicePhase): void {
    if (this.#phase !== phase) throw new SyncCryptoError("enroll_state", "not allowed in this state");
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

  /** The first failure wins and is final. */
  #fail(reason: NewDeviceFailure): Failed {
    if (this.#phase === "failed") return this.#failed();
    this.#phase = "failed";
    this.#failure = reason;
    this.#epoch++;
    this.#drop();
    return this.#failed();
  }

  #drop(): void {
    this.#esk = null;
    this.#epkAKey = null;
    this.#k = null;
  }
}
