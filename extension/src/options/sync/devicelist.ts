// The device list of the Sync section (SYNC-DESIGN §3.10, §6 O8), as M6 shows it: each device's name and when it last
// synced (to the day), this device marked, revoked ones greyed, repeated wrong master passwords flagged (§3.14 S2);
// rename (with the master password, N22), and, on the list, "reject all" waiting requests and clearing the server's
// history (O14, both with the master password). Revoking is its own flow (revoke.ts): it asks a reason and may go on to
// rotating the keys.
//   - The page loads the list by itself (listDue) only with sync on here and outside the server's backoff (§4.8: the
//     worker ends a backoff; nothing automatic is sent before it ends). An action the user starts is not held back.
//   - Every action needs the network: the view's click asks Chrome first (permission.ts asking) and passes its answer.
//   - Names are opened with the vault key here; while Sixkey is locked they are not shown (O8: "锁定时名称显示占位"),
//     and a lock takes them off the list at once (locked).
//   - The master password typed for an action lives in the view's field and in the call, never here.
import {
  checkDeviceName,
  clearServerHistory,
  failureOf,
  listDevices,
  rejectAllRequests,
  renameDevice,
  type DeviceNameProblem,
  type DeviceRow,
  type Failure,
  type SyncKit,
} from "./gateway";
import type { SyncFacts } from "./gateway";
import type { Text } from "./model";
import { Store } from "./store";

/** Whether this device is the account's only one not revoked (the list known): turning it off then warns (§3.10). */
export function isLastDevice(rows: readonly DeviceRow[] | null): boolean {
  return rows !== null && rows.some((r) => r.current) && rows.every((r) => r.current || r.revokedAt !== null);
}

/** Whether the page may load the device list by itself now: sync on here, and not inside the server's backoff. */
export function listDue(f: SyncFacts | null, now: number): boolean {
  return f !== null && f.syncOn && f.local === "on" && !(f.backoffUntil !== null && f.backoffUntil > now);
}

export type DevicesState = {
  rows: DeviceRow[] | null;
  /** What is running now (one thing at a time). */
  doing: "load" | "rename" | "reject_all" | "clear_history" | null;
  failure: Failure | null;
  /** The device a rename's name was refused for, and why (§2.4). */
  nameProblem: { id: string; problem: DeviceNameProblem } | null;
  /** One line of news after an action. */
  done: Text | null;
};

export class DevicesCtl extends Store<DevicesState> {
  constructor(private readonly kit: SyncKit) {
    super({ rows: null, doing: null, failure: null, nameProblem: null, done: null });
  }

  private patch(p: Partial<DevicesState>): void {
    this.set({ ...this.state, ...p });
  }

  /** GET /v1/devices, the names opened here. A failure keeps the rows shown before (they are a few minutes old at most). */
  async load(): Promise<void> {
    if (this.state.doing) return;
    this.patch({ doing: "load", failure: null });
    try {
      this.patch({ rows: await listDevices(this.kit.engine), doing: null });
    } catch (e) {
      this.patch({ doing: null, failure: failureOf(e) });
    }
  }

  /** Sixkey locked: the names go from the list (the rest of a row is no secret). */
  locked(): void {
    if (this.state.rows) this.patch({ rows: this.state.rows.map((r) => ({ ...r, name: null })) });
  }

  /** Rename a device (N22: this one too), the name checked first (§2.4), with the master password (pw_auth). */
  async rename(id: string, name: string, password: string, granted: Promise<boolean>): Promise<boolean> {
    if (this.state.doing) return false;
    const c = checkDeviceName(name);
    if (!c.ok) {
      this.patch({ nameProblem: { id, problem: c.problem } });
      return false;
    }
    return this.run("rename", granted, async () => {
      await renameDevice(this.kit.engine, id, c.name, password);
      this.patch({ done: { k: "syncDoneRenamed" } });
    });
  }

  /** Reject every waiting enrolment request (§3.2, O8), with the master password. */
  async rejectAll(password: string, granted: Promise<boolean>): Promise<boolean> {
    return this.run("reject_all", granted, async () => {
      const n = await rejectAllRequests(this.kit.engine, password);
      this.patch({ done: { k: "syncDoneRejectedAll", s: [n] } });
    });
  }

  /** Clear the server's history of earlier vault versions (O14, Q5), with the master password. */
  async clearHistory(password: string, granted: Promise<boolean>): Promise<boolean> {
    return this.run("clear_history", granted, async () => {
      const n = await clearServerHistory(this.kit.engine, password);
      this.patch({ done: { k: "syncDoneHistoryCleared", s: [n] } });
    });
  }

  clearNews(): void {
    this.patch({ failure: null, done: null, nameProblem: null });
  }

  /** One action: Chrome's answer first (declined: nothing sent), then the call, then the list again. */
  private async run(
    doing: "rename" | "reject_all" | "clear_history",
    granted: Promise<boolean>,
    act: () => Promise<void>,
  ): Promise<boolean> {
    this.patch({ doing, failure: null, done: null, nameProblem: null });
    let ok = false;
    try {
      ok = await granted;
    } catch {
      ok = false;
    }
    if (!ok) {
      this.patch({ doing: null, failure: { code: "declined" } });
      return false;
    }
    try {
      await act();
    } catch (e) {
      this.patch({ doing: null, failure: failureOf(e) });
      return false;
    }
    this.patch({ doing: null });
    this.kit.changed();
    await this.load();
    return true;
  }
}
