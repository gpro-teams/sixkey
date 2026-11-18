// "I have shares instead" (docs/design/notes/SHAMIR-NOTES.md §5; ADVANCED-RECOVERY-AND-TIERS §3.7 flow 2): the one input
// for recovery code shares, wherever a recovery code is accepted (the popup's and the side panel's lock screen, the
// settings page's reset, through options/RecoveryCodeInput.tsx) and in the shares wizard (its test restore and "Check
// my shares"). It is a lazy chunk with its own text (share-text.ts), so the popup carries only the link that loads it.
//
// The shares are typed one at a time; each is read at once (its check bits catch a typo; a share of another set, or the
// same share again, is refused before anything is combined) and leaves the field, which then asks for the next one. With
// the set's threshold typed, the recovery code is rebuilt in memory and handed to the host (`onCode`), which uses it
// exactly as a typed recovery code; R itself is zeroed by recoveryCodeFromShares, and the code's text goes nowhere else.
// It imports nothing of the popup's main chunk (the lock epoch's key and the code's formatter come from the host as
// props, the crypto from core/crypto/shares.ts and its two leaf modules), which keeps that chunk whole (SHAMIR-NOTES §7).
//
// What it keeps, and for how long, as the recovery code's own field (options/shared.tsx CodeField): the field is a
// password field until Show is ticked (Chrome may keep a text field's value for session restore), with autocomplete,
// autocapitalize and spell checking off and no name; the shares typed so far (their text, for the combination) are in
// this component's state only. Everything goes (the field emptied, the shares dropped, `onCode("", [])` to the host) at
// a lock from any page (the lock epoch's key in chrome.storage.session, which the host passes: `lockKey`), when the
// page goes away (pagehide), with "Start again", and when the entry is unmounted (its step ended). Its list of typed shares carries data-sk-held, so the side panel's lock screen wipe (src/sidepanel/
// main.tsx) sees that something is held even when the field is empty.
import { useEffect, useRef, useState } from "preact/hooks";
import { normalizeCrockford } from "../core/crypto/crockford";
import { SHARE_SYMBOLS, parseShare, recoveryCodeFromShares, setIdText } from "../core/crypto/shares";
import { t } from "./i18n";
import { sx } from "./share-text";
import "./share-entry.css";

type Typed = { text: string; setId: number; threshold: number; index: number };
/** The entry's own messages, by key of the shares' catalog. */
type Problem =
  | { key: "shWrongCheck" | "shLength" | "shNewer" | "shDifferentSets" | "shSame" | "shNoFit" }
  | { key: "shEntryOther"; is: number; want: number }
  | { key: "shEntryOtherSet"; is: number; want: number };

export type ShareEntryProps = {
  /** The prefix of the entry's ids (`${id}-in`, `${id}-add`, ...). */
  id: string;
  /**
   * platform/session.ts LOCK_EPOCH_KEY, from the host. Passed, not imported: this lazy chunk importing that module would
   * move it, and what shares its chunk, out of the popup's main chunk and cost the popup's counted bundle about 640 B
   * (docs/design/notes/SHAMIR-NOTES.md §7).
   */
  lockKey: string;
  /** recovery-code.ts formatRecoveryCode, from the host, for the same reason: the rebuilt secret's text, in 7 groups. */
  toCode: (secret: Uint8Array) => Promise<string>;
  /** The members to type, in this order (0-based; the wizard's test restore). Without it: any of one set. */
  want?: readonly number[];
  /**
   * The set the shares must be of (the wizard's test restore: the set just made): a share of another set, or of another
   * threshold, is refused as it is typed, saying which set is wanted. Without it: any set, the first share decides.
   */
  set?: { setId: number; threshold: number };
  /**
   * The rebuilt recovery code's text and the shares typed, once the set's threshold of them combine; ("", []) when the
   * entry lets go of them (a lock, Start again, the page or the entry going away). Must not throw.
   */
  onCode: (code: string, typed: readonly string[]) => void;
  /** The host found that the rebuilt code does not open this vault: the shares are of an old recovery code. */
  stale?: boolean;
  /** "Type the recovery code instead": the host's way back to its code field (no link without it). */
  onCodeField?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
};

const groups = (symbols: string) => symbols.match(/.{1,4}/g)?.join("-") ?? "";

export function ShareEntry(p: ShareEntryProps) {
  const [ready, setReady] = useState(sx.words() !== undefined);
  const [typed, setTyped] = useState<Typed[]>([]);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [rebuilt, setRebuilt] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const run = useRef(0); // bumped by every wipe: an answer that comes back after it is dropped
  const busy = useRef(false);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    if (!ready) void sx.loaded.then(() => setReady(true));
  }, []);
  useEffect(() => {
    if (ready && p.autoFocus) input.current?.focus();
    if (ready && sx.words() === null) latest.current.onCodeField?.(); // no text to draw the entry with: the code field
  }, [ready]);

  const wipe = () => {
    run.current++;
    if (input.current) input.current.value = "";
    setValue("");
    setShown(false);
    setTyped([]);
    setProblem(null);
    setRebuilt(false);
    latest.current.onCode("", []);
  };
  const wipeRef = useRef(wipe);
  wipeRef.current = wipe;
  useEffect(() => {
    const locked = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (latest.current.lockKey in changes) wipeRef.current();
    };
    const gone = () => wipeRef.current();
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    area?.onChanged.addListener(locked);
    addEventListener("pagehide", gone);
    return () => {
      area?.onChanged.removeListener(locked);
      removeEventListener("pagehide", gone);
      run.current++;
      if (input.current) input.current.value = "";
      latest.current.onCode("", []); // the step ended: the host lets go of the code too
    };
  }, []);

  /** Read the share in the field: refused with a reason, or added; with the threshold typed, the code is rebuilt. */
  async function add(raw: string) {
    if (busy.current || rebuilt) return;
    const symbols = normalizeCrockford(raw);
    if (!symbols) return;
    busy.current = true;
    const mine = run.current;
    try {
      let s;
      try {
        s = await parseShare(symbols);
      } catch (e) {
        const c = (e as { code?: unknown }).code;
        if (mine !== run.current) return;
        setProblem({ key: c === "share_length" ? "shLength" : c === "share_newer" ? "shNewer" : "shWrongCheck" });
        return;
      }
      s.value.fill(0); // the value is not kept: the text is what is combined, at the end
      if (mine !== run.current) return;
      const expected = p.set;
      if (expected && (expected.setId !== s.setId || expected.threshold !== s.threshold))
        return setProblem({ key: "shEntryOtherSet", is: s.setId, want: expected.setId });
      const first = typed[0];
      if (first && (first.setId !== s.setId || first.threshold !== s.threshold))
        return setProblem({ key: "shDifferentSets" });
      if (typed.some((x) => x.index === s.index)) return setProblem({ key: "shSame" });
      const want = p.want?.[typed.length];
      if (want !== undefined && s.index !== want) return setProblem({ key: "shEntryOther", is: s.index, want });
      const next = [...typed, { text: symbols, setId: s.setId, threshold: s.threshold, index: s.index }];
      setTyped(next);
      setProblem(null);
      if (input.current) input.current.value = "";
      setValue("");
      setShown(false);
      if (next.length < s.threshold) return void input.current?.focus();
      let code: string;
      try {
        code = await recoveryCodeFromShares(
          next.map((x) => x.text),
          latest.current.toCode,
        );
      } catch {
        if (mine !== run.current) return;
        setProblem({ key: "shNoFit" }); // they read well each, and do not combine: one has a typo the check missed
        return;
      }
      if (mine !== run.current) return;
      setRebuilt(true);
      latest.current.onCode(
        code,
        next.map((x) => x.text),
      );
    } finally {
      busy.current = false;
    }
  }

  if (!ready || sx.words() === null) return null; // a key name never reaches the screen
  const set = typed[0];
  const threshold = set?.threshold;
  const nextMember = p.want?.[typed.length];
  const label = sx("shEntryLabel", nextMember !== undefined ? nextMember + 1 : typed.length + 1);
  const field = `${p.id}-in`;
  const symbols = normalizeCrockford(value);
  const problemText =
    problem === null
      ? null
      : problem.key === "shEntryOther"
        ? sx("shEntryOther", problem.is + 1, problem.want + 1)
        : problem.key === "shEntryOtherSet"
          ? sx("shEntryOtherSet", setIdText(problem.is), setIdText(problem.want))
          : sx(problem.key);
  return (
    <div class="sh-entry" id={p.id}>
      <p class="sh-lead">{sx("shEntryLead")}</p>
      {typed.length > 0 && (
        <ul class="sh-typed" data-sk-held="" id={`${p.id}-typed`}>
          {typed.map((x) => (
            <li key={x.index}>
              <span aria-hidden="true">✓ </span>
              {sx("shEntryTyped", x.index + 1, setIdText(x.setId))}
            </li>
          ))}
        </ul>
      )}
      {set && !rebuilt && (
        <p class="sh-progress" role="status" id={`${p.id}-progress`}>
          {sx("shEntryProgress", typed.length, threshold!, setIdText(set.setId))}
        </p>
      )}
      {!rebuilt && (
        <div class="sh-field">
          <label for={field}>{label}</label>
          <input
            id={field}
            ref={input}
            class="sh-in"
            type={shown ? "text" : "password"}
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            maxLength={64}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            disabled={p.disabled}
            aria-invalid={problem ? "true" : undefined}
            aria-describedby={problem ? `${p.id}-err` : undefined}
            value={shown ? groups(symbols) : symbols}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.isComposing) return;
              e.preventDefault(); // not the host's form: the share is added, nothing is submitted
              void add(symbols);
            }}
            onInput={(e) => {
              const el = e.target as HTMLInputElement;
              const v = normalizeCrockford(el.value);
              el.value = shown ? groups(v) : v;
              setValue(v);
              if (problem) setProblem(null);
              if (v.length === SHARE_SYMBOLS) void add(v); // a whole share typed or pasted: read at once
            }}
          />
          <div class="sh-row">
            <label class="sh-show">
              <input
                type="checkbox"
                id={`${p.id}-show`}
                checked={shown}
                aria-controls={field}
                disabled={p.disabled}
                onChange={(e) => setShown((e.target as HTMLInputElement).checked)}
              />{" "}
              {t("showPassword")}
            </label>
            <button
              type="button"
              class="btn sm ghost"
              id={`${p.id}-add`}
              disabled={p.disabled || symbols.length === 0}
              onClick={() => void add(symbols)}
            >
              {sx("shEntryAdd")}
            </button>
          </div>
        </div>
      )}
      {problemText && (
        <div class="err" role="alert" id={`${p.id}-err`}>
          {problemText}
        </div>
      )}
      {rebuilt && !p.stale && (
        <p class="sh-rebuilt" role="status" id={`${p.id}-rebuilt`}>
          {sx("shEntryRebuilt", typed.length)}
        </p>
      )}
      {rebuilt && p.stale && (
        <div class="err" role="alert" id={`${p.id}-stale`}>
          {sx("shStale", set ? setIdText(set.setId) : "")}
        </div>
      )}
      {(typed.length > 0 || p.onCodeField) && (
        <div class="sh-row">
          {typed.length > 0 && (
            <button type="button" class="btn sm ghost" id={`${p.id}-clear`} onClick={wipe} disabled={p.disabled}>
              {sx("shEntryClear")}
            </button>
          )}
          {p.onCodeField && (
            <button type="button" class="btn sm ghost" id={`${p.id}-to-code`} onClick={p.onCodeField}>
              {sx("shEntryToCode")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
