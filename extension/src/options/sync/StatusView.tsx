// O12 and P4: the state sync is in (one card, model.ts cardOf), what it offers, the one-time notices, the saves kept
// while they cannot be read; with sync on, the devices (O8) and the keys (O11); and this device: turning sync off
// (§3.10), and under "Advanced" clearing the server's history and deleting the sync account (O14). The card's text is a
// polite live region, so a change of state is read out without moving the focus. Every handler that starts something
// needing the network asks Chrome first (permission.ts asking): here, or in SyncSection for the flows it opens.
import { useEffect, useState } from "preact/hooks";
import { formatDateTime, t } from "../../ui/i18n";
import { Icon, type IconName } from "../icons";
import type { Vault } from "../../core/vault/model";
import { isLastDevice, type DevicesCtl } from "./devicelist";
import { DevicesView } from "./DevicesView";
import { API_HOST, type DeviceRow, type SyncKit } from "./gateway";
import type { KeyOpKind } from "./keyops";
import { cardOf, noticesOf, parkedLines, type ActionId, type Card, type Tone, type VaultState } from "./model";
import type { SyncPanelCtl } from "./panel";
import { asking } from "./permission";
import { ReviewView } from "./ReviewView";
import { st } from "./text";
import { useStore } from "./use";
import { Confirm, FailureLine, Say } from "./widgets";

const ICON: Record<Tone, IconName> = {
  good: "check",
  busy: "sync",
  info: "info",
  warn: "alert",
  danger: "shieldAlert",
};

/** What each action button says. */
const LABEL: Record<ActionId, string> = {
  sync_now: "syncActSyncNow",
  grant: "syncActGrant",
  unlock: "syncActUnlock",
  adopt: "syncActAdopt",
  review: "syncActReview",
  remove_identity: "syncActRemoveIdentity",
  check_again: "syncActCheckAgain",
  start_over: "syncActJoinAgain",
  backup: "syncActBackup",
  restore_cloud: "syncActRestoreCloud",
  start_over_vault: "syncActStartOver",
  repair: "syncActRepair",
  rejoin: "syncActRejoin",
  rotate_keys: "syncKeyRotateTitle",
};

/** The flows the panel opens (SyncSection binds them, each asking Chrome first). */
export type PanelOpeners = {
  onJoinAgain: () => void;
  onApprove: () => void;
  onKeyOp: (kind: KeyOpKind) => () => void;
  onRevoke: (row: DeviceRow, approved: DeviceRow[]) => () => void;
  onRepair: () => void;
  onFork: () => void;
  onDelete: () => void;
  onFind: () => void;
};

/** A rotation owed (§3.10) that turning off or removing the identity would forget: said, and only an explicit tick lets it go. */
function OwedDrop({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="callout warn" id={id}>
      <Icon name="alert" size={16} />
      <span>
        {st("syncTurnOffRotationOwed")}
        <label class="check">
          <input
            type="checkbox"
            id={`${id}-drop`}
            checked={checked}
            onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
          />{" "}
          {st("syncOwedDrop")}
        </label>
      </span>
    </div>
  );
}

/** The master password for a delete that cannot be undone (VaultService.requireMasterPassword checks it). */
function DestroyPassword({ id, value, onValue }: { id: string; value: string; onValue: (v: string) => void }) {
  return (
    <div class="field">
      <label for={id}>{t("passwordLabel")}</label>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        aria-describedby={`${id}-why`}
        value={value}
        onInput={(e) => onValue((e.target as HTMLInputElement).value)}
      />
      <p class="muted" id={`${id}-why`}>
        {t("eraseNeedsPassword")}
      </p>
    </div>
  );
}

export function StatusView({
  ctl,
  devices,
  kit,
  vault,
  vaultState,
  open,
}: {
  ctl: SyncPanelCtl;
  devices: DevicesCtl;
  kit: SyncKit;
  vault: Vault | null;
  vaultState: VaultState;
  open: PanelOpeners;
}) {
  const p = useStore(ctl);
  const devicesState = useStore(devices);
  const [adopting, setAdopting] = useState(false);
  const [pw, setPw] = useState("");
  const [offPw, setOffPw] = useState("");
  const [offOpen, setOffOpen] = useState<null | "off" | "rejoin">(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [keptOpen, setKeptOpen] = useState(false);
  const [dropOwed, setDropOwed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPw, setHistoryPw] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [destroyPw, setDestroyPw] = useState(""); // the deletes that cannot be undone (kept vaults, parked saves)
  // a typed master password does not wait in its field for whoever sits down next (Backup.tsx's rule): emptied when
  // Sixkey locks or the tab is hidden (panel.ts forgetPassword)
  useEffect(() => {
    setPw("");
    setOffPw("");
    setHistoryPw("");
    setDestroyPw("");
  }, [p.forgot]);
  const f = p.facts;
  if (!f) return null;
  const c: Card | null = cardOf(f, vaultState, Date.now(), formatDateTime, API_HOST);
  const busy = p.doing !== null;

  const act = (a: ActionId) => {
    switch (a) {
      case "sync_now":
      case "review":
        return () => void ctl.syncNow();
      case "grant":
        return asking(kit, (g) => void ctl.grant(g)); // Chrome's prompt, first (permission.ts)
      case "unlock":
        return () => {
          const el = document.getElementById("unlock-pw");
          el?.scrollIntoView({ block: "center" });
          el?.focus();
        };
      case "adopt":
        return () => setAdopting(true);
      case "remove_identity":
        return () => setRemoveOpen(true);
      case "check_again":
        return () => void ctl.checkAgain();
      case "start_over":
        return open.onJoinAgain;
      case "backup":
        return () => {
          location.hash = "#backup";
        };
      case "restore_cloud":
        // the cloud restore is an adoption with the master password (§4.13), over the network: Chrome is asked first
        // (the lost-vault card is shown whatever the permission says)
        return asking(
          kit,
          (g) =>
            void ctl.permit(g).then((ok) => {
              if (ok) setAdopting(true);
            }),
        );
      case "start_over_vault":
        // Phase 0's start over, behind its own typed confirmation (the Advanced section's DELETE box, shown while the
        // vault is lost): it erases what is left of the unreadable vault
        return () => {
          location.hash = "#advanced";
        };
      case "repair":
        return open.onRepair;
      case "rejoin":
        return () => setOffOpen("rejoin");
      case "rotate_keys":
        return open.onKeyOp("rotate");
    }
  };

  const notices = noticesOf(f.notices);
  const parked = f.parked ? parkedLines(f.parked) : null;
  // turning off: the permission asked in the same click (the revocation needs the network), then the password checked
  const turnOff = asking(kit, (g) => {
    const had = f.permission;
    const rejoin = offOpen === "rejoin";
    void ctl.turnOff(offPw, g, had, undefined, { dropOwed }).then((ok) => {
      if (ok) setOffOpen(null);
      if (ok && rejoin) ctl.announce("syncDoneRejoinNext"); // sync is off here: the explanation card's Join comes next
      if (ok || ctl.state.review) setOffPw(""); // stopped for a review: the panel holds the password for its answer
    });
  });
  // §3.10: revoking the last device keeps the synced vault on the server; joining it again then needs the recovery code
  const lastDevice = isLastDevice(devicesState.rows);
  const clearHistory = asking(
    kit,
    (g) =>
      void devices.clearHistory(historyPw, g).then((ok) => {
        setHistoryPw("");
        if (ok) setHistoryOpen(false);
      }),
  );
  const on = f.syncOn && f.local === "on";
  // the key operations wait for the repair (§3.14): the server's keys behind this device's, or back on an older VK
  const behind = f.keyStatus === "keys_behind" || f.status === "server_older_key";
  const keysBlocked = behind || f.keyStatus === "update_required";
  const locked = vaultState !== "unlocked";

  return (
    <>
      {p.review && (
        <ReviewView
          blocked={p.review}
          vault={vault}
          busy={busy}
          onAnswer={(a) => void ctl.answer(a)}
          onClose={() => ctl.dismissReview()}
        />
      )}

      {c && (
        <section class={`box sync-card ${c.tone}`} id="sync-card" data-state={c.id} aria-labelledby="sync-card-t">
          <div class="sc-top">
            <span class="sc-ic">
              <Icon name={ICON[c.tone]} size={20} />
            </span>
            <div role="status" aria-live="polite" class="sc-tx">
              <h3 class="bt" id="sync-card-t">
                <Say x={c.title} />
              </h3>
              {c.lines.map((l, i) => (
                <p key={i} class={i ? "muted" : ""}>
                  <Say x={l} />
                </p>
              ))}
            </div>
          </div>
          {!offOpen && <FailureLine failure={p.failure} id="sync-card-err" />}
          {p.done && (
            <p class="ok-msg" role="status" id="sync-done-msg">
              <Icon name="check" size={15} />
              {st(p.done)}
            </p>
          )}
          {adopting && (c.actions.includes("adopt") || c.actions.includes("restore_cloud")) && (
            <form
              class="sync-adopt"
              onSubmit={(e) => {
                e.preventDefault();
                void ctl.adopt(pw).then(() => {
                  setPw("");
                  setAdopting(false);
                });
              }}
            >
              <div class="field">
                <label for="sync-adopt-pw">{t("passwordLabel")}</label>
                <input
                  id="sync-adopt-pw"
                  type="password"
                  autoComplete="current-password"
                  value={pw}
                  onInput={(e) => setPw((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="row2">
                <button class="btn" type="submit" id="sync-adopt-go" disabled={busy || !pw}>
                  {st(
                    c.actions.includes("restore_cloud")
                      ? "syncActRestoreCloud"
                      : c.id === "locked"
                        ? "syncActAdoptPending"
                        : "syncActAdopt",
                  )}
                </button>
                <button class="btn sm ghost" type="button" onClick={() => setAdopting(false)}>
                  {t("cancel")}
                </button>
              </div>
            </form>
          )}
          {p.confirmOlder && (
            <Confirm title={st("syncOlderTitle")} onCancel={() => ctl.keepCurrent()} id="sync-older">
              <p>{st("syncOlderBody")}</p>
              <div class="row2">
                <button class="btn" onClick={() => ctl.keepCurrent()}>
                  {st("syncOlderKeep")}
                </button>
                <button
                  class="btn ghost danger-text"
                  id="sync-older-adopt"
                  onClick={() => void ctl.adopt("", { confirmOlder: true })}
                >
                  {st("syncOlderAdopt")}
                </button>
              </div>
            </Confirm>
          )}
          {c.actions.length > 0 && !adopting && (
            <div class="row2">
              {c.actions.map((a, i) => (
                <button
                  key={a}
                  type="button"
                  class={`btn${i ? " ghost" : ""}${a === "remove_identity" ? " danger-text" : ""}`}
                  id={`sync-act-${a}`}
                  disabled={busy}
                  onClick={act(a)}
                >
                  {p.doing === "round" && (a === "sync_now" || a === "review")
                    ? st("syncSyncing")
                    : st(a === "adopt" && c.id === "locked" ? "syncActAdoptPending" : LABEL[a])}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {!c && p.done && (
        <p class="ok-msg" role="status" id="sync-done-msg">
          <Icon name="check" size={15} />
          {st(p.done)}
        </p>
      )}
      {!c && <FailureLine failure={p.failure} id="sync-card-err" />}

      {notices.length > 0 && (
        <div class="box sync-notices" id="sync-notices">
          <ul>
            {notices.map((n) => (
              <li key={`${n.notice.kind}-${n.notice.at}`} class={n.tone}>
                <Icon name={ICON[n.tone]} size={15} />
                <span>
                  <Say x={n.text} />{" "}
                  <time class="muted" dateTime={new Date(n.notice.at).toISOString()}>
                    {formatDateTime(n.notice.at)}
                  </time>
                  {n.link === "trash" && (
                    <>
                      {" "}
                      <a href="#trash">{st("syncSeeTrash")}</a>
                    </>
                  )}
                  {n.link === "backup" && (
                    <>
                      {" "}
                      <a href="#backup">{st("syncActBackup")}</a>
                    </>
                  )}
                  {n.act === "fork" && on && (
                    <>
                      {" "}
                      <button class="btn sm ghost" id="sync-fork-open" onClick={open.onFork}>
                        {st("syncForkOpen")}
                      </button>
                    </>
                  )}
                  {n.act === "find" && on && !locked && (
                    <>
                      {" "}
                      <button class="btn sm ghost" onClick={open.onFind}>
                        {st("syncFindTitle")}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div class="row2">
            <button
              class="btn sm ghost"
              id="sync-notices-ack"
              onClick={() => void ctl.dismiss(notices.map((n) => n.notice))}
            >
              {t("gotIt")}
            </button>
          </div>
        </div>
      )}

      {parked && f.parked && (
        <div class="box" id="sync-parked">
          <h3 class="bt">
            <Icon name="archive" size={17} />
            <Say x={parked.title} />
          </h3>
          <ul class="sec-inv">
            {parked.ways.map((w, i) => (
              <li key={i}>
                <Say x={w} />
              </li>
            ))}
          </ul>
          <details>
            <summary>{st("syncAdvanced")}</summary>
            {discardOpen ? (
              <Confirm
                title={st("syncParkedDeleteTitle", f.parked.count)}
                tone="danger"
                onCancel={() => setDiscardOpen(false)}
                id="sync-parked-confirm"
              >
                <p>{st("syncParkedDeleteBody")}</p>
                <DestroyPassword id="sync-parked-pw" value={destroyPw} onValue={setDestroyPw} />
                <div class="row2">
                  <button
                    class="btn danger"
                    id="sync-parked-delete"
                    disabled={busy || !destroyPw}
                    onClick={() =>
                      void ctl.discard(f.parked!, destroyPw).then(() => {
                        setDestroyPw("");
                        setDiscardOpen(false);
                      })
                    }
                  >
                    {st("syncParkedDelete")}
                  </button>
                  <button class="btn ghost" onClick={() => setDiscardOpen(false)}>
                    {t("cancel")}
                  </button>
                </div>
              </Confirm>
            ) : (
              <div class="row2">
                <button class="btn sm ghost danger-text" id="sync-parked-open" onClick={() => setDiscardOpen(true)}>
                  {st("syncParkedDelete")}
                </button>
              </div>
            )}
          </details>
        </div>
      )}

      {f.kept.length > 0 && (
        <div class="box" id="sync-kept">
          <h3 class="bt">
            <Icon name="archive" size={17} />
            {st("syncKeptTitle", f.kept.length)}
          </h3>
          <p class="muted">{st("syncKeptBody")}</p>
          <ul class="sec-inv">
            {f.kept.map((k) => (
              <li key={k.id}>
                {k.at !== null ? st("syncKeptItem", formatDateTime(k.at)) : st("syncKeptItemUnreadable")}
              </li>
            ))}
          </ul>
          <details>
            <summary>{st("syncAdvanced")}</summary>
            {keptOpen ? (
              <Confirm
                title={st("syncKeptDeleteTitle", f.kept.length)}
                tone="danger"
                onCancel={() => setKeptOpen(false)}
                id="sync-kept-confirm"
              >
                <p>{st("syncKeptDeleteBody")}</p>
                <DestroyPassword id="sync-kept-pw" value={destroyPw} onValue={setDestroyPw} />
                <div class="row2">
                  <button
                    class="btn danger"
                    id="sync-kept-delete"
                    disabled={busy || locked || !destroyPw}
                    onClick={() =>
                      void ctl.discardKept(f.kept, destroyPw).then(() => {
                        setDestroyPw("");
                        setKeptOpen(false);
                      })
                    }
                  >
                    {st("syncKeptDeleteGo")}
                  </button>
                  <button class="btn ghost" onClick={() => setKeptOpen(false)}>
                    {t("cancel")}
                  </button>
                </div>
              </Confirm>
            ) : (
              <div class="row2">
                <button
                  class="btn sm ghost danger-text"
                  id="sync-kept-open"
                  disabled={locked}
                  onClick={() => setKeptOpen(true)}
                >
                  {st("syncKeptDeleteOpen")}
                </button>
              </div>
            )}
          </details>
        </div>
      )}

      {removeOpen && (
        <Confirm
          title={st("syncRemoveTitle")}
          tone="danger"
          onCancel={() => setRemoveOpen(false)}
          id="sync-remove-confirm"
        >
          <p>{st("syncRemoveBody")}</p>
          <p class="muted">{st("syncUninstallNote")}</p>
          {f.rotationOwed && <OwedDrop id="sync-remove-owed" checked={dropOwed} onChange={setDropOwed} />}
          <FailureLine failure={p.failure} id="sync-remove-err" />
          <div class="row2">
            <button
              class="btn danger"
              id="sync-remove-go"
              disabled={busy || (!!f.rotationOwed && !dropOwed)}
              onClick={() => void ctl.removeIdentity(undefined, { dropOwed }).then((ok) => ok && setRemoveOpen(false))}
            >
              {st("syncActRemoveIdentity")}
            </button>
            <button class="btn ghost" onClick={() => setRemoveOpen(false)}>
              {t("cancel")}
            </button>
          </div>
        </Confirm>
      )}

      {on && (
        <DevicesView
          ctl={devices}
          kit={kit}
          pending={f.pendingEnrollments}
          locked={locked}
          onApprove={open.onApprove}
          onRevoke={open.onRevoke}
          forgot={p.forgot}
        />
      )}

      {/* §6 O13: accounts that were in an earlier version (the server's history, this device's snapshots) and are not now */}
      {on && (
        <div class="box" id="sync-find-box">
          <h3 class="bt">
            <Icon name="search" size={17} />
            {st("syncFindTitle")}
          </h3>
          <p class="muted">{st("syncFindBody")}</p>
          <div class="row2">
            <button class="btn sm ghost" id="sync-find-open" disabled={busy || locked} onClick={open.onFind}>
              {st("syncFindTitle")}
            </button>
          </div>
          {locked && <p class="muted">{st("syncUnlockToManage")}</p>}
        </div>
      )}

      {on && (
        <div class="box" id="sync-keys">
          <h3 class="bt">
            <Icon name="key" size={17} />
            {st("syncKeysTitle")}
          </h3>
          <p class="muted">
            {st(
              behind ? "syncKeysBlocked" : f.keyStatus === "update_required" ? "syncKeysBlockedUpdate" : "syncKeysBody",
            )}
          </p>
          <div class="row2">
            <button
              class="btn sm ghost"
              id="sync-keyop-password"
              disabled={busy || locked || keysBlocked}
              onClick={open.onKeyOp("password")}
            >
              {st("syncKeyPasswordTitle")}
            </button>
            <button
              class="btn sm ghost"
              id="sync-keyop-recovery"
              disabled={busy || locked || keysBlocked}
              onClick={open.onKeyOp("recovery")}
            >
              {st("syncKeyRecoveryTitle")}
            </button>
            <button
              class="btn sm ghost"
              id="sync-keyop-rotate"
              disabled={busy || locked || keysBlocked}
              onClick={open.onKeyOp("rotate")}
            >
              {st("syncKeyRotateTitle")}
            </button>
          </div>
          {locked && <p class="muted">{st("syncUnlockToManage")}</p>}
        </div>
      )}

      {/* turning off revokes this device with its identity: offered while the identity is intact (the cards of a damaged
          or lost one offer the local removal instead) */}
      {on && (
        <div class="box" id="sync-this-device">
          <h3 class="bt">
            <Icon name="device" size={17} />
            {st("syncThisDevice")}
          </h3>
          {!offOpen ? (
            <div class="row2">
              <button class="btn sm ghost" id="sync-off-open" disabled={busy} onClick={() => setOffOpen("off")}>
                {st("syncTurnOff")}
              </button>
            </div>
          ) : (
            <Confirm
              title={st(offOpen === "rejoin" ? "syncRejoinTitle" : "syncTurnOffTitle")}
              onCancel={() => {
                setOffOpen(null);
                setOffPw("");
                ctl.clearFailure();
              }}
              id="sync-off-confirm"
            >
              <p>{st(offOpen === "rejoin" ? "syncRejoinBody" : "syncTurnOffBody")}</p>
              {lastDevice && (
                <p class="callout warn" id="sync-off-last">
                  <Icon name="alert" size={16} />
                  <span>{st("syncTurnOffLast")}</span>
                </p>
              )}
              {f.rotationOwed && <OwedDrop id="sync-off-owed" checked={dropOwed} onChange={setDropOwed} />}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  turnOff();
                }}
              >
                <div class="field">
                  <label for="sync-off-pw">{t("passwordLabel")}</label>
                  <input
                    id="sync-off-pw"
                    type="password"
                    autoComplete="current-password"
                    value={offPw}
                    onInput={(e) => setOffPw((e.target as HTMLInputElement).value)}
                  />
                </div>
                <FailureLine failure={p.failure} id="sync-off-err" />
                {p.offlineOnly && (
                  <p class="callout warn" id="sync-off-offline">
                    <Icon name="alert" size={16} />
                    <span>{st("syncTurnOffNoNetwork")}</span>
                  </p>
                )}
                <div class="row2">
                  <button
                    class="btn"
                    type="submit"
                    id="sync-off-go"
                    disabled={busy || !offPw || (!!f.rotationOwed && !dropOwed)}
                  >
                    {p.doing === "turn_off" ? st("syncTurningOff") : st("syncTurnOff")}
                  </button>
                  {p.offlineOnly && (
                    <button
                      class="btn ghost danger-text"
                      type="button"
                      id="sync-off-local"
                      onClick={() => setRemoveOpen(true)}
                    >
                      {st("syncActRemoveIdentity")}
                    </button>
                  )}
                  <button
                    class="btn sm quiet"
                    type="button"
                    onClick={() => {
                      setOffOpen(null);
                      setOffPw("");
                      ctl.clearFailure();
                    }}
                  >
                    {t("cancel")}
                  </button>
                </div>
              </form>
            </Confirm>
          )}
          <details class="sync-advanced" id="sync-advanced">
            <summary>{st("syncAdvanced")}</summary>
            {!historyOpen ? (
              <div class="row2">
                <button
                  class="btn sm ghost"
                  id="sync-history-open"
                  disabled={busy || locked}
                  onClick={() => setHistoryOpen(true)}
                >
                  {st("syncClearHistory")}
                </button>
              </div>
            ) : (
              <Confirm
                title={st("syncClearHistoryTitle")}
                tone="danger"
                onCancel={() => {
                  setHistoryOpen(false);
                  setHistoryPw("");
                }}
                id="sync-history-confirm"
              >
                <p>{st("syncClearHistoryBody")}</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    clearHistory();
                  }}
                >
                  <div class="field">
                    <label for="sync-history-pw">{t("passwordLabel")}</label>
                    <input
                      id="sync-history-pw"
                      type="password"
                      autoComplete="current-password"
                      value={historyPw}
                      onInput={(e) => setHistoryPw((e.target as HTMLInputElement).value)}
                    />
                  </div>
                  <div class="row2">
                    <button class="btn danger" type="submit" id="sync-history-go" disabled={busy || !historyPw}>
                      {st("syncClearHistory")}
                    </button>
                    <button
                      class="btn sm quiet"
                      type="button"
                      onClick={() => {
                        setHistoryOpen(false);
                        setHistoryPw("");
                      }}
                    >
                      {t("cancel")}
                    </button>
                  </div>
                </form>
              </Confirm>
            )}
            {!deleteOpen ? (
              <div class="row2">
                <button
                  class="btn sm ghost danger-text"
                  id="sync-delete-open"
                  disabled={busy || locked}
                  onClick={() => setDeleteOpen(true)}
                >
                  {st("syncDeleteTitle")}
                </button>
              </div>
            ) : (
              <Confirm
                title={st("syncDeleteTitle")}
                tone="danger"
                onCancel={() => setDeleteOpen(false)}
                id="sync-delete-confirm"
              >
                <p>{st("syncDeleteBody")}</p>
                <div class="row2">
                  <button class="btn danger" id="sync-delete-next" onClick={open.onDelete}>
                    {t("continue")}
                  </button>
                  <button class="btn sm quiet" type="button" onClick={() => setDeleteOpen(false)}>
                    {t("cancel")}
                  </button>
                </div>
              </Confirm>
            )}
          </details>
        </div>
      )}
    </>
  );
}
