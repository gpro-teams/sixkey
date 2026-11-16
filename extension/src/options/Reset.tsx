// Forgot the master password (PHASE0X-PLAN A4; docs/audit/internal-reviews/A4-REVIEW.md A4R-1, GM2-13): the recovery code sets a new password
// and a new recovery code. It runs here, in a settings tab, never in the popup: the new code has to be saved somewhere,
// and going to a password manager or a downloaded file takes the focus away, which closes the popup. A tab stays.
//   1. recovery code + new password, typed twice   prepareReset: the new keys exist in this page's memory only
//   2. the new code: shown, copied or saved as a file, confirmed saved; then Continue writes it (commitReset)
// Until step 2 is confirmed nothing changes: the old recovery code and password keep working, and the new code opens
// nothing. The tab stays open while the user saves the code elsewhere, so the confirmation can honestly come after the
// save; the note says that nothing has changed yet, and the page asks before it is closed. The new password is typed
// twice: under it, after the commit, a typo would leave only the new code to get back in.
import { useEffect, useRef, useState } from "preact/hooks";
import { ServiceError, type PreparedReset } from "../core/service/service";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { masterAccepts, measure, type Strength } from "../ui/strength";
import { RecoveryCodeInput } from "./RecoveryCodeInput";
import { BoxTitle, errText, Panel, PasswordFields, RecoveryCodeBox, type Ctx } from "./shared";

/** How the reset ended, for the page to say: unlocked, or written but locked (the session could not be stored). */
export type ResetOutcome = "unlocked" | "locked" | null;

export function ResetPassword({
  ctx,
  onLeave,
  onHolding,
}: {
  ctx: Ctx;
  onLeave: (outcome: ResetOutcome) => void;
  onHolding: (holding: boolean) => void;
}) {
  const { rt } = ctx;
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [anyway, setAnyway] = useState<string | null>(null); // "Use anyway" was pressed for this value
  const [pending, setPending] = useState<PreparedReset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the code rebuilt from shares (the field's "I have shares instead"), and whether it was refused: shares of an old code
  const [viaShares, setViaShares] = useState(false);
  const [stale, setStale] = useState(false);
  const committing = useRef(false);

  // A prepared reset is in this page's memory only: leaving (closing the tab, the language menu's reload) discards it.
  // Nothing is lost by that, but ask first, as the first-run wizard does.
  useEffect(() => {
    onHolding(pending !== null);
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => {
      removeEventListener("beforeunload", warn);
      onHolding(false);
    };
  }, [pending]);

  const say = (e: unknown) => {
    const c = (e as { code?: unknown } | null)?.code;
    if (c === "wrong_secret" && viaShares && !pending)
      setStale(true); // the shares' entry says why, in its words
    else if (c === "wrong_secret") setError(t("wrongRecovery"));
    else if (typeof c === "string" && c.startsWith("recovery_")) setError(t("badRecoveryFormat"));
    else setError(errText(e));
  };

  const prepare = (ev: Event) => {
    ev.preventDefault();
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        // The master password's rule, as everywhere it is set (the floor, and 50 bits or "Use anyway": OWNER-DECISIONS/15);
        // the button already waits for it.
        if (!masterAccepts(await measure(pw), anyway === pw)) throw new ServiceError("weak_password");
        setPending(await rt.service.prepareReset(code, pw)); // nothing of the vault written yet
        setCode("");
        setPw("");
        setPw2("");
      } catch (e) {
        say(e);
      } finally {
        setBusy(false);
      }
    })();
  };

  /** "I have saved my recovery code", Continue: only now do the new password and code replace the old ones. */
  const commit = async () => {
    if (!pending || committing.current) return; // a second click while the first one writes
    committing.current = true;
    setBusy(true);
    setError(null);
    try {
      await rt.service.commitReset(pending);
      setPending(null); // written: this code screen is done, whatever comes next (A4R-8)
      // Unlocked by the reset, unless the session could not be stored: then the new password unlocks.
      onLeave((await rt.service.status().catch(() => null))?.state === "unlocked" ? "unlocked" : "locked");
    } catch (e) {
      if (e instanceof ServiceError && e.code === "bad_state") {
        // The keys changed in another page meanwhile (or this reset was already used): the code on screen can never
        // work. Nothing was written here; start again from the form (A4R-8).
        setPending(null);
        setError(t("resetChanged"));
      } else {
        say(e); // an I/O error: the code stays, and Continue again finishes it (a write that landed counts as done)
      }
    } finally {
      committing.current = false;
      setBusy(false);
    }
  };

  const canPrepare =
    !busy && code.trim().length > 0 && pw.length > 0 && pw === pw2 && masterAccepts(strength, anyway === pw);
  return (
    <Panel id="reset" icon="key" title={t("resetTitle")} lead={t("resetLead")}>
      {pending ? (
        <>
          <p class="callout" id="reset-note">
            <Icon name="info" size={16} />
            <span>{t("resetCodeNote", t("continue"))}</span>
          </p>
          <RecoveryCodeBox code={pending.recoveryCode} onDone={() => void commit()} />
          {error && (
            <div class="err" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
          <div class="row2">
            <button
              class="btn sm ghost"
              id="reset-back"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setError(null);
              }}
            >
              <Icon name="back" size={15} />
              {t("back")}
            </button>
          </div>
        </>
      ) : (
        <form class="box" onSubmit={prepare}>
          <BoxTitle icon="key">{t("recoveryTitle")}</BoxTitle>
          <RecoveryCodeInput
            id="reset-code-in"
            label={t("recoveryLabel")}
            value={code}
            onValue={(v) => {
              setCode(v);
              setStale(false);
            }}
            onShares={setViaShares}
            stale={stale}
            disabled={busy}
          />
          <p class="muted" id="reset-shares-note">
            {t("sharesStopWarn")}
          </p>
          <PasswordFields
            idPrefix="reset"
            value={pw}
            confirm={pw2}
            onValue={setPw}
            onConfirm={setPw2}
            onStrength={setStrength}
            anyway={{ value: anyway, set: setAnyway }}
          />
          {pw && pw2 && pw !== pw2 && (
            <div class="err">
              <Icon name="alert" size={15} />
              {t("passwordsDiffer")}
            </div>
          )}
          {error && (
            <div class="err" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
          <div class="row2">
            <button id="reset-next" class="btn" type="submit" disabled={!canPrepare}>
              {t("continue")}
              <Icon name="next" size={15} />
            </button>
            <button type="button" class="btn sm ghost" id="reset-cancel" disabled={busy} onClick={() => onLeave(null)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
