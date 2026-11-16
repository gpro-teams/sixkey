// The Sync section's state and its actions while no flow runs (SYNC-DESIGN §6 O1, O12, P4; §3.10; §4.2; §4.9): what the
// local side and the last round say (gateway.ts readFacts), the rounds this page runs, and the few actions a card
// offers (model.ts ActionId). The engine decides everything; this only calls it and reads what it stored.
//   - Rounds. With sync on and the vault unlocked here, the page runs a round when it opens and at every unlock, unless
//     the last success is under 30 s old or a backoff is running (§4.8: the server's Retry-After and the failure count
//     hold every context back; in "lock every time" only a page with the key can pull, merge and restore a lost
//     identity, M5-NOTES §12 item 5), and on "Sync now" (explicit: also inside a backoff, as the worker allows). Each round is
//     followed by SYNC_CHANGED_MESSAGE (the badge), and by a reload of the page's own state when it merged.
//   - The permission (§4.9). "Allow again" asks Chrome first (permission.ts); a round follows. Turning sync off asks too,
//     in the same click (the revocation needs the network): declined while the permission was withdrawn, the only way
//     left is removing the sync identity on this device only. Both give the permission back last.
//   - A merge the guard stopped (§4.4) is shown for review whatever started it (a round, the fold of kept saves, the
//     turn-off's fold, an adoption), and the same action runs again with the answer. A turn-off whose click granted the
//     permission again (it had been withdrawn) keeps it while its review is open, for the answer's revocation; every way
//     the review closes otherwise (dismissed, replaced, a lock, the tab hidden, the page closing) gives it back.
//   - The master password an action holds for its confirmation (a review, an older key state) is dropped when Sixkey
//     locks or the tab is hidden, and the confirmation with it (the user asks again).
import {
  adoptWithSecret,
  dismissNotices,
  discardKept,
  discardParked,
  dropPermission,
  failureOf,
  foldKeptLocally,
  readFacts,
  removeSyncIdentity,
  resumeFirstUpload,
  turnSyncOff,
  type Failure,
  type KeptVault,
  type MergeAnswer,
  type Notice,
  type ParkedSummary,
  type SyncFacts,
  type SyncKit,
} from "./gateway";
import type { VaultState } from "./model";
import { giveBack } from "./permission";
import type { Blocked } from "./review";
import { Store } from "./store";

/** A round in the background only when the last success is older than this (§4.8). */
export const ROUND_STALE_MS = 30_000;

/** What started a review, so the answer goes back to it. */
export type ReviewFor = "round" | "fold" | "turn_off" | "remove_identity" | "adopt";
export type Doing = "round" | "grant" | "adopt" | "remove_identity" | "turn_off" | "discard" | "check";

export type PanelState = {
  facts: SyncFacts | null;
  /** What is running now (one thing at a time). */
  doing: Doing | null;
  /** The last action's failure, shown with its card. */
  failure: Failure | null;
  /** A merge the guard stopped, waiting for the user's answer (memory only). */
  review: (Blocked & { for: ReviewFor }) | null;
  /** adopt: the server's bundle opens only with an older password: "[use my current one] [adopt anyway]" (§3.9 R3, N27). */
  confirmOlder: boolean;
  /** One line of good news after an action ("Sync turned off", "Keys updated", ...): a key of the sync catalog. */
  done: string | null;
  /** turning off: the API permission was declined while withdrawn; only the local removal is left (§3.10). */
  offlineOnly: boolean;
  /** Counts the times a lock or a hidden tab made the panel forget a password: the view empties its fields with it. */
  forgot: number;
};

export class SyncPanelCtl extends Store<PanelState> {
  /** Between an action that stopped for a confirmation (a turn-off's or an adoption's review, an older key state) and it. */
  #password: string | null = null;
  /** The turn-off's own click granted the API permission (it was withdrawn), and its review holds it for the answer. */
  #heldForReview = false;

  constructor(
    private readonly kit: SyncKit,
    private readonly o: { vault: () => VaultState; reload: () => Promise<void>; now?: () => number },
  ) {
    super({
      facts: null,
      doing: null,
      failure: null,
      review: null,
      confirmOlder: false,
      done: null,
      offlineOnly: false,
      forgot: 0,
    });
  }

  private patch(p: Partial<PanelState>): void {
    this.set({ ...this.state, ...p });
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The facts again (on opening, after each action, when sync's records change in storage). */
  async refresh(): Promise<SyncFacts> {
    const f = await readFacts(this.kit);
    this.patch({ facts: f });
    return f;
  }

  /** On opening and at every unlock: a quiet round when it is due (see the top of this file). */
  async roundIfDue(): Promise<void> {
    const f = this.state.facts ?? (await this.refresh());
    if (!f.syncOn || this.o.vault() !== "unlocked" || this.state.doing || this.state.review) return; // not under an open review
    if (f.lastOkAt !== null && this.now() - f.lastOkAt < ROUND_STALE_MS && f.status === "ok") return;
    if (f.backoffUntil !== null && f.backoffUntil > this.now()) return; // the worker runs it when the backoff ends
    await this.round(false);
  }

  /** "Sync now" (explicit), and every action that ends in a round. */
  async syncNow(answer?: MergeAnswer): Promise<void> {
    await this.round(true, answer);
  }

  private async round(explicit: boolean, answer?: MergeAnswer): Promise<void> {
    if (this.state.doing) return;
    const lost = this.state.facts?.local === "identity_missing";
    this.patch({ doing: "round", failure: null, done: null });
    try {
      const r = await this.kit.engine.round({ ...(explicit ? { explicit: true } : {}), ...(answer ? { answer } : {}) });
      if (r.blocked) this.showReview({ ...r.blocked, for: "round" });
      else if (answer) this.closeReview();
      if (r.merged || r.pulled) await this.o.reload();
    } catch (e) {
      this.patch({ failure: failureOf(e) });
    } finally {
      this.patch({ doing: null });
      this.kit.changed();
      const f = await this.refresh().catch(() => null);
      // §6 O12: a lost identity is restored by the first round with the key here; said once (the security record has it)
      if (lost && f && f.local === "on") this.patch({ done: "syncDoneIdentityRestored" });
    }
  }

  /** "Allow again" (permission_removed), from the click that asked Chrome (permission.ts asking). */
  async grant(granted: Promise<boolean>): Promise<void> {
    this.patch({ doing: "grant", failure: null, done: null });
    let ok = false;
    try {
      ok = await granted;
    } catch {
      ok = false;
    }
    this.patch({ doing: null, ...(ok ? {} : { failure: { code: "declined" } }) });
    if (ok) await this.syncNow();
    else await this.refresh();
  }

  /**
   * A rotation owed (§3.10) that turning off or removing the identity would forget, the user not having chosen to: kept,
   * and said. The choice lasts for this panel's next turn-off or removal (a review's answer included).
   */
  #dropOwed = false;
  private owedKept(): boolean {
    if (!this.state.facts?.rotationOwed || this.#dropOwed) return false;
    this.patch({ failure: { code: "rotation_owed_first" } });
    return true;
  }

  /** Chrome's answer to a click that asked for the API permission before a step that needs the network; declined: said. */
  async permit(granted: Promise<boolean>): Promise<boolean> {
    let ok = false;
    try {
      ok = await granted;
    } catch {
      ok = false;
    }
    this.patch(ok ? { failure: null } : { failure: { code: "declined" } });
    if (ok) this.kit.changed();
    return ok;
  }

  /**
   * The master password, to take over keys changed on another device (§3.9 R2, R3, R4): needs_password and
   * needs_new_password. The engine checks it against the server's current keys and adopts them only as M1 allows.
   */
  async adopt(password: string, o: { confirmOlder?: boolean; answer?: MergeAnswer } = {}): Promise<void> {
    if (this.state.doing) return;
    const pw = o.confirmOlder || o.answer ? (this.#password ?? password) : password;
    const forgot = this.state.forgot;
    const restoring = this.o.vault() === "lost"; // §4.13: the cloud restore is this adoption over a lost vault
    this.patch({ doing: "adopt", failure: null, done: null, confirmOlder: false });
    try {
      const r = await adoptWithSecret(
        this.kit.engine,
        { password: pw },
        { ...(o.confirmOlder ? { confirmOlder: true } : {}), ...(o.answer ? { answer: o.answer } : {}) },
      );
      if (r.kind === "confirm_older") {
        this.#password = pw;
        return this.patch({ confirmOlder: true });
      }
      this.#password = null;
      if (r.kind === "review_needed") {
        this.showReview({ report: r.report, seen: r.seen, for: "adopt" });
        this.#password = pw;
        return;
      }
      this.closeReview();
      if (r.kind === "rejected") return this.patch({ failure: { code: r.reason } });
      // this device's own keys opened with it: on a locked page that is Phase 0's unlock, with the same password
      if (r.kind === "local" && (await this.kit.service.status()).state === "locked")
        await this.kit.service.unlockWithPassword(pw);
      this.patch({
        done: r.kind === "adopted" ? (restoring ? "syncDoneRestored" : "syncDoneAdopted") : "syncDoneUnlocked",
      });
      await this.o.reload();
    } catch (e) {
      this.#password = null;
      this.patch({ failure: failureOf(e) });
    } finally {
      this.patch({ doing: null });
      this.forgetIfLockedOrHidden(forgot);
      this.kit.changed();
      await this.refresh().catch(() => undefined);
    }
  }

  /** "Use my current password": the older key state is not adopted. */
  keepCurrent(): void {
    this.#password = null;
    this.patch({ confirmOlder: false });
  }

  /**
   * Turn sync off on this device (§3.10): the master password revokes it (pw_auth, S8), then the local records go; the
   * vault and its accounts stay. `granted` is the answer of the click that asked Chrome first (the revocation needs the
   * network); `had`: whether the permission was there before that click. Declined while withdrawn: only the local
   * removal is left (offlineOnly). On success the permission is removed, last. While a rotation is owed (§3.10) the
   * record of it goes with sync's state: refused ("rotation_owed_first") unless `o.dropOwed` says the user chose that.
   */
  async turnOff(
    password: string,
    granted: Promise<boolean>,
    had: boolean,
    answer?: MergeAnswer,
    o: { dropOwed?: boolean } = {},
  ): Promise<boolean> {
    if (this.state.doing) return false;
    if (o.dropOwed) this.#dropOwed = true;
    if (this.owedKept()) return false;
    const forgot = this.state.forgot;
    this.patch({ doing: "turn_off", failure: null, done: null, offlineOnly: false });
    let ok = false;
    try {
      ok = await granted;
    } catch {
      ok = false;
    }
    if (!ok && !had) {
      this.patch({ doing: null, offlineOnly: true });
      return false;
    }
    try {
      await turnSyncOff(this.kit.engine, password, answer ? { answer } : {});
    } catch (e) {
      const f = failureOf(e);
      if (f.blocked) {
        // the review's answer runs the revocation again: a permission this click granted stays until the review closes
        this.showReview({ ...f.blocked, for: "turn_off" });
        this.#password = password;
        this.#heldForReview = !had;
        this.patch({ doing: null });
        this.forgetIfLockedOrHidden(forgot);
      } else {
        this.closeReview(); // a review this was the answer to is over: the user starts the turn-off again
        this.#heldForReview = false;
        this.patch({ doing: null, failure: f });
        if (!had) await dropPermission(this.kit); // asked only for this: back to how it was
      }
      await this.refresh().catch(() => undefined);
      return false;
    }
    this.#password = null;
    this.#heldForReview = false;
    await dropPermission(this.kit); // last (§3.10, revision 21)
    this.patch({ doing: null, review: null, done: "syncDoneOff" });
    this.kit.changed();
    await this.o.reload();
    await this.refresh().catch(() => undefined);
    return true;
  }

  /**
   * Remove the sync identity on this device only (§3.10 P5): no password, nothing sent. For a device the server no
   * longer accepts, a damaged record, another server's identity, or turning off without the network.
   */
  async removeIdentity(answer?: MergeAnswer, o: { dropOwed?: boolean } = {}): Promise<boolean> {
    if (this.state.doing) return false;
    if (o.dropOwed) this.#dropOwed = true;
    if (this.owedKept()) return false;
    this.patch({ doing: "remove_identity", failure: null, done: null });
    try {
      await removeSyncIdentity(this.kit.engine, answer ? { answer } : {});
    } catch (e) {
      const f = failureOf(e);
      if (f.blocked) this.showReview({ ...f.blocked, for: "remove_identity" });
      this.patch({ doing: null, ...(f.blocked ? {} : { failure: f }) });
      return false;
    }
    this.closeReview();
    await dropPermission(this.kit); // last
    this.patch({ doing: null, review: null, offlineOnly: false, done: "syncDoneRemoved" });
    this.kit.changed();
    await this.o.reload();
    await this.refresh().catch(() => undefined);
    return true;
  }

  /**
   * An unfinished first upload or join (§3.1 D4, §3.5 "加入未完成"): the signed status query. A first upload that never
   * reached the server is undone here (resumeFirstUpload), and the permission given back; anything else is settled by a
   * round (which also completes a join that did land).
   */
  async checkAgain(): Promise<void> {
    const f = this.state.facts;
    if (this.state.doing || !f) return;
    if (f.identity?.state === "pending" && !f.identity.pinned) {
      this.patch({ doing: "check", failure: null, done: null });
      try {
        const r = await resumeFirstUpload(this.kit.engine);
        this.patch({ doing: null });
        if (r === "created") return this.syncNow();
        if (r === "not_created") {
          await giveBack(this.kit);
          this.patch({ done: "syncDoneNotCreated" });
          this.kit.changed();
        } else this.patch({ failure: { code: "network" } });
      } catch (e) {
        this.patch({ doing: null, failure: failureOf(e) });
      }
      await this.refresh().catch(() => undefined);
      return;
    }
    await this.syncNow();
  }

  /** The review's answer, to whatever stopped (see ReviewFor). */
  async answer(a: MergeAnswer): Promise<void> {
    const r = this.state.review;
    if (!r) return;
    switch (r.for) {
      case "round":
        return this.syncNow(a);
      case "fold":
        return this.foldKept(a);
      case "adopt":
        return this.adopt(this.#password ?? "", { answer: a });
      case "turn_off": {
        const pw = this.#password;
        if (pw === null) return this.closeReview();
        // the permission is there: held since the first click (which asked for it) or held all along; the answer is a
        // second click, not a new request. `had` stays what it was before the first click.
        const had = !this.#heldForReview;
        await this.turnOff(pw, Promise.resolve(true), had, a);
        return;
      }
      case "remove_identity":
        await this.removeIdentity(a);
    }
  }

  /** Close the review without answering: nothing was applied, and the next round asks again. */
  dismissReview(): void {
    this.closeReview();
  }

  /**
   * Sixkey locked (lock.ts), or the tab was hidden: a password held for a confirmation goes, and the confirmation. A
   * review whose answer is running now is left to that answer's own ending (it took the password already, and the
   * permission it holds is the one the revocation on its way needs); a lock voids the key under it anyway.
   */
  forgetPassword(): void {
    const r = this.state.review;
    const answering = r !== null && this.state.doing === r.for;
    if (r && (r.for === "turn_off" || r.for === "adopt") && !answering) this.closeReview();
    this.#password = null;
    this.patch({ confirmOlder: false, forgot: this.state.forgot + 1 });
  }

  /** A lock or a hidden tab came while the action ran: what it now holds for a confirmation goes too. */
  private forgetIfLockedOrHidden(before: number): void {
    if (this.state.doing === null && this.state.forgot !== before) this.forgetPassword();
  }

  /** Sixkey locked (lock.ts). */
  locked(): void {
    this.forgetPassword();
  }

  /**
   * The page is going away (pagehide): a permission held for a turn-off's review is given back now, before anything is
   * awaited (the chrome.permissions call is made at once).
   */
  leaving(): void {
    const r = this.state.review;
    if (r && r.for === "turn_off") this.closeReview();
  }

  /** A review shown; one it replaces closes as if dismissed (closeReview). */
  private showReview(next: Blocked & { for: ReviewFor }): void {
    const cur = this.state.review;
    if (cur && !(cur.for === "turn_off" && next.for === "turn_off")) this.closeReview();
    this.patch({ review: next });
  }

  /**
   * The one way a review closes without its action finishing: the password it held goes, and a permission held only for
   * a turn-off's review is given back (its chrome.permissions call made before this returns).
   */
  private closeReview(): void {
    const r = this.state.review;
    if (!r) return;
    if (r.for === "turn_off" || r.for === "adopt") this.#password = null;
    if (r.for === "turn_off" && this.#heldForReview) {
      this.#heldForReview = false;
      void dropPermission(this.kit);
    }
    this.patch({ review: null });
  }

  /** "Got it" on the notices shown. */
  async dismiss(shown: readonly Notice[]): Promise<void> {
    await dismissNotices(this.kit, shown);
    await this.refresh().catch(() => undefined);
  }

  /**
   * "Advanced": delete the parked saves shown, after the user confirmed exactly those (count and checksums) and typed
   * the master password (it cannot be undone).
   */
  async discard(shown: ParkedSummary, password: string): Promise<void> {
    if (this.state.doing) return;
    this.patch({ doing: "discard", failure: null, done: null });
    try {
      await discardParked(this.kit, shown, password);
      this.patch({ done: "syncDoneDiscarded" });
    } catch (e) {
      this.patch({ failure: failureOf(e) }); // bad_state: the list changed; the notice is shown again from the new facts
    } finally {
      this.patch({ doing: null });
      await this.refresh().catch(() => undefined);
    }
  }

  /**
   * The kept vaults the user confirmed (shown), deleted: exactly those, or none when the list changed meanwhile. Only on
   * an unlocked page, and with the master password typed again (it destroys data, as the key and device actions it sits
   * beside need the open vault and the password).
   */
  async discardKept(shown: readonly KeptVault[], password: string): Promise<void> {
    if (this.state.doing) return;
    if (this.o.vault() !== "unlocked") return this.patch({ failure: { code: "locked" } });
    this.patch({ doing: "discard", failure: null, done: null });
    try {
      await discardKept(this.kit, shown, password);
      this.patch({ done: "syncDoneKeptDeleted" });
    } catch (e) {
      this.patch({ failure: failureOf(e) }); // bad_state: the list changed; it is shown again from the new facts
    } finally {
      this.patch({ doing: null });
      await this.refresh().catch(() => undefined);
    }
  }

  /** With sync off, at an unlock of this page: the saves a turn-off kept, folded into the vault here (no network). */
  async foldKept(answer?: MergeAnswer): Promise<void> {
    const f = this.state.facts;
    if (!f || f.syncOn || f.orphans === 0 || this.o.vault() !== "unlocked") return;
    try {
      const r = await foldKeptLocally(this.kit, answer);
      if (typeof r === "object" && r.folded > 0) await this.o.reload();
      if (answer) this.closeReview();
    } catch (e) {
      const x = failureOf(e);
      if (x.blocked) this.showReview({ ...x.blocked, for: "fold" });
    }
    await this.refresh().catch(() => undefined);
  }

  /**
   * A flow turned sync on (`outcome`, enable.ts and join.ts): the first round at once (a full pull and merge, §3.1 step
   * 7, §3.2 M8). The news (`key`, "Sync is on", "This device joined") only when that round went through and sync is in
   * sync; otherwise the card says what happened. "unconfirmed" gets no news: the flow's own screen says that the server's
   * answer is awaited, and this round is the one that settles it (D4).
   */
  async settled(outcome: "done" | "enrolled" | "unconfirmed", key: string): Promise<void> {
    await this.syncNow();
    const f = this.state.facts;
    if (outcome !== "unconfirmed" && this.state.failure === null && f !== null && f.syncOn && f.status === "ok")
      this.announce(key);
  }

  /** One line of good news (a key of the sync catalog). A failure shown stays shown. */
  announce(key: string): void {
    this.patch({ done: key });
  }

  /** The current card's failure dismissed. */
  clearFailure(): void {
    this.patch({ failure: null, offlineOnly: false });
  }
}
