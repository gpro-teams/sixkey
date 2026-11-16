// What "turn sync off" keeps of the orphan list (D11, §4.7), on its own: only the engine's side uses it, and state.ts is
// in the popup's module graph (the service and the outbox writer read it), so this stays out of the popup's chunk once
// the Sync section shares it (SYNC-DESIGN §7, revision 24).
import type { KV } from "../../storage/kv";
import { SYNC_KEYS } from "./keys";

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * D11, "turn sync off" (§4.7; M3 revisions 5 and 6): what stays in sk_sync_orphan. Every entry `folded` does not name
 * (the calling flow folded those into the vault; a stored value that is not a list is one entry), and the live outbox,
 * pushable or merge-only, unless `held(checksum)` says the active generation on disk provably holds it (retirement 3's
 * rule: a slot torn after the flow's load must not take the only copy of a save with it). A value without a
 * checksum and an envelope holds nothing to fold and is not kept. One read of both keys; the caller writes the result
 * in its critical section (and deletes the key when nothing is left).
 */
export async function keptAtTurnOff(
  kv: KV,
  folded: readonly { checksum: string; envelope: string }[],
  held: (checksum: string) => Promise<boolean>,
): Promise<unknown[]> {
  const r = await kv.get([SYNC_KEYS.orphan, SYNC_KEYS.outbox]);
  const raw = r[SYNC_KEYS.orphan];
  const list =
    isObject(raw) && raw.v === 1 && Array.isArray(raw.items)
      ? raw.items
      : raw === undefined || raw === null
        ? []
        : [raw];
  const keep = list.filter(
    (it) => !(isObject(it) && folded.some((f) => f.checksum === it.checksum && f.envelope === it.envelope)),
  );
  const ob = r[SYNC_KEYS.outbox];
  if (isObject(ob) && typeof ob.checksum === "string" && typeof ob.envelope === "string" && !(await held(ob.checksum)))
    keep.push(ob);
  return keep;
}
