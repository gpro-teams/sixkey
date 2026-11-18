// Settings page > Security: the security record and what Sixkey keeps in this browser profile (PHASE0X-PLAN C7,
// SYNC-DESIGN H6 / Z4). The record is src/core/service/security-log.ts; this page only reads it (rt.security):
//   - Viewing never acks. Only the popup's notice after an unlock takes the count down (src/popup/notice.ts).
//   - Clearing is the service's clearSecurityLog(password): the master password first, a wrong one refused and recorded.
//     A Phase 0 device-key vault has no password to ask for. There is no other way to clear it from a page.
//   - A damaged record, or one from a newer version, is shown as unreadable, never as a clean zero.
// It is the leaf Settings › Security › Record, with what Sixkey keeps in this profile (always open: it says what is kept
// and that nothing is sent). Only this page imports this module, so none of it is in the popup's bundle (its text is in the shared catalogs).
import { useEffect, useRef, useState } from "preact/hooks";
import { RESTART_KEY } from "../core/service/pin-store";
import type { SecurityKind } from "../core/service/security-kinds";
import { FAILURES, SECURITY_LOG_KEY, type SecurityEntry, type SecurityLogView } from "../core/service/security-log";
import { KEYS } from "../core/storage/format";
import { formatDateTime, getLang, t } from "../ui/i18n";
import { Icon } from "./icons";
import { MasterField } from "./MasterField";
import { BoxTitle, errText, type Ctx } from "./shared";
import "./securitycard.css";

/**
 * Every kind has its label: the Record type fails the build if a kind is added without one. The record reads back every
 * entry of a kind's form (security-log.ts isKind), a newer version's too: the list shows those named here, and only
 * those (`listed`).
 */
const KIND_LABEL: Record<SecurityKind, string> = {
  unlock_failed: "secKUnlockFailed",
  recovery_failed: "secKRecoveryFailed",
  recovery_used: "secKRecoveryUsed",
  export_encrypted: "secKExportEncrypted",
  export_plain: "secKExportPlain",
  export_subset: "secKExportSubset",
  password_enabled: "secKPasswordEnabled",
  password_changed: "secKPasswordChanged",
  password_reset: "secKPasswordReset",
  key_rotated: "secKKeyRotated",
  recovery_code_new: "secKRecoveryCodeNew",
  log_cleared: "secKLogCleared",
  // Version 2 (M2, R8). The server sync's kinds went with its client (security-kinds.ts): their entries in a record are
  // not listed.
  prf_enrolled: "secKPrfEnrolled",
  prf_removed: "secKPrfRemoved",
  prf_failed: "secKPrfFailed",
  // QUICK-UNLOCK Stage 1 (scripts/i18n/quick.py): the PIN set or removed, a wrong PIN, the session quick unlock ended
  pin_set: "secKPinSet",
  pin_removed: "secKPinRemoved",
  pin_failed: "secKPinFailed",
  quick_ended: "secKQuickEnded",
  shares_made: "secKSharesMade", // recovery code shares of the current code (scripts/i18n/shares.py)
};
/** An entry this page has a label for (an own property of KIND_LABEL: never one of Object's, such as "constructor"). */
const listed = (e: SecurityEntry): e is { at: number; kind: SecurityKind } => Object.hasOwn(KIND_LABEL, e.kind);
/** The newest entries listed; the record keeps up to 50. */
const SHOWN = 15;

/**
 * `restart`: the line of the PIN's record (OWNER-DECISIONS/20), when there is one, once its text is in: the PIN box's name,
 * and what a copy of this profile can do with it (PinRestartBox.tsx, lazy).
 */
type Stored = {
  snaps: number;
  mirror: boolean;
  lastBackup: number | null;
  restart: string | null;
};

/**
 * The PIN record's line (the PIN box's lazy part and its text), when its record is in this profile: with the vault open
 * here, only a record Sixkey made (one that is not is removed: PinRestartBox.tsx inventoryLine, review r2 PINR-01).
 */
async function restartLine(rt: Ctx["rt"]): Promise<Stored["restart"]> {
  if ((await rt.local.get([RESTART_KEY]))[RESTART_KEY] === undefined) return null;
  return (await import("./PinRestartBox")).inventoryLine(rt);
}

export function SecurityCard({ rt, status }: Ctx) {
  const [log, setLog] = useState<SecurityLogView | "unread" | null>(null);
  const [stored, setStored] = useState<Stored | null>(null);
  const [asking, setAsking] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);

  const reads = useRef(0);
  /** Reads overlap (a reload and a change at once): only the latest one is shown. */
  const readLog = () => {
    const n = ++reads.current;
    return rt.security.read().then(
      (v) => n === reads.current && setLog(v),
      () => n === reads.current && setLog("unread"),
    );
  };
  // On opening, after every reload of the page's state, and whenever any page adds to the record or the popup acks it.
  useEffect(() => {
    void readLog();
  }, [status]);
  useEffect(() => {
    const changed = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && SECURITY_LOG_KEY in c) void readLog();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  useEffect(() => {
    let live = true;
    void Promise.all([
      rt.store.snapshots().then(
        (s) => s.length,
        () => 0,
      ),
      rt.mirror
        ? rt.mirror.keys().then(
            (k) => k.includes(KEYS.mirrorGen),
            () => false,
          )
        : false,
      rt.service.lastBackupAt().catch(() => null),
      restartLine(rt).catch(() => null),
    ]).then(([snaps, mirror, lastBackup, restart]) => {
      if (live) setStored({ snaps, mirror, lastBackup, restart });
    });
    return () => {
      live = false;
    };
  }, [status]);
  useEffect(() => {
    if (asking) pwRef.current?.focus();
  }, [asking]);

  const vaultOk = status.state === "unlocked" || status.state === "locked";
  const device = status.state === "unlocked" && !status.passwordProtected; // a locked vault always has a password
  const close = () => {
    setAsking(false);
    setPw("");
    setError(null);
  };

  async function clear(ev: Event) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await rt.service.clearSecurityLog(device ? "" : pw);
      close();
      setCleared(true);
    } catch (e) {
      setError(errText(e)); // a wrong password: refused, and the record now lists it
    } finally {
      setBusy(false);
      void readLog();
    }
  }

  const ok = log !== null && log !== "unread" && log.state === "ok" ? log : null;
  const shown = ok ? ok.entries.filter(listed) : [];
  // nothing listed, nothing to clear here: what this version does not list (a newer version's entries) stays for it
  const empty = ok !== null && shown.length === 0;
  const justCleared = cleared && ok?.entries[0]?.kind === "log_cleared"; // until anything else is added
  return (
    <>
      {log !== null && !ok && (
        <p class="callout bad" id="sec-log-bad">
          <Icon name="alert" size={16} />
          <span>
            {t("secNoticeBad")}
            {log !== "unread" &&
              `${getLang() === "zh_CN" ? "" : " "}${t(log.state === "newer" ? "secLogNewer" : "secLogDamaged")}`}
          </span>
        </p>
      )}
      {ok && (
        <>
          <p class={`callout${ok.failed ? " warn" : ""}`} id="sec-log-count">
            <Icon name={ok.failed ? "shieldAlert" : "shieldCheck"} size={16} />
            <span>{t("secLogCount", ok.failed)}</span>
          </p>
          {shown.length ? (
            <ol class="sec-log" id="sec-log-list">
              {shown.slice(0, SHOWN).map((e, i) => (
                <li key={i} class={FAILURES.includes(e.kind) ? "bad" : ""}>
                  <span>{t(KIND_LABEL[e.kind])}</span>
                  <time dateTime={new Date(e.at).toISOString()}>{formatDateTime(e.at)}</time>
                </li>
              ))}
              {shown.length > SHOWN && <li class="more">{t("secLogOlder", shown.length - SHOWN)}</li>}
            </ol>
          ) : (
            <p class="nothing">{t("secLogEmpty")}</p>
          )}
        </>
      )}
      {vaultOk &&
        log !== null &&
        !empty &&
        (asking ? (
          <form class="sec-clear" onSubmit={clear}>
            {!device && (
              <>
                <p class="muted">{t("secLogClearLead")}</p>
                <MasterField
                  id="sec-log-pw"
                  label={t("passwordLabel")}
                  value={pw}
                  onValue={setPw}
                  rt={rt}
                  inputRef={pwRef}
                />
              </>
            )}
            {error && (
              <div class="err" role="alert">
                <Icon name="alert" size={15} />
                {error}
              </div>
            )}
            <div class="row2">
              {/* Nothing typed is not a guess, and the service would not record it either: the button waits for a password. */}
              <button class="btn" type="submit" id="sec-log-confirm" disabled={busy || (!device && !pw)}>
                {t("secLogClear")}
              </button>
              <button class="btn ghost" type="button" onClick={close}>
                {t("cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div class="row2">
            <button
              class="btn ghost"
              type="button"
              id="sec-log-clear"
              onClick={() => {
                setCleared(false);
                setAsking(true);
              }}
            >
              {t("secLogClear")}
            </button>
            {justCleared && (
              <span class="ok-msg" role="status">
                <Icon name="check" size={15} />
                {t("secKLogCleared")}
              </span>
            )}
          </div>
        ))}

      <div class="box" id="security-stored">
        <BoxTitle icon="device">{t("secInvTitle")}</BoxTitle>
        <ul class="sec-inv">
          {vaultOk && <li>{t(device ? "secInvKeysDevice" : "secInvKeysPw")}</li>}
          {stored && (
            <>
              <li>{t("secInvSnaps", stored.snaps)}</li>
              <li>{t(stored.mirror ? "secInvMirror" : "secInvNoMirror")}</li>
              <li>
                {t("secInvSettings", stored.lastBackup === null ? t("backupNever") : formatDateTime(stored.lastBackup))}
              </li>
            </>
          )}
          <li>{t("secInvLogs")}</li>
          {vaultOk && !device && <li>{t("secInvSession")}</li>}
          {stored?.restart && (
            <li id="security-stored-restart">
              <strong>{t("pinBoxTitle")}</strong> {stored.restart}
            </li>
          )}
          <li class="net">{t("trustNoTrack")}</li>
        </ul>
      </div>
    </>
  );
}
