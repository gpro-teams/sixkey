// The keyring of the vault's active generation, read straight from the slots: the check every record kept beside the
// vault under its key makes in its own critical section before a write (the VkRecord contract, service-core.ts: the PIN's
// set-up, the device unlock's record, and the PIN after a restart's, src/core/service/pin-restart-admin.ts).
// The generation itself, read the same way, is the backup in Chrome sync's view of "the vault on disk now"
// (platform/csb-worker.ts).
import type { Keyring } from "../crypto/keyring";
import { checkGeneration, KEYS, type Generation } from "./format";
import type { KV } from "./kv";
import { StorageError } from "./store";

/**
 * The active generation, read straight from the slots as the store's own fast path reads it: the pointer and the slot
 * it names, checked by checkGeneration. Null when the pointer names no readable generation; nothing is repaired here
 * (the store's own read walks its recovery ladder then), and a read that throws propagates.
 */
export async function activeGeneration(kv: KV): Promise<Generation | null> {
  const ptr = (await kv.get([KEYS.active]))[KEYS.active];
  const key = ptr === "a" || ptr === "b" ? KEYS.slot[ptr] : null;
  return key ? checkGeneration((await kv.get([key]))[key]) : null;
}

/**
 * The keyring of the active generation, read straight from the slots (the caller holds the vault lock; a cleanup runs
 * only on a vault that opened). A pointer that names no readable generation throws: the record cannot know the current
 * key, so the cleanup must stop and keep the marker (the store's own part repairs the pointer).
 */
export async function activeKeyring(kv: KV): Promise<Keyring> {
  const g = await activeGeneration(kv);
  if (!g) throw new StorageError("unreadable");
  return g.keyring;
}

/**
 * Whether the slots hold no readable generation: no vault, as an empty or lost store has none. Read straight from the
 * slots as activeKeyring reads them, for a caller that holds the vault lock and is about to act on "there is no vault"
 * (the plugin grant store's beforeNewVault, under makeVault: the second review's N2-2). Nothing is repaired here; a
 * read that throws propagates.
 */
export async function noReadableVault(kv: KV): Promise<boolean> {
  return activeKeyring(kv).then(
    () => false,
    (e: unknown) => {
      if (e instanceof StorageError && e.code === "unreadable") return true;
      throw e;
    },
  );
}
