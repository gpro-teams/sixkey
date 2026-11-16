// Holds the 30 second timer for clearing the clipboard. A service worker has no clipboard access and may be stopped,
// so this hidden page does it. It compares a hash first: if the user has copied something else since, it does nothing.
import { acceptedType } from "../platform/sender-policy";

const buf = document.getElementById("buf") as HTMLTextAreaElement;

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readClipboard(): string {
  buf.value = "";
  buf.focus();
  document.execCommand("paste"); // needs clipboardRead
  const v = buf.value;
  buf.value = "";
  return v;
}

function writeEmpty(): void {
  buf.value = " "; // execCommand("copy") ignores an empty selection, so select a single space then replace the clipboard
  buf.select();
  document.execCommand("copy"); // needs clipboardWrite
  buf.value = "";
}

async function clearIfUnchanged(hash: string): Promise<boolean> {
  try {
    if ((await sha256Hex(readClipboard())) !== hash) return false;
    writeEmpty();
    return true;
  } catch {
    return false;
  }
}

let pending = 0;

// Only the service worker arms the timer (sender-policy.ts). Every extension context hears runtime.sendMessage, so
// without this a page, or a content script, could arm or fire it; and with a hash of its choosing, clear the clipboard.
chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  if (acceptedType(msg, sender, chrome.runtime.id, "offscreen") !== "sk-offscreen-arm") return;
  const { hash, delayMs } = msg as { hash?: unknown; delayMs?: unknown };
  if (typeof hash !== "string") return;
  pending++;
  setTimeout(
    () => {
      void clearIfUnchanged(hash).finally(() => {
        // Only close once every armed timer has run, so a second copy within 30 seconds is not cut short.
        if (--pending === 0) chrome.runtime.sendMessage({ type: "sk-offscreen-done" }).catch(() => undefined);
      });
    },
    Math.min(Math.max(typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : 30_000, 1000), 120_000),
  );
});
