// The settings page's recovery code input with "I have shares instead" (docs/design/notes/SHAMIR-NOTES.md §5): the one
// code field (shared.tsx CodeField) and, a click away, the shares' entry (ui/ShareEntry.tsx, a lazy chunk with its own
// text), which rebuilds the recovery code from shares and hands it to the host as if it had been typed: `onValue` gets
// the code's symbols in both cases, and the host uses them exactly as before (the reset, the Sync section's turn-on,
// join, key operations and repair; the shares wizard's "split my current code"). Either way, nothing is kept here: the
// field and the entry each let go of what they hold at a lock, when the page goes away and when they are unmounted
// (switching between them unmounts the other one).
import { useState } from "preact/hooks";
import { formatRecoveryCode } from "../core/crypto/recovery-code";
import { LOCK_EPOCH_KEY } from "../platform/session";
import { logError } from "../ui/errors";
import { t } from "../ui/i18n";
import { CodeField } from "./shared";
import { codeSymbols } from "./code-text";

const shareEntry = () => import("../ui/ShareEntry");

export type RecoveryCodeInputProps = Parameters<typeof CodeField>[0] & {
  /** The host's last attempt with the code rebuilt from shares did not open the vault: the entry says why. */
  stale?: boolean;
  /** Whether the shares' entry is on screen (the host tells a stale share set from a wrong typed code). */
  onShares?: (on: boolean) => void;
};

export function RecoveryCodeInput(p: RecoveryCodeInputProps) {
  const [Entry, setEntry] = useState<Awaited<ReturnType<typeof shareEntry>>["ShareEntry"] | null>(null);
  const [shares, setShares] = useState(false);
  const { stale, onShares, ...field } = p;
  const to = (on: boolean) => {
    setShares(on);
    onShares?.(on);
    p.onValue("");
  };
  if (shares && Entry)
    return (
      <Entry
        id={`${p.id}-shares`}
        lockKey={LOCK_EPOCH_KEY}
        toCode={formatRecoveryCode}
        autoFocus
        disabled={p.disabled}
        stale={stale}
        onCode={(code) => p.onValue(code ? codeSymbols(code) : "")}
        onCodeField={() => to(false)}
      />
    );
  return (
    <>
      <CodeField {...field} />
      <div class="row2">
        <button
          type="button"
          class="btn sm ghost"
          id={`${p.id}-shares-link`}
          disabled={p.disabled}
          onClick={() =>
            void shareEntry().then(
              (m) => {
                setEntry(() => m.ShareEntry);
                to(true);
              },
              (e) => logError("settings shares entry", e),
            )
          }
        >
          {t("sharesInsteadLink")}
        </button>
      </div>
    </>
  );
}
