// O3: turning sync on, step by step (enable.ts has the order and the rules). Each step starts at its heading; every
// button that starts something needing the network asks Chrome for the permission first (permission.ts asking).
import { useEffect, useState } from "preact/hooks";
import { formatDate, t } from "../../ui/i18n";
import { Icon } from "../icons";
import type { EnableFlow } from "./enable";
import type { SyncKit } from "./gateway";
import { asking } from "./permission";
import { fullLength } from "./recovery";
import { ReviewView } from "./ReviewView";
import { SignInView } from "./SignInView";
import { st } from "./text";
import { useStore } from "./use";
import { CodeCard, FailureLine, GroupFields, RecoveryField, Say, StepTitle } from "./widgets";
import { failureText, nameProblemKey } from "./model";
import type { Vault } from "../../core/vault/model";

const STEPS = ["syncStepPassword", "syncStepSignIn", "syncStepName", "syncStepRecovery", "syncStepUpload"] as const;
const stepOf = (at: string): number =>
  (
    ({ password: 0, signin: 1, checking: 1, exists: 1, name: 2, recovery: 3, uploading: 4, review: 4 }) as Record<
      string,
      number
    >
  )[at] ?? -1;

export function Steps({ keys, at }: { keys: readonly string[]; at: number }) {
  return (
    <ol class="steps sync-steps" aria-label={st("syncStepsLabel")}>
      {keys.map((k, i) => (
        <li key={k} class={i < at ? "done" : i === at ? "on" : ""} aria-current={i === at ? "step" : undefined}>
          <i>{i < at ? <Icon name="check" size={13} /> : i + 1}</i>
          <span>{st(k)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The name field with N28's hint (one rule for joining and renaming, §6 O3). */
export function NameField({
  value,
  onValue,
  problem,
  id = "sync-name",
}: {
  value: string;
  onValue: (v: string) => void;
  problem?: string | undefined;
  id?: string;
}) {
  return (
    <div class="field">
      <label for={id}>{st("syncNameLabel")}</label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellcheck={false}
        maxLength={80}
        value={value}
        aria-invalid={problem ? "true" : undefined}
        aria-describedby={`${id}-hint`}
        onInput={(e) => onValue((e.target as HTMLInputElement).value)}
      />
      <span class="hint" id={`${id}-hint`}>
        {st("syncNameHint")}
      </span>
      {problem && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {st(nameProblemKey(problem))}
        </div>
      )}
    </div>
  );
}

/** `onHandOver`: join the email's vault with this flow's sign-in (step 4); `onJoin`: a new join (after vault_exists). */
export function EnableView({
  flow,
  kit,
  vault,
  onHandOver,
  onJoin,
  onClose,
}: {
  flow: EnableFlow;
  kit: SyncKit;
  vault: Vault | null;
  onHandOver: () => void;
  onJoin: () => void;
  onClose: () => void;
}) {
  const s = useStore(flow);
  const [pw, setPw] = useState("");
  const [name, setName] = useState(() => st("syncDefaultName"));
  const [code, setCode] = useState("");
  const [g1, setG1] = useState("");
  const [g2, setG2] = useState("");
  // what was typed belongs to one run: a run that starts or ends (Start again, a lock, a failure, Cancel) leaves nothing
  // typed in it for the next one, no password and no recovery code
  useEffect(() => {
    if (s.at !== "asking" && s.at !== "declined" && s.at !== "failed" && s.at !== "closed") return;
    setPw("");
    setCode("");
    setG1("");
    setG2("");
    setName(st("syncDefaultName"));
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
      case "password":
        return (
          <form
            class="box"
            id="sync-password"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.submitPassword(pw).then(() => setPw(""));
            }}
          >
            <StepTitle icon="lock">{st("syncPasswordTitle")}</StepTitle>
            <p class="muted">{st("syncPasswordBody")}</p>
            <div class="field">
              <label for="sync-pw">{t("passwordLabel")}</label>
              <input
                id="sync-pw"
                type="password"
                autoComplete="current-password"
                value={pw}
                disabled={s.busy}
                onInput={(e) => setPw((e.target as HTMLInputElement).value)}
              />
            </div>
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button class="btn" type="submit" id="sync-pw-next" disabled={s.busy || !pw}>
                {s.busy ? st("syncChecking") : t("continue")}
                {!s.busy && <Icon name="next" size={15} />}
              </button>
            </div>
          </form>
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
      case "exists":
        return (
          <div class="box warn" id="sync-exists">
            <StepTitle icon="sync">{st("syncExistsTitle")}</StepTitle>
            <p>
              {s.info.createdAt !== null
                ? st("syncExistsSince", formatDate(s.info.createdAt), s.info.devices ?? "?")
                : st("syncExistsBody")}
            </p>
            <p>{st("syncNotYouWarning")}</p>
            <div class="row2">
              <button class="btn" id="sync-exists-join" onClick={onHandOver}>
                {st("syncJoinIt")}
              </button>
              <button class="btn ghost" onClick={cancel}>
                {t("cancel")}
              </button>
            </div>
          </div>
        );
      case "name":
        return (
          <form
            class="box"
            id="sync-name-step"
            onSubmit={(e) => {
              e.preventDefault();
              flow.submitName(name);
            }}
          >
            <StepTitle icon="device">{st("syncNameTitle")}</StepTitle>
            <NameField value={name} onValue={setName} problem={s.problem} />
            <div class="row2">
              <button class="btn" type="submit" id="sync-name-next">
                {t("continue")}
                <Icon name="next" size={15} />
              </button>
            </div>
          </form>
        );
      case "recovery":
        if (s.mode === "choose")
          return (
            <div class="box" id="sync-recovery-choose">
              <StepTitle icon="key">{st("syncRecoveryTitle")}</StepTitle>
              <p class="muted">{st("syncRecoveryBody")}</p>
              <FailureLine failure={s.failure} />
              <div class="row2">
                <button class="btn" id="sync-have-code" disabled={s.busy} onClick={() => flow.enterCode()}>
                  {st("syncHaveCode")}
                </button>
                <button class="btn ghost" id="sync-new-code" disabled={s.busy} onClick={() => void flow.newCode()}>
                  {s.busy ? st("syncPreparing") : st("syncMakeNewCode")}
                </button>
              </div>
            </div>
          );
        if (s.mode === "enter")
          return (
            <form
              class="box"
              id="sync-recovery-enter"
              onSubmit={(e) => {
                e.preventDefault();
                void flow.submitCode(code).then(() => {
                  if (flow.state.at !== "recovery") setCode("");
                });
              }}
            >
              <StepTitle icon="key">{st("syncEnterCodeTitle")}</StepTitle>
              <RecoveryField
                id="sync-rc"
                value={code}
                onValue={setCode}
                disabled={s.busy}
                autoFocus
                invalid={!!s.failure}
                describedBy="sync-rc-err"
              />
              <FailureLine failure={s.failure} id="sync-rc-err" />
              <div class="row2">
                <button class="btn" type="submit" id="sync-rc-next" disabled={s.busy || !fullLength(code)}>
                  {s.busy ? st("syncChecking") : st("syncTurnOnNow")}
                </button>
              </div>
            </form>
          );
        if (s.mode === "show")
          return (
            <>
              <p class="callout warn" id="sync-new-code-note">
                <Icon name="alert" size={16} />
                <span>
                  {st("syncNewCodeNote")} {t("sharesStopWarn")}
                </span>
              </p>
              <CodeCard code={s.code} copy={kit.copy}>
                <div class="row2">
                  <button class="btn" id="sync-code-saved" onClick={() => flow.saved()}>
                    {st("syncCodeSaved")}
                    <Icon name="next" size={15} />
                  </button>
                </div>
              </CodeCard>
            </>
          );
        return (
          <form
            class="box"
            id="sync-recovery-confirm"
            onSubmit={(e) => {
              e.preventDefault();
              void flow.confirmGroups([g1, g2]).then(() => {
                setG1("");
                setG2("");
              });
            }}
          >
            <StepTitle icon="key">{st("syncConfirmCodeTitle")}</StepTitle>
            <p class="muted">{st("syncConfirmCodeBody", s.groups[0] + 1, s.groups[1] + 1)}</p>
            <GroupFields ids={["sync-g1", "sync-g2"]} groups={s.groups} g1={g1} g2={g2} onG1={setG1} onG2={setG2} />
            {s.wrong && (
              <div class="err" role="alert">
                <Icon name="alert" size={15} />
                {st("syncGroupsWrong")}
              </div>
            )}
            <FailureLine failure={s.failure} />
            <div class="row2">
              <button
                class="btn"
                type="submit"
                id="sync-groups-next"
                disabled={s.busy || g1.length < 4 || g2.length < 4}
              >
                {s.busy ? st("syncSaving") : st("syncTurnOnNow")}
              </button>
              <button class="btn sm ghost" type="button" disabled={s.busy} onClick={() => flow.showAgain()}>
                <Icon name="back" size={15} />
                {st("syncShowCodeAgain")}
              </button>
            </div>
          </form>
        );
      case "uploading":
        return (
          <p class="callout" role="status" id="sync-uploading">
            <Icon name="sync" size={16} />
            <span>{st("syncUploading")}</span>
          </p>
        );
      case "review":
        return <ReviewView blocked={s.blocked} vault={vault} onAnswer={(a) => void flow.upload(a)} onClose={cancel} />;
      case "done":
        return (
          <p class="callout good" role="status" id="sync-on-done">
            <Icon name="check" size={16} />
            <span>{st("syncOnDone")}</span>
          </p>
        );
      case "unconfirmed":
        return (
          <div class="box" id="sync-on-unconfirmed">
            <p class="callout" role="status">
              <Icon name="info" size={16} />
              <span>{st("syncOnUnconfirmed")}</span>
            </p>
            <div class="row2">
              <button class="btn" id="sync-on-unconfirmed-ok" onClick={onClose}>
                {t("gotIt")}
              </button>
            </div>
          </div>
        );
      case "vault_exists":
        return (
          <div class="box warn" role="alert" id="sync-vault-exists">
            <StepTitle icon="sync">{st("syncRaceTitle")}</StepTitle>
            <p>{st("syncRaceBody")}</p>
            {s.newCode && (
              <p class="callout bad">
                <Icon name="alert" size={16} />
                <span>{st("syncRaceNewCode")}</span>
              </p>
            )}
            <div class="row2">
              <button class="btn" id="sync-race-join" onClick={onJoin}>
                {st("syncJoinIt")}
              </button>
              <button class="btn ghost" onClick={onClose}>
                {t("cancel")}
              </button>
            </div>
          </div>
        );
      case "failed":
        return (
          <div class="box warn" role="alert" id="sync-on-failed">
            <StepTitle icon="alert">{st("syncOnFailedTitle")}</StepTitle>
            <p>
              <Say x={failureText(s.failure)} />
            </p>
            {s.newCode && (
              <p class="callout warn" id="sync-new-code-in-effect">
                <Icon name="alert" size={16} />
                <span>{st("syncNewCodeInEffect")}</span>
              </p>
            )}
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
    s.at === "done" ||
    s.at === "unconfirmed" ||
    s.at === "failed" ||
    s.at === "vault_exists" ||
    s.at === "closed" ||
    s.at === "declined";
  // no Cancel while something is being written (the new code, the upload): it cannot be taken back half way
  const writing = s.at === "uploading" || (s.at === "recovery" && s.mode === "confirm" && s.busy === true);
  return (
    <div class="sync-flow" id="sync-enable">
      {at >= 0 && <Steps keys={STEPS} at={at} />}
      {body}
      {!ended && !writing && s.at !== "asking" && (
        <div class="row2 fr-alt">
          <button class="btn sm ghost" id="sync-enable-cancel" onClick={cancel}>
            {t("cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
