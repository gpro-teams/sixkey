// O2: the email, then the six-digit code with a resend after a minute (signin.ts). The code never leaves the field and
// this step: once verified, only the account session is kept, in the flow's memory.
import { useState } from "preact/hooks";
import { Icon } from "../icons";
import type { SyncKit } from "./gateway";
import { RESEND_MS, type SignIn } from "./signin";
import { st } from "./text";
import { useStore } from "./use";
import { clock, Digits, FailureLine, StepTitle, useNow } from "./widgets";

export function SignInView({ s, kit }: { s: SignIn; kit: SyncKit }) {
  const state = useStore(s);
  const [email, setEmail] = useState(state.email);
  const [code, setCode] = useState("");
  const now = useNow(() => kit.engine.deps.now());

  if (state.at === "email" || state.at === "sending") {
    return (
      <form
        class="box"
        id="sync-signin"
        onSubmit={(e) => {
          e.preventDefault();
          void s.send(email);
        }}
      >
        <StepTitle icon="enter">{st("syncSignInTitle")}</StepTitle>
        <p class="muted">{st("syncSignInBody")}</p>
        <div class="field">
          <label for="sync-email">{st("syncEmailLabel")}</label>
          <input
            id="sync-email"
            type="email"
            autoComplete="email"
            spellcheck={false}
            value={email}
            disabled={state.at === "sending"}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </div>
        <FailureLine failure={state.at === "email" ? state.failure : null} />
        <div class="row2">
          <button class="btn" type="submit" id="sync-send-code" disabled={state.at === "sending" || !email.trim()}>
            {state.at === "sending" ? st("syncSending") : st("syncSendCode")}
          </button>
        </div>
      </form>
    );
  }
  if (state.at === "code" || state.at === "verifying") {
    const wait = state.sentAt + RESEND_MS - now;
    return (
      <form
        class="box"
        id="sync-otp"
        onSubmit={(e) => {
          e.preventDefault();
          void s.verify(code).then(() => setCode(""));
        }}
      >
        <StepTitle icon="enter">{st("syncCodeTitle")}</StepTitle>
        <p class="muted">{st("syncCodeBody", state.email)}</p>
        <Digits
          id="sync-otp-in"
          label={st("syncCodeLabel")}
          value={code}
          onValue={setCode}
          disabled={state.at === "verifying"}
          autoFocus
          invalid={state.at === "code" && !!state.failure}
          describedBy="sync-otp-err"
        />
        <FailureLine failure={state.at === "code" ? state.failure : null} id="sync-otp-err" />
        <div class="row2">
          <button class="btn" type="submit" id="sync-verify" disabled={state.at === "verifying" || code.length !== 6}>
            {state.at === "verifying" ? st("syncVerifying") : st("syncVerify")}
          </button>
          {wait > 0 ? (
            <span class="muted" aria-live="off">
              {st("syncResendIn", clock(wait))}
            </span>
          ) : (
            <button
              class="btn sm ghost"
              type="button"
              id="sync-resend"
              disabled={state.at === "verifying"}
              onClick={() => void s.resend()}
            >
              <Icon name="restore" size={14} />
              {st("syncResend")}
            </button>
          )}
          <button class="btn sm quiet" type="button" onClick={() => s.again()}>
            {st("syncOtherEmail")}
          </button>
        </div>
      </form>
    );
  }
  return (
    <p class="muted" role="status">
      {st("syncChecking")}
    </p>
  );
}
