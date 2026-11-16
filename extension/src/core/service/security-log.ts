// The local security record (SYNC-DESIGN H6, review H-b; PHASE0X-PLAN A3): when someone typed a wrong master password or
// recovery code, and when the vault's keys changed or its secrets were exported. The settings page shows it (C7), and
// the popup can say "N wrong passwords since you last looked".
//
// What it is and is not:
//   - Only times and kinds: no account names, no codes, no passwords, no IP or browser details, no error text. It lives
//     in this browser profile's chrome.storage.local, and Sixkey never sends, mirrors or exports it: it is not in backups
//     or exports (those are built from the vault alone), not in the mirror, not in the diagnostics file. A browser that
//     syncs or exports whole profiles carries it along with everything else. It is not vault data: a store holding only
//     this key loads as empty.
//   - Its own key, its own lock. It never reads or writes sk_events: those are the "data restored" banners, and mixing the
//     two would show a wrong password as a restore and push out unread restores (review H-b). It never goes through
//     VaultStore.transact, so it cannot touch the slots, the pointer or the key-change marker (sk_keychange), whatever
//     point a write of it dies at.
//   - This browser profile's history, not the vault's: create, restoreBackup, startOver and importBackup leave it as it is
//     (what happened just before the data became unreadable is what it is there for), and a backup brings none in.
//   - An alert line, not evidence: anyone who can write the profile (a copy of it, malware, devtools on an unlocked
//     browser) can edit or silence it. What it does withstand is someone at the browser's own pages without the master
//     password: the pages get only the read side (securityReader); emptying the log goes through the service and needs
//     the master password (VaultService.clearSecurityLog), and only the popup's notice after an unlock acks the count.
//   - Nothing reads it on the way to opening or unlocking the popup: entries are added when something happens, and the log
//     is read only when a page asks (read, failuresSinceAck, recent). The one read in the popup is the documented exception
//     to the read gates (PHASE0X-PLAN C7): after an unlock in that popup, once its first code is on screen, the notice
//     reads it once (src/popup/notice.ts; measured on its own in read-budget.test.ts, allowed in perf.spec.ts "in all").
//   - Adding to it never fails what is being recorded: a write that fails is reported to the diagnostics log and dropped.
//
// On disk, under sk_security_log:  { v: 2, entries: [{ at, kind }], ackAt?, failed?, remind? }
//   - v: 2 (SYNC-DESIGN §0.0i req. 15 R8): the one version bump for the kinds Phase 1 added, so a client that knows v: 1
//     stops adding entries once, not twice (it reads v > 1 as "newer"). A v: 1 record is read as before, and the next
//     write makes it v: 2. Since revision 25 a new kind needs no bump: every version keeps the entries of kinds it does
//     not know (StoredEntry, below).
//   - kind: a name of security-kinds.ts's list, which only the settings page and the service's types import. The record
//     itself knows a kind by its form only (isKind): it writes no entry that is not of that form, and reads back, and
//     keeps, every entry that is, whatever version wrote it; the settings page lists those it has a label for
//     (SecurityCard.tsx). So the popup's and the side panel's copy of this class carries no list of names.
//   - entries: oldest first, at most 50. When full, the oldest entry of the larger half goes: wrong guesses are one half
//     (FAILURES), everything else the other. So a burst of wrong guesses cannot push out the record of an export or a
//     key change (each half keeps at least its newest 25), and the reverse.
//   - failed: wrong guesses since the last ack() (or since the log began), counted as they are added, so the count does
//     not depend on the wall clock and is not capped by the 50 entries. ackAt: when ack() last ran, for display.
//   - remind: { kind: "shares", at, due, id, set } (docs/design/notes/SHAMIR-NOTES.md §4): after a recovery code was
//     replaced by shares, the popup says after every unlock, from the next browser start on, to check the shares before
//     destroying the old code, until a check passes (a commit can be rolled back by a power loss; only a check after a
//     restart shows it was not). Set by the service just before that commit (due: false), so a power loss that drops
//     the commit's last writes never keeps the commit and drops the reminder; put back as it was if the commit is
//     refused (putBack), but only while it is still that switch's own (`id`, random: two pages switching at once each
//     know their own); made due at the next start of the browser or the extension (browserStarted); dropped when "Check
//     my shares" passes once it is due (a pass before the restart proves nothing about the commit: checked), by a new
//     vault and by any other recovery code change. `set`: the switched set's id, as printed on every share, so a check
//     that fails can tell that set's shares from any other. No secret: a time, a random id, and the set's id. An older
//     version keeps it as a field it does not know.
//   - Damaged or of an unknown shape: read() says "damaged" (no entries, so a page does not show a clean zero), and the
//     next entry replaces it. Written by a newer version (v > 2): read() says "newer", and it is left alone (a version
//     that adds a kind writes v: 3), so entries are not added here; each one skipped goes to the diagnostics log. A read
//     that throws is not "empty": nothing is written on its account, so a passing I/O error cannot wipe the record.
import { createMutex, type KV, type Lock } from "../storage/kv";
import type { SecurityKind } from "./security-kinds";

export type { SecurityKind };

export const SECURITY_LOG_KEY = "sk_security_log";
export const SECURITY_LOG_MAX = 50;

/** The record's version. Every write is this one; a record above it is a newer version's and is left alone. */
export const SECURITY_LOG_VERSION = 2;
/** The wrong guesses: what failuresSinceAck() counts. */
export const FAILURES: readonly SecurityKind[] = ["unlock_failed", "recovery_failed", "pin_failed"];
export type ExportKind = "encrypted" | "plain" | "subset";

/**
 * An entry as a page gets it: a time and a kind of the kinds' form (isKind), which may be one this version has no name
 * for (a newer version's): the settings page lists only the kinds it has a label for (SecurityCard.tsx).
 */
export type SecurityEntry = { at: number; kind: string };
/**
 * What a page shows: entries newest first, wrong guesses since the last ack, and when that was. `state`: "ok" (also when
 * there is no log yet), "damaged" (unreadable: shown as such, not as a clean zero) or "newer" (written by a newer version
 * of Sixkey, which this one neither reads nor adds to). Only "ok" has entries and a count.
 */
export type SecurityLogView = {
  state: "ok" | "damaged" | "newer";
  entries: SecurityEntry[];
  failed: number;
  ackAt: number | null;
  /** A reminder that is due (`remind` above): "shares", from the first browser start after the switch until a check. */
  remind?: "shares";
};

/** What the service needs: add an entry (never fails), and empty the log (only behind the master password). */
export interface SecurityRecorder {
  append(kind: SecurityKind): Promise<void>;
  clear(): Promise<void>;
  /**
   * The shares reminder set, not yet due, for a switch (`id`: the switch's own random id, `set`: the set's id), or
   * dropped (null). Resolves to the reminder there before (null: none), or undefined when it was not read or not
   * written. Never rejects. Optional: a recorder without one has none.
   */
  remind?(to: { id: string; set: string } | null): Promise<SharesReminder | null | undefined>;
  /**
   * A refused switch takes its reminder back: if the reminder there is still the one with this `id`, `before` (null:
   * none) replaces it, in one read and one write under this log's lock; any other reminder, or none, is left alone (it
   * is another switch's, or a later change already dealt with it). Never rejects.
   */
  putBack?(id: string, before: SharesReminder | null): Promise<void>;
  /** The browser or the extension has started: a reminder set before becomes due. Never rejects. */
  started?(): Promise<void>;
  /**
   * Shares were checked: `pass`, they rebuild the code in force. A due reminder is dropped by a pass; one not yet due
   * stays (a check before the restart proves nothing about the commit). Resolves to the reminder's state before: "none",
   * "set" (not yet due) or "due" ("none" when unreadable), and its set's id. Never rejects.
   */
  checked?(pass: boolean): Promise<{ state: "none" | "set" | "due"; set?: string }>;
}

/** What the pages get (createRuntime's `security`): reading, and the popup notice's ack. Not clear(). */
export type SecurityReader = Pick<SecurityLog, "read" | "failuresSinceAck" | "recent" | "ack">;

/**
 * An entry as stored: a time and a kind, and whatever else a newer version wrote beside them. An entry of a kind this
 * version has no name for (a newer version's) is kept as it is when the log is rewritten, counted and trimmed like the
 * rest, and read back (the settings page lists only the kinds it has a label for): a downgrade loses no entry, and an
 * older version keeps recording (a version bump for each new kind would make it leave the whole record alone,
 * recording nothing more).
 */
type StoredEntry = { at: number; kind: string; [field: string]: unknown };
/** The record; `extra`: the fields a newer version added beside these, kept as they are when it is rewritten. */
/** The shares reminder as stored (`remind` in the header). */
export type SharesReminder = { kind: "shares"; at: number; due: boolean; id?: string; set?: string };
const REMIND_ID = /^[0-9a-f]{16}$/;
const SET_ID = /^[0-9A-F]{4}$/;
type StoredLog = {
  v: typeof SECURITY_LOG_VERSION;
  entries: StoredEntry[];
  ackAt?: number;
  failed?: number;
  remind?: SharesReminder;
  extra?: Record<string, unknown>;
};
const OWN_FIELDS = new Set(["v", "entries", "ackAt", "failed", "remind"]);
/** A reminder as stored, or undefined for anything else (a damaged one is dropped, never guessed at). */
const remindOf = (x: unknown): SharesReminder | undefined => {
  const r = x as SharesReminder | null;
  if (typeof r !== "object" || r === null || r.kind !== "shares" || !isTime(r.at) || typeof r.due !== "boolean")
    return undefined;
  // an id or a set that is not one is left out (an older one had neither): it never matches a switch's own
  return {
    kind: "shares",
    at: r.at,
    due: r.due,
    ...(typeof r.id === "string" && REMIND_ID.test(r.id) ? { id: r.id } : {}),
    ...(typeof r.set === "string" && SET_ID.test(r.set) ? { set: r.set } : {}),
  };
};

/** The record with this reminder (none: undefined or null), or null when that changes nothing (no write). */
function withRemind(cur: StoredLog, r: SharesReminder | null | undefined): StoredLog | null {
  if (!r) {
    if (!cur.remind) return null;
    const { remind: _drop, ...rest } = cur;
    return rest;
  }
  return { ...cur, remind: r };
}

const isFailure = (e: { kind: string }) => (FAILURES as readonly string[]).includes(e.kind);
/**
 * A kind's form (security-kinds.ts's names all have it; test/unit/security-log.test.ts holds them, and the form, to it): a
 * lower-case ASCII letter, then lower-case ASCII letters and underscores, 1 to 32 characters in all. Nothing else is
 * written (append), and every entry of this form is read back and kept, whatever version of Sixkey wrote it (a newer
 * version's kinds included). Inline, not a constant of the module: the popup's bundle carries this class (15 B gzipped).
 */
const isKind = (k: unknown): k is string => typeof k === "string" && /^[a-z][a-z_]{0,31}$/.test(k);
const isTime = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0;
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Absent or damaged: null. Written by a newer version: "newer". Otherwise the record, cleaned up, as version 2 (a
 * version 1 record has only version 1 kinds; it reads the same and is written back as version 2). An entry without a
 * time or a kind is dropped; one of a kind this version does not know, or with fields it does not know, is kept as it
 * is (StoredEntry), and so are the record's own unknown fields (`extra`).
 */
export function parseSecurityLog(x: unknown): StoredLog | "newer" | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.v === "number" && o.v > SECURITY_LOG_VERSION) return "newer";
  if ((o.v !== 1 && o.v !== SECURITY_LOG_VERSION) || !Array.isArray(o.entries)) return null;
  const entries = o.entries
    .filter(
      (e): e is StoredEntry =>
        typeof e === "object" &&
        e !== null &&
        !Array.isArray(e) &&
        isTime((e as StoredEntry).at) &&
        typeof (e as StoredEntry).kind === "string",
    )
    .map((e) => ({ ...e }))
    .slice(-SECURITY_LOG_MAX);
  const ackAt = isTime(o.ackAt) ? o.ackAt : undefined;
  // A record without a valid count (damaged, or edited by hand): the wrong guesses still listed after the last ack.
  const failed = isCount(o.failed)
    ? o.failed
    : entries.filter((e) => isFailure(e) && (ackAt === undefined || e.at > ackAt)).length;
  const extra = Object.fromEntries(Object.entries(o).filter(([k]) => !OWN_FIELDS.has(k)));
  const remind = remindOf(o.remind);
  return {
    v: SECURITY_LOG_VERSION,
    entries,
    ...(ackAt !== undefined ? { ackAt } : {}),
    failed,
    ...(remind ? { remind } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

/** The record as written: its own fields, and the ones a newer version added (`extra`) beside them, unchanged. */
const stored = (l: StoredLog): Record<string, unknown> => {
  const { extra, ...own } = l;
  return { ...(extra ?? {}), ...own };
};

/** Over the limit: the oldest entry of the larger half goes (on a tie, a wrong guess). */
function trim(entries: StoredEntry[]): StoredEntry[] {
  const out = [...entries];
  while (out.length > SECURITY_LOG_MAX) {
    const f = out.filter(isFailure).length;
    const dropFailure = f >= out.length - f;
    out.splice(
      out.findIndex((e) => isFailure(e) === dropFailure),
      1,
    );
  }
  return out;
}

export type SecurityLogOptions = {
  kv: KV;
  lock?: Lock;
  now?: () => number;
  onDiag?: (message: string, err?: unknown) => void;
};

export class SecurityLog implements SecurityRecorder {
  private readonly kv: KV;
  private readonly lock: Lock;
  private readonly now: () => number;
  private readonly diag: (message: string, err?: unknown) => void;

  /** Reads nothing: a context that never shows the log never pays for it. */
  constructor(o: SecurityLogOptions) {
    this.kv = o.kv;
    this.lock = o.lock ?? createMutex();
    this.now = o.now ?? Date.now;
    this.diag = o.onDiag ?? (() => undefined);
  }

  private async raw(): Promise<unknown> {
    return (await this.kv.get([SECURITY_LOG_KEY]))[SECURITY_LOG_KEY];
  }

  /**
   * Add an entry. Never rejects: what is being recorded has already happened, and must not be reported as failed
   * because its record could not be written. One read and one write of this key, under this log's own lock.
   */
  async append(kind: SecurityKind): Promise<void> {
    if (!isKind(kind)) {
      this.diag("security log: malformed kind not added");
      return;
    }
    try {
      await this.lock(async () => {
        const raw = await this.raw(); // a read that throws ends here: nothing is written over a log that could not be read
        const cur = parseSecurityLog(raw);
        if (cur === "newer") {
          this.diag("security log is from a newer version; entry not added");
          return;
        }
        if (cur === null && raw !== undefined) this.diag("security log was damaged; starting a new one");
        const base: StoredLog = cur ?? { v: SECURITY_LOG_VERSION, entries: [] };
        const entry: SecurityEntry = { at: this.now(), kind };
        const next: StoredLog = {
          v: SECURITY_LOG_VERSION,
          entries: trim([...base.entries, entry]),
          ...(base.ackAt !== undefined ? { ackAt: base.ackAt } : {}),
          failed: (base.failed ?? 0) + (isFailure(entry) ? 1 : 0),
          ...(base.remind ? { remind: base.remind } : {}),
          ...(base.extra ? { extra: base.extra } : {}),
        };
        await this.kv.set({ [SECURITY_LOG_KEY]: stored(next) });
      });
    } catch (e) {
      this.diag("security log entry not written", e);
    }
  }

  /** The whole log in one read, for a page to show. A read that throws rejects. */
  async read(): Promise<SecurityLogView> {
    const raw = await this.raw();
    const cur = parseSecurityLog(raw);
    if (cur === null || cur === "newer")
      return {
        state: cur === "newer" ? "newer" : raw === undefined ? "ok" : "damaged",
        entries: [],
        failed: 0,
        ackAt: null,
      };
    // every entry of a kind's form, as a time and a kind, whatever version wrote it (the settings page lists the kinds it
    // has a label for); one of no such form stays in the record, as it is, and is not read
    const shown = cur.entries.filter((e) => isKind(e.kind)).map((e) => ({ at: e.at, kind: e.kind }));
    return {
      state: "ok",
      entries: shown.reverse(),
      failed: cur.failed ?? 0,
      ackAt: cur.ackAt ?? null,
      ...(cur.remind?.due ? { remind: cur.remind.kind } : {}),
    };
  }

  /** Wrong passwords and recovery codes since the last ack() (or since the log began). 0 unless read() says "ok". */
  async failuresSinceAck(): Promise<number> {
    return (await this.read()).failed;
  }

  /** The newest `n` entries, newest first. */
  async recent(n: number): Promise<SecurityEntry[]> {
    return (await this.read()).entries.slice(0, Math.max(0, n));
  }

  /**
   * "Seen": `seen` is the count the popup's notice showed, and that many come off it, so a wrong guess added after the
   * notice read the count is still reported next time. The entries stay. Writes only when there is something to take
   * off; `seen` that is not a positive whole number takes off nothing. A read that throws rejects and changes nothing; a
   * newer version's log is left alone.
   * Only the popup's notice calls this, once it has been shown after an unlock in that popup (so to someone who just
   * typed the master password). A page that only shows the log, the settings card, never acks by being viewed.
   */
  async ack(seen: number): Promise<void> {
    await this.lock(async () => {
      const cur = parseSecurityLog(await this.raw());
      if (cur === null || cur === "newer" || !cur.failed || !Number.isSafeInteger(seen) || seen <= 0) return;
      await this.kv.set({
        [SECURITY_LOG_KEY]: stored({ ...cur, ackAt: this.now(), failed: Math.max(0, cur.failed - seen) }),
      });
    });
  }

  /**
   * The shares reminder (`remind` in the header): set, not yet due, for a switch, or dropped (null). One read and at
   * most one write, under this log's lock; nothing is written over a newer version's log or when nothing changes.
   * Resolves to the reminder before (null: none); undefined when it was not read or not written. Never rejects.
   */
  async remind(to: { id: string; set: string } | null): Promise<SharesReminder | null | undefined> {
    let before: SharesReminder | null | undefined;
    const done = await this.change((cur) => {
      before = cur.remind ?? null;
      return withRemind(cur, to && remindOf({ kind: "shares", at: this.now(), due: false, id: to.id, set: to.set }));
    });
    return done ? before : undefined;
  }

  /** A refused switch's reminder taken back (`SecurityRecorder.putBack`): only while it is still that switch's own. */
  async putBack(id: string, before: SharesReminder | null): Promise<void> {
    await this.change((cur) => (cur.remind?.id === id ? withRemind(cur, before && remindOf(before)) : null));
  }

  /** Shares were checked (`SecurityRecorder.checked`): a pass drops a due reminder and keeps one not yet due. */
  async checked(pass: boolean): Promise<{ state: "none" | "set" | "due"; set?: string }> {
    let found: { state: "none" | "set" | "due"; set?: string } = { state: "none" };
    await this.change((cur) => {
      const r = cur.remind;
      found = { state: !r ? "none" : r.due ? "due" : "set", ...(r?.set ? { set: r.set } : {}) };
      return pass && found.state === "due" ? withRemind(cur, undefined) : null;
    });
    return found;
  }

  /** The browser or the extension started (the service worker's onStartup, onInstalled): a set reminder becomes due. */
  async started(): Promise<void> {
    await this.change((cur) =>
      cur.remind && !cur.remind.due ? { ...cur, remind: { ...cur.remind, due: true } } : null,
    );
  }

  /**
   * A change of the record's own fields: the function given returns the new record, or null for none. Resolves true when
   * the record was read and the change (if any) written; false for a newer version's record or a failure. Never rejects.
   */
  private async change(edit: (cur: StoredLog) => StoredLog | null): Promise<boolean> {
    try {
      return await this.lock(async () => {
        const raw = await this.raw();
        const cur = parseSecurityLog(raw);
        if (cur === "newer") return false;
        const next = edit(cur ?? { v: SECURITY_LOG_VERSION, entries: [], failed: 0 });
        if (next) await this.kv.set({ [SECURITY_LOG_KEY]: stored(next) });
        return true;
      });
    } catch (e) {
      this.diag("security log reminder not written", e);
      return false;
    }
  }

  /**
   * Forget everything: the entries, the count, the last ack. What is left is one log_cleared entry with the time, so
   * clearing is never silent. Needs no read, so it also replaces a damaged log, and (asked for explicitly) one from a
   * newer version. Not for pages: they call VaultService.clearSecurityLog(password), which checks the master password
   * first; createRuntime hands the pages a securityReader, which has no clear().
   */
  async clear(): Promise<void> {
    await this.lock(async () => {
      await this.kv.set({
        [SECURITY_LOG_KEY]: {
          v: SECURITY_LOG_VERSION,
          entries: [{ at: this.now(), kind: "log_cleared" }],
          failed: 0,
        } satisfies StoredLog,
      });
    });
  }
}

/** The read side of a log, for the pages (createRuntime's `security`): no clear(), and nothing else to reach it by. */
export function securityReader(log: SecurityLog): SecurityReader {
  return Object.freeze({
    read: () => log.read(),
    failuresSinceAck: () => log.failuresSinceAck(),
    recent: (n: number) => log.recent(n),
    ack: (seen: number) => log.ack(seen),
  });
}
