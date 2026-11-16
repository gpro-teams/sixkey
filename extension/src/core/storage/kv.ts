// The only thing the storage logic needs from a platform: a small async key-value store.
// chrome.storage.local and IndexedDB both fit; tests use MemoryKV (optionally wrapped with fault injection).
export interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>;
  /** All keys are written in one call. Platforms may or may not make that atomic; the store does not rely on it. */
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  keys(): Promise<string[]>;
}

/** Runs one critical section at a time. The extension passes navigator.locks; tests use the in-process default. */
export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

export function createMutex(): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Stores structured clones, like a real serialising store, so aliasing bugs cannot hide. */
export class MemoryKV implements KV {
  readonly data = new Map<string, unknown>();
  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
  }
  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}
