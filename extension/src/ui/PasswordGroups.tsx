// The input for a generated master password (docs/design/notes/PASSWORD-SETUP-NOTES.md §8): its 16 symbols in four
// groups of four, the hyphens drawn between them and never typed. Shown when the input hint (sk_pw_format) says the
// password has that shape; the hint is never trusted for anything else, and every page that shows this also shows a way
// to the plain field. Both pages draw it: the settings page's prompts (options/MasterField.tsx) and the popup's lock
// screen (popup/screens/Locked.tsx, §8.3), so it lives here and imports nothing the popup lacks.
//
// The four boxes are one string of at most 16 symbols shown in four parts, like a field that formats itself: a symbol
// typed or deleted in one box moves the ones after it, and a part pasted goes in where the caret is. A whole code pasted
// (its 16 symbols, with or without its hyphens or spaces, in either case) replaces what the boxes held, whichever box it
// is pasted into; one filled in by a password manager, which sets the first box, fills all four the same way. What goes
// in is read as the plain field's check reads a code (compactCode, password-candidates.ts): NFKC, white space and "-"
// taken out, capitals. Anything else in it (I, L, O, 0, 1, a lookalike dash, a zero-width character) or more than 16
// symbols in all is refused, as the plain field would refuse it: a key does nothing, a paste goes in not at all.
// A box that fills moves the caret on to the next one; Backspace at the start of a box deletes the symbol before it, and
// the left and right arrows at a box's edge go on into the box beside, as in one field. While an input method composes,
// the boxes are left alone; what it commits is taken like a paste (compositionend).
//
// What the browser keeps: the boxes are type="password" unless Show is pressed (the popup has no Show: `showable`), and
// autocomplete="off" always, so Chrome keeps none of it for session restore (its Sessions files skip both kinds);
// autocapitalize and spellcheck are off. The value lives in the page that owns it and is emptied when the page goes
// away and on a lock from any page, and Show goes off whenever it is emptied.
import { useEffect, useRef, useState } from "preact/hooks";
import { compactCode, NOT_GEN_SYMBOL } from "../core/crypto/password-candidates";
import { LOCK_EPOCH_KEY } from "../platform/session";
import { t } from "./i18n";
import { Icon } from "./icons";

type Step = { code: string; at: number };

/** `text`'s symbols in capitals, read as the plain field's check reads a code; null: something else is in it. */
export function codeSymbols(text: string): string | null {
  const c = compactCode(text);
  return c.search(NOT_GEN_SYMBOL) < 0 ? c.toUpperCase() : null; // checked first: "ß" is no "SS" here, as in the check
}
/** The field's value for the symbols it holds: the groups joined by "-" (all 16: the generator's spelling). */
export const valueOf = (code: string) => code.replace(/.{4}(?=.)/g, "$&-");

/** `mine` as box `i`'s symbols, the caret `caret` symbols into it; null: more than 16 in all (refused, not cut off). */
function inBox(code: string, i: number, mine: string, caret: number): Step | null {
  const before = code.slice(0, 4 * i).length; // the boxes before this one are full whenever this one holds any
  const next = code.slice(0, before) + mine + code.slice(before + code.slice(4 * i, 4 * i + 4).length);
  return next.length > 16 ? null : { code: next, at: before + caret };
}

/**
 * One edit, as a pure step (test/unit/password-entry.test.ts): the boxes hold `code`; box `i` now reads `typed`, with
 * the caret after its `caret`-th character. The new code and the caret, counted in symbols; null: refused (the boxes
 * stay as they were). The first box set to a whole code (a password manager's fill) is that code, whatever was there.
 */
export function typedInto(code: string, i: number, typed: string, caret: number): Step | null {
  const mine = codeSymbols(typed);
  if (mine === null) return null;
  if (!i && mine.length === 16) return { code: mine, at: 16 };
  return inBox(code, i, mine, compactCode(typed.slice(0, caret)).length);
}

/**
 * A paste of `text` into box `i`, which reads `box` with `start` to `end` selected: a whole code (16 symbols) replaces
 * what the boxes held; a part goes in at the caret; null: refused (anything else in it, or more than 16 in all).
 */
export function pasteInto(code: string, i: number, box: string, start: number, end: number, text: string): Step | null {
  const s = codeSymbols(text);
  if (s === null) return null;
  if (s.length === 16) return { code: s, at: 16 };
  const mine = codeSymbols(box.slice(0, start) + s + box.slice(end));
  return mine === null ? null : inBox(code, i, mine, compactCode(box.slice(0, start)).length + s.length);
}

/** Backspace at the start of box `i`: the symbol before it goes. null: there is none. */
export function backspaceAt(code: string, i: number): Step | null {
  const before = code.slice(0, 4 * i).length;
  return before ? { code: code.slice(0, before - 1) + code.slice(before), at: before - 1 } : null;
}

/**
 * An arrow key (`left`, or the right one) in box `i` with the caret at `caret`: at the box's edge, the caret goes on into
 * the box beside, one symbol on, where one field would have it (left: before the last symbol of the box before; right:
 * from the end of a full box to after the first symbol of the next, or to its start when it is empty). null: inside
 * the box, where the browser moves it.
 */
export function arrowAt(code: string, i: number, left: boolean, caret: number): Step | null {
  const at = left ? (caret || !i ? -1 : 4 * i - 1) : caret === 4 && i < 3 ? Math.min(code.length, 4 * i + 5) : -1;
  return at < 0 ? null : { code, at };
}

/**
 * `value` is what the boxes hold (valueOf; "" is nothing typed). `id` goes to the first box, for the page's <label for>;
 * `label` names the field in each box's own name ("Master password, group 1 of 4").
 */
export function PasswordGroups(p: {
  id: string;
  label: string;
  /** The id of the page's visible label: the four boxes are one group named by it. */
  labelledBy: string;
  value: string;
  onValue: (v: string) => void;
  disabled?: boolean;
  /** The last try was wrong: every box says so (aria-invalid), as the plain field does. */
  invalid?: boolean;
  /** false: no Show button, the boxes always masked (the popup's lock screen: the master password is never shown). */
  showable?: boolean;
  /** Ids of text that goes with the field, for every box. */
  describedBy?: string;
  first?: { current: HTMLInputElement | null };
}) {
  const [shown, setShown] = useState(false);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const code = p.value.replace(/-/g, "");
  const ids = [0, 1, 2, 3].map((i) => (i ? `${p.id}-${i + 1}` : p.id));
  const latest = useRef(p.onValue);
  latest.current = p.onValue;

  useEffect(() => {
    if (!p.value) setShown(false); // emptied (the step is done): masked again
  }, [p.value]);
  useEffect(() => {
    const drop = () => latest.current("");
    const locked = (c: Record<string, unknown>) => {
      if (LOCK_EPOCH_KEY in c) drop();
    };
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    area?.onChanged.addListener(locked);
    addEventListener("pagehide", drop);
    return () => {
      area?.onChanged.removeListener(locked);
      removeEventListener("pagehide", drop);
    };
  }, []);

  /** The boxes set to the step's code, the caret where it says, and the new value reported. */
  const put = (r: Step) => {
    // written to the boxes before the render, so the render leaves them, and the caret, where they are
    boxes.current.forEach((b, k) => b && (b.value = r.code.slice(4 * k, 4 * k + 4)));
    const k = Math.min(3, r.at >> 2); // a full box's end is the start of the next one
    boxes.current[k]?.focus();
    boxes.current[k]?.setSelectionRange(r.at - 4 * k, r.at - 4 * k);
    p.onValue(valueOf(r.code));
  };
  /** Box `i`'s text taken as an edit; refused, the boxes put back as they were, the caret where the edit began. */
  const edit = (el: HTMLInputElement, i: number) => {
    const caret = el.selectionStart ?? el.value.length;
    const was = code.slice(4 * i, 4 * i + 4).length;
    put(
      typedInto(code, i, el.value, caret) ?? {
        code,
        at: Math.min(code.length, 4 * i + Math.max(0, caret - el.value.length + was)),
      },
    );
  };

  return (
    <div class="pw-groups" role="group" aria-labelledby={p.labelledBy}>
      {[0, 1, 2, 3].flatMap((i) => {
        const box = (
          <input
            key={i}
            id={ids[i]}
            ref={(el) => {
              boxes.current[i] = el;
              if (i === 0 && p.first) p.first.current = el;
            }}
            class="mono"
            type={shown ? "text" : "password"}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            aria-label={t("pwGroup", p.label, i + 1, 4)}
            aria-describedby={p.describedBy}
            aria-invalid={p.invalid || undefined}
            value={code.slice(4 * i, 4 * i + 4)}
            disabled={p.disabled}
            onPaste={(e) => {
              e.preventDefault(); // the paste goes in here, whole, as a part, or not at all
              const el = e.currentTarget;
              const at = el.selectionStart ?? el.value.length;
              const r = pasteInto(code, i, el.value, at, el.selectionEnd ?? at, e.clipboardData?.getData("text") ?? "");
              if (r) put(r);
            }}
            onInput={(e) => {
              // an input method composing: left alone until it commits (compositionend, below)
              if (!(e as unknown as InputEvent).isComposing) edit(e.currentTarget, i);
            }}
            // lower case: Chrome has no oncompositionend property, and Preact keeps the case of an event it does not know
            {...{ oncompositionend: (e: CompositionEvent) => edit(e.currentTarget as HTMLInputElement, i) }}
            onKeyDown={(e) => {
              const el = e.currentTarget;
              const at = el.selectionStart ?? 0;
              if (e.isComposing || at !== el.selectionEnd) return; // composing, or a selection: the browser's
              const left = e.key === "ArrowLeft";
              const r =
                e.key === "Backspace"
                  ? at
                    ? null
                    : backspaceAt(code, i)
                  : (left || e.key === "ArrowRight") && !(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)
                    ? arrowAt(code, i, left, at)
                    : null;
              if (!r) return;
              e.preventDefault();
              put(r);
            }}
          />
        );
        return i
          ? [
              <i key={-i} aria-hidden="true">
                -
              </i>,
              box,
            ]
          : [box];
      })}
      {p.showable !== false && (
        <button
          type="button"
          class="tb"
          aria-label={t("showPassword")}
          aria-pressed={shown}
          aria-controls={ids.join(" ")}
          disabled={p.disabled}
          onClick={() => setShown(!shown)}
        >
          <Icon name={shown ? "eyeOff" : "eye"} />
        </button>
      )}
    </div>
  );
}
