// Copy a code, and arm the 30 second clean-up when the user has allowed it.
// Copying needs no permission. Clearing "only if the clipboard still holds this code" needs clipboardRead and
// clipboardWrite, which are optional and asked for on the options page, plus an offscreen document to hold the timer.
export const CLEAR_AFTER_MS = 30_000;

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function clearPermitted(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["clipboardRead", "clipboardWrite"] });
  } catch {
    return false;
  }
}

/**
 * Returns true if the worker took the request for a clean-up. The message carries a hash of the code, never the code. `delayMs` 0: as soon
 * as the offscreen document can (it waits at least a second), for a code whose use is over (the pairing code, §7).
 */
export async function armClipboardClear(code: string, delayMs: number = CLEAR_AFTER_MS): Promise<boolean> {
  if (!(await clearPermitted())) return false;
  try {
    // The worker answers {ok: true} to a request it took; a refused or unanswered one is no clean-up (no countdown shown).
    const reply: unknown = await chrome.runtime.sendMessage({
      type: "sk-clip-arm",
      hash: await sha256Hex(code),
      delayMs,
    });
    return (reply as { ok?: unknown } | undefined)?.ok === true;
  } catch {
    return false;
  }
}
