// The master password's and the keys' operations (enable it, change it, a new recovery code, a new key), held by the page
// and not by the section that asks for them: they take a second or more (the key derivation), they change what the
// vault is, and a new recovery code is shown the moment its change has committed (onCode, GM2-1). A person who leaves the
// section meanwhile (a link, Back) must still be shown the code, and the outcome: a code that was committed and never seen
// is a vault that cannot be recovered. App draws the code above every section (RecoveryCodeBox) until the person has
// saved it; the forms hold only what is typed, and hand it over when they submit.
import { useCallback, useRef, useState } from "preact/hooks";
import { ServiceError, type PreparedShares, type Secret } from "../core/service/service";
import type { Runtime } from "../platform/runtime";
import { t } from "../ui/i18n";
import { masterAccepts, measure } from "../ui/strength";
import { errText } from "./shared";

export type KeyOps = {
  /** An operation is under way (one at a time). */
  busy: boolean;
  /** The new recovery code, committed and not yet saved by the person. */
  code: string | null;
  /** The last operation's refusal, or what it did; cleared by the next operation or `clear()`. */
  error: string | null;
  info: string | null;
  clear: () => void;
  /**
   * Each resolves true when the operation went through. `anyway`: the user pressed "Use anyway" for this new password
   * (masterAccepts; OWNER-DECISIONS/15).
   */
  enable: (pw: string, anyway: boolean) => Promise<boolean>;
  change: (old: string, pw: string, anyway: boolean) => Promise<boolean>;
  /** The PIN or the master password (a Secret, OWNER-DECISIONS/26); `say`: the PIN's own refusals (useConfirm). */
  newCode: (secret: Secret, say?: (e: unknown) => string | null) => Promise<boolean>;
  rotate: (pw: string) => Promise<boolean>;
  /**
   * The shares wizard's switch (ShareWizard.tsx; docs/design/notes/SHAMIR-NOTES.md §4): the test restore's shares, and
   * the new recovery code they rebuild committed. No code to show (the shares were shown before); its outcome is the
   * page's, so a person who left the leaf meanwhile is told, and the page asks before it is closed while it runs.
   */
  confirmShares: (
    prepared: PreparedShares,
    typed: readonly string[],
    /**
     * The wizard's words for an error of the shares themselves (another set, a typo: SHAMIR-NOTES.md §5), or null for
     * any other, which the page says as it says every error. Its text is the shares' own (lazy) catalog's.
     */
    say?: (e: unknown) => string | null,
  ) => Promise<boolean>;
  /** The code was saved: it leaves the screen. */
  codeSaved: () => void;
  /**
   * The key was just replaced here (rotate): Password and recovery offers to turn Touch ID back on with one touch
   * (DeviceBox.tsx DeviceAfterKeyChange; OWNER-DECISIONS/17 Q3) until `clear()`.
   */
  rotated?: boolean;
};

export function useKeyOps(rt: Runtime, reload: () => Promise<void>): KeyOps {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);
  const running = useRef(false);

  const run = useCallback(
    async (fn: () => Promise<void>, done?: string, say?: (e: unknown) => string | null): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        await fn();
        if (done) setInfo(done);
        return true;
      } catch (e) {
        setError(say?.(e) ?? errText(e));
        await reload(); // the operation may have gone through before the error; show what is true
        return false;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [reload],
  );

  return {
    busy,
    code,
    error,
    info,
    rotated,
    clear: () => {
      setError(null);
      setInfo(null);
      setRotated(false);
    },
    // the page's rule for a master password once more before writing (the floor, and 50 bits or "Use anyway"): the
    // button's answer may be a frame old
    enable: (pw, anyway) =>
      run(async () => {
        if (!masterAccepts(await measure(pw), anyway)) throw new ServiceError("weak_password");
        await rt.service.enableMasterPassword(pw, { onCode: setCode });
      }),
    change: (old, pw, anyway) =>
      run(async () => {
        if (!masterAccepts(await measure(pw), anyway)) throw new ServiceError("weak_password");
        await rt.service.changePassword(old, pw);
      }, t("passwordChanged")),
    newCode: (secret, say) =>
      run(
        async () => {
          await rt.service.newRecoveryCode(secret, { onCode: setCode });
        },
        undefined,
        say,
      ),
    rotate: (pw) =>
      run(async () => {
        await rt.service.rotateKey(pw, { onCode: setCode });
        setRotated(true);
      }),
    confirmShares: (prepared, typed, say) =>
      run(
        async () => {
          await rt.service.confirmShares(prepared, typed);
        },
        t("sharesSwitched"),
        say,
      ),
    codeSaved: () => setCode(null),
  };
}
