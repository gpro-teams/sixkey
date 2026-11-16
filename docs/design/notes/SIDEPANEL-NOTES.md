# The side panel mode

The owner asked for the side panel mode ("侧边栏模式") now. It was designed in the UX study (docs/research/ux-study.md
§2.1, decision table item 1, Q2) and parked until after the sync milestones (SYNC-DESIGN §9.1, cross-reference of
2026-10-16; now updated, 2026-10-20). Nothing in it depends on sync, and it changes nothing in sync.

Marks used below: **[measured]** seen in this package's runs (headless Chromium 156 from Playwright 1.64, macOS);
**[unverified]** not seen, inferred from documentation or from the UX study's notes.

Revision 2 follows an independent review (verdict: merge after fixes; no blocker, one major). §10 lists each finding
and what was done.

## 1. What it does

- **Settings › Appearance › "Clicking the icon opens": Popup / Side panel.** The default is Popup. The choice is a
  per-browser preference like the theme, but it is kept in `chrome.storage.local` (`sk_opener`: `"panel"`, or absent for
  the popup), because the service worker applies it and cannot read a page's `localStorage`. It is not part of the vault,
  of a backup or of sync. The row is hidden where the browser has no `chrome.sidePanel.open` (Chrome before 116, Firefox,
  Safari), and replaced by one line ("not offered in a shared profile") in a profile declared shared. The stored choice
  is kept there, and comes back if the profile is declared single-person again.
- **The popup's header gets "Open in side panel"** (`#open-panel`), in a single-person profile where the API exists. It
  opens the panel in the popup's window and closes the popup.
- **The side panel** is a page of its own, `sidepanel/index.html`, drawing the popup's screens (welcome, lock screen,
  list, add, confirm, edit, remember) in a column the user can resize, as tall as the window. Only the list scrolls.
- **Switching applies at once**, without reloading anything: the worker listens to the two keys it reads.
- **The keyboard shortcut** `_execute_action` (Alt+Shift+K) opens whatever the icon opens: with no popup set, Chrome
  delivers it as a click to `action.onClicked` (Chrome's commands documentation). Chrome's sidePanel page lists "a
  keyboard shortcut" among the user interactions `open()` accepts ("An action click, A keyboard shortcut, A context menu,
  A user gesture on an extension page or content script"); headless Chromium does not enforce the rule at all, so it is
  still an owner check in branded Chrome.
- **The View menu** (QUICKVIEW-NOTES.md), the search field's button, is in the panel as in the popup: the four Appearance
  choices, applied at once. The panel follows a change made in Settings (its guard reloads on the settings record, and its
  entry follows the theme), which is where "Settings changes show in an open page" is tested.

## 2. How it is opened, and why so (`src/platform/action-mode.ts`)

- **Panel mode = `action.setPopup({popup: ""})` and `sidePanel.open({windowId})` in `action.onClicked`.** The side panel
  API's own "open on action click" behaviour is not used: the UX study measured that a panel opened that way gets no
  `activeTab`, so "this site" and "Scan QR code on this page" stop working in it (E2). check-dist fails a build in which
  any shipped file names that behaviour, and a source rule does the same for `src/`.
- **The click handler calls `open()` at once**, in the listener, with no read or await before it (`open()` "may only be
  called in response to a user action", Chrome 116+). It calls `setOptions({path, enabled: true})` right before it, not
  awaited, so a panel path the browser lost is set again; that the two calls reach the browser in that order is
  inferred from how extension calls are sent [unverified].
- **No `side_panel` manifest key.** With a `default_path` the browser would offer Sixkey in its own side panel menu from
  install, in every profile. Instead the worker enables the page (`setOptions`) only for a single-person profile, at
  every start and at every change, and disables it in a shared one.
- **Re-applied at every worker start**, before anything else that waits: `src/background/action-first.ts` is the worker's
  second import, right after the storage access level. Its body adds the click and change listeners and starts the one
  read of `sk_opener` and `sk_settings`, synchronously; scripts/sw-order.mjs checks the BUILT worker for exactly that
  order (check-dist). Whether Chrome keeps `setPopup("")` and the panel options across a browser restart is not
  documented [unverified]; the worker runs at browser start (it listens to `runtime.onStartup`), so a click before it
  has applied can at worst open the manifest's popup once.
- **Fallbacks, for the clicked tab only.** A panel that will not open (an exception, a refusal, no API) gets the popup
  in that tab: `setPopup({tabId, popup})`, then `action.openPopup({windowId})` where it exists (Chrome 127+; on 120 to
  126 it is for policy-installed extensions only, so there the next click on that tab opens the popup), and one line in
  the diagnostics log. The other tabs and windows keep the panel, and the stored choice is untouched. A tab-specific popup
  lasts until that tab is closed [Chrome's action documentation]. A click that arrives while an apply is switching to the
  popup (a change being applied) also gets the popup in that tab, with no diagnostics line.
- **Windows without a side panel.** `open({windowId})` resolves for a popup-type window although no panel appears
  [measured by the review, headless Chromium 156]. So after `open()` resolves the worker reads the window's type
  (`windows.get`, no permission) and gives that tab the popup in anything but a normal browser window (popup, app/PWA
  windows). Whether the icon or the shortcut can be used in such windows at all is an owner check.
- **The panel's page is enabled in the click only on a known plan.** A worker woken by the click has not read the profile
  yet; it opens the panel without touching the page's options (the last apply left them), so a shared profile's disabled
  page is never enabled on a guess.
- **From the popup** the button calls `sidePanel.open()` in its own click handler, with the window ID from the active tab
  the popup already read, then closes the popup. It does not go through the worker: whether a user action survives
  `runtime.sendMessage` is not documented [unverified]. In the headless runs `open()` from a page also worked without a
  click (Playwright's evaluate) [measured], so the gesture rule itself could not be tested there.
- **A shared profile**: the worker sets the popup and disables the panel's page; the panel's page reads the profile
  before it draws anything and closes itself (draws nothing) if it is shared, and closes itself when the profile becomes
  shared while it is open (`src/sidepanel/guard.ts`). With the page disabled, `sidePanel.open()` is refused ("No active
  side panel for windowId") [measured].

## 3. Locking: a page that stays open (`src/sidepanel/guard.ts`)

The UX study and SYNC-DESIGN ask that the panel be treated like the settings page: a 15-minute idle cap, the key
dropped when it closes, and no panel in the "shared / automation" preset. As built:

- **Idle cap.** Sixkey locks after 15 minutes (`ALWAYS_MODE_MAX_IDLE_MINUTES`, the settings page's ceiling) in which the
  unlocked key's record of activity did not move, whatever the automatic lock allows (60 minutes, or "when the browser
  restarts"). A shorter automatic lock still applies through the worker's alarm, as before.
  - **"Used"** in the panel is the user's own input there: `pointerdown`, `keydown`, `wheel`, `touchstart`. Not focus, not
    a pointer moving over it, not the panel's reloads, not the codes' tick, not changes made elsewhere. Input moves the
    record (`touch`, at most once every 30 s). Other pages move the same record only where they call `touch`: opening the
    popup, a settings page loading the vault (each reload). Typing or scrolling in a settings tab does not, so with a
    long automatic lock a panel left open can lock a settings tab that is in use without reloading (the review's M7b; the
    settings page's own ceiling in "lock every time" is the same 15 minutes). An idle panel in one window does not lock
    a panel in use in another.
  - **The popup's "every load is use" is not the panel's**: App's touch after each load would, in a page open for hours,
    keep moving the deadline (and the worker's alarm) every time something elsewhere reloaded it. In the panel, App calls
    the panel's `shown` instead, which only asks the worker to re-arm its alarm for the key as it is.
  - **The clock** is read every 10 s, hidden or not, and when the panel is shown again or focused, so a timer that a
    hidden page or sleep held back delays the lock only to the next tick (Chrome's intensive throttling checks a hidden
    page's timers once a minute: a lock up to about a minute late). A backward change of the system clock delays the
    lock by the size of the jump, as it does the service's own expiry; a forward one locks early, which is safe. Storage is read only once the deadline seen at the last read
    has passed (one read per 15 minutes in the steady state).
  - **The lock** is the soft lock, the same as the idle timer's (QUICK-PIN-NOTES §2): the key goes from every page and
    the lock epoch moves on; a live PIN stays and reopens Sixkey. A sheet or dialog open at that moment goes with the list
    (the lock screen replaces the whole screen) [measured, e2e with Playwright's clock].
  - **"Lock every time"**: the key lives only in the panel's memory (RoutedSession). The cap drops that key only
    (`RoutedSession.forget()`), with no epoch, so another window's panel with its own key, or a settings tab, does not
    lock. That is what closing the popup does in that mode.
- **Close.** Closing the panel ends its page and everything in its memory. On `pagehide` it drops its own key first
  anyway, in case the browser keeps the page (a page shown again from the back/forward cache reloads). A key in shared
  storage (the idle and browser-restart modes) stays, as it does when the popup closes; the automatic lock and the idle
  cap end it. Decision: parity with the popup and the settings page rather than a global lock at close, which would lock
  every other page whenever the panel is closed.
- **Lock from anywhere** (Lock now in the popup or the panel, Alt+Shift+L in the worker, the idle alarm, the screen lock)
  bumps the lock epoch, and the panel drops the list at once: App's own listener, the same as the popup's [measured, two
  windows].
- **Unlock elsewhere**: when the shared key appears (`sk_session` in `chrome.storage.session`), a panel used in the last
  5 minutes (`FOLLOW_UNLOCK_MS`) opens the list at once [measured]; a panel left alone (another window, a screen shared
  with others) stays on its lock screen until the user's next input in it, and then shows the list without a password.
  The review's case: an unlock in one's own window must not show the codes on a second, projected window by itself. In
  "lock every time" there is no shared key, so nothing follows. A commit or a settings change elsewhere reloads the list
  (`sk_active`, `sk_settings`), so the panel never shows a stale vault.
- **The lock screen in a page that stays open**: a password, PIN or recovery key typed there, or a Show box ticked, is
  wiped after 2 minutes without input in the panel (`LOCK_SCREEN_WIPE_MS`) and when the panel is hidden: the page is
  drawn again from storage, which empties every field and unticks every box (it holds no key on its lock screen)
  [measured, e2e]. A popup would have closed at the first click elsewhere.
- **Focus**: in the panel the lock screen focuses its field only while the panel has the focus (`document.hasFocus()`),
  so a lock that comes while the user types digits into the web page cannot pull them into the PIN field, which submits
  itself at the PIN's length. Whether Chrome would move keyboard focus to an unfocused side panel at all is unverified;
  this makes the question moot for the PIN.
- **Unchanged**: the PIN rules, the soft and hard locks, the lock screen. The panel's lock screen is the popup's
  (`Locked.tsx`): the master password is never shown there (`showable={false}`), the recovery key has its Show box.

## 4. The current site in the panel

- The click that opens the panel grants `activeTab` for the clicked tab: the panel reads its address [measured: the
  panel's `tabs.query` returned the URL of the tab `Extensions.triggerAction` clicked].
- On a tab change (`tabs.onActivated`), a load in the active tab (`tabs.onUpdated`, status complete) and a new click on
  the icon (the worker writes `sk_action_click` to `chrome.storage.session` after `open()`), the list reads the active tab
  again. A tab the icon was not clicked on has no address: no site section [measured]. Back on the clicked tab the
  address is readable again [measured], as E2 found. No `tabs` permission.
- **The hint** (built in revision 2, the minimal form of the UX study's greyed card): on such a tab one line,
  "Click the Sixkey icon on this tab to match its site and scan it.", stands under the search, where "this site" would
  be, on the list and the add view, and so above "Could not capture this page" when a scan fails there [measured, e2e].
  It is the panel's own code (`src/sidepanel/main.tsx`, `panel.css`); its one string is in the popup's catalog. activeTab
  survives a same-origin navigation of the clicked tab and is lost after a cross-origin one (an SSO redirect, for
  example) [measured by the review]: the hint covers that case too.
- **Adding an account remembers the site the user was on when the confirm page opened** (review J1). In the popup the
  site never changes; in the panel the active tab can change while the confirm page is open, and before revision 2
  "Show first on <site>" followed it, so a tick given on one site saved another. The host is now captured when the
  confirm page opens (`Main.tsx`, `adding.host`) and used for its label, its default and the saved domain [measured,
  e2e: ticked on github.test, switched to other.test and its icon clicked, Add: github.test saved, other.test not]. The
  edit dialog keeps the live site: what it adds is a chip the user clicks, showing the site it adds. The "remember"
  sheet's choices are fixed when it opens.

## 5. Permissions, policies and checks

- **`sidePanel`** is added to the manifest's `permissions` (base and e2e overlays): no install warning (Chrome's
  permission list, ux-study C3). It is required, not optional: the click opens the panel itself, and an optional
  permission's prompt would need a user action of its own. check-dist's whitelist (`PERMISSIONS`) adds it with a comment;
  `test/unit/sidepanel-check-dist.test.ts` shows that leaving it out, putting it in the optional list instead or as well,
  adding `tabs` or `scripting`, and a `side_panel` key each still fail.
- **Unchanged**: no host permission, the CSP and every page's own `connect-src 'none'` (the panel's page has it; check-dist
  checks every page), the storage access level (TRUSTED_CONTEXTS), no content scripts, the privacy statement's claims
  (no network; the reviewer key list in PRIVACY.md gained `sk_opener` and `sk_action_click`).
- **Sender policy** (`src/platform/sender-policy.ts`): a new surface `sidepanel` at exactly `/sidepanel/index.html`, a
  sender of exactly the popup's three messages (`sk-reschedule-autolock`, `sk-sync-soon`, `sk-clip-arm`), no others; the
  table stays exhaustive (no new message type). In a real panel the worker saw `sender.url` at that path, `sender.origin`
  the extension's, and **no `sender.tab`** [measured, headless Chromium 156]; a panel URL with a web tab, a web origin, a
  suffix or the wrong case is refused (autofill-pre-sender.test.ts).
- **The worker's storage listener**: the source rule "storage.onChanged is never listened to by the worker" gained one
  deliberate exception, `platform/action-mode.ts`: it takes only the names of two keys from the change and then reads both
  itself, as at every start; a source rule checks it never reads a change's value.
- **check-dist** also: the panel's page exists (the worker names it, not the manifest), declares both colour schemes and
  runs theme-boot.js first like the popup; the panel loads the popup's catalogs, one per language, and no settings or
  Sync catalog, and preloads none; the panel has its own enforced budget (§6); the built worker's third to fifth calls are
  the click listener, the change listener and the read of what the icon opens.
- **What `sidePanel` is used for:** only to show Sixkey's list in the browser's side panel when the user turns that on
  in Settings › Appearance (off by default; the toolbar popup is the default), so codes stay visible while typing them
  into a page. The permission itself is required, not optional; what is off by default is the setting. The permission
  table in docs/security/local-vault.md says the same. There is no in-extension "permissions explained" page.

## 6. Bundles and budgets

The panel and the popup share their code: both entries call `boot()` (`src/popup/boot.tsx`), so each entry chunk is a
call (70 B gzipped for the popup), and the screens are one chunk. A first try with two full entries cost the popup 209 B
of entry overhead; the shared boot brought that to 78 B. The panel's own code (its entry, `guard.ts`, `panel.css`) is in
the panel's chunks only, and the code it shares with the settings page (`action-mode.ts`) is a small chunk of theirs,
never the popup's: the popup's button imports nothing of it (it opens the page the worker enabled).

| Store build, gzipped bytes (check-dist's measure) | Before | Revision 1 | Revision 2 | Budget | Headroom |
| ------------------------------------------------- | ------ | ---------- | ---------- | ------ | -------- |
| popup, release gate closed                        | 58,672 | 58,984     | 59,065     | 61,440 | 2,375    |
| popup, release gate open                          | 59,514 | 59,820     | 59,902     | 61,440 | 1,538    |
| side panel, release gate closed                   | -      | 60,451     | 60,980     | 63,488 | 2,508    |
| side panel, release gate open                     | -      | 61,291     | 61,819     | 63,488 | 1,669    |

- The popup grows by 393 B (gate closed) / 388 B (gate open) in all: the split's overhead (78), the header button and its
  handler, the surface seams in App, Main, the lock screen and the way to the settings page, the tab watch hook, the
  confirm page's captured site (revision 2), `RoutedSession.forget`, one icon, and two catalog strings (`openPanel`;
  `panelTabHint`, the panel's hint, which the popup's catalog carries because the panel loads that catalog: about 50 B
  in zh_CN). The gate-open headroom stays above the 1,500 B asked for, by 38 B: the next popup feature has little room.
- **The panel's budget** (`PANEL_BUDGET_GZ`) is the popup's budget plus 2 KB for the panel's own code, so that code
  cannot grow unseen while the popup has room. Enforced in the store build, as the popup's, and counted with the larger
  catalog the panel loads (a test pads the panel by less than the catalog and expects the failure). The panel's own code,
  measured as the difference between the panel's and the popup's totals: 1,917 B (gate open), 1,915 B (gate closed;
  revision 1: 1,471 and 1,467).
- **Text**: the panel's modules are read by the popup's key collector (`POPUP_PAGES`), so the one key only the panel uses
  (`panelTabHint`) is in the popup's catalog and counted there. The Appearance row's five strings, and three lines
  rewritten to cover the panel (`lookShortcutBody`: the shortcut opens what the icon opens; `lookLead`; `lookHide`, which
  the Security mode box shows too and so is in core), are in the settings catalogs: `general` 1,525 of 3,072 B (zh_CN;
  was 1,343), `core` 3,471 of 5,120 (was 3,462). Loaded together: with a vault 9,962 of 12,288 B (was 9,817), every part
  10,485 (was 10,339), with no vault 4,116 (was 4,106). No limit was raised.

## 7. What could not be tested, and what is unverified

- **Real browsers, real input**: the e2e suite drives a real side panel in headless Chromium 156 through the DevTools
  protocol: the action click (`Extensions.triggerAction`, with `--enable-unsafe-extension-debugging`), the popup's
  button, `activeTab`, tab changes, a second window, locks and unlocks elsewhere, the shared profile, the sender. Not
  covered, owner checks (docs/OWNER-CHECKLIST.md item 18): branded Chrome, the real toolbar button and the real
  Alt+Shift+K and Alt+Shift+L keys (the commands' user-action status for `open()`), the panel's look at the browser's
  real widths and resizing, the clipboard clearing from the panel, a browser restart, Chrome's own side panel menu.
- **The idle cap** is tested with fake timers (unit) and with Playwright's clock on the panel's page in a tab (e2e, a
  sheet open); not in a real side panel over 15 real minutes.
- **The user-action rule itself**: headless Chromium does not enforce it (`open()` resolved even from a script, for the
  implementer and the reviewer alike), so no automated run shows that the action click, the shortcut, or **the first
  click after the worker has stopped** (it stops after about 30 s idle, so that is most clicks) opens the panel in
  branded Chrome. Chrome's sidePanel page lists the action click and the keyboard shortcut among the accepted user
  interactions. The review measured that a click wakes a stopped worker, reaches the listener in time and finds
  `setPopup("")` still set. Owner check, the most important one (OWNER-CHECKLIST item 18).
- **Chrome's side panel switched to another entry and back** (Reading list, Bookmarks): whether Chrome keeps Sixkey's
  page alive meanwhile is unverified. If it does, "lock every time" does not lock at that "close" (the idle cap and the
  lock-screen wipe still apply). Owner check.
- **Focus**: whether a script `focus()` in an unfocused side panel can take keyboard focus from the web page is
  unverified; the lock screen no longer calls it while the panel is unfocused (§3). Owner check with a PIN.
- **Popup-type and app (PWA) windows**: handled by the window-type check (§2), unit-tested; a click there could not be
  driven headless (the reviewer's attempt closed the browser). Owner check.
- **Persistence**: whether `setPopup("")` and the panel options survive a browser restart [unverified]; re-applied at
  every worker start anyway.
- **Chrome 156 force-closing popups for security dialogs** (ux-study item 6, C7) applies to popups; whether it applies to
  side panels is not documented [unverified]. Nothing in the panel opens a security dialog today; a future WebAuthn
  unlock should be tried in the panel before relying on it.
- **Edge, Brave, Opera, Vivaldi** (documented in ux-study §2.1, not tested here): Edge uses `chrome.sidePanel` and has a
  known issue that the panel does not reappear when switching back to its tab; Brave has the API but no entry in its own
  side panel, so only the icon opens it; Opera supports it from 135; Vivaldi 7's `setOptions` is buggy [all as the UX
  study transcribed them]. Where `open` or `setOptions` is missing, the setting is hidden and the popup stays.
- **A profile where the API throws**: handled by the fallbacks (§2) and unit-tested with fakes; not seen in a browser.
- **Whether a real panel's sender ever carries `tab`**: not in headless Chromium 156 [measured]; a `tab` whose URL is one
  of Sixkey's own pages is accepted too, so only a web tab would refuse the panel's messages (the clipboard would not
  clear: owner check), nothing worse.
- **Not testable here, or equivalent** (two of the review's surviving mutants): the reload of a page shown again from the
  back/forward cache (`pageshow` with `persisted`) cannot be produced for a side panel in these runs, and side panels are
  not put in that cache in practice: the reload stays as a guard, untested. Dropping `due = 0` on a session change is
  equivalent: `due` only ever defers a read until a time no later than the real deadline, so a stale value costs one
  read, never a missed lock.

## 8. Tests and mutants

- Unit: `test/unit/sidepanel-mode.test.ts` (the plan, the order of the calls, the worker's start, listeners, click,
  the per-tab fallbacks and the window-type check, the real worker over fakes, source rules including the lock screen's
  guarded focus), `test/unit/sidepanel-guard.test.ts` (the idle cap with fake timers in each lock mode, input, pointer
  moves and throttling, other pages' use, hidden and sleeping timers, the lock-screen wipe, close, following changes and
  unlocks, the shared profile, the active tab and the hint), `test/unit/sidepanel-check-dist.test.ts` (one real store
  build altered one rule at a time), and deliberate updates to `autofill-pre-sender.test.ts` (the new surface and rows,
  hostile panel senders), `autofill-pre-source-rules.test.ts` (the worker's one storage listener, the panel's
  `sendMessage`), `quick-source-rules.test.ts` (the permission list), `i18n-popup.test.ts` (the catalog loaded by
  `boot.tsx`), `m5-check-dist-tamper.test.ts` (the page list) and `test/helpers/sw-world.ts` (the toolbar and side panel
  fakes). `test/e2e/harness.ts` is unchanged (it is frozen); the driven profile has its own launcher
  (`test/e2e/panel-helpers.ts`).
- e2e: `test/e2e/sidepanel.spec.ts` (five tests, two of them in a real side panel), `smoke.spec.ts` and
  `install-source.spec.ts` (the permission list), and the visual guard (`visual-guard.spec.ts`) probes the panel's list
  and lock screen, and the list with the hint line shown, at 320, 420 and 600 px, light and dark, in English and Chinese.
- Mutants: 48 hand-made mutants, each applied alone, the named tests run, the file restored; all 48 killed.
  - Revision 1 (29): the idle cap removed, made 30 minutes, counted from the panel's own input only, fed by the panel's
    reloads, not moved by input; the key not dropped at `pagehide`; `forget()` dropping nothing; the "lock every time"
    idle lock bumping the epoch for every page; the panel offered in a shared profile (the worker's plan) and the page
    ignoring a switch to shared; the sender row missing, the surface's path missing, a row too wide (`sk-api` from the
    panel), a path matched by prefix; the open-on-click behaviour used; no apply at the worker's start; no apply on a
    change; the panel as the default; a read awaited before `open()`; no re-read of the tab after a click; `sidePanel`
    moved to the optional permissions; check-dist without the panel's budget, with `tabs` allowed, without the
    open-on-click tripwire; and in e2e, the panel's page drawing in a shared profile, the popup's button and the
    Appearance row in a shared profile, no tab watch. One more, `showable` true on the lock screen, is killed, but by two
    older source rules (`enroll-v2.test.ts`, `password-entry-service.test.ts`), not by the panel's tests (the review's
    correction).
  - Revision 2 (19, §10): R01 the confirm page following the live site (e2e); R02 to R05 the lock-screen wipe removed,
    made 20 minutes, not on hiding, a no-op in the page (e2e); R06, R07 the hint never shown, never drawn (e2e); R08 to
    R12 the review's survivors N1, N2 (e2e), N4 (e2e), N10b, N11; R13, R14 the global fallback, no window-type check;
    R15, R16 every panel following an unlock, a left-alone panel never following; R17 the lock screen focusing in an
    unfocused panel (a source rule: focus routing cannot be driven headless); R18, R19 the nits N-2 and N-1.

## 9. Points for the owner

None blocks the change; each is how it is built, and can be changed in one place.

1. **The panel is offered in Chrome's own side panel menu in a single-person profile, in popup mode too** (the worker
   enables its page whenever it is offered, so the popup's button can open it without a race). The alternative is to
   enable it only in panel mode and have the popup's button enable it just before `open()`.
2. **The idle cap is a soft lock of Sixkey, not of the panel alone**, also in the "when the browser restarts" mode: a
   lock of the panel alone would not be a lock while the key is in shared storage (reopening the panel would show the
   list again). It only fires when the key's record of activity has not moved for 15 minutes (§3: input in the panel, the popup
   opening, a settings page loading the vault).
3. **Closing the panel does not lock a shared key**, as closing the popup does not (§3). "Lock every time" does lock at
   close, by construction. SYNC-DESIGN's cross-reference said "关闭即丢弃 VK" (drop the VK at close) without that
   condition; its 2026-10-20 note now states the deviation. **Your explicit yes is asked here.**
4. **The panel's budget**: the popup's plus 2 KB (63,488 B), proposed from the measurement in §6.
5. **The site hint** (revision 2, the review asked for it; §9.5 was "not built"): built in its minimal form, one line
   (§4).
6. **An unlock elsewhere opens the list at once only in a panel used in the last 5 minutes** (revision 2, the review's
   M6). The alternative is the revision 1 behaviour, every locked panel follows every unlock, which shows the codes on a
   second (perhaps projected) window by itself.
7. **Lock-screen secrets are wiped after 2 minutes** without input, and when the panel is hidden (revision 2, M1).

## 10. Revision 2: the independent review, and what changed

The review (2026-10-20) found no blocker and one major issue; its report is not part of the tree. Each finding:

| #       | Finding                                                                                                                           | Done                                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1      | The confirm page's "Show first on <site>" followed the active tab: ticked on one site, a tab change and Add saved another (measured) | The site is captured when the confirm page opens and used for its label, its default and the saved domain (§4). e2e in the real panel; mutant R01                                                                                                |
| M1      | A password, PIN or recovery key typed on the panel's lock screen, Show ticked, stayed on screen indefinitely                     | Wiped after 2 minutes without input and when the panel is hidden (§3). Unit and e2e; mutants R02 to R05                                                                                                                                          |
| M2      | On a tab the icon was not clicked on, the confirm page lost its site box                                                          | Fixed with J1: the captured site stays                                                                                                                                                                                                           |
| M3      | On such a tab "this site" vanished silently and a scan said only "Could not capture this page"                                   | The one-line hint (§4). Unit and e2e (its place under the search); mutants R06, R07                                                                                                                                                              |
| M4      | Seven surviving mutants                                                                                                           | N1 (pointer moves counted as use), N2 (every load counted as use), N4 (Settings closing the panel), N10b (the panel's total without its catalog), N11 (no check while hidden): a test each, mutants R08 to R12. N5 untestable, N6 equivalent (§7) |
| M5      | One failing `open()` switched every window to the popup; in a popup-type window `open()` resolves and nothing shows               | The popup for the clicked tab only, the choice untouched; the window's type checked after `open()` (§2). Unit; mutants R13, R14                                                                                                                  |
| M6      | An unlock anywhere opened the list in every locked panel                                                                           | At once only in a panel used in the last 5 minutes; others at their next input (§3; owner point 6). Unit; mutants R15, R16                                                                                                                       |
| M7      | SYNC-DESIGN said "drop the VK at close" was implemented as intended; "neither the panel nor any other Sixkey page was used" overstated | SYNC-DESIGN's note states the deviation (owner point 3); the idle wording says what moves the record of activity (§3, the guard, local-vault.md, ARCHITECTURE.md)                                                                                |
| M8      | "Optional and off by default" beside a required permission                                                                       | Reworded (§5, SYNC-DESIGN §7, local-vault.md)                                                                                                                                                                                                    |
| N-1     | A click during an apply's switch to the popup logged a failure                                                                    | No diagnostics line on that path; mutant R19                                                                                                                                                                                                     |
| N-2     | A worker woken by the click enabled the panel's page before reading the profile                                                   | Only on a known plan that offers it (§2); mutant R18                                                                                                                                                                                             |
| N-3     | Appearance's lines named the popup only                                                                                           | The section's lead, "Hide codes …" and the shortcut's line now name the side panel too. The row's appearance after a read (a small shift) is unchanged                                                                                          |
| N-4     | The popup's button: a generic error, and nothing if the tab read has not answered                                                 | Not changed: the popup's budget has 38 B of room above the 1,500 B asked for                                                                                                                                                                     |
| N-5     | The icon does not close an open panel (the API's own behaviour toggles)                                                           | Not built: `sidePanel.close()` needs Chrome 141; a follow-up if wanted                                                                                                                                                                           |
| N-6     | A backward clock change delays the cap                                                                                            | Documented (§3); the service's own expiry behaves the same                                                                                                                                                                                       |
| N-7     | A switch to shared and back resumes panel mode                                                                                    | Kept, documented (§1)                                                                                                                                                                                                                            |
| N-8     | The shortcut's user-action status is documented by Chrome                                                                         | Cited (§1, §7); still an owner check                                                                                                                                                                                                             |
| A4, B   | Owner checks: the first click after the worker stops, digits typed into a page while the panel locks, switching Chrome's side panel to another entry and back, PWA windows | Added to OWNER-CHECKLIST item 18; the lock screen's focus is now guarded (§3)                                                                                                                                                                    |

The review also noted that the `showable` mutant on the lock screen (revision 1's notes counted it among the panel's) is
caught only by two older source rules, `enroll-v2.test.ts` and `password-entry-service.test.ts`, not by the panel's own
tests: §8 says so now.
