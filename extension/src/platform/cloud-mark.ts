// The backup in Chrome's sync storage's part of the store's recovery hook (CSB; core/cloud/slots.ts rule 3): when the
// store falls back to an older copy, or replaces lost data, the backup's link is marked held, so that no write
// overwrites a slot that may be newer than this computer's data until a page merges it. Every context builds the store
// with this hook (platform/runtime-base.ts), the popup's too, so it is kept to a read and a write of one record, with
// nothing of the backup's own code: the record's shape is checked by its reader (platform/csb-config.ts), and the mark
// is slots.ts heldLink's, written out here. It runs inside the store's lock, before every recovery write, and takes the
// backup's records' lock (webLock("sixkey-csb")) only for the mark: the write lands after it lets that lock go, still
// inside the store's lock. So a recovery write that lands while the worker holds the records' lock had its mark written
// before the worker took the lock, and the worker's run reads it; and the worker's handlers that lift or replace a hold
// (a page's merge, a restore's adoption) take the store's lock first, then the records' lock, so no recovery can be
// between its mark and its write while they compare and re-base (platform/csb-worker.ts).
import type { KV, Lock } from "../core/storage/kv";

/** The backup in Chrome sync's configuration in storage.local: whether it is on, the link (csb-config.ts). */
export const CSB_CFG_KEY = "sk_csb_cfg";
/**
 * Its state (csb-config.ts): named here too, beside the configuration, for the one more context that reads it without
 * the backup's code: the popup's open, which reads both with the settings (platform/runtime-base.ts).
 */
export const CSB_STATE_KEY = "sk_csb_state";

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Marks the link of the backup's configuration held (rule 3). Nothing when the backup never wrote (no link). */
export async function markCsbHeld(kv: KV, lock: Lock): Promise<void> {
  await lock(async () => {
    const cfg = (await kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY];
    if (!isRecord(cfg) || !isRecord(cfg.link)) return;
    await kv.set({ [CSB_CFG_KEY]: { ...cfg, link: { ...cfg.link, held: true } } });
  });
}
