import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { PinAdmin } from "../core/service/pin-admin";
import { pinKit } from "../core/service/pin-kit";
import type { DeviceView } from "../core/service/service-core";
import { logError } from "../ui/errors";
import { Icon } from "./icons";
import { t } from "../ui/i18n";
import { MasterField } from "./MasterField";
import { BoxTitle, errText, type Ctx } from "./shared";

/**
 * Shown at the top of the settings page while the vault is locked. With a PIN that opens Sixkey now it asks for the PIN
 * first (QUICK-UNLOCK §5.10: the unlock bar accepts quick unlock too), the master password one button away. The field
 * is emptied as soon as a PIN is submitted. The master password's field is the one the input hint asks for (MasterField).
 * A PIN set up that waits for the master password (PinAdmin.state: "wait" or "paused"; never in a profile declared
 * shared) gets the lock screen's line that it needs it once (OWNER-DECISIONS/15). Touch ID / Windows Hello (QUICK-UNLOCK
 * Stage 2): the lock screen's button and lines (ui/DeviceUnlock.tsx, a lazy chunk with its own text), in place: this is a
 * tab. What it offers is the lock screen's own view (openView's `device`). The PIN opens Sixkey with its record, and the
 * master password's note after an unlock makes that record usable again (core/service/pin-restart-steps.ts, a lazy
 * chunk; OWNER-DECISIONS/20 and its 2026-10-30 notes).
 */
const deviceUnlock = () => import("../ui/DeviceUnlock");
const pinSteps = () => import("../core/service/pin-restart-steps");
/** How long the bar waits for the master password's note before the page shows the vault anyway (as Locked.tsx). */
const NOTE_WAIT_MS = 10_000;
/** `p` waited for, at most NOTE_WAIT_MS; its errors swallowed (the note never throws; its chunk's load may). */
const capped = (p: Promise<unknown>): Promise<void> =>
  new Promise<void>((done) => {
    const late = setTimeout(done, NOTE_WAIT_MS);
    const end = () => {
      clearTimeout(late);
      done();
    };
    p.then(end, end);
  });
export function UnlockBar({ ctx }: { ctx: Ctx }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const admin = useMemo(() => new PinAdmin(ctx.rt.service), [ctx.rt]);
  const [pinTries, setPinTries] = useState(0); // the PIN's tries left while it opens Sixkey; 0: none
  const [waiting, setWaiting] = useState(false); // a PIN set up, waiting for the master password
  const [usePassword, setUsePassword] = useState(false);
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [Device, setDeviceUi] = useState<Awaited<ReturnType<typeof deviceUnlock>>["DeviceUnlock"] | null>(null);
  // what the PIN can do now: read when the page's status changes, and again when a PIN unlock says it cannot be used
  // (the 5th wrong try), so the line comes without a reload. Reads are numbered: an answer that comes
  // back after a newer one was asked for is dropped, so an older look never puts back a PIN that has ended.
  const looks = useRef(0);
  // the latest look at the device unlock (openView's `device`), kept as a promise so that a master password typed before
  // it answered still notes its time (below)
  const deviceLook = useRef<Promise<DeviceView | null>>(Promise.resolve(null));
  const look = () => {
    const n = ++looks.current;
    deviceLook.current = ctx.rt.service.openView().then(
      (v) => (v.state === "locked" ? (v.device ?? null) : null),
      () => null,
    );
    void deviceLook.current.then((d) => n === looks.current && setDevice(d));
    return admin.state().then(
      (s) => {
        if (n !== looks.current) return;
        const opens = s.restart?.state === "pin";
        setPinTries(opens ? s.restart!.triesLeft : 0);
        setWaiting(s.available === "ok" && s.pin !== null && !opens);
      },
      () => {
        if (n !== looks.current) return;
        setPinTries(0);
        setWaiting(false);
      },
    );
  };
  useEffect(() => void look(), [ctx.status]);
  useEffect(() => {
    if (device && !Device)
      void deviceUnlock().then(
        (m) => setDeviceUi(() => m.DeviceUnlock),
        (e) => logError("settings device unlock", e),
      );
  }, [device]);

  const pin = pinTries > 0 && !usePassword;

  async function withPin(value: string) {
    // the PIN's record (its lazy chunk; the service's rules)
    const r = await (await pinSteps()).unlock(ctx.rt.service, value, pinKit);
    if (r.ok) return ctx.reload();
    if (r.reason === "malformed") setError(t("pinFormat"));
    else if (r.reason === "locked") setError(t("pinRetry"));
    else if (r.reason === "wrong") {
      setPinTries(r.triesLeft);
      setError(t("pinWrong", r.triesLeft));
    } else {
      setError(t(r.reason === "exhausted" ? "pinExhausted" : "pinEnded"));
      setPinTries(0);
      void look();
    }
  }

  return (
    <form
      class="box banner unlock"
      onSubmit={async (e) => {
        e.preventDefault();
        const value = pw;
        setError(null);
        try {
          if (pin) {
            setPw("");
            await withPin(value);
            return;
          }
          await ctx.rt.service.unlockWithPassword(value);
          // the 14 days of the device unlock restart with the master password (its chunk, as the popup's lock screen)
          void deviceLook.current
            .then((d) => d && deviceUnlock().then((m) => m.notePassword(ctx.rt.service)))
            .catch(() => undefined);
          // and the PIN's record is made, or made usable again (its chunk, as the popup's lock screen; waited for, capped,
          // before the page shows the vault)
          if (waiting || pinTries > 0) await capped(pinSteps().then((m) => m.notePassword(ctx.rt.service, pinKit)));
          setPw("");
          await ctx.reload();
        } catch (err) {
          setError(errText(err));
        }
      }}
    >
      <span class="pi">
        <Icon name="lock" size={20} />
      </span>
      <div class="unlock-f">
        <BoxTitle icon="lock">{t(pin ? "pinTitle" : "lockedTitle")}</BoxTitle>
        {Device && device && (
          <Device
            service={ctx.rt.service}
            device={device}
            where="tab"
            autoFocus={false}
            onUnlocked={() => ctx.reload()}
            onFallback={() => document.getElementById(pin ? "unlock-pin" : "unlock-pw")?.focus()}
          />
        )}
        <div class="row2 grow">
          {pin ? (
            <div class="field">
              <label for="unlock-pin">{t("pinLabel")}</label>
              <input
                id="unlock-pin"
                key="pin"
                type="password"
                inputMode="numeric"
                autocomplete="off"
                aria-describedby="unlock-pin-tries"
                value={pw}
                onInput={(e) => setPw((e.target as HTMLInputElement).value)}
              />
            </div>
          ) : (
            <MasterField id="unlock-pw" label={t("passwordLabel")} value={pw} onValue={setPw} rt={ctx.rt} />
          )}
          <button id="unlock-btn" class="btn" type="submit" disabled={!pw}>
            {t("unlock")}
          </button>
          {pinTries > 0 && (
            <button
              type="button"
              class="btn ghost"
              id="unlock-switch"
              onClick={() => {
                setUsePassword(!usePassword);
                setPw("");
                setError(null);
              }}
            >
              {t(pin ? "useMasterPassword" : "usePin")}
            </button>
          )}
        </div>
        {pin && (
          <p class="muted" id="unlock-pin-tries">
            {t("pinTriesLeft", pinTries)}
          </p>
        )}
        {!pin && waiting && (
          <p class="muted" id="unlock-pin-waiting">
            {t("lockPinWaiting")}
          </p>
        )}
        {error && (
          <div class="err" role="alert">
            <Icon name="alert" size={15} />
            {error}
          </div>
        )}
      </div>
    </form>
  );
}
