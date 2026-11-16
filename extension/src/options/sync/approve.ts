// Approving a new device from this one (SYNC-DESIGN §3.2 M2–M5, §6 O9). In this order:
//   1. the click asks Chrome first (manage.ts); the master password (every step that hands the vault key over sends
//      pw_auth, and the pre-send check runs first, §3.14);
//   2. the waiting requests, with when each was made; more than one: "approve only the one you are setting up right
//      now" (a request someone else made looks the same); one already handled elsewhere says so;
//   3. one chosen: this device answers it (respond), and only once the server accepted that, the pairing code is shown
//      in seven groups with Copy (and what copying means), to be typed on the new device (§3.2 M2, MUST 5, MUST 10);
//      this page polls until the new device has revealed;
//   4. the new device revealed: the pairing code leaves the screen (and the engine's memory); a claimed name that does
//      not open under the key holding the code ends the request ("the pairing code did not match": the engine rejects it,
//      MUST 10); otherwise the user types the six digits the new device shows ("claims to be: X" beside them, untrusted
//      text, shown as text); three wrong tries reject the request (MUST 4);
//   5. a match: the approval is built and sent; once the server accepted it, "Approved".
// The scam warning is on both code screens. A request can be rejected from the list or from its own steps. The
// password is held in this object while the flow runs (the steps after the first need it again) and dropped once the
// server accepted the approval (nothing is left to send), at the flow's end, at a lock, and when the page goes away
// (manage.ts). The pairing code is in this flow's state only while it is on screen, and at most as long as the request
// can live (ENROLL_TTL_S and a minute), however the polls go; if the user copied it, the clipboard is cleared of it as
// soon as the step ends (when clearing the clipboard is allowed). The approval goes into the security record
// (device_approved).
import { Approver, failureOf, type Failure, type SyncKit } from "./gateway";
import { ManageFlow } from "./manage";
import { fixable } from "./model";

export type WaitingRequest = { rid: string; createdAt: number | null; handledBy: string | null };

export type ApproveState =
  | { at: "asking" }
  | { at: "password"; failure?: Failure; busy?: boolean }
  | { at: "list"; requests: WaitingRequest[]; failure?: Failure; busy?: boolean }
  | { at: "connecting" }
  | { at: "code"; code: string } // respond accepted: the pairing code on screen, polling for the reveal
  | { at: "sas"; claimedName: string; attemptsLeft: number; problem?: "malformed" | "wrong"; busy?: boolean }
  | { at: "mismatch" } // the claimed name did not open under the pairing code's key: rejected (MUST 10)
  | { at: "done" }
  | { at: "rejected" };

/** The approver's poll interval while it waits for the new device (§4.8: 2 s). */
export const APPROVER_POLL_MS = 2_000;
/** The SAS attempts (§3.2 MUST 4). */
export const SAS_ATTEMPTS = 3;
/**
 * The longest the pairing code stays on screen (MUST 10: "至多到请求过期"): the request's life (ENROLL_TTL_S, 600 s) and
 * a minute of rounding, counted from respond's acceptance on this device's own clock, whatever the polls say.
 */
export const CODE_LIFETIME_MS = (600 + 60) * 1000;

type Timer = (fn: () => void, ms: number) => () => void;
const browserTimer: Timer = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const time = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);

export class ApproveFlow extends ManageFlow<ApproveState> {
  #password: string | null = null;
  #approver: Approver | null = null;
  #stopPoll: (() => void) | null = null;
  #stopDeadline: (() => void) | null = null;
  /** The pairing code, if the user copied it: cleared from the clipboard when its step ends (§7). */
  #copied: string | null = null;

  constructor(
    kit: SyncKit,
    private readonly o: { timer?: Timer } = {},
  ) {
    super(kit, { at: "asking" }, ["done", "rejected", "mismatch"]);
  }

  protected clear(): void {
    this.#password = null;
    this.#approver?.discard(); // the pairing secret wiped with it (MUST 10: discarded at every end)
    this.#approver = null;
    this.#stopPoll?.();
    this.#stopPoll = null;
    this.codeGone();
  }

  /** The pairing code's step is over (the reveal, or any end): no deadline left, and no copy of it on the clipboard. */
  private codeGone(): void {
    this.#stopDeadline?.();
    this.#stopDeadline = null;
    if (this.#copied !== null) this.kit.uncopy(this.#copied);
    this.#copied = null;
  }

  start(granted: Promise<boolean>): Promise<void> {
    return this.opened(granted, () => this.set({ at: "password" }));
  }

  /** The master password, then the waiting requests (checked by the server's answer to the first step that sends it). */
  async submitPassword(password: string): Promise<void> {
    const s = this.state;
    if (s.at !== "password" || s.busy || !password) return;
    const run = this.epoch;
    this.set({ at: "password", busy: true });
    try {
      const list = await Approver.list(this.kit.engine);
      if (!this.live(run)) return;
      this.#password = password;
      this.set({ at: "list", requests: waiting(list) });
    } catch (e) {
      if (this.live(run)) this.failedAt(failureOf(e), { at: "password" });
    }
  }

  /** The list again (a request made a moment ago). */
  async refresh(): Promise<void> {
    const s = this.state;
    if (s.at !== "list" || s.busy) return;
    const run = this.epoch;
    this.set({ ...s, busy: true, failure: undefined } as ApproveState);
    try {
      const list = await Approver.list(this.kit.engine);
      if (this.live(run)) this.set({ at: "list", requests: waiting(list) });
    } catch (e) {
      if (this.live(run)) this.set({ ...s, busy: false, failure: failureOf(e) } as ApproveState);
    }
  }

  /**
   * Answer request `rid` (M2): this device responds; accepted, the pairing code is shown and the page waits for the new
   * device to reveal (its claimed name, then the six digits it shows).
   */
  async choose(rid: string): Promise<void> {
    const s = this.state;
    const pw = this.#password;
    if (s.at !== "list" || s.busy || pw === null || !s.requests.some((r) => r.rid === rid)) return;
    const run = this.epoch;
    this.set({ at: "connecting" });
    try {
      const a = await Approver.start(this.kit.engine, rid, pw);
      if (!this.live(run)) {
        await a.reject(pw).catch(() => undefined);
        return;
      }
      this.#approver = a;
      this.set({ at: "code", code: a.pairingCode }); // respond was accepted (MUST 5)
      this.#stopDeadline = (this.o.timer ?? browserTimer)(() => {
        if (this.live(run) && this.state.at === "code") this.end({ code: "expired" }); // MUST 10: its whole lifetime
      }, CODE_LIFETIME_MS);
      await this.pollOnce();
      if (this.live(run) && this.state.at === "code") this.schedulePoll(run);
    } catch (e) {
      if (!this.live(run)) return;
      const f = failureOf(e);
      if (f.code === "wrong_secret") return this.set({ at: "password", failure: f }); // typed wrong: the list asks again
      this.end(f);
    }
  }

  private schedulePoll(run: number): void {
    this.#stopPoll?.();
    this.#stopPoll = (this.o.timer ?? browserTimer)(() => {
      if (!this.live(run)) return;
      void this.pollOnce().then(() => {
        if (this.live(run) && this.state.at === "code") this.schedulePoll(run);
      });
    }, APPROVER_POLL_MS);
  }

  /**
   * One poll (exported for the tests; the page polls every 2 s while the pairing code is on screen, until the new device
   * has revealed its name). The reveal takes the code off the screen; a name that does not open under the code's key
   * is the mismatch screen (the engine rejected the request with the password).
   */
  async pollOnce(): Promise<void> {
    const a = this.#approver;
    const pw = this.#password;
    if (!a || pw === null || this.state.at !== "code") return;
    const run = this.epoch;
    let step;
    try {
      step = await a.poll(pw);
    } catch (e) {
      const f = failureOf(e);
      if (f.code === "network") return; // the next poll asks again
      if (this.live(run)) this.end(f);
      return;
    }
    if (!this.live(run)) return;
    if (step.kind === "enter_sas") {
      this.codeGone();
      this.set({ at: "sas", claimedName: step.claimedName, attemptsLeft: SAS_ATTEMPTS });
    } else if (step.kind === "failed" && step.reason === "pairing_mismatch") {
      this.clear();
      this.set({ at: "mismatch" });
    } else if (step.kind === "failed") this.end({ code: step.reason });
  }

  /** Copy (§7): the pairing code to the system clipboard, on the user's click, only while it is on screen. */
  async copyCode(): Promise<boolean> {
    const s = this.state;
    if (s.at !== "code") return false;
    const run = this.epoch;
    const ok = await this.kit.copy(s.code);
    if (ok) {
      this.#copied = s.code;
      if (!this.live(run) || this.state.at !== "code") this.codeGone(); // the step ended while it was being copied
    }
    return ok;
  }

  /** The six digits the new device shows: three tries; a match sends the approval. */
  async submitSas(sas: string): Promise<void> {
    const s = this.state;
    const a = this.#approver;
    const pw = this.#password;
    if (s.at !== "sas" || s.busy || !a || pw === null) return;
    const run = this.epoch;
    this.set({ ...s, busy: true, problem: undefined });
    let r;
    try {
      r = await this.write(a.submitSas(sas, pw));
    } catch (e) {
      if (this.live(run) || this.lockedOut) this.end(failureOf(e));
      return;
    }
    if (!this.live(run)) return;
    if (r.kind === "malformed") return this.set({ ...s, busy: false, problem: "malformed" });
    if (r.kind === "retry") return this.set({ ...s, busy: false, attemptsLeft: r.attemptsLeft, problem: "wrong" });
    if (r.kind === "failed") return this.end({ code: r.reason });
    this.clear(); // approved: nothing secret is needed any more, and nothing is left to send
    this.set({ at: "done" });
    this.kit.changed();
  }

  /**
   * Cancel, or another flow taking this one's place, while a request is being answered and not yet approved: the request
   * is given up (rejected with the password still held), so that other devices do not show it as handled here until it
   * expires and the new device stops waiting. After the approval was accepted there is nothing to give up.
   */
  override async cancel(): Promise<void> {
    const givingUp = this.giveUp();
    await super.cancel();
    await givingUp;
  }

  override retire(): void {
    void this.giveUp();
    super.retire();
  }

  private giveUp(): Promise<void> {
    const a = this.#approver;
    const pw = this.#password;
    const at = this.state.at;
    if (!a || pw === null || (at !== "connecting" && at !== "code" && at !== "sas")) return Promise.resolve();
    this.#stopPoll?.();
    return a.reject(pw).catch(() => undefined);
  }

  /** Reject the request being answered (pw_auth). */
  async rejectCurrent(): Promise<void> {
    const a = this.#approver;
    const pw = this.#password;
    if (!a || pw === null || this.isOver) return;
    const run = this.bump();
    this.#stopPoll?.();
    try {
      await this.write(a.reject(pw));
    } catch (e) {
      if (this.live(run)) this.end(failureOf(e));
      return;
    }
    if (!this.live(run)) return;
    this.clear();
    this.set({ at: "rejected" });
  }

  /** Reject one request from the list without answering it (pw_auth). */
  async reject(rid: string): Promise<void> {
    const s = this.state;
    const pw = this.#password;
    if (s.at !== "list" || s.busy || pw === null) return;
    const run = this.epoch;
    this.set({ ...s, busy: true, failure: undefined });
    try {
      await this.write(Approver.rejectRequest(this.kit.engine, rid, pw));
    } catch (e) {
      if (this.live(run)) this.set({ ...s, busy: false, failure: failureOf(e) });
      return;
    }
    if (!this.live(run)) return;
    this.set({ ...s, busy: false, requests: s.requests.filter((r) => r.rid !== rid) });
    this.kit.changed();
  }

  private failedAt(f: Failure, stay: ApproveState): void {
    if (f.code === "locked" || this.lockedOut) return this.end({ code: "locked_out" });
    if (fixable(f)) return this.set({ ...stay, failure: f } as ApproveState);
    this.end(f);
  }
}

/** The requests still waiting for this device's answer, oldest first (what the server says: shown, not trusted). */
function waiting(
  list: readonly { request_id: string; created_at: number; state: string; handled_by?: string }[],
): WaitingRequest[] {
  return list
    .filter(
      (r) =>
        typeof r?.request_id === "string" &&
        (r.state === "pending" || r.state === "responded" || r.state === "revealed"),
    )
    .map((r) => ({
      rid: r.request_id,
      createdAt: time(r.created_at),
      handledBy: typeof r.handled_by === "string" ? r.handled_by : null,
    }))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
