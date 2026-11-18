// The backup in Chrome's sync storage in the popup and the side panel: a lazy chunk with its own text
// (src/ui/csb-popup-text.ts), loaded by every build, with nothing of the settings page's modules. What it says agrees
// with what Settings › Backup's card says (src/options/csb/model.ts cardView; csb-popup-dom.test.ts holds the two
// together), from the worker's two records (src/platform/csb-config.ts):
//   - the header pill: the popup's own "本机" while the backup is off; "Chrome 同步" once it is on, with a check once a
//     copy of the vault as it is has been handed over (a clock before the first copy and while changes wait), its
//     title "已交给 Chrome 同步 · 3 分钟前" (the act, never "backed up": Sixkey cannot see what Chrome uploads), or the
//     backup's name until a copy has been handed over; "备份已停" (amber) when the card's line is a problem only the
//     person can fix (stopped), changes have waited three days (stale), or this browser would not let the worker close
//     the area to web pages (unsafe). A passing failure is the card's alone: the worker retries it. Where the browser is
//     not Google Chrome, "浏览器同步" (csb-brand.ts); no line here names a Google account;
//   - the footer: "N 个账户 · 备份出了问题" then, which opens Settings › Backup; nothing is blocked. While the backup runs
//     (on and not stopped: csb-config.ts backupRuns), the account count only: no reminder to back up, whatever the last
//     copy's age, since a vault unchanged for a week is not handed over again;
//   - the one click: with the backup off and the reminder due in a profile only the person uses (Main.tsx's `due`), the
//     footer's "立即备份" leaves "turn on now" for the card (src/platform/cloud-go.ts) and opens Settings › Backup, where
//     the card turns the backup on as it loads, with its cost line in view. Not where the person turned it off before
//     (`declined`): the popup's own reminder then, which opens the card as it is.
// The popup never sends the worker a message of the backup's (sk-csb-*): the settings page alone does
// (src/platform/sender-policy.ts), and check-dist holds every chunk the popup and the side panel can load to that.
import { useEffect, useState } from "preact/hooks";
import { wantConnect } from "../../platform/cloud-go";
import { backupRuns, CSB_CFG_KEY, CSB_STATE_KEY, parseCsbConfig, parseCsbState } from "../../platform/csb-config";
import type { CsbConfig, CsbState } from "../../platform/csb-config";
import { ago } from "../../ui/ago";
import { cb } from "../../ui/csb-popup-text";
import { getLang, t } from "../../ui/i18n";
import { Icon } from "../../ui/icons";
import { csbChanges } from "../csb-changes";

/** The two records, as the card reads them. */
export type Recs = { cfg: CsbConfig; st: CsbState };

/** The records from a read of their two keys (absent or not checking out: a backup never set up, a fresh state). */
export const recsOf = (x: Readonly<Record<string, unknown>>): Recs => ({
  cfg: parseCsbConfig(x[CSB_CFG_KEY]),
  st: parseCsbState(x[CSB_STATE_KEY]),
});

/**
 * Whether the popup speaks up (the pill "备份已停", the footer's problem line): on, and the card's line is one only the
 * person can fix: this browser's refusal, an error no retry fixes, or changes waiting for three days.
 */
export const stopped = (r: Recs, now: number): boolean => r.cfg.on && !backupRuns(r.cfg, r.st, now);

// The records, shared by every component that shows them (the pill and the footer). The open's own read brings them:
// the settings store reads them with the settings (src/platform/runtime-base.ts, the screen's `also`), so an open reads
// nothing more for them (test/e2e/perf.spec.ts), unless a change of them was heard since that read began (the screen's
// `mark`, ../csb-changes.ts, which listens from the page's start): then they are read again, so a change between that
// read and the listener here is not missed. From then on, a change of either reads both again, once, whoever shows
// them. Kept while anything shows them; dropped with the last, so a later mount (the list shown again) reads afresh.
let shared: Recs | null = null;
/** The open's records, used once: a mount after them reads afresh (they may be older than a change it did not hear). */
let taken: unknown = null;
const subs = new Set<(r: Recs) => void>();
let reading = false;
/** A change arrived while a read was out: read once more after it (that read may have started before the change). */
let again = false;
let events: chrome.storage.StorageArea["onChanged"] | undefined;
function readRecs(fresh: boolean): void {
  if (reading) {
    again ||= fresh;
    return;
  }
  reading = true;
  void Promise.resolve()
    .then(() => chrome.storage.local.get([CSB_CFG_KEY, CSB_STATE_KEY]))
    .then((r) => {
      shared = recsOf(r);
      subs.forEach((f) => f(shared!));
    })
    .catch(() => undefined)
    .finally(() => {
      reading = false;
      if (subs.size === 0) shared = null; // the last one went while this read was out: nothing kept for later
      if (again && subs.size > 0) {
        again = false;
        readRecs(false);
      }
    });
}
const changed = (x: Record<string, unknown>) => void ((CSB_CFG_KEY in x || CSB_STATE_KEY in x) && readRecs(true));
function watchRecs(
  f: (r: Recs) => void,
  open: Readonly<Record<string, unknown>> | undefined,
  mark: number | undefined,
): () => void {
  if (subs.size === 0) {
    events = chrome.storage?.local?.onChanged;
    events?.addListener(changed);
    // A read still out began before this listener: a change in between would be missed, so read once more after it.
    again ||= reading;
  }
  subs.add(f);
  if (!shared && !reading && open && open !== taken && mark === csbChanges()) {
    taken = open;
    shared = recsOf(open);
  }
  if (shared) f(shared);
  else readRecs(false);
  return () => {
    subs.delete(f);
    if (subs.size > 0) return;
    events?.removeListener(changed);
    events = undefined;
    shared = null;
    again = false;
  };
}

/** What Main hands the pill and the footer: the open's records (`also`) and the count of changes when it read them. */
type Open = { also?: Record<string, unknown> | undefined; mark?: number | undefined };

/**
 * The records (shared: watchRecs above), from the open's `also` and again on every change of them, drawn at once from
 * what the open read (watchRecs corrects them if they changed since); and whether the text is in (`ready`: the pill,
 * the footer's problem line). Null only with no records from the open, until read.
 */
export function useRecs(o: Open): { r: Recs | null; ready: boolean } {
  const [r, setR] = useState<Recs | null>(() => shared ?? (o.also ? recsOf(o.also) : null));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void cb.loaded.then(() => setReady(cb.words() != null));
    return watchRecs(setR, o.also, o.mark);
  }, []);
  return { r, ready };
}

/** The header pill once the backup is on; the popup's own ("本机", `children`) while it is off, or the text is not in. */
export function Pill(p: Open & { children: preact.ComponentChildren }) {
  const { r, ready } = useRecs(p);
  if (!ready || !r?.cfg.on) return <>{p.children}</>;
  const now = Date.now();
  const stop = stopped(r, now);
  const at = r.st.lastOk;
  // the check only once this vault as it is now has been handed to Chrome Sync: never before the first copy, nor while
  // changes wait (a clock then)
  const handed = at !== null && r.st.pendingSince === null;
  return (
    <span
      class={stop ? "loc stop" : "loc"}
      id="csb-pill"
      title={stop ? cb("cbStopped") : at !== null ? cb("cbOk", ago(at, now, getLang())) : cb("cbTitle")}
    >
      <Icon name={stop ? "alert" : handed ? "check" : "clock"} size={12} />
      <span>{cb(stop ? "cbStopped" : "cbPill")}</span>
    </span>
  );
}

/**
 * The footer. The backup on: the account count only while it runs (no reminder to back up), its problem line
 * ("N 个账户 · 备份出了问题") once it stopped. Off: with the reminder due and the backup never turned off by the person,
 * the one click; the popup's own footer (`children`, its reminder or the count) otherwise, and until the records are
 * there. `due` is the caller's: the reminder due in a profile only the person uses (Main.tsx).
 */
export function Foot(
  p: Open & { count: string; due: boolean; open: (h: string) => void; children: preact.ComponentChildren },
) {
  const { count, open } = p;
  const { r, ready } = useRecs(p);
  if (!r) return <>{p.children}</>;
  const plain = (
    <span class="bk">
      <span class="dot" />
      {count}
    </span>
  );
  if (r.cfg.on)
    return !stopped(r, Date.now()) || !ready ? (
      plain
    ) : (
      <a
        href="#"
        class="bk old"
        id="csb-problem"
        onClick={(ev) => {
          ev.preventDefault();
          open("#backup");
        }}
      >
        <span class="dot" />
        {count} · <u>{cb("cbProblem")}</u>
      </a>
    );
  if (r.cfg.declined || !p.due) return <>{p.children}</>;
  return (
    <a
      href="#"
      class="bk old"
      id="csb-now"
      onClick={(ev) => {
        ev.preventDefault();
        // the card takes it as it loads and turns the backup on (src/options/csb/CsbCard.tsx); nothing is sent from here
        void wantConnect().then(() => open("#backup"));
      }}
    >
      <span class="dot" />
      {count} · <u>{t("backupNow")}</u>
    </a>
  );
}
