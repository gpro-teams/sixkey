// Turning sync on in this profile: the first device of an account (SYNC-DESIGN §3.1; §6 O1–O3). In this order:
//   1. the click asks Chrome for the API permission (permission.ts: the handler's first statement); declined, nothing
//      changes and the flow says why sync needs it;
//   2. the master password, once (it proves the user knows it, and the server's password check is made from it, H1);
//   3. the email and its one-time code (signin.ts): the account session, in memory only;
//   4. GET /v1/account: an account that already has a vault is joined instead (join.ts takes over with the same session
//      and the permission, §3.5's warning first);
//   5. this device's name (§2.4, the rules of N28);
//   6. the recovery code (I9, not skippable): typed and checked against this profile's own keyring, or made new, shown,
//      and confirmed by typing back two of its groups, and only then written (show before commit). From that moment the
//      old code no longer opens this profile, whatever happens next; the screen says so;
//   7. the first upload (enroll.ts firstUpload): "done" (the first round follows at once), "unconfirmed" (the next round
//      asks the server, D4: never reported as a failure), "vault_exists" (another device got there first: join it),
//      "keyring_changed" (a key change in another tab: start again).
// The API permission is kept only for "done" and "unconfirmed"; every other outcome, a cancel included, gives it back at
// once (permission.ts). A failure the user can fix on the spot (a wrong password, code or recovery code, an expired
// sign-in) keeps the flow, and the permission, open. Secrets (the password, the recovery code) are held in this object
// only between the step that takes them and the upload, and dropped at every end.
// A lock of Sixkey (lock.ts) ends the flow at once, the secrets dropped, the new code no longer on screen. While a write
// is under way (the new code being written, the upload) the lock waits for it: the engine checks the lock itself (a
// locked page cannot write the code, and the upload needs the key), and the write's outcome is what the flow reports.
// Nothing gives the permission back while a write is under way (cancel and the page closing wait for it): its outcome
// may be that sync is on, which needs the permission.
import { SignIn } from "./signin";
import { accountOf, type VaultInfo } from "./account";
import {
  checkDeviceName,
  commitRecovery,
  failureOf,
  firstUpload,
  prepareRecovery,
  recoveryOpensLocal,
  type DeviceNameProblem,
  type Failure,
  type MergeAnswer,
  type PreparedRecovery,
  type SyncKit,
} from "./gateway";
import { fixable } from "./model";
import { giveBack, settlePermission } from "./permission";
import { groupsMatch, pickGroups } from "./recovery";
import type { Blocked } from "./review";
import { Store } from "./store";

export type EnableState =
  | { at: "asking" }
  | { at: "declined" }
  | { at: "password"; failure?: Failure; busy?: boolean }
  | { at: "signin" }
  | { at: "checking"; failure?: Failure }
  | { at: "exists"; info: VaultInfo }
  | { at: "name"; name: string; problem?: DeviceNameProblem }
  | { at: "recovery"; mode: "choose"; failure?: Failure; busy?: boolean }
  | { at: "recovery"; mode: "enter"; failure?: Failure; busy?: boolean }
  | { at: "recovery"; mode: "show"; code: string }
  | {
      at: "recovery";
      mode: "confirm";
      code: string;
      groups: [number, number];
      wrong?: boolean;
      busy?: boolean;
      failure?: Failure;
    }
  | { at: "uploading" }
  | { at: "review"; blocked: Blocked }
  | { at: "done" }
  | { at: "unconfirmed" }
  | { at: "vault_exists"; newCode: boolean }
  | { at: "failed"; failure: Failure; newCode?: boolean }
  | { at: "closed" };

/** The outcomes after which sync is on, or will be once the next round confirms it (permission.ts KEPT_OUTCOMES). */
export type EnableOutcome = "done" | "unconfirmed";

/** The states in which the flow is over: nothing it holds is secret, and a lock changes nothing. */
const OVER: ReadonlySet<EnableState["at"]> = new Set([
  "declined",
  "done",
  "unconfirmed",
  "vault_exists",
  "failed",
  "closed",
]);

export class EnableFlow extends Store<EnableState> {
  readonly signin: SignIn;
  #password: string | null = null;
  #code: string | null = null;
  #name = "";
  #prepared: PreparedRecovery | null = null;
  #newCode = false;
  /** The sign-in went to the join flow (handOver): it is that flow's from then on. */
  #handedOver = false;
  /** The write under way (the new code, the upload), if any: nothing gives the permission back before it ends. */
  #writing: Promise<unknown> | null = null;
  /** The upload has started: from then on its outcome, not this flow, decides whether sync is on. */
  #uploadStarted = false;
  /** Sixkey locked while a write was under way: the flow ends once it does. */
  #lockedOut = false;
  /** What this flow held went to another flow (handOver, retire): nothing of it is this flow's to give back any more. */
  #passedOn = false;
  #unsub: () => void;

  /** `random`: for the two groups to type back (tests pass a fixed one). `onSyncOn`: the flow ended with sync on, and how. */
  constructor(
    private readonly kit: SyncKit,
    private readonly o: { onSyncOn?: (outcome: EnableOutcome) => void; random?: () => number } = {},
  ) {
    super({ at: "asking" });
    this.signin = new SignIn(kit);
    this.#unsub = this.signin.subscribe(() => {
      if (this.state.at === "signin" && this.signin.state.at === "in") void this.checkAccount();
    });
  }

  /** Step 1, from the click (permission.ts asking): the answer to Chrome's prompt. */
  async start(granted: Promise<boolean>): Promise<void> {
    const run = this.bump();
    this.reset();
    this.#lockedOut = false;
    this.#uploadStarted = false;
    this.set({ at: "asking" });
    let ok = false;
    try {
      ok = await granted;
    } catch {
      ok = false; // not asked (no gesture, or the browser refused): the same as declined, nothing granted
    }
    if (!this.live(run)) {
      // answered after the flow ended (a lock or a cancel while Chrome's prompt was open): a grant has no flow to serve.
      // A run superseded by a newer one (Ask again, clicked twice) leaves it to that run.
      if (ok && OVER.has(this.state.at) && !this.#passedOn) await giveBack(this.kit);
      return;
    }
    this.set(ok ? { at: "password" } : { at: "declined" });
  }

  /** Step 2: the master password (VaultService.verifyPassword: a wrong one is refused and recorded, H6). */
  async submitPassword(password: string): Promise<void> {
    if (this.state.at !== "password" || this.state.busy) return;
    const run = this.epoch;
    this.set({ at: "password", busy: true });
    try {
      await this.kit.service.verifyPassword(password);
    } catch (e) {
      if (this.live(run)) this.fail(failureOf(e), { at: "password" });
      return;
    }
    if (!this.live(run)) return;
    this.#password = password;
    this.set({ at: "signin" });
  }

  /** Step 4: the account's vault, if any (the sign-in moves here by itself). */
  async checkAccount(): Promise<void> {
    const session = this.signin.session;
    if (!session || (this.state.at !== "signin" && this.state.at !== "checking")) return;
    const run = this.epoch;
    this.set({ at: "checking" });
    try {
      const a = await accountOf(this.kit, session);
      if (!this.live(run)) return;
      if (a.hasVault) return this.set({ at: "exists", info: a.info });
      // a sign-in repeated because the session expired at the upload: the name and the code are still here
      if (this.#code !== null && this.#name !== "") return this.upload();
      this.set({ at: "name", name: this.#name });
    } catch (e) {
      if (!this.live(run)) return;
      const f = failureOf(e);
      if (f.code === "session_invalid") {
        this.signin.again(f);
        this.set({ at: "signin" });
      } else this.set({ at: "checking", failure: f });
    }
  }

  /** Step 5: this device's name, as other devices will list it (§2.4). */
  submitName(name: string): void {
    if (this.state.at !== "name") return;
    const c = checkDeviceName(name);
    if (!c.ok) return this.set({ at: "name", name, problem: c.problem });
    this.#name = c.name;
    this.set({ at: "recovery", mode: "choose" });
  }

  /** Step 6 (a): the user has the recovery code. */
  enterCode(): void {
    if (this.state.at === "recovery") this.set({ at: "recovery", mode: "enter" });
  }

  /** Step 6 (a): the typed code must open this profile's own keyring (nothing is written). */
  async submitCode(code: string): Promise<void> {
    if (this.state.at !== "recovery" || this.state.mode !== "enter" || this.state.busy) return;
    const run = this.epoch;
    this.set({ at: "recovery", mode: "enter", busy: true });
    let ok = false;
    try {
      ok = await recoveryOpensLocal(this.kit, code);
    } catch (e) {
      if (this.live(run)) this.fail(failureOf(e), { at: "recovery", mode: "enter" });
      return;
    }
    if (!this.live(run)) return;
    if (!ok) return this.set({ at: "recovery", mode: "enter", failure: { code: "recovery_not_local" } });
    this.#code = code;
    await this.upload();
  }

  /** Step 6 (b): a new code, made in memory and shown; nothing is written yet. */
  async newCode(): Promise<void> {
    if (this.state.at !== "recovery" || this.state.mode !== "choose" || this.state.busy || !this.#password) return;
    const run = this.epoch;
    this.set({ at: "recovery", mode: "choose", busy: true });
    try {
      const p = await prepareRecovery(this.kit, this.#password);
      if (!this.live(run)) return;
      this.#prepared = p;
      this.set({ at: "recovery", mode: "show", code: p.recoveryCode });
    } catch (e) {
      if (this.live(run)) this.fail(failureOf(e), { at: "recovery", mode: "choose" });
    }
  }

  /** The user says the new code is saved: two of its groups, typed back, prove it before it is written. */
  saved(): void {
    const s = this.state;
    if (s.at === "recovery" && s.mode === "show")
      this.set({ at: "recovery", mode: "confirm", code: s.code, groups: pickGroups(this.o.random) });
  }

  /** Back to the code, to read it again. */
  showAgain(): void {
    const s = this.state;
    if (s.at === "recovery" && s.mode === "confirm" && !s.busy)
      this.set({ at: "recovery", mode: "show", code: s.code });
  }

  /** The two groups typed back: right, the new code is written (the old one stops working), then the upload. */
  async confirmGroups(typed: [string, string]): Promise<void> {
    const s = this.state;
    if (s.at !== "recovery" || s.mode !== "confirm" || s.busy || !this.#prepared) return;
    if (!groupsMatch(s.code, s.groups, typed)) return this.set({ ...s, wrong: true });
    const run = this.epoch;
    this.set({ ...s, wrong: false, busy: true });
    try {
      await this.write(commitRecovery(this.kit, this.#prepared));
    } catch (e) {
      if (this.live(run)) this.fail(failureOf(e), { at: "recovery", mode: "choose" });
      return;
    }
    if (!this.live(run)) return;
    this.#newCode = true;
    this.#prepared = null;
    if (this.#lockedOut) return this.end({ code: "locked_out" }); // written before the lock: the new code is in effect
    this.#code = s.code;
    await this.upload();
  }

  /** Step 7, and again with the user's answer when the guard stopped the fold of an unfinished first upload's undo. */
  async upload(answer?: MergeAnswer): Promise<void> {
    const session = this.signin.session;
    if (!session || !this.#password || !this.#code) return;
    const run = this.epoch;
    this.set({ at: "uploading" });
    this.#uploadStarted = true;
    let r;
    try {
      r = await this.write(
        firstUpload(this.kit.engine, {
          session,
          password: this.#password,
          recoveryCode: this.#code,
          deviceName: this.#name,
          email: this.signin.email,
          ...(answer ? { answer } : {}),
        }),
      );
    } catch (e) {
      if (!this.live(run)) return;
      const f = failureOf(e);
      // an expired sign-in: sign in again, then the upload goes on with what was given (checkAccount)
      if (f.code === "session_invalid") {
        this.signin.again(f);
        return this.set({ at: "signin" });
      }
      if (f.blocked && !this.#lockedOut) return this.set({ at: "review", blocked: f.blocked });
      // anything else ends it, including a lock (the key is gone) and a password or code that no longer opens this
      // profile (its keys changed in another tab since they were checked): start again
      return this.end(f.code === "locked" || this.#lockedOut ? { code: "locked_out" } : f);
    }
    if (!this.live(run)) return;
    if (r.kind === "done" || r.kind === "unconfirmed") {
      this.clear();
      this.set({ at: r.kind });
      this.kit.changed();
      this.o.onSyncOn?.(r.kind);
      return;
    }
    if (r.kind === "vault_exists") {
      const newCode = this.#newCode;
      this.clear();
      await settlePermission(this.kit, "vault_exists"); // revision 23: a result, not an exception, and it gives it back
      if (this.live(run)) this.set({ at: "vault_exists", newCode });
      return;
    }
    await this.end({ code: "keyring_changed" });
  }

  /**
   * Step 4's other way: this email has a vault, and the user chose to join it. The sign-in goes to the join flow with the
   * permission (neither is given back here); this flow is over.
   */
  handOver(): SignIn {
    this.bump();
    this.#password = null;
    this.#code = null;
    this.#prepared = null;
    this.#handedOver = true;
    this.#passedOn = true;
    this.set({ at: "closed" });
    return this.signin;
  }

  /**
   * The user cancelled (or the page is closing, or the section went away): the secrets dropped, then the permission back.
   * Nothing goes on to a next step, and a write under way is waited for before the permission is decided: an upload
   * that turned sync on keeps it (giveBack sees sync on).
   */
  async cancel(): Promise<void> {
    this.bump(); // nothing this flow started goes on to a next step
    const was = this.state.at;
    this.clear();
    this.set({ at: "closed" });
    const writing = this.#writing;
    if (writing) await writing.catch(() => undefined);
    // after "done" or "unconfirmed" sync is on, and leaving the screen changes nothing; after "closed" (handed over to the
    // join, or cancelled already) the permission is not this flow's any more
    if (was !== "done" && was !== "unconfirmed" && was !== "closed") await settlePermission(this.kit, "cancelled");
  }

  /**
   * The page is going away (pagehide): whether the permission can be given back right now, before anything is awaited
   * (a closing page may not get to the end of cancel). Only while this flow holds it for itself and nothing it started
   * can have turned sync on: not handed over, not ended with sync on, no upload started. The caller removes it, then
   * cancels.
   */
  leaving(): boolean {
    return !this.#handedOver && !this.#uploadStarted && this.#writing === null && !OVER.has(this.state.at);
  }

  /** Sixkey locked (lock.ts): see the top of this file. */
  async locked(): Promise<void> {
    if (OVER.has(this.state.at)) return;
    this.#lockedOut = true;
    if (this.#writing) return; // the write's own continuation ends the flow
    this.bump();
    await this.end({ code: "locked_out" });
  }

  /**
   * Another flow takes this one's place (a join, after "vault_exists"): this one stops, its secrets dropped. The
   * permission is left as it is: the new flow's own click has just asked for it.
   */
  retire(): void {
    this.bump();
    this.#passedOn = true;
    this.clear();
    if (!OVER.has(this.state.at)) this.set({ at: "closed" });
  }

  /** The page is done with this flow (unmounted): nothing kept. */
  dispose(): void {
    this.#unsub();
  }

  /** A write: tracked until it ends, so that nothing gives the permission back meanwhile. */
  private async write<T>(p: Promise<T>): Promise<T> {
    const tracked = p.finally(() => {
      if (this.#writing === tracked) this.#writing = null;
    });
    this.#writing = tracked;
    return tracked;
  }

  /** A failure: fixable ones stay on `stay`; the others end the flow (a lock among them: the key is gone). */
  private fail(f: Failure, stay: EnableState): void {
    if (f.code === "locked" || this.#lockedOut) void this.end({ code: "locked_out" });
    else if (fixable(f) || f.code === "otp_format") this.set({ ...stay, failure: f } as EnableState);
    else void this.end(f);
  }

  /** The flow ended without turning sync on: the secrets dropped, then the permission back (permission.ts). */
  private async end(f: Failure): Promise<void> {
    const newCode = this.#newCode;
    this.clear();
    this.set({ at: "failed", failure: f, ...(newCode ? { newCode } : {}) });
    await giveBack(this.kit);
  }

  private clear(): void {
    this.#password = null;
    this.#code = null;
    this.#prepared = null;
    if (!this.#handedOver) this.signin.forget();
  }

  private reset(): void {
    this.clear();
    this.#newCode = false;
    this.#name = "";
  }
}
