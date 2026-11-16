import type { KV } from "../core/storage/kv";

const KEY = "sk_diag";
const MAX = 50;

export type DiagEntry = { at: number; message: string; error?: string };

/**
 * A small local log of non-fatal problems (a failed mirror write, a skipped snapshot). There is no telemetry, so this
 * is the only way a user can tell us what went wrong: they export it by hand. It records the error class, never its text.
 */
export function createDiagLogger(kv: KV, now: () => number = Date.now) {
  return (message: string, err?: unknown): void => {
    const code = err && typeof err === "object" ? ((err as { code?: unknown }).code ?? (err as Error).name) : undefined;
    void (async () => {
      try {
        const cur = (await kv.get([KEY]))[KEY];
        const list = Array.isArray(cur) ? (cur as DiagEntry[]) : [];
        list.push({ at: now(), message, ...(code ? { error: String(code) } : {}) });
        await kv.set({ [KEY]: list.slice(-MAX) });
      } catch {
        /* logging must never throw */
      }
    })();
  };
}

export async function readDiag(kv: KV): Promise<DiagEntry[]> {
  const cur = (await kv.get([KEY]))[KEY];
  return Array.isArray(cur) ? (cur as DiagEntry[]) : [];
}

/**
 * Like the logger, but a message already in the log is not written again, so a condition that repeats at every worker
 * start (a refused storage access level) takes one line and does not push the other lines out of the 50. It is read and
 * written in one step, not locked: the caller is the one writer of its message.
 */
export function createDiagOnce(kv: KV, now: () => number = Date.now) {
  return async (message: string): Promise<void> => {
    try {
      const cur = (await kv.get([KEY]))[KEY];
      const list = Array.isArray(cur) ? (cur as DiagEntry[]) : [];
      if (list.some((e) => e.message === message)) return;
      list.push({ at: now(), message });
      await kv.set({ [KEY]: list.slice(-MAX) });
    } catch {
      /* logging must never throw */
    }
  };
}
