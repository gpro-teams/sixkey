// The View menu (docs/design/notes/QUICKVIEW-NOTES.md): the four Appearance choices that change how the list looks, one
// click from the search field, in the popup and the side panel. The search row's button (main/Main.tsx) loads this
// module on its first click, so neither its code, its styles nor its text are in the popup's counted bundle: the text is
// catalogs/view-<lang>.json (scripts/messages.py VIEW), read into a lookup of this module's own as it loads: the page's
// catalog (src/ui/i18n.ts) is never touched, so a chunk that cannot be loaded costs the menu its words and the rest of the
// popup nothing. The build works out which keys this file can show (scripts/catalog-keys.mjs viewKeys;
// test/unit/view-catalog.test.ts).
//
// It writes what Settings > Appearance writes, and nothing else: the settings record's `display` (the whole record is
// read, one part changed, the whole record put back: src/options/settings-store.ts says why; the lock rules and the
// profile are as they were, so nothing here locks) and the theme choice (src/ui/theme-set.ts). A change made in Settings
// meanwhile shows here too: the list is drawn again at every change of the settings record (the side panel does that
// itself, src/sidepanel/guard.ts), and a theme change comes by the `storage` event.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DisplaySettings } from "../../core/service/types";
import type { PopupRuntime } from "../../platform/runtime-base";
import { t, type Catalog, type Lang } from "../../ui/i18n";
import { lazyText } from "../../ui/lazy-text";
import { getThemeChoice, type ThemeChoice } from "../../ui/theme";
import { followTheme, setThemeChoice } from "../../ui/theme-set";
import "./view.css";

// Two literal imports, one per language, so each language is its own chunk (scripts/build.mjs names it); only `.default`.
const viewCatalog = async (lang: Lang): Promise<Catalog> =>
  lang === "zh_CN"
    ? (await import("../../../catalogs/view-zh_CN.json")).default
    : (await import("../../../catalogs/view-en.json")).default;

// The menu's text, read as soon as this module is loaded: this language's, else English's, else null (the menu then says
// so, in the page's own words, and still closes). `x` is the menu's t(); until the text is in, the menu draws nothing. The
// lookup is src/ui/lazy-text.ts's, shared with the Fill button's.
const x = lazyText(viewCatalog);

/** One row: its name, and a bar of real radio buttons (the arrow keys move between them), as in Appearance. */
function Choice<V extends string>(p: {
  id: string;
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onPick: (v: V) => void;
}) {
  return (
    <div class="vw-row">
      <span class="vw-k" id={p.id}>
        {p.label}
      </span>
      <div class="vw-seg" role="radiogroup" aria-labelledby={p.id}>
        {p.options.map(([v, label]) => (
          <label key={v} class={`vw-o${p.value === v ? " on" : ""}`}>
            <input
              type="radio"
              name={p.id}
              id={`${p.id}-${v}`}
              value={v}
              checked={p.value === v}
              onChange={() => p.onPick(v)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * `display`: the settings record's, as the list was last drawn with it. `reload` draws the popup's screen again (the list
 * then follows every change); `onClose` is for Escape, a click outside and the button that opened the menu (Main.tsx).
 */
export function ViewMenu(p: {
  rt: PopupRuntime;
  display: DisplaySettings;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const { rt, reload } = p;
  const [ready, setReady] = useState(x.words() !== undefined);
  // What was chosen and is not yet in the drawn settings: shown at once, so a click never waits for the write.
  const [pick, setPick] = useState<Partial<DisplaySettings>>({});
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const write = useRef<Promise<unknown>>(Promise.resolve()); // the writes, one at a time, each over the record as stored
  const close = useRef(p.onClose);
  close.current = p.onClose;
  const d = { ...p.display, ...pick };

  useEffect(() => {
    let live = true;
    void x.loaded.then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  // The drawn settings caught up with a choice: it is no longer pending.
  useEffect(
    () =>
      setPick((x) =>
        Object.fromEntries(Object.entries(x).filter(([k, v]) => p.display[k as keyof DisplaySettings] !== v)),
      ),
    [p.display],
  );
  useEffect(() => {
    // any change of the settings record, whoever made it (this menu, Settings): the list is drawn again from storage
    const changed = (c: Record<string, chrome.storage.StorageChange>) => {
      if ("sk_settings" in c) void reload();
    };
    chrome.storage.local.onChanged.addListener(changed);
    const unfollow = followTheme(setTheme);
    // a press outside the menu closes it; the button that opened it is not outside (its own click closes the menu)
    const away = (e: PointerEvent) => {
      const el = e.target as Node;
      if (!box.current?.contains(el) && !document.getElementById("view-toggle")?.contains(el)) close.current();
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      chrome.storage.local.onChanged.removeListener(changed);
      unfollow();
      document.removeEventListener("pointerdown", away, true);
    };
  }, [reload]);
  // Under the button, as tall as the window leaves room for (it scrolls past that, so a short window or a high zoom cuts
  // nothing off), and the focus in on the chosen theme, as the text arrives.
  useLayoutEffect(() => {
    if (!ready || !box.current) return;
    const top = (document.getElementById("view-toggle")?.getBoundingClientRect().bottom ?? 90) + 6;
    box.current.style.top = `${top}px`;
    box.current.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
    (box.current.querySelector<HTMLInputElement>("input:checked") ?? box.current).focus();
  }, [ready]);

  const set = (part: Partial<DisplaySettings>) => {
    setFailed(false);
    setPick((x) => ({ ...x, ...part }));
    write.current = write.current.then(async () => {
      try {
        const s = await rt.settings.get();
        await rt.settings.set({ ...s, display: { ...(s.display ?? p.display), ...part } });
        // drawn again from storage now (a write of the value already stored fires no change event, and its choice would
        // stay pending for ever); the change event of a write that did change something draws it once more
        await reload();
        setPick((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !(k in part))));
      } catch {
        setFailed(true);
        setPick({});
      }
    });
  };

  function keys(e: KeyboardEvent) {
    // Nothing typed here is for the list behind the menu (Main.tsx's keys: the arrows move its selection, Enter copies,
    // letters search): the arrows move between the choices, Space and Enter set one.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      document.getElementById("view-toggle")?.focus();
      close.current();
    } else if (e.key === "Tab") {
      // the menu is small and has no way out but Escape: Tab goes round its controls (a radio group is one stop)
      const stops = [...(box.current?.querySelectorAll<HTMLInputElement>("input") ?? [])].filter(
        (i) => i.type !== "radio" || i.checked,
      );
      const at = stops.indexOf(document.activeElement as HTMLInputElement);
      const edge = e.shiftKey ? 0 : stops.length - 1;
      if (at === edge || at < 0) {
        e.preventDefault();
        stops[e.shiftKey ? stops.length - 1 : 0]?.focus();
      }
    }
  }

  if (!ready) return null;
  // No text (neither language's chunk could be read): the page's own line, nothing else; Escape and a press outside close it
  const dialog = {
    class: "vw-pop",
    role: "dialog" as const,
    "aria-modal": true,
    "aria-labelledby": "view-toggle",
    ref: box,
    tabIndex: -1, // the focus goes in even when there is no control (no text): Escape then reaches the menu
    onKeyDown: keys,
  };
  if (!x.words())
    return (
      <div {...dialog}>
        <p class="vw-err" role="alert">
          {t("errorTitle")}
        </p>
      </div>
    );
  return (
    <div {...dialog}>
      <Choice
        id="view-theme"
        label={x("lookTheme")}
        value={theme}
        options={[
          ["auto", x("viewAuto")],
          ["light", x("lookThemeLight")],
          ["dark", x("lookThemeDark")],
        ]}
        onPick={(v) => {
          setThemeChoice(v);
          setTheme(v);
        }}
      />
      <Choice
        id="view-density"
        label={x("lookDensity")}
        value={d.density}
        options={[
          ["standard", x("lookDensityStandard")],
          ["compact", x("lookDensityCompact")],
        ]}
        onPick={(density) => set({ density })}
      />
      <Choice
        id="view-sort"
        label={x("lookSort")}
        value={d.sort}
        options={[
          ["manual", x("lookSortManual")],
          ["name", x("lookSortName")],
        ]}
        onPick={(sort) => set({ sort })}
      />
      <div class="vw-row">
        <label class="vw-hide">
          <input
            type="checkbox"
            id="view-hide"
            checked={d.hideCodes}
            aria-describedby="view-hide-note"
            onChange={(e) => set({ hideCodes: (e.target as HTMLInputElement).checked })}
          />
          {x("viewHide")}
        </label>
        <p class="vw-hint" id="view-hide-note">
          {x("listRevealHint")}
        </p>
      </div>
      {failed && (
        <p class="vw-err" role="alert">
          {t("errorTitle")}
        </p>
      )}
    </div>
  );
}
