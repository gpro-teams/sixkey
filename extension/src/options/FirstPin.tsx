// First run's PIN step (2026-11-25, the owner: after the master password and the recovery key, recommend a PIN, set
// without the master password typed again). It comes after the profile question, once the vault is written, and only for
// "only me" (a shared profile has no PIN); the step is offered only while PinAdmin.firstPinOpen says the PIN may be set
// without the master password: this page made the vault from a master password typed in it a moment ago (never after a
// recovery-key restore that kept the copy's password). Skippable; the PIN's rules are Settings' (4 to 8 digits, a weak
// one said, not refused). A lazy chunk: first run loads it once the vault is written.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { checkPinPolicy } from "../core/crypto/pin-policy";
import { PinAdmin } from "../core/service/pin-admin";
import { ServiceError } from "../core/service/service";
import type { Runtime } from "../platform/runtime";
import { LOCK_EPOCH_KEY } from "../platform/session";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { BoxTitle, errText } from "./shared";

/** Whether first run offers the step now (PinAdmin.firstPinOpen). Never rejects. */
export const firstPinOpen = (rt: Runtime): Promise<boolean> => new PinAdmin(rt.service).firstPinOpen();

export function FirstPinStep({ rt, onDone }: { rt: Runtime; onDone: () => void }) {
  const admin = useMemo(() => new PinAdmin(rt.service), [rt]);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the PIN can no longer be set here without the master password (the time ran out, the vault changed): Settings it is
  const [later, setLater] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  // a lock (from anywhere: the idle timer, the screen, Lock now) or the page going away: what was typed goes, as the PIN
  // box's fields go; locked, the PIN is Settings' to set, after the unlock
  useEffect(() => {
    const wipe = () => {
      setPin("");
      setPin2("");
    };
    const locked = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (!(LOCK_EPOCH_KEY in changes)) return;
      wipe();
      setLater(true);
    };
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    area?.onChanged.addListener(locked);
    addEventListener("pagehide", wipe);
    return () => {
      area?.onChanged.removeListener(locked);
      removeEventListener("pagehide", wipe);
    };
  }, []);

  const policy = pin ? checkPinPolicy(pin) : null;
  const hint =
    policy && !policy.ok
      ? t("pinFormat")
      : pin2 && pin !== pin2
        ? t("pinDiffer")
        : policy?.weak
          ? t("pinWeak") // said, not refused (OWNER-DECISIONS/20, 2026-10-30)
          : null;
  const canSet = !busy && !later && policy?.ok === true && pin === pin2;

  const submit = (ev: Event) => {
    ev.preventDefault();
    if (!canSet) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await admin.setFirstPin(pin);
        onDone();
      } catch (e) {
        if (e instanceof ServiceError && e.code === "bad_pin") setError(t("pinFormat"));
        else if (e instanceof ServiceError && e.code === "bad_state") setLater(true);
        else setError(errText(e));
      } finally {
        setPin("");
        setPin2("");
        setBusy(false);
      }
    })();
  };

  return (
    <form class="box" id="fr-pin" onSubmit={submit}>
      <BoxTitle icon="lock">
        <span tabIndex={-1}>{t("frPinTitle")}</span>
      </BoxTitle>
      <p>{t("frPinBody")}</p>
      {later ? (
        <p class="callout" id="fr-pin-later" role="status">
          <Icon name="info" size={16} />
          <span>{t("frPinLater")}</span>
        </p>
      ) : (
        <>
          <div class="row2">
            <div class="field">
              <label for="fr-pin-new">{t("pinNew")}</label>
              <input
                id="fr-pin-new"
                ref={first}
                type="password"
                inputMode="numeric"
                autocomplete="off"
                value={pin}
                disabled={busy}
                aria-describedby="fr-pin-hint"
                onInput={(e) => setPin((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="fr-pin-new2">{t("pinAgain")}</label>
              <input
                id="fr-pin-new2"
                type="password"
                inputMode="numeric"
                autocomplete="off"
                value={pin2}
                disabled={busy}
                aria-describedby="fr-pin-hint"
                onInput={(e) => setPin2((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <p class="muted" id="fr-pin-hint" aria-live="polite">
            {hint ?? ""}
          </p>
        </>
      )}
      {error && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}
      <div class="row2">
        {!later && (
          <button id="fr-pin-set" class="btn" type="submit" disabled={!canSet}>
            <Icon name="check" size={15} />
            {t("pinSet")}
          </button>
        )}
        <button id="fr-pin-skip" type="button" class={later ? "btn" : "btn ghost"} disabled={busy} onClick={onDone}>
          {t(later ? "continue" : "frPinSkip")}
        </button>
      </div>
    </form>
  );
}
