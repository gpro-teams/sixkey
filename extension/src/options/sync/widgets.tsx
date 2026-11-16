// The Sync section's building blocks (SYNC-DESIGN §6: "所有 6 位数字（OTP、SAS）共用一个 6 格输入组件；28 个字符的码
// （恢复码、配对码）共用一个 7 组输入组件"), on the page's existing components and tokens (src/options/options.css,
// src/ui/styles.css) plus sync.css.
//   - Say: a text of the model (model.ts Text), resolved with st(), substitutions included.
//   - Digits: one numeric input drawn as six cells (the one-time code, the SAS on an approving device). One real input:
//     typing, pasting "123 456" or "123-456", the browser's one-time-code autofill and screen readers all work as with
//     any field; the cells are drawn behind it and hidden from assistive technology.
//   - RecoveryField, PairingField: the recovery code and the pairing code (§3.2 MUST 10), both the page's one
//     28-character input (shared.tsx CodeField: masked until shown, seven groups, read the way the code is read). The
//     recovery code's has "I have shares instead" (../RecoveryCodeInput.tsx; docs/design/notes/SHAMIR-NOTES.md §5): the
//     code rebuilt from shares reaches the flow as if typed.
//   - CodeCard: a new recovery code shown before it is written (A4), with copy (the clipboard cleared after 30 s when the
//     user allowed it, platform/clipboard.ts) and "save as file".
//   - PairingCodeCard: the pairing code on the approving device, in seven groups, with copy and what copying means
//     (§7: the system clipboard, a clipboard shared across devices, the clean-up after 30 s when allowed).
//   - Confirm: an in-page confirmation (never window.confirm): focus moves into it (to its title when it is destructive),
//     Escape cancels, focus goes back to where it came from.
//   - SasDial: the six-digit check in large digits in the vault dial, its outer ticks counting down the request's time;
//     screen readers get the digits spelled one by one, in text hidden from view.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { LOCK_EPOCH_KEY } from "../../platform/session";
import { RecoveryCodeInput } from "../RecoveryCodeInput";
import { CodeField, download, stamp } from "../shared";
import { t } from "../../ui/i18n";
import { Icon, type IconName } from "../icons";
import type { Failure } from "./gateway";
import { failureText, type Sub, type Text } from "./model";
import { st } from "./text";

/** A model text in the current language. */
export function say(x: Text): string {
  return st(x.k, ...(x.s ?? []).map((s: Sub) => (typeof s === "object" ? say(s) : s)));
}

export function Say({ x }: { x: Text }) {
  return <>{say(x)}</>;
}

/** A failure, said as what happened (role=alert: read out when it appears). */
export function FailureLine({ failure, id }: { failure: Failure | null | undefined; id?: string }) {
  if (!failure) return null;
  return (
    <div class="err" role="alert" {...(id ? { id } : {})}>
      <Icon name="alert" size={15} />
      {say(failureText(failure))}
    </div>
  );
}

/** Six digits, grouped "123 456" for reading; spelled digit by digit for screen readers. */
export const grouped6 = (d: string): string => `${d.slice(0, 3)} ${d.slice(3, 6)}`;
export const spelled = (d: string): string => d.split("").join(" ");

/** Today: the time moving once a second, for the countdowns (redrawn, never animated: reduced motion is the same). */
export function useNow(now: () => number, everyMs = 1000): number {
  const [n, setN] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setN(now()), everyMs);
    return () => clearInterval(id);
  }, []);
  return n;
}

/** The heading a step's focus moves to (each step starts there, for keyboard and screen reader users). */
export function StepTitle({ icon, children }: { icon: IconName; children: ComponentChildren }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => ref.current?.focus({ preventScroll: false }), []);
  return (
    <h3 class="bt">
      <Icon name={icon} size={17} />
      <span tabIndex={-1} ref={ref} class="step-focus">
        {children}
      </span>
    </h3>
  );
}

export function Digits(p: {
  id: string;
  label: string;
  value: string;
  onValue: (v: string) => void;
  onDone?: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  describedBy?: string;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (p.autoFocus) ref.current?.focus();
  }, []);
  const digits = p.value.replace(/\D/g, "").slice(0, 6);
  return (
    <div class="field">
      <label for={p.id}>{p.label}</label>
      <div class={`digits${p.invalid ? " bad" : ""}`}>
        <input
          id={p.id}
          ref={ref}
          class="digits-in"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          spellcheck={false}
          maxLength={13}
          value={digits}
          disabled={p.disabled}
          aria-invalid={p.invalid ? "true" : undefined}
          {...(p.describedBy ? { "aria-describedby": p.describedBy } : {})}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, 6);
            (e.target as HTMLInputElement).value = v;
            p.onValue(v);
            if (v.length === 6) p.onDone?.(v);
          }}
        />
        <span class="cells" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <i key={i} class={`${i === 3 ? "gap " : ""}${i === digits.length ? "cur" : ""}`}>
              {digits[i] ?? ""}
            </i>
          ))}
        </span>
      </div>
    </div>
  );
}

type CodeFieldProps = {
  id: string;
  value: string;
  onValue: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  describedBy?: string;
  invalid?: boolean;
};

/** The recovery code typed (§3.1 step 4, §3.3, the key operations and the repair). */
export function RecoveryField(p: CodeFieldProps) {
  return (
    <RecoveryCodeInput
      {...p}
      label={t("recoveryLabel")}
      hint={st("syncRecoveryHint")}
      tooLong={st("syncCodeTooLong")}
    />
  );
}

/** The pairing code typed on the new device (§3.2 M3, O5): the same input, the same reading. */
export function PairingField(p: CodeFieldProps) {
  return <CodeField {...p} label={st("syncPairLabel")} hint={st("syncRecoveryHint")} tooLong={st("syncCodeTooLong")} />;
}

/**
 * Two groups of a new recovery code typed back (A4, §0.0i item 14): part of the code, so masked like it (a password
 * field, shared.tsx CodeField says why), with one Show for both; emptied when the page goes away and at a lock.
 */
export function GroupFields(p: {
  ids: readonly [string, string];
  groups: readonly [number, number];
  g1: string;
  g2: string;
  onG1: (v: string) => void;
  onG2: (v: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const wipe = useRef(() => {});
  wipe.current = () => {
    p.onG1("");
    p.onG2("");
  };
  useEffect(() => {
    const onHide = () => wipe.current();
    const locked = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (LOCK_EPOCH_KEY in changes) wipe.current();
    };
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    area?.onChanged.addListener(locked);
    addEventListener("pagehide", onHide);
    return () => {
      area?.onChanged.removeListener(locked);
      removeEventListener("pagehide", onHide);
    };
  }, []);
  const one = (id: string, group: number, value: string, on: (v: string) => void) => (
    <div class="field">
      <label for={id}>{st("syncGroupLabel", group + 1)}</label>
      <input
        id={id}
        class="mono"
        type={shown ? "text" : "password"}
        autoComplete="off"
        autoCapitalize="off"
        spellcheck={false}
        maxLength={4}
        value={value}
        onInput={(e) => on((e.target as HTMLInputElement).value)}
      />
    </div>
  );
  return (
    <>
      <div class="grid2">
        {one(p.ids[0], p.groups[0], p.g1, p.onG1)}
        {one(p.ids[1], p.groups[1], p.g2, p.onG2)}
      </div>
      <label class="check">
        <input
          type="checkbox"
          id={`${p.ids[0]}-show`}
          checked={shown}
          aria-controls={`${p.ids[0]} ${p.ids[1]}`}
          onChange={(e) => setShown((e.target as HTMLInputElement).checked)}
        />{" "}
        {t("showPassword")}
      </label>
    </>
  );
}

/** A new recovery code on screen, with copy and save; `children` is what comes after it (the next step's controls). */
export function CodeCard({
  code,
  copy,
  children,
}: {
  code: string;
  copy: (text: string) => Promise<boolean>;
  children?: ComponentChildren;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="box keycard">
      <StepTitle icon="key">{t("recoveryShownTitle")}</StepTitle>
      <p>{t("recoveryShownBody")}</p>
      <div class="code-box" id="sync-recovery-code">
        {code.split("-").map((g, i, all) => (
          <span key={i}>
            {g}
            {i < all.length - 1 && <i>-</i>}
          </span>
        ))}
      </div>
      <div class="row2">
        <button type="button" class="btn sm ghost" onClick={() => void copy(code).then(setCopied)}>
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? t("copied") : t("copy")}
        </button>
        <button
          type="button"
          class="btn sm ghost"
          onClick={() => download(`sixkey-recovery-key-${stamp()}.txt`, code + "\n", "text/plain")}
        >
          <Icon name="download" size={15} />
          {t("saveAsFile")}
        </button>
      </div>
      {children}
    </div>
  );
}

/**
 * The pairing code on the approving device (§3.2 M2, O9), only while the flow is at that step: seven groups in large
 * type, and Copy, which goes through the system clipboard (the one way S leaves this device's memory, and only on the
 * user's click; §7), with what that means beside it.
 */
export function PairingCodeCard({ code, copy }: { code: string; copy: () => Promise<boolean> }) {
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => box.current?.focus({ preventScroll: false }), []); // where the user's eyes, and focus, go
  return (
    <div class="pair-code">
      <div class="code-box big" id="sync-approve-code" tabIndex={-1} ref={box}>
        <span aria-hidden="true">
          {code.split("-").map((g, i, all) => (
            <span key={i}>
              {g}
              {i < all.length - 1 && <i>-</i>}
            </span>
          ))}
        </span>
        {/* for screen readers: symbol by symbol, a pause between the groups (the visual groups are hidden from them) */}
        <span class="vh">{code.split("-").map(spelled).join(", ")}</span>
      </div>
      <div class="row2">
        <button type="button" class="btn sm ghost" id="sync-approve-copy" onClick={() => void copy().then(setCopied)}>
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <p class="muted" id="sync-approve-copy-note">
        {st("syncPairCopyNote")}
      </p>
    </div>
  );
}

/**
 * An in-page confirmation (§6: destructive actions are confirmed here, never with window.confirm). Focus moves to its
 * first field; without one, to its first button, or, when the action is destructive (tone "danger"), to its title, so
 * that no key press the user did not aim at the button runs it. Escape is Cancel; on closing, focus returns to the
 * element that opened it.
 */
export function Confirm(p: {
  title: string;
  tone?: "warn" | "danger";
  onCancel: () => void;
  children: ComponentChildren;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    const field = ref.current?.querySelector<HTMLElement>("input");
    if (field) field.focus();
    else if (p.tone === "danger") title.current?.focus();
    else ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    return () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, []);
  const labelId = `${p.id ?? "confirm"}-t`;
  return (
    <div
      ref={ref}
      class={`box confirm ${p.tone ?? "warn"}`}
      role="group"
      aria-labelledby={labelId}
      {...(p.id ? { id: p.id } : {})}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          p.onCancel();
        }
      }}
    >
      <h3 class="bt step-focus" id={labelId} ref={title} tabIndex={-1}>
        <Icon name="alert" size={17} />
        {p.title}
      </h3>
      {p.children}
    </div>
  );
}

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const f2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The six-digit check (SAS, §3.2 M3, O5) in the middle of the vault dial; the outer ticks show the time the request has
 * left, out of `total` (the server lets it live 10 to 11 minutes). Drawn from `left`, redrawn once a second by the caller.
 */
export function SasDial({ sas, left, total }: { sas: string; left: number; total: number }) {
  const lit = Math.max(0, Math.min(60, Math.ceil((left / total) * 60)));
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const a = rad(i * 6);
    const r0 = 92,
      r1 = i % 5 === 0 ? 82 : 86;
    return (
      <line
        key={i}
        class={i < lit ? "tk on" : "tk"}
        x1={f2(100 + r0 * Math.cos(a))}
        y1={f2(100 + r0 * Math.sin(a))}
        x2={f2(100 + r1 * Math.cos(a))}
        y2={f2(100 + r1 * Math.sin(a))}
      />
    );
  });
  return (
    <div class="sas">
      <svg class="sas-dial" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
        <circle class="face" cx="100" cy="100" r="97" />
        <g>{ticks}</g>
        <circle class="face2" cx="100" cy="100" r="74" />
      </svg>
      <p class="sas-digits">
        <span id="sync-sas" aria-hidden="true">
          {grouped6(sas)}
        </span>
        <span class="vh" id="sync-sas-spoken">
          {spelled(sas)}
        </span>
      </p>
    </div>
  );
}

/** Minutes and seconds, "9:41" ("0:00" for a time that is not a number). */
export const clock = (ms: number): string => {
  const s = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
