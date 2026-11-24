// The page's half of "enter your recovery key, two shares, or make a new one" (ADVANCED-RECOVERY-AND-TIERS §0.3, §5.1;
// docs/design/notes/SHAMIR-NOTES.md §3), built once: the choice between a new recovery code (the master password) and the
// current one (typed, or rebuilt from shares: RecoveryCodeInput), and its field. The service's half is
// VaultService.recoveryKeyFrom, which verifies what this step hands it (`recoveryKeyOf`). The shares wizard draws it;
// protected accounts and the inheritance kit are to draw it too, with words of their own (`words`), so it has no text of
// its own beyond the fields' labels. Its fields keep what they hold as every field of the page does (MasterField,
// RecoveryCodeInput): until a lock, the page going away, or the step's end.
import type { Runtime } from "../platform/runtime";
import { t } from "../ui/i18n";
import { codeSymbols, CODE_SYMBOLS } from "./code-text";
import { ConfirmField, type Confirm } from "./ConfirmField";
import { MasterField } from "./MasterField";
import { RecoveryCodeInput } from "./RecoveryCodeInput";

export type RecoveryKeySource = "new" | "current";
/** The choice's words, and the line under each field: the caller's (what the code is for there). */
export type RecoveryKeyWords = { new: string; newNote: string; current: string; currentNote: string };

/** What recoveryKeyFrom takes, from what the step holds; null until it is complete. */
export function recoveryKeyOf(
  source: RecoveryKeySource,
  password: string,
  code: string,
  pin = false,
): { password: string } | { pin: string } | { recoveryCode: string } | null {
  if (source === "new") return password ? (pin ? { pin: password } : { password }) : null;
  return codeSymbols(code).length === CODE_SYMBOLS ? { recoveryCode: code } : null;
}

export function RecoveryKeyStep(p: {
  rt: Runtime;
  /** The ids' prefix: `${id}-new`, `${id}-current` (the choice), `${id}-pw`, `${id}-code` (the fields). */
  id: string;
  source: RecoveryKeySource;
  onSource: (s: RecoveryKeySource) => void;
  password: string;
  onPassword: (v: string) => void;
  /** A new code confirmed with the PIN or the master password (ConfirmField, OWNER-DECISIONS/26): `password` is its value. */
  confirm?: Confirm;
  code: string;
  onCode: (v: string) => void;
  /** The code field's "I have shares instead" is on screen (a stale set is then said by the shares' entry). */
  onShares?: (on: boolean) => void;
  stale?: boolean;
  disabled?: boolean;
  words: RecoveryKeyWords;
  labelledBy?: string;
}) {
  return (
    <>
      <div class="sh-pick" role="radiogroup" aria-labelledby={p.labelledBy}>
        {(["new", "current"] as const).map((s) => (
          <label key={s} class={`sh-opt${p.source === s ? " on" : ""}`}>
            <input
              type="radio"
              name={`${p.id}-source`}
              id={`${p.id}-${s}`}
              checked={p.source === s}
              disabled={p.disabled}
              onChange={() => p.onSource(s)}
            />
            <span>{s === "new" ? p.words.new : p.words.current}</span>
          </label>
        ))}
      </div>
      {p.source === "new" ? (
        <>
          {p.confirm ? (
            <ConfirmField c={p.confirm} id={`${p.id}-pw`} label={t("passwordLabel")} rt={p.rt} disabled={p.disabled} />
          ) : (
            <MasterField
              id={`${p.id}-pw`}
              label={t("passwordLabel")}
              value={p.password}
              onValue={p.onPassword}
              rt={p.rt}
              disabled={p.disabled}
            />
          )}
          <p class="callout" id={`${p.id}-new-note`}>
            {p.words.newNote}
          </p>
        </>
      ) : (
        <>
          <RecoveryCodeInput
            id={`${p.id}-code`}
            label={t("recoveryLabel")}
            value={p.code}
            onValue={p.onCode}
            {...(p.onShares ? { onShares: p.onShares } : {})}
            {...(p.stale !== undefined ? { stale: p.stale } : {})}
            {...(p.disabled !== undefined ? { disabled: p.disabled } : {})}
          />
          <p class="muted" id={`${p.id}-current-note`}>
            {p.words.currentNote}
          </p>
        </>
      )}
    </>
  );
}
