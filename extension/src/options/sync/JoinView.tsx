// O4–O7: joining a synced vault (join.ts has the order and the rules). The approval path asks for the pairing code the
// other device shows (seven groups, typed or pasted; a wrong format or a typo the check bits catch is said here and
// costs nothing), then shows the six-digit check in the dial with the request's time counting down; the warning about
// scams is on both (§6 O9: "这两个码只在你自己的两台设备之间抄写"). The pairing code typed lives in this view's state
// only while its step is on screen.
import { useEffect, useState } from "preact/hooks";
import { formatDate, t } from "../../ui/i18n";
import { Icon } from "../icons";
import type { Vault } from "../../core/vault/model";
import { NameField, Steps } from "./EnableView";
import type { SyncKit } from "./gateway";
import type { JoinFlow, JoinState } from "./join";
import { failureText, summaryText } from "./model";
import { asking } from "./permission";
import { fullLength } from "./recovery";
import { ReviewView } from "./ReviewView";
import { SignInView } from "./SignInView";
import { st } from "./text";
import { useStore } from "./use";
import { clock, FailureLine, PairingField, RecoveryField, SasDial, Say, StepTitle, useNow } from "./widgets";

const STEPS = ["syncStepSignIn", "syncStepChoose", "syncStepJoin", "syncStepSummary"] as const;
const stepOf = (at: string): number =>
  (
    ({
      signin: 0,
      checking: 0,
      no_vault: 0,
      choose: 1,
      recovery: 2,
      starting: 2,
      waiting: 2,
      code: 2,
      sas: 2,
      review: 2,
      summary: 3,
    }) as Record<string, number>
  )[at] ?? -1;
/** The server lets an approval request live 10 to 11 minutes (ENROLL_TTL_S, rounded up to the minute). */
const REQUEST_MS = 11 * 60_000;

function Countdown({ kit, expiresAt }: { kit: SyncKit; expiresAt: number }) {
  const now = useNow(() => kit.engine.refNow());
  return <p class="muted sas-left">{st("syncRequestLeft", clock(expiresAt - now))}</p>;
}

function SasStep({ kit, sas, expiresAt }: { kit: SyncKit; sas: string; expiresAt: number }) {
  const now = useNow(() => kit.engine.refNow());
  return (
    <div class="box" id="sync-sas-step">
      <StepTitle icon="shield">{st("syncSasTitle")}</StepTitle>
      <p>{st("syncSasBody")}</p>
      <SasDial sas={sas} left={expiresAt - now} total={REQUEST_MS} />
      <p class="muted sas-left">{st("syncRequestLeft", clock(expiresAt - now))}</p>
      <p class="callout">
        <Icon name="shieldAlert" size={16} />
        <span>{st("syncScamWarning")}</span>
      </p>
      <p class="muted" role="status">
        {st("syncWaitingForApprover")}
      </p>
    </div>
  );
}

function Summary({ s, onCommit }: { s: Extract<JoinState, { at: "summary" }>; onCommit: () => void }) {
  return (
    <div class="box" id="sync-summary">
      <StepTitle icon="check">{st("syncSummaryTitle")}</StepTitle>
      <p id="sync-summary-what">
        <Say x={summaryText(s.summary, s.via)} />
      </p>
      {s.summary.mode === "added" && <p class="muted">{st("syncSummaryKeptAside")}</p>}
      <p class="callout warn">
        <Icon name="alert" size={16} />
        <span>{st("syncShareWarning")}</span>
      </p>
      <div class="row2">
        <button class="btn" id="sync-join-commit" disabled={s.busy} onClick={onCommit}>
          {s.busy ? st("syncJoining") : t("continue")}
        </button>
      </div>
    </div>
  );
}

/** `onNewCode`, `onNewPassword`: a join with the recovery code's follow-ups (O7), each a new flow from its own click. */
export function JoinView({
  flow,
  kit,
  vault,
  onEnable,
  onClose,
  onNewCode,
  onNewPassword,
}: {
  flow: JoinFlow;
  kit: SyncKit;
  vault: Vault | null;
  onEnable: () => void;
  onClose: () => void;
  onNewCode?: () => void;
  onNewPassword?: () => void;
}) {
  const s = useStore(flow);
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState("");
  const [lost, setLost] = useState(false);
  // what was typed or ticked belongs to one run: a run that starts or ends (Start again, a lock, a failure, Cancel)
  // leaves nothing of it for the next one, no recovery code and above all no tick that replaces unreadable data
  useEffect(() => {
    if (s.at !== "asking" && s.at !== "declined" && s.at !== "failed" && s.at !== "closed") return;
    setCode("");
    setLost(false);
  }, [s.at]);
  // the pairing code typed is kept only while its step is on screen (MUST 10: S is not kept past the step)
  useEffect(() => {
    if (s.at !== "code") setPairing("");
  }, [s.at]);
  const restart = asking(kit, (g) => void flow.start(g));
  const cancel = () => void flow.cancel().then(onClose);

  const body = (() => {
    switch (s.at) {
      case "asking":
        return (
          <p class="callout" role="status">
            <Icon name="info" size={16} />
            <span>{st("syncAsking")}</span>
          </p>
        );
      case "declined":
        return (
          <div class="box warn" id="sync-declined">
            <StepTitle icon="alert">{st("syncDeclinedTitle")}</StepTitle>
            <p>{st("syncDeclinedBody")}</p>
            <div class="row2">
              <button class="btn" id="sync-ask-again" onClick={restart}>
                {st("syncAskAgain")}
              </button>
              <button class="btn ghost" onClick={cancel}>
                {t("cancel")}
              </button>
            </div>
          </div>
        );
      case "signin":
        return <SignInView s={flow.signin} kit={kit} />;
      case "checking":
        return s.failure ? (
          <div class="box warn">
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn" onClick={() => void flow.checkAccount()}>
                {t("retry")}
              </button>
            </div>
          </div>
        ) : (
          <p class="muted" role="status">
            {st("syncChecking")}
          </p>
        );
      case "no_vault":
        return (
          <div class="box" id="sync-no-vault">
            <StepTitle icon="info">{st("syncNoVaultTitle")}</StepTitle>
            <p>{st("syncNoVaultBody")}</p>
            <div class="row2">
              <button class="btn" id="sync-no-vault-enable" onClick={onEnable}>
                {st("syncTurnOn")}
              </button>
              <button class="btn ghost" onClick={cancel}>
                {t("cancel")}
              </button>
            </div>
          </div>
        );
      case "choose":
        return (
          <div class="box warn" id="sync-join-choose">
            <StepTitle icon="sync">{st("syncJoinWarnTitle")}</StepTitle>
            <p id="sync-join-since">
              {s.info.createdAt !== null && s.info.devices !== null
                ? st("syncJoinSince", formatDate(s.info.createdAt), s.info.devices)
                : st("syncJoinSinceUnknown")}
            </p>
            <p>
              <b>{st("syncNotYouWarning")}</b>
            </p>
            <NameField value={s.name} onValue={(v) => flow.setName(v)} problem={s.problem} />
            {s.lost && (
              <label class="check strong">
                <input
                  id="sync-confirm-lost"
                  type="checkbox"
                  checked={lost}
                  onChange={(e) => setLost((e.target as HTMLInputElement).checked)}
                />{" "}
                {st("syncConfirmLost")}
              </label>
            )}
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button
                class="btn"
                id="sync-join-approval"
                onClick={() => void flow.chooseApproval({ confirmLost: lost })}
              >
                <Icon name="device" size={15} />
                {st("syncJoinByApproval")}
              </button>
              <button
                class="btn ghost"
                id="sync-join-recovery"
                onClick={() => void flow.chooseRecovery({ confirmLost: lost })}
              >
                <Icon name="key" size={15} />
                {st("syncJoinByCode")}
              </button>
            </div>
          </div>
        );
      case "recovery":
        return (
          <form
            class="box"
            id="sync-join-code"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submitRecovery(code).then(() => {
                if (flow.state.at !== "recovery") setCode("");
              });
            }}
          >
            <StepTitle icon="key">{st("syncJoinCodeTitle")}</StepTitle>
            <p class="muted">{st("syncJoinCodeBody")}</p>
            <RecoveryField
              id="sync-join-rc"
              value={code}
              onValue={setCode}
              disabled={s.busy}
              autoFocus
              invalid={!!s.failure}
              describedBy="sync-join-rc-err"
            />
            <FailureLine failure={s.failure} id="sync-join-rc-err" />
            <div class="row2">
              <button class="btn" type="submit" id="sync-join-code-next" disabled={s.busy || !fullLength(code)}>
                {s.busy ? st("syncChecking") : t("continue")}
              </button>
              <button
                class="btn sm ghost"
                type="button"
                disabled={s.busy}
                onClick={() => {
                  setCode("");
                  flow.back();
                }}
              >
                <Icon name="back" size={15} />
                {t("back")}
              </button>
            </div>
          </form>
        );
      case "starting":
        return (
          <p class="muted" role="status">
            {st("syncStartingRequest")}
          </p>
        );
      case "waiting":
        return (
          <div class="box" id="sync-waiting">
            <StepTitle icon="device">{st("syncWaitingTitle")}</StepTitle>
            <ol class="gsteps">
              <li>
                <i>1</i>
                <span>{st("syncWaitingStep1")}</span>
              </li>
              <li>
                <i>2</i>
                <span>{st("syncWaitingStep2")}</span>
              </li>
              <li>
                <i>3</i>
                <span>{st("syncWaitingStep3")}</span>
              </li>
            </ol>
            <Countdown kit={kit} expiresAt={s.expiresAt} />
          </div>
        );
      case "sas":
        return <SasStep kit={kit} sas={s.sas} expiresAt={s.expiresAt} />;
      case "code":
        // the pairing code (§3.2 M3, MUST 10): typed or pasted before this device reveals anything; a wrong format or a
        // typo the check bits catch is said here and changes nothing, so the field keeps what was typed for correcting
        return (
          <form
            class="box"
            id="sync-pair"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submitCode(pairing);
            }}
          >
            <StepTitle icon="key">{st("syncPairTitle")}</StepTitle>
            <p>{st("syncPairBody")}</p>
            <PairingField
              id="sync-pair-in"
              value={pairing}
              onValue={setPairing}
              disabled={s.busy}
              autoFocus
              invalid={!!s.problem}
              describedBy="sync-pair-err"
            />
            {s.problem && (
              <div class="err" role="alert" id="sync-pair-err">
                <Icon name="alert" size={15} />
                {s.problem === "malformed" ? st("syncPairMalformed") : st("syncPairWrong")}
              </div>
            )}
            <p class="callout">
              <Icon name="shieldAlert" size={16} />
              <span>{st("syncScamWarning")}</span>
            </p>
            <div class="row2">
              <button class="btn" type="submit" id="sync-pair-next" disabled={s.busy || !fullLength(pairing)}>
                {s.busy ? st("syncChecking") : t("continue")}
              </button>
            </div>
            <Countdown kit={kit} expiresAt={s.expiresAt} />
          </form>
        );
      case "review":
        return (
          <ReviewView blocked={s.blocked} vault={vault} onAnswer={(a) => void flow.answered(a)} onClose={cancel} />
        );
      case "summary":
        return <Summary s={s} onCommit={() => void flow.commit()} />;
      case "done":
        return (
          <div id="sync-join-done">
            <p class="callout good" role="status">
              <Icon name="check" size={16} />
              <span>{st(s.via === "recovery" ? "syncJoinedByCode" : "syncJoined")}</span>
            </p>
            {s.via === "recovery" && (
              <div class="cards" id="sync-join-followups">
                <div class="box">
                  <h3 class="bt">
                    <Icon name="key" size={17} />
                    {st("syncFollowNewCodeTitle")}
                  </h3>
                  <p class="muted">{st("syncFollowNewCodeBody")}</p>
                  <div class="row2">
                    <button class="btn" id="sync-follow-new-code" onClick={onNewCode}>
                      {st("syncKeyRecoveryTitle")}
                    </button>
                  </div>
                </div>
                <div class="box">
                  <h3 class="bt">
                    <Icon name="lock" size={17} />
                    {st("syncFollowNewPasswordTitle")}
                  </h3>
                  <p class="muted">{st("syncFollowNewPasswordBody")}</p>
                  <div class="row2">
                    <button class="btn ghost" id="sync-follow-new-password" onClick={onNewPassword}>
                      {st("syncKeyResetTitle")}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {s.via === "recovery" && (
              <div class="row2">
                <button class="btn sm ghost" id="sync-join-done-ok" onClick={onClose}>
                  {st("syncFollowLater")}
                </button>
              </div>
            )}
          </div>
        );
      case "unconfirmed":
        return (
          <div class="box" id="sync-join-unconfirmed">
            <p class="callout" role="status">
              <Icon name="info" size={16} />
              <span>{st("syncJoinUnconfirmed")}</span>
            </p>
            <div class="row2">
              <button class="btn" id="sync-join-unconfirmed-ok" onClick={onClose}>
                {t("gotIt")}
              </button>
            </div>
          </div>
        );
      case "failed":
        return (
          <div class="box warn" role="alert" id="sync-join-failed">
            <StepTitle icon="alert">{st("syncJoinFailedTitle")}</StepTitle>
            <p>
              <Say x={failureText(s.failure)} />
            </p>
            <div class="row2">
              <button class="btn" id="sync-start-again" onClick={restart}>
                {st("syncStartAgain")}
              </button>
              <button class="btn ghost" onClick={onClose}>
                {t("cancel")}
              </button>
            </div>
          </div>
        );
      case "closed":
        return null;
    }
  })();

  const at = stepOf(s.at);
  const ended =
    s.at === "done" || s.at === "unconfirmed" || s.at === "failed" || s.at === "closed" || s.at === "declined";
  // no Cancel while Continue writes the join: it cannot be taken back half way, and its outcome is what the screen says
  const writing = s.at === "summary" && s.busy === true;
  return (
    <div class="sync-flow" id="sync-join">
      {at >= 0 && <Steps keys={STEPS} at={at} />}
      {body}
      {!ended && !writing && s.at !== "asking" && (
        <div class="row2 fr-alt">
          <button class="btn sm ghost" id="sync-join-cancel" onClick={cancel}>
            {t("cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
