import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ServiceStatus } from "../core/service/service";
import type { Vault } from "../core/vault/model";
import { armClipboardClear } from "../platform/clipboard";
import type { Runtime } from "../platform/runtime";
import { LOCK_EPOCH_KEY } from "../platform/session";
import { errorLine, logError } from "../ui/errors";
import { getLang, t } from "../ui/i18n";
import { Icon, type IconName } from "./icons";
import {
  forgetGenerated,
  measure,
  meterView,
  offlineSeconds,
  roughTime,
  suggestPassphrase,
  suggestPassword,
  MIN_BITS,
  type Generated,
  type RoughTime,
  type Strength,
} from "../ui/strength";
import { CODE_SYMBOLS, codeGroups, codeSymbols } from "./code-text";

export type Ctx = { rt: Runtime; status: ServiceStatus; vault: Vault | null; reload: () => Promise<void> };

export function Panel(p: {
  id: string;
  icon: IconName;
  title: string;
  lead?: string;
  children: preact.ComponentChildren;
}) {
  return (
    <section id={p.id} class="panel">
      <header>
        <span class="pi">
          <Icon name={p.icon} size={20} />
        </span>
        <div>
          <h2 tabIndex={-1}>{p.title}</h2>
          {p.lead && <p>{p.lead}</p>}
        </div>
      </header>
      <div class="panel-body">{p.children}</div>
    </section>
  );
}

/** Title line of a box inside a panel. */
export function BoxTitle({ icon, children }: { icon: IconName; children: preact.ComponentChildren }) {
  return (
    <h3 class="bt">
      <Icon name={icon} size={17} />
      {children}
    </h3>
  );
}

/**
 * A box that is one line until opened: its title as a button, `note` always under it (a status that must not hide), and
 * `children` only while open. Closed means unmounted: whatever was typed in it is dropped with it, and `onToggle(false)`
 * (the button, Escape) is where the owner clears the state it holds for those fields (the same as on a lock).
 */
export function Fold(p: {
  id: string;
  icon: IconName;
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  note?: preact.ComponentChildren;
  children: preact.ComponentChildren;
}) {
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <div class={`box fold${p.open ? " open" : ""}`} id={p.id}>
      <h3 class="bt">
        <button
          type="button"
          class="fold-b"
          id={`${p.id}-toggle`}
          ref={toggle}
          aria-expanded={p.open}
          aria-controls={p.open ? `${p.id}-body` : undefined}
          onClick={() => p.onToggle(!p.open)}
        >
          <Icon name={p.icon} size={17} />
          <span>{p.title}</span>
          <Icon name="next" size={15} />
        </button>
      </h3>
      {p.note}
      {p.open && (
        <div
          class="fold-body"
          id={`${p.id}-body`}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || e.isComposing) return; // an input method's own Escape is not this box's
            e.stopPropagation();
            p.onToggle(false);
            toggle.current?.focus();
          }}
        >
          {p.children}
        </div>
      )}
    </div>
  );
}

export function download(name: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/**
 * Service codes only this page can meet, told here rather than in src/ui/errors.ts, whose table the popup carries
 * (RR-11): a rotation refused while an earlier key change's cleanup is pending (SYNC-DESIGN §0.0i item 10).
 */
const PAGE_ONLY: Record<string, { what: string; next: string }> = {
  cleanup_pending: { what: "errCleanupPending", next: "errNextCleanupPending" },
};

/**
 * The text for an error caught on this page: what happened and what to do next (src/ui/errors.ts, or PAGE_ONLY), never
 * the error's name or code. Unexpected errors are noted in the local diagnostics log, which the text points to.
 */
export function errText(e: unknown): string {
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  if (typeof code === "string" && Object.hasOwn(PAGE_ONLY, code))
    return t("errLine", t(PAGE_ONLY[code]!.what), t(PAGE_ONLY[code]!.next));
  logError("settings page error", e);
  return errorLine(e);
}

/** A duration in the page's language, in a unit Intl knows: "36 days", "36天". */
function sayTime(r: RoughTime): string {
  const locale = getLang() === "zh_CN" ? "zh-CN" : "en-GB";
  return new Intl.NumberFormat(locale, { style: "unit", unit: r.unit, unitDisplay: "long" }).format(r.count);
}

/**
 * A new password, typed twice, with a live strength line, and "Generate for me" (docs/design/notes/
 * PASSWORD-SETUP-NOTES.md). A generated password fills both fields and is shown as page text in its box, with why it is
 * strong enough, Copy and where to keep it; the other style (random words, easier to type) is one click away.
 *
 * Which comes first: for the master password, the user's own (OWNER-DECISIONS/15; docs/design/notes/OWN-PASSWORD-NOTES.md):
 * the fields, then "Generate for me" as a secondary button, its box and "Choose my own" under it. For a backup file
 * (`purpose="file"`), "Generate for me" stays first and primary, with "Choose my own" beside it.
 *
 * `anyway` (the master password's pages, never a backup file or the sync key operations): MIN_BITS is a warning. Past the
 * service's floor and below MIN_BITS, a box says what that means (a copy of this browser profile can be guessed at
 * offline, and how long one graphics card takes at this strength) and offers "Use anyway", a toggle for this very value:
 * `anyway.value` is the value it was pressed for, and the page accepts with masterAccepts(strength, anyway.value ===
 * value). It is let go (set(null)) as soon as the value changes, on a lock, when the page goes away and on unmount.
 * Without `anyway`, MIN_BITS is the bar, as before. Below the bar the line says by how much and offers a generated one.
 *
 * What the browser keeps: the fields stay type="password" unless the user ticks Show, and while shown they say
 * autocomplete="off". Chrome saves the state of other text fields for session restore, in the profile's Sessions files,
 * in plain text; it skips these two kinds. A generated password is shown only as text in the box, never in a text field.
 * No control here saves a password to a file. Copy arms the extension's usual 30 s clean-up when it is allowed.
 *
 * What the page keeps: a generated password is remembered (here and in strength.ts) only while the field holds it
 * unchanged, and dropped on a lock (from any page), when the page goes away, and on unmount, which also empties the fields.
 *
 * The strength comes from measure() alone, and is shown and reported only for the value it was measured for: the parent
 * gets null in the same task as an edit (a layout effect), then the new answer.
 * `purpose`: what the password protects, for where to keep it ("file": a backup file, which has no recovery code).
 */
export function PasswordFields(p: {
  value: string;
  confirm: string;
  onValue: (v: string) => void;
  onConfirm: (v: string) => void;
  idPrefix: string;
  onStrength?: (s: Strength | null) => void;
  purpose?: "master" | "file";
  anyway?: { value: string | null; set: (v: string | null) => void };
}) {
  const [s, setS] = useState<{ for: string; r: Strength } | null>(null);
  const [shown, setShown] = useState(false);
  const [made, setMade] = useState<Generated | null>(null);
  const [copied, setCopied] = useState(false);
  const [making, setMaking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  // Bumped by whatever makes a generation still under way stale: typing, "Choose my own", a lock, leaving.
  const run = useRef(0);
  const busy = useRef(false);
  const focusCopy = useRef(false);
  const last = useRef(""); // the last value set from here (typed or generated): an empty one from the parent ends the step
  const latest = useRef({ p, made });
  latest.current = { p, made };

  useLayoutEffect(() => {
    p.onStrength?.(null);
    // "Use anyway" was for the value it was pressed on: let go in the same task as any other one
    if (p.anyway && p.anyway.value !== null && p.anyway.value !== p.value) p.anyway.set(null);
    let live = true;
    const v = p.value;
    void measure(v).then((r) => {
      if (live) {
        setS({ for: v, r });
        p.onStrength?.(r);
      }
    });
    return () => {
      live = false;
    };
  }, [p.value]);

  useEffect(() => {
    setCopied(false);
    if (made && made.value !== p.value) {
      forgetGenerated(made.value); // edited, replaced or emptied: no longer the one on screen
      setMade(null);
    }
    if (!p.value && last.current !== "") setShown(false); // emptied by the parent (the step is done)
    if (!p.value) last.current = "";
  }, [p.value]);

  useEffect(() => {
    if (made && focusCopy.current) copyButton.current?.focus(); // the control that asked is gone
    focusCopy.current = false;
  }, [made]);

  useEffect(() => {
    const drop = () => {
      run.current++;
      const { p: q, made: m } = latest.current;
      if (m) forgetGenerated(m.value);
      setMade(null);
      setShown(false);
      q.onValue(""); // and so the press: the layout effect lets it go with the value
      q.onConfirm("");
    };
    const locked = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (LOCK_EPOCH_KEY in changes) drop();
    };
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    area?.onChanged.addListener(locked);
    addEventListener("pagehide", drop);
    return () => {
      area?.onChanged.removeListener(locked);
      removeEventListener("pagehide", drop);
      run.current++;
      const m = latest.current.made;
      if (m) forgetGenerated(m.value);
      latest.current.p.anyway?.set(null);
    };
  }, []);

  const id = p.idPrefix;
  const ownFirst = p.purpose !== "file"; // the master password: the user's own first (OWNER-DECISIONS/15)
  const cur = s !== null && s.for === p.value ? s.r : null;
  const view = meterView(p.value, cur, p.anyway !== undefined);
  const pressed = p.anyway !== undefined && p.anyway.value === p.value && p.value !== "";
  const use = async (kind: Generated["kind"], o: { focusCopy?: boolean } = {}) => {
    if (busy.current) return; // the buttons say aria-disabled, so they keep the focus while the word list loads
    busy.current = true;
    const mine = ++run.current;
    setMaking(true);
    try {
      const g = kind === "words" ? await suggestPassphrase() : suggestPassword();
      if (mine !== run.current) {
        forgetGenerated(g.value); // typed over, "Choose my own", a lock or leaving meanwhile: what the user did wins
        return;
      }
      const old = latest.current.made;
      if (old) forgetGenerated(old.value); // only the one on screen is kept
      focusCopy.current = o.focusCopy === true;
      last.current = g.value;
      setMade(g);
      p.onValue(g.value);
      p.onConfirm(g.value);
    } catch (e) {
      logError("password generator", e); // the word list did not load: the characters still work
    } finally {
      busy.current = false;
      setMaking(false);
    }
  };
  const own = () => {
    run.current++;
    if (made) {
      forgetGenerated(made.value);
      setMade(null);
      p.onValue("");
      p.onConfirm("");
    }
    setShown(false);
    input.current?.focus();
  };
  const onType = (set: (v: string) => void) => (e: Event) => {
    run.current++;
    const v = (e.target as HTMLInputElement).value;
    last.current = v;
    set(v);
  };
  const msg = view.msg;
  const line =
    msg.key === "strengthHint"
      ? t("strengthHint", ...msg.subs)
      : msg.key === "strengthHintOwn"
        ? t("strengthHintOwn", ...msg.subs)
        : msg.key === "strengthGenerated"
          ? t("strengthGenerated", ...msg.subs)
          : msg.key === "strengthLow"
            ? t("strengthLow", ...msg.subs)
            : msg.key === "strengthLowOwn"
              ? t("strengthLowOwn", ...msg.subs)
              : msg.key === "strengthShort"
                ? t("strengthShort", ...msg.subs)
                : t(msg.key);
  const tone = view.tone ? ` ${view.tone}` : "";
  // a field holding a password: never a plain text field the browser would keep, and nothing it would guess at
  const field = {
    class: "mono-pw",
    type: shown ? "text" : "password",
    autocomplete: shown ? "off" : "new-password",
    autocapitalize: "off",
    spellcheck: false,
  } as const;
  const ownButton = (
    <button type="button" class="btn sm ghost" id={`${id}-own`} onClick={own}>
      {t("pwOwn")}
    </button>
  );
  const generator = (
    <div class="row2">
      <button
        type="button"
        class={ownFirst ? "btn sm ghost" : "btn"}
        id={`${id}-gen`}
        aria-disabled={making}
        onClick={() => void use(made?.kind ?? "chars")}
      >
        <Icon name="dice" size={16} />
        {t("generate")}
      </button>
      {!ownFirst && ownButton}
    </div>
  );
  const madeBox = made && (
    <div class="callout good pw-made" id={`${id}-made`}>
      <Icon name="shieldCheck" size={16} />
      <div>
        <p class="pw-value">
          <span>{t("newPasswordLabel")}</span> <code id={`${id}-value`}>{made.value}</code>
        </p>
        <p id={`${id}-why`}>
          {made.kind === "words"
            ? t("pwWhyWords", made.count, Math.floor(made.bits), MIN_BITS)
            : t("pwWhyChars", made.count, Math.floor(made.bits), MIN_BITS)}
        </p>
        <p class="pw-save">{t(p.purpose === "file" ? "pwSaveFile" : "pwSaveMaster")}</p>
        <div class="row2">
          <button
            type="button"
            class="btn sm ghost"
            id={`${id}-copy`}
            ref={copyButton}
            onClick={async () => {
              const v = made.value;
              try {
                await navigator.clipboard.writeText(v);
              } catch {
                return; // the password is on screen to copy by hand
              }
              setCopied(true);
              await armClipboardClear(v); // cleared after 30 s if still there, when the user has allowed it
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={15} />
            {copied ? t("copied") : t("copy")}
          </button>
          <button
            type="button"
            class="btn sm ghost"
            id={`${id}-style`}
            aria-disabled={making}
            onClick={() => void use(made.kind === "words" ? "chars" : "words")}
          >
            {t(made.kind === "words" ? "pwUseChars" : "pwUseWords")}
          </button>
          {ownFirst && ownButton}
        </div>
        <span class="pw-status" role="status">
          {copied ? t("copied") : ""}
        </span>
      </div>
    </div>
  );
  // the warning: only on the master password's pages, for the value it was measured for, past the floor, below the bar
  const weak = view.warn && cur !== null && p.anyway !== undefined;
  const described = [`${id}-strength`, made ? `${id}-why` : "", weak ? `${id}-weak-why` : ""].filter(Boolean).join(" ");
  return (
    <>
      {!ownFirst && generator}
      {!ownFirst && madeBox}
      <div class="field">
        <label for={`${id}-pw`}>{t("newPasswordLabel")}</label>
        <input
          id={`${id}-pw`}
          ref={input}
          {...field}
          aria-describedby={described}
          value={p.value}
          onInput={onType(p.onValue)}
        />
        <div class="strength">
          <div class={`meter${tone}`} aria-hidden="true">
            {Array.from({ length: 10 }, (_, k) => (
              <i key={k} class={k < view.on ? "on" : ""} />
            ))}
          </div>
          <span class={`sh${tone}`} id={`${id}-strength`} aria-live="polite">
            {line}
          </span>
          {view.offer && (
            <button
              type="button"
              class="btn sm ghost"
              id={`${id}-use-gen`}
              aria-disabled={making}
              onClick={() => void use("chars", { focusCopy: true })}
            >
              <Icon name="dice" size={15} />
              {t("pwUseGenerated")}
            </button>
          )}
        </div>
        {weak && (
          <div class="callout pw-weak" id={`${id}-weak`}>
            <Icon name="alert" size={16} />
            <div>
              <p id={`${id}-weak-why`}>{t("pwWeakWhy", sayTime(roughTime(offlineSeconds(cur.bits))))}</p>
              <button
                type="button"
                class="btn sm ghost"
                id={`${id}-anyway`}
                aria-pressed={pressed}
                onClick={() => p.anyway!.set(pressed ? null : p.value)}
              >
                <Icon name={pressed ? "check" : "alert"} size={15} />
                {t("pwUseAnyway")}
              </button>
            </div>
          </div>
        )}
      </div>
      <div class="field">
        <label for={`${id}-pw2`}>{t("confirmPasswordLabel")}</label>
        <input id={`${id}-pw2`} {...field} value={p.confirm} onInput={onType(p.onConfirm)} />
      </div>
      <div class="row2">
        <label class="check">
          <input
            id={`${id}-show`}
            type="checkbox"
            checked={shown}
            onChange={(e) => setShown((e.target as HTMLInputElement).checked)}
          />{" "}
          {t("showPassword")}
        </label>
      </div>
      {ownFirst && generator}
      {ownFirst && madeBox}
    </>
  );
}

/**
 * The one input for a 28-character code: the recovery code (Reset; the Sync section's turn-on, join, key operations and
 * repair, and the pairing code of its approval join, went with that section: OWNER-DECISIONS/25).
 * - Read the way the code is read (any case; spaces, hyphens ignored; O as 0, I and L as 1); `onValue` gets the symbols
 *   only, all of them: a 29th is kept, not cut off, so that the code's own reading says it is not a code (MUST 10), and
 *   the field says "too long" at once (`tooLong`) and marks itself invalid. Typing and pasting work the same (one real
 *   input; a paste of the 34-character grouped form fits).
 * - Safe by construction: a password field (Chrome may write the value of a text field to disk to restore the session;
 *   it does not keep a password field's), hidden until the user ticks Show, with autocomplete, autocapitalize and
 *   spell checking off and no name attribute. Shown, it is grouped as it is typed; hidden, seven bars count the groups.
 * - The value goes when the page goes (pagehide), at a lock (from any page, as PasswordFields above) and when the field
 *   goes (its step ended): the input is emptied, and `onValue("")` tells the owner, whose state must not keep it either.
 * - Accessibility: a label, the caller's description (hint, error) and the count of symbols typed; Show is a labelled
 *   checkbox that controls the field.
 */
export function CodeField(p: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onValue: (symbols: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  describedBy?: string;
  invalid?: boolean;
  /** Said under the field while it holds more than 28 symbols. */
  tooLong?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);
  const onValue = useRef(p.onValue);
  onValue.current = p.onValue;
  useLayoutEffect(() => {
    if (p.autoFocus) ref.current?.focus();
  }, []);
  useEffect(() => {
    const wipe = () => {
      if (ref.current) ref.current.value = "";
      setShown(false);
      onValue.current("");
    };
    const locked = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (LOCK_EPOCH_KEY in changes) wipe();
    };
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    area?.onChanged.addListener(locked);
    addEventListener("pagehide", wipe);
    return () => {
      area?.onChanged.removeListener(locked);
      removeEventListener("pagehide", wipe);
      if (ref.current) ref.current.value = "";
      onValue.current(""); // the step ended: the owner's state lets go of the code too
    };
  }, []);
  const symbols = codeSymbols(p.value);
  const over = symbols.length > CODE_SYMBOLS;
  const filled = Array.from({ length: CODE_SYMBOLS / 4 }, (_, g) => Math.max(0, Math.min(4, symbols.length - g * 4)));
  const described = [
    p.hint ? `${p.id}-hint` : "",
    `${p.id}-count`,
    over && p.tooLong ? `${p.id}-long` : "",
    p.describedBy ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div class="field code-field">
      <label for={p.id}>{p.label}</label>
      <input
        id={p.id}
        ref={ref}
        class="code-in"
        type={shown ? "text" : "password"}
        autoComplete="off"
        autoCapitalize="off"
        spellcheck={false}
        maxLength={64}
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        value={shown ? codeGroups(symbols) : symbols}
        disabled={p.disabled}
        aria-invalid={p.invalid || over ? "true" : undefined}
        aria-describedby={described}
        onInput={(e) => {
          const el = e.target as HTMLInputElement;
          const v = codeSymbols(el.value);
          el.value = shown ? codeGroups(v) : v;
          p.onValue(v);
        }}
      />
      <span class="code-meter" aria-hidden="true">
        {filled.map((n, g) => (
          <i key={g} class={n === 4 ? "full" : n > 0 ? "part" : ""} />
        ))}
      </span>
      <span class="vh" id={`${p.id}-count`}>{`${symbols.length}/${CODE_SYMBOLS}`}</span>
      {over && p.tooLong && (
        <span class="err" role="alert" id={`${p.id}-long`}>
          <Icon name="alert" size={15} />
          {p.tooLong}
        </span>
      )}
      {p.hint && (
        <span class="hint" id={`${p.id}-hint`}>
          {p.hint}
        </span>
      )}
      <label class="check">
        <input
          type="checkbox"
          id={`${p.id}-show`}
          checked={shown}
          aria-controls={p.id}
          disabled={p.disabled}
          onChange={(e) => setShown((e.target as HTMLInputElement).checked)}
        />{" "}
        {t("showPassword")}
      </label>
    </div>
  );
}

export function RecoveryCodeBox({ code, onDone }: { code: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div class="box keycard" role="alert">
      <BoxTitle icon="key">{t("recoveryShownTitle")}</BoxTitle>
      <p>{t("recoveryShownBody")}</p>
      <div class="code-box" id="recovery-code">
        {code.split("-").map((g, i, all) => (
          <span key={i}>
            {g}
            {i < all.length - 1 && <i>-</i>}
          </span>
        ))}
      </div>
      <div class="row2">
        <button
          class="btn sm ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
            } catch {
              /* the code is on screen to copy by hand */
            }
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? t("copied") : t("copy")}
        </button>
        <button
          class="btn sm ghost"
          onClick={() => download(`sixkey-recovery-key-${stamp()}.txt`, code + "\n", "text/plain")}
        >
          <Icon name="download" size={15} />
          {t("saveAsFile")}
        </button>
      </div>
      <label class="check strong">
        <input
          id="recovery-saved"
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved((e.target as HTMLInputElement).checked)}
        />{" "}
        {t("recoverySavedCheck")}
      </label>
      <div>
        <button class="btn" id="recovery-done" disabled={!saved} onClick={onDone}>
          {t("continue")}
          <Icon name="next" size={15} />
        </button>
      </div>
    </div>
  );
}
