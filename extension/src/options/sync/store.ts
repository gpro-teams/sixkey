// The Sync section's controllers keep their state in a Store: plain objects, replaced (never mutated) on every step,
// with subscribers told after each. The views read `state` and call the controller's methods; the tests do the same
// without a DOM (test/unit/m6-flows.test.ts).
//
// Every controller works through asynchronous steps that the user can cancel at any time (a page closed, a flow left).
// A step started before a cancel must not write its result over what came after: each controller counts its runs
// (`epoch`), and a step's continuation checks `live(epoch)` before it sets anything (the same rule as SYNC-DESIGN §3.2
// MUST 7 for the enrolment state machines, applied to the screens).
export class Store<S> {
  #state: S;
  readonly #subs = new Set<() => void>();
  #epoch = 0;

  constructor(initial: S) {
    this.#state = initial;
  }

  get state(): S {
    return this.#state;
  }

  subscribe(fn: () => void): () => void {
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  }

  protected set(next: S): void {
    this.#state = next;
    for (const fn of [...this.#subs]) fn();
  }

  /** The current run; a new one starts with every cancel or restart (`bump`). */
  protected get epoch(): number {
    return this.#epoch;
  }

  protected bump(): number {
    return ++this.#epoch;
  }

  protected live(epoch: number): boolean {
    return epoch === this.#epoch;
  }
}
