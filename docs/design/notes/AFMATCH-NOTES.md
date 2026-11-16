# AFMATCH notes: a name guess for 2 letters, and "Which account for this page?"

> **Round 2** (the maintainers, 2026-10-31): the Chinese line is 「用哪个账户登录 $1？」 (§2), and a guess of 2 no longer
> ticks the confirm page's "Show first on <host>" by itself (§1 item 1, `firmGuess`). The rest is round 1 as it was.
>
> **Round 3** (the independent review, verdict "mergeable", and its four suggestions, all taken): the remember sheet
> names a picked account's own sites above Save (AF-01, §1 item 3); the question wraps instead of being cut (AF-02); the
> sheet closes when its page or its account goes (AF-03); §3 and `docs/security/local-vault.md` say plainly how far
> "Remember" now reaches (AF-04); a first-frame test binds choosing to its page in the side panel (the review's K15).
> Merged as 24e3440.
>
> **Follow-up** (the round 3 review, verdict "mergeable", three suggestions; patch AFMATCH-FU against 24e3440): a sheet
> whose code loads while the side panel moves to another page opens nothing (R3-01, §1 item 3); tests now hold what the
> review's surviving mutants N1, N8 and N9 changed (R3-02, §4, §5); the warning says "Remember", the button's name, not
> "Save" (R3-03, the maintainers' text, §2).

**The report (the owner, 2026-10-30).** On `https://ws.g.pro/admin/` the popup showed no "This site" section and no
Fill button. The accounts came from Google Authenticator, so none has a site (`domains`). The issuer "ws" has 2
letters, and the name guess (`src/core/match.ts` nameGuess) needed 3, so nothing was even "Possibly related". The only
one-click way to register a site, "Remember: … belongs to this account", sits under related rows only; without a guess
the owner had to open the account's editor and use its Sites field.

## 1. What was built

1. **A guess for names of 2** (`src/core/match.ts`). An issuer that folds to exactly 2 ASCII letters or digits counts
   through the whole-label rule only: it must equal a label of the host other than the top-level one, never a punycode
   label, never on an IP host, never for an account with a usable registered domain. The run-together rule stays at 5
   characters or more, and 1 character never counts. As before, a guess is only ever "related", never "registered":
   nothing here can make an account "This site" or fill a page. "ws" is related on `ws.g.pro` and on
   `login.ws.example.com`; not on `example.ws`, `aws.amazon.com`, `news.example.com` or `w.s.example.com`.
   - **The confirm page's default (round 2).** Adding an account in the popup, "Show first on <host>" starts ticked
     when the new name is guessed for the page (it has no sites yet, so a guess is its only match). `firmGuess` in
     match.ts now holds that rule: a guess of 3 characters or more ticks it, as before; a guess of 2 shows the box
     unticked, so it lists the account as related without committing a site. Main passes it to the confirm page as
     `tickSite` (the prop was `related`, a name that no longer says what it does).
2. **The line "Which account for <host>?"** (`src/popup/main/model.ts` askHost, `List.tsx`, `Main.tsx`, `popup.css`,
   `scripts/i18n/afmatch.py`). Above the sections, one line with the weight of a section header (11 px, the headers'
   colours, no box), and a quiet button "Choose". Shown when the page's host could be registered (`canRegister`: an IP
   address or a name of 2 labels or more) and no account is registered for it (no "site" section). Not shown while
   searching, with no accounts, when locked (the list is not drawn), on pages that are not http(s), or on single-label
   hosts.
   - **Choose** puts the related rows' own button, "Remember: <host> belongs to this account", under every row. The
     button now says "Cancel" and ends it; so does Escape, which puts the focus back on the line's button and is not
     passed on to the browser. A search, another page, or the site being saved ends it too (`Main.tsx` `pickFor`, kept
     only while the line asks about the same page).
   - **Picking an account** opens the existing "Remember this site" sheet with its choices for this page, unchanged.
     Saved, the account moves to "This site", the line goes, and the Fill button appears as on any registered page.
   - **Keyboard and screen reader**: the row buttons are the related rows' very element (same class, label
     "Remember: <host> belongs to this account (<name>)", roving tabindex: only the selected row's buttons are in the tab
     order). The line's button is an ordinary button in the tab order before the list, `aria-describedby` the question.
   - **The side panel** draws the same list. The line follows the active tab: another tab ends the choosing and the
     line asks about that page (or goes); a tab the icon was not clicked on has no address, so no line.
   - The question wraps, never cut (round 3, AF-02; in round 1 it was cut with an ellipsis, which hid the end of a long
     host, the part one could register: `github.com.login-session-verify.at…`). The host comes last in both languages.
3. **Round 3** (`Remember.tsx`, `site.css`, `Main.tsx`).
   - **The sheet names the account's own sites (AF-01).** When the account picked already has usable registered sites
     (`usableDomain`; at most the first two, then "…", joined with ", " or "、"), one line right above the Remember
     button says so: "This account is already remembered for github.com. Remember only if this page is the same
     service." It is the dialog's `aria-describedby`. It warns and nothing more: the button, the choices and the default
     stay as they are. On a host nothing can be registered for (a shared suffix such as `github.io`) the sheet has no
     Remember button, so no warning either. Only the line's path can bring such an account to the sheet; a related one
     never has a site (match.ts stops guessing for it).
   - **The sheet closes with its page or its account (AF-03).** Before, in the side panel, a sheet opened on one page
     stayed open on another tab (with the first page's names), and on a tab with no address, or once its account was
     deleted elsewhere, it was not drawn but still held the list's keys and paste. `Main.tsx` now closes it when the
     page's host changes or its account is gone; any other reload of the vault, or another tab of the same site, leaves
     it open.
   - **The sheet opens only on its own page (follow-up, R3-01).** The first Remember loads the sheet's code (two lazy
     chunks). If the side panel moved to another page meanwhile, the closing above had already run, before the sheet
     existed, and the sheet then opened with the page left behind's names. `remember()` now checks the page again once
     the code is in (`siteNow`) and opens nothing if it changed; the related rows' Remember goes the same way.

## 2. Wording (the maintainers' decision, round 2)

| Key        | en                      | zh_CN                 | Bytes (en / zh) |
| ---------- | ----------------------- | --------------------- | --------------- |
| `siteAsk`  | `Which account for $1?` | `用哪个账户登录 $1？` | 21 / 27         |
| `sitePick` | `Choose`                | `选择`                | 6 / 6           |

Round 3 and the follow-up (the maintainers' text; the button is 记住 / Remember, so the warning names it, not "Save"):
`siteBound`, en "This account is already remembered for $1. Remember only if this page is the same service." (90 B), zh
「这个账户已记住 $1。确认这里也是它的网站再点“记住”。」 (78 B). It is in the popup's catalog: the popup's lazy
catalogs each serve a whole view (the View menu, the Fill button, the plugins), and one line in the remember sheet does
not earn one of its own.

"Cancel" is the existing `cancel`; the row buttons and the sheet are the existing `siteRemember*` texts. The host comes
last in both: the first example, `$1 用哪个账户？`, put it first, and on a long host the ellipsis cut the whole question.
Round 1 proposed `哪个账户用于 $1？`.

## 3. Limits, said plainly

- **"Remember" now reaches bound accounts, on any page (AF-04).** Before AFMATCH, "Remember" was only under related
  rows, and a related row never has a site of its own, so an account already registered somewhere could only get
  another site through the editor, which lists the ones it has. Choose puts "Remember" under every account, on every
  page no account is registered for, look-alikes included: on `github.com.attacker.io`, GitHub (registered for
  `github.com`, so not even related there) is three clicks from being remembered for it, and the sheet starts with the
  page's own host ticked (`github.com.attacker.io`; `com.attacker.io` and `attacker.io` are the other choices). Round
  3's warning covers exactly this path: the sheet names `github.com` above its Remember button. It warns; it does not
  block, hide the line on look-alikes (a guess at a page's shape, which misses `github-com.attacker.io` and homographs
  and would hide real sister domains), or change the default.
- **A guess of 2 is a weaker guess.** Second-level words of 2 letters (`co.uk`, `ac.uk`, `ne.jp`) are labels too, so an
  issuer "AC" is related on every `*.ac.uk` page. Related only lists the account apart; it never fills, and since
  round 2 it never ticks the confirm page's "Show first on <host>" either.
- A single-label host (`http://hr/`) is guessed for an issuer of 2 as for longer names (its only label counts), but
  cannot be registered, so it gets no line and no Remember.
- On a host that is itself shared (`github.io`) the line shows (its host has 2 labels); the sheet then says the name
  cannot be remembered, as it does from a related row. The table of shared names is not loaded until then.

## 4. Tests

- `test/unit/match.test.ts` "the name guess for a name of 2": whole labels (`ws.g.pro`, a deeper label, a folded
  "W.S.", the ASCII part of a mixed name, digits); not the top level (`example.ws`, `github.io`, `example.cn`); never run
  together (`aws.amazon.com`, `news.`, `wsx.`, `w.s.example.com`, `example.wsx`); not punycode (`wsü` is `xn--ws-…`); not
  IP hosts; not 1 letter; not for an account with a usable registered domain, still for one with an unusable one.
  `firmGuess` (round 2): false for "ws", "W.S." and "ws 后台" on `ws.g.pro`; true for "Hub" on `hub.docker.com` (3),
  "GitHub", and "Booking.com" run together; false with no guess, on an IP address and with no page.
- `test/unit/list-model.test.ts` askHost: shown with only guesses, with nothing guessed, with an account registered
  elsewhere, on an IP address; hidden with a registered match or a registered parent, while searching (results or
  none), with no accounts, on `localhost`, a single label, `chrome:`, `file:`, `about:` and no address.
- `test/unit/afmatch-dom.test.ts` (16 tests in round 1, 26 in round 3, 30 in the follow-up): Main and List drawn into
  `test/helpers/mini-dom.ts` over stand-ins for `chrome.*` and the service, the real "Remember this site" sheet, the
  Fill chunk a stand-in. The line's text and place (en, zh_CN), its button and `aria-describedby`; Choose puts the
  identical button (type, class, label, text, icon) under every row, roving tabindex as the copy buttons; Cancel; Escape
  (only while choosing, prevented, focus back); picking GitHub (not guessed) → the sheet with `ws.g.pro` (ticked) and
  `g.pro` → saved once → GitHub in "This site" with the Fill slot, the line gone, the choosing over; the sheet cancelled
  keeps choosing; hidden for a registered page or parent, while searching (also in the search's first frame, before any
  effect), with no accounts, on four unregistrable addresses; shown on an IP address; the side panel's tab change ends
  the choosing. Round 3: the warning for a bound account on `github.com.attacker.io` (text, `aria-describedby`, the
  three choices, Save enabled and saving), none for an account whose only stored site is unusable (`com`), none on the
  related path, two sites named, three named as two and "…" in Chinese (a duplicate and an unusable one left out); a
  failed save (the error, still choosing, nothing written); the sheet closed by another tab (then a letter goes to the
  search and Ctrl+V opens the confirm page), by a tab with no address (the arrows and paste work, and it does not come
  back with the page), and by its account deleted elsewhere; K15: the side panel's first frame on another unregistered
  page is not choosing.
- `test/e2e/afmatch.spec.ts`, real Chromium, the toolbar icon's own click (activeTab): the owner's case in the popup
  ("ws" imported from a Google Authenticator export pasted in Settings, page `ws.g.test/owner`): related, the line, no
  "This site"; locked: no line; unlocked: the line; Choose → Remember on all 3 rows → the sheet (`ws.g.test` ticked,
  `g.test`) → "This site", no line → the Fill button → filled with a valid code. And the side panel: choosing, another
  tab ("This site" there, no line), back: the line again, not choosing. `autofill-helpers.ts` gains the host
  `ws.g.test` and a `paste` option.
- `test/e2e/add-popup.spec.ts` (round 2), the popup over a stand-in active tab: "ws" pasted on `ws.g.test` shows "Show
  first on ws.g.test" unticked, and is added under "Possibly related" with no site; "GitHub" on `github.test` starts
  ticked and is added as "This site".
- `test/e2e/visual-guard.spec.ts` probes the line and the choosing in the popup (light and dark, both languages, focus
  ring) and the line in the side panel at 320 and 600 px. Its allowance for the 18 px `.remember` line now covers the
  states named "remember" in the panel as well. Round 3: a long look-alike of the site GitHub is registered for
  (`github.com.login-session-verify.attacker.io`), in the popup and the side panel at 320 and 600 px, light and dark,
  both languages: the question is not cut (`scrollWidth` ≤ `clientWidth`) and passes every probe; GitHub's sheet
  with its warning passes them too (popup, side panel at 320 px).

**Runs** (private copies, `nice -n 19`, the shared lock; e2e in a copy with the API port moved off 8787):
`python3 scripts/messages.py` (catalogs byte-identical on a second run), typecheck, build, check-dist, format:check,
notices:check: clean. Full unit run: 299 files, 4,601 passed, 4 expected fail, 1 skipped. e2e: `afmatch`,
`visual-guard`, `popup-text` 6 passed; `autofill1`, `autofill2` 48 passed; `autofill2-content`, `autofill2-sites`,
`autofill-engine`, `sidepanel`, `site`, `list`, `add-popup`, `quickview` 125 passed, 1 skipped (quickview's screenshots,
which only run with `SK_SHOTS` set). The line was also looked at in screenshots: popup and side panel (320 px), light
and dark, en and zh_CN, a short host and a long one.
Round 2: the same gates, clean; the unit tests of every file that names match.ts, the platform's autofill, the fill
shortcut, the autofill sites, Main, AddConfirm or Fill (35 files, 545 passed); e2e `afmatch`, `add-popup`, `sidepanel`,
`visual-guard`: 19 passed.
Round 3 (no shared code changed: match.ts is as in round 2): the same gates, clean; the unit tests of every file that
names match.ts, the popup's main screens, `_locales`, the catalog keys, check-dist or the popup's style sheets (64
files, 1,130 passed); e2e `afmatch`, `add-popup`, `sidepanel`, `visual-guard`: 19 passed.
Follow-up (against 24e3440; no shared code changed): the same gates, clean; the same 64 unit test files (1,134 passed);
e2e `afmatch`, `sidepanel`: 7 passed. `afmatch-dom.test.ts` has 30 tests: the warning right above the Remember button
(no element between), none on `github.io` with a bound account (no Remember button there), the sheet left open by
another account deleted elsewhere and by another tab of the same site, and the slow first load: Remember on ws.g.pro, the
side panel on zoom.example.com before the sheet's code is in (a stand-in that takes 300 ms), no sheet once it is in,
then zoom.example.com's own sheet from Zoom's Remember.

## 5. Mutants

Each applied alone; every one killed by a failed assertion, none by a timeout. M01–M25 and, from round 3, W1–W6, R1,
R2 and K15 against the unit tests (`mutants.py`, all rerun in round 3 and again in the follow-up); in the follow-up, F1
and the review's N1, N8 and N9 (`mutants-fu.py`). E1–E7 built into the e2e flavour against `afmatch.spec.ts` (the
popup test fails on an assertion; the side panel test may fail on a wait) and, for E5 and E6, the round 2 test in
`add-popup.spec.ts` (Playwright's `not.toBeChecked()`, an assertion); E7 against `visual-guard.spec.ts`.

| #   | Mutant                                                          | Killed by                                       |
| --- | --------------------------------------------------------------- | ----------------------------------------------- |
| M01 | the 2-letter rule applied to the top-level label                | match: not the top-level label                  |
| M02 | the 2-letter rule applied to the run-together rule              | match (5 tests, never run together among them)  |
| M03 | 1 letter guessed                                                | match: one letter is never enough               |
| M04 | the old minimum of 3                                            | match, DOM (7 tests)                            |
| M05 | IP hosts guessed                                                | match (2 tests)                                 |
| M06 | guessed despite a registered domain                             | match (3 tests)                                 |
| M07 | the line shown when a registered match exists                   | list-model, DOM (4 tests)                       |
| M08 | the line shown on an unregistrable host                         | list-model, DOM                                 |
| M09 | the line shown while searching                                  | list-model, DOM                                 |
| M10 | the line shown with no accounts                                 | list-model, DOM                                 |
| M11 | Remember on every row without choosing                          | DOM (6 tests)                                   |
| M12 | choosing adds no Remember                                       | DOM (6 tests)                                   |
| M13 | the button never says Cancel                                    | DOM (3 tests)                                   |
| M14 | no `aria-describedby`                                           | DOM                                             |
| M15 | the line never drawn                                            | DOM (9 tests)                                   |
| M16 | the button does not end the choosing                            | DOM                                             |
| M17 | Escape does not end the choosing                                | DOM                                             |
| M18 | Escape leaves the focus nowhere                                 | DOM                                             |
| M19 | Escape passed on                                                | DOM                                             |
| M20 | the choosing outlives the line (no reset)                       | DOM: a search ends the choosing                 |
| M21 | Main asks on every registrable page                             | DOM (5 tests)                                   |
| M22 | choosing not tied to the line's page (one stale frame)          | DOM: the search's first frame                   |
| E1  | the old minimum of 3                                            | e2e: `remembers` (ws not related)               |
| E2  | the line never drawn                                            | e2e: the question's text                        |
| E3  | choosing adds no Remember                                       | e2e: `remembers` after Choose                   |
| M23 | a guess of 2 ticks the site box again (`> 2` → `> 1`)           | match: too weak to tick "Show first on"         |
| M24 | a guess of 3 no longer ticks it (`> 2` → `> 3`)                 | match: the same test ("Hub")                    |
| M25 | the box ticked for any name of 3 or more, guessed or not        | match: the same test ("Zoom", IP, no page)      |
| E4  | the line shown when a registered match exists                   | e2e: no line after saving; in the panel too     |
| E5  | a guess of 2 ticks the site box again                           | e2e add-popup: "ws" box not ticked              |
| E6  | Main ticks the box whenever there is a page                     | e2e add-popup: "ws" box not ticked              |
| W1  | the warning for any account                                     | DOM: no usable site; the related path           |
| W2  | the warning never shown                                         | DOM: a bound account on a look-alike (+2)       |
| W3  | unusable stored sites counted (`com`)                           | DOM: no usable site; more than two              |
| W4  | every site named, not two then "…"                              | DOM: more than two                              |
| W5  | Save disabled by the warning                                    | DOM: Save still enabled                         |
| W6  | the warning not the dialog's `aria-describedby`                 | DOM: a bound account on a look-alike            |
| R1  | the sheet stays when the page changes                           | DOM: another tab; a tab with no address         |
| R2  | the sheet stays when its account is gone                        | DOM: the account deleted elsewhere              |
| K15 | choosing not bound to its page (`pickFor !== null`)             | DOM: the side panel's first frame               |
| E7  | the question cut again (the wrap rule removed)                  | e2e visual-guard: `scrollWidth` > `clientWidth` |
| F1  | a sheet whose code loads slowly opens on the page left behind   | DOM: the slow first load (follow-up, R3-01)     |
| N1  | the warning also with no choices (the review's)                 | DOM: `github.io` with a bound account           |
| N8  | the warning drawn below the buttons (the review's)              | DOM: right above the Remember button            |
| N9  | the sheet closed by any reload of the vault (the review's)      | DOM: another account changed elsewhere          |

## 6. Sizes (prod build, gzip as check-dist counts it, against 2e260d0)

| What                                           | 2e260d0         | Round 1         | Round 2         | Round 3         | Change (round 3)          |
| ---------------------------------------------- | --------------- | --------------- | --------------- | --------------- | ------------------------- |
| Popup (budget 61,440)                          | 57,116 B        | 57,359 B        | 57,416 B        | 57,478 B        | +362 B                    |
| – static (JS / CSS)                            | 52,681 B        | 52,895 B        | 52,952 B        | 52,982 B        | +301 (+258 / +43)         |
| – popup catalog zh_CN (counted) / en           | 4,435 / 3,751 B | 4,464 / 3,774 B | 4,464 / 3,774 B | 4,496 / 3,801 B | +61 / +50                 |
| Side panel (budget 63,488)                     | 59,349 B        | 59,590 B        | 59,641 B        | 59,703 B        | +354 B                    |
| The remember sheet's lazy chunk / `site.css`   | 833 / 613 B     | 833 / 613 B     | 833 / 613 B     | 993 / 653 B     | +160 / +40 (not counted)  |
| The change list's view with its text, en / zh  | 3,593 / 3,874 B | 3,620 / 3,903 B | 3,620 / 3,903 B | 3,620 / 3,903 B | +27 / +29 (no budget)     |
| A vault's page with every lazy catalog (zh_CN) | 15,170 B        | 15,170 B        | 15,170 B        | 15,170 B        | 0 (popup keys, no part)   |

The change list's view (`plugin-changes-*.js` and its style sheet, printed by check-dist with no budget) did not change
in content: its chunk is 6,787 B raw before and after; the shared chunk's identifiers were renamed by the minifier,
which moves its gzip by a few bytes (the review, AF-04).

Follow-up, against 24e3440 (= round 3): popup 57,482 B (+4: static +3, the zh catalog +1), side panel 59,708 B (+5),
popup catalogs zh_CN / en 4,497 / 3,800 B (+1 / −1; the new text is 9 B longer in zh_CN, 4 B in en), the sheet's chunk
993 B (unchanged), the rest as round 3.

No budget was changed.

## 7. A deliberate exception: "same sign-in" (TOTP autofill Stage 3, AF3-4)

`match.ts` stops guessing for an account once it has a usable registered site (§1 item 1, item 3: "a related one never
has a site"). AF3-4 makes one exception, on purpose, outside `matchTier`: an account registered for a site that Apple's
shared-credentials list says shares its sign-in with the page (an account for `twitter.com` on `x.com`; `chat.com`,
`chatgpt.com` and `openai.com` each other's) is listed under "Possibly related", with a line that names its own site
("Same sign-in as twitter.com"). The exception is stated in `match.ts` and here.

- **Why it is allowed when a name guess is not.** The relation is no guess from a name or a page's shape, which a
  look-alike page can imitate: it comes from a list Apple reviews, imported into the site rules' baseline with its hash
  pinned (`rules/`), shipped with each release only. A downloaded rules bundle can never carry it (the format refuses
  `aliases` in a live bundle), and the extension reads the package's baseline alone for it (the maintainers' C29).
- **What it does not do.** It is `related`, never `registered`: no "This site", no Fill button, nothing filled. "Remember"
  writes the page's host to the account, as from any related row, and the remember sheet then names the account's own
  sites above its button (round 3's AF-01 warning), as for a bound account picked through "Choose".
- **How narrow it is.** A host is at a member only when the two are equal once one leading `www.` is taken off each; a
  member's other subdomains are never offered (user-content hosts such as `*.fandom.com`), nor is an account registered
  for a subdomain of a member; never an IP address. One-way groups offer one way only (`twitter.com`'s account on
  `x.com`, never `x.com`'s on `twitter.com`).
- **The "Which account" line** shows beside such rows, as beside name guesses (the plan's N15).

Where it is built and tested: `docs/design/notes/AUTOFILL3-NOTES.md` §8.
