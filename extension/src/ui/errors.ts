// What every page says when something fails (PHASE0X-PLAN C8, ux-study §2.12 P0): what happened, then what to do next.
// Never the error's name (TypeError, QuotaExceededError), its code (bad_state) or its message, which could carry
// anything: those are for the local diagnostics log, which keeps only the error class (src/platform/diag.ts).
import { createDiagLogger } from "../platform/diag";
import { ChromeLocalKV } from "../platform/chrome-kv";
import { t } from "./i18n";

/** Message keys: `what` has no closing full stop (errLine adds it), `next` is one or two whole sentences. */
type Entry = { what: string; next: string; log?: true };

const READ: Entry = { what: "errRead", next: "errNextRestore", log: true };
const UNKNOWN: Entry = { what: "errorTitle", next: "errNextRetry", log: true };

// By error code first (ServiceError, StorageError, BackupError, VaultError, CryptoError all carry one), then by the
// error's class name, which is all the popup's loader passes on. Codes of things the user typed are not logged.
const TABLE: Record<string, Entry> = {
  wrong_secret: { what: "wrongPassword", next: "errNextCheck" },
  unwrap_failed: { what: "wrongPassword", next: "errNextCheck" },
  weak_password: { what: "weakPassword", next: "errNextWeak" },
  recovery_char: { what: "badRecoveryFormat", next: "errNextCheck" },
  recovery_checksum: { what: "badRecoveryFormat", next: "errNextCheck" },
  recovery_length: { what: "badRecoveryFormat", next: "errNextCheck" },
  invalid_vault: { what: "invalidData", next: "errNextCheck" },
  locked: { what: "needUnlock", next: "errNextUnlock" },
  already_protected: { what: "alreadyProtected", next: "errNextReload" },
  not_protected: { what: "deviceOnlyTitle", next: "errNextReload" },
  bad_state: { what: "badState", next: "errNextReload", log: true },
  newer_schema: { what: "newerTitle", next: "newerBody" },
  wrong_password_or_damaged: { what: "backupWrongOrDamaged", next: "errNextBackupPw" },
  invalid_file: { what: "backupInvalid", next: "errNextBackupFile" },
  newer_format: { what: "newerFormat", next: "errNextUpdate" },
  verify_failed: { what: "errSave", next: "errNextRetry", log: true },
  unreadable: READ,
  lost_needs_confirm: { what: "lostTitle", next: "errNextRestore", log: true },
  QuotaExceededError: { what: "errSpace", next: "errNextSpace", log: true },
  StorageError: READ,
  VaultError: READ,
  CryptoError: READ,
  BackupError: { what: "backupInvalid", next: "errNextBackupFile" },
};

/** Codes and class names are identifiers; anything else (a message, a number, an object) is not trusted as one. */
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ident = (v: unknown): string | null => (typeof v === "string" && IDENT.test(v) ? v : null);

/**
 * The error's code, else its class name, else "unknown": for the diagnostics log only, never for the screen. A string
 * counts as a code (the popup's loader passes the class name); a DOMException's numeric code is skipped for its name.
 */
export function errorCode(e: unknown): string {
  if (typeof e === "string") return ident(e) ?? "unknown";
  if (e && typeof e === "object")
    return ident((e as { code?: unknown }).code) ?? ident((e as { name?: unknown }).name) ?? "unknown";
  return "unknown";
}

function entryOf(e: unknown): Entry {
  const keys =
    typeof e === "string"
      ? [ident(e)]
      : e && typeof e === "object"
        ? [ident((e as { code?: unknown }).code), ident((e as { name?: unknown }).name)]
        : [];
  for (const k of keys) if (k && Object.hasOwn(TABLE, k)) return TABLE[k]!;
  return UNKNOWN;
}

/** Where a "next" sends the user: a settings section for the popup's button, and its name for the text. */
export function sectionOf(e: unknown): "backup" | "advanced" | null {
  const next = entryOf(e).next;
  return next === "errNextRestore" ? "backup" : next === "errNextRetry" ? "advanced" : null;
}

const place = (title: string) => `${t("settings")} › ${t(title)}`;
const SUBS: Record<string, () => string> = {
  errNextRetry: () => place("advancedTitle"),
  errNextRestore: () => place("backupTitle"),
  errNextWeak: () => t("generate"),
  errNextBackupFile: () => t("exportEncrypted"),
};

/** What happened and what to do next, in the current language. */
export function describeError(e: unknown): { what: string; next: string } {
  const { what, next } = entryOf(e);
  return { what: t(what), next: t(next, SUBS[next]?.() ?? "") };
}

/** The same as one line, for an error shown inline. */
export function errorLine(e: unknown): string {
  const d = describeError(e);
  return t("errLine", d.what, d.next);
}

let diag: ReturnType<typeof createDiagLogger> | undefined;

/**
 * Note an error that was shown in the local diagnostics log, which "save diagnostics" exports: only its code or class
 * (errorCode), never its message. Mistakes in what the user typed (a wrong password, a weak one, a file that is not a
 * backup) are not logged. Never throws, also where there is no extension storage (unit tests).
 */
export function logError(where: string, e: unknown): void {
  if (!entryOf(e).log) return;
  try {
    diag ??= createDiagLogger(new ChromeLocalKV());
    diag(where, { code: errorCode(e) });
  } catch {
    /* no storage: nothing to log to */
  }
}
