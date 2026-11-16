// A new recovery code's two steps, shared by every flow that makes one (keyops.ts, revoke.ts): shown, with copy and save
// (widgets.tsx CodeCard: the clipboard cleared after 30 s when the user allowed it), then confirmed by typing back two
// of its groups before anything is sent (A4, §0.0i item 14). The note above it says what the code replaces.
import { useState } from "preact/hooks";
import { t } from "../../ui/i18n";
import { Icon } from "../icons";
import { st } from "./text";
import { CodeCard, GroupFields, StepTitle } from "./widgets";

export type CodeStep =
  | { at: "show"; code: string }
  | { at: "confirm"; code: string; groups: [number, number]; wrong?: boolean; busy?: boolean };

/** `go`: the last button's words (what typing the groups back sends), when not the plain "confirm and save". */
export function NewCodeSteps({
  s,
  note,
  copy,
  onSaved,
  onShowAgain,
  onConfirm,
  idPrefix,
  go,
}: {
  s: CodeStep;
  note: string;
  copy: (text: string) => Promise<boolean>;
  onSaved: () => void;
  onShowAgain: () => void;
  onConfirm: (typed: [string, string]) => void;
  idPrefix: string;
  go?: string;
}) {
  if (s.at === "show")
    return (
      <>
        <p class="callout warn" id={`${idPrefix}-code-note`}>
          <Icon name="alert" size={16} />
          {/* a new recovery code: shares of the current one stop working with it (SHAMIR-NOTES.md §5) */}
          <span>
            {note} {t("sharesStopWarn")}
          </span>
        </p>
        <CodeCard code={s.code} copy={copy}>
          <div class="row2">
            <button class="btn" id={`${idPrefix}-code-saved`} onClick={onSaved}>
              {st("syncCodeSaved")}
              <Icon name="next" size={15} />
            </button>
          </div>
        </CodeCard>
      </>
    );
  // its own component, keyed by the code: the two fields start empty for every code, from the first render on
  return (
    <TypeBack
      key={s.code}
      s={s}
      onShowAgain={onShowAgain}
      onConfirm={onConfirm}
      idPrefix={idPrefix}
      go={go ?? st("syncCodeConfirmGo")}
    />
  );
}

function TypeBack({
  s,
  onShowAgain,
  onConfirm,
  idPrefix,
  go,
}: {
  s: Extract<CodeStep, { at: "confirm" }>;
  onShowAgain: () => void;
  onConfirm: (typed: [string, string]) => void;
  idPrefix: string;
  go: string;
}) {
  const [g1, setG1] = useState("");
  const [g2, setG2] = useState("");
  return (
    <form
      class="box"
      id={`${idPrefix}-code-confirm`}
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm([g1, g2]);
      }}
    >
      <StepTitle icon="key">{st("syncConfirmCodeTitle")}</StepTitle>
      <p class="muted">{st("syncConfirmCodeBody", s.groups[0] + 1, s.groups[1] + 1)}</p>
      <GroupFields
        ids={[`${idPrefix}-g1`, `${idPrefix}-g2`]}
        groups={s.groups}
        g1={g1}
        g2={g2}
        onG1={setG1}
        onG2={setG2}
      />
      {s.wrong && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {st("syncGroupsWrong")}
        </div>
      )}
      <div class="row2">
        <button
          class="btn"
          type="submit"
          id={`${idPrefix}-groups-next`}
          disabled={s.busy || g1.length < 4 || g2.length < 4}
        >
          {s.busy ? st("syncSaving") : go}
        </button>
        <button class="btn sm ghost" type="button" disabled={s.busy} onClick={onShowAgain}>
          <Icon name="back" size={15} />
          {st("syncShowCodeAgain")}
        </button>
      </div>
    </form>
  );
}
