// Revoking another device (SYNC-DESIGN §3.10, §6 O10). In this order:
//   1. the click asks Chrome first (manage.ts); the master password (pw_auth), checked by the pre-send check, which also
//      tells whether the current key bundle is the one that device wrote;
//   2. the reason, chosen by the user (none is preselected): "I still control it" (a profile no longer used) revokes it;
//      "lost, stolen or not sure" revokes it and rotates the keys (§3.8), so that it sees nothing changed after and a
//      recovery code it may have planted stops working. When the device wrote the current keys, only the second is
//      offered. The devices it approved are listed beside it, ticked, to be revoked with it;
//   3. "lost": the rotation is prepared and its new recovery code shown and typed back (A4) before anything is revoked,
//      where it can be, so that Cancel, a lock or a failure on those steps leaves nothing done. Then, in one run: the
//      rotation is recorded as owed (engine noteRotationOwed, written first), the devices are revoked (§3.10: it cuts
//      the device off at once), and the rotation is sent. Revoking is never blocked (§3.14): when the rotation cannot be
//      prepared (a round that is not "ok", a review waiting, an update the server requires, the server's keys behind,
//      a cleanup due), the devices are revoked at once all the same, the rotation recorded as owed with why it waits
//      ("owed"). A run that stops between the revocation and the rotation (a refusal, a lock, the page closing) leaves
//      the owed rotation recorded: the Sync section's card says so and offers it until a rotation is in effect, and this
//      flow's end says it too ("rotation_owed");
//   4. then the list of what a revocation cannot undo (the 2FA secrets that device has seen) and the advice to change
//      the master password too.
// "unconfirmed" (the rotation's answer lost) keeps both codes, as the key operations say theirs (keyops.ts).
import {
  commitRotation,
  failureOf,
  noteRotationOwed,
  prepareRotation,
  revokeDevice,
  revokeNeedsProtect,
  type Failure,
  type OwedRotation,
  type PreparedRotation,
  type SyncKit,
} from "./gateway";
import { ManageFlow } from "./manage";
import { fixable } from "./model";
import { groupsMatch, pickGroups } from "./recovery";

export type RevokeTarget = { id: string; name: string | null };
export type RevokeReason = "retired" | "lost";

export type RevokeState =
  | { at: "asking" }
  | { at: "password"; failure?: Failure; busy?: boolean }
  | {
      at: "reason";
      reason: RevokeReason | null;
      protectOnly: boolean;
      ticked: string[];
      failure?: Failure;
      busy?: boolean;
    }
  | { at: "show"; code: string }
  | { at: "confirm"; code: string; groups: [number, number]; wrong?: boolean; busy?: boolean }
  | { at: "done"; reason: RevokeReason; revoked: number }
  | { at: "unconfirmed"; revoked: number }
  /** "Lost": revoked without the rotation, which could not be prepared (`waits`, a failure code): it is owed. */
  | { at: "owed"; revoked: number; waits: string };

export class RevokeFlow extends ManageFlow<RevokeState> {
  #password: string | null = null;
  #rotation: PreparedRotation | null = null;
  /** The devices to revoke, chosen on the reason step (the target first). */
  #ids: string[] = [];
  #revoked = 0;
  /** This run revoked for "lost" and the rotation is not in effect: its end says so (end()). */
  #owed = false;

  /** `approved`: the devices `target` approved, still active (listed with it, ticked). */
  constructor(
    kit: SyncKit,
    readonly target: RevokeTarget,
    readonly approved: readonly RevokeTarget[],
    private readonly o: { random?: () => number } = {},
  ) {
    super(kit, { at: "asking" }, ["done", "unconfirmed", "owed"]);
  }

  protected clear(): void {
    this.#password = null;
    this.#rotation = null;
  }

  /** How many devices this run revoked (a failure after the first says so). */
  get revoked(): number {
    return this.#revoked;
  }

  start(granted: Promise<boolean>): Promise<void> {
    this.#revoked = 0;
    this.#owed = false;
    return this.opened(granted, () => this.set({ at: "password" }));
  }

  async submitPassword(password: string): Promise<void> {
    const s = this.state;
    if (s.at !== "password" || s.busy || !password) return;
    const run = this.epoch;
    this.set({ at: "password", busy: true });
    let protectOnly: boolean;
    try {
      protectOnly = await revokeNeedsProtect(this.kit.engine, this.target.id, password);
    } catch (e) {
      if (!this.live(run)) return;
      const f = failureOf(e);
      if (f.code === "locked" || this.lockedOut) return this.end(f);
      if (fixable(f)) return this.set({ at: "password", failure: f });
      return this.end(f);
    }
    if (!this.live(run)) return;
    this.#password = password;
    this.set({
      at: "reason",
      reason: protectOnly ? "lost" : null,
      protectOnly,
      ticked: this.approved.map((d) => d.id),
    });
  }

  setReason(reason: RevokeReason): void {
    const s = this.state;
    if (s.at === "reason" && !s.busy && !(s.protectOnly && reason === "retired"))
      this.set({ ...s, reason, failure: undefined });
  }

  toggle(id: string): void {
    const s = this.state;
    if (s.at !== "reason" || s.busy || !this.approved.some((d) => d.id === id)) return;
    this.set({ ...s, ticked: s.ticked.includes(id) ? s.ticked.filter((x) => x !== id) : [...s.ticked, id] });
  }

  /**
   * "Still mine": revoke now. "Lost": prepare the rotation and show its code first (nothing revoked yet); when it cannot
   * be prepared, revoke now all the same, with the rotation recorded as owed.
   */
  async confirm(): Promise<void> {
    const s = this.state;
    const pw = this.#password;
    if (s.at !== "reason" || s.busy || pw === null) return;
    if (s.reason === null) return this.set({ ...s, failure: { code: "choose_reason" } });
    const run = this.epoch;
    this.#ids = [this.target.id, ...s.ticked];
    this.set({ ...s, busy: true, failure: undefined });
    if (s.reason === "retired") {
      if (!(await this.revokeAll(run))) return;
      if (this.lockedOut) return this.end({ code: "locked_out" }); // revoked all the same: the end says how many
      this.clear();
      return this.set({ at: "done", reason: "retired", revoked: this.#revoked });
    }
    try {
      this.#rotation = await prepareRotation(this.kit.engine, pw);
    } catch (e) {
      if (!this.live(run)) return;
      const f = failureOf(e);
      if (f.code === "locked" || this.lockedOut) return this.end(f); // nothing revoked: said as it is
      if (f.code === "wrong_secret") return this.set({ ...s, busy: false, failure: f });
      return this.revokeOwing(run, f.code); // the revocation does not wait for the rotation (§3.14: never blocked)
    }
    if (!this.live(run)) return;
    this.set({ at: "show", code: this.#rotation.recoveryCode });
  }

  saved(): void {
    const s = this.state;
    if (s.at === "show") this.set({ at: "confirm", code: s.code, groups: pickGroups(this.o.random) });
  }

  showAgain(): void {
    const s = this.state;
    if (s.at === "confirm" && !s.busy) this.set({ at: "show", code: s.code });
  }

  /** The code typed back: the rotation recorded as owed, the devices revoked, then the rotation sent. */
  async confirmGroups(typed: [string, string]): Promise<void> {
    const s = this.state;
    const h = this.#rotation;
    if (s.at !== "confirm" || s.busy || !h) return;
    if (!groupsMatch(s.code, s.groups, typed)) return this.set({ ...s, wrong: true });
    const run = this.epoch;
    this.set({ ...s, wrong: false, busy: true });
    let owed: OwedRotation;
    try {
      owed = await this.write(noteRotationOwed(this.kit.engine, { targets: this.#ids }));
    } catch (e) {
      if (this.live(run) || this.lockedOut) this.end(failureOf(e));
      return;
    }
    if (!(await this.revokeAll(run, owed))) return;
    if (this.lockedOut) return this.end({ code: "locked_out" }); // revoked; the rotation needs the open vault (end() says it is owed)
    try {
      await this.write(commitRotation(this.kit.engine, h));
    } catch (e) {
      if (!this.live(run) && !this.lockedOut) return;
      const f = failureOf(e);
      this.kit.changed();
      this.clear();
      if (f.code === "unconfirmed") return this.set({ at: "unconfirmed", revoked: this.#revoked });
      if (f.code !== "committed_on_server") return this.end(f);
    }
    this.#owed = false;
    if (!this.live(run) && !this.lockedOut) return;
    this.clear();
    this.kit.changed();
    this.set({ at: "done", reason: "lost", revoked: this.#revoked });
  }

  /** "Lost" when the rotation cannot be prepared: the rotation recorded as owed (and why), then the devices revoked. */
  private async revokeOwing(run: number, waits: string): Promise<void> {
    let owed: OwedRotation;
    try {
      owed = await this.write(noteRotationOwed(this.kit.engine, { targets: this.#ids, waits }));
    } catch (e) {
      if (this.live(run) || this.lockedOut) this.end(failureOf(e));
      return;
    }
    if (!(await this.revokeAll(run, owed))) return;
    if (this.lockedOut) return this.end({ code: "locked_out" }); // end() says the rotation is owed
    this.clear();
    this.set({ at: "owed", revoked: this.#revoked, waits });
  }

  /**
   * The devices, the target first. False when the run ended here (a refusal, or the run replaced): with nothing revoked
   * the owed rotation recorded for this run is undone; with one or more revoked on the "lost" way it stays, and says so.
   */
  private async revokeAll(run: number, owed?: OwedRotation): Promise<boolean> {
    const pw = this.#password;
    if (pw === null) return false;
    try {
      for (const id of this.#ids) {
        const after = await this.write(revokeDevice(this.kit.engine, id, pw));
        this.#revoked++;
        if (owed) {
          this.#owed = true;
          await owed.revoked(after).catch(() => undefined); // the record says a device went (the card may say so)
        }
      }
    } catch (e) {
      this.kit.changed();
      const f = failureOf(e);
      // a refusal before any revocation: nothing to rotate for; a lost answer may have revoked it: the record stays
      if (owed && this.#revoked === 0 && f.code !== "unconfirmed") await owed.undo().catch(() => undefined);
      else if (owed) this.#owed = true;
      if (this.live(run) || this.lockedOut) this.end(f);
      return false;
    }
    this.kit.changed();
    return this.live(run) || this.lockedOut;
  }

  /** An end with the device revoked for "lost" and the keys not rotated says that above all (the card offers the rotation). */
  protected override end(f: Failure): void {
    if (!this.#owed) return super.end(f);
    this.clear();
    this.set({ at: "failed", failure: { code: "rotation_owed" } }); // over a lock too: the more important news
  }
}
