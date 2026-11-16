// What the popup shows when it opens, decided in one place, from one service call: openView (PHASE0X-PLAN A2). Nothing
// here calls chrome.* (the runtime is passed in), so a test can call loadScreen with a runtime over fake storage areas;
// test/unit/read-budget.test.ts counts its reads. App does the "touch the session" step itself, after the list has rendered.
import type { PasswordFormat } from "../core/crypto/password-candidates";
import type { DeviceView, OpenView } from "../core/service/service-core";
import { ServiceError } from "../core/service/service-error";
import type { Settings } from "../core/service/types";
import type { StorageEvent } from "../core/storage/format";
import type { Vault } from "../core/vault/model";
import { VaultError } from "../core/vault/validate";
import type { PopupRuntime } from "../platform/runtime-base";

export type Screen =
  | { k: "loading" }
  | { k: "welcome" }
  | { k: "lost" }
  | { k: "newer" }
  | { k: "locked"; format?: PasswordFormat; device?: DeviceView }
  | {
      k: "main";
      vault: Vault;
      events: StorageEvent[];
      protected: boolean;
      lastBackup: number | null;
      settings: Settings;
      /** The backup in Chrome sync's two records, read with the settings (main/CsbPop.tsx: none of its own). */
      also?: Record<string, unknown>;
      /** The count of their changes heard when that read began (csb-changes.ts): newer ones are read again. */
      mark?: number;
    }
  | { k: "error"; code: string };

export async function loadScreen(rt: Pick<PopupRuntime, "service">, mark?: number): Promise<Screen> {
  try {
    return screenOf(await rt.service.openView(), mark);
  } catch (e) {
    if (e instanceof VaultError && e.code === "newer_schema") return { k: "newer" };
    if (e instanceof ServiceError && e.code === "locked") return { k: "locked" };
    return { k: "error", code: e instanceof Error ? e.name : "unknown" };
  }
}

/** The screen for a view: the one openView returned, or the one an unlock returned (so unlocking loads nothing again). */
export function screenOf(v: OpenView, mark?: number): Screen {
  switch (v.state) {
    case "empty":
      return { k: "welcome" };
    case "lost":
      return { k: "lost" };
    case "locked":
      // the input hint: which field it shows for the master password (the PIN's field and line the lock screen tells from
      // the read the view was made of: pin-restart-count.ts restartOffer); the device unlock's button and lines
      return {
        k: "locked",
        ...(v.format ? { format: v.format } : {}),
        ...(v.device ? { device: v.device } : {}),
      };
    case "unlocked":
      return {
        k: "main",
        vault: v.vault,
        events: v.events,
        protected: v.passwordProtected,
        lastBackup: v.lastBackup,
        settings: v.settings,
        also: v.also,
        mark,
      };
  }
}
