// Settings › Security › Autofill: "Get the latest site rules" (TOTP autofill Stage 3, AF3-U2; docs/design/notes/
// AUTOFILL3-NOTES.md §10; the plan's §5.4), the site rules' updater's switch and its status line. A lazy chunk of its own
// that the page loads (options/Misc.tsx) only in a build whose updater's release gate is open, with its own text
// (catalogs/rules-<lang>.json, scripts/messages.py RULES; never in _locales, so a build without the updater carries none
// of it). It never opens the updater's database: the worker reads and writes it (platform/rules-live.ts), and this page
// asks it (`sk-af-rules-status`): the status, or, with `on`, the switch turned first. Off deletes the downloaded rules at
// once (the floor stays: off and on again is not a fresh install); on asks the worker to check at once, and the answer
// comes once that check is over ("Checking for newer site rules…" meanwhile, the box disabled). While a check left a
// floor above the built-in rules (off, then on again), it says it waits for a newer version, rather than promising one at
// once (AF3-U1's §9.8).
// What it shows is the worker's last real answer, never a guess (the review's S1, the maintainers' C34: turning it off
// is how a user drops downloaded rules at once, so the result must be true): once drawn, the switch never goes away; a
// turn that gets no answer (the worker answered null, or the message failed) asks the status again and shows what it
// says, or, with no answer again, what was shown before the click, with a line that it did not go through. A first read
// that fails is tried once more; if that fails too, the switch is drawn disabled with a line to reload the page.
import { useEffect, useState } from "preact/hooks";
import { formatDate } from "../ui/i18n";
import { lazyText } from "../ui/lazy-text";

/** One literal import per language, so each is its own chunk (assets/rules-update-locale-<lang>-*.js); only `.default`. */
const rx = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/rules-zh_CN.json")).default
      : (await import("../../catalogs/rules-en.json")).default,
  true,
);
/** The chunk waits for its text before it draws (Misc.tsx's host). */
export const prepare = (): Promise<void> => rx.loaded;

/** The worker's answer (platform/rules-live.ts Status). */
type Status = { on: boolean; v: number | null; got: number | null; base: number; floor: number | null; host: string };
/** The worker's answer, or null for none (the worker reported a failure, or the message was not answered). */
async function ask(on?: boolean): Promise<Status | null> {
  try {
    const s: Status | null | undefined = await chrome.runtime.sendMessage({
      type: "sk-af-rules-status",
      ...(on === undefined ? {} : { on }),
    });
    return s !== null && typeof s === "object" && typeof s.on === "boolean" ? s : null;
  } catch {
    return null;
  }
}

export function RulesUpdate() {
  const [s, setS] = useState<Status | null>(null);
  // the first read failed twice: drawn disabled, with a line to reload
  const [unread, setUnread] = useState(false);
  // a turn waiting for the worker's answer, and which way
  const [busy, setBusy] = useState<"on" | "off" | null>(null);
  // the last turn got no answer (cleared by the next one that does)
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const first = (await ask()) ?? (await ask()); // tried once more
      if (!live) return;
      if (first) setS(first);
      else setUnread(true);
    })();
    return () => {
      live = false;
    };
  }, []);
  if (!rx.words() || (s === null && !unread)) return null;
  function flip(on: boolean): void {
    const before = s!;
    setS({ ...before, on }); // the box follows the click; the worker's answer then says what is true
    setBusy(on ? "on" : "off");
    setFailed(false);
    void (async () => {
      const answer = await ask(on);
      if (answer) setS(answer);
      else {
        setS((await ask()) ?? before); // what is true now; if that cannot be read either, what was shown before
        setFailed(true);
      }
      setBusy(null);
    })();
  }
  return (
    <div id="rules-update">
      <label class="check">
        <input
          type="checkbox"
          id="ru-on"
          checked={s?.on ?? false}
          disabled={unread || busy !== null}
          onChange={(e) => flip((e.target as HTMLInputElement).checked)}
        />{" "}
        <b>{rx("ruTitle")}</b>
      </label>
      {s && <p class="muted">{rx("ruLead", s.host)}</p>}
      <p id="ru-status">
        {s === null
          ? rx("ruUnread")
          : busy === "on"
            ? rx("ruChecking")
            : s.v !== null && s.got !== null
              ? rx("ruUpdated", formatDate(s.got), s.v)
              : rx("ruBuiltIn", s.base)}
      </p>
      {s && busy !== "on" && s.on && s.floor !== null && (
        <p class="muted" id="ru-wait">
          {rx("ruWaiting", s.floor)}
        </p>
      )}
      {failed && busy === null && (
        <p class="callout warn" id="ru-failed" role="status">
          {rx("ruFailed")}
        </p>
      )}
    </div>
  );
}
