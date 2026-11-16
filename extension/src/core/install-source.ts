// Was this copy installed from the Chrome Web Store? (SYNC-DESIGN H4 / Z5, PHASE0X-PLAN C3.) Pure, so every case is
// unit tested; src/platform/install-source.ts asks the browser and caches the answer.
//
// What it is for: finding copies installed from a zip, a .crx or an unpacked folder, which never update themselves,
// and showing an ID the user can compare. What it cannot do: stop a malicious copy, which can simply delete this check.

/** chrome.management.ExtensionInfo["installType"]. */
export type InstallType = "admin" | "development" | "normal" | "sideload" | "other";

/**
 * - `not_store`: not installed the normal way (loaded unpacked, put there by other software, or something else).
 * - `id_mismatch`: installed the normal way, from a .crx, but not the store's copy: its ID is not the store ID.
 */
export type InstallProblem = "not_store" | "id_mismatch";

/**
 * In this order:
 * 1. `admin` (forced by an administrator's policy) is never reported, whatever its ID (SYNC-DESIGN H-d).
 * 2. Any type but `normal` is `not_store`. That includes a type this code does not know yet.
 * 3. `normal` with a store ID set and a different ID is `id_mismatch`. With no store ID (dev and e2e builds) the ID
 *    is not looked at.
 * SYNC-DESIGN Z5 reports "the ID is not the store ID, or the type is not normal or admin", so a `normal` copy with
 * another ID is reported too, not only the types other than `normal`.
 */
export function installProblem(self: { id: string; installType: string }, storeId: string): InstallProblem | null {
  if (self.installType === "admin") return null;
  if (self.installType !== "normal") return "not_store";
  if (storeId && self.id !== storeId) return "id_mismatch";
  return null;
}
