# A shorter, planned settings page

The owner's complaint (a screenshot of the settings page, 2026-10-21): the page is far too long, because every feature
added a card to the one column. Then, after the first version (one section of nine at a time): "the settings are still
heavy to think about; plan the functional areas as tabs". Goal: short and calm, no feature removed, no complexity added.
Nothing here changes what Sixkey stores, derives, sends or wipes; it changes which parts of the page are on the screen
at once, and where the page keeps what must not be lost when the person moves.

Revisions 3 and 4 follow the review's two re-verifications (§8, "Revision 3", "Revision 4"). Revision 2 follows an
independent review (verdict: merge after fixes; one blocker, two major). §8 lists each finding and what was done. One claim of the first version was false and is corrected here: "no assertion was weakened" (§7).

## 1. The plan: five groups, one leaf at a time

The rail has five groups. A group is one page, or has a few leaves, shown as a row of links under the page's title.

| Group (rail, hash) | Leaves (hash) | What is in them |
| --- | --- | --- |
| **Accounts** `#accounts` | **Add account** `#add`, **Backup** `#backup`, **Trash** `#trash` | the ways in; the backup, the restore and the exports (Export selected accounts is a fold); the recycle bin |
| **Security** `#security` | **Locking** `#security`, **Password & recovery** `#security-keys`, **Security record** `#security-log`, **Autofill** `#autofill` | the two modes, auto-lock, the codes settings and the PIN (and, for a device-key vault, the box that turns a master password on); the master password, a new recovery key, a new key; the record and what Sixkey keeps in this profile; the sites code suggestions are turned on for (AUTOFILL2-NOTES.md §7) |
| **Appearance** `#appearance` | one page: Appearance, with the **Clipboard** panel (`#clipboard`) | theme, what the toolbar icon opens, rows, order, hidden codes, the shortcut; clearing the clipboard |
| **Sync** `#sync` | one page (only where the build has the sync interface) | unchanged |
| **Advanced** `#advanced` | one page: Advanced, with the **Guide** panel (`#guide`) | the clock, diagnostics, starting over; the guide for antidetect browsers and agents |

Why this split. An owner looks first for: is my vault safe and backed up (the rail's status card, always there), add
accounts, back up, when it locks. Security is split by how often and how dangerously it is touched: locking is changed
now and then; the keys are rare and destructive; the record is read-only. Clipboard is one toggle and Guide is help text:
they are panels of a page, not pages. The names are the page's existing words (Accounts, Security, Appearance, Sync,
Advanced; Add account, Backup, Trash), so the paths the texts name ("Settings › Security › Security mode", "Settings ›
Backup", "Settings › Advanced") stay true; two new words (Locking, Password & recovery) name the two new leaves.

The place for the autofill settings was reserved here as a panel of the Appearance page (the group is named for what the
person sees in the popup and when copying). AUTOFILL2 patch 2 made it a fourth leaf of Security instead, **Autofill**
`#autofill` (`AUTOFILL2-NOTES.md` §7.3 P2-5): the Appearance page is already near the 1,350 px a leaf may have (§6), and
a row of leaf links over it would push it over too.

Two levels of links only where a group needs them (Accounts: three leaves; Security: three, and Autofill since AUTOFILL2
patch 2); the other three groups are one page, so there is no second bar for them. The leaves are plain links with the address as the choice, not an ARIA tablist:
they are navigation with their own addresses (no arrow-key handling to maintain). The group's link is
`aria-current="true"` when the group has leaves, `"page"` when it is one page; the shown leaf's link is `"page"`.

At 320 px the five groups wrap into a grid of two or three per row, and the leaves wrap below the title: nothing scrolls
sideways (it was nine chips in one scrolling row, two and a half in view).

## 2. How the address works (`src/options/route.ts`)

One leaf is on the page. The hash is the choice; Back and Forward follow; nothing rewrites it on load (parts of the page
read it themselves). A hash names a leaf by itself (`#security-log`), by its group (`#accounts`: the group's first leaf),
by a name that moved inside a leaf (`#clipboard`, `#guide`) or by its first word (`#add-scanned`, `#sync/join`,
`#backup-x`). Anything else (`#setup`, `#setup-restore`, `#reset`, `#install`, none, unknown) names none, and the page
shows what its address says: the default leaf, Security › Locking, or Backup for a vault that cannot be read. This
includes Back to such an address (F7: it used to keep the leaf last shown).

| Hash | Lands on |
| --- | --- |
| none, `#install`, `#setup*`, `#reset`, unknown | Security › Locking (a lost vault: Backup); the wizard and the reset are as before and show no groups |
| `#security`, `#security-keys`, `#security-log` | the leaf of that name; `#security-…` anything else: Locking |
| `#accounts`, `#add`, `#add-paste`, `#add-upload`, `#add-manual`, `#add-google`, `#add-scanned` | Add account (`#add-scanned` still takes the code read from the page) |
| `#backup`, `#trash` | the leaf of that name (the popup's "Back up now", the error screens' "Settings") |
| `#appearance`, `#clipboard` | Appearance (the Clipboard panel is on it) |
| `#advanced`, `#guide` | Advanced (the Guide panel is on it) |
| `#sync`, `#sync/join` | Sync (only where the build has it); the join alone on the page, as before |

On a switch the page goes to the top and the focus goes to the leaf's `h2` (`tabindex=-1`); on the first drawing nothing
takes the focus (the unlock bar, the reset and the wizard have fields of their own). The wizard's end goes to Add
account (its hint is there); a join ends on Sync. The popup is untouched and every hash it opens still lands where it
did (`short-settings-route.test.ts` scans the source for them).

## 3. What the page holds above its leaves (F1, F2)

What is typed is wiped when a leaf is left, as a lock wipes it. What must not be lost is not in a leaf.

- **A recovery key that has committed (F1, blocker).** A new recovery key, a replaced key and a master password turned
  on all show a code the moment the change has committed. The operations, their busy state, their outcome and that code
  are held by the page (`key-ops.ts`, used by `App.tsx`), not by Security. The code box is drawn above every leaf, in the
  same place whatever the person does; while it waits the rail and the leaves are not offered, the language menu is held,
  and closing the page asks first (`beforeunload`, as the wizard and the reset do). "Continue" (after "I have saved it")
  reloads the page's state, as before. An operation that finishes while the person is on another leaf shows its outcome
  (a refusal, "Password changed") at the top of that leaf until they move on. The forms in Security › Password & recovery
  are components of their own that hold only what is typed: closing a form unmounts it, and the typed passwords go with
  it (the lock, a hidden tab, Escape, another form opening, leaving the leaf and Back all reduce to that).
- **The question "delete the file you imported from?" (F2).** It holds files' names and handles, no keys. The list is kept
  (`import-asks.ts`) and drawn above every leaf (`PendingDeletes`) until the person answers (Keep, Delete, Got it), also
  across a lock. This reverses the first version's default (dropped on leaving Add account): a plain-text file of keys
  left on the disk because a link was clicked is what the question exists to prevent.
- **A file handed over from Backup (F5, F6).** Backup keeps it and hands it over only when the person follows the link in
  its message ("This is not a Sixkey backup. Open it in Add account"); it waits in memory for the moment between the
  click and Add account taking it. It is handed over when Sixkey is unlocked (Add account waits for the vault itself), and
  dropped, with its message and link, on a lock: both keyed on the lock itself, not on the vault having been read. A file
  still being read when Sixkey locked is refused after the unlock (an epoch every drop bumps; the link carries the epoch
  of its pick too), and Backup says why: "Sixkey locked while the file was being read. Choose it again." A file not
  followed is not left for a later visit.
- **What was typed or read in Add account** (pasted keys, the files' accounts, the camera) is dropped when the leaf is
  left, as before (its camera stops). The Sync section is the one thing kept mounted while another leaf is shown (its
  rail line and rounds need it); what is typed in its views is dropped when it is hidden (they are drawn again, the flows
  go on), F8.

## 4. Folded boxes and the install notice

`Fold` (`shared.tsx`) is a box that is one line (its title, a button with `aria-expanded`) until opened. Closed means
unmounted. A status never hides behind a fold (`note`). Escape closes it, except an input method's own Escape
(`isComposing`). Folds: Change master password, New recovery key, Replace the encryption key (one open at a time, in
Password & recovery); PIN quick unlock (its state and "End quick unlock now" stay in view; its lead moved inside); Export
selected accounts (Backup). "What Sixkey keeps in this browser profile" is no longer a fold: it says what is kept and that
nothing is sent, so it is always open, on the Security record leaf. Closing, a lock and a hidden tab drop what was typed
in each.

Encrypted backup (Backup) is a fold too since the cloud backup's card became the leaf's first (BACKUP-VISUAL,
CLOUD-PLUGIN-NOTES §3.8): with the card and the open form, the leaf ran past a screen and a half. Closing it (its
button, Escape) drops the file password; otherwise it keeps what the open box did: a lock empties its fields, a hidden
tab does not.

The install notice is one line (a native `<details>`), never dismissed or stored; `#install` opens it, in the page and from
the popup's banner. It is drawn above the header's dial.

## 5. Budgets

New text: three names (`grpAccounts`, the rail card's `accountsLabel` being "number of accounts" in Chinese; and two leaves of Security, `secLockTab`, `secKeysTab`) and one rewritten line (`loadedIntoAdd`); `instDetails` and
`secLogTitle` are in the core part now (the rail and the page's links use them). Text loading is as it was (every part of
a vault's page up front: aggregates, a lock waits for no text, no empty frame on a switch). `messages.py` (zh_CN, the
larger language) against the live tree: see the table at the end of this section.

| Catalog (gzip, zh_CN) | live tree | now | limit |
| --- | --- | --- | --- |
| core | 3,471 | 3,532 | 5,120 |
| security | 3,311 | 3,306 | 5,120 |
| backup | 1,169 | 1,159 | 3,072 |
| accounts | 2,454 | 2,454 | 3,072 |
| a vault's page, loaded together | 10,828 | 10,871 | 12,288 |
| every part together | 11,349 | 11,390 | 12,288 |

The popup is untouched: no file under `src/popup` or `src/ui` changed.

## 6. Page heights (1400 x 900, a vault of two accounts)

Security › Locking 1,102 px (zh_CN 1,073), Password & recovery and Security record one screen (900: the height of the rail),
Add account 1,158, Backup 1,298 (zh_CN 1,310), Trash and Sync one screen, Appearance with Clipboard 1,315 (zh_CN 1,273),
Advanced with Guide 1,053. No leaf is past a screen and a half (1,350 px), so none is exempt in the visual guard. (The
first version's Security was 1,674.)

## 7. Tests, and what the first version got wrong

The first version said "no assertion was weakened". That was false in three places, found by the review and restored:

- `export-selection.spec.ts` test 3 (C6-3: an account that left the list does not come back ticked) left Backup to reload
  the page, which drops every tick, so its check was trivially true: removing the prune survived. It now reloads without
  leaving Backup (two refused exports, C6-2), and the prune mutant dies.
- `quick-pin.spec.ts`: "nothing left in the fields" had become "the fields are not there". It opens the box again and
  asserts the fields are empty.
- `export.spec.ts`: "the selected-accounts button is disabled after its export" had become "it is absent". It opens the
  fold again and asserts the button is disabled.

Every other spec that changed only navigates first (`showSection`, `openFold`, in `test/e2e/harness.ts`) or follows a
moved element (the `importfile-source-rules` chain assertions are unchanged: the delete click chain still lives in
`AddAccounts.tsx`; `password-setup.test.ts` points the "measure() before every write" rule at `key-ops.ts`, where the
writes are now). `budget-split.test.ts` counts 15 wrappers instead of 12 (the three new ones), and its wrapper pattern now
accepts a hyphenated leaf id.

Layers (the first version's kill counts leaned on source-text regexes; they are separated now):

- unit, behaviour: `short-settings-route.test.ts` (the hash table; every hash the popup and the page open),
  `short-settings-dom.test.ts` (Security › Password & recovery: closing, Escape, IME, another form, an answer not following,
  a lock, a hidden tab, what a form hands to the page's operation), `short-settings-fold-dom.test.ts` (PIN, Backup's
  fold), `short-settings-state.test.ts` (the page's operations hold the code across the leaf that asked; the questions;
  the hand-over and its epoch).
- e2e, behaviour, in Chromium: `short-settings.spec.ts` (groups and leaves, every hash, Back and Forward, F7, 320 px with
  nothing scrolling sideways, a short window, focus on a switch including the sync leaf's late load, the hand-over and
  its three ends, Add account dropping what was pasted, the delete question kept, the drop guard, the forms' wipes by
  Escape, leaving, Back, a hidden tab and a lock, an answer not following, a lost vault, F1 (the code survives a hash
  change, Back and Forward, an immediate click, a device-key vault, an operation finishing elsewhere) and `beforeunload`),
  `install-source.spec.ts` (the notice, in the production build, including an in-page `#install`).
- `visual-guard.spec.ts`: every leaf at 320, 420, 600 and 1400 px, both themes, both languages; each fold open at 320, 420
  and the default width; a short window; the page height at 1400 x 900; the nav hscroll allowance is gone.

Hand-made mutants, one at a time, in a private copy, each against the layers that can see it:

- 38 in code that unit tests can see (the hash mapping, the page's operations and the code they hold, the forms' closing
  on Escape, an input method, a lock, a hidden tab and another form opening, the answer not following, the PIN and
  Backup folds, the hand-over's epoch and queue, the delete questions' list, the Sync host's focus and its count): 38
  killed, all by behaviour tests (none by a text pattern; the 38th, an error after the commit dropping the shown code, is revision 3's).
- 31 in the real browser (focus and scroll on a switch, Back to an address naming no leaf, the lost-vault landing, the code
  drawn above the leaves, the rail held, `beforeunload`, the language menu held, the delete questions above the leaves,
  the drop guard, the outcome on another leaf, Add account kept mounted while hidden, Sync's typed text, the wizard's end,
  a hand-over surviving a lock or a slow read, the link not handing over, the C6-3 prune, a hidden tab, the rail's own
  scroll, the groups at 320 px, `aria-current` on the group and the leaf, an `#install` written in the page, and revision 3's: a hand-over gated on the vault, Locking as the keys' leaf, the refusal only inside a fold, `#clipboard` not scrolled to, no hold while an operation runs, the code box hidden while locked): 31 killed.

The first version's equivalent survivor (Security's wipe on a lock) is gone: the forms are components that hold their own
fields, so closing is the wipe and there is nothing left to forget. Text-pattern rules in the unit tests are kept only for
what is static (one `hashchange` listener and no `popstate`, the release gate's exact shape, the list of
`scrollIntoView` callers, the focusable headings, the install notice storing nothing).

Runs of this version, in private copies (the e2e copy with the API port moved off the default): the whole unit suite (212
files, 2,998 tests), the whole of `playwright test` (e2e and regression, 188 tests, with the production build for the
install notice), and the sync specs with the real API server and its database (12 tests), all passing; `typecheck`,
`build`, `check` and `format:check`. Those specs of `test/sync/` that touch the settings page were updated for the new
addresses (the keys box is on Password & recovery, the sync controls on Sync, the accounts in Backup's fold).

## 8. The review's findings (F1 to F11) and what was done

| Finding | Done |
| --- | --- |
| F1 blocker: a committed recovery key lost on leaving Security | §3: held by the page, above every leaf, rail and language held, `beforeunload`; tested by hash change, Back/Forward, an immediate click, a device-key vault |
| F2: the delete-file question lost on leaving Add account | §3: kept until answered, drawn on every leaf |
| F3: weakened assertions, the C6-3 prune | §7 |
| F4: an operation's outcome lost | §3: held by the page, shown on the leaf the person is on |
| F5: a file read across a lock | §3: epoch |
| F6: a held file waiting indefinitely | §3: handed over by the link only |
| F7: Back to `#install` kept the old leaf | §2 |
| F8: a typed Sync password kept while hidden | §3 |
| F9: Security forms not wiped on a hidden tab | `visibilitychange` closes them (also the PIN box and Backup's fold) |
| F10: two password folds open together | one fold at a time in Password & recovery; the PIN box is on another leaf |
| F11 and mutants: source-regex kills, no behaviour for the survivors | §7: the survivors have run-time tests; the rail's scroll-into-view was deleted (the groups wrap) |
| Escape during IME composition closed a fold | ignored while composing |
| "What Sixkey keeps" is a disclosure | always open, on the Security record leaf |
| The header dial hid the install notice's Details | the notice is drawn above it |

### Revision 3 (the re-verification: no data-loss defect left; small fixes)

| Finding | Done |
| --- | --- |
| N1: a flaky hand-over test, and the wrong "not a Sixkey backup" for a file picked before the vault is read | Backup hands a file over when Sixkey is **unlocked** (Add account waits for the vault itself), not when the vault is read; a locked page, or a lock since the file was chosen, says "Unlock to manage this" instead. The test waits for the account count, a second test picks the file with no wait at all; both repeated 20 times |
| N10: a refusal not shown on Locking or when back on Password & recovery | the refusal is drawn at the top of Password & recovery whatever fold is open, until the next attempt or a fold opening; Locking counts as the keys' leaf only for a device-key vault's enable box, so elsewhere the page shows it at the top |
| N2: `showSection` raced on a page opened at a later leaf | the helper waits for the page's marked group and for the leaf row before it reads or clicks |
| N3: `#clipboard` landed with its panel below the window | a hash that points at a panel inside a leaf (`#clipboard`, `#guide`) scrolls to it (again for a moment while the leaf fills in, given up at the first wheel, touch or key) and focuses its heading after the first drawing |
| N4: no `beforeunload` while a key operation runs | asked while the operation is under way too, not only once the code is shown |
| Locking's heading said "Security" | it says "Locking" (the group stays "Security"; `presets.spec.ts` checks the rail's word, the tab and the heading) |
| 320 px first screen all chrome | the rail card's three facts sit in a row below 560 px (about half as tall) |
| the Security-mode cards overhung 4 px at 320 px (older than this work) | `minmax(min(240px, 100%), 1fr)` (also the wizard's cards) |
| mutants Q22 (a code survives an error after the commit) and Q23 (the code stays while locked) | unit test (GM2-1) and an e2e test; both mutants die |

### Revision 4 (the second re-verification: two small regressions of revision 3, and test gaps)

| Finding | Done |
| --- | --- |
| N11: a file handed over while the vault was still being read survived a lock (the drop was keyed on "vault read", the hand-over on "unlocked") | Backup drops the file and its message on `status.state` leaving "unlocked", the same condition as the hand-over; the link also passes the epoch of its pick |
| (found while testing N11, older than this work) a reload still reading the vault when a lock arrived set that vault afterwards on the locked page (the rail showed the account count while locked) | App applies the vault only from its latest reload (a counter); a newer reload shows what is true |
| N12: at 320 x 700 a refusal at the top of Password & recovery was drawn above the window | the line is brought into view (`block: "nearest"`) when a new refusal comes |
| T1: the N1 gate's test hit the window 1 time in 20 | a test seam in the test page only (an init script holds the page's AES-GCM decryption, which only the vault read uses at that point) makes the window every time: a file picked while the vault is read is handed over; a lock in that window takes it (N11) |
| T1: "Unlock to manage this" untested | asserted for a pick on a locked page |
| N13: a lock and an unlock during the file read said "Unlock to manage this" on an unlocked page | a lock during the read (still locked or unlocked again) says "Sixkey locked while the file was being read. Choose it again." (one new text, backup part) |
| N14: a locked page opened at `#clipboard` or `#guide` scrolled past the unlock bar | no panel scroll on the first drawing unless the page is unlocked |
| S09, S11/S16, S14 untested | tests: a key press ends the page's repeated scroll; the panel heading is not focused on the first drawing; a device-key vault's refusal on Locking is said once |
| S12 (the mode-card CSS), N3b (a scrollbar drag in the first second is pulled back), N5 | not done (cosmetic or optional) |

## 9. Owner decisions (defaults chosen; say if you disagree)

1. **Five groups, as in §1.** The owner asked for tabs; this is groups in the rail with leaves where a group has three
   pages, because a second row of tabs under every group would be more to think about than the page it replaces.
2. **Landing page: Security › Locking** (Backup for a vault that cannot be read). The review suggested making Accounts
   the landing page when the vault has no accounts or has never been backed up. *Default: not done*; the rail's status
   card shows "Last backup: Never" in red on every page, and the Accounts group is the first link.
3. **Leaving a leaf drops what was typed or read in it** (a pasted key, the files' accounts, a typed password).
   *Default: dropped.* The delete-file question is the exception (§3).
4. **A recovery key on screen holds the rail** until it is saved, and closing the page asks first. *Default: held*
   (the alternative, letting the person wander with an unsaved code on screen, is the data loss the review found).
5. **Locking holds the lock settings and the PIN; the keys have a leaf of their own.** *Default: as §1.*
6. **A vault that cannot be read opens on Backup.** *Default: Backup;* a hash still wins.
7. **Folds are closed on every opening and not remembered** (a remembered open form would be a remembered place to type
   a password).
8. **The install notice is closed by default** and shows only its title; the ID is one click away (`#install` opens it).
9. **After the wizard the page opens on Add account**, with the hint, as the hint's text ("add your first account
   below") asks; a join ends on Sync.
10. **Security › Locking is still the longest page** (see §6): the two security modes, the lock settings and the PIN. The
    next cut, if the owner wants one, is the modes as one row showing the chosen mode.

## 10. Real-browser checks

Owner checklist item 20.
