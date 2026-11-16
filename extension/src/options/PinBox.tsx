// Settings › Security › PIN quick unlock (QUICK-UNLOCK §6.3; OWNER-DECISIONS/20 and its 2026-10-30 notes): set, change or
// remove the PIN, and end quick unlock now. Every change asks for the master password again (src/core/service/pin-admin.ts);
// ending asks for nothing, since it only takes a way in away. The text says what a PIN protects and what it does not
// (pinHonest), and, before a PIN is set, what a copy of this profile can do with it (rsCost, the PIN's lazy part:
// PinRestartBox.tsx). A PIN of 4 to 8 digits is taken; one too easy to guess is said to be so (pinWeak), not refused.
// Locked, the box shows only the state. In a profile declared shared it says why there is no PIN.
// The box is one line until opened (shared.tsx Fold); what must stay in view is not behind it: the state of the PIN, why
// there is none, "End quick unlock now", the box's answers. Closing it drops the typed password and PIN, as a lock does.
// The PIN opens Sixkey until 5 wrong tries, also after a restart; the state line says whether it does now or waits for
// the master password (after 5 wrong tries, "End quick unlock now", a key change: "Turn back on" is the lazy part's).
import { useEffect, useMemo, useState } from "preact/hooks";
import { checkPinPolicy } from "../core/crypto/pin-policy";
import { PinAdmin, type QuickState } from "../core/service/pin-admin";
import { PIN_KEY, RESTART_KEY } from "../core/service/pin-store";
import { quickChanged } from "../platform/session";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { MasterField } from "./MasterField";
import { errText, Fold, type Ctx } from "./shared";

/** The PIN's lazy part: what it costs, and "Turn back on" (loaded when the PIN is available here). */
const restartBox = () => import("./PinRestartBox");
type RestartBox = Awaited<ReturnType<typeof restartBox>>;

/** The PIN's own refusals, in this box's words; anything else as every page says it (errText). */
function pinError(e: unknown): string {
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  if (code === "bad_pin") return t("pinFormat");
  if (code === "quick_off") return t("pinShared");
  return errText(e);
}

export function PinBox({ rt, status, reload }: Ctx) {
  const admin = useMemo(() => new PinAdmin(rt.service), [rt]);
  const [st, setSt] = useState<QuickState | null>(null);
  const [pw, setPw] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [Box, setBox] = useState<RestartBox | null>(null);
  const wipe = () => {
    setPw("");
    setPin("");
    setPin2("");
  };

  const refresh = () => admin.state().then(setSt, () => setSt(null));
  // On opening, after every reload of the page's state, and when the PIN, its record or the gate's arming changes in any
  // page (a wrong PIN in the popup, a change made in another tab).
  useEffect(() => {
    void refresh();
  }, [status]);
  useEffect(() => {
    const changed = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if ((area === "session" && quickChanged(c)) || (area === "local" && (PIN_KEY in c || RESTART_KEY in c)))
        void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  // A typed master password or PIN does not wait in the box for whoever sits down next: emptied when the page locks, and
  // when this tab is hidden.
  const unlocked = status.state === "unlocked";
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      wipe();
      setOpen(false);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  useEffect(() => {
    if (!unlocked) {
      wipe();
      setOpen(false);
    }
  }, [unlocked]);

  const offered = st?.available === "ok";
  useEffect(() => {
    if (offered && !Box)
      void restartBox().then(
        (m) => setBox(() => m),
        () => undefined,
      );
  }, [offered]);

  if (!st || st.available === "no_vault" || st.available === "off") return null;

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
      wipe();
      setOpen(false);
      setInfo(done);
    } catch (e) {
      setError(pinError(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const policy = pin ? checkPinPolicy(pin) : null;
  const hint =
    policy && !policy.ok
      ? t("pinFormat")
      : pin2 && pin !== pin2
        ? t("pinDiffer")
        : policy?.weak
          ? t("pinWeak") // said, not refused (OWNER-DECISIONS/20, 2026-10-30)
          : null;
  const canSet = !busy && !!pw && policy?.ok === true && pin === pin2;
  const set = st.pin !== null;

  return (
    <Fold
      id="pin-box"
      icon="key"
      title={t("pinBoxTitle")}
      open={open}
      onToggle={(on) => {
        wipe();
        setError(null);
        setInfo(null);
        setOpen(on);
      }}
      note={
        <>
          {st.available === "no_password" && <p class="muted">{t("pinNeedsPassword")}</p>}
          {st.available === "shared" && (
            <p class="callout" id="pin-shared">
              <Icon name="shieldAlert" size={16} />
              <span>{t("pinShared")}</span>
            </p>
          )}
          {st.available === "ok" && set && (
            <p class="ok-msg" id="pin-state" role="status">
              <Icon name="check" size={15} />
              {t(st.restart?.state === "pin" ? "pinOn" : "pinWaiting", st.pin!.digits)}
            </p>
          )}
          {st.available === "ok" && !unlocked && (
            <p class="callout">
              <Icon name="lock" size={16} />
              <span>{t("unlockToManage")}</span>
            </p>
          )}
          {/* Locked too: it only takes a way in away (no master password), and it is what to press when walking away */}
          {st.available === "ok" && (st.gate?.armed || st.restart?.state === "pin") && (
            <div class="row2">
              <button
                id="quick-end"
                class="btn ghost"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await admin.endQuickUnlock();
                    await reload(); // a hard lock: this page is locked now too
                  }, t("quickEnded"))
                }
              >
                {t("quickEndNow")}
              </button>
            </div>
          )}
          {error && (
            <div class="err" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
          {info && (
            <div class="ok-msg" role="status" id="pin-info">
              <Icon name="check" size={15} />
              {info}
            </div>
          )}
        </>
      }
    >
      <p class="muted">{t("pinLead")}</p>
      <p class="callout">
        <Icon name="info" size={16} />
        <span>{t("pinHonest")}</span>
      </p>
      {st.available === "ok" && (
        <>
          <p class="muted">{t("pinRoot")}</p>
          <p class="muted">{t("pinClose", t("alAlways"))}</p>
          {unlocked && Box && <Box.PinRestartBox rt={rt} changed={() => void refresh()} />}
          {unlocked && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (canSet) void run(() => admin.setPin(pw, pin), t("pinSaved"));
              }}
            >
              <MasterField id="pin-pw" label={t("passwordLabel")} value={pw} onValue={setPw} rt={rt} />
              <div class="row2">
                <div class="field">
                  <label for="pin-new">{t("pinNew")}</label>
                  <input
                    id="pin-new"
                    type="password"
                    inputMode="numeric"
                    autocomplete="off"
                    value={pin}
                    aria-describedby="pin-hint"
                    onInput={(e) => setPin((e.target as HTMLInputElement).value)}
                  />
                </div>
                <div class="field">
                  <label for="pin-new2">{t("pinAgain")}</label>
                  <input
                    id="pin-new2"
                    type="password"
                    inputMode="numeric"
                    autocomplete="off"
                    value={pin2}
                    aria-describedby="pin-hint"
                    onInput={(e) => setPin2((e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
              <p class="muted" id="pin-hint" aria-live="polite">
                {hint ?? ""}
              </p>
              <div class="row2">
                <button id="pin-set" class="btn" type="submit" disabled={!canSet}>
                  {t(set ? "pinChange" : "pinSet")}
                </button>
                {set && (
                  <button
                    id="pin-remove"
                    class="btn ghost"
                    type="button"
                    disabled={busy || !pw}
                    onClick={() => void run(() => admin.removePin(pw), t("pinRemoved"))}
                  >
                    {t("pinRemove")}
                  </button>
                )}
              </div>
            </form>
          )}
        </>
      )}
    </Fold>
  );
}
