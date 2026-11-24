// Settings page > Security > Security mode (PHASE0X-PLAN C5; ux-study §2.8): the two presets from the first-run question
// (src/core/service/presets.ts), and the settings they bundle, each still adjustable. Which preset is current is read off
// the settings, never stored: change any bundled setting and the mode shows as Custom. The first-run wizard points here
// by name ("Settings › Security › Security mode", frRiskNote), so the panel and box titles must keep matching it.
import { useState } from "preact/hooks";
import { applyPreset, detectPreset, type PresetId } from "../core/service/presets";
import { displayOf, type AutoLock, type Settings } from "../core/service/types";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { SHORTCUTS_PAGE, useShortcut } from "../ui/shortcut";
import { useSettings } from "./settings-store";
import { BoxTitle, errText, type Ctx } from "./shared";
import "./securitymode.css";

const CARDS: readonly (readonly [PresetId, string, string])[] = [
  ["standard", "frSoloTitle", "frSoloBody"],
  ["shared", "frSharedTitle", "frSharedBody"],
];

export function SecurityMode({ rt, status, reload }: Ctx) {
  const { settings: s, change: changeSaved } = useSettings(rt);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // switching to "lock every time" (a soft lock: the PIN opens) and declaring the profile shared (a hard lock) lock
  // Sixkey (VaultService.updateSettings): the page says so where the change was made
  const [lockedNow, setLockedNow] = useState(false);
  const [busy, setBusy] = useState(0); // changes still being saved (and the page brought up to date after them)
  // What is typed in the minutes field until it is committed (Enter, or leaving the field). The field is drawn from the
  // settings, and anything that redraws the page meanwhile (a reload, another panel's change) would otherwise reset it.
  const [typing, setTyping] = useState<string | null>(null);
  const lockKey = useShortcut("lock"); // the `lock` command (QUICK-UNLOCK §5.12 item 2)
  if (!s) return null;
  const mode = detectPreset(s);
  const al = s.autoLock;

  /**
   * Save one change, the whole record (src/options/settings-store.ts), then show the real state. A change of lock mode
   * other than to "lock every time" no longer locks (OWNER-DECISIONS/26): it decides the next lock.
   */
  async function save(change: (cur: Settings) => Settings) {
    setError(null);
    setLockedNow(false);
    let locks = false;
    setBusy((n) => n + 1);
    try {
      await changeSaved((cur) => {
        const next = change(cur);
        locks =
          (next.profile === "shared" && cur.profile !== "shared") ||
          (next.autoLock.mode === "always" && cur.autoLock.mode !== "always");
        return next;
      });
      await reload();
      setLockedNow(locks && status.state === "unlocked" && status.passwordProtected);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(errText(e));
      await reload();
    } finally {
      setBusy((n) => n - 1);
    }
  }
  const setAutoLock = (autoLock: AutoLock) => void save((cur) => ({ ...cur, autoLock }));

  return (
    <div class="box" id="security-mode" aria-busy={busy > 0}>
      <BoxTitle icon="shieldCheck">{t("smTitle")}</BoxTitle>
      <p class="muted sm-lead">{t("smLead")}</p>
      <div class="sm-cards" role="radiogroup" aria-label={t("smTitle")}>
        {CARDS.map(([id, title, body]) => (
          <label key={id} class={`sm-card${mode === id ? " on" : ""}`}>
            <input
              type="radio"
              name="sm-preset"
              id={`sm-${id}`}
              checked={mode === id}
              onChange={() => void save((cur) => applyPreset(cur, id))}
            />
            <span>
              <b>{t(title)}</b>
              <small>{t(body)}</small>
            </span>
          </label>
        ))}
        {mode === "custom" && (
          <label class="sm-card on custom">
            <input type="radio" name="sm-preset" id="sm-custom" checked disabled />
            <span>
              <b>{t("smCustomTitle")}</b>
              <small>{t("smCustomBody")}</small>
            </span>
          </label>
        )}
      </div>

      <h4 class="sm-sub">{t("autoLockTitle")}</h4>
      <div class="row2">
        <label for="al-mode">{t("autoLockWhen")}</label>
        <select
          id="al-mode"
          value={al.mode}
          onChange={(e) => {
            const m = (e.target as HTMLSelectElement).value;
            setAutoLock(
              m === "idle" ? { mode: "idle", minutes: 15 } : m === "always" ? { mode: "always" } : { mode: "session" },
            );
          }}
        >
          <option value="idle">{t("alIdle")}</option>
          <option value="session">{t("alSession")}</option>
          <option value="always">{t("alAlways")}</option>
        </select>
        {al.mode === "idle" && (
          <>
            <input
              id="al-minutes"
              type="number"
              min={1}
              max={1440}
              style="width:80px"
              value={typing ?? al.minutes}
              onInput={(e) => setTyping((e.target as HTMLInputElement).value)}
              onChange={(e) => {
                setTyping(null);
                setAutoLock({ mode: "idle", minutes: Number((e.target as HTMLInputElement).value) || 15 });
              }}
            />
            <span>{t("minutes")}</span>
          </>
        )}
      </div>
      <label class="check">
        <input
          id="al-screen"
          type="checkbox"
          checked={s.lockOnScreenLock}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            void save((cur) => ({ ...cur, lockOnScreenLock: on }));
          }}
        />{" "}
        {t("lockOnScreenLock")}
      </label>
      <p class="muted">{t("autoLockNote")}</p>
      <p class="sm-clip" id="sm-lock-key">
        <Icon name="keyboard" size={16} />
        <span>
          {t("lockShortcutBody")}{" "}
          {lockKey === undefined ? null : lockKey ? <kbd class="look-key">{lockKey}</kbd> : t("lookShortcutNone")}{" "}
          <a
            href="#"
            id="sm-lock-key-edit"
            onClick={(e) => {
              e.preventDefault();
              void chrome.tabs.create({ url: SHORTCUTS_PAGE });
            }}
          >
            {t("lookShortcutOpen")}
          </a>
        </span>
      </p>
      <h4 class="sm-sub">{t("lookCodes")}</h4>
      <label class="check">
        <input
          id="sm-hide"
          type="checkbox"
          checked={displayOf(s).hideCodes}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            void save((cur) => ({ ...cur, display: { ...displayOf(cur), hideCodes: on } }));
          }}
        />{" "}
        {t("lookHide")}
      </label>
      <p class="sm-clip">
        <Icon name="clipboard" size={16} />
        <span>
          {t("smClipNote")}{" "}
          <a href="#clipboard" id="sm-clip">
            {t("clipTitle")}
          </a>
        </span>
      </p>
      {/* H3 (PHASE0X-PLAN C6): always on, part of neither mode, so it is a fixed line and not a setting. */}
      <p class="sm-clip" id="sm-export">
        <Icon name="lock" size={16} />
        <span>{t("expPwLead")}</span>
      </p>

      {lockedNow && (
        <p class="callout" id="sm-locked" role="status">
          <Icon name="lock" size={16} />
          <span>{t("smLockedNow")}</span>
        </p>
      )}
      {error && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}
      {saved && (
        <span class="ok-msg" role="status">
          <Icon name="check" size={15} />
          {t("saved")}
        </span>
      )}
    </div>
  );
}
