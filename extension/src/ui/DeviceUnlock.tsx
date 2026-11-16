// The device unlock on a lock screen (QUICK-UNLOCK §5.4, §6.2, §6.4; Stage 2): one real button, "Unlock with Touch ID"
// (Windows Hello, this computer's sign-in), and the lines that say why it is not there now (the 14 days, paused by a key
// change, waiting for the master password). Used by the popup's and the side panel's lock screen
// (src/popup/screens/Locked.tsx) and the settings page's unlock bar (src/options/UnlockBar.tsx). A lazy chunk with its own
// text (device-text.ts), loaded only when the view says there is a device unlock, so the popup's counted bundle carries
// none of it, nor the WebAuthn, crypto and assertion check it uses.
//
// Where the ceremony runs (§0A.5 item 3, §1.6): in place, except in the toolbar popup on a computer where Stage 0 has not
// shown that the popup survives the OS dialog (everywhere but macOS, today): there the button opens the popup page in a
// small window (360×600), whose lock screen has the same focused button. The OS's dialog is the OS's: this says only
// beforehand what will appear (dvWindowNote). It never starts by itself (the no-interaction get() is unmeasured, §1.6):
// the button is focused, and Enter starts it.
//
// A cancel, a failure or a refusal moves the focus to the master password's field (§6.2 item 5), with a line for a
// failure (role="alert"). Nothing it receives is kept: the answer goes to the service, which keeps nothing of it either.
import { useEffect, useRef, useState } from "preact/hooks";
import { DeviceUnlocker } from "../core/service/device-unlock";
import type { DeviceView, ServiceCore, UnlockResult } from "../core/service/service-core";
import { webauthn } from "../platform/webauthn";
import { deviceName, dx, onMac } from "./device-text";
import { logError } from "./errors";

export type DeviceUnlockProps = {
  service: ServiceCore;
  device: DeviceView;
  /** The popup's page (the toolbar popup, or that page in a tab or window), the side panel, or the settings page. */
  where: "popup" | "panel" | "tab";
  /** Take the focus once drawn (unless something else has it), so Enter starts the ceremony. */
  autoFocus: boolean;
  /** The button was pressed: the host notes what it showed then (the pending fill request), before anything is awaited. */
  onStart?: () => void;
  onUnlocked: (r: UnlockResult) => void | Promise<void>;
  /** A cancel or a failure: the host gives the master password's field the focus. */
  onFallback: () => void;
  disabled?: boolean;
};

/**
 * The master password has just unlocked Sixkey on a lock screen that offers the device unlock: its time for the 14 days
 * (core/service/device-unlock.ts). Fire and forget: a lost write only asks for the master password sooner.
 */
export function notePassword(service: ServiceCore): void {
  void new DeviceUnlocker(service, webauthn).notePasswordTyped();
}

/** The toolbar popup itself (not that page in a tab or window): it has no tab of its own. */
async function inToolbarPopup(): Promise<boolean> {
  try {
    return (await chrome.tabs.getCurrent()) === undefined;
  } catch {
    return false;
  }
}

export function DeviceUnlock(p: DeviceUnlockProps) {
  const [ready, setReady] = useState(dx.words() !== undefined);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<"dvFailed" | null>(null);
  // what the service answered that the view did not know yet: for the persistent unlock, the 14 days over, paused, or
  // nothing to unlock with (the gate is then offered if it is armed); for the gate, ended
  const [prfGone, setPrfGone] = useState<"due" | "paused" | "ended" | null>(null);
  const [gateGone, setGateGone] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ready) void dx.loaded.then(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!ready || !p.autoFocus) return;
    const a = document.activeElement as HTMLInputElement | null;
    if (!a || a === document.body || (a.tagName === "INPUT" && !a.value)) btn.current?.focus();
  }, [ready]);
  if (!ready || dx.words() === null) return null;
  const name = deviceName();
  const d = p.device;
  const usePrf = d.prf && !prfGone; // the persistent unlock first, as §5.4 orders them
  const offer = usePrf || (d.gate && !gateGone);

  async function go() {
    if (busy) return;
    p.onStart?.();
    setBusy(true);
    setLine(null);
    try {
      if (p.where === "popup" && !onMac() && (await inToolbarPopup())) {
        // the OS dialog may close the toolbar popup (unmeasured here): a small window, which keeps it
        await chrome.windows.create({
          url: chrome.runtime.getURL("popup/index.html"),
          type: "popup",
          width: 360,
          height: 600,
        });
        window.close();
        return;
      }
      const u = new DeviceUnlocker(p.service, webauthn);
      const r = usePrf ? await u.unlockWithPrf() : await u.unlockWithGate();
      if (r.ok) return void (await p.onUnlocked(r));
      if (r.reason === "locked" || r.reason === "failed")
        setLine("dvFailed"); // locked meanwhile: try again, or the password
      else if (r.reason !== "cancelled") {
        if (usePrf) setPrfGone(r.reason);
        else setGateGone(true);
      }
      p.onFallback();
    } catch (e) {
      logError("device unlock failed", e);
      setLine("dvFailed");
      p.onFallback();
    } finally {
      setBusy(false);
    }
  }

  const due = prfGone === "due" || (!d.prf && d.due);
  const paused = prfGone === "paused" || (!d.prf && d.paused);
  return (
    <div class="stack" id="device-unlock">
      {offer && (
        <button
          type="button"
          class="btn"
          id="device-unlock-go"
          ref={btn}
          disabled={busy || p.disabled}
          aria-describedby="device-unlock-note"
          onClick={() => void go()}
        >
          {dx("dvUnlock", name)}
        </button>
      )}
      {offer && (
        <p class="muted" id="device-unlock-note">
          {dx("dvWindowNote")}
        </p>
      )}
      {line && (
        <div class="err" role="alert" id="device-unlock-error">
          {dx(line)}
        </div>
      )}
      {due && (
        <p class="muted" id="device-unlock-due">
          {dx("dvDue")}
        </p>
      )}
      {paused && (
        <p class="muted" id="device-unlock-paused">
          {dx("dvPaused", name)}
        </p>
      )}
      {!d.gate && !d.prf && d.waiting && (
        <p class="muted" id="device-unlock-waiting">
          {dx("dvWaiting", name)}
        </p>
      )}
    </div>
  );
}
