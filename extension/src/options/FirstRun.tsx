// First run (PHASE0X-PLAN A1; SYNC-DESIGN H1, H5, Z1, Z2). Every way to get a vault (new, restored from a backup, started
// over after unreadable data) takes the same steps, here in the settings tab and never in the popup: the popup closes as
// soon as focus leaves it (to a password manager, to the downloaded code file) and would take an unsaved code with it.
//   1. master password   prepareKeys: the keys exist in this page's memory only
//   2. recovery code     shown, copied or saved as a file, confirmed
//   3. one question      the security preset (ux-study §2.8)
//   4. first account     the normal page, at "Add accounts" (App, with SetupReady)
// The vault is written once, when step 3 is finished, together with the answer. Closing the tab before that leaves nothing
// behind. Everything uses the page's one runtime and the page is never reloaded: in "lock every time" mode the unlocked
// key exists only in this page's memory.
import { useEffect, useRef, useState } from "preact/hooks";
import { BackupError, openBackup, parseBackupFile } from "../core/backup/backup";
import type { PresetId } from "../core/service/presets";
import { ServiceError, type PreparedKeys } from "../core/service/service";
import type { Vault } from "../core/vault/model";
import type { Runtime } from "../platform/runtime";
import { formatDateTime, t } from "../ui/i18n";
import { Icon } from "./icons";
import { masterAccepts, measure, type Strength } from "../ui/strength";
import { BoxTitle, errText, Panel, PasswordFields, RecoveryCodeBox } from "./shared";
import { cs } from "../ui/csb-text";
import type { CsbOpened } from "./csb/open";
import type { BackupOutcome } from "./csb/merge";
import "./firstrun.css";

export type OpenedBackup = { vault: Vault; created: number };
/** How the wizard was entered. A restore may arrive with its backup already opened (the Backup panel did that part). */
export type SetupStart =
  | { mode: "create" }
  | { mode: "restore"; backup?: OpenedBackup }
  | { mode: "startOver" }
  // the restore from the backup in Chrome's sync storage (#setup-csb, Backup's restore, the found copy's button): its
  // step lists the copies there; `opened`, a downloaded copy of that backup "Choose file" already opened (Backup.tsx),
  // which has no copy in Chrome Sync to continue
  | { mode: "csb"; opened?: CsbOpened };
/** What the wizard hands the page at its end (SetupReady): accounts restored, what a restore opened, the backup. */
export type SetupDone = { restored?: number; opened?: CsbOpened; backup?: BackupOutcome };

type Step = "file" | "csb" | "password" | "code" | "risk" | "clipboard";
/** The backup in Chrome's sync storage's parts (the found copy, its restore step, the last step's box), one lazy chunk. */
const csbPages = () => import("./csb/CsbPages");
const CLIP: chrome.permissions.Permissions = { permissions: ["clipboardRead", "clipboardWrite"] };
const live = (v: Vault) => v.entries.filter((e) => e.secret !== "").length;

export function FirstRun({
  rt,
  start,
  onSwitch,
  onExit,
  onDone,
  onRefresh,
  onHolding,
}: {
  rt: Runtime;
  start: SetupStart;
  /** Fresh install only: switch between starting empty and restoring. */
  onSwitch?: (s: SetupStart) => void;
  /** Leave without writing anything (back to the page), or after another page got there first. */
  onExit: () => void;
  /** The vault exists and is unlocked in this page: show the page at "Add accounts". */
  onDone: (r: SetupDone) => void;
  /** Re-read what is stored, after a write that failed: it may have landed anyway (the rail then shows the truth). */
  onRefresh: () => Promise<void>;
  /** Whether prepared keys exist (shown code, nothing written yet): the page must not reload meanwhile. */
  onHolding: (holding: boolean) => void;
}) {
  const [backup, setBackup] = useState<OpenedBackup | null>(start.mode === "restore" ? (start.backup ?? null) : null);
  const [step, setStep] = useState<Step>(
    start.mode === "csb" ? "csb" : start.mode === "restore" && !start.backup ? "file" : "password",
  );
  const [opened, setOpened] = useState<CsbOpened | null>(null);
  const [Csb, setCsb] = useState<Awaited<ReturnType<typeof csbPages>> | null>(null);
  // the last step's box: ticked for "only me", not for a shared profile, unless the person ticked or cleared it
  const [csbPick, setCsbPick] = useState<boolean | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [anyway, setAnyway] = useState<string | null>(null); // "Use anyway" was pressed for this value
  const [keys, setKeys] = useState<PreparedKeys | null>(null);
  const [risk, setRisk] = useState<PresetId>("standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const stepRef = useRef<HTMLDivElement>(null);

  // Between preparing and writing, leaving the page (closing it, the language switch's reload) would make the code the
  // user may already have saved worthless. Nothing is lost by leaving, but ask first.
  // The language menu, which reloads the page, is held still meanwhile (onHolding).
  useEffect(() => {
    onHolding(keys !== null);
    if (!keys) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => {
      removeEventListener("beforeunload", warn);
      onHolding(false);
    };
  }, [keys]);

  // The backup in Chrome's sync storage: its parts, loaded at once (the copy found above the first step, the restore
  // step, the last step's box); a downloaded copy already opened (Choose file) goes on to its keys at once.
  useEffect(() => {
    void csbPages().then(
      (m) => setCsb(() => m),
      () => undefined, // not loaded: no box (the backup stays off), and the restore step waits
    );
    if (start.mode === "csb" && start.opened) csbOpened(start.opened);
  }, []);

  // Each later step starts at its heading, for keyboard and screen reader users.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    stepRef.current?.querySelector<HTMLElement>('[tabindex="-1"]')?.focus();
  }, [step]);

  async function run(fn: () => Promise<void>, wrote = false) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      // bad_state: another page made or replaced the vault meanwhile (the service refused before writing anything; a
      // vault that holds these very keys, written by an attempt that reported an error, is not refused but finished).
      if (e instanceof ServiceError && e.code === "bad_state") setChanged(true);
      else {
        setError(errText(e));
        if (wrote) await onRefresh().catch(() => undefined); // the write may have gone through before the error
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * A restore from Chrome Sync (or a downloaded copy) opened: its keys as they were restored, with the password typed; a
   * recovery-key restore is the reset, so a new master password first (the password step). No new recovery code.
   */
  const csbOpened = (o: CsbOpened) =>
    void run(async () => {
      setOpened(o);
      // a recovery-key restore: the password step, where the copy's master password goes on (keepsPassword) or a new
      // one is set (a forgotten password; and the only way when the copy had no password wrap, needsPassword)
      if (o.restore.needsPassword || o.restore.keepsPassword) return setStep("password");
      setKeys(await rt.service.prepareRestoredKeys(o.restore.keyring, o.restore.vk, { typed: o.typed }));
      setStep("risk");
    });

  /**
   * Back to the master password (the owner's report of 2026-11-18: no way back once it was set). Nothing has been
   * written yet: the keys made for that password are only in this page, and are dropped; the next one makes new keys,
   * with a new recovery code.
   */
  const backToPassword = () => {
    setKeys(null);
    setError(null);
    setStep("password");
  };
  /** The profile step's way back: to the recovery code of a new vault, or to a restore's password step; none else. */
  const backFromRisk: (() => void) | null =
    opened && (opened.restore.needsPassword || opened.restore.keepsPassword)
      ? backToPassword
      : !opened && keys !== null && keys.recoveryCode !== ""
        ? () => setStep("code")
        : null;

  /** A recovery-key restore going on with the master password the copy already had: nothing to type, nothing new. */
  const keepPassword = () =>
    void run(async () => {
      if (!opened) return;
      setKeys(await rt.service.prepareRestoredKeys(opened.restore.keyring, opened.restore.vk, { keep: true }));
      setStep("risk");
    });

  const submitPassword = (ev: Event) => {
    ev.preventDefault();
    void run(async () => {
      // The service holds every password to the floor; the 50-bit estimate is the pages' (a warning for the master
      // password, passed with "Use anyway": OWNER-DECISIONS/15), checked here once more than the disabled button does.
      if (opened) {
        // a recovery restore's new master password (the reset): the same gate; no new recovery code after it
        if (!masterAccepts(await measure(pw), anyway === pw)) throw new ServiceError("weak_password");
        const k = await rt.service.prepareRestoredKeys(opened.restore.keyring, opened.restore.vk, { newPassword: pw });
        setPw("");
        setPw2("");
        setKeys(k);
        return setStep("risk");
      }
      if (!masterAccepts(await measure(pw), anyway === pw)) throw new ServiceError("weak_password");
      const k = await rt.service.prepareKeys(pw, backup ? { vaultId: backup.vault.vaultId } : {});
      setPw("");
      setPw2("");
      setKeys(k);
      setStep("code");
    });
  };

  // The last step's box: ticked for "only me", not for a shared profile, unless the person ticked
  // or cleared it themselves; shown, and so taken, only once the backup's parts are loaded.
  const csbOn = Csb !== null && (csbPick ?? risk !== "shared");
  const [outcome, setOutcome] = useState<BackupOutcome | undefined>(undefined);
  const finish = () =>
    void run(async () => {
      if (!keys) return;
      // The answer goes in with the vault, in one locked step (VaultService.saveChoice): written after the check that no
      // vault appeared and before the key, so "lock every time" keeps the key in this page and the user stays unlocked.
      // Then the backup in Chrome sync, as the box says: ticked, turned on (nothing is written while the vault is empty),
      // or, after a restore from it, continuing the copy restored from (merge.ts finishRestore, which writes the vault);
      // cleared, off, also where it was on already (a first run over data that could not be read), and where it was
      // ticked for the person, recorded as their turning it off (merge.ts boxCleared).
      const choice = { preset: risk };
      let b: BackupOutcome | undefined;
      if (start.mode === "csb" && opened) {
        b = Csb
          ? await Csb.finishRestore(rt, { opened, keys, choice, backup: csbOn })
          : (await rt.service.restoreBackup(opened.restore.vault, keys, choice), undefined);
      } else {
        if (start.mode === "create") await rt.service.create(keys, choice);
        else if (start.mode === "startOver") await rt.service.startOver(keys, choice);
        else if (backup) await rt.service.restoreBackup(backup.vault, keys, choice);
        else return;
        if (csbOn && Csb) b = await Csb.turnOn();
        else if (Csb) await Csb.boxCleared(rt, risk === "shared"); // the box cleared: off, as the person's choice
      }
      setKeys(null);
      setOutcome(b);
      if (risk === "shared") setStep("clipboard");
      else done(b);
    }, true);
  const done = (b = outcome) =>
    onDone({
      ...(start.mode === "csb" && opened
        ? { restored: live(opened.restore.vault), opened }
        : start.mode === "restore" && backup
          ? { restored: live(backup.vault) }
          : {}),
      ...(b ? { backup: b } : {}),
    });

  // the restore from Chrome Sync's first step stands where a file's would, named by the backup's own text (null here: it
  // is no key of the page's catalog); a downloaded copy's is a file's, and named as one
  const steps: (string | null)[] =
    start.mode === "csb"
      ? [
          start.opened ? "frStepFile" : null,
          ...(opened?.restore.needsPassword || opened?.restore.keepsPassword ? ["stepPassword"] : []),
          "frStepProfile",
          "frStepAccount",
        ]
      : [
          ...(start.mode === "restore" ? ["frStepFile"] : []),
          "stepPassword",
          "stepRecovery",
          "frStepProfile",
          "frStepAccount",
        ];
  const at = steps.indexOf(
    {
      file: "frStepFile",
      csb: start.mode === "csb" && start.opened ? "frStepFile" : null,
      password: "stepPassword",
      code: "stepRecovery",
      risk: "frStepProfile",
      clipboard: "frStepAccount",
    }[step],
  );
  const lead =
    start.mode === "restore" || start.mode === "csb"
      ? t("frRestoreLead")
      : start.mode === "startOver"
        ? t("frStartOverLead")
        : t("emptyOptions");
  const canPassword = !busy && pw.length > 0 && pw === pw2 && masterAccepts(strength, anyway === pw);
  // Leaving is always safe before the vault is written; switching what to start with only before keys exist, and never
  // at the clipboard step, which comes after the vault was written (its keys are gone from here by then).
  const canSwitch = !!onSwitch && !keys && !changed && !busy && step !== "clipboard";
  const canCancel = !onSwitch && !changed && step !== "clipboard" && !busy; // not while Finish is writing

  return (
    <Panel id="setup" icon="shieldCheck" title={t("frTitle")} lead={lead}>
      <ol class="steps fr-steps">
        {steps.map((k, i) => (
          <li
            key={k ?? "csb"}
            class={i < at ? "done" : i === at ? "on" : ""}
            aria-current={i === at ? "step" : undefined}
          >
            <i>{i < at ? <Icon name="check" size={13} /> : i + 1}</i>
            <span>{k === null ? (Csb ? cs("csStep") : "") : t(k)}</span>
          </li>
        ))}
      </ol>

      {changed ? (
        <div class="box warn" role="alert">
          <BoxTitle icon="alert">{t("frChanged")}</BoxTitle>
          <div class="row2">
            <button class="btn" id="fr-changed" onClick={onExit}>
              {t("continue")}
            </button>
          </div>
        </div>
      ) : (
        <div class="fr-step" ref={stepRef}>
          {step === "file" && (
            <BackupFileStep backup={backup} onOpened={setBackup} onNext={() => setStep("password")} />
          )}
          {step === "csb" && start.mode === "csb" && !start.opened && Csb && (
            <Csb.CsbRestore rt={rt} onOpened={csbOpened} />
          )}
          {/* a copy in Chrome Sync, found above the new vault's first step: restoring it comes first, "新建" stays */}
          {step === "password" && canSwitch && start.mode === "create" && Csb && (
            <Csb.CsbFound onRestore={() => onSwitch!({ mode: "csb" })} />
          )}

          {step === "password" && (
            <form class="box" onSubmit={submitPassword}>
              <BoxTitle icon="lock">
                <span tabIndex={-1}>{t("frPasswordTitle")}</span>
              </BoxTitle>
              {backup && (
                <p class="callout good">
                  <Icon name="archive" size={16} />
                  <span>{t("backupContains", live(backup.vault), formatDateTime(backup.created))}</span>
                </p>
              )}
              {opened && Csb && !opened.restore.keepsPassword && (
                <p class="callout good" id="cs-need-password">
                  <Icon name="restore" size={16} />
                  <span>{cs("csNeedPassword")}</span>
                </p>
              )}
              {opened && Csb && opened.restore.keepsPassword && (
                <>
                  <p class="callout good" id="cs-keep-line">
                    <Icon name="restore" size={16} />
                    <span>{cs("csKeepPasswordLine")}</span>
                  </p>
                  <div class="row2">
                    <button type="button" class="btn" id="cs-keep-password" disabled={busy} onClick={keepPassword}>
                      {cs("csKeepPassword")}
                    </button>
                  </div>
                  <p class="muted" id="cs-or-new">
                    {cs("csOrNewPassword")}
                  </p>
                </>
              )}
              <PasswordFields
                idPrefix="fr"
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
              <p class="callout">
                <Icon name="info" size={16} />
                <span>{t("passwordLossWarning")}</span>
              </p>
              {error && (
                <div class="err" role="alert">
                  <Icon name="alert" size={15} />
                  {error}
                </div>
              )}
              <div class="row2">
                <button id="fr-next" class="btn" type="submit" disabled={!canPassword}>
                  {busy ? t("frPreparing") : t("continue")}
                  {!busy && <Icon name="next" size={15} />}
                </button>
              </div>
            </form>
          )}

          {step === "code" && keys && (
            <>
              <p class="callout" id="fr-code-note" tabIndex={-1}>
                <Icon name="info" size={16} />
                <span>{t("frCodeNote")}</span>
              </p>
              {/* a vault that existed is replaced (start over, or a restore over unreadable data): shares of its recovery
                  code stop working with it (docs/design/notes/SHAMIR-NOTES.md §1) */}
              {(start.mode === "startOver" || (start.mode === "restore" && !onSwitch)) && (
                <p class="muted" id="fr-shares-note">
                  {t("sharesStopWarn")}
                </p>
              )}
              <RecoveryCodeBox code={keys.recoveryCode} onDone={() => setStep("risk")} />
              <div class="row2">
                <button type="button" class="btn ghost" id="fr-back-password" disabled={busy} onClick={backToPassword}>
                  <Icon name="back" size={15} />
                  {t("back")}
                </button>
              </div>
            </>
          )}

          {step === "risk" && (
            <div class="box">
              <BoxTitle icon="shield">
                <span tabIndex={-1}>{t("frRiskTitle")}</span>
              </BoxTitle>
              <p>{t("frRiskBody")}</p>
              <div class="fr-cards" role="radiogroup" aria-label={t("frRiskTitle")}>
                {(["standard", "shared"] as const).map((id) => (
                  <label key={id} class={`fr-card${risk === id ? " on" : ""}`}>
                    <input
                      type="radio"
                      name="fr-risk"
                      id={id === "standard" ? "fr-solo" : "fr-shared"}
                      checked={risk === id}
                      onChange={() => setRisk(id)}
                    />
                    <span>
                      <b>{t(id === "standard" ? "frSoloTitle" : "frSharedTitle")}</b>
                      <small>{t(id === "standard" ? "frSoloBody" : "frSharedBody")}</small>
                    </span>
                  </label>
                ))}
              </div>
              {Csb && <Csb.CsbBox on={csbOn} shared={risk === "shared"} onChange={(on) => setCsbPick(on)} />}
              <p class="callout">
                <Icon name="info" size={16} />
                <span>{t("frRiskNote")}</span>
              </p>
              {error && (
                <div class="err" role="alert">
                  <Icon name="alert" size={15} />
                  {error}
                </div>
              )}
              <div class="row2">
                {backFromRisk && (
                  <button type="button" class="btn ghost" id="fr-back" disabled={busy} onClick={backFromRisk}>
                    <Icon name="back" size={15} />
                    {t("back")}
                  </button>
                )}
                <button id="fr-finish" class="btn" disabled={busy} onClick={finish}>
                  <Icon name="check" size={15} />
                  {t("frFinish")}
                </button>
              </div>
            </div>
          )}

          {step === "clipboard" && <ClipboardStep onNext={() => done()} />}
        </div>
      )}

      {(canSwitch || canCancel) && (
        <div class="row2 fr-alt">
          {canSwitch && start.mode === "create" && (
            <button class="btn sm ghost" id="fr-to-restore" onClick={() => onSwitch!({ mode: "restore" })}>
              <Icon name="upload" size={15} />
              {t("frRestoreInstead")}
            </button>
          )}
          {canSwitch && start.mode === "create" && Csb && (
            <button class="btn sm ghost" id="fr-to-csb" onClick={() => onSwitch!({ mode: "csb" })}>
              <Icon name="sync" size={15} />
              {cs("csRestore")}
            </button>
          )}
          {canSwitch && start.mode !== "create" && (
            <button class="btn sm ghost" id="fr-to-create" onClick={() => onSwitch!({ mode: "create" })}>
              {t("frCreateInstead")}
            </button>
          )}
          {canCancel && (
            <button class="btn sm ghost" id="fr-cancel" onClick={onExit}>
              {t("cancel")}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Restore, before step 1: the backup file and its password. Its own ids: the Backup panel's are its contract (Appendix D). */
function BackupFileStep({
  backup,
  onOpened,
  onNext,
}: {
  backup: OpenedBackup | null;
  onOpened: (b: OpenedBackup | null) => void;
  onNext: () => void;
}) {
  const [pending, setPending] = useState<unknown>(null);
  const [openPw, setOpenPw] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    setError(null);
    onOpened(null);
    try {
      const json: unknown = JSON.parse(await file.text());
      parseBackupFile(json);
      setPending(json);
      setOpenPw("");
    } catch (e) {
      setError(e instanceof BackupError ? errText(e) : t("backupInvalid"));
    }
  }
  async function unlockFile(ev: Event) {
    ev.preventDefault();
    setError(null);
    try {
      onOpened(await openBackup(pending, openPw));
      setPending(null);
      setOpenPw("");
    } catch (e) {
      setError(e instanceof BackupError ? errText(e) : t("errorBody", "unknown"));
    }
  }
  return (
    <div class="box">
      <BoxTitle icon="upload">
        <span tabIndex={-1}>{t("restoreTitle")}</span>
      </BoxTitle>
      <p class="muted">{t("restoreBody")}</p>
      {error && (
        <p class="callout bad" role="alert" id="fr-backup-error">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
      <div class="row2">
        <label class="btn ghost sm" for="fr-backup-file">
          <Icon name="file" size={15} />
          {t("chooseFile")}
        </label>
        <input
          id="fr-backup-file"
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const el = e.target as HTMLInputElement;
            const f = el.files?.[0];
            if (f)
              void onFile(f).then(() => {
                el.value = "";
              });
          }}
        />
      </div>
      {pending !== null && (
        <form onSubmit={unlockFile}>
          <div class="field">
            <label for="fr-open-pw">{t("backupPasswordLabel")}</label>
            <input
              id="fr-open-pw"
              type="password"
              autocomplete="off"
              value={openPw}
              onInput={(e) => setOpenPw((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="row2">
            <button class="btn" id="fr-open" type="submit" disabled={!openPw}>
              {t("openBackup")}
            </button>
          </div>
        </form>
      )}
      {backup && (
        <>
          <p class="callout good">
            <Icon name="archive" size={16} />
            <span>{t("backupContains", live(backup.vault), formatDateTime(backup.created))}</span>
          </p>
          <div class="row2">
            <button id="fr-restore-next" class="btn" onClick={onNext}>
              {t("continue")}
              <Icon name="next" size={15} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Shared or automated profile, after the vault is made: offer clipboard clearing. The permission prompt is safe in a tab. */
function ClipboardStep({ onNext }: { onNext: () => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void chrome.permissions.contains(CLIP).then(setOn, () => setOn(false));
  }, []);
  return (
    <div class="box" id="fr-clip">
      <BoxTitle icon="clipboard">
        <span tabIndex={-1}>{t("clipTitle")}</span>
      </BoxTitle>
      <p>{t("frClipLead")}</p>
      <p class="muted">{t("clipBody")}</p>
      <div class="row2">
        {on ? (
          <span class="chip ok" id="fr-clip-state">
            {t("clipOn")}
          </span>
        ) : (
          <button
            class="btn"
            id="fr-clip-enable"
            disabled={on === null}
            onClick={async () => setOn(await chrome.permissions.request(CLIP).catch(() => false))}
          >
            {t("clipEnable")}
          </button>
        )}
        <button class="btn ghost" id="fr-clip-next" onClick={onNext}>
          {t("continue")}
          <Icon name="next" size={15} />
        </button>
      </div>
    </div>
  );
}

/** Step 4, on the normal page right above "Add accounts": where to go next. */
export function SetupReady({ rt, restored, opened, backup }: SetupDone & { rt: Runtime }) {
  const ref = useRef<HTMLDivElement>(null);
  // what a restore of the backup's copies found, and how the backup goes on (the backup's lazy chunk)
  const [Csb, setCsb] = useState<Awaited<ReturnType<typeof csbPages>> | null>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start" });
    if (opened || backup)
      void csbPages().then(
        (m) => setCsb(() => m),
        () => undefined,
      );
  }, []);
  return (
    <div ref={ref} id="fr-hint" class="box banner fr-ready" role="status">
      <BoxTitle icon="check">{t("frReadyTitle")}</BoxTitle>
      <p>{restored !== undefined ? t("restored", restored) : t("frAddBelow")}</p>
      {Csb && <Csb.CsbAfter rt={rt} {...(opened ? { opened } : {})} {...(backup ? { backup } : {})} />}
      <p class="muted">{t("frScanHint")}</p>
    </div>
  );
}
