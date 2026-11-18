// Forgot the master password (PHASE0X-PLAN A4; docs/audit/internal-reviews/A4-REVIEW.md A4R-1, GM2-13): the recovery
// key sets a new master password, and goes on working itself (the owner's report of 2026-11-18: a reset used to issue a
// new recovery key as well, one more thing to save for no gain). The recovery key and the new password, typed twice;
// Continue writes it (prepareReset, then commitReset at once). The new password is typed twice because, written, a typo
// would leave only the recovery key to get back in. It runs in a settings tab, never in the popup.
import { useRef, useState } from "preact/hooks";
import { ServiceError } from "../core/service/service";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { masterAccepts, measure, type Strength } from "../ui/strength";
import { RecoveryCodeInput } from "./RecoveryCodeInput";
import { BoxTitle, errText, Panel, PasswordFields, type Ctx } from "./shared";

/** How the reset ended, for the page to say: unlocked, or written but locked (the session could not be stored). */
export type ResetOutcome = "unlocked" | "locked" | null;

export function ResetPassword({
  ctx,
  onLeave,
}: {
  ctx: Ctx;
  onLeave: (outcome: ResetOutcome) => void;
  onHolding?: (holding: boolean) => void;
}) {
  const { rt } = ctx;
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [anyway, setAnyway] = useState<string | null>(null); // "Use anyway" was pressed for this value
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the code rebuilt from shares (the field's shares link), and whether it was refused: shares of an old code
  const [viaShares, setViaShares] = useState(false);
  const [stale, setStale] = useState(false);
  const working = useRef(false);

  const say = (e: unknown) => {
    const c = (e as { code?: unknown } | null)?.code;
    if (c === "wrong_secret" && viaShares)
      setStale(true); // the shares' entry says why, in its words
    else if (c === "wrong_secret") setError(t("wrongRecovery"));
    else if (c === "bad_state") setError(t("resetChanged"));
    else if (typeof c === "string" && c.startsWith("recovery_")) setError(t("badRecoveryFormat"));
    else setError(errText(e));
  };

  const reset = (ev: Event) => {
    ev.preventDefault();
    if (working.current) return; // a second click while the first one writes
    working.current = true;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        // The master password's rule, as everywhere it is set (the floor, and 50 bits or "Use anyway": OWNER-DECISIONS/15);
        // the button already waits for it.
        if (!masterAccepts(await measure(pw), anyway === pw)) throw new ServiceError("weak_password");
        const prepared = await rt.service.prepareReset(code, pw);
        await rt.service.commitReset(prepared);
        setCode("");
        setPw("");
        setPw2("");
        // Unlocked by the reset, unless the session could not be stored: then the new password unlocks.
        onLeave((await rt.service.status().catch(() => null))?.state === "unlocked" ? "unlocked" : "locked");
      } catch (e) {
        say(e);
      } finally {
        working.current = false;
        setBusy(false);
      }
    })();
  };

  const canReset =
    !busy && code.trim().length > 0 && pw.length > 0 && pw === pw2 && masterAccepts(strength, anyway === pw);
  return (
    <Panel id="reset" icon="key" title={t("resetTitle")} lead={t("resetLead")}>
      <form class="box" onSubmit={reset}>
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
          <button id="reset-next" class="btn" type="submit" disabled={!canReset}>
            {t("continue")}
            <Icon name="next" size={15} />
          </button>
          <button type="button" class="btn sm ghost" id="reset-cancel" disabled={busy} onClick={() => onLeave(null)}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
