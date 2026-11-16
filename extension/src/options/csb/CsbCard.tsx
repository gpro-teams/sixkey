// Settings › Backup's first card: the backup in Chrome's sync storage, in a lazy chunk with its own text
// (src/ui/csb-text.ts). Which state is model.ts's cardView, from the two records the worker writes
// (platform/csb-config.ts), re-read on every change of them. The page never writes chrome.storage.sync: it sends the
// worker sk-csb-* messages (merge.ts), and reads the copies only to merge them.
//   - Off, one button "开启" (no unlock needed); never turned on by itself for a vault that exists. The popup's
//     "立即备份" stands for that button: it leaves "turn on now" (platform/cloud-go.ts), which the card takes as it loads,
//     unless the person turned the backup off before or the profile is not theirs alone. The cost line is
//     always on the card, and what "handed to Chrome Sync" means where the card says it or offers it: Sixkey can
//     confirm the act, never that Chrome uploaded it. In a profile declared shared, whose Google account it would be.
//   - On: one status line, with when it was handed over; a problem is amber and blocks nothing; what fixes it is a button
//     beside "关闭": the encrypted file ("另存加密备份") when the vault is too large or the space is full, a merge where a
//     copy here may be newer (held) or other copies take the room (no_room). Merges need the vault open, and what opens
//     another copy typed; the held copy opens with a key held here first.
//   - "关闭" removes this computer's own copy, but while held, and says so beside it.
//   - Within a screen and a half with the rest of Settings › Backup at 1400 x 900, in every state
//     (test/e2e/csb-card-visual.spec.ts).
import { useEffect, useRef, useState } from "preact/hooks";
import type { Vault } from "../../core/vault/model";
import { profileOf } from "../../core/service/types";
import { takeConnect } from "../../platform/cloud-go";
import { CSB_CFG_KEY, CSB_STATE_KEY, parseCsbConfig, parseCsbState } from "../../platform/csb-config";
import type { CsbConfig, CsbState } from "../../platform/csb-config";
import type { Runtime } from "../../platform/runtime";
import { cs, isChrome } from "../../ui/csb-text";
import { getLang } from "../../ui/i18n";
import { Icon } from "../icons";
import { BoxTitle, errText } from "../shared";
import { ask, mergeHeld, mergeOthers, removeMerged, type Merged, type MergeResult } from "./merge";
import { ago, amber, cardView, reasonKey, saysHonest, stoppedKey, usageLine, type CardView } from "./model";

const TICK_MS = 30_000;
type Records = { cfg: CsbConfig; st: CsbState; shared: boolean };
/** The merge the card is asking what opens: the held copy (after a key change), others' copies, or the room's. */
type Asking = "held" | "others" | "clean";

async function readRecords(rt: Pick<Runtime, "local" | "settings">): Promise<Records> {
  const r = await rt.local.get([CSB_CFG_KEY, CSB_STATE_KEY]);
  const shared = await rt.settings.get().then(
    (s) => profileOf(s) === "shared",
    () => false,
  );
  return { cfg: parseCsbConfig(r[CSB_CFG_KEY]), st: parseCsbState(r[CSB_STATE_KEY]), shared };
}

export function CsbCard({
  rt,
  unlocked,
  vault,
  onSaveFile,
}: {
  rt: Runtime;
  unlocked: boolean;
  /** The vault as the page holds it (unlocked): its id for the merges, its entries for the space line. */
  vault: Vault | null;
  /** Opens Settings › Backup's encrypted file ("加密备份"). */
  onSaveFile: () => void;
}) {
  const [rec, setRec] = useState<Records | null>(null);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [typed, setTyped] = useState("");
  const [said, setSaid] = useState<{ good: boolean; text: string } | null>(null);
  // another vault's copies just merged, which the person may now remove from Chrome Sync (their vaults in this page's
  // memory, to merge again in the removal's own commit); gone with a lock
  const [toRemove, setToRemove] = useState<Merged[] | null>(null);
  // one action at a time: the ref answers within the click, the state draws the buttons disabled
  const acting = useRef(false);
  const refresh = () =>
    readRecords(rt).then(
      (r) => (setRec(r), r),
      () => null,
    );

  useEffect(() => {
    void cs.loaded.then(() => setReady(cs.words() != null));
    // the popup's "立即备份" left "turn on now" for this card (platform/cloud-go.ts): taken as the card loads, within its
    // minute, and the backup turned on as the card's own button does; not where the person turned it off before, nor in
    // a profile not theirs alone
    void Promise.all([refresh(), takeConnect()]).then(([r, go]) => {
      if (go && r && !r.cfg.on && !r.cfg.declined && !r.shared) void send("sk-csb-on");
    });
    const changed = (c: Record<string, unknown>) => {
      if (CSB_CFG_KEY in c || CSB_STATE_KEY in c) void refresh();
    };
    chrome.storage.local.onChanged.addListener(changed);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      chrome.storage.local.onChanged.removeListener(changed);
      clearInterval(tick);
    };
  }, []);
  // what was typed to open a copy goes with a lock
  useEffect(() => {
    if (unlocked) return;
    setAsking(null);
    setTyped("");
    setToRemove(null);
  }, [unlocked]);

  async function act(fn: () => Promise<string | null>): Promise<void> {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setSaid(null);
    try {
      const bad = await fn();
      if (bad) setSaid({ good: false, text: bad });
    } catch (e) {
      setSaid({ good: false, text: errText(e) });
    } finally {
      acting.current = false;
      setBusy(false);
      await refresh();
    }
  }
  /**
   * A message to the worker. A refusal because this browser would not close the area to web pages' scripts is said by
   * the card's own line, from the state the worker wrote before it answered: not twice.
   */
  const send = (type: string, more: Record<string, unknown> = {}) =>
    act(async () => {
      await ask(type, more);
      return null;
    });
  /** A merge's result, said: what it did, or why not; asking for what opens the copy when it needs that. */
  function told(r: MergeResult, which: Asking): string | null {
    if (r.kind === "secret") {
      setAsking(which);
      return null;
    }
    if (r.kind === "done") {
      setAsking(null);
      setTyped("");
      setToRemove(r.merged?.length ? r.merged : null);
      const parts = [cs("csMerged")];
      if (r.added > 0) parts.push(cs("csAdded", r.added));
      if (r.removed > 0) parts.push(cs("csRemoved", r.removed));
      if (r.notFit) parts.push(cs("csNotRemoved"));
      else if (r.kept > 0 && !r.merged) parts.push(cs("csKept", r.kept));
      setSaid({ good: !r.notFit, text: parts.join(" ") });
      return null;
    }
    return cs(
      r.kind === "wrong"
        ? "csWrong"
        : r.kind === "typo"
          ? "csKeyTypo"
          : r.kind === "nothing"
            ? "csNothing"
            : r.kind === "unsafe"
              ? "csUnsafeArea"
              : "csMergeAgain",
    );
  }
  const remove = (groups: Merged[]) =>
    act(async () => {
      setToRemove(null);
      return told(await removeMerged(rt, groups), "others");
    });
  const merge = (which: Asking, secret?: string) =>
    act(async () => {
      if (!vault) return cs("csUnlockToMerge");
      const r =
        which === "held"
          ? await mergeHeld(rt, secret)
          : await mergeOthers(rt, secret ?? "", { vaultId: vault.vaultId, remove: which === "clean" });
      return told(r, which);
    });

  if (!ready || !rec) return null;
  const { cfg, st } = rec;
  const v: CardView = cardView(cfg, st, now);
  const on = v.kind !== "off";
  const held = v.kind === "stopped" && v.err === "held";
  const space = usageLine(cfg, st, vault ? vault.entries.length : null);
  const others = on && st.others.otherVaults > 0;
  const canMerge = unlocked && vault !== null;
  return (
    <div class="box" id="csb-card" data-state={v.kind === "stopped" ? v.err : v.kind}>
      <BoxTitle icon="sync">{cs("csTitle")}</BoxTitle>
      {v.kind === "off" && <p class="muted">{cs("csBody")}</p>}
      <Status v={v} st={st} now={now} />
      {/* off, and a page's or a run's ask found this browser would not close the area to web pages' scripts */}
      {v.kind === "off" && st.unsafe && (
        <p class="callout warn" id="cs-unsafe">
          <Icon name="alert" size={16} />
          <span>{cs("csUnsafeArea")}</span>
        </p>
      )}
      {saysHonest(v) && (
        <p class="muted" id="cs-honest">
          {cs(isChrome() ? "csHonest" : "csBrowserUnknown")}
        </p>
      )}
      {st.seen && on && saysHonest(v) && (
        <p class="muted" id="cs-seen">
          {cs("csSeen")}
        </p>
      )}
      {space && (
        <p class="muted" id="cs-usage">
          {space.kind === "usage" ? cs("csUsage", space.pct, space.kb) : cs("csNearFull", space.more)}
        </p>
      )}
      {others && (
        <p class="muted" id="cs-others">
          {cs("csOthers", st.others.otherVaults)}
        </p>
      )}
      <p class="callout" id="cs-cost">
        <Icon name="info" size={16} />
        <span>{cs(cfg.opens === "recovery" ? "csCostRecovery" : "csCost")}</span>
      </p>
      {v.kind === "off" && rec.shared && (
        <p class="muted" id="cs-shared">
          {cs("csShared")}
        </p>
      )}
      {/* while a merge asks what opens the copies, the switch, the card's buttons and 关闭's line wait (the form's 取消
          brings them back): the card stays within the leaf's screen and a half */}
      {!asking && (
        <label class="check">
          <input
            type="checkbox"
            id="cs-opens"
            disabled={busy}
            checked={cfg.opens === "recovery"}
            onChange={(e) =>
              void act(async () => {
                await ask("sk-csb-opens", { opens: (e.target as HTMLInputElement).checked ? "recovery" : "both" });
                return null;
              })
            }
          />{" "}
          {cs("csSwitch")}
        </label>
      )}
      {said && (
        <p class={said.good ? "callout good" : "callout warn"} id={said.good ? "cs-result" : "cs-error"} role="status">
          <Icon name={said.good ? "check" : "alert"} size={16} />
          <span>{said.text}</span>
        </p>
      )}
      {/* another vault's copies just merged: removing them from Chrome Sync is the person's click */}
      {toRemove && canMerge && !asking && (
        <div class="row2" id="cs-drop-row">
          <button class="btn ghost sm" id="cs-drop-merged" disabled={busy} onClick={() => void remove(toRemove)}>
            {cs("csDropMerged")}
          </button>
          <span class="muted" id="cs-drop-hint">
            {cs("csDropHint")}
          </span>
        </div>
      )}
      {asking && canMerge && (
        <form
          id="cs-merge-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed) void merge(asking, typed);
          }}
        >
          {asking === "clean" && <p class="muted">{cs("csMergeCleanHint")}</p>}
          <div class="field">
            <label for="cs-secret">{cs("csSecret")}</label>
            <input
              id="cs-secret"
              type="password"
              autocomplete="off"
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="row2">
            <button class="btn" type="submit" id="cs-merge-go" disabled={busy || !typed}>
              {cs("csMerge")}
            </button>
            <button
              class="btn ghost sm"
              type="button"
              id="cs-merge-cancel"
              disabled={busy}
              onClick={() => {
                setAsking(null);
                setTyped("");
              }}
            >
              {cs("csCancel")}
            </button>
          </div>
        </form>
      )}
      {(held || others || (v.kind === "stopped" && v.err === "no_room")) && !canMerge && (
        <p class="muted" id="cs-unlock">
          {cs("csUnlockToMerge")}
        </p>
      )}
      <div class="row2" hidden={asking !== null}>
        {v.kind === "off" && (
          <button class="btn" id="cs-on" disabled={busy} onClick={() => void send("sk-csb-on")}>
            {cs("csOn")}
          </button>
        )}
        {held && (
          <button class="btn" id="cs-held-merge" disabled={busy || !canMerge} onClick={() => void merge("held")}>
            {cs("csHeldMerge")}
          </button>
        )}
        {/* the encrypted file is the fix that removes nothing: the main button; the merge that removes copies is not */}
        {v.kind === "stopped" && (v.err === "too_large" || v.err === "no_room") && (
          <button class="btn" id="cs-save-file" onClick={onSaveFile}>
            {cs("csSaveFile")}
          </button>
        )}
        {v.kind === "stopped" && v.err === "no_room" && (
          <button
            class="btn ghost sm"
            id="cs-merge-clean"
            disabled={busy || !canMerge}
            onClick={() => {
              setSaid(null);
              setAsking("clean");
            }}
          >
            {cs("csMergeClean")}
          </button>
        )}
        {others && (
          <button
            class="btn ghost sm"
            id="cs-merge-others"
            disabled={busy || !canMerge}
            onClick={() => {
              setSaid(null);
              setAsking("others");
            }}
          >
            {cs("csMergeOthers")}
          </button>
        )}
        {on && v.kind !== "stopped" && v.kind !== "unsafe" && v.kind !== "empty" && (
          <button class="btn ghost sm" id="cs-now" disabled={busy} onClick={() => void send("sk-csb-now")}>
            {cs("csNow")}
          </button>
        )}
        {on && (
          <button class="btn ghost sm" id="cs-off" disabled={busy} onClick={() => void send("sk-csb-off")}>
            {cs("csOff")}
          </button>
        )}
      </div>
      {on && !asking && (
        <p class="muted" id="cs-off-hint">
          {cs(held ? "csOffHeld" : "csOffHint")}
        </p>
      )}
    </div>
  );
}

function Status({ v, st, now }: { v: CardView; st: CsbState; now: number }) {
  let line: string;
  switch (v.kind) {
    case "off":
      return null;
    case "unsafe":
      line = cs("csUnsafeArea");
      break;
    case "empty":
      line = cs("csEmpty");
      break;
    case "saving":
      line = cs("csSaving");
      break;
    case "ok":
      line = cs("csOk", ago(v.at, now, getLang()));
      break;
    case "waiting":
      line = cs("csWaiting");
      break;
    case "failed":
      line = cs("csFailed", cs(reasonKey(v.err)));
      break;
    case "stale":
      line = v.err === null ? cs("csStaleQuiet", v.days) : cs("csStale", v.days, cs(reasonKey(v.err)));
      break;
    case "stopped":
      // no room: how many other copies take it, and how much (the worker's count at its last run)
      line =
        v.err === "no_room" ? cs("csNoRoom", st.others.n, Math.round(st.others.bytes / 1024)) : cs(stoppedKey[v.err]);
      break;
  }
  const warn = amber(v);
  return (
    <p class={warn ? "callout warn" : v.kind === "ok" ? "callout good" : "callout"} id="cs-status" role="status">
      <Icon name={warn ? "alert" : v.kind === "ok" ? "check" : "info"} size={16} />
      <span>{line}</span>
    </p>
  );
}
