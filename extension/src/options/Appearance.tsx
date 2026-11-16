// Settings page > Appearance (PHASE0X-PLAN C4; ux-study §2.1, §2.2, §2.7): the colour theme, what a click on the toolbar
// icon opens (the popup or the side panel: docs/design/notes/SIDEPANEL-NOTES.md), how the popup lists accounts (density,
// order, hidden codes; the popup draws them, PHASE0X-PLAN B1), and the keyboard shortcut that opens it.
import { useEffect, useState } from "preact/hooks";
import { displayOf, profileOf, type DisplaySettings } from "../core/service/types";
import { OPENER_KEY, openerOf, panelSupported, type Opener } from "../platform/action-mode";
import { t } from "../ui/i18n";
import { Icon, type IconName } from "./icons";
import { SHORTCUTS_PAGE, useShortcut } from "../ui/shortcut";
import { getThemeChoice, type ThemeChoice } from "../ui/theme";
import { followTheme, setThemeChoice } from "../ui/theme-set";
import { useSettings } from "./settings-store";
import { BoxTitle, errText, Panel, type Ctx } from "./shared";
import "./appearance.css";

/** A row of mutually exclusive choices: real radio buttons (arrow keys move between them), drawn as one segmented bar. */
function Choice<V extends string>(p: {
  id: string;
  label: string;
  value: V;
  options: readonly (readonly [V, string, IconName?])[];
  onPick: (v: V) => void;
  hint?: string;
}) {
  return (
    <div class="look-row">
      <span class="look-k" id={`${p.id}-label`}>
        {p.label}
      </span>
      <div class="look-v">
        <div class="seg" role="radiogroup" aria-labelledby={`${p.id}-label`}>
          {p.options.map(([v, text, icon]) => (
            <label key={v} class={`seg-o${p.value === v ? " on" : ""}`}>
              <input
                type="radio"
                name={p.id}
                id={`${p.id}-${v}`}
                value={v}
                checked={p.value === v}
                onChange={() => p.onPick(v)}
              />
              {icon && <Icon name={icon} size={15} />}
              <span>{text}</span>
            </label>
          ))}
        </div>
        {p.hint && <p class="look-hint">{p.hint}</p>}
      </div>
    </div>
  );
}

export function Appearance({ rt }: Ctx) {
  const { settings, change } = useSettings(rt);
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice);
  useEffect(() => followTheme(setTheme), []); // a choice made in the View menu of the popup or the side panel
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shortcut = useShortcut("_execute_action"); // the one that opens the popup
  const d = settings ? displayOf(settings) : null;
  // What the icon opens: its own key in chrome.storage.local, which the service worker reads and applies at once
  // (src/platform/action-mode.ts). Not offered where the browser has no side panel, nor in a shared profile.
  const [opener, setOpener] = useState<Opener | null>(null);
  useEffect(() => {
    rt.local.get([OPENER_KEY]).then(
      (r) => setOpener(openerOf(r[OPENER_KEY])),
      () => undefined,
    ); // unreadable: hidden
  }, [rt]);

  async function pickOpener(v: Opener) {
    setError(null);
    try {
      if (v === "panel") await rt.local.set({ [OPENER_KEY]: "panel" });
      else await rt.local.remove([OPENER_KEY]); // the default
      setOpener(v);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function setDisplay(part: Partial<DisplaySettings>) {
    setError(null);
    try {
      // the whole record goes back, with only this part of `display` changed (src/options/settings-store.ts)
      await change((s) => ({ ...s, display: { ...displayOf(s), ...part } }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Panel id="appearance" icon="sun" title={t("lookTitle")} lead={t("lookLead")}>
      <div class="box look">
        <Choice
          id="look-theme"
          label={t("lookTheme")}
          value={theme}
          hint={t("lookThemeNote")}
          options={[
            ["auto", t("lookThemeAuto"), "device"],
            ["light", t("lookThemeLight"), "sun"],
            ["dark", t("lookThemeDark"), "moon"],
          ]}
          onPick={(v) => {
            setThemeChoice(v);
            setTheme(v);
          }}
        />
        {settings &&
          opener &&
          panelSupported() &&
          (profileOf(settings) === "shared" ? (
            <div class="look-row">
              <span class="look-k">{t("lookOpen")}</span>
              <div class="look-v">
                <p class="look-hint" id="look-open-shared">
                  {t("lookOpenShared")}
                </p>
              </div>
            </div>
          ) : (
            <Choice
              id="look-open"
              label={t("lookOpen")}
              value={opener}
              hint={t("lookOpenNote")}
              options={[
                ["popup", t("lookOpenPopup")],
                ["panel", t("lookOpenPanel"), "panel"],
              ]}
              onPick={(v) => void pickOpener(v)}
            />
          ))}
        {d && (
          <>
            <Choice
              id="look-density"
              label={t("lookDensity")}
              value={d.density}
              hint={t("lookDensityNote")}
              options={[
                ["standard", t("lookDensityStandard")],
                ["compact", t("lookDensityCompact")],
              ]}
              onPick={(density) => void setDisplay({ density })}
            />
            <Choice
              id="look-sort"
              label={t("lookSort")}
              value={d.sort}
              hint={t("lookSortNote")}
              options={[
                ["manual", t("lookSortManual")],
                ["name", t("lookSortName")],
              ]}
              onPick={(sort) => void setDisplay({ sort })}
            />
            <div class="look-row">
              <span class="look-k">{t("lookCodes")}</span>
              <div class="look-v">
                <label class="check">
                  <input
                    id="look-hide"
                    type="checkbox"
                    checked={d.hideCodes}
                    onChange={(e) => void setDisplay({ hideCodes: (e.target as HTMLInputElement).checked })}
                  />{" "}
                  {t("lookHide")}
                </label>
                <p class="look-hint">{t("listRevealHint")}</p>
              </div>
            </div>
          </>
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
      <div class="box">
        <BoxTitle icon="keyboard">{t("lookShortcutTitle")}</BoxTitle>
        <div class="row2">
          <span>{t("lookShortcutBody")}</span>
          {shortcut !== undefined &&
            (shortcut ? (
              <kbd class="look-key" id="look-shortcut">
                {shortcut}
              </kbd>
            ) : (
              <span class="muted" id="look-shortcut">
                {t("lookShortcutNone")}
              </span>
            ))}
        </div>
        <div class="row2">
          <button
            type="button"
            class="btn sm ghost"
            id="look-shortcut-edit"
            onClick={() => void chrome.tabs.create({ url: SHORTCUTS_PAGE })}
          >
            <Icon name="keyboard" size={15} />
            {t("lookShortcutOpen")}
          </button>
          <span class="muted look-hint">{t("lookShortcutWhere", SHORTCUTS_PAGE)}</span>
        </div>
      </div>
    </Panel>
  );
}
