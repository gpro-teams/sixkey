// What Settings › Backup's card for the backup in Chrome's sync storage says, worked out from the worker's two records
// (platform/csb-config.ts) and the time: pure, so every state is tested without a page.
//   off      the backup is off: the one button "开启", the body, the cost line, the switch; in a shared profile the line
//            on whose Google account it would go to
//   unsafe   on, but this browser did not let the worker close storage.sync to scripts in web pages in this run of it
//            (the worker writes `unsafe` in its state): nothing is written here, and the card says
//            why. Off and unsafe: the off state with that line
//   empty    on, and a run went through with nothing written and nothing waiting (an empty vault is written since
//            2026-11-17, so this is a passing state, not the normal one for a new vault)
//   saving   on, nothing handed over yet, a run due
//   ok       handed to Chrome Sync, with when: never "backed up", Sixkey cannot see what Chrome uploads
//   waiting  changes not handed over yet, no error
//   failed   a passing error (Chrome busy, or another refusal), retried by the worker
//   stale    changes waiting for three days or more
//   stopped  an error no retry fixes (status.ts csbStops): too large, no room, held, no master password, unreadable
// Beside the state: the honest line (what "handed to Chrome Sync" means), the evidence that sync carries the area (a
// copy another computer made was seen), the space used (from 60 %, nearly full from 85 %), and
// other vaults' copies, which a merge brings in.
import { ROOM_BYTES } from "../../core/cloud/slot-limits";
import { csbStatus, type CsbError, type CsbStoppingError } from "../../core/cloud/status";
import type { CsbConfig, CsbState } from "../../platform/csb-config";

// "3 分钟前": the card's and first run's, and the popup's, which takes it without this module (src/ui/ago.ts)
export { ago } from "../../ui/ago";

/** Chrome sync's room (core/cloud/slots.ts QUOTA_BYTES), as the card says it: about 100 KB. */
const AREA_BYTES = 102_400;
const DAY = 24 * 60 * 60_000;
/** The usage line from this share of the area, the nearly-full line from this one. */
export const USAGE_FROM = 0.6;
export const NEAR_FULL_FROM = 0.85;
/** A typical account's bytes in the copy (a 32-character key, an e-mail label, one site), when this vault's are unknown. */
export const TYPICAL_ACCOUNT_BYTES = 454;
/** What a copy holds besides its accounts: the container, the keyring, the envelope's header, the keys (about). */
export const FIXED_BYTES = 1_300;

export type CardKind = "off" | "unsafe" | "empty" | "saving" | "ok" | "waiting" | "failed" | "stale" | "stopped";
export type CardView =
  | { kind: "off" | "unsafe" | "empty" | "saving" | "waiting" }
  | { kind: "ok"; at: number }
  | { kind: "failed"; err: CsbError }
  | { kind: "stale"; days: number; err: CsbError | null }
  | { kind: "stopped"; err: CsbStoppingError };

export function cardView(cfg: CsbConfig, st: CsbState, now: number): CardView {
  if (!cfg.on) return { kind: "off" };
  if (st.unsafe) return { kind: "unsafe" };
  const s = csbStatus(true, st, now);
  switch (s.kind) {
    case "stopped":
      return { kind: "stopped", err: s.err };
    case "stale":
      return { kind: "stale", days: Math.floor((now - s.since) / DAY), err: s.err as CsbError | null };
    case "failed":
      return { kind: "failed", err: s.err as CsbError };
    case "waiting":
      if (s.at !== null) return { kind: "waiting" };
      // a run went through with nothing to write and nothing waiting, and no copy was ever handed over
      return st.lastRun !== null && st.pendingSince === null ? { kind: "empty" } : { kind: "saving" };
    case "ok":
      return { kind: "ok", at: s.at };
    default:
      return { kind: "off" };
  }
}

/** The key of a passing error's reason. */
export const reasonKey = (err: CsbError | null): string => (err === "busy" ? "csErrBusy" : "csErrOther");

/** The key of a stopping error's line. */
export const stoppedKey: Record<CsbStoppingError, string> = {
  too_large: "csTooLarge",
  no_room: "csNoRoom",
  held: "csHeld",
  no_password: "csNoPassword",
  unreadable: "csUnreadable",
};

/** Whether the state's line is a problem (amber: nothing is blocked, the card says what to do). */
export const amber = (v: CardView): boolean =>
  v.kind === "unsafe" || v.kind === "failed" || v.kind === "stale" || v.kind === "stopped";

/** Whether the card says what "handed to Chrome Sync" means beside this state (where it claims or offers that). */
export const saysHonest = (v: CardView): boolean =>
  v.kind === "off" || v.kind === "empty" || v.kind === "saving" || v.kind === "ok" || v.kind === "waiting";

/**
 * The space line, once the area is used to 60 %: its share and kilobytes; from 85 %, how many more accounts fit
 * instead, from this vault's own bytes per account where they can be worked out (`entries`: its entries, the trash's and
 * erased ones' included, when the page holds the vault), else a typical account's. Null below 60 %, or off.
 */
export function usageLine(
  cfg: CsbConfig,
  st: CsbState,
  entries: number | null,
): { kind: "usage"; pct: number; kb: number } | { kind: "near"; more: number } | null {
  if (!cfg.on || st.used === null) return null;
  const share = st.used / AREA_BYTES;
  if (share < USAGE_FROM) return null;
  if (share < NEAR_FULL_FROM) return { kind: "usage", pct: Math.round(share * 100), kb: Math.round(st.used / 1024) };
  const per =
    entries !== null && entries > 0 && st.bytes !== null && st.bytes > FIXED_BYTES
      ? Math.max(1, (st.bytes - FIXED_BYTES) / entries)
      : TYPICAL_ACCOUNT_BYTES;
  return { kind: "near", more: Math.max(0, Math.floor((ROOM_BYTES - st.used) / per)) };
}
