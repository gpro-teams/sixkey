// Two flows that change what this profile is in the sync account (SYNC-DESIGN §4.10, §3.12; §6 O12 forked, O14):
//   - ForkFlow, "make this profile a separate device": this profile looks like a copy of another one (a clone, a
//     vendor's sync); with the master password and a name, it becomes a device of its own (engine keys.ts forkDevice).
//     The other copy keeps the original identity; the forked notice also offers revoking it from here (the device list).
//   - DeleteFlow, "delete the sync account": the account's vault, history and devices on the server, for every device;
//     the local data of every device stays. It needs a fresh one-time code (an account session) and the master password,
//     besides this device's signature (§3.12); then this device removes its own sync identity (as "remove sync
//     identity" does) and gives the API permission back, last.
import {
  checkDeviceName,
  deleteSyncAccount,
  dropPermission,
  failureOf,
  forkDevice,
  removeSyncIdentity,
  type DeviceNameProblem,
  type Failure,
  type SyncKit,
} from "./gateway";
import { ManageFlow } from "./manage";
import { fixable } from "./model";
import { SignIn } from "./signin";

export type ForkState =
  { at: "asking" } | { at: "form"; failure?: Failure; problem?: DeviceNameProblem; busy?: boolean } | { at: "done" };

export class ForkFlow extends ManageFlow<ForkState> {
  constructor(kit: SyncKit) {
    super(kit, { at: "asking" }, ["done"]);
  }

  protected clear(): void {}

  start(granted: Promise<boolean>): Promise<void> {
    return this.opened(granted, () => this.set({ at: "form" }));
  }

  async submit(password: string, name: string): Promise<void> {
    const s = this.state;
    if (s.at !== "form" || s.busy) return;
    const c = checkDeviceName(name);
    if (!c.ok) return this.set({ at: "form", problem: c.problem });
    const run = this.epoch;
    this.set({ at: "form", busy: true });
    try {
      await this.write(forkDevice(this.kit.engine, password, c.name));
    } catch (e) {
      if (!this.live(run) && !this.lockedOut) return;
      const f = failureOf(e);
      if (!this.lockedOut && f.code !== "locked" && fixable(f)) return this.set({ at: "form", failure: f });
      return this.end(f);
    }
    if (!this.live(run) && !this.lockedOut) return;
    this.kit.changed();
    this.set({ at: "done" });
  }
}

export type DeleteState =
  | { at: "asking" }
  | { at: "signin" }
  | { at: "password"; failure?: Failure; busy?: boolean }
  /** `localLeft`: the account is gone, but this device's own sync identity could not be removed (the card offers it). */
  | { at: "done"; localLeft: boolean };

export class DeleteFlow extends ManageFlow<DeleteState> {
  readonly signin: SignIn;
  #unsub: () => void;

  constructor(kit: SyncKit) {
    super(kit, { at: "asking" }, ["done"]);
    this.signin = new SignIn(kit);
    this.#unsub = this.signin.subscribe(() => {
      if (this.state.at === "signin" && this.signin.state.at === "in") this.set({ at: "password" });
    });
  }

  protected clear(): void {
    this.signin.forget();
  }

  start(granted: Promise<boolean>): Promise<void> {
    return this.opened(granted, () => {
      this.signin.again();
      this.set({ at: "signin" });
    });
  }

  async submitPassword(password: string): Promise<void> {
    const s = this.state;
    const session = this.signin.session;
    if (s.at !== "password" || s.busy || !session || !password) return;
    const run = this.epoch;
    this.set({ at: "password", busy: true });
    try {
      await this.write(deleteSyncAccount(this.kit.engine, session, password));
    } catch (e) {
      if (!this.live(run) && !this.lockedOut) return;
      const f = failureOf(e);
      if (f.code === "unconfirmed") return this.end({ code: "delete_unconfirmed" }); // the answer was lost: it may be gone
      // the sign-in expired, or is older than the server allows for this (step_up_required, §3.12): a new code
      if (f.code === "session_invalid" || f.code === "step_up_required") {
        this.signin.again({ code: "session_invalid" });
        return this.set({ at: "signin" });
      }
      if (!this.lockedOut && f.code !== "locked" && fixable(f)) return this.set({ at: "password", failure: f });
      return this.end(f);
    }
    // the account is gone: this device's own identity next, then the permission, last (§3.10's order), whatever the
    // screen does meanwhile (a cancel or a lock after the delete leaves nothing half done that could be finished here)
    let localLeft = false;
    try {
      await this.write(removeSyncIdentity(this.kit.engine));
      await dropPermission(this.kit);
    } catch {
      localLeft = true; // a guard block or a lock: the card's "Remove sync identity" finishes it
    }
    this.clear();
    this.kit.changed();
    if (this.live(run) || this.lockedOut) this.set({ at: "done", localLeft });
  }

  override dispose(): void {
    this.#unsub();
  }
}
