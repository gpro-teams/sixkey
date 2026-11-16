// Joining a vault that another device already syncs (SYNC-DESIGN §3.2, §3.3, §3.5; §6 O4–O7). In this order:
//   1. the click asks Chrome for the API permission (permission.ts), unless the turn-on flow hands its sign-in and its
//      permission over (enable.ts handOver: the email turned out to have a vault already);
//   2. the email and its one-time code (signin.ts), then GET /v1/account: no vault yet, the user can turn sync on with
//      this profile instead; a vault, the warning card (O4: when it was made, how many devices; "if you never turned on
//      Sixkey sync, someone else may control your email: stop here"), this device's name, and the two ways in:
//   3a. the recovery code (§3.3, O7): seven groups of four, read the way the code is read; the server returns the vault
//       to the code's proof, M1 checks what it opened, and the local half is prepared in memory (nothing written);
//   3b. approval by a device that already syncs (§3.2, O5, O6; enrolment v2): a request is opened; once the other device
//       picks it, it shows a pairing code (28 characters), which the user types or pastes here, BEFORE this device
//       reveals anything (MUST 10): a code that is not 28 symbols, or whose check bits are wrong, is said here and costs
//       nothing (no attempt, no state change). A good one: this device shows the six-digit check (SAS) in large digits,
//       to be typed there; once that device approves, the payload opens only under the key that holds the pairing code
//       (MUST 5), and the join is prepared. Polled every 2 s by this page (§4.8), never re-opened by itself (MUST 3):
//       every failure is final, and starting again is the user's, with a new sign-in (one request per account session).
//       A request that ends after the code was typed may be the approver's "pairing code did not match" (a typo past the
//       check bits): this side cannot know (the server could lie), so its text says to start again if the code was
//       mistyped. The code typed is held by the view only while that step is on screen, never by this flow;
//   4. the summary (§3.5 ③): what joining does to this profile (its own accounts added to the synced vault, the vault
//      kept aside; or merged; or nothing here yet), with the sharing warning; Continue writes it and completes the
//      enrolment (enroll.ts commitJoin): "enrolled", or "unconfirmed" (the next round asks the server, D4).
// Over unreadable local data (vaultStatus "lost") neither way goes on until the user ticked, on the warning card, that
// the synced vault replaces it (§3.5): only that tick passes confirmLost to the engine, whose commit refuses without it.
// The API permission is kept only for "enrolled" and "unconfirmed"; every other outcome, a cancel included, gives it back
// (permission.ts). A guard block on a fold (this profile's kept saves, an earlier join's undo) shows the review and the
// join starts again with the answer (§4.4). Closing the page gives the request up (MUST 6): the reject is sent if the
// page lives long enough, and the request expires on the server in any case (ten minutes).
// A lock of Sixkey (lock.ts) ends the join at once, the recovery code and the prepared join dropped, the approval request
// given up. While Continue is writing, the lock waits for it: the engine refuses to commit a join prepared with this
// device's vault open once the vault has locked, and the commit's outcome is what the flow reports. Nothing gives the
// permission back while Continue is writing (cancel and the page closing wait for it).
import { accountOf, type VaultInfo } from "./account";
import {
  ApprovalJoin,
  checkDeviceName,
  commitJoin,
  failureOf,
  joinSummary,
  joinWithRecoveryCode,
  vaultStatus,
  type DeviceNameProblem,
  type Failure,
  type JoinPlan,
  type MergeAnswer,
  type PreparedJoin,
  type SyncKit,
} from "./gateway";
import { fixable } from "./model";
import { giveBack, settlePermission } from "./permission";
import type { Blocked } from "./review";
import { SignIn } from "./signin";
import { Store } from "./store";

export type JoinVia = "recovery" | "approval";
export type JoinState =
  | { at: "asking" }
  | { at: "declined" }
  | { at: "signin" }
  | { at: "checking"; failure?: Failure }
  | { at: "no_vault" }
  | { at: "choose"; info: VaultInfo; name: string; problem?: DeviceNameProblem; lost: boolean; failure?: Failure }
  | { at: "recovery"; lost: boolean; failure?: Failure; busy?: boolean }
  | { at: "starting" }
  | { at: "waiting"; expiresAt: number }
  | { at: "code"; expiresAt: number; problem?: "malformed" | "wrong"; busy?: boolean } // the pairing code (MUST 10)
  | { at: "sas"; sas: string; expiresAt: number }
  | { at: "review"; blocked: Blocked; via: JoinVia }
  | { at: "summary"; summary: PreparedJoin; via: JoinVia; busy?: boolean }
  | { at: "done"; via: JoinVia }
  | { at: "unconfirmed" }
  | { at: "failed"; failure: Failure }
  | { at: "closed" };

/** How the server ends a request; after the reveal, one of these may be the approver's pairing-code mismatch. */
const ENDED: ReadonlySet<string> = new Set(["gone", "rejected", "expired"]);

/** The outcomes after which sync is on, or will be once the next round confirms it (permission.ts KEPT_OUTCOMES). */
export type JoinOutcome = "enrolled" | "unconfirmed";

/** The states in which the join is over: nothing it holds is secret, and a lock changes nothing. */
const OVER: ReadonlySet<JoinState["at"]> = new Set(["declined", "no_vault", "done", "unconfirmed", "failed", "closed"]);

/** The approval request's poll interval (§4.8: the enrolment pages poll their own endpoint every 2 s). */
export const POLL_MS = 2_000;

type Timer = (fn: () => void, ms: number) => () => void;
const browserTimer: Timer = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export class JoinFlow extends Store<JoinState> {
  readonly signin: SignIn;
  #name = "";
  #lost = false;
  #info: VaultInfo = { createdAt: null, devices: null };
  #code: string | null = null;
  #plan: JoinPlan | null = null;
  #approval: ApprovalJoin | null = null;
  #stopPoll: (() => void) | null = null;
  #unsub: () => void;
  #handedOver: boolean;
  /** The user ticked that the synced vault replaces this profile's unreadable data (asked only when it is lost). */
  #confirmedLost = false;
  /** Sync was off when this join began (read once; null until then): only then may the page's closing drop the permission. */
  #syncOff: boolean | null = null;
  /** Continue's write, while it runs: nothing gives the permission back before it ends. */
  #writing: Promise<unknown> | null = null;
  /** Sixkey locked while Continue was writing: the join ends with the lock once it does, unless it turned sync on. */
  #lockedOut = false;
  /** Another flow took this one's place (retire): nothing of it is this flow's to give back any more. */
  #passedOn = false;

  /**
   * `signin`: a sign-in handed over by the turn-on flow (signed in already, the permission held). `timer`: the approval
   * poll's (tests drive pollOnce themselves). `onSyncOn`: the join ended with sync on, and how. `name`: the device name
   * offered.
   */
  constructor(
    private readonly kit: SyncKit,
    private readonly o: {
      signin?: SignIn;
      timer?: Timer;
      onSyncOn?: (outcome: JoinOutcome) => void;
      name?: string;
    } = {},
  ) {
    super(o.signin ? { at: "checking" } : { at: "asking" });
    this.#name = o.name ?? "";
    this.#handedOver = o.signin !== undefined;
    this.signin = o.signin ?? new SignIn(kit);
    this.#unsub = this.signin.subscribe(() => {
      if (this.state.at === "signin" && this.signin.state.at === "in") void this.checkAccount();
    });
    if (this.#handedOver) void this.checkAccount();
  }

  /** Step 1, from the click (permission.ts asking): the answer to Chrome's prompt. */
  async start(granted: Promise<boolean>): Promise<void> {
    const run = this.bump();
    this.stopApproval();
    this.#code = null;
    this.#plan = null;
    this.#confirmedLost = false;
    this.#lockedOut = false;
    this.signin.again();
    this.set({ at: "asking" });
    let ok = false;
    try {
      ok = await granted;
    } catch {
      ok = false;
    }
    if (!this.live(run)) {
      // answered after the join ended (a lock or a cancel while Chrome's prompt was open): a grant has no flow to serve.
      // A run superseded by a newer one (Ask again, clicked twice) leaves it to that run.
      if (ok && OVER.has(this.state.at) && !this.#passedOn) await giveBack(this.kit);
      return;
    }
    this.set(ok ? { at: "signin" } : { at: "declined" });
    if (ok) await this.readSyncOff();
  }

  private async readSyncOff(): Promise<void> {
    if (this.#syncOff !== null) return;
    const on = await this.kit.engine.view().then(
      (v) => v.syncOn,
      () => null,
    );
    if (on !== null && this.#syncOff === null) this.#syncOff = !on;
  }

  /** Step 2: the account's vault, then the warning card (the sign-in moves here by itself). */
  async checkAccount(): Promise<void> {
    const session = this.signin.session;
    if (!session || (this.state.at !== "signin" && this.state.at !== "checking")) return;
    const run = this.epoch;
    this.set({ at: "checking" });
    await this.readSyncOff();
    try {
      const a = await accountOf(this.kit, session);
      const local = await vaultStatus(this.kit);
      if (!this.live(run)) return;
      this.#lost = local === "lost";
      this.#info = a.info;
      this.set(a.hasVault ? { at: "choose", info: a.info, name: this.#name, lost: this.#lost } : { at: "no_vault" });
    } catch (e) {
      if (!this.live(run)) return;
      const f = failureOf(e);
      if (f.code === "session_invalid") {
        this.signin.again(f);
        this.set({ at: "signin" });
      } else this.set({ at: "checking", failure: f });
    }
  }

  /** The name the user typed on the warning card (kept while they choose). */
  setName(name: string): void {
    if (this.state.at === "choose") this.set({ ...this.state, name, problem: undefined } as JoinState);
  }

  /**
   * The name is one other devices can list (§2.4); this profile's unreadable data, if it has some, may be replaced (the
   * user ticked it); and this profile's vault can be read here: with a vault of its own the page must be unlocked (its
   * accounts are added to the synced vault, §3.5), so a page that is locked when the user chooses is told to unlock
   * first, before anything is sent (the flow stays open: this is the one place "locked" is a thing to fix in place).
   */
  private async ready(confirmLost: boolean): Promise<boolean> {
    const s = this.state;
    if (s.at !== "choose") return false;
    const c = checkDeviceName(s.name);
    if (!c.ok) {
      this.set({ ...s, problem: c.problem });
      return false;
    }
    this.#name = c.name;
    if (this.#lost && !confirmLost) {
      this.set({ ...s, name: c.name, failure: { code: "confirm_lost" } });
      return false;
    }
    if ((await this.kit.service.status()).state === "locked") {
      this.set({ ...s, name: c.name, failure: { code: "locked" } });
      return false;
    }
    this.#confirmedLost = this.#lost && confirmLost;
    return true;
  }

  private chooseState(failure?: Failure): JoinState {
    return { at: "choose", info: this.#info, name: this.#name, lost: this.#lost, ...(failure ? { failure } : {}) };
  }

  // ---- 3a. the recovery code ----------------------------------------------------------------------------------

  /** `confirmLost`: the warning card's tick (shown only when this profile's data is unreadable). */
  async chooseRecovery(o: { confirmLost?: boolean } = {}): Promise<void> {
    const run = this.epoch;
    if ((await this.ready(o.confirmLost === true)) && this.live(run)) this.set({ at: "recovery", lost: this.#lost });
  }

  /** The code (§3.3): its proof opens the vault on the server, M1 checks it, the local half is prepared in memory. */
  async submitRecovery(code: string, o: { answer?: MergeAnswer } = {}): Promise<void> {
    const s = this.state;
    const fromReview = s.at === "review" && s.via === "recovery";
    if (!fromReview && (s.at !== "recovery" || s.busy)) return;
    const session = this.signin.session;
    if (!session) return;
    const run = this.epoch;
    this.#code = code;
    this.set({ at: "recovery", lost: this.#lost, busy: true });
    try {
      const plan = await joinWithRecoveryCode(this.kit.engine, {
        session,
        recoveryCode: code,
        deviceName: this.#name,
        email: this.signin.email,
        ...(this.#confirmedLost ? { confirmLost: true } : {}),
        ...(o.answer ? { answer: o.answer } : {}),
      });
      if (!this.live(run)) return;
      this.#plan = plan;
      this.set({ at: "summary", summary: joinSummary(plan), via: "recovery" });
    } catch (e) {
      if (this.live(run)) await this.failed(failureOf(e), { at: "recovery", lost: this.#lost }, "recovery");
    }
  }

  // ---- 3b. approval by another device ---------------------------------------------------------------------------

  /** Opens the request (§3.2 N1, M1); the page then polls it. `confirmLost`: the warning card's tick. */
  async chooseApproval(o: { confirmLost?: boolean; answer?: MergeAnswer } = {}): Promise<void> {
    const s = this.state;
    const fromReview = s.at === "review" && s.via === "approval";
    const run = this.epoch;
    if (!fromReview && !(await this.ready(o.confirmLost === true))) return;
    const session = this.signin.session;
    if (!session || !this.live(run)) return;
    this.set({ at: "starting" });
    try {
      const a = await ApprovalJoin.start(this.kit.engine, {
        session,
        deviceName: this.#name,
        email: this.signin.email,
        ...(o.answer ? { answer: o.answer } : {}),
        ...(this.#confirmedLost ? { confirmLost: true } : {}),
      });
      if (!this.live(run)) {
        await a.cancel();
        return;
      }
      this.#approval = a;
      this.set({ at: "waiting", expiresAt: a.expiresAt });
      this.schedulePoll(run);
    } catch (e) {
      if (this.live(run)) await this.failed(failureOf(e), this.chooseState(), "approval");
    }
  }

  private schedulePoll(run: number): void {
    this.#stopPoll?.();
    this.#stopPoll = (this.o.timer ?? browserTimer)(() => {
      if (!this.live(run)) return;
      void this.pollOnce().then(() => {
        const at = this.state.at;
        if (this.live(run) && (at === "waiting" || at === "code" || at === "sas")) this.schedulePoll(run);
      });
    }, POLL_MS);
  }

  /** One poll of the request (exported for the tests; the page polls every 2 s). */
  async pollOnce(): Promise<void> {
    const a = this.#approval;
    if (!a) return;
    const run = this.epoch;
    let step;
    try {
      step = await a.poll();
    } catch (e) {
      const f = failureOf(e);
      if (f.code === "network") return; // a poll lost on the way: the next one asks again (nothing is re-opened, MUST 3)
      if (this.live(run)) await this.end(f);
      return;
    }
    if (!this.live(run)) return;
    const s = this.state;
    const expiresAt = "expiresAt" in s ? s.expiresAt : a.expiresAt;
    switch (step.kind) {
      case "waiting":
        if (s.at !== "waiting") this.set({ at: "waiting", expiresAt });
        return;
      case "enter_code":
        if (s.at !== "code") this.set({ at: "code", expiresAt });
        return;
      case "show_sas":
        if (s.at !== "sas" || s.sas !== step.sas) this.set({ at: "sas", sas: step.sas, expiresAt });
        return;
      case "approved":
        return this.approved(a, run);
      default:
        // after the code was typed, the approver's "did not match" looks like any other end here (MUST 10)
        return this.end({ code: s.at === "sas" && ENDED.has(step.reason) ? "join_ended" : step.reason });
    }
  }

  /**
   * The pairing code the approving device shows (§3.2 M3, MUST 10), typed or pasted. Not 28 symbols, or check bits that
   * do not match: said here, and nothing changes (no attempt is counted, the step stays). A good one: the reveal is sent
   * and the six digits shown.
   */
  async submitCode(code: string): Promise<void> {
    const s = this.state;
    const a = this.#approval;
    if (s.at !== "code" || s.busy || !a) return;
    const run = this.epoch;
    this.set({ ...s, busy: true, problem: undefined });
    let r;
    try {
      r = await a.submitPairingCode(code);
    } catch (e) {
      if (this.live(run)) await this.end(failureOf(e));
      return;
    }
    if (!this.live(run)) return;
    if (r.kind === "malformed") return this.set({ ...s, busy: false, problem: "malformed" });
    if (r.kind === "wrong_code") return this.set({ ...s, busy: false, problem: "wrong" });
    if (r.kind === "failed") return this.end({ code: r.reason });
    this.set({ at: "sas", sas: r.sas, expiresAt: s.expiresAt });
  }

  /** M7: the payload opened under the pairing code's key: the join is prepared, and its summary shown. */
  private async approved(a: ApprovalJoin, run: number): Promise<void> {
    this.#stopPoll?.();
    let plan: JoinPlan;
    try {
      plan = await a.prepare();
    } catch (e) {
      // the fold before the join refused (locked) or stopped at the guard: nothing was prepared or written; the request
      // is given up, and the user starts again (after unlocking, or with the review's answer: M3-NOTES §10 item 17)
      if (!this.live(run)) return;
      await a.cancel();
      this.#approval = null;
      const f = failureOf(e);
      if (f.blocked) return this.set({ at: "review", blocked: f.blocked, via: "approval" });
      return this.end(f);
    }
    if (!this.live(run)) return;
    this.#plan = plan;
    this.set({ at: "summary", summary: joinSummary(plan), via: "approval" });
  }

  // ---- 4. the summary and the commit ------------------------------------------------------------------------------

  /** Continue: the local half written, the enrolment completed (enroll.ts commitJoin). */
  async commit(): Promise<void> {
    const s = this.state;
    if (s.at !== "summary" || s.busy || !this.#plan) return;
    const run = this.epoch;
    this.set({ ...s, busy: true });
    let r: JoinOutcome;
    const writing = commitJoin(this.#plan).finally(() => {
      if (this.#writing === writing) this.#writing = null;
    });
    this.#writing = writing;
    try {
      r = await writing;
    } catch (e) {
      if (this.live(run)) await this.end(this.#lockedOut ? { code: "locked_out" } : failureOf(e));
      return;
    }
    if (!this.live(run)) return;
    this.#plan = null;
    this.#code = null;
    this.#approval = null;
    this.signin.forget();
    this.set(r === "enrolled" ? { at: "done", via: s.via } : { at: "unconfirmed" });
    this.kit.changed();
    this.o.onSyncOn?.(r);
  }

  /** The review's answer: the same join again, with it. */
  async answered(answer: MergeAnswer): Promise<void> {
    const s = this.state;
    if (s.at !== "review") return;
    if (s.via === "recovery" && this.#code !== null) return this.submitRecovery(this.#code, { answer });
    return this.chooseApproval({ answer });
  }

  /** Back from the recovery code or a failed approval to the two ways in. */
  back(): void {
    const s = this.state;
    if (s.at === "recovery" && !s.busy) this.set(this.chooseState());
  }

  /**
   * The user cancelled, or the page is closing (MUST 6), or the section went away: the request rejected, then the
   * permission back. Nothing goes on to a next step, and Continue's write, if it runs, is waited for before the
   * permission is decided: a join that turned sync on keeps it (giveBack sees sync on).
   */
  async cancel(): Promise<void> {
    this.bump();
    const was = this.state.at;
    const a = this.#approval;
    this.stopApproval();
    this.#code = null;
    this.#plan = null;
    this.signin.forget();
    this.set({ at: "closed" });
    await a?.cancel().catch(() => undefined);
    const writing = this.#writing;
    if (writing) await writing.catch(() => undefined);
    if (was !== "done" && was !== "unconfirmed" && was !== "closed") await settlePermission(this.kit, "cancelled");
  }

  /**
   * The page is going away (pagehide): whether the permission can be given back right now, before anything is awaited.
   * Only while this join holds it for itself and cannot have turned sync on: sync was off when it began, not handed over,
   * Continue not pressed, not ended with sync on. The caller removes it, then cancels.
   */
  leaving(): boolean {
    return (
      this.#syncOff === true &&
      !this.#handedOver &&
      this.#writing === null &&
      this.state.at !== "summary" &&
      !OVER.has(this.state.at)
    );
  }

  /** Sixkey locked (lock.ts): see the top of this file. */
  async locked(): Promise<void> {
    if (OVER.has(this.state.at)) return;
    this.#lockedOut = true;
    if (this.#writing) return; // Continue's own continuation ends the join, unless it turned sync on
    this.bump();
    await this.end({ code: "locked_out" });
  }

  /**
   * Another flow takes this one's place (turning sync on, after "no vault yet"): this one stops, its sign-in and secrets
   * dropped, an approval request given up. The permission is left as it is: the new flow's own click has just asked for it.
   */
  retire(): void {
    this.bump();
    this.#passedOn = true;
    const a = this.#approval;
    this.stopApproval();
    void a?.cancel().catch(() => undefined);
    this.#code = null;
    this.#plan = null;
    this.signin.forget();
    if (!OVER.has(this.state.at)) this.set({ at: "closed" });
  }

  dispose(): void {
    this.#unsub();
    this.#stopPoll?.();
  }

  private stopApproval(): void {
    this.#stopPoll?.();
    this.#stopPoll = null;
    this.#approval = null;
  }

  /** A failure of step 3: fixable ones stay on `stay`; a guard block shows the review; the others end the join. */
  private async failed(f: Failure, stay: JoinState, via: JoinVia): Promise<void> {
    if (f.code === "session_invalid" || f.code === "one_per_session") {
      // a sign-in again (one approval request per session), then back to the two ways in
      this.signin.again(f);
      return this.set({ at: "signin" });
    }
    if (f.blocked) return this.set({ at: "review", blocked: f.blocked, via });
    if (fixable(f)) return this.set({ ...stay, failure: f } as JoinState);
    await this.end(f);
  }

  /**
   * The join ended without turning sync on: the request (if any) given up, then the permission back. A lock among the
   * causes (the engine says locked: the key is gone) is said as one.
   */
  private async end(f: Failure): Promise<void> {
    const a = this.#approval;
    this.stopApproval();
    this.#code = null;
    this.#plan = null;
    this.signin.forget();
    this.set({ at: "failed", failure: f.code === "locked" ? { code: "locked_out" } : f });
    await a?.cancel().catch(() => undefined);
    await giveBack(this.kit);
  }
}
