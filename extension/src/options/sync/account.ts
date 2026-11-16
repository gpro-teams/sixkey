// GET /v1/account (SYNC-DESIGN §3.1 step 3, §3.5): whether the signed-in email already has a synced vault, and the two
// numbers the warning card shows (§6 O4: when it was made, how many devices). They come from the server and are only a
// reminder (the real protection is the pairing code, §3.2): anything that is not a plain number in range is shown
// as unknown, never as text.
import type { AccountSession, SyncKit } from "./gateway";

export type VaultInfo = { createdAt: number | null; devices: number | null };

const HOUR = 3_600_000;
const okTime = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x % HOUR === 0;
const okCount = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= 100_000;

export async function accountOf(
  kit: SyncKit,
  session: AccountSession,
): Promise<{ hasVault: boolean; info: VaultInfo }> {
  const a = (await kit.engine.api.account(session)) as {
    has_vault: boolean;
    vault_created_at?: unknown;
    device_count?: unknown;
  };
  return {
    hasVault: a.has_vault === true,
    info: {
      createdAt: okTime(a.vault_created_at) ? a.vault_created_at : null,
      devices: okCount(a.device_count) ? a.device_count : null,
    },
  };
}
