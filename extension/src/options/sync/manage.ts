// What the flows that manage a sync account share (SYNC-DESIGN §3.2 the approving side, §3.3 step 5, §3.6–§3.10, §3.12,
// §4.10, §4.13; §6 O7–O11, O14): approving a device, the key operations, revoking, repairing the cloud, restoring from
// it, a separate identity, rejoining, deleting the account. They keep the rules the turn-on and join flows keep
// (enable.ts, join.ts), here in one place so that no flow drifts from the others:
//   - Each is started from a click that asks Chrome for the API permission first (permission.ts asking). Sync is on for
//     all of them, so a grant is sync's own (the paused card's "Allow again" in another form) and nothing is given back
//     when the flow ends; declined, the flow ends and says why. Deleting the account, which ends sync, gives it back
//     itself, last (fork.ts, DeleteFlow).
//   - A lock of Sixkey (lock.ts) ends the flow at once and drops its secrets (a password, a recovery code typed or
//     shown, an approval's state), unless a write is under way: then the write's own outcome ends it, and a lock that came
//     meanwhile is said as one. Cancel, the section going away and the page closing drop the secrets too, and wait for a
//     write under way.
//   - What the screen says at the end is what the engine said: "unconfirmed" as such, never as done.
//   - What is typed on a flow's screens belongs to its run (the views empty their fields when a run starts or ends).
import type { Failure, SyncKit } from "./gateway";
import { Store } from "./store";

/** The states every managing flow has, beside its own steps. */
export type FlowEnd = { at: "failed"; failure: Failure } | { at: "closed" };

export abstract class ManageFlow<S extends { at: string }> extends Store<S | FlowEnd> {
  #writing: Promise<unknown> | null = null;
  #lockedOut = false;
  /** The states in which the flow is over (besides "failed" and "closed"). */
  readonly #over: ReadonlySet<string>;

  protected constructor(
    protected readonly kit: SyncKit,
    initial: S,
    over: readonly string[],
  ) {
    super(initial);
    this.#over = new Set(["failed", "closed", ...over]);
  }

  /** Drop every secret the flow holds (passwords, codes, prepared handles). */
  protected abstract clear(): void;

  get isOver(): boolean {
    return this.#over.has(this.state.at);
  }

  /** Sixkey locked while a write was under way. */
  protected get lockedOut(): boolean {
    return this.#lockedOut;
  }

  /**
   * Step 1, from the click (permission.ts asking): `next` once Chrome answered yes; declined (or not asked), the flow
   * ends. Starts a new run: anything of an earlier run is dropped first.
   */
  protected async opened(granted: Promise<boolean>, next: () => void | Promise<void>): Promise<void> {
    const run = this.bump();
    this.clear();
    this.#lockedOut = false;
    let ok = false;
    try {
      ok = await granted;
    } catch {
      ok = false;
    }
    if (!this.live(run)) return;
    if (!ok) return this.end({ code: "declined" });
    await next();
  }

  /** A write: tracked until it ends, so that a lock, a cancel or the page closing waits for its outcome. */
  protected async write<T>(p: Promise<T>): Promise<T> {
    const tracked = p.finally(() => {
      if (this.#writing === tracked) this.#writing = null;
    });
    this.#writing = tracked;
    return tracked;
  }

  /** Sixkey locked (lock.ts): the flow ends at once, unless a write is under way (its continuation ends it). */
  async locked(): Promise<void> {
    if (this.isOver) return;
    this.#lockedOut = true;
    if (this.#writing) return;
    this.bump();
    this.end({ code: "locked_out" });
  }

  /** Sync is on for every managing flow: the permission is sync's, and the page closing gives nothing back. */
  leaving(): boolean {
    return false;
  }

  /** Cancel, the section going away, the page closing: nothing goes on to a next step, the secrets go, a write is waited for. */
  async cancel(): Promise<void> {
    this.bump();
    this.clear();
    this.set({ at: "closed" });
    const w = this.#writing;
    if (w) await w.catch(() => undefined);
  }

  /** Another flow takes this one's place: it stops, its secrets dropped. */
  retire(): void {
    this.bump();
    this.clear();
    if (!this.isOver) this.set({ at: "closed" });
  }

  dispose(): void {}

  /** The flow ended without its result: secrets dropped; a lock among the causes is said as one. */
  protected end(f: Failure): void {
    this.clear();
    this.set({ at: "failed", failure: f.code === "locked" || this.#lockedOut ? { code: "locked_out" } : f });
  }
}
