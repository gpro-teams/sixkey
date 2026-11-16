// The built-in autofill's switch (docs/design/proposals/MOD-PLATFORM.md §7.2 Option I item 2; PLUGINS-W1B-NOTES.md):
// "Autofill" with On/Off, on its own page, Settings › Security › Autofill (which loads it as a chunk of its own:
// options/Misc.tsx), with the request log's last lines for autofill under it ("Recent requests"). The switch is a tagged
// write, so it is shown only while Sixkey is unlocked; the sites' list below it on the autofill page works locked, as
// before.
//   - On: Chrome's request is the first statement of the click (`scripting` and the listed sites' patterns, in one), then
//     the switch (platform/plugins/autofill-switch.ts).
//   - Off: the switch and the page hint; the worker then unregisters the content script and gives back each site's grant
//     and `scripting`; the list is kept.
//   - A record whose tag fails: the switch shows what the record says, read tighten-only as the gate and the worker read
//     it (autofill-switch.ts switchRecord), with the line that the setting could not be checked. A flip writes a new,
//     tagged record.
//   - Recent requests: the last ten lines of the request log (storage.session, core/plugins/session.ts) that autofill's
//     fills wrote, newest first, read with the switch; nothing when there are none. Each is its time and its outcome
//     in words (the log's own are protocol words); its type is autofill's one, `codes.forPage`, so it is not shown.
//   - The removed plugin platform's page hint (sk_plugins_any, page localStorage), which nothing reads now, is taken out
//     where the switch is read.
// Its words are a catalog of its own (src/ui/plugins/text.ts), loaded with this chunk.
import { useCallback, useEffect, useState } from "preact/hooks";
import { AUTOFILL_ID, autofillOn } from "../core/plugins/builtin";
import type { LogEntry } from "../core/plugins/session";
import { readList, setOffHint } from "../platform/autofill-sites";
import { CleanupPendingError, runPendingCleanup, withFreshKeys } from "../core/plugins/store";
import { askAutofillOn, switchRecord, turnAutofillOff, turnAutofillOn } from "../platform/plugins/autofill-switch";
import { pluginSession } from "../platform/plugins/chrome";
import { formatDateTime } from "../ui/i18n";
import { px } from "../ui/plugins/text";
import type { Ctx } from "./shared";

/** The chunk waits for its text before it draws (Misc.tsx's host). */
export const prepare = (): Promise<void> => px.loaded;

/** A line's outcome in words: the gate's three (autofill-gate.ts), and any other word an earlier version wrote. */
const outcomeKey = (o: string) =>
  o === "ok" ? "pxLogOk" : o === "locked" ? "pxLogLocked" : o === "disabled" ? "pxLogOff" : "pxLogOther";

/** The removed plugin platform's page hint: nothing reads it now. */
const OLD_HINT = "sk_plugins_any";

/** Autofill's own lines of the request log: its last ten, newest first. */
const autofillLines = (log: readonly LogEntry[]): LogEntry[] =>
  log
    .filter((l) => l.pluginId === AUTOFILL_ID)
    .slice(-10)
    .reverse();

export function AutofillSwitch({ rt, status, onChange }: Pick<Ctx, "rt" | "status"> & { onChange?: () => void }) {
  const unlocked = status.state === "unlocked";
  // null: not known (locked, or not read yet)
  const [on, setOn] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(true);
  const [hosts, setHosts] = useState<string[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  // a flip refused while a key change is being finished (W2A-01): nothing was written; the switch shows the record
  const [retry, setRetry] = useState(false);
  const load = useCallback(async () => {
    const r = unlocked ? await withFreshKeys(() => rt.service.grantKeys(), switchRecord) : null;
    if (!r) return setOn(null);
    const now = autofillOn(r.plugins);
    setOffHint(!now); // the page hint follows the record (autofill-switch.ts)
    try {
      localStorage.removeItem(OLD_HINT);
    } catch {
      // no page storage: nothing kept there either
    }
    setChecked(r.verified);
    setOn(now);
    setHosts(await readList());
    // the log is only shown: one that cannot be read is no reason to hide the switch
    setLog(
      autofillLines(
        await pluginSession()
          .log()
          .catch((): LogEntry[] => []),
      ),
    );
    onChange?.(); // the page around it follows the hint too (Misc.tsx)
  }, [rt, unlocked]);
  useEffect(() => void load().catch(() => setOn(null)), [load]);
  if (on === null) return null;
  function flip(next: boolean): void {
    // On: Chrome's request first, in the click's gesture (nothing is awaited before it)
    const asked = next ? askAutofillOn(hosts) : null;
    setBusy(true);
    setRetry(false);
    void (async () => {
      try {
        const granted = asked ? await asked : false;
        // a tagged write: with a fresh key if a key change retired the one read first (N2), and again in a moment while
        // that change is being finished (W2A-01)
        await withFreshKeys(
          () => rt.service.grantKeys(),
          (k) => (asked ? turnAutofillOn(k, granted) : turnAutofillOff(k)),
        );
      } catch (e) {
        if (!(e instanceof CleanupPendingError)) throw e;
        setRetry(true);
        void runPendingCleanup(rt); // the clean-up an open would run, once (r3)
      } finally {
        setBusy(false);
        await load().catch(() => undefined);
      }
    })();
  }
  return (
    <div id="af-switch">
      <label class="check">
        <input
          type="checkbox"
          id="af-on"
          checked={on}
          disabled={busy}
          onChange={(e) => flip((e.target as HTMLInputElement).checked)}
        />{" "}
        <b>{px("pxAfName")}</b>
      </label>
      <p class="muted">{px("pxAfOff")}</p>
      {retry && <p class="callout warn">{px("pxTryAgain")}</p>}
      {!checked && <p class="callout warn">{px("pxBadTag")}</p>}
      {log.length > 0 && (
        <details class="af-log" id="af-log">
          <summary>{px("pxRecent")}</summary>
          <ul>
            {log.map((l, i) => (
              <li key={i}>
                <span class="muted">{formatDateTime(l.at)}</span> {px(outcomeKey(l.outcome))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
