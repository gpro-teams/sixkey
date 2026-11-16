// The master password typed again, in the field the input hint asks for (docs/design/notes/PASSWORD-SETUP-NOTES.md §8):
// for a generated password of 16 symbols the grouped input (ui/PasswordGroups.tsx) with "Use a plain password field"
// under it; for 5 words the plain field, saying how to type them; otherwise the plain field as before. The hint
// (sk_pw_format in chrome.storage.session, platform/runtime.ts passwordFormat) picks the input and nothing else:
// whatever is typed goes to the same service call, which takes a generated password typed loosely in either field, and a
// wrong, forged or missing hint costs one click at most.
import { useEffect, useState } from "preact/hooks";
import type { PasswordFormat } from "../core/crypto/password-candidates";
import { PW_FORMAT_KEY } from "../core/service/pw-format";
import { passwordFormat, type Runtime } from "../platform/runtime";
import { t } from "../ui/i18n";
import { PasswordGroups } from "../ui/PasswordGroups";

type Hint = PasswordFormat | null;

/**
 * The page's one reader of the hint (test/unit/password-entry.test.ts): every field gets the latest answer. Reads are
 * numbered, and only the newest one's answer is applied, so a read that resolves late never replaces a newer one
 * (HYPHEN review m2). `refresh(true)`: the record changed, read again even while a read is under way; otherwise a read
 * under way is joined (the fields of one render read once).
 */
export function hintReader(read: () => Promise<Hint>) {
  let seq = 0;
  let busy = false;
  let latest: Hint = null;
  const fields = new Set<(h: Hint) => void>();
  const refresh = (changed = false) => {
    if (busy && !changed) return;
    busy = true;
    const mine = ++seq;
    void read().then(
      (h) => {
        if (mine !== seq) return; // a newer read is under way: its answer wins
        busy = false;
        latest = h;
        for (const f of fields) f(h);
      },
      () => {
        if (mine === seq) busy = false;
      },
    );
  };
  return {
    latest: () => latest,
    /** A field's subscription, with a read for it; the unsubscribe. */
    watch(f: (h: Hint) => void): () => void {
      fields.add(f);
      refresh();
      return () => fields.delete(f);
    },
    refresh,
  };
}

const readers = new WeakMap<Runtime, ReturnType<typeof hintReader>>();
function readerFor(rt: Runtime) {
  let r = readers.get(rt);
  if (!r) {
    const reader = hintReader(() => passwordFormat(rt));
    // a password set or an unlock putting the record right, in any page: read again
    if (typeof chrome !== "undefined")
      chrome.storage?.session?.onChanged.addListener((c) => {
        if (PW_FORMAT_KEY in c) reader.refresh(true);
      });
    readers.set(rt, (r = reader));
  }
  return r;
}

export function MasterField(p: {
  rt: Runtime;
  /** The input's id (the first box's, grouped), for the page's tests and its <label for>. */
  id: string;
  label: string;
  value: string;
  onValue: (v: string) => void;
  /** The plain field's autocomplete: "current-password" unless the page says otherwise. */
  autocomplete?: string;
  disabled?: boolean;
  /** Text the page shows with the field (inside it, as `children`), by id. */
  describedBy?: string;
  inputRef?: { current: HTMLInputElement | null };
  /** The .field's own id, when the page names it. */
  fieldId?: string;
  children?: preact.ComponentChildren;
}) {
  const reader = readerFor(p.rt);
  const [hint, setHint] = useState<Hint>(reader.latest);
  // The field shown follows the hint only while nothing is typed: never swapped under the user's fingers (review m1).
  const [format, setFormat] = useState<Hint>(reader.latest);
  const [plain, setPlain] = useState(false); // asked for over the hint's grouped input
  useEffect(() => reader.watch(setHint), [reader]);
  useEffect(() => {
    if (!p.value) setFormat(hint);
  }, [hint, p.value]);
  const groups = format === "gen16-v1" && !plain;
  const words = format === "gen5words-v1";
  const described = [p.describedBy, words && `${p.id}-words`].filter(Boolean).join(" ") || undefined;
  useEffect(() => {
    if (plain) document.getElementById(p.id)?.focus();
  }, [plain]);
  return (
    <div class="field" id={p.fieldId}>
      <label for={p.id} id={`${p.id}-label`}>
        {p.label}
      </label>
      {groups ? (
        <PasswordGroups
          id={p.id}
          label={p.label}
          labelledBy={`${p.id}-label`}
          value={p.value}
          onValue={p.onValue}
          {...(p.disabled ? { disabled: true } : {})}
          {...(described ? { describedBy: described } : {})}
          {...(p.inputRef ? { first: p.inputRef } : {})}
        />
      ) : (
        <input
          id={p.id}
          ref={p.inputRef}
          type="password"
          autocomplete={p.autocomplete ?? "current-password"}
          aria-describedby={described}
          value={p.value}
          disabled={p.disabled}
          onInput={(e) => p.onValue(e.currentTarget.value)}
        />
      )}
      {words && (
        <p class="muted" id={`${p.id}-words`}>
          {t("pwWordsHint")}
        </p>
      )}
      {groups && (
        <div>
          <button
            type="button"
            class="btn sm ghost"
            id={`${p.id}-plain`}
            onClick={() => {
              setPlain(true);
              p.onValue("");
            }}
          >
            {t("pwPlainField")}
          </button>
        </div>
      )}
      {p.children}
    </div>
  );
}
