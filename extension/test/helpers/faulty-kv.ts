import { MemoryKV, type KV } from "../../src/core/storage/kv";

export class CrashError extends Error {
  constructor() {
    super("simulated crash");
    this.name = "CrashError";
  }
}

export type CrashMode =
  | "before" // the write never happens
  | "after" // the write fully lands, then the process dies before the caller hears about it
  | "partial" // a non-atomic store: only the first half of the keys land
  | "torn"; // every key lands, but the first value is cut short

/** Wraps a MemoryKV. Counts write calls and "kills the process" at the Nth one; every call after that throws. */
export class FaultyKV implements KV {
  calls = 0;
  crashed = false;
  constructor(
    readonly inner: MemoryKV,
    private plan?: { at: number; mode: CrashMode },
  ) {}

  arm(plan: { at: number; mode: CrashMode }): void {
    this.plan = plan;
  }

  private dead(): void {
    if (this.crashed) throw new CrashError();
  }

  async get(keys: string[]) {
    this.dead();
    return this.inner.get(keys);
  }
  async keys() {
    this.dead();
    return this.inner.keys();
  }
  async set(items: Record<string, unknown>): Promise<void> {
    this.dead();
    this.calls++;
    if (this.plan && this.calls === this.plan.at) {
      this.crashed = true;
      const entries = Object.entries(items);
      if (this.plan.mode === "after") await this.inner.set(items);
      else if (this.plan.mode === "partial")
        await this.inner.set(Object.fromEntries(entries.slice(0, Math.floor(entries.length / 2))));
      else if (this.plan.mode === "torn") {
        const [k0, v0] = entries[0]!;
        await this.inner.set({ ...Object.fromEntries(entries.slice(1)), [k0]: tear(v0) });
      }
      throw new CrashError();
    }
    await this.inner.set(items);
  }
  async remove(keys: string[]): Promise<void> {
    this.dead();
    this.calls++;
    if (this.plan && this.calls === this.plan.at) {
      this.crashed = true;
      if (this.plan.mode === "after") await this.inner.remove(keys);
      else if (this.plan.mode === "partial") await this.inner.remove(keys.slice(0, Math.floor(keys.length / 2)));
      throw new CrashError();
    }
    await this.inner.remove(keys);
  }
}

/** Cut a stored value in half, the way an interrupted write would. */
export function tear(v: unknown): unknown {
  const s = JSON.stringify(v);
  return { torn: s.slice(0, Math.floor(s.length / 2)) };
}

/** A store that acknowledges writes but silently keeps nothing for matching keys (a lying disk). */
export class LyingKV extends MemoryKV {
  constructor(private readonly dropKey: (k: string) => boolean) {
    super();
  }
  override async set(items: Record<string, unknown>): Promise<void> {
    await super.set(Object.fromEntries(Object.entries(items).filter(([k]) => !this.dropKey(k))));
  }
}
