// The recovery key shares wizard (docs/design/notes/SHAMIR-NOTES.md §5; ADVANCED-RECOVERY-AND-TIERS §3.7): Settings ›
// Security › Password & recovery › Recovery key shares, a fold that loads this module (and its text, ui/share-text.ts)
// when it is opened. Three steps, each on the one screen:
//   1. how many (any 2 of 3, the default, or any 3 of 5) and from what: a new recovery code shown only as shares (the
//      master password; recommended), or the current code (typed, or rebuilt from shares: RecoveryCodeInput) split;
//      the service makes the set in memory (VaultService.prepareShares), nothing is written;
//   2. each share on its own: Print (one share on the printed page: the page's print view shows that share's paper
//      only, never the others, and the paper leaves the page as soon as printing is over) or Save as a text file (the
//      synced-folder warning beside it); no Copy, because the system clipboard can leave the computer; "kept" ticked
//      before the next one;
//   3. the test restore: the shares the service chose at random typed back (ui/ShareEntry.tsx with `want`); for "replace"
//      only then "Switch to these shares", the page's key operation (key-ops.ts confirmShares: VaultService.confirmShares
//      commits the new code in one locked save, and the old code works until it does); for "split" nothing is written.
// "Check my shares" types shares and asks whether they rebuild the code that opens the vault now (checkRecoveryCode:
// nothing of the vault written, nothing recorded); after a switch, a pass before the next browser restart asks for one
// more check after it, and a set that fails after it may be a switch that did not complete (SHAMIR-NOTES.md §4). What it holds is in this component only: the fold's closing (its button, Escape,
// a lock, a hidden tab, leaving the leaf) unmounts it, and the shares on screen, the typed password or code and the set
// go with it; until the switch, a set dropped that way changes nothing and its shares open nothing (the screen says so,
// and the page asks before it is closed while a set is out).
import { useEffect, useState } from "preact/hooks";
import { formatRecoveryCode } from "../core/crypto/recovery-code";
import { parseShare, setIdText } from "../core/crypto/shares";
import type { PreparedShares } from "../core/service/service";
import type { Runtime } from "../platform/runtime";
import { LOCK_EPOCH_KEY } from "../platform/session";
import { formatDate, getLang, t } from "../ui/i18n";
import { ShareEntry } from "../ui/ShareEntry";
import { sx } from "../ui/share-text";
import type { KeyOps } from "./key-ops";
import { recoveryKeyOf, RecoveryKeyStep, type RecoveryKeySource } from "./RecoveryKeyStep";
import { download, errText } from "./shared";
import "./share-wizard.css";

type Step =
  | { at: "start" }
  | { at: "show"; h: PreparedShares; i: number }
  | { at: "test"; h: PreparedShares }
  // only what the done screen says: the shares themselves are dropped (F5: no reason to hold them past the switch)
  | { at: "done"; mode: PreparedShares["mode"]; threshold: number; count: number }
  | { at: "check" };

const SETUPS = { "23": { threshold: 2, count: 3 }, "35": { threshold: 3, count: 5 } } as const;
type SetupId = keyof typeof SETUPS;

/** The done screen's step: what it says, and none of the shares. */
const done = (h: PreparedShares): Step => ({ at: "done", mode: h.mode, threshold: h.threshold, count: h.count });

/** The id of the set typed shares are of (each share says it): a failed check tells the switched set from any other. */
async function setOf(shares: readonly string[]): Promise<string | undefined> {
  const s = shares[0] ? await parseShare(shares[0]).catch(() => null) : null;
  s?.value.fill(0);
  return s ? setIdText(s.setId) : undefined;
}

/**
 * An error of the shares themselves, in the shares' words (SHAMIR-NOTES.md §5): another set, a typo, the same share, a set
 * that does not fit. Never the page's "could not read its data" for a paper of another set, and no diagnostics line for
 * what the person typed. Anything else: null (the page's usual words).
 */
export function sharesWords(e: unknown): string | null {
  const c = (e as { code?: unknown } | null)?.code;
  if (c === "shares_mixed") return sx("shDifferentSets");
  if (c === "share_checksum" || c === "share_char") return sx("shWrongCheck");
  if (c === "share_length") return sx("shLength");
  if (c === "share_newer") return sx("shNewer");
  if (c === "shares_duplicate") return sx("shSame");
  if (c === "shares_digest" || c === "shares_count") return sx("shNoFit");
  return null;
}

/** "2 and 3", "2、3": the members asked for, in the page's language. */
function members(list: readonly number[]): string {
  const words = list.map((i) => String(i + 1));
  try {
    return new Intl.ListFormat(getLang() === "zh_CN" ? "zh-CN" : "en-GB", { type: "conjunction" }).format(words);
  } catch {
    return words.join(", ");
  }
}

/** One share's paper, as lines: what the printed page and the text file say (§3.7). */
function paperLines(h: PreparedShares, i: number, date: string): string[] {
  return [
    sx("shPaperTitle", i + 1, h.count),
    sx("shPaperAny", h.threshold, h.count),
    sx("shSheetSet", h.setId, date),
    "",
    h.shares[i]!,
    "",
    sx("shPaperWhere"),
    "",
    `${sx("shPaperHeld")} ______________________`,
  ];
}

/**
 * Print one share: its paper is put on the page for the print only (a node of its own under <body>, its text set as
 * text), the print view shows nothing else (share-wizard.css), and the node is removed when printing is over.
 */
function printPaper(lines: string[]): void {
  const root = document.createElement("div");
  root.setAttribute("id", "sh-print");
  root.setAttribute("class", "sh-print");
  for (const [k, line] of lines.entries()) {
    const el = document.createElement(k === 0 ? "h1" : k === 4 ? "pre" : "p");
    el.appendChild(document.createTextNode(line)); // text, never markup
    root.appendChild(el);
  }
  document.body.appendChild(root);
  document.documentElement.classList.add("sh-printing");
  const done = () => {
    removeEventListener("afterprint", done);
    root.parentNode?.removeChild(root);
    document.documentElement.classList.remove("sh-printing");
  };
  addEventListener("afterprint", done);
  try {
    window.print(); // returns once the print dialog has closed
  } finally {
    done();
  }
}

export function ShareWizard({ rt, keys, start }: { rt: Runtime; keys: KeyOps; start?: "check" }) {
  const [ready, setReady] = useState(sx.words() !== undefined);
  const [step, setStep] = useState<Step>(start === "check" ? { at: "check" } : { at: "start" });
  const [setup, setSetup] = useState<SetupId>("23");
  const [source, setSource] = useState<RecoveryKeySource>("new"); // a new code (replace) or the current one (split)
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [viaShares, setViaShares] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [kept, setKept] = useState(false);
  const [typed, setTyped] = useState<readonly string[]>([]);
  /** "Check my shares": a pass (and whether one more after a browser restart is asked for), or a switch that failed. */
  const [checked, setChecked] = useState<"ok" | "again" | null>(null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (!ready) void sx.loaded.then(() => setReady(true));
  }, []);
  // a set is out (its shares on screen, or being checked): closing the page drops it, so ask first, as the reset does
  const out = step.at === "show" || step.at === "test";
  useEffect(() => {
    if (!out) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [out]);
  if (!ready || sx.words() === null) return null;

  const { threshold, count } = SETUPS[setup];
  const go = (s: Step) => {
    setError(null);
    setStale(false);
    setKept(false);
    setTyped([]);
    setChecked(null);
    setLost(false);
    setStep(s);
  };
  const say = (e: unknown, what: "password" | "code") => {
    const c = (e as { code?: unknown } | null)?.code;
    if (c === "wrong_secret" && what === "code" && viaShares)
      setStale(true); // the shares' entry says why
    else if (c === "wrong_secret") setError(what === "password" ? t("wrongPassword") : sx("shWrongCode"));
    else if (typeof c === "string" && c.startsWith("recovery_")) setError(t("badRecoveryFormat"));
    else setError(errText(e));
  };

  async function make(from: { password: string } | { recoveryCode: string }) {
    setBusy(true);
    setError(null);
    try {
      const h = await rt.service.prepareShares(from, SETUPS[setup]);
      setPw("");
      setCode("");
      go({ at: "show", h, i: 0 });
    } catch (e) {
      say(e, "password" in from ? "password" : "code");
    } finally {
      setBusy(false);
    }
  }

  /** The test restore's shares: "split" is confirmed at once (nothing to write); "replace" waits for the switch. */
  async function tested(h: PreparedShares, shares: readonly string[]) {
    setTyped(shares);
    setStale(false);
    if (!shares.length || h.mode !== "split") return;
    setBusy(true);
    try {
      await rt.service.confirmShares(h, shares);
      go(done(h));
    } catch (e) {
      if ((e as { code?: unknown }).code === "wrong_secret")
        setStale(true); // the code changed since the set was made
      else setError(sharesWords(e) ?? errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function check(c: string, shares: readonly string[]) {
    setStale(false);
    setChecked(null);
    setLost(false);
    setError(null);
    if (!c) return;
    try {
      const r = await rt.service.checkRecoveryCode(c, await setOf(shares));
      if (r === "current" || r === "current_before_restart") setChecked(r === "current" ? "ok" : "again");
      else {
        setStale(true);
        setLost(r === "stale_after_switch");
      }
    } catch (e) {
      setError(errText(e));
    }
  }

  const problem = error && (
    <div class="err" role="alert" id="shares-err">
      {error}
    </div>
  );

  if (step.at === "show") {
    const { h, i } = step;
    const date = formatDate(Date.now());
    const lines = paperLines(h, i, date);
    return (
      <div class="sh-wiz" id="shares-wizard">
        <div class="sh-sheet" id="shares-sheet">
          <h4 class="sh-title" id="shares-sheet-title">
            {sx("shSheetTitle", i + 1, h.count)}
          </h4>
          <p class="muted" id="shares-sheet-set">
            {sx("shSheetSet", h.setId, date)}
          </p>
          <div class="code-box sh-code" id="shares-share">
            {h.shares[i]!.split("-").map((g, k, all) => (
              <span key={k}>
                {g}
                {k < all.length - 1 && <i>-</i>}
              </span>
            ))}
          </div>
          <p class="muted">{sx("shPaperWhere")}</p>
        </div>
        {h.mode === "replace" && (
          <p class="callout" id="shares-not-yet">
            {sx("shNotYet")}
          </p>
        )}
        <div class="row2">
          <button type="button" class="btn sm ghost" id="shares-print" onClick={() => printPaper(lines)}>
            {sx("shPrint", i + 1)}
          </button>
          <button
            type="button"
            class="btn sm ghost"
            id="shares-save"
            onClick={() =>
              download(`sixkey-share-${h.setId}-${i + 1}-of-${h.count}.txt`, lines.join("\n") + "\n", "text/plain")
            }
          >
            {sx("shSaveFile")}
          </button>
        </div>
        <p class="hint" id="shares-save-warn">
          {sx("shSaveWarn")}
        </p>
        <label class="check strong">
          <input
            type="checkbox"
            id="shares-kept"
            checked={kept}
            onChange={(e) => setKept((e.target as HTMLInputElement).checked)}
          />{" "}
          {sx("shKept", i + 1)}
        </label>
        <div class="row2">
          {i > 0 && (
            <button type="button" class="btn sm ghost" id="shares-prev" onClick={() => go({ at: "show", h, i: i - 1 })}>
              {t("back")}
            </button>
          )}
          <button
            type="button"
            class="btn"
            id="shares-next"
            disabled={!kept}
            onClick={() => go(i + 1 < h.count ? { at: "show", h, i: i + 1 } : { at: "test", h })}
          >
            {t("continue")}
          </button>
          <button type="button" class="btn sm ghost" id="shares-cancel" onClick={() => go({ at: "start" })}>
            {t("cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (step.at === "test") {
    const { h } = step;
    const replace = h.mode === "replace";
    return (
      <div class="sh-wiz" id="shares-wizard">
        <h4 class="sh-title" id="shares-test-title">
          {sx(replace ? "shTestTitle" : "shTestTitleSplit", h.threshold)}
        </h4>
        <p class="muted" id="shares-test-lead">
          {sx("shTestLead", members(h.test))}
        </p>
        {replace && (
          <p class="callout" id="shares-not-yet">
            {sx("shNotYet")}
          </p>
        )}
        <ShareEntry
          id="shares-test"
          lockKey={LOCK_EPOCH_KEY}
          toCode={formatRecoveryCode}
          want={h.test}
          set={{ setId: parseInt(h.setId, 16), threshold: h.threshold }}
          autoFocus
          stale={stale}
          disabled={busy || keys.busy}
          onCode={(c, shares) => void tested(h, c ? shares : [])}
        />
        {problem}
        <div class="row2">
          {replace && (
            <button
              type="button"
              class="btn"
              id="shares-switch"
              disabled={typed.length !== h.threshold || keys.busy}
              onClick={() =>
                void keys.confirmShares(h, typed, sharesWords).then((ok) => {
                  if (!ok) return; // the page says why (the refusal at the top of this leaf)
                  keys.clear(); // the done screen below says it; the line is for a leaf the person moved to meanwhile
                  go(done(h));
                })
              }
            >
              {sx("shSwitch")}
            </button>
          )}
          <button
            type="button"
            class="btn sm ghost"
            id="shares-test-back"
            onClick={() => go({ at: "show", h, i: h.count - 1 })}
          >
            {t("back")}
          </button>
          <button type="button" class="btn sm ghost" id="shares-cancel" onClick={() => go({ at: "start" })}>
            {t("cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (step.at === "done") {
    return (
      <div class="sh-wiz" id="shares-wizard">
        <p class="callout good" id="shares-done" role="status">
          {sx(step.mode === "replace" ? "shDone" : "shDoneSplit", step.threshold, step.count)}
        </p>
        <p class="muted" id="shares-lost">
          {sx("shLost")}
        </p>
        <div class="row2">
          <button type="button" class="btn sm ghost" id="shares-again" onClick={() => go({ at: "start" })}>
            {t("back")}
          </button>
        </div>
      </div>
    );
  }

  if (step.at === "check")
    return (
      <div class="sh-wiz" id="shares-wizard">
        <p class="muted">{sx("shCheckLead")}</p>
        <ShareEntry
          id="shares-check"
          lockKey={LOCK_EPOCH_KEY}
          toCode={formatRecoveryCode}
          autoFocus
          stale={stale}
          onCode={(c, shares) => void check(c, shares)}
        />
        {checked && (
          <p class="callout good" id="shares-check-ok" role="status">
            {sx("shCheckOk")}
          </p>
        )}
        {checked === "again" && (
          <p class="callout" id="shares-check-restart" role="status">
            {sx("shCheckRestart")}
          </p>
        )}
        {lost && (
          <p class="callout" id="shares-check-lost" role="status">
            {sx("shSwitchLost")}
          </p>
        )}
        {problem}
        <div class="row2">
          <button type="button" class="btn sm ghost" id="shares-check-back" onClick={() => go({ at: "start" })}>
            {t("back")}
          </button>
        </div>
      </div>
    );

  const from = recoveryKeyOf(source, pw, code);
  return (
    <div class="sh-wiz" id="shares-wizard">
      <p class="muted" id="shares-intro">
        {sx("shIntro", count, threshold)}
      </p>
      <div class="sh-pick" role="radiogroup" aria-labelledby="shares-intro">
        {(["23", "35"] as const).map((id) => (
          <label key={id} class={`sh-opt${setup === id ? " on" : ""}`}>
            <input
              type="radio"
              name="shares-setup"
              id={`shares-${id}`}
              checked={setup === id}
              onChange={() => setSetup(id)}
            />
            <span>{sx(id === "23" ? "shPick23" : "shPick35")}</span>
          </label>
        ))}
      </div>
      <RecoveryKeyStep
        rt={rt}
        id="shares"
        labelledBy="shares-intro"
        source={source}
        onSource={(v) => {
          setSource(v);
          setError(null);
          setStale(false);
        }}
        password={pw}
        onPassword={setPw}
        code={code}
        onCode={(v) => {
          setCode(v);
          setStale(false);
        }}
        onShares={setViaShares}
        stale={stale}
        disabled={busy}
        words={{
          new: sx("shReplace"),
          newNote: sx("shReplaceNote"),
          current: sx("shSplitCurrent"),
          currentNote: sx("shSplitNote"),
        }}
      />
      {problem}
      <div class="row2">
        <button
          type="button"
          class="btn"
          id="shares-make"
          disabled={busy || !from}
          onClick={() => from && void make(from)}
        >
          {sx("shMake")}
        </button>
        <button type="button" class="btn sm ghost" id="shares-check-open" onClick={() => go({ at: "check" })}>
          {sx("shCheckMine")}
        </button>
      </div>
    </div>
  );
}
