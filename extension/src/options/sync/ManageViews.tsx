// The screens of the flows that manage a sync account that is on (manage.ts and its flows): approving a device (O9),
// the key operations (O11, O7's "set a new master password"), revoking (O10), repairing the cloud (O12 keys_behind and
// server_older_key), a separate identity (O12 forked), deleting the account (O14) and finding accounts (O13). Each binds
// its controller; a run's typed fields are emptied when it starts or ends; Cancel is not offered while a write is under
// way; the failure screen says what the engine said.
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { formatDateTime, t } from "../../ui/i18n";
import { Icon } from "../icons";
import { PasswordFields } from "../shared";
import { measure, type Strength } from "../../ui/strength";
import type { ApproveFlow } from "./approve";
import { NewCodeSteps } from "./codesteps";
import { NameField } from "./EnableView";
import type { FindFlow } from "./find";
import type { DeleteFlow, ForkFlow } from "./fork";
import type { FindSource, SyncKit, Failure } from "./gateway";
import type { KeyOpFlow } from "./keyops";
import { failureText } from "./model";
import type { RepairFlow } from "./repair";
import type { RevokeFlow } from "./revoke";
import { SignInView } from "./SignInView";
import { st } from "./text";
import { useStore } from "./use";
import { Digits, FailureLine, PairingCodeCard, RecoveryField, Say, StepTitle } from "./widgets";

/** A run's fields are emptied when it starts or ends (the same rule as the turn-on and join screens). */
function useRunReset(at: string, reset: () => void): void {
  useEffect(() => {
    if (at === "asking" || at === "failed" || at === "closed") reset();
  }, [at]);
}

/** `drop` once the flow has left its form step (the secrets typed there were taken, or the run went on without them). */
function useLeftForm(at: string, drop: () => void): void {
  useEffect(() => {
    if (at !== "form") drop();
  }, [at]);
}

function PwField({
  id,
  value,
  onValue,
  label,
  autoFocus,
}: {
  id: string;
  value: string;
  onValue: (v: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  return (
    <div class="field">
      <label for={id}>{label ?? t("passwordLabel")}</label>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        autoFocus={autoFocus}
        value={value}
        onInput={(e) => onValue((e.target as HTMLInputElement).value)}
      />
    </div>
  );
}

/** The frame every managing flow's screens share: the title, the body, Cancel (unless a write is under way). */
function Frame({
  id,
  title,
  icon,
  busy,
  over,
  onCancel,
  children,
}: {
  id: string;
  title: string;
  icon: Parameters<typeof StepTitle>[0]["icon"];
  busy: boolean;
  over: boolean;
  onCancel: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="box sync-manage" id={id}>
      <StepTitle icon={icon}>{title}</StepTitle>
      {children}
      {!over && !busy && (
        <div class="row2 fr-alt">
          <button class="btn sm ghost" id={`${id}-cancel`} onClick={onCancel}>
            {t("cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function Ended({ failure, onClose, id }: { failure: Failure; onClose: () => void; id: string }) {
  return (
    <div role="alert" id={`${id}-failed`}>
      <p>
        <Say x={failureText(failure)} />
      </p>
      <div class="row2">
        <button class="btn" id={`${id}-close`} onClick={onClose}>
          {st("syncClose")}
        </button>
      </div>
    </div>
  );
}

const Asking = () => (
  <p class="callout" role="status">
    <Icon name="info" size={16} />
    <span>{st("syncAsking")}</span>
  </p>
);

// ---- approving a new device (O9) ------------------------------------------------------------------------------------

export function ApproveView({ flow, onClose }: { flow: ApproveFlow; onClose: () => void }) {
  const s = useStore(flow);
  const [pw, setPw] = useState("");
  const [sas, setSas] = useState("");
  useRunReset(s.at, () => {
    setPw("");
    setSas("");
  });
  const cancel = () => void flow.cancel().then(onClose);
  const busy = "busy" in s && s.busy === true;
  const body = (() => {
    switch (s.at) {
      case "asking":
        return <Asking />;
      case "password":
        return (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submitPassword(pw).then(() => setPw(""));
            }}
          >
            <p class="muted">{st("syncApprovePasswordBody")}</p>
            <PwField id="sync-approve-pw" value={pw} onValue={setPw} autoFocus />
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn" type="submit" id="sync-approve-pw-next" disabled={s.busy || !pw}>
                {t("continue")}
              </button>
            </div>
          </form>
        );
      case "list":
        return (
          <>
            {s.requests.length > 1 && (
              <p class="callout warn" id="sync-approve-many">
                <Icon name="alert" size={16} />
                <span>{st("syncApproveMany")}</span>
              </p>
            )}
            {s.requests.length === 0 ? (
              <p class="muted" id="sync-approve-none">
                {st("syncApproveNone")}
              </p>
            ) : (
              <ul class="sync-requests" id="sync-approve-list">
                {s.requests.map((r) => (
                  <li key={r.rid}>
                    <span>
                      {r.createdAt !== null
                        ? st("syncRequestMadeAt", formatDateTime(r.createdAt))
                        : st("syncRequestMade")}
                      {r.handledBy && <span class="muted"> · {st("syncRequestHandled")}</span>}
                    </span>
                    <span class="row2">
                      <button
                        class="btn sm"
                        id={`sync-approve-${r.rid}`}
                        disabled={s.busy || r.handledBy !== null}
                        onClick={() => void flow.choose(r.rid)}
                      >
                        {st("syncApproveThis")}
                      </button>
                      <button
                        class="btn sm ghost danger-text"
                        disabled={s.busy}
                        onClick={() => void flow.reject(r.rid)}
                      >
                        {st("syncRejectThis")}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button
                class="btn sm ghost"
                id="sync-approve-refresh"
                disabled={s.busy}
                onClick={() => void flow.refresh()}
              >
                {st("syncApproveRefresh")}
              </button>
            </div>
          </>
        );
      case "connecting":
        return (
          <p class="muted" role="status" id="sync-approve-waiting">
            {st("syncApproveWaiting")}
          </p>
        );
      case "code":
        // the pairing code (§3.2 M2, O9): on screen only at this step; the reveal takes it away
        return (
          <div id="sync-approve-pair" class="sync-flow">
            <p>{st("syncApprovePairBody")}</p>
            <PairingCodeCard code={s.code} copy={() => flow.copyCode()} />
            <p class="callout">
              <Icon name="shieldAlert" size={16} />
              <span>{st("syncScamWarning")}</span>
            </p>
            <p class="muted" role="status" id="sync-approve-pair-waiting">
              {st("syncApprovePairWaiting")}
            </p>
            <div class="row2">
              <button class="btn sm ghost danger-text" type="button" onClick={() => void flow.rejectCurrent()}>
                {st("syncRejectThis")}
              </button>
            </div>
          </div>
        );
      case "sas":
        return (
          <form
            id="sync-approve-sas"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submitSas(sas).then(() => setSas(""));
            }}
          >
            <p>{st("syncApproveSasBody")}</p>
            <p class="sync-claims" id="sync-approve-claims">
              {st("syncApproveClaims", s.claimedName)}
            </p>
            <Digits
              id="sync-approve-sas-in"
              label={st("syncApproveSasLabel")}
              value={sas}
              onValue={setSas}
              disabled={s.busy}
              autoFocus
              invalid={!!s.problem}
              describedBy="sync-approve-sas-err"
            />
            {s.problem && (
              <div class="err" role="alert" id="sync-approve-sas-err">
                <Icon name="alert" size={15} />
                {s.problem === "malformed" ? st("syncSasMalformed") : st("syncSasWrong", s.attemptsLeft)}
              </div>
            )}
            <p class="callout">
              <Icon name="shieldAlert" size={16} />
              <span>{st("syncScamWarning")}</span>
            </p>
            <div class="row2">
              <button class="btn" type="submit" id="sync-approve-sas-next" disabled={s.busy || sas.length !== 6}>
                {s.busy ? st("syncChecking") : st("syncApproveGo")}
              </button>
              <button
                class="btn sm ghost danger-text"
                type="button"
                disabled={s.busy}
                onClick={() => void flow.rejectCurrent()}
              >
                {st("syncRejectThis")}
              </button>
            </div>
          </form>
        );
      case "mismatch":
        return (
          <div role="alert" id="sync-approve-mismatch">
            <p>{st("syncApproveMismatch")}</p>
            <div class="row2">
              <button class="btn" id="sync-approve-mismatch-close" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </div>
        );
      case "done":
        return (
          <>
            <p class="callout good" role="status" id="sync-approve-done">
              <Icon name="check" size={16} />
              <span>{st("syncApproveDone")}</span>
            </p>
            <div class="row2">
              <button class="btn" id="sync-approve-close" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </>
        );
      case "rejected":
        return (
          <>
            <p class="callout" role="status" id="sync-approve-rejected">
              <Icon name="info" size={16} />
              <span>{st("syncApproveRejected")}</span>
            </p>
            <div class="row2">
              <button class="btn" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </>
        );
      case "failed":
        return <Ended failure={s.failure} onClose={onClose} id="sync-approve" />;
      case "closed":
        return null;
    }
  })();
  return (
    <Frame
      id="sync-approve"
      title={st("syncApproveTitle")}
      icon="device"
      busy={busy}
      over={flow.isOver}
      onCancel={cancel}
    >
      {body}
    </Frame>
  );
}

// ---- the key operations (O11) and the new password with the recovery code (O7) ----------------------------------------

const KEYOP_TITLE = {
  password: "syncKeyPasswordTitle",
  recovery: "syncKeyRecoveryTitle",
  rotate: "syncKeyRotateTitle",
  reset: "syncKeyResetTitle",
} as const;
const KEYOP_NOTE = {
  password: "syncKeyRotateNote",
  recovery: "syncKeyRecoveryNote",
  rotate: "syncKeyRotateNote",
  reset: "syncKeyResetNote",
} as const;

export function KeyOpView({ flow, kit, onClose }: { flow: KeyOpFlow; kit: SyncKit; onClose: () => void }) {
  const s = useStore(flow);
  const [pw, setPw] = useState("");
  const [npw, setNpw] = useState("");
  const [npw2, setNpw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [rotate, setRotate] = useState(false);
  const [code, setCode] = useState("");
  useRunReset(s.at, () => {
    setPw("");
    setNpw("");
    setNpw2("");
    setRotate(false);
    setCode("");
  });
  useLeftForm(s.at, () => setCode("")); // the recovery code typed for "reset" does not wait past its step
  const kind = flow.kind;
  const cancel = () => void flow.cancel().then(onClose);
  const busy = "busy" in s && s.busy === true;
  const newPwOk = npw.length > 0 && npw === npw2 && strength?.ok === true;
  const body = (() => {
    switch (s.at) {
      case "asking":
        return <Asking />;
      case "form": {
        const ready = kind === "password" ? !!pw && newPwOk : kind === "reset" ? code.length > 0 && newPwOk : !!pw;
        return (
          <form
            id="sync-keyop-form"
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                // the page's 50-bit rule once more before anything is prepared: the button's answer may be a frame old
                if ((kind === "password" || kind === "reset") && !(await measure(npw)).ok) return;
                await flow.submit({ password: pw, newPassword: npw, rotate, recoveryCode: code });
                setPw("");
                setNpw("");
                setNpw2("");
              })();
            }}
          >
            <p class="muted">
              {st(
                kind === "password"
                  ? "syncKeyPasswordBody"
                  : kind === "recovery"
                    ? "syncKeyRecoveryBody"
                    : kind === "rotate"
                      ? "syncKeyRotateBody"
                      : "syncKeyResetBody",
              )}
            </p>
            {kind === "reset" ? (
              <RecoveryField id="sync-keyop-rc" value={code} onValue={setCode} disabled={s.busy} autoFocus />
            ) : (
              <PwField
                id="sync-keyop-pw"
                value={pw}
                onValue={setPw}
                label={kind === "password" ? t("oldPasswordLabel") : undefined}
                autoFocus
              />
            )}
            {(kind === "password" || kind === "reset") && (
              <PasswordFields
                idPrefix="sync-keyop-new"
                value={npw}
                confirm={npw2}
                onValue={setNpw}
                onConfirm={setNpw2}
                onStrength={setStrength}
              />
            )}
            {npw && npw2 && npw !== npw2 && (
              <div class="err">
                <Icon name="alert" size={15} />
                {t("passwordsDiffer")}
              </div>
            )}
            {kind === "password" && (
              <label class="check">
                <input
                  id="sync-keyop-rotate"
                  type="checkbox"
                  checked={rotate}
                  onChange={(e) => setRotate((e.target as HTMLInputElement).checked)}
                />{" "}
                {st("syncKeyAlsoRotate")}
              </label>
            )}
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn" type="submit" id="sync-keyop-next" disabled={s.busy || !ready}>
                {s.busy ? st("syncChecking") : t("continue")}
              </button>
            </div>
          </form>
        );
      }
      case "show":
      case "confirm":
        return (
          <NewCodeSteps
            s={s}
            note={st(KEYOP_NOTE[kind])}
            copy={kit.copy}
            onSaved={() => flow.saved()}
            onShowAgain={() => flow.showAgain()}
            onConfirm={(g) => void flow.confirmGroups(g)}
            idPrefix="sync-keyop"
          />
        );
      case "done":
        return (
          <>
            <p class="callout good" role="status" id="sync-keyop-done">
              <Icon name="check" size={16} />
              <span>
                {st(
                  s.passwordChanged && s.newCode
                    ? "syncKeyDoneBoth"
                    : s.passwordChanged
                      ? "syncKeyDonePassword"
                      : kind === "rotate"
                        ? "syncKeyDoneRotated"
                        : "syncKeyDoneCode",
                )}
              </span>
            </p>
            <div class="row2">
              <button class="btn" id="sync-keyop-close" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </>
        );
      case "unconfirmed":
        return (
          <>
            <p class="callout warn" role="status" id="sync-keyop-unconfirmed">
              <Icon name="info" size={16} />
              <span>{st("syncKeyUnconfirmed")}</span>
            </p>
            <div class="row2">
              <button class="btn" onClick={onClose}>
                {t("gotIt")}
              </button>
            </div>
          </>
        );
      case "failed":
        return (
          <>
            {flow.passwordChanged && (
              <p class="callout warn" id="sync-keyop-password-changed">
                <Icon name="alert" size={16} />
                <span>{st("syncKeyPasswordChangedAnyway")}</span>
              </p>
            )}
            <Ended failure={s.failure} onClose={onClose} id="sync-keyop" />
          </>
        );
      case "closed":
        return null;
    }
  })();
  const writing = busy && (s.at === "confirm" || s.at === "form");
  return (
    <Frame id="sync-keyop" title={st(KEYOP_TITLE[kind])} icon="key" busy={writing} over={flow.isOver} onCancel={cancel}>
      {body}
    </Frame>
  );
}

// ---- revoking a device (O10) ------------------------------------------------------------------------------------------

/** `onRotate`: the key rotation, offered when this run revoked for "lost" and the rotation is not in effect. */
export function RevokeView({
  flow,
  kit,
  onClose,
  onRotate,
}: {
  flow: RevokeFlow;
  kit: SyncKit;
  onClose: () => void;
  onRotate: () => void;
}) {
  const s = useStore(flow);
  const [pw, setPw] = useState("");
  useRunReset(s.at, () => setPw(""));
  const cancel = () => void flow.cancel().then(onClose);
  const busy = "busy" in s && s.busy === true;
  const name = flow.target.name ?? st("syncDeviceUnnamed");
  const body = (() => {
    switch (s.at) {
      case "asking":
        return <Asking />;
      case "password":
        return (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submitPassword(pw).then(() => setPw(""));
            }}
          >
            <PwField id="sync-revoke-pw" value={pw} onValue={setPw} autoFocus />
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn" type="submit" id="sync-revoke-pw-next" disabled={s.busy || !pw}>
                {t("continue")}
              </button>
            </div>
          </form>
        );
      case "reason":
        return (
          <div id="sync-revoke-reason">
            <fieldset class="sync-reasons">
              <legend>{st("syncRevokeWhy")}</legend>
              <label class={`check${s.protectOnly ? " disabled" : ""}`}>
                <input
                  type="radio"
                  name="sync-revoke-reason"
                  id="sync-revoke-retired"
                  disabled={s.protectOnly || s.busy}
                  checked={s.reason === "retired"}
                  onChange={() => flow.setReason("retired")}
                />{" "}
                {st("syncRevokeRetired")}
              </label>
              {s.protectOnly && (
                <p class="muted" id="sync-revoke-protect-only">
                  {st("syncRevokeProtectOnly")}
                </p>
              )}
              <label class="check">
                <input
                  type="radio"
                  name="sync-revoke-reason"
                  id="sync-revoke-lost"
                  disabled={s.busy}
                  checked={s.reason === "lost"}
                  onChange={() => flow.setReason("lost")}
                />{" "}
                {st("syncRevokeLost")}
              </label>
            </fieldset>
            {flow.approved.length > 0 && (
              <fieldset class="sync-reasons" id="sync-revoke-approved">
                <legend>{st("syncRevokeApproved")}</legend>
                {flow.approved.map((d) => (
                  <label key={d.id} class="check">
                    <input
                      type="checkbox"
                      checked={s.ticked.includes(d.id)}
                      disabled={s.busy}
                      onChange={() => flow.toggle(d.id)}
                    />{" "}
                    {d.name ?? st("syncDeviceUnnamed")}
                  </label>
                ))}
              </fieldset>
            )}
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button
                class="btn danger"
                id="sync-revoke-go"
                disabled={s.busy || s.reason === null}
                onClick={() => void flow.confirm()}
              >
                {s.busy
                  ? st(s.reason === "lost" ? "syncChecking" : "syncRevoking")
                  : st(s.reason === "lost" ? "syncRevokeLostNext" : "syncRevokeGo")}
              </button>
            </div>
          </div>
        );
      case "show":
      case "confirm":
        return (
          <NewCodeSteps
            s={s}
            note={st("syncRevokeRotateNote")}
            copy={kit.copy}
            onSaved={() => flow.saved()}
            onShowAgain={() => flow.showAgain()}
            onConfirm={(g) => void flow.confirmGroups(g)}
            idPrefix="sync-revoke"
            go={st("syncRevokeAndRotate")}
          />
        );
      case "done":
        return (
          <div id="sync-revoke-done">
            <p class="callout good" role="status">
              <Icon name="check" size={16} />
              <span>{st(s.reason === "lost" ? "syncRevokeDoneLost" : "syncRevokeDone", s.revoked)}</span>
            </p>
            {s.reason === "lost" && (
              <ul class="sec-inv">
                <li>{st("syncRevokeAfter1")}</li>
                <li>{st("syncRevokeAfter2")}</li>
                <li>{st("syncRevokeAfter3")}</li>
              </ul>
            )}
            <div class="row2">
              <button class="btn" id="sync-revoke-close" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </div>
        );
      case "unconfirmed":
        return (
          <>
            <p class="callout warn" role="status" id="sync-revoke-unconfirmed">
              <Icon name="info" size={16} />
              <span>{st("syncRevokeRotationUnconfirmed", s.revoked)}</span>
            </p>
            <div class="row2">
              <button class="btn" onClick={onClose}>
                {t("gotIt")}
              </button>
            </div>
          </>
        );
      case "owed":
        return (
          <div id="sync-revoke-owed">
            <p class="callout warn" role="status">
              <Icon name="alert" size={16} />
              <span>{st("syncRevokeOwed", s.revoked)}</span>
            </p>
            <p class="muted">
              {st("syncRotationOwedWaits")} <Say x={failureText({ code: s.waits })} />
            </p>
            <div class="row2">
              <button class="btn danger" id="sync-revoke-rotate" onClick={onRotate}>
                {st("syncKeyRotateTitle")}
              </button>
              <button class="btn ghost" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </div>
        );
      case "failed":
        return (
          <>
            {flow.revoked > 0 && (
              <p class="callout warn">
                <Icon name="alert" size={16} />
                <span>{st("syncRevokePartly", flow.revoked)}</span>
              </p>
            )}
            <Ended failure={s.failure} onClose={onClose} id="sync-revoke" />
            {s.failure.code === "rotation_owed" && (
              <div class="row2">
                <button class="btn danger" id="sync-revoke-rotate" onClick={onRotate}>
                  {st("syncKeyRotateTitle")}
                </button>
              </div>
            )}
          </>
        );
      case "closed":
        return null;
    }
  })();
  return (
    <Frame
      id="sync-revoke"
      title={st("syncRevokeTitle", name)}
      icon="shieldAlert"
      busy={busy}
      over={flow.isOver}
      onCancel={cancel}
    >
      {body}
    </Frame>
  );
}

// ---- repairing the cloud from this device (O12 keys_behind) -------------------------------------------------------

export function RepairView({ flow, onClose }: { flow: RepairFlow; onClose: () => void }) {
  const s = useStore(flow);
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  useRunReset(s.at, () => {
    setOld("");
    setPw("");
    setCode("");
  });
  useLeftForm(s.at, () => setCode("")); // the typed recovery code does not wait past its step
  const cancel = () => void flow.cancel().then(onClose);
  const busy = "busy" in s && s.busy === true;
  const body = (() => {
    switch (s.at) {
      case "asking":
        return <Asking />;
      case "form":
        return (
          <form
            id="sync-repair-form"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submit({ oldPassword: old, password: pw, recoveryCode: code }).then(() => {
                setOld("");
                setPw("");
              });
            }}
          >
            <p class="muted">{st("syncRepairBody")}</p>
            {s.again.length > 0 && (
              <p class="callout warn" id="sync-repair-again">
                <Icon name="alert" size={16} />
                <span>
                  {st("syncRepairRevokeAgain", s.again.map((r) => r.name ?? st("syncDeviceUnnamed")).join(", "))}
                </span>
              </p>
            )}
            <PwField id="sync-repair-pw" value={pw} onValue={setPw} autoFocus />
            <PwField id="sync-repair-old" value={old} onValue={setOld} label={st("syncRepairOldLabel")} />
            <span class="hint">{st("syncRepairOldHint")}</span>
            <RecoveryField id="sync-repair-rc" value={code} onValue={setCode} disabled={s.busy} />
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn" type="submit" id="sync-repair-go" disabled={s.busy || !pw || code.length === 0}>
                {s.busy ? st("syncChecking") : st("syncRepairGo")}
              </button>
            </div>
          </form>
        );
      case "done":
        return (
          <>
            <p class="callout good" role="status" id="sync-repair-done">
              <Icon name="check" size={16} />
              <span>{st("syncRepairDone")}</span>
            </p>
            <div class="row2">
              <button class="btn" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </>
        );
      case "unconfirmed":
        return (
          <>
            <p class="callout warn" role="status" id="sync-repair-unconfirmed">
              <Icon name="info" size={16} />
              <span>{st("syncRepairUnconfirmed")}</span>
            </p>
            <div class="row2">
              <button class="btn" onClick={onClose}>
                {t("gotIt")}
              </button>
            </div>
          </>
        );
      case "failed":
        return <Ended failure={s.failure} onClose={onClose} id="sync-repair" />;
      case "closed":
        return null;
    }
  })();
  return (
    <Frame
      id="sync-repair"
      title={st("syncRepairTitle")}
      icon="restore"
      busy={busy}
      over={flow.isOver}
      onCancel={cancel}
    >
      {body}
    </Frame>
  );
}

// ---- finding accounts in an earlier version (O13) ---------------------------------------------------------------------

/** A source by when it was kept: the server's time (to the hour) or this device's; a server time that is not one, by number. */
const keptWhen = (src: FindSource): string =>
  src.at !== null ? formatDateTime(src.at) : src.kind === "server" ? `#${src.version}` : "";

export function FindView({ flow, onClose }: { flow: FindFlow; onClose: () => void }) {
  const s = useStore(flow);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  // what is ticked belongs to the version on screen: emptied whenever another screen or another version comes
  useEffect(() => setTicked(new Set()), [s.at === "accounts" ? s.source : s.at]);
  const cancel = () => void flow.cancel().then(onClose);
  const busy = "busy" in s && s.busy === true;
  const back = (
    <div class="row2">
      <button class="btn ghost" id="sync-find-back" disabled={busy} onClick={() => flow.back()}>
        <Icon name="back" size={15} />
        {t("back")}
      </button>
    </div>
  );
  // each version's button is told by its list's heading (the server's, this device's) for a screen reader
  const sources = (id: string, list: readonly FindSource[]) =>
    list.length === 0 ? (
      <p class="muted" id={id}>
        {st("syncFindNoVersions")}
      </p>
    ) : (
      <ul class="sync-find-src" id={id}>
        {list.map((src) => (
          <li key={src.kind === "server" ? `s${src.version}` : `l${src.id}`}>
            <button
              class="btn sm ghost"
              disabled={busy}
              aria-describedby={`${id}-h`}
              onClick={() => void flow.open(src)}
            >
              {keptWhen(src)}
              {src.kind === "server" && src.older ? <span class="muted"> · {st("syncFindOlderKey")}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    );
  const body = (() => {
    switch (s.at) {
      case "asking":
        return <Asking />;
      case "sources":
        return (
          <>
            <p class="muted">{st("syncFindBody")}</p>
            <h4 id="sync-find-server-h">{st("syncFindServer")}</h4>
            {s.sources.server === null ? (
              <FailureLine failure={{ code: s.sources.error ?? "unknown" }} id="sync-find-server-err" />
            ) : (
              sources("sync-find-server", s.sources.server)
            )}
            <h4 id="sync-find-local-h">{st("syncFindLocal")}</h4>
            {sources("sync-find-local", s.sources.local)}
          </>
        );
      case "accounts":
        if (s.status !== "ok")
          return (
            <>
              <p role="status" id="sync-find-unreadable">
                {s.status === "newer_schema" ? (
                  <Say x={failureText({ code: "newer_schema" })} />
                ) : (
                  st("syncFindUnreadable")
                )}
              </p>
              {back}
            </>
          );
        if (!s.accounts.length)
          return (
            <>
              <p role="status" id="sync-find-none">
                {st("syncFindNone")}
              </p>
              {back}
            </>
          );
        return (
          <form
            id="sync-find-form"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.recover([...ticked]);
            }}
          >
            <p>
              {st("syncFindPick")} <span class="muted">{keptWhen(s.source)}</span>
            </p>
            <ul class="sync-find-list">
              {s.accounts.map((a) => (
                <li key={a.ref}>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={ticked.has(a.ref)}
                      disabled={busy}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if ((e.target as HTMLInputElement).checked) next.add(a.ref);
                        else next.delete(a.ref);
                        setTicked(next);
                      }}
                    />{" "}
                    <b>{a.issuer || a.label}</b>
                    {a.issuer && a.label ? <span class="muted"> · {a.label}</span> : null}
                    {a.note ? (
                      <span class="muted"> ({st(a.note === "same_key" ? "syncFindSameKey" : "syncFindSameName")})</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
            <div class="row2">
              <button class="btn" type="submit" id="sync-find-go" disabled={busy || ticked.size === 0}>
                {busy ? st("syncChecking") : st("syncFindGo", ticked.size)}
              </button>
              <button class="btn ghost" type="button" id="sync-find-back" disabled={busy} onClick={() => flow.back()}>
                <Icon name="back" size={15} />
                {t("back")}
              </button>
            </div>
          </form>
        );
      case "done":
        return (
          <>
            <p class="callout good" role="status" id="sync-find-done">
              <Icon name="check" size={16} />
              <span>{st("syncFindDone", s.n)}</span>
            </p>
            <div class="row2">
              <button class="btn" id="sync-find-close" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </>
        );
      case "failed":
        return <Ended failure={s.failure} onClose={onClose} id="sync-find" />;
      case "closed":
        return null;
    }
  })();
  return (
    <Frame id="sync-find" title={st("syncFindTitle")} icon="search" busy={busy} over={flow.isOver} onCancel={cancel}>
      {body}
    </Frame>
  );
}

// ---- a separate identity (O12 forked) -------------------------------------------------------------------------------

export function ForkView({ flow, onClose }: { flow: ForkFlow; onClose: () => void }) {
  const s = useStore(flow);
  const [pw, setPw] = useState("");
  const [name, setName] = useState(() => st("syncDefaultName"));
  useRunReset(s.at, () => setPw(""));
  const cancel = () => void flow.cancel().then(onClose);
  const busy = "busy" in s && s.busy === true;
  const body = (() => {
    switch (s.at) {
      case "asking":
        return <Asking />;
      case "form":
        return (
          <form
            id="sync-fork-form"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submit(pw, name).then(() => setPw(""));
            }}
          >
            <p class="muted">{st("syncForkBody")}</p>
            <NameField value={name} onValue={setName} problem={s.problem} id="sync-fork-name" />
            <PwField id="sync-fork-pw" value={pw} onValue={setPw} />
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn" type="submit" id="sync-fork-go" disabled={s.busy || !pw}>
                {s.busy ? st("syncChecking") : st("syncForkGo")}
              </button>
            </div>
          </form>
        );
      case "done":
        return (
          <>
            <p class="callout good" role="status" id="sync-fork-done">
              <Icon name="check" size={16} />
              <span>{st("syncForkDone")}</span>
            </p>
            <div class="row2">
              <button class="btn" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </>
        );
      case "failed":
        return <Ended failure={s.failure} onClose={onClose} id="sync-fork" />;
      case "closed":
        return null;
    }
  })();
  return (
    <Frame id="sync-fork" title={st("syncForkTitle")} icon="device" busy={busy} over={flow.isOver} onCancel={cancel}>
      {body}
    </Frame>
  );
}

// ---- deleting the sync account (O14) ------------------------------------------------------------------------------

export function DeleteView({ flow, kit, onClose }: { flow: DeleteFlow; kit: SyncKit; onClose: () => void }) {
  const s = useStore(flow);
  const [pw, setPw] = useState("");
  useRunReset(s.at, () => setPw(""));
  const cancel = () => void flow.cancel().then(onClose);
  const busy = "busy" in s && s.busy === true;
  const body = (() => {
    switch (s.at) {
      case "asking":
        return <Asking />;
      case "signin":
        return (
          <>
            <p class="muted">{st("syncDeleteSignIn")}</p>
            <SignInView s={flow.signin} kit={kit} />
          </>
        );
      case "password":
        return (
          <form
            id="sync-delete-form"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submitPassword(pw).then(() => setPw(""));
            }}
          >
            <p class="callout bad">
              <Icon name="alert" size={16} />
              <span>{st("syncDeleteFinal")}</span>
            </p>
            <PwField id="sync-delete-pw" value={pw} onValue={setPw} autoFocus />
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn danger" type="submit" id="sync-delete-go" disabled={s.busy || !pw}>
                {s.busy ? st("syncDeleting") : st("syncDeleteGo")}
              </button>
            </div>
          </form>
        );
      case "done":
        return (
          <>
            <p class="callout good" role="status" id="sync-delete-done">
              <Icon name="check" size={16} />
              <span>{st(s.localLeft ? "syncDeleteDoneLocalLeft" : "syncDeleteDone")}</span>
            </p>
            <div class="row2">
              <button class="btn" id="sync-delete-close" onClick={onClose}>
                {st("syncClose")}
              </button>
            </div>
          </>
        );
      case "failed":
        return <Ended failure={s.failure} onClose={onClose} id="sync-delete" />;
      case "closed":
        return null;
    }
  })();
  return (
    <Frame id="sync-delete" title={st("syncDeleteTitle")} icon="trash" busy={busy} over={flow.isOver} onCancel={cancel}>
      {body}
    </Frame>
  );
}
