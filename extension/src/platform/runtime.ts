// Builds the one VaultService every extension context shares but the popup (options page, service worker): the wiring in
// runtime-base.ts with the whole service. The popup builds the same wiring with the part of the service it uses
// (createPopupRuntime, runtime-base.ts).
import type { PasswordFormat } from "../core/crypto/password-candidates";
import { formatFor } from "../core/service/pw-format";
import { VaultService } from "../core/service/service";
import { buildRuntime, type RuntimeStorage } from "./runtime-base";

export { type RuntimeStorage } from "./runtime-base";

export function createRuntime(o: RuntimeStorage = {}) {
  return buildRuntime(o, (deps) => new VaultService(deps));
}
export type Runtime = ReturnType<typeof createRuntime>;

/**
 * The master-password prompts' input hint, for the settings page (core/service/pw-format.ts): the record in
 * chrome.storage.session checked against the keyring as stored now, or null. One load and one session read; never throws
 * (no hint means the plain field). Shown, never used to decide anything. The popup does not call it: its lock screen
 * has the hint in its view (ServiceCore.openView), checked against the keyring that open has already read, so it reads
 * nothing more of chrome.storage.local (docs/design/notes/PASSWORD-SETUP-NOTES.md §8.3).
 */
export async function passwordFormat(rt: Pick<Runtime, "store" | "formats">): Promise<PasswordFormat | null> {
  try {
    const r = await rt.store.load();
    return r.status === "ok" && rt.formats ? formatFor(await rt.formats.read(), r.gen.keyring) : null;
  } catch {
    return null;
  }
}
