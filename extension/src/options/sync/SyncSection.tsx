// The settings page's Sync section (SYNC-DESIGN §6: O1–O12, O14, P4), loaded when it is first shown (SyncHost.tsx): the
// explanation card while this profile has no sync records, the flows that turn sync on or join a vault, and once it is
// on, its state, the devices and the keys, with the flows that manage them (manage.ts). It runs the engine in this page,
// over the page's own runtime (gateway.ts kitFor). One flow at a time, whatever its kind: a lock, the page closing and
// the section going away reach whichever is open the same way.
import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatDateTime, t } from "../../ui/i18n";
import { Icon } from "../icons";
import { Panel, type Ctx } from "../shared";
import { ApproveFlow } from "./approve";
import { DevicesCtl, listDue } from "./devicelist";
import { EnableFlow } from "./enable";
import { EnableView } from "./EnableView";
import { FindFlow } from "./find";
import { DeleteFlow, ForkFlow } from "./fork";
import { API_HOST, dropPermission, kitFor, type DeviceRow, type SyncKit } from "./gateway";
import { JoinFlow } from "./join";
import { JoinView } from "./JoinView";
import { KeyOpFlow, type KeyOpKind } from "./keyops";
import { ApproveView, DeleteView, FindView, ForkView, KeyOpView, RepairView, RevokeView } from "./ManageViews";
import { RepairFlow } from "./repair";
import { RevokeFlow } from "./revoke";
import { watchLock, type LockArea } from "./lock";
import { railOf, type VaultState } from "./model";
import { SyncPanelCtl } from "./panel";
import { asking } from "./permission";
import { StatusView } from "./StatusView";
import { st } from "./text";
import { useStore } from "./use";
import { say } from "./widgets";

/** The rail's line for sync (Rail.tsx): its text and tone. */
export type SyncRail = { text: string; tone: "none" | "good" | "warn" | "bad"; on?: boolean };

type Flow =
  | { kind: "enable"; f: EnableFlow }
  | { kind: "join"; f: JoinFlow }
  | { kind: "approve"; f: ApproveFlow }
  | { kind: "keyop"; f: KeyOpFlow }
  | { kind: "revoke"; f: RevokeFlow }
  | { kind: "repair"; f: RepairFlow }
  | { kind: "fork"; f: ForkFlow }
  | { kind: "delete"; f: DeleteFlow }
  | { kind: "find"; f: FindFlow };

/** Which of sync's storage keys a change is about (the facts are read again then). */
const SYNC_RECORD = /^sk_(?:sync_|prejoin$)/;

/** O1: what sync is, what the server can and cannot see, what it needs, and the two ways in. */
function OffCard({
  ctx,
  joinOnly,
  onEnable,
  onJoin,
  onLeave,
}: {
  ctx: Ctx;
  joinOnly: boolean;
  onEnable: () => void;
  onJoin: () => void;
  onLeave?: (() => void) | undefined;
}) {
  const s = ctx.status;
  const hasPassword = (s.state === "unlocked" && s.passwordProtected) || s.state === "locked";
  const canEnable = s.state === "unlocked" && s.passwordProtected;
  const canJoin = s.state !== "locked";
  return (
    <div class="box sync-off" id="sync-off-card">
      <h3 class="bt">
        <Icon name="sync" size={17} />
        {st(joinOnly ? "syncJoinOnlyTitle" : "syncOffTitle")}
      </h3>
      <p>{st(joinOnly ? "syncJoinOnlyBody" : "syncOffBody")}</p>
      <details class="sync-sees" id="sync-sees">
        <summary>{st("syncSeesSummary")}</summary>
        <div class="grid2">
          <div>
            <b>{st("syncSeesCan")}</b>
            <ul>
              {["syncSeesCan1", "syncSeesCan2", "syncSeesCan3", "syncSeesCan4"].map((k) => (
                <li key={k}>{st(k)}</li>
              ))}
            </ul>
          </div>
          <div>
            <b>{st("syncSeesCannot")}</b>
            <ul>
              {["syncSeesCannot1", "syncSeesCannot2", "syncSeesCannot3"].map((k) => (
                <li key={k}>{st(k)}</li>
              ))}
            </ul>
          </div>
        </div>
        <p class="muted">{st("syncSeesMore")}</p>
      </details>
      {!joinOnly && (
        <ul class="sync-pre" aria-label={st("syncPreLabel")}>
          <li class={hasPassword ? "ok" : "no"}>
            <Icon name={hasPassword ? "check" : "x"} size={15} />
            {st(hasPassword ? "syncPreHasPassword" : "syncPreNoPassword")}
            {!hasPassword && s.state === "unlocked" && (
              <>
                {" "}
                <a href="#security">{st("syncPreSetPassword")}</a>
              </>
            )}
          </li>
        </ul>
      )}
      <p class="callout warn">
        <Icon name="alert" size={16} />
        <span>{st("syncSharedWarning")}</span>
      </p>
      <p class="callout">
        <Icon name="info" size={16} />
        <span>{st("syncPermissionNote", API_HOST)}</span>
      </p>
      {s.state === "locked" && (
        <p class="callout" id="sync-unlock-first">
          <Icon name="lock" size={16} />
          <span>{st("syncUnlockFirst")}</span>
        </p>
      )}
      <div class="row2">
        {!joinOnly && (
          <button class="btn" id="sync-turn-on" disabled={!canEnable} onClick={onEnable}>
            <Icon name="sync" size={15} />
            {st("syncTurnOn")}
          </button>
        )}
        <button class={`btn${joinOnly ? "" : " ghost"}`} id="sync-join-start" disabled={!canJoin} onClick={onJoin}>
          {st("syncJoinStart")}
        </button>
        {joinOnly && onLeave && (
          <button class="btn ghost" id="sync-join-leave" onClick={onLeave}>
            <Icon name="back" size={15} />
            {t("back")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * `joinOnly`: the section alone on the page of an empty profile (App.tsx). `onJoined`: the join is over there, and the page
 * shows its usual sections again; when the join's own screen stays (a join with the recovery code and its follow-ups, or
 * an unconfirmed join), `onHold` first, so that the page keeps the section alone until the user closes that screen (or
 * the follow-up it opened), and `onJoined` then.
 */
export function SyncSection({
  ctx,
  onRail,
  joinOnly = false,
  onLeave,
  onJoined,
  onHold,
  wiped = 0,
}: {
  ctx: Ctx;
  onRail: (r: SyncRail) => void;
  /** Counts the times the section was left for another leaf of the page: what was typed in its views goes (SyncHost.tsx). */
  wiped?: number;
  joinOnly?: boolean;
  onLeave?: () => void;
  onJoined?: () => void;
  onHold?: () => void;
}) {
  const kit: SyncKit = useMemo(() => kitFor(ctx.rt), [ctx.rt]);
  const vault = useRef<VaultState>(ctx.status.state);
  vault.current = ctx.status.state;
  const ctl = useMemo(() => new SyncPanelCtl(kit, { vault: () => vault.current, reload: ctx.reload }), [kit]);
  const p = useStore(ctl);
  const devices = useMemo(() => new DevicesCtl(kit), [kit]);
  const [flow, setFlow] = useState<Flow | null>(null);
  const flowRef = useRef<Flow | null>(null);
  flowRef.current = flow;

  // the facts: on opening, when sync's records change (this page, the worker, another page), and on permission events
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const again = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void ctl.refresh().catch(() => undefined), 150);
    };
    const changed = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && Object.keys(c).some((k) => SYNC_RECORD.test(k))) again();
    };
    chrome.storage.onChanged.addListener(changed);
    chrome.permissions.onAdded.addListener(again);
    chrome.permissions.onRemoved.addListener(again);
    void ctl.refresh().then(
      () => ctl.roundIfDue(),
      () => undefined,
    );
    return () => {
      if (timer) clearTimeout(timer);
      chrome.storage.onChanged.removeListener(changed);
      chrome.permissions.onAdded.removeListener(again);
      chrome.permissions.onRemoved.removeListener(again);
    };
  }, [ctl]);

  // every unlock of this page: a round with sync on (in "lock every time" only a page can), the kept saves folded with
  // sync off (no network)
  useEffect(() => {
    if (ctx.status.state !== "unlocked" || !p.facts) return;
    void ctl.roundIfDue();
    void ctl.foldKept();
  }, [ctx.status.state]);

  // a lock of Sixkey (lock.ts: from any context, or this page's own view moving from unlocked to locked): an open flow
  // ends, and the panel forgets a password it holds; the tab hidden: the panel forgets it too (Backup.tsx's rule)
  const lockedNow = () => {
    void flowRef.current?.f.locked();
    ctl.locked();
    devices.locked();
  };
  useEffect(() => {
    const area =
      typeof chrome !== "undefined" ? (chrome.storage?.session as unknown as LockArea | undefined) : undefined;
    const stop = area ? watchLock(area, () => kit.service.status(), lockedNow) : () => undefined;
    const hidden = () => {
      if (document.visibilityState === "hidden") ctl.forgetPassword();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [ctl, kit]);
  const seen = useRef(ctx.status.state);
  useEffect(() => {
    if (seen.current === "unlocked" && ctx.status.state === "locked") lockedNow();
    seen.current = ctx.status.state;
  }, [ctx.status.state]);

  // the device list, with sync on: when the section opens, at a lock or an unlock (names), when requests come or go,
  // and when the server's backoff has ended (never inside it: devicelist.ts listDue)
  const due = listDue(p.facts, Date.now());
  useEffect(() => {
    if (due) void devices.load();
  }, [due, ctx.status.state, p.facts?.pendingEnrollments]);

  // the rail's line
  useEffect(() => {
    if (!p.facts) return;
    const r = railOf(p.facts, ctx.status.state, Date.now(), formatDateTime);
    onRail(
      r ? { text: say(r.text), tone: r.tone, on: p.facts.syncOn } : { text: t("syncOff"), tone: "none", on: false },
    );
  }, [p.facts, ctx.status.state]);

  // the page going away (pagehide): what a closing page may not get to do later is done first, synchronously: the
  // permission a flow holds only for itself given back, and one held for a turn-off's review; then the flow is given up
  // (an approval request rejected if the page lives long enough, MUST 6)
  useEffect(() => {
    const away = () => {
      const cur = flowRef.current;
      if (cur?.f.leaving()) void dropPermission(kit); // the chrome.permissions call is made before this returns
      ctl.leaving();
      if (cur) void cur.f.cancel();
    };
    addEventListener("pagehide", away);
    return () => removeEventListener("pagehide", away);
  }, [ctl, kit]);
  // the section going away while the page stays (the wizard took its place, the join made the vault): the flow given up
  // as by Cancel; a flow that ended with sync on, or handed its sign-in over, gives nothing back
  useEffect(() => () => void flowRef.current?.f.cancel(), []);
  // a flow replaced by another: its listeners go (what it held passed to the new one, or was given back already)
  useEffect(() => {
    if (!flow) return;
    return () => flow.f.dispose();
  }, [flow]);

  // a flow that turned sync on: the page's state again (the join wrote the vault), then the first round and, if it went
  // through, the news (panel.ts settled). "unconfirmed": the flow's own screen stays until the user closes it.
  // A join with the recovery code keeps its own screen too: its two follow-ups (O7: a new recovery code, recommended; a
  // new master password, for a user who joined with the code because the password was forgotten).
  const held = useRef(false);
  const synced = (key: string) => (outcome: "done" | "enrolled" | "unconfirmed") => {
    const cur = flowRef.current;
    const byCode = cur?.kind === "join" && cur.f.state.at === "done" && cur.f.state.via === "recovery";
    const stays = outcome === "unconfirmed" || byCode;
    if (!stays) setFlow(null);
    else if (joinOnly && onHold) {
      held.current = true;
      onHold(); // before the reload: the page, no longer empty, keeps the section alone while that screen is up
    }
    void (async () => {
      await ctx.reload();
      if (!held.current) onJoined?.();
      await ctl.settled(outcome, key);
    })();
  };
  // a new flow in place of one still open (a join that found no vault, the turn-on flow that found one): the old one is
  // left without giving the permission back, which the new one's own click has just asked for again
  const replace = (next: Flow) => {
    const prev = flowRef.current;
    if (prev && prev.f !== next.f) prev.f.retire();
    setFlow(next);
  };
  const startEnable = asking(kit, (g) => {
    const f = new EnableFlow(kit, { onSyncOn: synced("syncDoneOn") });
    replace({ kind: "enable", f });
    void f.start(g);
  });
  const startJoin = asking(kit, (g) => {
    const f = new JoinFlow(kit, { name: st("syncDefaultName"), onSyncOn: synced("syncDoneJoined") });
    replace({ kind: "join", f });
    void f.start(g);
  });
  // the turn-on flow found a vault for this email: the join takes its sign-in and the permission over
  const handOver = (from: EnableFlow) =>
    asking(kit, () => {
      const f = new JoinFlow(kit, {
        signin: from.handOver(),
        name: st("syncDefaultName"),
        onSyncOn: synced("syncDoneJoined"),
      });
      replace({ kind: "join", f });
    });
  // the flows that manage a sync account that is on, each from a click that asks Chrome first (manage.ts)
  const startApprove = asking(kit, (g) => {
    const f = new ApproveFlow(kit);
    replace({ kind: "approve", f });
    void f.start(g);
  });
  const startKeyOp = (kind: KeyOpKind) =>
    asking(kit, (g) => {
      const f = new KeyOpFlow(kit, kind);
      replace({ kind: "keyop", f });
      void f.start(g);
    });
  const startRevoke = (row: DeviceRow, approved: DeviceRow[]) =>
    asking(kit, (g) => {
      const f = new RevokeFlow(
        kit,
        { id: row.id, name: row.name },
        approved.map((d) => ({ id: d.id, name: d.name })),
      );
      replace({ kind: "revoke", f });
      void f.start(g);
    });
  const startRepair = asking(kit, (g) => {
    const f = new RepairFlow(kit);
    replace({ kind: "repair", f });
    void f.start(g);
  });
  const startFork = asking(kit, (g) => {
    const f = new ForkFlow(kit);
    replace({ kind: "fork", f });
    void f.start(g);
  });
  const startDelete = asking(kit, (g) => {
    const f = new DeleteFlow(kit);
    replace({ kind: "delete", f });
    void f.start(g);
  });
  const startFind = asking(kit, (g) => {
    const f = new FindFlow(kit);
    replace({ kind: "find", f });
    void f.start(g);
  });
  const closed = () => {
    setFlow(null);
    void ctl.refresh();
    if (listDue(p.facts, Date.now())) void devices.load();
    if (held.current) {
      held.current = false;
      onJoined?.();
    }
  };

  const f = p.facts;
  const off =
    f !== null &&
    !f.syncOn &&
    (f.local === "off" || (f.local === "cfg_missing" && f.identity?.state === "pending" && !f.identity.pinned));
  return (
    <Panel id="sync" icon="sync" title={t("syncLabel")} lead={st("syncLead")}>
      {/* the views are drawn again when the section was left: the flows go on (they are held above), the typed text does not */}
      <Fragment key={wiped}>
        {flow?.kind === "enable" && (
          <EnableView
            flow={flow.f}
            kit={kit}
            vault={ctx.vault}
            onHandOver={handOver(flow.f)}
            onJoin={startJoin}
            onClose={closed}
          />
        )}
        {flow?.kind === "join" && (
          <JoinView
            flow={flow.f}
            kit={kit}
            vault={ctx.vault}
            onEnable={startEnable}
            onClose={closed}
            onNewCode={startKeyOp("recovery")}
            onNewPassword={startKeyOp("reset")}
          />
        )}
        {flow?.kind === "approve" && <ApproveView flow={flow.f} onClose={closed} />}
        {flow?.kind === "keyop" && <KeyOpView flow={flow.f} kit={kit} onClose={closed} />}
        {flow?.kind === "revoke" && (
          <RevokeView flow={flow.f} kit={kit} onClose={closed} onRotate={startKeyOp("rotate")} />
        )}
        {flow?.kind === "repair" && <RepairView flow={flow.f} onClose={closed} />}
        {flow?.kind === "fork" && <ForkView flow={flow.f} onClose={closed} />}
        {flow?.kind === "delete" && <DeleteView flow={flow.f} kit={kit} onClose={closed} />}
        {flow?.kind === "find" && <FindView flow={flow.f} onClose={closed} />}
        {!flow && f === null && (
          <p class="muted" aria-busy="true">
            {st("syncChecking")}
          </p>
        )}
        {!flow && f !== null && (
          <StatusView
            ctl={ctl}
            devices={devices}
            kit={kit}
            vault={ctx.vault}
            vaultState={ctx.status.state}
            open={{
              onJoinAgain: startJoin,
              onApprove: startApprove,
              onKeyOp: startKeyOp,
              onRevoke: startRevoke,
              onRepair: startRepair,
              onFork: startFork,
              onDelete: startDelete,
              onFind: startFind,
            }}
          />
        )}
        {!flow && off && (
          <OffCard ctx={ctx} joinOnly={joinOnly} onEnable={startEnable} onJoin={startJoin} onLeave={onLeave} />
        )}
      </Fragment>
    </Panel>
  );
}
