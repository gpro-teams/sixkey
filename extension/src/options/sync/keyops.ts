// The key operations with sync on, in the Sync section (SYNC-DESIGN §3.6–§3.8, §3.6.0, §3.3 step 5; §6 O7, O10, O11).
// With sync on, Phase 0's own key changes are refused (sync_on, §0.0i item 18); these are their sync forms, through the
// engine (keys.ts), server first and then local:
//   - "password": the old and the new master password (the new one checked like everywhere, §3.6.1 step 1), and the tick
//     "I'm worried the old password leaked: rotate the keys too" (F13b), which goes on to a rotation with the new one;
//   - "recovery": a new recovery code (§3.7);
//   - "rotate": new keys (§3.8), with a new recovery code;
//   - "reset": a new master password set with the recovery code (§3.3 step 5: after a recovery-code join, for a user who
//     forgot the password), with a new recovery code in the same update.
// A new recovery code is shown before anything is sent and typed back (two of its groups) before it is (A4, §0.0i item
// 14). Every operation needs the network, and none runs while the server's keys are behind this device's (keys_behind,
// N27: the card offers the repair first). What the screen says at the end is the engine's outcome: "unconfirmed" keeps
// both codes until a later round tells (§3.6.0), "changed elsewhere" says the code shown is void.
import {
  changePassword,
  commitRecoveryCode,
  commitRecoveryReset,
  commitRotation,
  failureOf,
  prepareRecoveryCode,
  prepareRecoveryReset,
  prepareRotation,
  type Failure,
  type PreparedCode,
  type PreparedRecoveryReset,
  type PreparedRotation,
  type SyncKit,
} from "./gateway";
import { ManageFlow } from "./manage";
import { fixable } from "./model";
import { groupsMatch, pickGroups } from "./recovery";

export type KeyOpKind = "password" | "recovery" | "rotate" | "reset";

export type KeyOpState =
  | { at: "asking" }
  /** The secrets the operation asks for: the password (old and new for "password"), or the recovery code and a new password ("reset"). */
  | { at: "form"; failure?: Failure; busy?: boolean }
  | { at: "show"; code: string }
  | { at: "confirm"; code: string; groups: [number, number]; wrong?: boolean; busy?: boolean; failure?: Failure }
  | { at: "done"; passwordChanged: boolean; newCode: boolean }
  | { at: "unconfirmed"; newCode: boolean };

type Prepared =
  | { kind: "recovery"; h: PreparedCode }
  | { kind: "rotate"; h: PreparedRotation }
  | { kind: "reset"; h: PreparedRecoveryReset };

export class KeyOpFlow extends ManageFlow<KeyOpState> {
  #prepared: Prepared | null = null;
  #passwordChanged = false;

  /** `random`: for the two groups to type back (tests pass a fixed one). */
  constructor(
    kit: SyncKit,
    readonly kind: KeyOpKind,
    private readonly o: { random?: () => number } = {},
  ) {
    super(kit, { at: "asking" }, ["done", "unconfirmed"]);
  }

  protected clear(): void {
    this.#prepared = null;
  }

  /** The master password was changed by this run (the "password" kind's first step), whatever came after it. */
  get passwordChanged(): boolean {
    return this.#passwordChanged;
  }

  start(granted: Promise<boolean>): Promise<void> {
    this.#passwordChanged = false;
    return this.opened(granted, () => this.set({ at: "form" }));
  }

  /**
   * The form's secrets. "password": `password` is the old one, `newPassword` the new, `rotate` the tick. "recovery",
   * "rotate": `password`. "reset": `recoveryCode` and `newPassword`.
   */
  async submit(o: { password?: string; newPassword?: string; rotate?: boolean; recoveryCode?: string }): Promise<void> {
    const s = this.state;
    if (s.at !== "form" || s.busy) return;
    const run = this.epoch;
    this.set({ at: "form", busy: true });
    try {
      if (this.kind === "password") {
        if (!o.password || !o.newPassword) return this.set({ at: "form", failure: { code: "wrong_secret" } });
        await this.write(changePassword(this.kit.engine, o.password, o.newPassword));
        if (!this.live(run) && !this.lockedOut) return;
        this.#passwordChanged = true;
        this.kit.changed();
        if (this.lockedOut) return this.end({ code: "locked_out" });
        if (!o.rotate) return this.set({ at: "done", passwordChanged: true, newCode: false });
        this.#prepared = { kind: "rotate", h: await prepareRotation(this.kit.engine, o.newPassword) };
      } else if (this.kind === "recovery") {
        this.#prepared = { kind: "recovery", h: await prepareRecoveryCode(this.kit.engine, o.password ?? "") };
      } else if (this.kind === "rotate") {
        this.#prepared = { kind: "rotate", h: await prepareRotation(this.kit.engine, o.password ?? "") };
      } else {
        this.#prepared = {
          kind: "reset",
          h: await prepareRecoveryReset(this.kit.engine, {
            recoveryCode: o.recoveryCode ?? "",
            newPassword: o.newPassword ?? "",
          }),
        };
      }
    } catch (e) {
      if (!this.live(run)) return;
      const f = failureOf(e);
      // the password changed and the rotation could not be prepared: the change stands (passwordChanged says so)
      if (this.#passwordChanged || f.code === "locked" || this.lockedOut) return this.end(f);
      if (fixable(f) || f.code === "weak_password") return this.set({ at: "form", failure: f });
      return this.end(f);
    }
    if (!this.live(run)) return;
    this.set({ at: "show", code: this.#prepared.h.recoveryCode });
  }

  /** The new code is saved: two of its groups, typed back, prove it before anything is sent. */
  saved(): void {
    const s = this.state;
    if (s.at === "show") this.set({ at: "confirm", code: s.code, groups: pickGroups(this.o.random) });
  }

  /** Back to the code, to read it again. */
  showAgain(): void {
    const s = this.state;
    if (s.at === "confirm" && !s.busy) this.set({ at: "show", code: s.code });
  }

  /** The groups typed back: right, the operation is sent; its outcome is what the screen says. */
  async confirmGroups(typed: [string, string]): Promise<void> {
    const s = this.state;
    const p = this.#prepared;
    if (s.at !== "confirm" || s.busy || !p) return;
    if (!groupsMatch(s.code, s.groups, typed)) return this.set({ ...s, wrong: true });
    const run = this.epoch;
    this.set({ ...s, wrong: false, busy: true });
    try {
      if (p.kind === "recovery") await this.write(commitRecoveryCode(this.kit.engine, p.h));
      else if (p.kind === "rotate") await this.write(commitRotation(this.kit.engine, p.h));
      else await this.write(commitRecoveryReset(this.kit.engine, p.h));
    } catch (e) {
      if (!this.live(run) && !this.lockedOut) return;
      const f = failureOf(e);
      this.kit.changed();
      if (f.code === "unconfirmed") {
        this.clear();
        return this.set({ at: "unconfirmed", newCode: true }); // §3.6.0: keep both codes until a round tells
      }
      if (f.code === "committed_on_server") return this.finish(); // in effect; this device takes it on its next round
      return this.end(f);
    }
    if (!this.live(run) && !this.lockedOut) return;
    this.finish();
  }

  private finish(): void {
    this.clear();
    this.kit.changed();
    this.set({ at: "done", passwordChanged: this.#passwordChanged || this.kind === "reset", newCode: true });
  }
}
