// First run's parts of the backup in Chrome's sync storage, in its lazy chunk with its text (src/ui/csb-text.ts):
//   - CsbFound: on a new install, above the master password, a copy found in Chrome Sync (or one that arrives while the
//     page is open): "从 Chrome 同步恢复" first, "新建" kept. Read only (read.ts), never waited for.
//   - CsbRestore: the restore step. No sign-in: the copies in Chrome Sync, watched while the step is open (a copy still
//     arriving is never used: the step says so and goes on when it is whole), then one field for the master password or
//     the recovery key. What it opens is opened here (open.ts); the worker never sees what was typed.
//   - CsbBox: the last step's box, "自动备份到 Chrome 同步（推荐）", ticked for a profile declared "only me" and not for a
//     shared one, with what it costs beside it. Nothing is written before "完成", and nothing
//     while the vault has no account.
//   - CsbAfter: at the end, what a restore found (the lines that apply), the newer master password elsewhere, and how
//     the backup goes on when it does not continue the copy restored from.
import { useEffect, useState } from "preact/hooks";
import type { Runtime } from "../../platform/runtime";
import { cs, isChrome } from "../../ui/csb-text";
import { getLang } from "../../ui/i18n";
import { masterAccepts, measure, type Strength } from "../../ui/strength";
import { ServiceError } from "../../core/service/service-error";
import { Icon } from "../icons";
import { BoxTitle, errText, PasswordFields } from "../shared";
import type { BackupOutcome } from "./merge";
import { ago } from "./model";
import { openBackups, resultLines, type CsbOpened } from "./open";
import { watchSlots, type SlotList } from "../../platform/csb-read";

/** Whether the catalog is in (nothing of the backup is drawn without its words). */
function useWords(): boolean {
  const [ready, setReady] = useState(cs.words() != null);
  useEffect(() => {
    void cs.loaded.then(() => setReady(cs.words() != null));
  }, []);
  return ready;
}

/** What the area holds when it could not be read: nothing found. */
const NOTHING: SlotList = { slots: [], intact: [], latest: null, partial: [], invalid: [], newer: [], foreign: [] };

/**
 * The copies in Chrome Sync, read now and after each change while mounted, and whether the first read already had a
 * whole one (else a whole one found later "just arrived"); null until the first read ends. `failed`: the last read
 * could not be made (the area not answering, or none in this browser): nothing found, said so, and the next change of
 * the area reads it again.
 */
function useSlots(): { list: SlotList; firstHad: boolean; failed: boolean } | null {
  const [seen, setSeen] = useState<{ list: SlotList; firstHad: boolean; failed: boolean } | null>(null);
  useEffect(() => {
    const failed = () =>
      setSeen((was) => ({ list: was?.list ?? NOTHING, firstHad: was?.firstHad ?? false, failed: true }));
    try {
      return watchSlots(
        (list) => setSeen((was) => ({ list, firstHad: was ? was.firstHad : list.intact.length > 0, failed: false })),
        { onError: (_e, from) => from === "read" && failed() },
      );
    } catch {
      failed(); // no storage.sync here
      return undefined;
    }
  }, []);
  return seen;
}

export function CsbFound({ onRestore }: { onRestore: () => void }) {
  const ready = useWords();
  const seen = useSlots();
  const latest = seen?.list.latest ?? null;
  if (!ready || !seen || latest === null) return null;
  return (
    <div class="callout good" id="cs-found" role="status">
      <Icon name="sync" size={16} />
      <span>
        {seen.firstHad ? cs("csFoundAt", ago(latest, Date.now(), getLang())) : cs("csArrived")}{" "}
        <button class="btn sm" id="cs-found-restore" onClick={onRestore}>
          {cs("csRestore")}
        </button>
      </span>
    </div>
  );
}

export function CsbRestore({ rt, onOpened }: { rt: Pick<Runtime, "settings">; onOpened: (o: CsbOpened) => void }) {
  const ready = useWords();
  const seen = useSlots();
  const list = seen?.list ?? null;
  const [typed, setTyped] = useState("");
  const [opening, setOpening] = useState(false);
  const [wrong, setWrong] = useState<string | null>(null);
  async function open(ev: Event) {
    ev.preventDefault();
    if (!list || list.intact.length === 0 || opening) return;
    setOpening(true);
    setWrong(null);
    try {
      const r = await openBackups(list.intact, typed, { now: Date.now(), device: await rt.settings.deviceId() });
      if (!r) return setWrong(cs("csWrong"));
      if (r === "typo") return setWrong(cs("csKeyTypo"));
      onOpened({
        restore: r,
        typed,
        partial: list.partial.length,
        unusable: list.invalid.length + list.newer.length,
        slots: true,
      });
    } catch (e) {
      setWrong(errText(e)); // whatever else: said, never an unhandled rejection
    } finally {
      setOpening(false);
    }
  }
  if (!ready) return null;
  const found = list !== null && list.intact.length > 0;
  return (
    <div class="box" id="cs-restore">
      <BoxTitle icon="restore">
        <span tabIndex={-1}>{cs("csRestore")}</span>
      </BoxTitle>
      {list === null && (
        <p class="muted" id="cs-looking">
          {cs("csLooking")}
        </p>
      )}
      {list !== null && !found && (
        <p
          class={seen?.failed ? "callout warn" : "callout"}
          id={seen?.failed ? "cs-read-failed" : list.partial.length ? "cs-partial-only" : "cs-none"}
          role="status"
        >
          <Icon name={seen?.failed ? "alert" : "info"} size={16} />
          <span>{cs(seen?.failed ? "csReadFailed" : list.partial.length ? "csPartialOnly" : "csNone")}</span>
        </p>
      )}
      {found && (
        <form onSubmit={open}>
          <p id="cs-found-n">{cs("csFound", list.intact.length)}</p>
          {list.partial.length > 0 && (
            <p class="muted" id="cs-partial">
              {cs("csPartial", list.partial.length)}
            </p>
          )}
          <div class="field">
            <label for="cs-restore-secret">{cs("csSecret")}</label>
            <input
              id="cs-restore-secret"
              type="password"
              autocomplete="off"
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            />
          </div>
          {wrong && (
            <div class="err" role="alert" id="cs-wrong">
              <Icon name="alert" size={15} />
              {wrong}
            </div>
          )}
          <div class="row2">
            <button class="btn" type="submit" id="cs-open" disabled={!typed || opening}>
              {cs("csOpen")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function CsbBox({ on, shared, onChange }: { on: boolean; shared: boolean; onChange: (on: boolean) => void }) {
  const ready = useWords();
  if (!ready) return null;
  return (
    <div class="fr-csb" id="fr-csb-box">
      <label class="check hinted">
        <input
          type="checkbox"
          id="fr-csb"
          checked={on}
          onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        />
        <span>
          <span>{cs("csFrBox")}</span>
          <small class="muted">{cs("csFrHint")}</small>
        </span>
      </label>
      <p class="muted" id="fr-csb-cost">
        {cs("csCost")} {cs(isChrome() ? "csHonest" : "csBrowserUnknown")}
      </p>
      {shared && (
        <p class="muted" id="fr-csb-shared">
          {cs("csShared")}
        </p>
      )}
    </div>
  );
}

export function CsbAfter({ rt, opened, backup }: { rt: Runtime; opened?: CsbOpened; backup?: BackupOutcome }) {
  const ready = useWords();
  // the new master password's offer: after a password restore only; a recovery restore set one just now, and the typed
  // recovery key is no old password. Dropped once used or declined.
  const [typed, setTyped] = useState(opened?.restore.outdated && !opened.restore.needsPassword ? opened.typed : null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [anyway, setAnyway] = useState<string | null>(null); // "Use anyway" was pressed for this value
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ready) return null;

  async function setNew(ev: Event) {
    ev.preventDefault();
    if (typed === null) return;
    setError(null);
    try {
      // the master password's gate, as every page that sets one (the 50-bit warning, passed with "Use anyway")
      if (!masterAccepts(await measure(pw), anyway === pw)) throw new ServiceError("weak_password");
      await rt.service.changePassword(typed, pw);
      setTyped(null);
      setPw("");
      setPw2("");
      setDone(true);
    } catch (e) {
      setError(errText(e));
    }
  }
  const lines = opened ? resultLines(opened) : [];
  // how the backup goes on, as the last step's box left it (nothing said when the box was cleared)
  const note =
    backup === "adopted"
      ? "csAfter"
      : backup === "on"
        ? "csBackupOn"
        : backup === "new_copy"
          ? "csNewCopy"
          : backup === "unsafe"
            ? "csUnsafeArea"
            : null;
  return (
    <div id="cs-after">
      {lines.map(([k, n]) => (
        <p class="muted" key={k} id={`cs-line-${k}`}>
          {n === undefined ? cs(k) : cs(k, n)}
        </p>
      ))}
      {note && (
        <p class="muted" id="cs-backup-note">
          {cs(note)}
        </p>
      )}
      {typed !== null && (
        <form class="box" id="cs-outdated" onSubmit={(e) => void setNew(e)}>
          <p>{cs("csOutdated")}</p>
          <PasswordFields
            idPrefix="cs"
            value={pw}
            confirm={pw2}
            onValue={setPw}
            onConfirm={setPw2}
            onStrength={setStrength}
            anyway={{ value: anyway, set: setAnyway }}
          />
          {error && (
            <div class="err" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
          <div class="row2">
            <button
              class="btn"
              type="submit"
              id="cs-set-new"
              disabled={!pw || pw !== pw2 || !masterAccepts(strength, anyway === pw)}
            >
              {cs("csSetNew")}
            </button>
            <button class="btn ghost" type="button" id="cs-later" onClick={() => setTyped(null)}>
              {cs("csLater")}
            </button>
          </div>
        </form>
      )}
      {done && (
        <p class="callout good" id="cs-new-set" role="status">
          <Icon name="check" size={16} />
          <span>{cs("csNewSet")}</span>
        </p>
      )}
    </div>
  );
}
