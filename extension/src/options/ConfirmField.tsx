// The PIN or the master password typed again for what is done while Sixkey is unlocked (OWNER-DECISIONS/26, 2026-11-24:
// every copy of the master password is one more exposure): deleting for good, clearing the security record, setting,
// changing or removing the PIN, a new recovery key, Touch ID / Windows Hello. With a PIN that opens Sixkey
// now (RestartAdmin.state "pin"), the field asks for the PIN, and "Use master password" is the way back; without one, the
// master password's own field (MasterField) as before. What is typed goes to the service as a Secret
// (VaultService.confirmSecret), which counts a PIN with the lock screens' 5 tries; after its refusals the field shows the
// master password (the 5th wrong PIN, a PIN that no longer confirms). Key changes keep the master password: it is what
// the new key is wrapped under. The export's own field is Backup.tsx's.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { RestartAdmin } from "../core/service/pin-restart-admin";
import { ServiceError, type Secret } from "../core/service/service";
import type { Runtime } from "../platform/runtime";
import { t } from "../ui/i18n";
import { MasterField } from "./MasterField";

export type Confirm = ReturnType<typeof useConfirm>;

/**
 * One form's confirmation: what is typed, and whether it is the PIN. The PIN's state is read when the page shows
 * unlocked (and by `reread`, after the PIN itself changed); a lock empties the field.
 */
export function useConfirm(rt: Runtime, unlocked: boolean) {
  const restart = useMemo(() => new RestartAdmin(rt.service), [rt]);
  const [tries, setTries] = useState<number | null>(null);
  const [withPassword, setWithPassword] = useState(false);
  const [value, setValue] = useState("");
  const typed = useRef("");
  typed.current = value;
  const reread = () =>
    void restart.state().then(
      (v) => {
        const n = v?.state === "pin" && v.triesLeft > 0 ? v.triesLeft : null;
        // the field is never swapped under the user's fingers (as MasterField's input): typing already begun in the
        // master password's field stays there
        if (n !== null && tries === null && typed.current !== "") setWithPassword(true);
        setTries(n);
      },
      () => setTries(null),
    );
  useEffect(() => {
    if (unlocked) reread();
    else {
      setValue(""); // not left in the field for whoever sits down next
      setTries(null);
    }
  }, [unlocked]);
  const byPin = tries !== null && !withPassword;
  return {
    byPin,
    /** A PIN that opens Sixkey now: the switch between the PIN and the master password is offered. */
    canPin: tries !== null,
    value,
    setValue,
    secret: (): Secret => (byPin ? { pin: value } : value),
    use(password: boolean) {
      setWithPassword(password);
      setValue("");
    },
    /**
     * After the service refused: the line for the PIN's own refusals (null: the page's errText), the field emptied; the
     * 5th wrong PIN and a PIN that no longer confirms leave the master password's field.
     */
    refused(e: unknown): string | null {
      if (!(e instanceof ServiceError)) return null;
      // what was typed for the confirmation goes when it was refused; another refusal (a new PIN too short) keeps it
      if (e.code === "wrong_secret" || e.code.startsWith("pin_")) setValue("");
      if (e.code === "pin_wrong") {
        const n = Number(e.message);
        setTries(n);
        return t("pinWrong", n);
      }
      if (e.code === "pin_typo") return t("pinFormat");
      if (e.code === "pin_exhausted" || e.code === "pin_ended") {
        setTries(null);
        return t(e.code === "pin_exhausted" ? "pinExhausted" : "lockPinWaiting");
      }
      return null;
    },
    /** What the PIN offers read again (after it was set, changed or removed here). */
    reread,
  };
}

/**
 * The field: the PIN's (`<id>-pin`) or the master password's (`<id>`), and the switch between them (`<id>-switch`)
 * while a PIN opens Sixkey. `children`: the page's line about the field, shown with either.
 */
export function ConfirmField(p: {
  c: Confirm;
  rt: Runtime;
  id: string;
  label: string;
  fieldId?: string;
  describedBy?: string;
  disabled?: boolean;
  autocomplete?: string;
  inputRef?: { current: HTMLInputElement | null };
  children?: preact.ComponentChildren;
}) {
  const { c } = p;
  return (
    <>
      {c.byPin ? (
        <div class="field" id={p.fieldId}>
          <label for={`${p.id}-pin`}>{t("pinLabel")}</label>
          <input
            id={`${p.id}-pin`}
            ref={p.inputRef}
            class="mono-pw"
            type="password"
            inputMode="numeric"
            autocomplete="off"
            maxLength={8}
            aria-describedby={p.describedBy}
            value={c.value}
            disabled={p.disabled}
            onInput={(e) => c.setValue((e.target as HTMLInputElement).value)}
          />
          {p.children}
        </div>
      ) : (
        <MasterField
          id={p.id}
          fieldId={p.fieldId}
          label={p.label}
          value={c.value}
          onValue={c.setValue}
          rt={p.rt}
          describedBy={p.describedBy}
          disabled={p.disabled}
          autocomplete={p.autocomplete}
          inputRef={p.inputRef}
        >
          {p.children}
        </MasterField>
      )}
      {c.canPin && (
        <div class="row2">
          <button
            type="button"
            id={`${p.id}-switch`}
            class="btn sm quiet"
            disabled={p.disabled}
            onClick={() => c.use(c.byPin)}
          >
            {t(c.byPin ? "useMasterPassword" : "usePin")}
          </button>
        </div>
      )}
    </>
  );
}
