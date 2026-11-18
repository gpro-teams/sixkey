import { useEffect, useRef, useState } from "preact/hooks";
import type { PasswordFormat } from "../../core/crypto/password-candidates";
import { normalizePin } from "../../core/crypto/pin";
import { formatRecoveryCode } from "../../core/crypto/recovery-code";
import { pinKit } from "../../core/service/pin-kit";
import { restartOffer } from "../../core/service/pin-restart-count";
import type { DeviceView, UnlockedView, UnlockResult } from "../../core/service/service-core";
import { ServiceError } from "../../core/service/service-error";
import { hereNow, peekRequest, REQ_MS, requestArea, watchRequest, type FillReq } from "../../platform/fill-request";
import type { PopupRuntime } from "../../platform/runtime-base";
import { usePageLock } from "./page-lock";
import { LOCK_EPOCH_KEY } from "../../platform/session";
import { VaultDial } from "../../ui/art";
import { errorLine, logError } from "../../ui/errors";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import { PasswordGroups } from "../../ui/PasswordGroups";
import { Frame, openOptions } from "../chrome";
import { surface } from "../surface";

/**
 * What a successful unlock reports to App: the view to show (PHASE0X-PLAN A2). The security record's notice is App's to
 * read, after this view's first code is on screen (C7, ../notice.ts): the unlock itself reads nothing more for it.
 * `via`: opened with the PIN or the device unlock (Touch ID, Windows Hello), not the master password, so App shows the
 * notice but does not ack it (the count comes off only for someone who typed the master password;
 * docs/design/notes/QUICK-PIN-NOTES.md, PRF-NOTES.md).
 * `req`: the nonce of the pending fill request whose line this screen showed when the PIN, password or recovery code was
 * typed into it (AUTOFILL2 patch 1): the list may then fill that page, once. Absent for every other unlock.
 */
export type UnlockInfo = { view?: UnlockedView; via?: "pin" | "device"; req?: string };

/**
 * The pending fill request R (platform/fill-request.ts) that is for this surface now: its tab in front of this window, at
 * its address, fresh, no lock since. Read when the screen shows and again whenever R, the lock epoch or the tab in front
 * changes. Only shown: the screen never writes R.
 */
function usePendingFill(): FillReq | null {
  const [req, setReq] = useState<FillReq | null>(null);
  useEffect(() => {
    const area = requestArea();
    if (!area) return;
    let live = true;
    let asked = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const n = ++asked;
      void peekRequest(area, hereNow(area)).then(
        (r) => {
          if (!live || n !== asked) return;
          setReq(r);
          // R ends by time alone too (no event says so): look again just after its minute (the verify's MINOR-2)
          clearTimeout(expiry);
          if (r) expiry = setTimeout(look, Math.max(0, r.at + REQ_MS - Date.now()) + 5);
        },
        () => live && n === asked && setReq(null),
      );
    };
    look();
    const unwatch = watchRequest(look);
    chrome.tabs?.onActivated?.addListener(look);
    chrome.tabs?.onUpdated?.addListener(look);
    return () => {
      live = false;
      clearTimeout(expiry);
      unwatch();
      chrome.tabs?.onActivated?.removeListener(look);
      chrome.tabs?.onUpdated?.removeListener(look);
    };
  }, []);
  return req;
}

// The in-page suggestion's release gate (scripts/suggest-ui.mjs), read here as a constant of this module, which the build
// folds: with it open, a page's fill request (R v2) on this screen brings the rules of ./page-lock.ts; with it closed,
// none of them is in the build.
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;
/** The line for a PIN sent by Enter at another length than the PIN's (page-lock.ts R2-M1 c): the gate's words only. */
const lengthLine = (digits: number) => SUGGEST_UI && t("pinLength", digits);

/**
 * "I have shares instead" (docs/design/notes/SHAMIR-NOTES.md §5): the recovery code rebuilt from shares, then used
 * exactly as a typed one (the same unlock, the same answers and records). The entry and its text are a lazy chunk
 * (ui/ShareEntry.tsx), loaded at the link's click, so the popup's counted bundle carries only the link.
 */
const shareEntry = () => import("../../ui/ShareEntry");

/**
 * Touch ID / Windows Hello (QUICK-UNLOCK Stage 2; docs/design/notes/PRF-NOTES.md): the button and its lines are a lazy
 * chunk with its own text (ui/DeviceUnlock.tsx), loaded only when the view says there is a device unlock here.
 */
const deviceUnlock = () => import("../../ui/DeviceUnlock");

/**
 * The PIN (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/PIN-RESTART-NOTES.md §3, §18): what it offers is
 * told here, in this screen's own chunk, from what openView read (pin-restart-count.ts restartOffer: no read of its own);
 * the unlock with its record and the master password's note are a lazy chunk (core/service/pin-restart-steps.ts), loaded
 * when a PIN is set up here (its field on screen: loaded at once, so a PIN typed straight away does not wait for it). None
 * of it is in the popup's counted bundle.
 */
const pinSteps = () => import("../../core/service/pin-restart-steps");
/** How long the screen waits for the master password's note before it shows the list anyway (it goes on meanwhile). */
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

/**
 * The lock screen. With a PIN that opens Sixkey now (its record's field: restartOffer; QUICK-UNLOCK §5.4) it opens on it, so
 * digits typed straight after the shortcut land in the PIN field: one `<input type="password" inputmode="numeric">` with
 * a visible label and its tries-left line linked (§6.4). It submits on Enter, and by itself once the PIN's length is
 * reached. Paste is allowed (NIST SP 800-63B §5.1.1.2; password managers and assistive tools paste). The field is
 * emptied the moment a PIN is submitted, whatever the answer; the PIN is passed to the unlock and to nothing else (no
 * URL, no log: an error is logged by its code only). The master password is one button away, always.
 *
 * The master password's field follows the input hint (`format`, from the view: docs/design/notes/PASSWORD-SETUP-NOTES.md
 * §8.3): for a generated password of 16 symbols the grouped input (ui/PasswordGroups.tsx, as the settings page's prompts
 * have it, but with no Show: the master password is never shown here), with "Use a plain password field" under it;
 * otherwise the plain field. The hint picks the field and nothing else: what is typed goes to the same unlock, which
 * takes a generated password typed loosely in either field, so a wrong, forged or missing hint costs one click at most.
 * The PIN and the recovery code keep their own fields.
 */
export function Locked({
  rt,
  format,
  device,
  onUnlocked,
}: {
  rt: PopupRuntime;
  format?: PasswordFormat;
  /** The device unlock this screen offers (OpenView, QUICK-UNLOCK Stage 2): its button and lines, from a lazy chunk. */
  device?: DeviceView;
  onUnlocked: (info?: UnlockInfo) => Promise<void>;
}) {
  // the PIN: what it offers, from what this view's openView read (its field; or, set up here, that it waits for the
  // master password once: a line under that field says so)
  const offer = restartOffer(rt.service, pinKit); // pure and cheap: from the read the view was made of
  const field = offer?.field;
  const [mode, setMode] = useState<"pin" | "password" | "recovery">(field ? "pin" : "password");
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  // tries left; 0: the PIN ended here (too many wrong ones, or it expired), the master password only
  const [tries, setTries] = useState(field?.triesLeft ?? 0);
  // the PIN's length, for the submit at the last digit: from the record each answer names (it may have been changed)
  const [digits, setDigits] = useState(field?.digits ?? 0);
  const [plain, setPlain] = useState(false); // asked for over the hint's grouped input
  const [waitingNow, setWaitingNow] = useState(false); // the PIN's 5th wrong try was on this screen
  // the recovery code from shares: the entry (loaded on the link's first click), and whether the code it rebuilt was
  // refused (the shares belong to an old recovery code: the entry says so, in its own words)
  const [Shares, setShares] = useState<Awaited<ReturnType<typeof shareEntry>>["ShareEntry"] | null>(null);
  const [viaShares, setViaShares] = useState(false);
  const [stale, setStale] = useState(false);
  const [Device, setDevice] = useState<Awaited<ReturnType<typeof deviceUnlock>>["DeviceUnlock"] | null>(null);
  useEffect(() => {
    if (device)
      void deviceUnlock().then(
        (m) => setDevice(() => m.DeviceUnlock),
        (e) => logError("popup device unlock", e),
      );
  }, [device !== undefined]);
  useEffect(() => {
    if (field) void pinSteps().catch((e: unknown) => logError("popup pin steps", e)); // ready for the first PIN typed
  }, [field !== undefined]);
  const deviceReq = useRef<string | undefined>(undefined); // the fill request on screen when the button was pressed
  const input = useRef<HTMLInputElement>(null);
  // the fill request this screen shows (its line), and its nonce as it was when the secret was sent: read from the ref
  // BEFORE the unlock is awaited (a request that arrives while the unlock runs was not on screen when the secret was typed:
  // the verify's MINOR-1), and handed on with the unlock's view
  const req = usePendingFill();
  const shownReq = useRef<string | undefined>(undefined);
  shownReq.current = req?.nonce;
  // a page's request on this screen: its rules (./page-lock.ts), with the gate open only; `page.on` is false for the
  // shortcut's request and for none, so the screen is then exactly as before
  const page = SUGGEST_UI ? usePageLock(req) : undefined;
  /** The grouped password boxes' value (ui/PasswordGroups.tsx), noted as the plain field's input is (the gate open). */
  const groupsTyped = (v: string) => {
    page?.typed(v);
    setValue(v);
  };
  const own = (view: UnlockedView, nonce: string | undefined, via?: "pin" | "device"): UnlockInfo => ({
    view,
    ...(via ? { via } : {}),
    ...(nonce ? { req: nonce } : {}),
  });
  // In the side panel only while the panel has the focus: a lock that comes while the user types into the web page beside
  // it must not pull the keys into the PIN field, which sends itself at the PIN's length (SIDEPANEL-NOTES.md §3).
  useEffect(() => {
    if (!surface.panel || document.hasFocus()) input.current?.focus();
  }, [mode, plain]);
  // The way in on screen now. An answer that comes back after the user switched to another (a wrong password answered
  // once the recovery code's field is up) is not that field's error: it is not shown.
  const now = useRef(mode);
  now.current = mode;

  async function tryPin(pin: string) {
    setValue(""); // not left in the field, whatever the answer
    setBusy(true);
    setError(null);
    const fail = (msg: string) => {
      if (now.current !== "pin") return;
      setError(msg);
      setShake((n) => n + 1);
    };
    const shownNow = SUGGEST_UI && page?.on ? page.handOn(shownReq.current) : shownReq.current;
    try {
      // the PIN's record (its lazy chunk; the service's rules)
      const r = await (await pinSteps()).unlock(rt.service, pin, pinKit);
      if (r.ok) return void (await onUnlocked(own(r.view, shownNow, "pin")));
      if (r.reason === "malformed") fail(t("pinFormat"));
      else if (r.reason === "locked") fail(t("pinRetry"));
      else if (r.reason === "wrong") {
        setTries(r.triesLeft);
        setDigits(r.digits);
        if (SUGGEST_UI && page) page.wrong(); // no further send at the PIN's length on this screen (R2-M1 a)
        fail(t("pinWrong", r.triesLeft));
      } else {
        fail(t(r.reason === "exhausted" ? "pinExhausted" : "pinEnded"));
        setTries(0);
        setMode("password");
        // its tries spent, or the right 5th one with a lock meanwhile: the master password makes it usable again
        if (r.reason === "exhausted" || r.reason === "waiting") setWaitingNow(true);
      }
    } catch (e) {
      logError("popup pin failed", e);
      fail(errorLine(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(ev: Event) {
    ev.preventDefault();
    if (SUGGEST_UI && page?.on) {
      // a page's request on screen: not during the delay, nor for a press begun in it; an entry held to Enter only after
      // its quiet; a PIN of another length cleared, not tried (page-lock.ts)
      const may = page.send(mode === "pin" ? value : null, digits);
      if (may === "length") {
        setValue("");
        setError(lengthLine(digits) || null);
        setShake((n) => n + 1);
      }
      if (may !== "ok") return;
    }
    if (mode === "pin") return void tryPin(value);
    await attempt(mode, value);
  }

  /** The master password or the recovery code (typed, or rebuilt from shares: `fromShares`), to the same unlock. */
  async function attempt(asked: "password" | "recovery", secret: string, fromShares = false) {
    setBusy(true);
    setError(null);
    const fail = (msg: string) => {
      if (now.current !== asked) return;
      setError(msg);
      setShake((n) => n + 1);
    };
    const shownNow = SUGGEST_UI && page?.on ? page.handOn(shownReq.current, fromShares) : shownReq.current;
    try {
      let done: UnlockResult;
      if (asked === "password") {
        done = await rt.service.unlockWithPassword(secret);
        // the 14 days of the device unlock restart with the master password (its chunk; never the recovery key's)
        if (device)
          void deviceUnlock().then(
            (m) => m.notePassword(rt.service),
            () => undefined,
          );
        // and the PIN's: its record made, or made usable again (its chunk; never after the recovery key: the steps take
        // the service's own mark of this very password unlock). Waited for, still "unlocking", before the list shows: a
        // popup closed at once (a code copied, the page clicked) would end it half-way (review of PINONE, PO-02)
        if (offer) await capped(pinSteps().then((m) => m.notePassword(rt.service, pinKit)));
      } else done = await rt.service.unlockWithRecoveryCode(secret);
      await onUnlocked(own(done.view, shownNow));
    } catch (e) {
      const code =
        e instanceof ServiceError
          ? e.code
          : e instanceof Error && "code" in e
            ? String((e as { code: unknown }).code)
            : "unknown";
      if (code === "wrong_secret" && fromShares) {
        // shares that rebuild a valid code which does not open this vault: an old recovery code's (the entry says so)
        if (now.current === asked) {
          setStale(true);
          setShake((n) => n + 1);
        }
      } else if (code === "wrong_secret") {
        if (SUGGEST_UI && page) page.wrong(); // Enter only, after its quiet, on this screen from now (R2-M1 b)
        fail(t(asked === "password" ? "wrongPassword" : "wrongRecovery"));
      } else if (code.startsWith("recovery_")) fail(t("badRecoveryFormat"));
      else {
        // What happened and what to do, never the error's name (PHASE0X-PLAN C8).
        logError(`popup ${asked} failed`, e);
        fail(errorLine(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const go = (m: typeof mode) => {
    if (SUGGEST_UI && page) page.forget();
    setMode(m);
    setValue("");
    setError(null);
    setShow(false);
    setViaShares(false);
    setStale(false);
  };
  const toShares = () =>
    void shareEntry().then(
      (m) => {
        setShares(() => m.ShareEntry);
        setViaShares(true);
        setValue("");
        setError(null);
        setShow(false);
      },
      (e) => logError("popup shares entry", e),
    );
  const sharing = mode === "recovery" && viaShares && Shares !== null;
  const pin = mode === "pin";
  // the recovery code is read off paper, so it can be shown while it is typed (masked by default, like the settings
  // page's code field); a password or PIN never is, in the plain field or the grouped boxes (showable={false})
  const shown = mode === "recovery" && show;
  const groups = mode === "password" && format === "gen16-v1" && !plain;
  return (
    <Frame>
      <form class={`center lock mode-${mode}`} onSubmit={submit} aria-busy={busy}>
        <div class="hero">
          <VaultDial key={shake} size={104} class={busy ? "busy" : shake ? "shake" : ""} />
        </div>
        <h1 class="prompt">{t(pin ? "pinTitle" : mode === "password" ? "lockedTitle" : "recoveryTitle")}</h1>
        {req && (
          <p class="lockfill" id="lock-fill" role="status">
            {t("lockFillFor", req.host)}
          </p>
        )}
        {Device && device && mode !== "recovery" && (
          <Device
            service={rt.service}
            device={device}
            where={surface.panel ? "panel" : "popup"}
            // the PIN field keeps the focus where there is one, so digits typed after the shortcut land in it (§6.2)
            autoFocus={!pin && (!surface.panel || document.hasFocus())}
            disabled={SUGGEST_UI && page?.holdDevice() ? true : busy}
            onStart={() =>
              (deviceReq.current = SUGGEST_UI && page?.on ? page.device(shownReq.current) : shownReq.current)
            }
            onUnlocked={(r) => onUnlocked(own(r.view, deviceReq.current, "device"))}
            onFallback={() => {
              if (now.current !== "pin" && (!surface.panel || document.hasFocus())) input.current?.focus();
            }}
          />
        )}
        <div class="field">
          <label for={pin ? "pin" : "secret"} id="lock-label">
            {t(pin ? "pinLabel" : mode === "password" ? "passwordLabel" : "recoveryLabel")}
          </label>
          {sharing ? (
            <Shares
              id="lock-shares"
              lockKey={LOCK_EPOCH_KEY}
              toCode={formatRecoveryCode}
              autoFocus={!surface.panel || document.hasFocus()}
              disabled={busy}
              stale={stale}
              onCode={(code) => {
                setStale(false);
                if (code) void attempt("recovery", code, true);
              }}
              onCodeField={() => {
                setViaShares(false);
                setStale(false);
              }}
            />
          ) : groups ? (
            <PasswordGroups
              key="groups"
              id="secret"
              label={t("passwordLabel")}
              labelledBy="lock-label"
              value={value}
              onValue={SUGGEST_UI ? groupsTyped : setValue}
              invalid={!!error}
              showable={false}
              first={input}
            />
          ) : (
            <div class="inp-ic" key="plain">
              <Icon name={mode === "recovery" ? "key" : "lock"} />
              <input
                id={pin ? "pin" : "secret"}
                key={pin ? "pin" : "secret"}
                ref={input}
                class={mode === "recovery" ? "mono" : ""}
                // the recovery code too, unless the user ticks Show: a text field's value may be kept for session restore
                // (ENROLL-V2-NOTES.md)
                type={shown ? "text" : "password"}
                inputMode={pin ? "numeric" : undefined}
                autocomplete="off"
                spellcheck={false}
                value={value}
                aria-invalid={error ? true : undefined}
                aria-describedby={pin ? "pin-tries" : undefined}
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  if (SUGGEST_UI && page) page.typed(v);
                  setValue(v);
                  // the PIN's length reached: submitted at once (it is shown as dots anyway, QUICK-UNLOCK §6.2); with a
                  // page's request on screen, only for an entry begun after the delay, before any wrong secret (R2-M1 a)
                  if (SUGGEST_UI && page?.on && !page.auto()) return;
                  if (pin && !busy && normalizePin(v)?.length === digits) void tryPin(v);
                }}
              />
            </div>
          )}
          {groups && (
            <div>
              <button
                type="button"
                class="btn sm ghost"
                id="secret-plain"
                onClick={() => {
                  if (SUGGEST_UI && page) page.forget();
                  setPlain(true);
                  setValue("");
                  setError(null);
                }}
              >
                {t("pwPlainField")}
              </button>
            </div>
          )}
          {mode === "recovery" && !sharing && (
            <label class="show">
              <input
                type="checkbox"
                id="secret-show"
                checked={show}
                aria-controls="secret"
                onChange={(e) => setShow((e.target as HTMLInputElement).checked)}
              />
              {t("showPassword")}
            </label>
          )}
          {pin && (
            <p class="muted" id="pin-tries">
              {t("pinTriesLeft", tries)}
            </p>
          )}
          {mode === "password" && ((offer && !field) || waitingNow) && (
            <p class="muted" id="pin-waiting">
              {t("lockPinWaiting")}
            </p>
          )}
        </div>
        {error && (
          <div class="err" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        )}
        <div class="stack">
          {!sharing && (
            <button class="btn" type="submit" disabled={SUGGEST_UI && page?.holdSend() ? true : busy || !value}>
              {t("unlock")}
            </button>
          )}
          {mode === "recovery" && !sharing && (
            <button type="button" class="btn ghost" id="use-shares" onClick={toShares}>
              {t("sharesInsteadLink")}
            </button>
          )}
          {pin && (
            <button type="button" class="btn ghost" id="use-password" onClick={() => go("password")}>
              {t("useMasterPassword")}
            </button>
          )}
          {mode === "password" && field && tries > 0 && (
            <button type="button" class="btn ghost" id="use-pin" onClick={() => go("pin")}>
              {t("usePin")}
            </button>
          )}
          {mode === "password" && (
            <button type="button" class="btn ghost" onClick={() => go("recovery")}>
              {t("useRecovery")}
            </button>
          )}
          {mode === "recovery" && (
            <div class="duo">
              <button type="button" class="btn ghost" onClick={() => go("password")}>
                <Icon name="back" />
                {t("back")}
              </button>
              {/* The reset shows a new recovery code, and saving it (to a password manager, a file) takes the focus away,
                  which closes this popup: it runs in a settings tab instead, which stays (A4R-1; A1's first run, likewise). */}
              <button type="button" class="btn ghost" id="forgot-password" onClick={() => openOptions("#reset")}>
                {t("forgotPassword")}
              </button>
            </div>
          )}
        </div>
        <p class="hint">
          <Icon name="info" size={14} />
          <span>{t("lockHint")}</span>
        </p>
      </form>
    </Frame>
  );
}
