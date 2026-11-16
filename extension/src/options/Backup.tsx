import { useEffect, useRef, useState } from "preact/hooks";
import { BackupError, createBackup, openBackup, parseBackupFile } from "../core/backup/backup";
import { createSubsetBackup, sameAsShown, selectedEntries } from "../core/backup/subset";
import { generatedForm } from "../core/crypto/password-candidates";
import { MAX_TEXT_BYTES } from "../core/import/file-text";
import { exportOtpauthList } from "../core/import/importer";
import type { ExportKind } from "../core/service/security-log";
import { ServiceError } from "../core/service/service";
import { aliveEntries, type Vault } from "../core/vault/model";
import { logError } from "../ui/errors";
import { formatDateTime, t } from "../ui/i18n";
import { measure, type Strength } from "../ui/strength";
import { Icon } from "./icons";
import type { SetupStart } from "./FirstRun";
import type { Picked } from "../platform/file-access";
import { handoffEpoch, handToAdd } from "./import-handoff";
import { MasterField } from "./MasterField";
import { BoxTitle, download, errText, Fold, Panel, PasswordFields, stamp, type Ctx } from "./shared";
import { SubsetPicker } from "./SubsetPicker";
import { cs } from "../ui/csb-text";
import "./export.css";

/**
 * Settings › Backup's first card, the backup in Chrome's sync storage, and its restore with no readable vault: the
 * backup's one lazy chunk (src/options/csb/CsbPages.ts).
 */
const csbPages = () => import("./csb/CsbPages");
/** A downloaded copy of that backup's format name (core/cloud/format.ts CLOUD_FORMAT), told from a backup file's here. */
const CLOUD_FILE = "sixkey-cloud-backup";

/** A file to save, and what to say once it is saved. */
type Made = { name: string; text: string; type?: string; done: string };
/**
 * The accounts ticked here are not all there any more, or no longer look as this page shows them (renamed, regrouped,
 * other sites, deleted, from another page since this one loaded): nothing is saved, and the page reloads to show them.
 */
const CHANGED = new Error("changed");
/** A typed master password is emptied after this long without typing (C6-REVIEW C6-6). */
const EXPORT_PW_IDLE_MS = 60_000;
/** chrome.storage.session key that every lock bumps, from any page (src/platform/session.ts, RoutedSession.clear). */
const LOCK_EPOCH_KEY = "sk_lock_epoch";

/**
 * Whether two typed strings are the same master password as every prompt takes it (openWithPassword: as typed, or the
 * generator's spelling of a generated shape; NFKC as the key derivation sees it). The subset file's password must not be
 * one that opens the vault: a loose spelling of a generated master password is that password (HYPHEN review B1). Pure:
 * no call asks the service whether a string opens the vault, which would be an unrecorded password oracle.
 */
export const sameMasterPassword = (a: string, b: string): boolean => {
  const taken = (s: string) => generatedForm(s)?.canonical ?? s.normalize("NFKC");
  return taken(a) === taken(b);
};

/** `onSetup`: a restore (no readable vault here) continues in the first-run wizard, which asks for the master password first. */
export function Backup({ rt, status, vault, reload, onSetup }: Ctx & { onSetup: (s: SetupStart) => void }) {
  const unlocked = status.state === "unlocked" && vault !== null;
  const canRestore = status.state === "empty" || status.state === "lost";
  // H3: every export asks for the master password again. Only a Phase 0 device-key vault has none to ask for: it warns.
  const asks = !(status.state === "unlocked" && !status.passwordProtected);
  const [exportPw, setExportPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a file of another app's, kept here until the person follows the link to Add account (import-handoff.ts): it is not
  // left waiting for a later visit. `since`: the hand-over epoch when it was chosen (a lock since then refuses it)
  const [handed, setHanded] = useState<{ files: Picked[]; since: number } | null>(null);
  const handedOff = handed !== null && msg === t("loadedIntoAdd");
  const [plainOk, setPlainOk] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [subPw, setSubPw] = useState("");
  const [subPw2, setSubPw2] = useState("");
  const [subStrength, setSubStrength] = useState<Strength | null>(null);
  // "Selected accounts" is one line until opened; closing it (its button, Escape, a lock, leaving the section) drops the
  // file password typed in it
  const [subOpen, setSubOpen] = useState(false);
  // "Encrypted backup" is one line until opened, as "Selected accounts" is (BACKUP-VISUAL: with the backup in Chrome
  // sync's card on top, the leaf stays within a screen and a half at 1400 x 900, test/e2e/visual-guard.spec.ts); closing
  // it (its button, Escape) drops the file password typed or generated in it; the card's "另存加密备份" opens it
  const [encOpen, setEncOpen] = useState(false);
  const closeEncrypted = () => {
    setPw("");
    setPw2("");
    setStrength(null);
    setEncOpen(false);
  };
  const closeSubset = () => {
    setSubPw("");
    setSubPw2("");
    setSubStrength(null);
    setSubOpen(false);
  };
  const [pending, setPending] = useState<unknown>(null); // a parsed backup file waiting for its password
  const [cloudFile, setCloudFile] = useState<unknown>(null); // a downloaded copy of the backup waiting for its secret
  const [Csb, setCsb] = useState<Awaited<ReturnType<typeof csbPages>> | null>(null);
  const [csReady, setCsReady] = useState(false);
  useEffect(() => {
    void csbPages().then(
      (m) => setCsb(() => m),
      () => undefined,
    );
    void cs.loaded.then(() => setCsReady(cs.words() != null));
  }, []);
  const [openPw, setOpenPw] = useState("");
  const [opened, setOpened] = useState<{ vault: Vault; created: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const exportPwRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  // After a wrong master password, back to its field: once the field is enabled again (it is disabled while busy).
  const [retype, setRetype] = useState(0);
  useEffect(() => {
    if (retype && !busy) exportPwRef.current?.focus();
  }, [retype, busy]);
  // One export at a time. A ref, set before the first await: clicks queued in the same task all see it (C6-4).
  const inFlight = useRef(false);

  // A typed master password does not wait in the field for whoever sits down next (C6-6): it is emptied when Sixkey
  // locks (from any page: every lock bumps the lock epoch), when the page shows locked, when this tab is hidden, and
  // after a minute without typing.
  useEffect(() => {
    if (!unlocked) {
      setExportPw("");
      closeSubset();
    }
  }, [unlocked]);
  // The hand-over's file and its message (with its link) go with a lock. Keyed on the lock itself, as the hand-over is,
  // not on the vault having been read: a lock while the vault is still being read must take them too.
  const open = status.state === "unlocked";
  useEffect(() => {
    if (open) return;
    setHanded(null);
    setMsg((m) => (m === t("loadedIntoAdd") ? null : m));
  }, [open]);
  useEffect(() => {
    if (!exportPw) return;
    const idle = setTimeout(() => setExportPw(""), EXPORT_PW_IDLE_MS);
    return () => clearTimeout(idle);
  }, [exportPw]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      setExportPw("");
      closeSubset();
    };
    const locked = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (LOCK_EPOCH_KEY in changes) setExportPw("");
    };
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    document.addEventListener("visibilitychange", hidden);
    area?.onChanged.addListener(locked);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      area?.onChanged.removeListener(locked);
    };
  }, []);

  const live = vault ? aliveEntries(vault) : [];
  // What the page shows as ticked: the only accounts an export of the selection may hold (C6-2).
  const shown = vault ? selectedEntries(vault, picked) : [];
  const count = shown.length;
  // An account that leaves the list leaves the selection, so it does not come back ticked when it returns.
  useEffect(() => {
    if (!vault) return;
    setPicked((p) => {
      const keep = aliveEntries(vault)
        .filter((e) => p.has(e.id))
        .map((e) => e.id);
      return keep.length === p.size ? p : new Set(keep);
    });
  }, [vault]);
  // The file and its password go to someone else: the master password must not be the one they learn. Compared as the
  // prompts take passwords (sameMasterPassword: NFKC, and a generated password's loose spellings), so neither a full-width
  // spelling from an IME nor the code without its hyphens gets through.
  const samePw = asks && subPw !== "" && sameMasterPassword(subPw, exportPw);
  const ready = unlocked && !busy && (!asks || exportPw !== "");
  const canEncrypted = ready && strong(pw, pw2, strength);
  const canPlain = ready && plainOk;
  const canSubset = ready && count > 0 && strong(subPw, subPw2, subStrength) && !samePw;

  /** Whether the export may go ahead: the master password typed for it, checked by the service, which records a wrong one. */
  async function confirmed(typed: string): Promise<boolean> {
    if (asks) {
      await rt.service.verifyPassword(typed);
      return true;
    }
    // A device-key vault as this page loaded it: there is no password to ask for, and the page warned. The vault as stored
    // now decides, not the page: if a master password was turned on meanwhile (another page), the page reloads and asks
    // for it. verifyPassword is not asked here: there is no password to check, and how it answers an empty one is up to
    // the service (A3-4), so nothing here depends on that.
    const now = await rt.service.status();
    if (now.state === "unlocked" && !now.passwordProtected) return true;
    await reload();
    return false;
  }

  /**
   * Every export goes through here (H3, H6), in this order:
   *   1. the master password typed for it, checked by the service (a wrong one is refused and recorded there);
   *   2. the vault read as it is now, not the copy this page loaded (another page may have changed it);
   *   3. the file made;
   *   4. the export recorded: once the file exists, before it leaves the page (closing the tab cannot skip the record);
   *   5. the file saved;
   *   6. "Last backup" set, for the full exports only. The file is saved by then: a failure here is noted in the
   *      diagnostics log and does not turn the export into an error (C6-5).
   * The field is emptied at the start, so the next export asks again. Resolves true once the file is saved.
   */
  async function exportWith(kind: ExportKind, make: (vault: Vault) => Promise<Made>): Promise<boolean> {
    const typed = exportPw;
    if (inFlight.current || !unlocked || (asks && typed === "")) return false; // nothing typed is no guess, and never a password
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setMsg(null);
    setExportPw("");
    setRetype(0);
    try {
      if (!(await confirmed(typed))) return false;
      const out = await make((await rt.service.read()).vault);
      await rt.service.recordExport(kind); // never throws
      download(out.name, out.text, out.type);
      setMsg(out.done);
      // a few accounts are not a backup of the vault
      if (kind !== "subset")
        await rt.service.markBackedUp().catch((e: unknown) => logError("last backup time not saved", e));
      return true;
    } catch (e) {
      if (e === CHANGED) {
        setError(t("expSubChanged"));
        await reload();
      } else setError(errText(e));
      if (e instanceof ServiceError && e.code === "wrong_secret") setRetype((n) => n + 1);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function exportEncrypted(ev: Event) {
    ev.preventDefault();
    if (!canEncrypted) return; // defence in depth: a disabled submit button already stops Enter from submitting (measured)
    void exportWith("encrypted", async (v) => {
      // the page's 50-bit rule once more before the file is made: the button's answer may be a frame old
      if (!(await measure(pw)).ok) throw new ServiceError("weak_password");
      return {
        name: `sixkey-backup-${stamp()}.json`,
        text: JSON.stringify(await createBackup(v, pw)),
        done: t("backupSaved"),
      };
    }).then((ok) => {
      if (ok) {
        setPw("");
        setPw2("");
      }
    });
  }

  function exportPlain() {
    if (!canPlain) return;
    void exportWith("plain", async (v) => ({
      name: `sixkey-accounts-${stamp()}.txt`,
      text: exportOtpauthList(v),
      type: "text/plain",
      done: t("plainSaved"),
    })).then((ok) => {
      if (ok) setPlainOk(false);
    });
  }

  function exportSubset(ev: Event) {
    ev.preventDefault();
    if (!canSubset) return; // defence in depth, as above
    const ids = shown.map((e) => e.id);
    void exportWith("subset", async (v) => {
      // Exactly the accounts this page lists as ticked, and only as it shows them: if one is gone, renamed, regrouped or
      // has other sites in the vault as it is now, nothing is saved and the page reloads to show the change (C6-2).
      if (!sameAsShown(shown, selectedEntries(v, ids))) throw CHANGED;
      if (!(await measure(subPw)).ok) throw new ServiceError("weak_password"); // as above
      const { file, count: n } = await createSubsetBackup(v, ids, subPw);
      return { name: `sixkey-selected-${stamp()}.json`, text: JSON.stringify(file), done: t("expSubSaved", n) };
    }).then((ok) => {
      if (ok) closeSubset();
    });
  }

  async function onFile(file: File) {
    const since = handoffEpoch(); // a lock while the file is read ends this: the file is not handed over after it
    setError(null);
    setMsg(null);
    setOpened(null);
    setHanded(null);
    // A Sixkey backup is a small JSON file; anything else (another app's export in any format, encrypted or zipped,
    // an image, UTF-16 text) goes to Add account, which reads every format and says what it found (import-handoff.ts;
    // the File, never its text, is handed over). Only while unlocked; Add account takes it when its section is shown.
    let json: unknown = null;
    try {
      json = file.size <= MAX_TEXT_BYTES ? JSON.parse(await file.text()) : null;
    } catch {
      json = null; // not JSON: not a Sixkey backup
    }
    // a downloaded copy of the automatic backup: opened with the master password or the recovery key, as the restore
    // from Chrome Sync opens its copies
    if (typeof json === "object" && json !== null && "format" in json && json.format === CLOUD_FILE) {
      setPending(null);
      setCloudFile(json);
      setOpenPw("");
      return;
    }
    const sixkey = typeof json === "object" && json !== null && "format" in json && json.format === "sixkey-backup";
    if (!sixkey) {
      // Unlocked is all Add account needs (it waits for the vault itself, which may still be on its way): a pick while the
      // vault is read is handed over, not refused. A lock since the file was chosen ends the hand-over, and says so.
      if (status.state === "unlocked" && since === handoffEpoch()) {
        setHanded({ files: [{ file, handle: null }], since });
        return setMsg(t("loadedIntoAdd"));
      }
      // Sixkey locked while the file was read (it may be unlocked again by now): choose it again. Locked when it was
      // chosen: unlock first. No vault to hand it to (a restore): it is not a backup of Sixkey's.
      if (since !== handoffEpoch()) return setError(t("fileLockedMeanwhile"));
      return setError(t(status.state === "locked" ? "unlockToManage" : "backupInvalid"));
    }
    try {
      parseBackupFile(json);
      setPending(json);
      setOpenPw("");
    } catch (e) {
      setError(errText(e));
    }
  }

  async function unlockFile(ev: Event) {
    ev.preventDefault();
    setError(null);
    if (cloudFile !== null) return openCloud();
    try {
      setOpened(await openBackup(pending, openPw));
      setPending(null);
      setOpenPw("");
    } catch (e) {
      setError(e instanceof BackupError ? errText(e) : t("errorBody", "unknown"));
    }
  }

  async function openCloud() {
    try {
      const r = await (await import("./csb/file")).openCloudFile(cloudFile, openPw, await rt.settings.deviceId());
      if (!r) return setError(cs("csWrongFile"));
      if (r === "typo") return setError(cs("csKeyTypo"));
      const typed = openPw;
      setCloudFile(null);
      setOpenPw("");
      // no vault here: the wizard writes it (its keys as restored; a recovery key's restore sets a new password first);
      // a file has no copy in Chrome Sync to continue
      if (canRestore)
        return onSetup({ mode: "csb", opened: { restore: r, typed, partial: 0, unusable: 0, slots: false } });
      const res = await rt.service.importBackup(r.vault);
      setMsg(res.mode === "merged" ? t("mergedBackup") : t("addedN", res.added));
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function apply() {
    if (!opened) return;
    setError(null);
    // H1: restored accounts are never written under a device key; the wizard takes the password and recovery code first.
    if (canRestore) return onSetup({ mode: "restore", backup: opened });
    try {
      const r = await rt.service.importBackup(opened.vault);
      setMsg(r.mode === "merged" ? t("mergedBackup") : t("addedN", r.added));
      setOpened(null);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Panel id="backup" icon="archive" title={t("backupTitle")} lead={t("backupLead")}>
      {msg && (
        <div class="callout good" role="status" id="backup-msg">
          <Icon name="check" size={16} />
          <span>{msg}</span>
          {handedOff && (
            <a href="#add" onClick={() => handed && handToAdd(handed.files, handed.since)}>
              {t("addTitle")}
            </a>
          )}
        </div>
      )}
      {error && (
        <div class="callout bad" role="alert" id="backup-error" ref={errorRef}>
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </div>
      )}

      {Csb && (status.state === "unlocked" || status.state === "locked") && (
        <Csb.CsbCard
          rt={rt}
          unlocked={unlocked}
          vault={vault}
          onSaveFile={() => {
            setEncOpen(true);
            requestAnimationFrame(() => document.getElementById("encrypted")?.scrollIntoView?.({ block: "nearest" }));
          }}
        />
      )}

      {unlocked &&
        (asks ? (
          <div class="box exp-pw" id="export-confirm">
            <BoxTitle icon="lock">{t("lockedTitle")}</BoxTitle>
            <p class="muted">{t("expPwLead")}</p>
            <MasterField
              id="export-pw"
              label={t("passwordLabel")}
              value={exportPw}
              onValue={setExportPw}
              rt={rt}
              autocomplete="off"
              disabled={busy}
              inputRef={exportPwRef}
            />
          </div>
        ) : (
          <div class="box warn" id="export-nopw">
            <BoxTitle icon="shieldAlert">{t("deviceOnlyTitle")}</BoxTitle>
            <p>{t("expNoPw")}</p>
          </div>
        ))}

      <Fold
        id="encrypted"
        icon="lock"
        title={t("exportEncryptedTitle")}
        open={encOpen}
        onToggle={(on) => (on ? setEncOpen(true) : closeEncrypted())}
      >
        <p class="muted">{t("exportEncryptedBody")}</p>
        <form onSubmit={exportEncrypted}>
          <PasswordFields
            idPrefix="backup"
            purpose="file"
            value={pw}
            confirm={pw2}
            onValue={setPw}
            onConfirm={setPw2}
            onStrength={setStrength}
          />
          <div class="row2">
            <button id="export-encrypted" class="btn" type="submit" disabled={!canEncrypted}>
              <Icon name="download" size={16} />
              {t("exportEncrypted")}
            </button>
          </div>
        </form>
      </Fold>

      <Fold
        id="subset"
        icon="transfer"
        title={t("expSubTitle")}
        open={subOpen}
        onToggle={(on) => (on ? setSubOpen(true) : closeSubset())}
      >
        <p class="muted">{t("expSubBody")}</p>
        {live.length > 0 ? (
          <SubsetPicker entries={live} picked={picked} onPick={setPicked} disabled={!unlocked || busy} />
        ) : (
          <p class="muted">{t("emptyTitle")}</p>
        )}
        <form onSubmit={exportSubset}>
          <PasswordFields
            idPrefix="subset"
            purpose="file"
            value={subPw}
            confirm={subPw2}
            onValue={setSubPw}
            onConfirm={setSubPw2}
            onStrength={setSubStrength}
          />
          {samePw && (
            <div class="err" id="subset-same">
              <Icon name="alert" size={15} />
              {t("expSubSamePw")}
            </div>
          )}
          <div class="row2">
            <button id="export-subset" class="btn" type="submit" disabled={!canSubset}>
              <Icon name="download" size={16} />
              {t("expSubSave", count)}
            </button>
          </div>
        </form>
      </Fold>

      <div class="cards">
        <div class="box warn">
          <BoxTitle icon="file">{t("exportPlainTitle")}</BoxTitle>
          <p>{t("exportPlainBody")}</p>
          <label class="check">
            <input
              id="plain-ok"
              type="checkbox"
              checked={plainOk}
              onChange={(e) => setPlainOk((e.target as HTMLInputElement).checked)}
            />{" "}
            {t("exportPlainCheck")}
          </label>
          <div class="row2">
            <button id="export-plain" class="btn ghost" disabled={!canPlain} onClick={exportPlain}>
              <Icon name="download" size={16} />
              {t("exportPlain")}
            </button>
          </div>
        </div>

        <div class="box">
          <BoxTitle icon="upload">{t(canRestore ? "restoreTitle" : "importTitle")}</BoxTitle>
          <p class="muted">{t(canRestore ? "restoreBody" : "importBody")}</p>
          {canRestore && Csb && csReady && (
            <div class="row2">
              <button class="btn" id="cs-restore-start" onClick={() => onSetup({ mode: "csb" })}>
                <Icon name="sync" size={15} />
                {cs("csRestore")}
              </button>
            </div>
          )}
          <div class="row2">
            <label class="btn ghost sm" for="backup-file">
              <Icon name="file" size={15} />
              {t("chooseFile")}
            </label>
            <input
              id="backup-file"
              ref={fileRef}
              type="file"
              accept=".json,.txt,application/json,text/plain"
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
          {(pending !== null || cloudFile !== null) && (
            <form onSubmit={unlockFile}>
              <div class="field">
                <label for="open-pw">{cloudFile !== null && csReady ? cs("csFile") : t("backupPasswordLabel")}</label>
                <input
                  id="open-pw"
                  type="password"
                  autocomplete="off"
                  value={openPw}
                  onInput={(e) => setOpenPw((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="row2">
                <button class="btn" type="submit" disabled={!openPw}>
                  {t("openBackup")}
                </button>
              </div>
            </form>
          )}
          {opened && (
            <div class="opened">
              <span class="callout good">
                <Icon name="archive" size={16} />
                <span>
                  {t(
                    "backupContains",
                    opened.vault.entries.filter((e) => e.secret !== "").length,
                    formatDateTime(opened.created),
                  )}
                </span>
              </span>
              <div class="row2">
                <button id="apply-backup" class="btn" disabled={!canRestore && !unlocked} onClick={() => void apply()}>
                  {t(canRestore ? "restore" : "importAction")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** A file password the pages accept: typed twice the same, and strong by the page's estimate (the service has its floor). */
function strong(pw: string, pw2: string, s: Strength | null): boolean {
  return pw.length > 0 && pw === pw2 && s?.ok === true;
}
