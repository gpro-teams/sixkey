// "Repair the cloud from this device" (SYNC-DESIGN §4.2, §3.9 R1, N24, N27; §6 O12 keys_behind and server_older_key): the
// server's keys are older than this device's (a backup restored on the server, maybe to before a rotation, or a device
// that published behind the others), and this device publishes its own keys again so that every device takes them. The
// user gives the master password that opens the server's older keys (it may be an older password), the current one (it
// opens this device's keys) and this device's recovery code, typed (I9: never stored; both checked before anything is
// sent). The form names the devices the repair revokes again first (the revocations a restore of the server undid), and
// the repair revokes no other. The key operations wait until it is done.
import { failureOf, repairKeys, revokedBeforeRestore, type Failure, type SyncKit } from "./gateway";
import { ManageFlow } from "./manage";
import { fixable } from "./model";

/** A device the repair will revoke again before it sends its keys (a revocation the server's restore undid). */
export type AgainRow = { id: string; name: string | null };

export type RepairState =
  | { at: "asking" }
  | { at: "form"; again: readonly AgainRow[]; failure?: Failure; busy?: boolean }
  | { at: "done" }
  | { at: "unconfirmed" };

export class RepairFlow extends ManageFlow<RepairState> {
  constructor(kit: SyncKit) {
    super(kit, { at: "asking" }, ["done", "unconfirmed"]);
  }

  protected clear(): void {}

  start(granted: Promise<boolean>): Promise<void> {
    return this.opened(granted, () => this.#form());
  }

  /**
   * The form, with the devices the repair will revoke again (engine devices.ts revokedBeforeRestore: the rule the repair
   * applies), named before the click; `failure`: what the last try said.
   */
  async #form(failure?: Failure): Promise<void> {
    const run = this.epoch;
    let again: AgainRow[];
    try {
      again = (await revokedBeforeRestore(this.kit.engine)).map((r) => ({ id: r.id, name: r.name }));
    } catch (e) {
      if (this.live(run)) this.end(failureOf(e));
      return;
    }
    if (!this.live(run)) return;
    this.set({ at: "form", again, ...(failure ? { failure } : {}) });
  }

  /** `oldPassword`: the one the server's keys open (the current one when it did not change); `password`: the current one. */
  async submit(o: { oldPassword: string; password: string; recoveryCode: string }): Promise<void> {
    const s = this.state;
    if (s.at !== "form" || s.busy) return;
    const run = this.epoch;
    this.set({ ...s, busy: true });
    try {
      await this.write(
        repairKeys(this.kit.engine, {
          oldPassword: o.oldPassword || o.password,
          password: o.password,
          recoveryCode: o.recoveryCode,
          revokeAgain: s.again.map((r) => r.id),
        }),
      );
    } catch (e) {
      if (!this.live(run) && !this.lockedOut) return;
      const f = failureOf(e);
      this.kit.changed();
      if (f.code === "unconfirmed") return this.set({ at: "unconfirmed" });
      if (f.code === "committed_on_server") return this.set({ at: "done" });
      if (this.lockedOut || f.code === "locked") return this.end(f);
      // the devices to revoke again are not those the form showed: the form again, with the list as it is now
      if (f.code === "stale") return this.#form(f);
      // fixed on the same form: a typo, the recovery code, or the password the server's older keys use
      if (fixable(f) || f.code === "invalid_recovery_code" || f.code === "old_password_required")
        return this.set({ at: "form", again: s.again, failure: f });
      return this.end(f);
    }
    if (!this.live(run) && !this.lockedOut) return;
    this.kit.changed();
    this.set({ at: "done" });
  }
}
