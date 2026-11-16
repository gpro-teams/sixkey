// "Find accounts" (SYNC-DESIGN §6 O13, P4's "[找回]"; §4.4 D6): accounts that were in an earlier version of the vault
// and are not in it now, brought back by the user's choice. The flow: Chrome is asked first (the server's history is
// read over the network; permission.ts asking, in the click), then the sources (the server's history and this
// device's snapshots, engine find.ts), then one source opened: the accounts it holds that the vault does not hold now,
// shown by issuer and label only; the user ticks some, and they come back in one local edit, synced as any edit is.
// The managing flows' rules hold (manage.ts): a lock ends the flow at once unless the edit is under way, Cancel and the
// page closing wait for it, and the screen says what the engine said. The opened source's entries (their secrets) are
// held by the engine for its handle only, and dropped whenever the flow leaves that screen: another source, Back, the
// edit made, or any end (clear).
import {
  dropFound,
  failureOf,
  findSources,
  openFound,
  recoverFound,
  type FindSource,
  type FindSources,
  type Found,
  type FoundAccount,
  type SyncKit,
} from "./gateway";
import { ManageFlow } from "./manage";

export type FindState =
  | { at: "asking" }
  | { at: "sources"; sources: FindSources; busy?: boolean }
  | {
      at: "accounts";
      source: FindSource;
      status: Found["status"];
      accounts: readonly FoundAccount[];
      busy?: boolean;
    }
  | { at: "done"; n: number };

export class FindFlow extends ManageFlow<FindState> {
  #sources: FindSources | null = null;
  #found: Found | null = null;

  constructor(kit: SyncKit) {
    super(kit, { at: "asking" }, ["done"]);
  }

  protected clear(): void {
    this.#drop();
    this.#sources = null;
  }

  #drop(): void {
    dropFound(this.#found);
    this.#found = null;
  }

  start(granted: Promise<boolean>): Promise<void> {
    return this.opened(granted, () => this.#load());
  }

  async #load(): Promise<void> {
    const run = this.epoch;
    try {
      const sources = await findSources(this.kit.engine);
      if (!this.live(run)) return;
      this.#sources = sources;
      this.set({ at: "sources", sources });
    } catch (e) {
      if (this.live(run)) this.end(failureOf(e));
    }
  }

  /** One source opened: what it holds that the vault does not now. Reads only. */
  async open(source: FindSource): Promise<void> {
    const s = this.state;
    if (s.at !== "sources" || s.busy) return;
    const run = this.epoch;
    this.set({ ...s, busy: true });
    try {
      const found = await openFound(this.kit.engine, source);
      if (!this.live(run)) return dropFound(found);
      this.#drop();
      this.#found = found;
      this.set({ at: "accounts", source, status: found.status, accounts: found.accounts });
    } catch (e) {
      if (this.live(run)) this.end(failureOf(e));
    }
  }

  /** Back to the sources; the opened one's entries are dropped. */
  back(): void {
    const s = this.state;
    if (s.at !== "accounts" || s.busy || !this.#sources) return;
    this.#drop();
    this.set({ at: "sources", sources: this.#sources });
  }

  /** The ticked accounts (`refs`) brought back: one local edit (a write: a lock waits for it, and its outcome is said). */
  async recover(refs: readonly string[]): Promise<void> {
    const s = this.state;
    const found = this.#found;
    if (s.at !== "accounts" || s.busy || !found || !refs.length) return;
    const run = this.epoch;
    this.set({ ...s, busy: true });
    let n: number;
    try {
      n = await this.write(recoverFound(this.kit.engine, found, refs));
    } catch (e) {
      this.#drop();
      if (!this.live(run) && !this.lockedOut) return;
      return this.end(failureOf(e));
    }
    this.#drop();
    if (!this.live(run) && !this.lockedOut) return;
    this.kit.changed();
    this.set({ at: "done", n });
  }
}
