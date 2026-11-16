# The View menu: the Appearance choices one click from the list

The owner asked (2026-10-21, with two screenshots of Settings › Appearance) for the quick choices to be offered in the
popup itself, "without going to Settings": the colour theme, the rows' density, the order, and "Hide codes in the popup
and the side panel". This change adds a small menu, opened from the search field, with exactly those four. The side
panel draws the popup's screens, so it has the menu too.

Marks used below: **[measured]** seen in this package's runs (headless Chromium from Playwright 1.64, macOS);
**[owner]** a choice made for the owner, with its default, that the owner may overrule; **[unverified]** not seen.

## 1. What it does

- **A button at the right end of the search field**, a sun icon named "Appearance" (外观), the icon and the name of the
  Settings section. It is in the search row and not in the header because the header already holds the brand, the "local" badge,
  the language, Lock, "Open in side panel" and Settings, which is a full row at 320 px.
- **The menu** opens under the button, over the list, and has four rows: **Theme** (Auto, Light, Dark), **Rows**
  (Standard, Compact), **Order** (Manual, By name) and a **Hide codes** box with the line that says how a hidden code is
  copied and shown. The words are Appearance's, with two short forms where Appearance's would not fit 296 px
  ("Auto" for "Follow the system", "Hide codes" for "Hide codes in the popup and the side panel"; 自动, 隐藏验证码).
- **It changes what Settings changes**, nothing else: the same four preferences, in the same places (§3). Each applies
  at once, is kept, and Settings › Appearance shows it. A change made in Settings shows in the open menu and the list.
- **Closing**: Escape (the focus goes back to the button), a press outside the menu, or the button again. Tab goes round
  the menu's controls; the arrow keys move between the choices of a row; nothing typed in the menu reaches the list.
- **Hidden codes mean what they meant**: no digit in the page, a click copies, Space or press-and-hold shows one row's
  code for 5 seconds. The box only changes the setting. Turning "Hide codes" on also ends any reveal still running.

## 2. Choices made for the owner

| #   | Choice                                                                    | Default and why                                                                                                                                                                                                                                                                                                                                                                   | Overrule by                                                                      |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Where the button is                                                       | Inside the search field, at its right end, after the "/" hint. The header is full at 320 px.                                                                                                                                                                                                                                                                                      | Moving the button in `main/Main.tsx` (the menu positions itself under it)        |
| 2   | Which icon                                                                | The sun: Settings' own icon for Appearance, already in the set (+2 B popup, −1 B with the gate open, measured). An eye was the first choice and was dropped after review: it is the show/hide-password glyph of the lock screen, and above a list of masked codes it reads as "show them". The sun is also Settings' "Light" choice, which is why the menu's bars carry no icons. | A new `IconName` (a "contrast" glyph measured +30 B), one line in Main           |
| 3   | The name                                                                  | "Appearance", Settings' own section name (`lookTitle`), so there is no new string in the popup's catalog and the owner finds the same word in both places.                                                                                                                                                                                                                        | One key                                                                          |
| 4   | Text-only choices (no icons in the bars)                                  | Settings' bars have icons for the theme; the menu's do not. The icons would put the icon table into the menu's chunk and split the popup's shared chunk (§4, +400 B gzipped, measured).                                                                                                                                                                                           | Re-measure first                                                                 |
| 5   | A menu over the list, not a row that pushes the list down                 | Over. A row that grows would move the accounts under the pointer and, at 600 px, push the footer out. The cost: the first rows are covered while the menu is open; Escape or a press outside gives them back.                                                                                                                                                                     | `view.css`                                                                       |
| 6   | Tab goes round the menu; Escape is the way out                            | A trap, as a small dialog has it, rather than a menu that closes when Tab leaves it. The menu is the last thing in the page, so without a trap Shift+Tab from its first control would land on the footer's Add button instead of the button that opened it.                                                                                                                       | Remove the Tab branch in `keys()` (the menu then closes on a press outside only) |
| 7   | A press on the button toggles; a press anywhere else outside closes       | So a second click on the button closes the menu instead of closing and opening it again.                                                                                                                                                                                                                                                                                          | —                                                                                |
| 8   | The theme stays a per-browser choice                                      | As in Settings (`sk_theme` in localStorage): not in the vault, a backup or sync. The menu does not repeat Settings' note about it.                                                                                                                                                                                                                                                | —                                                                                |
| 9   | "Hide codes" in the menu changes the Security mode card as Settings' does | The Security mode presets include hidden codes (presets.ts), so after ticking the box a preset card reads "Custom" in Settings, exactly as after ticking Appearance's box.                                                                                                                                                                                                        | —                                                                                |
| 10  | "Settings changes show in an open popup"                                  | The toolbar popup closes when it loses the focus, so it cannot be open while Settings is used; the side panel is the page that stays open, and that is where it is tested with the real icon. A popup page opened in a tab (as the tests do) follows too, through the menu's listener.                                                                                            | —                                                                                |

## 3. How it works

**Files.** `src/popup/main/View.tsx` and `view.css` (the menu; loaded on the first click), `src/ui/theme-set.ts` (the theme
setter and follower, moved out of `theme.ts`, §4), `catalogs/view-<lang>.json` (generated), and small edits to `Main.tsx`
(the button), `options/App.tsx`, `options/settings-store.ts`, `options/Appearance.tsx` and `sidepanel/main.tsx`.

**What it writes.**

- `display.density`, `display.sort`, `display.hideCodes` of the settings record (`sk_settings`): the whole record is read
  just before, one part of `display` is changed, the whole record goes back through `rt.settings`, the way
  `options/settings-store.ts` does it. `autoLock`, `lockOnScreenLock` and `profile` are what they were, so nothing here
  locks, and a lock rule changed elsewhere meanwhile is not put back. Writes go one after another, so two quick choices
  do not lose each other. (The popup's service, `ServiceCore`, has no `updateSettings`, and adding it would put code in the
  counted bundle; the store's `get` and `set` are what `VaultService.updateSettings` calls for a change like this, which
  has no lock side effect.)
- The theme: `setThemeChoice` (the one Appearance calls), which keeps `sk_theme` in localStorage and applies it to the page.

**How it stays live.**

- A choice shows at once in the menu (a pending value, shown until the drawn settings catch up) and in the page: the theme
  directly; the rows, order and hidden codes when the popup's screen is drawn again. The menu listens to
  `chrome.storage.local.onChanged` while it is open, looks at the key's name only (`sk_settings`, as the worker's listener
  does: action-mode.ts) and draws the screen again from storage: that is how a change made in Settings reaches the open
  menu and list. The menu's own write also draws the screen again once it is in (a write of the value already stored fires
  no change event, and its choice would stay pending), so a change of the menu's own may draw twice, and the side panel's
  guard reloads on the same change as well (guard.ts); they are cheap and idempotent. A pending choice is dropped when
  that redraw is in.
- A theme chosen on another page arrives as the window's `storage` event. `followTheme` (theme-set.ts) applies it and
  tells the page; the menu, the side panel's entry and Settings' Appearance use it. The toolbar popup does not: it closes
  when it loses the focus.
- Settings follows the menu: `options/App.tsx` calls `watchSettings` (settings-store.ts), which listens to
  `chrome.storage.local.onChanged` for `sk_settings` (the key's name only) and calls `refreshSettings`, which reads the record through the service and hands it to
  every panel that shows it, behind any change of that page still being saved (the same queue). Before this, an open
  settings page showed the record as it was when it opened.
- The settings page follows the theme at its entry (`options/main.tsx`), not only in the Appearance section, so it follows
  whichever section is drawn (the page may draw one section at a time).
- A lock elsewhere takes the open menu with the list: the menu is a child of `Main`, which is dropped. The menu is also
  closed when the popup goes to the add view or the confirm page.

**Keys and focus.** The menu's root stops every key at itself (`stopPropagation`); `Main`'s document handler would
otherwise take the arrows for the list's selection, Enter for "copy the selected code" (a radio is not a button) and a
letter for the search field. The side panel's input guard listens in the capture phase, so typing in the menu still counts
as use there. The dialog is `aria-modal`. The focus goes to the chosen theme as the text arrives (to the dialog itself when there is no
text); Escape returns it to the button. A press outside
closes the menu through a capture-phase `pointerdown` listener, which every close removes with the others.

**Size.** The menu is as tall as the window leaves room for below the button (set from the button's position when it opens)
and scrolls past that, so at 175% zoom or in a short side panel the hint and the error line are reachable, none cut off.

**If its text cannot be read.** The menu keeps its words in a lookup of its own (`x()`), read from `catalogs/view-<lang>.json`
as the module loads: this language's, else English's. The page's catalog (`i18n.ts`) is never touched, so a missing chunk
costs the menu its words and the rest of the popup nothing (the first version merged into the page's catalog, and a failed
chunk turned the whole popup English, or into key names). With neither language's chunk, the menu opens with one line in the
page's own words ("Something unexpected went wrong", the popup's `errorTitle`), no controls, and closes on Escape; if the
menu's code is gone, the button shows the same line as a toast; likewise the add view (tested: `quickview.spec.ts` removes
each chunk from a private copy of the build).

**One known race.** The menu reads the record and writes it back with only `display` changed, as Settings does; the two
are not locked against each other across pages. A lock rule saved in Settings in the few milliseconds between the menu's
read and its write is put back to the old value (the lock itself, which Settings performs first, has happened). It needs
two human clicks in two pages within that window. A lock rule changed any other time is kept.

**The menu covers the codes.** At 376 px the 300 px menu covers the codes column, so the effect of "Hide codes" shows when
the menu is closed (Escape or a press outside), not behind it. Kept as it is: a narrower menu would still cover most of
the column, and a menu that moves off the codes has no good place at 320 px. The checked box and the next frame after
closing show it. (Owner veto welcome.)

**The search field's ring.** The field showed its focus ring on `:focus-within`; with a button inside it, the ring (and the
button's own) showed after Escape returned the focus to the button. It is now `:has(input:focus)`: the ring is the text
field's, as the screenshots show.

**Source rules.** `storage.onChanged` listeners are an explicit list (autofill-pre-source-rules.test.ts): `popup/main/View.tsx`
and `options/settings-store.ts` are added to it, with this reason. `quickview-source-rules.test.ts` pins the rest (§5), loosely, so harmless refactors do not break it.

## 4. The popup's budget

The popup's gzip limit is 61,440 B and the owner's floor is 1,500 B of headroom with the sync user interface in; the side
panel's limit is 63,488 B. The measure is `check-dist`'s: the static scripts and stylesheets of the page, each gzipped, plus
the larger popup catalog. Gate open means `SYNC_UI_IN_STORE_BUILD = true` in a private copy (as m6-gate.test.ts builds it);
the committed value stays `false`.

| Build, gate open                                        |  Popup | Headroom | Side panel |
| ------------------------------------------------------- | -----: | -------: | ---------: |
| Before this change                                      | 59,904 |    1,536 |     61,822 |
| The View menu alone (button, lazy menu, theme follower) | 60,113 |    1,327 |     62,327 |
| Final: + the "Add account" view loaded on first use     | 59,732 |    1,708 |     61,942 |

The gate closed (the store build as it is now): popup 59,065 → 58,905 B, side panel 60,979 → 61,120 B. (The middle row is the
first version's measure; the final rows include the private-catalog menu and the later fixes.)

Moved on top of the menu: **AddMenu −551 B** in both pages (the view and its `.pz` styles, 1.9 KB + 0.7 KB raw now in their
own chunks). The menu alone takes the popup under the floor; AddMenu alone clears it. A second move, the first-run and
state screens (310 B), was made in the first version and dropped: the autofill work loads those screens its own way, and the
popup should have one mechanism for lazy screens.

- **What is lazy, and the cost of the first use.** The menu's code (3.5 KB raw), styles (1.4 KB) and text (two chunks, 254 B
  and 335 B gzipped), loaded on the first click on the button; the "Add account" view, on its first draw. Each is a local file: a few milliseconds, in the same page. Nothing is fetched from the network.
  Everything lazy is outside the popup's budget by the build's own definition (check-dist counts what the page's HTML names,
  and the one catalog the page loads up front).
- **The menu's text is a catalog of its own**: `catalogs/view-<lang>.json`, 12 keys written by `scripts/messages.py` from a
  fragment's `VIEW` list (existing keys listed again, not moved: the settings page keeps its own text; plus the two short
  forms). `scripts/catalog-keys.mjs` stops the popup's walk at `View.tsx` and works out its keys (`viewKeys`, as for a
  settings part), so none of the menu's words is in the popup's counted catalog; the menu draws nothing until its text is in, so no key
  name is ever on screen. The popup's catalog gained one
  key, `lookTitle` (the button's name, +10 B). Budget: 2,048 B gzipped (measured 335 B, plus the 1.5 KB the parts get,
  rounded to 512 B), checked by messages.py and check-dist alike.
- **The build and check-dist refuse**: the menu's code or text reachable from any page's static graph or HTML; a page
  other than the popup and the side panel reaching them; a chunk that is not the generated file or whose text is not the
  full catalog's; a different set of keys in the two languages; the text over its budget; a key the menu can show that
  neither its catalog nor the popup's has.
- **Sensitivity of the shared chunks (measured).** The bundler groups modules by which entry points reach them, and each
  group is a file gzipped on its own. A new lazy chunk that imports some of a group's modules and not the others splits the
  group. Two such splits were met and avoided: the menu importing `ui/icons` (the icon table and the art module came
  apart: +400 B), and importing a value from `core/service/types.ts` (the vault-model chunk became a static preload: +300 B).
  The menu therefore draws no icons and imports only types from the service; `quickview-source-rules.test.ts` pins its list
  of imports and says why. The same reason put `setThemeChoice` and `followTheme` in `theme-set.ts`: exported from
  `theme.ts` they would be kept in the popup's chunk although the popup never calls them.
- **A CSS rule that was in the wrong file.** Moving the add view out of the counted bundle took `add.css` with it, and
  `.empty-acts` (the two buttons under the empty list's picture) went too. The visual guard found it ("unstyled
  div.empty-acts"); the rule is now in `popup.css`.

## 5. Tests

Unit (vitest): `view-menu.test.ts` renders the menu with Preact into the project's minimal document (each control's write,
the pending state, a failed write, the order of writes, a lock rule changed meanwhile, following, keys, Tab, outside press,
every listener removed); `view-catalog.test.ts` (the file is exactly the keys the code can show, Appearance's text, the
popup's counted catalog does not carry the menu's words, messages.py's refusals); `quickview-source-rules.test.ts` (lazy
only, what it writes and with which keys and values, keys stop, listener pairs, where following lives);
`quickview-check-dist.test.ts` (check-dist's rules against altered builds, and two builds that must stop);
`view-menu-failure.test.ts` (each language's text chunk made to fail: the menu in English, then the menu's one line; the page's catalog untouched); `settings-refresh.test.ts` (including the page's listener, `watchSettings`); `theme.test.ts` (followTheme); and the changed `budget-split`, `i18n-popup` and
`autofill-pre-source-rules` tests.

End to end (`test/e2e/quickview.spec.ts`, serial, in the real browser): each of the four choices applies at once, is stored
where Settings stores it (`sk_settings.display`, `sk_theme`), shows in Settings, shows again in a popup opened afterwards,
and a change made in Settings shows in the open menu and list; Hide codes keeps its meaning (no digit in the page, a click
copies, Space shows a row, Space on the box toggles the box); Escape, an outside press, the button, Tab, arrows, and the keys
that do not reach the list (nothing copied, the clipboard untouched); the side panel (a page in a tab and the real panel
opened by the toolbar icon through the DevTools protocol), with Settings changing all four beside it and a lock elsewhere;
a short window (175% zoom, a 320×320 panel) where the menu must scroll to its last line; and the lazy chunks taken away
from a private copy of the build (the menu's text, the menu's code, the add view) with the page's text still Chinese.
The visual guard (`visual-guard.spec.ts`) also probes the open menu in the popup (376 and 320 px) and the panel (320, 360,
420, 600 px), light and dark, English and Chinese, and walks the focus round it. `SK_SHOTS=<dir>` makes the spec save
screenshots.

Hand-made mutants, one at a time, run under the unit tests, the e2e spec and the build: the table is in §8.

## 6. Owner checks

OWNER-CHECKLIST item 22 (the menu in the real toolbar popup and the real side panel; the keyboard; both directions of
following; the narrow panel).

## 7. Open points

- The icon (§2, row 2) and the covered codes (§3) are the owner's to veto.
- The popup's `reload()` runs on every change of the settings record while the menu is open, twice for the menu's own, and
  in the panel three times. If that ever shows as flicker, the menu can skip it in the panel. `App.reload()` has no ordering
  (it never had): a late answer could draw an older `display` for a moment.
- Not done: the menu is not offered on the lock screen or the other screens (there is no list to change there);
  other Settings (lock rules, the icon's behaviour) are not in it, by design.

## 8. Hand-made mutants

Hand-made mutants, one at a time, each run under the unit files that touch the menu, the e2e spec (the e2e build rebuilt for
each) and, for the build rules, the build itself (a scratch runner, not part of the tree).

**Revision 1** (the first version): 39 mutants, all killed after one test was strengthened (L2, no pending state: the test
had looked at a radio the test itself had set). The kinds: a wrong preference key (5), not live (4), not synced with Settings
(7), hidden codes leaking (3), focus (5), listener leaks (3), manners (8), build rules (4).

**Revision 2** (after the independent review): the same mutants re-run on the revised code wherever their text still
applied, plus 14 new ones (R1 to R14): **53 mutants, 52 killed**, 44 by unit tests (76 failing tests in all), 33 by the e2e
spec (64 in all), 1 by the build alone. The review's three survivors are closed: **M5** (the settings page's listener never
removed) by a run-time test of `watchSettings` (R1), **M8** (the add view's chunk fails) and **M17** (the button's chunk
fails) by the e2e spec that removes each chunk from a private copy of the build (R3, R2). The new ones:

| Mutant                                                                                | Killed by                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| R4 a failed text chunk empties the page's own catalog (the first version's behaviour) | unit (failure test) and e2e (the page stays Chinese) |
| R5 no text: the menu draws nothing (a dead button)                                    | unit and e2e                                         |
| R9 the no-text dialog cannot take the focus (Escape never reaches it)                 | e2e                                                  |
| R13 the text falls back to nothing, not English, when this language's chunk fails     | unit                                                 |
| R6, R14 the menu's height ignores where it starts (as a script line, as a CSS rule)   | e2e (175% zoom and a 320×320 panel)                  |
| R7 no redraw after the write (a choice that changes nothing in storage stays pending) | unit and e2e                                         |
| R8 `aria-modal` dropped                                                               | unit                                                 |
| R10 the menu stays open when the popup goes to the add view                           | unit and e2e (a paste that opens the confirm page)   |
| R11 the settings page follows the theme only in Appearance                            | unit (source: one `followTheme()` at the entry)      |
| R12 the Chinese hint's "5 秒" may wrap apart                                          | unit                                                 |

The one survivor, **S7** (a pending choice is not dropped when the drawn settings catch up), is equivalent since the
write's own redraw drops it too; the effect stays for a redraw that arrives before the write settles, which looks the
same on screen. Two kinds of kill rest on one layer, worth knowing: the unit tests alone see a record reset to its defaults
(K4), a queue order (S6, O4), a listener count (LK1, LK2, R1), `aria-*` (O8, R8) and the Tab stops (F5); the e2e spec alone
sees what needs the real page (L4, O6, O7, R2, R3, R6, R9, R14).
