// O8, as M6 narrowed it: the devices of this sync account, each with its name and when it last synced (to the day), this
// device marked, revoked ones greyed, repeated wrong master passwords flagged; rename (the master password), revoke (its
// own flow, revoke.ts), approve a new device (approve.ts), reject every waiting request. Names show only while this page
// is unlocked (O8: placeholders otherwise).
import { useEffect, useState } from "preact/hooks";
import { formatDate, t } from "../../ui/i18n";
import { Icon } from "../icons";
import type { DevicesCtl } from "./devicelist";
import { NameField } from "./EnableView";
import type { DeviceRow, SyncKit } from "./gateway";
import { nameProblemKey } from "./model";
import { asking } from "./permission";
import { formatServerDay, st } from "./text";
import { useStore } from "./use";
import { Confirm, FailureLine, Say } from "./widgets";

/** 90 days without a sync: the row says so (O8). */
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

export function DevicesView({
  ctl,
  kit,
  pending,
  locked,
  onApprove,
  onRevoke,
  forgot,
}: {
  ctl: DevicesCtl;
  kit: SyncKit;
  pending: number;
  locked: boolean;
  onApprove: () => void;
  onRevoke: (row: DeviceRow, approved: DeviceRow[]) => () => void;
  forgot: number;
}) {
  const s = useStore(ctl);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [rejecting, setRejecting] = useState(false);
  // a typed master password does not wait in its field (Backup.tsx's rule): emptied at a lock or a hidden tab
  useEffect(() => setPw(""), [forgot, locked]);
  const busy = s.doing !== null;
  const rows = s.rows ?? [];
  const now = Date.now();
  const renameNow = (id: string) =>
    asking(
      kit,
      (g) =>
        void ctl.rename(id, name, pw, g).then((ok) => {
          setPw("");
          if (ok) setRenaming(null);
        }),
    );
  const rejectAll = asking(
    kit,
    (g) =>
      void ctl.rejectAll(pw, g).then((ok) => {
        setPw("");
        if (ok) setRejecting(false);
      }),
  );
  return (
    <div class="box" id="sync-devices">
      <h3 class="bt">
        <Icon name="device" size={17} />
        {st("syncDevicesTitle")}
      </h3>
      {s.rows === null && s.doing === "load" && (
        <p class="muted" aria-busy="true">
          {st("syncChecking")}
        </p>
      )}
      <ul class="sync-devices">
        {rows.map((r) => (
          <li key={r.id} class={r.revokedAt !== null ? "revoked" : ""} data-device={r.id}>
            <div class="sd-main">
              <b>{r.name ?? (locked ? st("syncDeviceNameLocked") : st("syncDeviceUnnamed"))}</b>
              {r.current && <span class="tag">{st("syncThisDeviceTag")}</span>}
              <span class="muted">
                {r.revokedAt !== null
                  ? st("syncDeviceRevokedAt", formatDate(r.revokedAt))
                  : r.lastSeenAt !== null
                    ? st("syncDeviceLastSeen", formatServerDay(r.lastSeenAt))
                    : st("syncDeviceNeverSeen")}
              </span>
              {r.revokedAt === null && r.lastSeenAt !== null && now - r.lastSeenAt > STALE_MS && (
                <span class="muted"> · {st("syncDeviceStale")}</span>
              )}
              {r.authFailures >= 3 && r.revokedAt === null && (
                <span class="danger-text"> · {st("syncDeviceWrongPasswords", r.authFailures)}</span>
              )}
            </div>
            {r.revokedAt === null && renaming !== r.id && (
              <div class="row2">
                <button
                  class="btn sm ghost"
                  disabled={busy || locked}
                  onClick={() => {
                    setRenaming(r.id);
                    setName(r.name ?? "");
                    ctl.clearNews();
                  }}
                >
                  {st("syncRename")}
                </button>
                {!r.current && (
                  <button
                    class="btn sm ghost danger-text"
                    id={`sync-revoke-${r.id}`}
                    disabled={busy || locked}
                    onClick={onRevoke(
                      r,
                      rows.filter((x) => x.approvedBy === r.id && x.revokedAt === null && !x.current),
                    )}
                  >
                    {st("syncRevoke")}
                  </button>
                )}
              </div>
            )}
            {renaming === r.id && (
              <form
                class="sync-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  renameNow(r.id)();
                }}
              >
                <NameField
                  value={name}
                  onValue={setName}
                  problem={s.nameProblem?.id === r.id ? s.nameProblem.problem : undefined}
                  id={`sync-rename-${r.id}`}
                />
                <div class="field">
                  <label for={`sync-rename-pw-${r.id}`}>{t("passwordLabel")}</label>
                  <input
                    id={`sync-rename-pw-${r.id}`}
                    type="password"
                    autoComplete="current-password"
                    value={pw}
                    onInput={(e) => setPw((e.target as HTMLInputElement).value)}
                  />
                </div>
                <div class="row2">
                  <button class="btn sm" type="submit" disabled={busy || !pw}>
                    {s.doing === "rename" ? st("syncSaving") : st("syncRenameGo")}
                  </button>
                  <button
                    class="btn sm quiet"
                    type="button"
                    onClick={() => {
                      setRenaming(null);
                      setPw("");
                    }}
                  >
                    {t("cancel")}
                  </button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
      {s.nameProblem && renaming === null && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {st(nameProblemKey(s.nameProblem.problem))}
        </div>
      )}
      <FailureLine failure={s.failure} id="sync-devices-err" />
      {s.done && (
        <p class="ok-msg" role="status" id="sync-devices-done">
          <Icon name="check" size={15} />
          <Say x={s.done} />
        </p>
      )}
      <div class="row2">
        <button class="btn sm" id="sync-approve-open" disabled={busy || locked} onClick={onApprove}>
          {st("syncApproveOpen")}
        </button>
        {pending > 0 && (
          <button
            class="btn sm ghost danger-text"
            id="sync-reject-all-open"
            disabled={busy || locked}
            onClick={() => setRejecting(true)}
          >
            {st("syncRejectAll", pending)}
          </button>
        )}
      </div>
      {rejecting && (
        <Confirm
          title={st("syncRejectAllTitle")}
          tone="danger"
          onCancel={() => {
            setRejecting(false);
            setPw("");
          }}
          id="sync-reject-all"
        >
          <p>{st("syncRejectAllBody")}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              rejectAll();
            }}
          >
            <div class="field">
              <label for="sync-reject-all-pw">{t("passwordLabel")}</label>
              <input
                id="sync-reject-all-pw"
                type="password"
                autoComplete="current-password"
                value={pw}
                onInput={(e) => setPw((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="row2">
              <button class="btn danger" type="submit" id="sync-reject-all-go" disabled={busy || !pw}>
                {st("syncRejectAllGo")}
              </button>
              <button
                class="btn sm quiet"
                type="button"
                onClick={() => {
                  setRejecting(false);
                  setPw("");
                }}
              >
                {t("cancel")}
              </button>
            </div>
          </form>
        </Confirm>
      )}
    </div>
  );
}
