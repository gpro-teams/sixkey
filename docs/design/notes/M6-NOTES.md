# M6 notes: the sync user interface

Milestone M6 of `docs/SYNC-DESIGN.md` (revision 24; §6, the M6 row of §9), built on the engine of M3 (`docs/design/notes/M3-NOTES.md`,
§1.2 and its hand-off in §10) and the wiring of M5 (`docs/design/notes/M5-NOTES.md`, its hand-off in §12). M6 gives users the
settings page's Sync section: what sync is, turning it on, joining a vault another device syncs, what state sync is in,
and turning it off. SYNC-DESIGN.md, `api/` and `contract/` are not changed here.

M6 is delivered in two parts. **Sections 1 to 12 describe part A, the core path**: the section, its explanation card,
turning sync on, both ways of joining, the state of sync and its actions, turning sync off and removing the sync
identity, the review of a merge the guard stopped, the notices, the saves kept while they cannot be read, the toolbar
badge's words, the release gate that keeps all of it out of the store build until the cloud exists, and the catalog
split that pays for its text. **Section 13 describes part B**: the module split that keeps the engine's code out of the
popup, the device list, approving and revoking devices, renaming, the key operations, the cards' ways out (repair,
rejoin, cloud restore, start over, a separate device), deleting the sync account, the security record's sync events,
and the popup's lock-screen line. Where part B changed what part A says, part A's text points to §13.

---

## 1. How to run

| Command (in `extension/`) | What |
|---|---|
| `python3 scripts/messages.py` | writes `_locales/<lang>/messages.json` **and** `catalogs/sync-<lang>.json`; both are generated and never part of a patch (§4), so run it first: the dev and e2e builds need the second |
| `npm run build:e2e`, `npm run build:dev` | builds with the Sync section (the release gate lets it into dev and e2e builds, §3) |
| `npm run build`, `npm run check` | the store build, without it; `check-dist` says `sync user interface: out (release gate SYNC_UI_IN_STORE_BUILD = false)` |
| `npm test` | unit tests; M6's are `test/unit/m6-*.test.ts` (§9) |
| `npm run e2e:sync` | the extension in Chromium against the real API server (it needs the server's Python: `make venv` in `api/server`, or `SIXKEY_API_PYTHON`); M6's are in `test/sync/m6-section.spec.ts` |

**Trying it by hand** (dev build): `make run` in `api/server`, `npm run build:dev`, load `extension/dist-dev/` unpacked,
set a master password, open the settings page, Sync. The dev build declares the API origin as an optional permission
as the store build will, so "Turn on sync" shows Chrome's real prompt (`OWNER-DECISIONS/12` lists it as a manual
check). One-time codes go to `api/server/.pg/otp-inbox.jsonl`.

---

## 2. What was built

| Piece | Where |
|---|---|
| The release gate: one constant, `SYNC_UI_IN_STORE_BUILD = false` | `scripts/sync-ui.mjs` (+ `.d.mts`); read by `scripts/build.mjs` (define `__SYNC_UI__`, the graph guard) and `scripts/check-dist.mjs` |
| The section's place in the page, the lazy load, the rail item | `src/options/SyncHost.tsx`; `App.tsx`, `Rail.tsx`, `FirstRun.tsx` ("join a synced vault instead") |
| The section (one lazily loaded chunk, `assets/sync-ui-*.js`) | `src/options/sync/` |
| &nbsp;&nbsp;its one door to the engine and the platform's sync wiring | `gateway.ts` |
| &nbsp;&nbsp;its own text and translator `st()` | `text.ts`; text in `scripts/i18n/m6.py` (`SYNC_EN`, `SYNC_ZH`) |
| &nbsp;&nbsp;what is shown for each state (pure) | `model.ts` |
| &nbsp;&nbsp;the controllers (plain TypeScript, no DOM) | `store.ts`, `signin.ts`, `account.ts`, `enable.ts`, `join.ts`, `panel.ts`, `permission.ts`, `recovery.ts`, `review.ts` |
| &nbsp;&nbsp;a lock of Sixkey, as the section sees it | `lock.ts` (`watchLock`) |
| &nbsp;&nbsp;the views | `SyncSection.tsx`, `EnableView.tsx`, `JoinView.tsx`, `SignInView.tsx`, `StatusView.tsx`, `ReviewView.tsx`, `widgets.tsx`, `use.ts`, `sync.css` |
| The generator's second catalog | `scripts/messages.py` (`SYNC_EN`/`SYNC_ZH` → `catalogs/sync-<lang>.json`) |
| The toolbar badge in words | `src/platform/sync-worker.ts` (`badgeTitle`, `setBadgeTitle`) |
| Engine additions (small) | `src/core/sync/engine/state.ts` `dismissNotices`; `enroll.ts` `ApprovalJoin.expiresAt` (range-checked) and `confirmLost`; `src/core/service/sync-flows.ts`: `commitUploadRecovery` and `commitJoin` refuse once the vault has locked since their step one, and the join's session carries the epoch read before its last check (`service.ts` `startSession`'s optional `epoch`) (§8); saves of another vault kept until the user deletes them (`local/outbox.ts` the parked reason "vault", `engine/orphans.ts`, `engine/engine.ts`; §12 item 1) |
| The developer page's approving side (dev and e2e only) | `src/devsync/main.ts` `approverList`/`approverStart`/`approverPoll`/`approverSas` |
| Tests | §9 |

The popup has no sync code; its only change is the vault service's `startSession` parameter (§5). (Part B adds the
popup's one line of sync user interface, behind the release gate: §13.)

---

## 3. The release gate

The store build must not offer sync before the cloud exists (M8). The whole interface is built, and kept out of the
store build by one constant:

```js
// scripts/sync-ui.mjs
export const SYNC_UI_IN_STORE_BUILD = false;
export const syncUiIn = (flavour) => (flavour === "prod" ? SYNC_UI_IN_STORE_BUILD : true);
```

- **One source.** `build.mjs` defines `__SYNC_UI__` from `syncUiIn(flavour)`; `check-dist.mjs` imports the same function
  (as it imports `STORE_ID`: a second, restated copy would be a second switch to forget). No environment variable or
  command-line flag reaches it (a test reads the build script).
- **Read in one module.** `src/options/SyncHost.tsx` exports `SYNC_UI` and is the only importer of the section; `App` and
  `FirstRun` ask it. The section's `import()` sits behind `if (SYNC_UI)`; with the gate closed it is dead code that the
  bundler drops **before it loads the module** (checked: the store build's module graph has none of `src/options/sync/`,
  the catalogs or the enrolment code, and its popup chunks are byte for byte the same as before M6).
- **Two checks of a closed gate.** `build.mjs`'s graph guard fails a store build whose graph reaches
  `src/options/sync/`, `catalogs/sync-*.json`, `enroll.ts` or the new-device machine (M5's guard, extended);
  `check-dist` fails one that ships any `assets/sync-*` file, names any key of the section's catalog (as a string or as
  an identifier: the minified catalogs are objects keyed by them, unquoted), or carries the enrolment fingerprints.
- **One check of an open gate** (dev, e2e, and the store build once flipped): exactly one section chunk and one catalog
  per language, each catalog exactly the generated file, the same keys in every language, none of them a key of the
  full catalogs, each within its limit (§4); the settings page loads them lazily (not from its HTML) and the popup
  cannot load them at all.
- **Flipping it** (M8) is one reviewed change: the constant, `test/unit/m6-gate.test.ts` (which pins it), the store's
  permission text and `OWNER-DECISIONS/06`'s "no network" sentence. The same test builds a private copy with the gate
  opened and shows that the store build then carries the section and passes its own `check-dist`.

---

## 4. Text: the catalog split and its budget

The full catalogs (the settings page's) were at en 9.2 KB and zh_CN 10.4 KB gzipped against `FULL_CATALOG_GZ` 12 KB;
the section needs about 300 strings. They are a catalog of their own:

- `scripts/messages.py` accepts `SYNC_EN` and `SYNC_ZH` in a fragment (`scripts/i18n/m6.py`) and writes
  `catalogs/sync-en.json` and `catalogs/sync-zh_CN.json`. Generated, like `_locales`: never edited by hand, never part of
  a patch, written by whoever applies one. Outside `_locales`, because the build copies `_locales` into every build,
  the store build included. The generator refuses a sync key that is also a key of the full catalogs, and languages
  with different keys.
- The section loads only its own language's file with its code (`text.ts`, the same fallback rules as `loadCatalog`),
  and reads it with `st()`. The words it shares with the page (Cancel, Continue, Master password, ...) stay `t()`'s. Both
  report a missing key the same way in test builds, which the end-to-end harness turns into a failed test.
- **Budget: `SYNC_CATALOG_GZ`**, enforced by `check-dist` wherever the section is built (e2e, and the store
  build once the gate opens; a dev build, not minified, prints it). Measured for part A: **en 7,074 B, zh_CN 7,955 B**
  against 10 KB. Part B's screens take the catalog to en 9,488 B and zh_CN 10,564 B, over 10 KB: part B sets the limit
  to **12 KB** (§13.5 item 4).
- Two keys went into the full catalogs, because they are needed outside the section: `frJoinSync` (the first-run
  wizard's way to the join, drawn before the section loads) and `syncBadgeTitle` (the badge's words, which the service
  worker reads with `chrome.i18n`: it has no catalog). The full catalogs are now **en 9,463 B, zh_CN 10,747 B** (+48 B,
  +54 B).

When the section loads: when it first comes near the screen, when the page is opened at `#sync` or `#sync/join`, or at
once when the profile has any of sync's records (sync on, an unfinished turn-off or join, kept saves), because the
rail's sync line and the page's own rounds need it then. A profile that never uses sync never loads it.

---

## 5. Measurements

Gzipped, the way `check-dist` counts (before = main without M6).

| | Before | After | |
|---|---|---|---|
| Popup, store build | 56,058 B (54.7 KB) | **56,066 B** | +8 B: the service's `startSession` takes an epoch (§8); no sync code (budget 61,440 B) |
| Full catalogs (settings page) | en 9,415, zh_CN 10,693 | en 9,463, zh_CN 10,747 | limit 12,288 B |
| Settings page entry, store build | 17,865 B | 17,997 B | +132 B: the host (gated), the rail line, the wizard's button |
| `sw.js`, store build | 50,209 B | 50,460 B | +251 B: the badge's title; the service's lock checks (§8); saves of another vault kept |
| The section's chunk (e2e build) | — | 18,568 B | + its stylesheet 1,584 B |
| The engine chunk the section shares with the developer page (e2e build) | — | 30,245 B | not in the store build while the gate is closed |
| The section's catalogs (e2e build) | — | en 7,074 B, zh_CN 7,955 B | limit 10,240 B |

The store build compared file by file with main's: the settings page's entry and HTML, the full catalogs (the two
keys of §4) and `sw.js` differ, and of the popup's files only the chunk it shares with the settings page and the worker
(the vault service's code), by `startSession`'s epoch parameter (§8, "A lock of Sixkey"); the popup's other files
differ only by that chunk's name in their imports. No module the popup loads is new, and none is the section's. The popup
carries no sync interface: §6 lists the popup screens the design asks for and why they are not here.

**With the gate open** (the store build as M8 will make it; measured in a private copy with the constant flipped,
`check-dist` passing): the popup is **59,694 B (58.3 KB)**, +3,636 B, still within its budget, and the section's chunk
is 45,975 B (the engine is in it: the store build has no developer page to share it with). The popup loads no module it
did not load before, and none of the section's: the growth is the bundler's module-level sharing. Five modules the
popup already imports (`core/sync/crypto/keybundle.ts`, `encoding.ts`, `subkeys.ts`, `core/sync/local/outbox.ts`,
`state.ts`) are also used by the section, which keeps more of their exports (about 7.2 KB more before compression,
beside the 2.9 KB of them the shared chunk held before). The rest, about 0.9 KB, is the split: the shared chunk they
sit in becomes two, and `platform/clipboard.ts` (shared with the section's Copy) a third, small one. The e2e build,
whose gate is open, splits the popup's shared chunk the same way. A change that took
the gate-open popup over its budget fails a test: `test/unit/m6-gate.test.ts` builds the store build with the gate
opened and requires its `check-dist`, which enforces the budget, to pass. §12 item 5.

---

## 6. Departures from the design, each with its reason

Revision 24 of SYNC-DESIGN (§0.0x) records departures 1 to 7 and 10 as the design's own: the items below say what
part A does and why; the design now says the same.

1. **No popup screens** (§6 P1–P5: the sync tick in the header, the lock screen's line, the welcome option, the banners,
   the HOTP line). The popup is at 54.7 KB of its 60 KB budget and M6 was asked to add no sync code to it. Everything
   P1–P5 says is on the settings page instead: the rail's sync line (P1), the notices and the pending-approval line on
   the section's card (P4), and "join a synced vault instead" in the first-run wizard, which the popup's "get started"
   opens (P3). The toolbar badge already counts the devices waiting (M5) and now says so in words. P2 and the HOTP line
   (P5) wait for the popup work. Measured: the store build's popup is unchanged. (Part B adds P2 behind the release
   gate, §13.2.)
2. **The order of turning sync on**: master password, email and code, the account check, the device name, the recovery
   code, the upload. O3 lists "password, name, recovery code" (earlier name); §3.1 puts the email's code (step 2) and the account check
   (step 3) before the recovery key (step 4), so a user whose email already has a vault is sent to the join before
   making a recovery key that would be useless there. The name comes after the account check for the same reason.
3. **Which outcomes give the permission back** (revision 23: every outcome but "done" and "unconfirmed"; revision 24, §7,
   says what an outcome is). An outcome is
   the end of the flow: a result of the upload or the join (`vault_exists` and `keyring_changed` included), a failure
   that ends it, a lock of Sixkey, or the user leaving (Cancel, the section going away, or the page closing: the
   worker's browser-start cleanup is the backstop). A mistake the user fixes on the same screen (a wrong password,
   one-time code or recovery key, a malformed one, an expired sign-in) keeps the flow, and the permission, open, so
   that retyping a code does not bring Chrome's prompt back each time. The list is `model.ts FIXABLE`; tests cover both
   kinds. "Locked" is not on it: a lock during a flow ends the flow (§8). The one place a locked page is something to
   fix in place is the join's warning card, when the page is already locked as the user chooses a way in: it says
   "unlock first" and stays open, before anything is sent.
4. **The recovery key at "turn on"**: a new code is shown before it is written and confirmed by typing back two of its
   groups (§3.1 step 4, O3), not with the checkbox that Phase 0's screens use; its copy button clears the clipboard
   after 30 s when the user allowed it (Phase 0's recovery-code box does not). The screen says that the old code stops
   working once the new one is confirmed, even if the user then stops.
5. **The saves kept while they cannot be read, with sync off**, are shown in the Sync section, not on the Security
   section (§4.7 says "the security page" because the design's sync panel disappears with sync off; this section stays,
   showing the explanation card).
6. **"Update Sixkey" has no store link** (O12 "附商店链接"): `check-dist` allows no URL in a script but the API origin's,
   and the store ID does not exist yet (`scripts/store-id.mjs`). The card says that Chrome updates by itself and that
   chrome://extensions' Update does it now.
7. **The badge's words follow the browser's language**, not the language chosen in Sixkey: the worker has no catalog and
   reads `chrome.i18n`, and the choice is kept in the pages' `localStorage`, which a worker cannot read.
8. **Part A's cards without their part-B action**: `keys_behind` and `server_older_key` (the repair), `different_vault`
   (rejoin from the cloud), `cloud_restore` (the cloud restore; part A offers the backup), `forked` (the notice only).
   They say what happened and what is paused. (Part B adds them all but `server_older_key`'s: §13.2, §13.5.)
9. **The approving side in the end-to-end tests** is the developer page's (dev and e2e builds only) until part B builds
   O9 in the section. (Part B's end-to-end tests approve from the section: §13.7.)
10. **The approval join's summary cannot skip duplicates** (§3.5 ③ "重复的跳过"). The approval path prepares the join
    against the synced vault without its accounts: they reach the new device only with its first round (M3-NOTES §3
    item 6: the enrolment's payload carries the key bundle, not the vault). So an account that is in this profile and in
    the synced vault ends up there twice (different ids; nothing is lost). The summary says so on that path ("an account
    the synced vault has already will then be there twice: delete the extra one") and gives no count of skipped ones;
    the recovery-code path sees the synced vault's accounts and still skips them, with the count. M3-NOTES lists the
    ways to remove the limit (the payload carrying the head envelope, which changes the contract; or a dedupe pass after
    the first round); none is part A's.

---

## 7. What is shown, state by state

`model.ts cardOf` chooses one card in this order (each rule is tested; `test/unit/m6-model.test.ts`):

1. **No sync records** (`off`): no card; the explanation card (O1).
2. **The local side** (§2.5): a damaged identity or configuration → *damaged* (Remove sync identity); a lost identity →
   *identity_missing* (Unlock; restoring once unlocked); configuration missing with a pending identity never pinned →
   nothing (an enrolment in progress, or a page closed before it wrote anything); otherwise an unfinished turn-off →
   *finishing* (a round finishes it, no network), or with the vault lost → *cloud_restore*.
3. **The stops before the network** (stored status `identity_missing`, `cloud_restore`, `damaged`, `wrong_origin`,
   `join_unfinished`, `rejected_by_server`): their card, whatever the permission is (they need none).
4. **A lost vault** while sync is on → *cloud_restore* (Restore from a backup).
5. **The permission as Chrome says it now** (`apiPermissionGranted`, read with the facts and again on Chrome's events):
   withdrawn → *paused* (Allow again), over any stored status; granted while the stored status still says paused →
   *resuming* (the next round clears it; M5-NOTES §9 item 11).
6. **The key state** (`keyStatus` ≠ ok): `keys_behind` (part B: Repair the cloud's keys), `needs_new_password` (Update
   this device), `rejected`, `update_required`.
7. **The round's status**, one entry per `SyncStatus` (a `Record`, so a new status fails the build):

| Status | Card | Actions |
|---|---|---|
| `ok` | In sync, when last, devices waiting for approval | Sync now |
| `offline` | Offline; changes kept; next try | Sync now |
| `locked` | Locked; changes made while locked still go up | Unlock |
| `error` | Sync didn't go through; the code in words; next try | Sync now |
| `busy` | Syncing | — |
| `needs_password` | Enter your master password to keep syncing | Update this device (`adoptWithSecret`; "this password opens only an older key state" asked in-page, §3.9 R3) |
| `review_needed` | A change needs your OK | Review (a round shows what the guard stopped) |
| `remote_unreadable` | The synced vault can't be read; nothing here changed | Sync now |
| `server_older_key` | The server went back to older keys; paused until repaired | Sync now (no repair: §13.5 item 3) |
| `update_required` | Update Sixkey to keep syncing | — |
| `too_large` | Too big to sync; deleting is always allowed | Sync now |
| `paused_newer` | Another device uses a newer Sixkey | Sync now |
| `different_vault` | This device's vault isn't the synced one; paused | Rejoin the synced vault (part B, §13.5 item 2) |
| `rejected_by_server` | The server no longer accepts this device; uninstalling and copies | Sync now, Remove sync identity |
| `join_unfinished` | Turning sync on / joining didn't finish | Check again (+ Join again for a join) |
| `identity_missing`, `cloud_restore`, `damaged`, `wrong_origin`, `permission_removed` | as in 2–5 | |
| `off` (stored with sync on: never rounded) | Getting ready | Sync now |

Beside the card: the **notices** (§6 P4, one-time, newest first, "Got it" removes exactly those shown: `dismissNotices`;
"another device deleted N accounts" with a link to the trash, and in danger colour per D6 when it then erased them,
linked to "Restore from a backup" instead, since erased accounts are not in the trash; "keys taken back" as the visible
event §3.9 R1 asks for); the **parked saves** (count, each reason's way out: update Sixkey, unlock with the newer password, make room; saves of
another vault than the one this profile syncs now are said to be kept until the user deletes them; "Advanced: delete
these saves" confirmed in-page and deleting exactly the entries shown, by count and checksums, the only way such a save
of another vault goes, §12 item 1); **this device** (Turn off sync).

**The rail's line**: Off / On · synced (when) / On · syncing / On · offline / On · locked / Paused / Needs attention,
coloured by the card's tone.

---

## 8. Security and privacy considerations

- **The API permission** (§4.9, §7): every button that starts something needing the network asks Chrome first, as its
  handler's first statement (`permission.ts asking`), because Chrome grants a request only within the gesture, which the
  first `await` spends; a static test reads the views to hold them to it (`m6-wiring.test.ts`). Turning sync off asks
  too, in the same click (the revocation needs the network); declined while withdrawn, only "remove the sync identity"
  (local) is offered; turning off and removing the identity remove the permission last; a turn-off that fails after the
  click re-granted a withdrawn permission removes it again. A turn-off that stopped for a review keeps the permission
  its click granted while the review is open (the answer's revocation needs it), and every other way the review closes
  (dismissed, a lock, the tab hidden, the page closing) gives it back.
- **Sync on means the permission is held** (or the user withdrew it). Nothing gives the permission back while a write is
  under way (the first upload, the new recovery key, a join's Continue): Cancel is not offered then, and the section
  going away, the page closing and a lock wait for the write, whose outcome may be that sync is on. The page closing
  gives back at once, before any await (a closing page may not get further), only a permission that a flow holds for
  itself and that nothing it started can still need (`leaving`); the rest is the worker's browser-start cleanup's. A
  flow replaced by another (a join that found no vault, then turning on) leaves the permission to the new one. Chrome's
  prompt answered after the flow ended (a lock or a cancel while it was open): the grant is given back when it arrives,
  since no flow is left to use it; a run that a newer one replaced (Ask again, clicked twice) leaves the grant to it.
- **A lock of Sixkey** (any context: the popup's Lock, the worker's idle or screen lock, another page; `lock.ts` sees
  the lock epoch move and the service say "locked") ends an open flow at once: the password, the recovery key, the new
  code on screen and the prepared join are dropped, an approval request is given up, and the permission goes back. A
  write under way finishes first and its outcome is what the flow says (a new code written just before the lock is
  said to be the one in effect). The engine checks by itself as well: `commitUploadRecovery` refuses a code prepared
  before the vault locked (someone at the locked page could otherwise confirm a code read off the screen into force),
  and `commitJoin` refuses a join prepared with this profile's vault open once it has locked (the commit ends in a
  session under the cloud key, which would open the locked page without the master password); the session a join
  starts carries the lock epoch read before its last check, so a lock during the commit's write leaves the page
  locked. A profile with nothing to lock (empty, unreadable, or without a master password) sees the epoch move but no
  lock: the first-run join goes on. What was typed or ticked on a flow's screens belongs to its run: a run that starts
  or ends (Start again, a lock, a failure, Cancel) empties the password, the recovery key, the two groups and the
  confirmation code, and unticks "replace this profile's unreadable data".
- **Secrets**: the master password and the recovery key live in a flow's memory between the step that takes them and
  the upload or join, and are dropped at every end (done, failure, cancel, a lock). Password fields are cleared once
  used; a typed recovery key stays in its field only while the user may correct it (Back empties it). A new recovery
  code is on screen only on its two steps (shown, typed back). The panel's master password, held for a turn-off's or an
  adoption's confirmation, and the panel's typed password fields are emptied when Sixkey locks or the tab is hidden
  (Backup.tsx's rule for the export password), except while a review's own answer is running (it took the password
  already, and the permission it holds is the one its revocation needs: the answer's ending decides); an action that
  a lock or a hide overtook and that then stops for a review keeps neither the password nor a permission for it. A
  flow's password is not emptied on hide, since turning on needs the email's tab for the one-time code. Nothing goes into a URL, the console, the diagnostics log or the security record.
  The account session (§0.1) is in the sign-in's memory only, and dropped when the flow ends.
- **The clipboard**: only on an explicit click (Copy), cleared after 30 s when the user allowed clipboard clearing
  (`platform/clipboard.ts`, the popup's convention). The six-digit check and the confirmation code are not secrets
  (§3.2) and have no copy button: they are typed across devices.
- **What the server says is untrusted**: the vault's creation date and device count on the warning card (§3.5) are
  shown only when they are plain numbers in range; error codes are shown only as short identifiers (the engine keeps no more), and in
  words where the section knows them.
- **The approval join** keeps §3.2's rules on the screen: the request is polled every 2 s while open and never re-opened
  by the page (MUST 3); a step that finishes after a cancel writes nothing (each controller counts its runs); closing
  the page gives the request up (MUST 6): the signed reject is sent if the page lives long enough, and the server lets
  the request expire after ten minutes in any case; a wrong confirmation code three times ends it; the scam warning is
  on both digit screens. The expiry the server sends drives only the countdown, and is used only when it is a time the
  request can end at. Over unreadable local data, neither way in goes on until the user ticked on the warning card that
  the synced vault replaces it (§3.5); only that tick reaches the engine, whose commit refuses without it.
- **Destructive actions are confirmed in the page** (never `window.confirm`): removing the sync identity, deleting
  parked saves, turning sync off (with the master password), adopting an older key state. A destructive confirmation
  takes the focus to its title, not to its button, so no key press the user did not aim at the button runs it. The
  review of a merge the guard stopped binds the answer to the versions shown (`seen`) and is held in memory only.
- **What the section says is true**: a flow tells the page how it ended; "unconfirmed" keeps the flow's own screen (the
  server's answer is awaited) and gets no news; the news after turning on or joining comes only after a first round
  that went through and in sync, and never clears a failure shown (`panel.ts settled`).
- **The page reaches no host** (its `connect-src 'none'`): every request goes through the worker's bridge, as M5 built
  it; the engine in the page signs its own requests.

---

## 9. Tests

New unit tests (vitest; numbers of tests in brackets):
- `m6-model.test.ts` (52): the card for every status and key state, the order of the rules, the rail line, times in
  words, the round's error codes, the notices (order, unknown kinds, D6's danger and its link), the parked lines, every
  flow failure's text, which failures keep a flow open (a lock not among them), the device name's problems, the join's
  summary on each path, the parked saves' ways out (another vault's among them).
- `m6-flows.test.ts` (20): turning sync on and joining end to end over the FakeServer, with a stand-in
  `chrome.permissions` that grants only inside a click: the code the user has; a new code shown, typed back wrong and
  right, written only then; declined; a request made after an `await` refused like Chrome does; wrong and malformed
  one-time codes; cancel; the sign-in expiring before the upload; the email already syncing (the join takes the sign-in
  and the permission over); `vault_exists` after the check; offline at the upload; the recovery-code join into a new
  profile and over a profile of its own (added, skipped); a recovery key of another vault; no vault; a page locked as
  the user chooses; a lost vault (neither way in before the tick); the approval join (SAS here, code there, malformed
  and wrong codes, three wrong codes, cancel, the poll's timer).
- `m6-panel.test.ts` (14): the panel over the FakeServer: off; rounds when due and on Sync now; none of the page's own
  inside the server's backoff (Sync now still runs one); the permission withdrawn and granted again; turning off (wrong password, then right; the permission removed last); turning off with the
  permission withdrawn and declined (local removal only); granted by the click but a wrong password (removed again); a
  device the server no longer accepts; a guard block reviewed and answered "keep mine"; keys rotated elsewhere adopted
  with the password; notices dismissed exactly; a sync identity lost from IndexedDB restored once unlocked, and said
  once; parked saves deleted only as shown; an unfinished first upload undone.
- `m6-permission.test.ts` (12): every outcome of a first upload and a join against the permission (kept for done,
  unconfirmed, enrolled; given back for vault_exists, keyring_changed, exceptions; kept while sync is on), and `asking`.
- `m6-i18n.test.ts` (7): the section's catalog (same keys, placeholders, no emoji, every key used and only in the
  section, disjoint from the full catalogs, one importer).
- `m6-gate.test.ts` (5): the constant; its one source; its one reader and the section's one importer; the store build
  with the gate opened in a private copy (carries the section, passes `check-dist`); with it closed, an import that
  slipped past the gate fails the build.
- `m6-check-dist.test.ts` (15): the pristine builds pass; 6 altered store builds and 8 altered e2e builds each fail with
  their rule's message.
- `m6-badge.test.ts` (3): the badge's title.
- `m6-helpers.test.ts` (8): the recovery key's input, groups and type-back; the email and six-digit inputs; the
  account check's numbers; the review's rows and answers; the section's translator and its fallbacks.
- `m6-lock.test.ts` (11): a lock while a flow is open. The engine refuses by itself: a recovery key prepared before the
  lock is not written by a confirmation after it (the code does not open the vault, the old one still does), and a join
  prepared before the lock does not unlock the page. The flows end at a lock (the code no longer in their state, the
  prepared join dropped, an approval request given up, the permission back); a lock during a write waits for it (a new
  code written just before is said to be in effect; a join that got through stays on with the permission). What counts
  as a lock: the epoch moving and the service saying locked, not a profile with nothing to lock (the first-run join
  goes on).
- `m6-approval.test.ts` (4): over unreadable data, nothing replaced and no request opened before the tick; ticked, the
  synced vault replaces it; the summary over a profile with accounts says what the vault then holds (the same account
  twice after the first round, as it says); the request's expiry used only when it is a time the request can end at.
- `m6-honesty.test.ts` (5): the outcome each flow reports (done, unconfirmed, enrolled); an unconfirmed join is not
  drawn as in sync and gets no news; news only after a first round that went through; news never clears a failure.
- `m6-permission-edges.test.ts` (11): a turn-off stopped for a review with the permission withdrawn before its click:
  the answer runs with the permission held, a second review holds it the same way, and dismissing, a lock, the tab
  hidden, the page closing and a failed answer give it back; held all along, it stays. Cancel during a join's Continue
  and during the first upload never leaves sync on without the permission. What the page closing may give back at once,
  and a flow replaced by another giving nothing back.
- `m6-remove.test.ts` (2): removing the sync identity keeps the parked saves and the accounts and gives the permission
  back last; locked with a save not yet folded, it is refused and nothing changes.
- `m6-timing.test.ts` (7): Chrome's prompt answered after the flow ended (a lock while turning on, a cancel while
  joining: the grant given back; Ask again clicked twice: the earlier answer takes nothing from the later run); a lock
  during a join's commit write leaves the page locked, and without one the joined page is unlocked; the tab hidden while
  a turn-off review's answer runs (the revocation keeps the permission) and during the first click's revocation that
  then stops for a review (the review not kept, the permission back).
- `m6-other-vault.test.ts` (1): a save of the profile's own vault, kept, then a join to the synced vault: kept by the
  join and by every round (parked as another vault's, no `orphan_unreadable`), shown with its way out, deleted by the
  confirmed "Advanced" delete only.
- `m6-wiring.test.ts` (4): the views read as source: every start, Allow again and Turn off call inside an `asking(...)`
  callback, every `asking` handler bound directly or called before any await, the start handlers passed down bound
  directly.

End to end against the real API server (`test/sync/m6-section.spec.ts`, 4): one profile turns sync on through the
section and a new profile joins with the recovery key from the first-run wizard, an edit reaches it, and it turns sync
off (revoked on the server, accounts kept, the records gone); a new profile joins by approval (the six digits read off
its screen, typed on the approving profile; a wrong confirmation code, then the right one); the permission withdrawn in
the page (a stand-in `chrome.permissions`: the e2e build declares the permission as required), the card paused, "Allow
again" asks in the click and sync resumes, turning off removes it last; a join refused at the recovery key keeps the
flow, and Cancel gives the permission back. Every request on the wire: signed, exactly `application/json` on bodies,
no cookie, no referrer.

**Mutation check.** Hand-made mutants of part A's logic, applied one at a time (each target must occur exactly once),
each run against the test files that cover the mutated module (the runner is outside the repository). **87 mutants,
87 killed**, each by a failing assertion. Three more checks are defence in depth and their mutants would be
equivalent, so they are not counted: making the engine's `confirmLost` follow "the data is lost" instead of the tick
(no way in gets past the warning card without the tick; two of the mutants below mutate that check itself); the vault
condition on the rule that removes an entry whose key is provably gone (the fold parks another vault's entry as such
first); reading the lock epoch again inside the join's write (the epoch read before the first check is no later).

| Set | Mutants | Killed |
|---|---|---|
| What is shown: the live permission over the stored status; the permission before the local stops; the key state over the round's status; an enrolment in progress elsewhere; first upload and join unfinished swapped; the rejected card's local removal; a lost vault while on; resuming after a re-grant; D6's danger colour; the rail's tone; a wrong password ending the flow; the page's round when not due; the page's round inside the server's backoff; a guard block not shown | 14 | 14 |
| The permission: asked after an `await` (the gesture spent); `vault_exists` kept; given back while sync is on; the upload's `vault_exists`, a cancel, a failure (turn on and join) not giving it back; turning off keeping it, removing it before the revocation, revoking although declined while withdrawn, keeping a re-grant after a failed turn-off; removing the identity keeping it; the flow not waiting for the answer | 14 | 14 |
| Destructive actions and what they bind to: the parked delete without the checksums shown; the review's answer unbound from `seen`; Keep mine answering Apply; a new recovery key written without the groups typed back; a join over unreadable data unconfirmed; a locked page not stopped before the join sends anything | 6 | 6 |
| The gate: opened; the store build always carrying it; the build's define on for every flavour; the host reading no gate; the graph guard without the section; check-dist without its file-name check, matching keys only as quoted strings, without the catalog limit, letting the popup load the section, letting the page load it up front, never checking the enrolment fingerprints | 11 | 11 |
| A lock: the engine writing a new code, and committing a join, after the vault locked; a lock not ending the turn-on flow, the join; the flow going on to the upload after a lock during the code's write; a lock ending a flow under a write's feet; every epoch move taken for a lock; the panel keeping a turn-off's review and password at a lock | 8 | 8 |
| The unreadable data replaced only after the tick: the approval way ignoring it | 1 | 1 |
| What is said: the join, and turning on, reporting a fixed outcome; news after any first round; news clearing the failure; the approval summary claiming skipped accounts | 5 | 5 |
| Never sync on without the permission: the join's and the turn-on's cancel not waiting for the write; the page closing dropping the permission at the summary, after the upload started; a flow replaced by another giving it back | 5 | 5 |
| The turn-off's review: giving the permission back at once; a review closed without giving back what it held; the answer's revocation told it was held before | 3 | 3 |
| check-dist allowing an engine chunk where the gate is closed; the request's expiry taken as the server sent it | 2 | 2 |
| The views' wiring (`m6-wiring.test.ts`): Allow again without asking, asked after an await; Turn off asked after an await; turning on started without asking; the turn-on button behind a reload; Start again deferred | 6 | 6 |
| Removing the identity giving the permission back before the engine answered | 1 | 1 |
| A grant after the flow ended: kept when turning on, when joining; a replaced run giving it back | 3 | 3 |
| A lock during the join's commit: the session's epoch taken at its own moment, in the join and in the service | 2 | 2 |
| The tab hidden during a turn-off: the review of a running answer closed; a review kept with its password after a hide during the click | 2 | 2 |
| Saves of another vault: removed by the fold; pushed by a locked round; their mark not read back; no words for them in the section | 4 | 4 |

Not mutated: the views' other bindings (which controller method a button calls, the in-page confirmations' focus and
Escape, Cancel hidden during a write, the per-run reset of what was typed, the lock and pagehide wiring of
`SyncSection.tsx`). They are thin by design: each
binds a controller method or `asking(...)`, and the permission's part of them is held by `m6-wiring.test.ts`. The
end-to-end tests go through the flows' screens (turning on, both joins, the code steps, the summary) and the turn-off,
Allow again and Sync now buttons on the real pages; the screens for removing the identity, deleting parked saves, the
review and adopting keys are covered at the controller level only (and were looked at by hand, §11).

**Full runs** (part A's final state): unit tests 148 files, 2,090 passed, 4 expected failures (the existing `it.fails`
markers; one of the five before is now an ordinary test, §10), 1 skipped, none failed; `tsc --noEmit` clean; `npm run e2e` (store, e2e and dev builds, each with
`check-dist`, then the existing end-to-end tests) 102 passed; `npm run e2e:sync` (the existing real-server tests and
M6's) 8 passed. By hand in the e2e build (a scratch script outside the repository): a lock from another context while
the new recovery key is on screen ends the flow and takes the code off the page; a destructive confirmation takes the
focus to its title, and Enter there runs nothing; a run that a lock ended leaves nothing typed in it for Start again
(the turn-on password, the join's recovery key).

One existing real-server test (`outage.spec.ts`) found a fault while M6 was built: the page ran rounds of its own
inside the server's backoff, which the worker is meant to hold. The page now leaves a backoff to the worker (a test and
a mutant cover it).

---

## 10. Existing tests changed

Each follows from the requirement; none relaxes a rule that still holds. Every list stays exact.
- `test/unit/sync-crypto-hygiene.test.ts`: the importers of `core/sync` outside it gain `options/sync/gateway.ts` (the
  section's one door) and `options/SyncHost.tsx` (the names of sync's storage keys, and the section's lazy import).
- `test/unit/m3-source-rules.test.ts`: the importers of the engine gain `options/sync/gateway.ts`. The popup's graph
  test is unchanged and passes.
- `test/unit/m2-source-rules.test.ts`: the importers of the sync flows' modules gain `options/sync/gateway.ts`. The
  popup's exact module list is unchanged and passes.
- `test/unit/m5-source-rules.test.ts`: the enrolment fingerprints exist in `enroll.ts` and otherwise only in the
  section, which the release gate keeps out of the store build together with `enroll.ts`.
- `test/unit/m5-build-guard.test.ts`: the private copies of the sources include `catalogs/` (dev builds carry the
  section's text).
- `test/e2e/sync-helpers.ts`: the developer page's type gains the four approver calls.
- `test/unit/m3-orphan.test.ts`: "startOver over a lost vault" pinned the old rule (the old vault's entry removed by the
  next round, and by a locked round); it now pins revision 24's (kept, parked as another vault's, never pushed, deleted
  by the user's confirmed delete).
- `test/unit/m3r4-review-probes.test.ts`: the recorded gap R4R-12 (`it.fails`) is closed by revision 24 and is now an
  ordinary test of the rule (kept after the join and every round).

---

## 11. Known residuals and not done (part A)

- **Popup** P1, P3–P5: §6 item 1 (P2: part B, §13.2).
- **Old browser engines** (Chromium 120 and 134, the M6 row's "旧内核上跑 §8.6 子集"): not run; the same pipeline as
  M5-NOTES §10 is still missing.
- **The real permission prompt** is a manual check (`OWNER-DECISIONS/12`): the e2e build declares the permission as
  required, and the tests stand in for `chrome.permissions` where they need it withdrawn.
- **A component test runner**: the views are covered by the end-to-end tests and a visual walk in light, dark and at
  420 px; the logic they bind (every state and transition) is in the controllers and the model, tested without a DOM.
  No DOM library was added to the project for it.
- **"Join again" after a join that did not finish** starts a new join (the engine undoes the old local half, or waits
  while the old request may still land: "try again in N minutes").
- **A lock during a join's commit** is seen: the commit checks the lock before and inside its write, and the session
  it starts carries the lock epoch read just before that last check, so a lock anywhere after it (the vault's
  encryption, `sk_prejoin`, the configuration and pins, the two-slot write and its read-back, the security record) voids
  the new session at once and the page stays locked (`m6-timing.test.ts`). Phase 0's own key changes (a password
  change, a new recovery key with sync off, start over) still start their session with the epoch of that moment: a
  lock between their key check and their session (their whole write) is absorbed and leaves the page unlocked. That
  window is Phase 0's and unchanged here; the same option of `startSession` would close it, in a change of its own.
- **The page closing** is best effort by nature: what it gives back synchronously is limited to what is safe (§8), the
  rest is the worker's browser-start cleanup's, and an approval request expires on the server.
- **"Recover the accounts"** after another device erased them (O13, D6: the snapshots and the server's 30 days of
  history) has no screen in part A; the danger notice points to a backup.
- **The views' remaining bindings** (a destructive confirmation's focus, Cancel hidden during a write, the per-run reset
  of what was typed, the lock and pagehide wiring in `SyncSection.tsx`) are checked by hand and in the end-to-end tests where those reach them; the
  rules they apply are the controllers' and are tested there.

---

## 12. For the maintainers and the design owner

1. **M3-NOTES §B item 1 is closed** (SYNC-DESIGN revision 24, §4.7): a saved entry of another vault than this
   profile's (kept by a turn-off, then a join to another vault) is never removed by itself; the fold parks it ("another
   vault"), a locked round neither pushes nor removes it, the rule that removes an entry whose key is provably gone holds
   only for entries of this very vault, and the Sync section shows it (another vault's, kept until deleted) with the
   confirmed "Advanced" delete (`m6-other-vault.test.ts`; M3's own tests of the old rule now pin the new one).
2. **§3.3 step 5 with sync on**: "set a new master password with the recovery code" (earlier name) (one bundle update with
   `recovery_auth` instead of `pw_auth`) has no engine function: `keys.ts changePassword` needs the old password. Part B
   needs it for the follow-up card after a recovery-code join (O7); it is an engine addition with its own tests. (Done
   in part B: §13.1.)
3. **Other engine gaps part B meets** (found while reading the engine; nothing here depends on them): "make this profile
   a separate device" (§4.10 fork) exists only as `SyncApi.fork`, with no flow that writes the new identity, the new
   `sk_device` and clears `lastSynced`; "rejoin from the cloud" (§3.5, `different_vault`: replace the identity, join,
   revoke the old device) and "delete the sync account" (§3.12, O14) have no flow function either. (Part B: the fork
   and the deletion are engine functions; the rejoin is two existing flows, §13.5 item 2.)
4. **Engine additions made here** (small, with tests): `EngineStateStore.dismissNotices` (notices had no way to be
   dismissed), `ApprovalJoin.expiresAt` (the countdown; a value from the server that is not a time the request can end
   at is replaced by the latest it can be), `ApprovalJoin.start({ confirmLost })` (an approval join over a lost vault
   could not commit: `prepareJoin` was called without it); the lock checks of `commitUploadRecovery` and `commitJoin`,
   and the join's session started with the epoch read before its last check (`startSession`'s optional `epoch`, the
   flows' `lockEpoch`; §8, §11); the parked reason "vault" and the rules of item 1.
5. **For M8**: flip the gate (§3), with the store text and `OWNER-DECISIONS/06`. With the gate open the popup is at
   58.3 KB of its 60 KB (§5). The remedy is in the sources, not the bundler (which cannot split a module between
   chunks): the parts of the five shared modules that only the engine uses move into modules of their own, so that the
   popup's chunk no longer carries them. Decided: that split is part B's first change, with a test that keeps those
   modules out of the popup's graph, before part B adds more users of them.
6. **Recorded by the design author in revision 24** (§0.0x; SYNC-DESIGN is not changed by this patch): departures 1
   to 7 and 10; the two service rules of §8 "A lock of Sixkey" (§3.1 step 4 (b), §3.5); the permission invariant and
   the turn-off review's exception (§7); the module split as part B's first change (§7, §9 M6); the dedupe after an
   approval join as a later requirement (§3.5: after the first round, the duplicates the join added go to the trash).
   One new item: the parked reason `"vault"` is a new value in a stored record (`sk_sync_orphan`'s parked mark), for
   §3.13's list of format changes. A build older than this one reads such an entry as not parked, and its fold then
   removes it as another vault's, which revision 24 forbids: after a downgrade the rule holds only as far as that older
   build knows it.
   **For the design author (§3.13)**: no build of Sixkey has shipped, so no older build can meet a parked "vault" entry
   today and the downgrade above is moot; the new value belongs on §3.13's list of stored-format changes all the same.
7. **Before the gate opens** (M8; SYNC-DESIGN §9, M8 item 17): the flip itself; the popup's lock-screen line "the
   password was changed on another device" (P2); the actions of departure 8's cards (`keys_behind` and `different_vault`
   have no way out in part A); the store link of departure 6; the popup within its budget with the gate open (the
   module split). Part B does all of these but the flip and the store link (§13).

Part B inherited: the approval screen (O9) and the device list (O8), revoke (O10), rename, the key operations with sync
on (O11: change password with the rotation tick, new recovery key, rotate keys; their "unconfirmed" outcomes), the
repair (`keys_behind`, `server_older_key`), rejoin from the cloud (`different_vault`), the cloud restore, start over,
the fork ("make this profile a separate device"), clear server history, the security record's sync events and the
"keys taken back" record kind, and `sk_prejoin`'s export and deletion. §13 says what it did with each.

---

## 13. Part B

### 13.1 What was built

| Piece | Where |
|---|---|
| The module split, first (§13.2) | `core/sync/crypto/cap-previous.ts`, `basic-encoding.ts`, `write-proof.ts`; `core/sync/local/outbox-writer.ts`, `kept-at-turn-off.ts` (the old modules re-export what moved) |
| The managing flows' shared rules (permission first, a lock ends them, secrets dropped at every end, "unconfirmed" said as such) | `src/options/sync/manage.ts` |
| The device list (O8): name and last sync (to the day), this device marked, revoked ones greyed, 90 days without a sync, repeated wrong master passwords; rename (with the master password, N22); reject every waiting request | `devicelist.ts`, `DevicesView.tsx`; engine `engine/devices.ts listDevices` |
| Approving a new device (O9, §3.2 M2–M5); Cancel while a request is answered gives it up | `approve.ts`, `ManageViews.tsx`; engine `enroll.ts Approver.rejectRequest` |
| Revoking a device (O10, §3.10): "still mine" or "lost or stolen", the devices it approved ticked beside it; for "lost" the rotation's code first where the rotation can be prepared, then the owed rotation recorded, the devices revoked and the rotation sent; when it cannot be prepared, revoked at once all the same with the rotation owed and why (§13.4) | `revoke.ts`; engine `keys.ts revokeNeedsProtect`, `noteRotationOwed`, `revokeDevice`; `engine/state.ts rotationOwed` |
| The key operations (O11, §3.6–§3.8): change the master password (with the "rotate too" tick), a new recovery key, rotate the keys; a new master password with the recovery key (§3.3 step 5, O7); each commit refused after a lock | `keyops.ts`, `codesteps.tsx`; engine `keys.ts` (`prepareRecoveryReset`/`commitRecoveryReset`, `stillOpen`) |
| The follow-ups after a join with the recovery key (O7): a new recovery key, a new master password | `JoinView.tsx`, `SyncSection.tsx`, `App.tsx` (the page keeps the section alone until they close) |
| The cards' ways out (O12): `keys_behind` repairs the cloud's keys; `different_vault` rejoins; the lost vault restores from the cloud (asking Chrome first), from a backup, or leads to the Advanced section's confirmed start over; `forked` makes this profile a separate device; a rotation owed; the locked page after a key change not confirmed | `repair.ts`, `fork.ts ForkFlow`, `model.ts`, `StatusView.tsx`, `panel.ts permit`; engine `keys.ts forkDevice`, `local/sync-local.ts switchIdentity` |
| Deleting the sync account (O14, §3.12); turning off the last device warns (§3.10) | `fork.ts DeleteFlow`, `StatusView.tsx`; engine `keys.ts deleteSyncAccount` |
| Clearing the server's history (§5.4) | `StatusView.tsx` (Advanced); engine `keys.ts clearServerHistory` (existing) |
| The vaults kept from before a join (§3.5 ④) as a list: every join in the added mode appends its own while the list has room (past its bound the join is refused before anything is written, saying what to delete); listed in the section, deleted only on an unlocked page by a confirmed delete of exactly those shown; scrubbed by "delete forever" where it can open them, which says how many it could not; start over says it leaves them | `local/records.ts` (`prejoinItems`, `PrejoinRecord` cleanup and purge), `local/record-writers.ts` (`PrejoinWriter.writeInLock`, `fits`, `discard`, `keptId`, `KEPT_MAX`), `service.ts purgeForever`, `gateway.ts`, `panel.ts discardKept`, `StatusView.tsx`, `options/Misc.tsx`, `platform/runtime.ts keptVaultCount` |
| The security record: `keys_adopted_back` (a new kind); `device_approved`, `device_revoked`, `history_cleared` now recorded (M2 reserved them); a wrong master password or recovery key typed into the adoption recorded as Phase 0's unlock records one; entries of kinds and fields a version does not know kept when it rewrites the record | `core/service/security-log.ts`, `engine/engine.ts`, `engine/enroll.ts`, `engine/keys.ts`, `core/service/sync-flows.ts recordAction`, `options/SecurityCard.tsx` |
| The Security section with sync on: its three key boxes (Phase 0's, which refuse with sync on) give way to one pointing to Sync; neither while that is not known yet | `options/Security.tsx`, `App.tsx` |
| The popup's lock-screen line (§6 P2) | `popup/screens/Locked.tsx`; `platform/runtime.ts keysChangedElsewhere`; `core/sync/local/state.ts` |
| The popup's catalog without the line's words where the gate is closed | `scripts/catalog-keys.mjs` (rule 5), `scripts/build.mjs` |
| Text | `scripts/i18n/m6b.py` (the section's in `SYNC_EN`/`SYNC_ZH`; the popup's line, the Security box and the new record kind in the full catalogs) |

### 13.2 The module split and the popup

**The split** (part A §12 item 5, done first): the parts of five modules the popup imports that only the engine uses
moved to modules of their own, so that the bundler, which shares whole modules, no longer puts them in the popup's
chunk once the section uses the rest. `crypto/keybundle.ts` keeps its API and re-exports `capPrevious` from
`cap-previous.ts`; `encoding.ts` re-exports `ID_RE` and `b64` from `basic-encoding.ts`; `subkeys.ts` re-exports the
write proof from `write-proof.ts`; `local/outbox.ts` re-exports the writer from `outbox-writer.ts`; `keptAtTurnOff`
moved to `kept-at-turn-off.ts`. The service imports `cap-previous.ts`, the runtime `outbox-writer.ts`.
`test/unit/m2-source-rules.test.ts` lists the popup's sync modules exactly and fails if `keybundle.ts`, `encoding.ts`,
`subkeys.ts`, `outbox.ts` or `kept-at-turn-off.ts` enter its graph (a mutant that undoes the split is caught).

**The lock-screen line (P2)**, added because the split freed room in the gate-open popup (§13.3): after an unlock
attempt fails, the lock screen reads the sync state once (`keysChangedElsewhere`) and, if the master password or the
keys were changed on another device, or a key change made in this profile's Sync section was sent and not confirmed
(§13.4, "the reset that never reached this device"), says so and links to Settings › Sync. It is read only after a
failure, so an unlock that works reads nothing more (`test/e2e/perf.spec.ts`'s hard gate of 10 reads per unlock caught
the first version, which read on every lock screen). It reads through `platform/runtime.ts`, the popup's one door to
sync (`sync-crypto-hygiene.test.ts`). It is behind the release gate as the section is: `Locked.tsx` reads `__SYNC_UI__`
into a constant of its own (a constant imported from another module is not folded before the bundler decides what to
keep), and `check-dist` checks the line's element id: in no shipped file where the gate is closed, in the popup's code
where it is open (two rules, each with a failing altered build in `m6-check-dist.test.ts`).

**Its words** are looked up inside the gated expression itself (`SYNC_UI && <KeysElsewhere say={...} />`), and the
popup catalog's key collector (`scripts/catalog-keys.mjs`, rule 5) skips the right side of `SYNC_UI && ...` when the
build's gate is closed, `SYNC_UI` being a constant declared as the gate's idiom in that module (any other `SYNC_UI`
skips nothing). The store build's popup catalog is therefore the same as main's; the build still checks the bundle
afterwards (a key the shipped code names and the catalog lacks fails it). Tests: fixtures for the rule
(`i18n-collector.test.ts`), the real tree's popup keys with the gate closed and open (`m6-gate.test.ts`: exactly the
line's four keys differ), the built catalogs (`m6-check-dist.test.ts`).

### 13.3 Measurements

Gzipped, as `check-dist` counts. "Main" is the tree with part A merged.

| | Main | Part B | |
|---|---|---|---|
| Popup, store build (gate closed) | 56,066 B (static 52,074 + zh_CN catalog 3,992) | **56,674 B** (static 52,682 + catalog 3,992) | +608 B, all static: the catalog is main's (§13.2); static: the split's re-exports, the kept vaults' list in the cleanup that every context runs, and the permanent delete's scrub of it, the security record keeping entries of kinds it does not know |
| Popup, store build with the gate open | 59,694 B (58.3 KB) | **58,476 B** (57.1 KB) | the split took it to 57,429 B; the lock line, its words and the kept vaults' code are the rest |
| Settings page entry, store build | 17,997 B | 18,272 B | the Security box, the join's hold, the trash's and the start over's words on the kept vaults |
| `sw.js`, store build | 50,460 B | 51,373 B | the engine's additions (the commits' lock checks, the owed rotation, the security record of actions on the server) and the kept vaults' list |
| Full catalogs | en 9,463, zh_CN 10,747 | en 9,819, zh_CN 11,126 | limit 12,288 B |
| The section's catalogs (e2e build) | en 7,074, zh_CN 7,955 | **en 10,170, zh_CN 11,270** | limit 12,288 B (was 10,240 B; §13.5 item 4) |
| The section's chunk (e2e build) | 18,568 B | 28,430 B | + stylesheet 1,945 B |
| The engine chunk shared with the developer page (e2e build) | 30,245 B | 36,558 B | |
| The section's chunk, store build with the gate open | 45,975 B | 63,748 B | the engine in it |

### 13.4 Security and privacy (what part B adds to §8)

- **Permission first, everywhere**: every new start button (approve, each key operation, revoke, rename, reject all,
  clear history, repair, rejoin, the cloud restore, a separate device, delete the account, rotate the keys) asks
  Chrome as its handler's first statement; `m6-wiring.test.ts`'s rules cover them (and the forms `onClick={open.onX}`,
  `onClick={onX(...)}`, starters passed down by name, and the panel's `permit`). Sync is on for all of them, so a grant
  is sync's own and nothing is given back when they end; deleting the account, which ends sync, gives it back last,
  after this device's identity is gone (a test checks the order at the moment of the removal). The lost-vault card's
  "Restore from the synced vault" asks too: that card is shown whatever the permission says.
- **A lock ends every managing flow** at once and drops its secrets (password, recovery key typed or shown, prepared
  key handles, an approval's state), unless a write is under way: then the write's own outcome ends it, and a failure
  with a lock among its causes is said as the lock (`manage.ts`; tests hold a write on the wire, lock, then release
  it). The device list drops the names at a lock.
- **The engine refuses a key operation's commit after a lock** that the page may not have seen (an idle expiry nobody
  read): a new recovery key and a new password with the recovery key check, before anything is written or sent, that
  the vault is still open under the key they were prepared with (`keys.ts stillOpen`, through requireVk, §4.10), as the
  rotation already did in each pass and the service's first-upload and join commits do (part A). Every key commit's
  session (the password change, the new code, the reset, the rotation, the repair) carries the lock epoch read just
  before its open-vault check (`KeyCommit.epoch`), so a lock while the request is on the wire leaves the page locked:
  the change itself lands (the server accepted it, the local keys follow). An adoption keeps the epoch of its moment: it
  is how a locked page is opened with a secret just typed.
- **Show before commit**: every new recovery key (a new code, a rotation, the rotation of a "lost" revocation, a new
  password with the recovery key) is shown, then two of its groups typed back, before anything of it is sent;
  "unconfirmed" keeps both codes and is never said as done. Every such screen says to keep the old code until Sixkey
  says the change is done. The typed groups start empty for each code (the form is keyed by it), and a typed recovery
  code is emptied as soon as its step is left.
- **"Lost or stolen"** (§3.10: revoke, then rotate; §3.14: revoking is never blocked): where the rotation can be
  prepared, it is prepared and its code shown and typed back before anything is revoked, so Cancel, a lock or a failure
  on those steps leaves nothing done. Then, in this order: the rotation recorded as owed (`sk_sync_state.rotationOwed`:
  the devices about to go, when), the devices revoked (that cuts them off at once; the record then says a revocation
  went, with the server's keys just after it), the rotation sent. Where the rotation cannot be prepared (a round that is
  not "ok", a review waiting, an update the server requires, keys behind, a cleanup due; a wrong password or a lock
  aside), the devices are revoked at once all the same, the record saying why the rotation waits, and the flow ends
  "revoked; the rotation is owed" with "Rotate the keys". A run that stops between the revocation and the rotation (a
  refusal, a lock, the page closing) ends saying the keys still need rotating. The record lasts across locks, closed
  pages and new ones, and the Sync section's danger card says it and offers the rotation until one is in effect. The
  card says a device was revoked only when a revocation is on the record; a run that stopped before it went (the page
  closed between the record and the request) is said as "may not have finished: check the list, revoke it if it is
  still there, then rotate", and a rotation does not clear that record. A rotation the server accepted clears a record
  with a revocation on it; a rotation adopted from another device makes it moot only when it came after the revocation
  (another key than the server had just after it, at a higher kver: the revoked device could have fetched one from
  before). A first revocation refused before any device went takes the record back. This covers the device that wrote
  the current keys (it may have planted a recovery key): only this way is offered for it, and nothing that stops a
  rotation can stop its revocation now. One thing comes before any revocation, as in part A and M3: while the server
  holds keys from another device that this one has not taken (the Sync section's "Update this device"), the password is
  refused at its step (`needs_adoption`), because the server's keys are checked with a key this device holds before a
  password is derived against their parameters (§3.9 R0); the update takes the same master password, and then the
  revocation goes (§13.5 item 14). Turning sync off and removing the sync identity, which delete sync's state, are
  refused while a rotation is owed unless the user ticks "go on anyway: I will rotate the keys from another device"; the
  confirmations say why.
- **Destructive actions confirmed in the page**: revoking (no reason preselected); reject every waiting request, clear
  the server's history, turn off and rejoin (each with the master password; turning off the last device not revoked
  warns that rejoining will need the recovery key, §3.10); delete the sync account (a confirmation, then a fresh
  one-time code, then the master password; a sign-in older than the server allows for it, `step_up_required`, asks for
  a new code); a separate device (master password and name); delete the kept vaults (on an unlocked page, a danger
  confirmation, exactly the entries shown). The lost-vault card's "Start over" leads to the Advanced section, where Phase
  0's start over stays behind typing DELETE: it erases what is left of the unreadable vault, not the kept vaults, which
  its box says when there are any (a static test holds every way into the start-over wizard to that button).
- **The approval**: three tries at the six digits, the scam warning on both digit screens, the claimed name shown as
  untrusted text beside them; the confirmation code appears only once the server accepted the approval, with no Cancel
  then (nothing is left to cancel) and without the master password, which is dropped at that point; Cancel before that,
  with a request answered, rejects it (with the password still held), so the new device stops waiting and the other
  devices do not show it as handled; a second approval lists only requests still waiting.
- **The reset that never reached this device**: a new master password set with the recovery key is one bundle update
  on the server, then the local commit. If the page closes between the two, this profile's keys still open only with
  the forgotten password and the old code. The change was recorded as sent before it went (§3.6.0 `pendingRecoveryWrap`):
  while that record is there, the locked card offers "Unlock with the server's password" (the engine's adoption, which
  opens a locked page) beside the page's own unlock, and the popup's lock line points to it after a failed unlock. The
  same form opens a page whose own keys take the password typed (an unconfirmed new code with the password unchanged).
  A wrong master password or recovery key typed into it, or into any of the section's adoption forms, is recorded in
  the security record exactly as Phase 0's unlock records one (`unlock_failed`, `recovery_failed`: the count the next
  unlock reports). Through this form, as through the `needs_password` card part A already had, a locked page opens with
  the server's current password (§3.9 R3's order), and, while the server is on an older key state, with a former
  password after the "adopt anyway" confirmation (the design's "never locked out" residual); `docs/security/local-vault.md`'s sync
  section is to say so when the gate opens (§13.5 item 13).
- **Names** (device names) are opened with the vault key only while the page is unlocked; while locked a placeholder.
- **Nothing automatic inside the server's backoff** (§4.8, part A's rule for the page's rounds): the page loads the
  device list by itself (on opening, at a lock or an unlock, when requests come or go, after a flow closes) only with
  sync on here and outside the backoff (`devicelist.ts listDue`); the worker ends the backoff and the list follows.
  What the user starts is not held back.
- **The kept vaults** (`sk_prejoin`): a join never replaces one (each join's own is appended; a retry of the same join
  is not written twice), and refuses only when its own would take the list past its bound (`KEPT_MAX`: 8 entries, 2 MiB;
  checked at the join's first step, before anything is sent or written, and again in the write), saying which entries
  to delete; nothing on the list is dropped for room. The join's write is read back whole, earlier entries included, and
  a disk that dropped or changed any of them fails the join. Only the user's confirmed delete removes an entry, on an
  unlocked page. "Delete forever" scrubs the erased accounts out of every kept vault it can open (by the account's
  identity, as in another vault's copies), keeps what it cannot open as it is, and says at that moment how many it
  could not check, with where to delete them (`docs/security/local-vault.md`, `docs/PRIVACY.md` say so too). The page lists them as
  stored and never decrypts them.
- **The security record** gains the actions on the server, each recorded only once the server accepted it, never
  their details: `device_approved`, `device_revoked`, `history_cleared`; `keys_adopted_back` (§3.9 R1: keys this device
  had committed before, taken back from the server without asking, the one such case) beside the Sync section's notice;
  and the wrong secrets typed into the adoption (above). A version keeps the entries of kinds it does not know, and
  the fields it does not know, when it rewrites the record (counted and trimmed like the rest, not shown), so a new kind
  needs no version bump and a downgrade loses no entry (§13.5 item 5).
- **The popup** reads one record after a failed unlock and shows no secret; the line links to the settings page.
- Nothing new goes into a URL, the console, the diagnostics log or the security record beyond the kinds above. The
  clipboard is used only by the code card's Copy (part A's rule).

### 13.5 Decisions and departures, each with its reason

1. **P2's words and moment.** The design's line says "enter the new password"; the popup cannot take keys from the
   server (it carries no sync code), so the new password does not open this device until the Sync section takes it. The
   line says to unlock here with the previous password and take the new one in Settings › Sync ("the keys were
   changed": unlock with the password this device last used, then enter the current one there; "a change made here not
   confirmed": unlock in Settings › Sync with the password set there). It appears after a failed unlock attempt, which
   is when it explains something, and costs no read on an unlock that works; the "keys" variant also appears after a
   plain typo, which is harmless (it is true then too).
2. **Rejoin from the cloud** (`different_vault`, §3.5) is "turn sync off here" (this device revoked with the master
   password; its accounts kept) followed by the ordinary join, which adds this profile's accounts to the synced vault
   and appends the old vault to `sk_prejoin`'s list. The design's single flow (replace the identity, join, revoke the
   old device) is the same steps in another order; doing it with the two tested flows adds no new engine path, and the
   card says what comes next. A join that then fails leaves this profile not syncing, with its accounts, and the
   explanation card's Join offers it again. Since the kept vaults are a list (item 12), no earlier join can block it.
3. **`server_older_key` has no repair**: the engine has none (M3-NOTES lists the gap); its card keeps "Sync now" and
   says what is paused. `keys_behind`'s repair is built.
4. **The section's catalog limit is 12 KB** (was 10 KB), as decided: part B's text takes zh_CN to 11,270 B.
5. **`keys_adopted_back` without a version bump** of the security record, as decided: a version now keeps the entries of
   kinds it does not know (and unknown fields, in an entry or in the record) when it rewrites the record, instead of
   dropping them; a version bump per kind would make an older version leave the whole record alone and stop recording.
   Phase 0's record rules change accordingly (`security-log.ts`; tests: a newer version's kind and fields round-trip).
6. **Start over** (the lost-vault card) leads to the Advanced section's start over, behind its typed DELETE; afterwards
   this profile's new vault is not the synced one, and the card says `different_vault` with its rejoin. As decided, it
   does not erase the kept vaults (they are not the unreadable remains it discards), and its box says so when there are
   any.
7. **The dedupe after an approval join** (rev. 24 §3.5) is not built: it needs the ids the join added kept until the
   first round (a new record of sync's local state, under the naming rules of `m3-source-rules.test.ts`), a step after
   the first round that went through (`engine.ts`, after the merge), the match against live synced entries by secret +
   issuer + label (`addedModeKey`, as the added mode uses), the matches moved to the trash as an ordinary guarded edit,
   and a one-time notice ("N duplicate accounts moved to the trash"). Part A's summary already says the duplicates
   happen on that path.
8. **The Security section with sync on** shows one box pointing to Sync instead of Phase 0's change-password,
   new-recovery-code and rotate boxes, which refuse while sync is on (`sync_on`). While a profile with sync records
   waits for the section to load, it shows neither.
9. **A "lost" revocation shows the rotation's code before it revokes where the rotation can be prepared, and revokes at
   once without it where it cannot** (§13.4, "Lost or stolen"). §3.10 asks for "revoke + rotate" and §3.14 for revoking
   never blocked; on the wire the revocation always comes first, so the device is cut off before the keys change, and
   only the user's steps (showing and typing back the code) moved before it when they can run. For the design author:
   §3.10 could say so, and that the owed rotation is a record with a card.
10. **A device's last sync is shown as the server's day in UTC**: the server keeps it to the day (a UTC midnight); in
    local time that midnight falls on the day before anywhere west of Greenwich.
11. **Not built**: re-importing or exporting a kept vault ("Advanced", §3.5 ④; it needs a key the profile may no longer
    hold after a start over, and a re-import would bring back accounts deleted from the synced vault since the join),
    so only the confirmed delete is there; "recover the accounts" after another device erased them (O13); the old
    browser engines' run (§11). The fork has a crash window: after the server made the new device and before this
    profile switched to it, a crash leaves the old identity here (still valid; the forked notice offers the fork again,
    which makes another row).
12. **`sk_prejoin` is a list** (format 2, `{ v: 2, items }`; a stored single record from before reads as the list's one
    entry, unchanged, and is written as the list only by the next write that changes it). Every join in the added mode
    appends its own entry; nothing is replaced, and a join is refused only past the bound below. For the design author: §3.5 ④ and §4.7's wording,
    and §3.13's list of stored-format changes (no build has shipped, so no older build meets the list).
    - **The permanent delete keeps the kept entries it cannot open** (under a key this profile no longer holds, after a
      start over for example, or damaged), as decided, and says so at that moment (the trash's line: how many, and to
      delete them in Sync if the account must be gone everywhere). The residual: such an entry may hold an account
      erased since, and someone with that old cloud account's password and its server could still open it;
      `docs/security/local-vault.md` and `docs/PRIVACY.md` say so.
    - **Deleting a kept vault** needs an unlocked page and an in-page danger confirmation, not the master password.
    - **A bound**: at most 8 entries and 2 MiB (one `chrome.storage.local` value, rewritten whole at every key change and
      every permanent delete). A join whose own entry would go past it is refused at its first step, nothing written or
      sent, saying to delete kept vaults first; nothing on the list is ever dropped for room. For the design author:
      §3.5 ④.
    - **Two small things left as they are**: an entry's id on the list is the hash of the entry as stored, so two
      byte-identical entries would share one (fresh IVs make that impossible but for duplicated damaged entries, which a
      delete then removes together); the list's rewrites at a key change and at a permanent delete are not read back
      (only the join's is: the same accepted residual as the store's own records on a lying disk).
    - **A crash window, documented**: a join that commits and dies before its cleanup leaves an earlier join's kept
      vault under this profile's key from before the join, which the next cleanup cannot open: kept as it was, no longer
      readable here. The same residual §3.5 ⑥ accepts for the old vault's snapshots; that vault's accounts went into the
      synced vault it was kept for. The crash matrix (`m2-crash-matrix.test.ts`, "added mode over a profile that kept a
      vault from an earlier join") checks that the entry is never lost and allows exactly this.

13. **Before the gate opens** (with part A's §12 item 7): `docs/security/local-vault.md`'s sync section (it gets one when the
    settings page can turn sync on) says what a locked page opens with when sync is on: the server's current password
    (§3.9 R3), and, while a key change is pending or the server is on an older key state, a former password after the
    "adopt anyway" confirmation (the design's "never locked out" residual), each wrong guess recorded as at the lock
    screen.
14. **The one wait before a revocation**: keys from another device not taken here yet (above). Not changed: it is the
    pre-send check's first rule (`core/sync/crypto/presend.ts`), and lifting it would derive the password against
    parameters no key of this device has checked. The update that ends it needs the server's current master password,
    which the revocation needs too; it can itself wait (an update the server requires stops it, as it stops every
    adoption), and then the device cannot be revoked from here until the extension is updated. For the design author:
    §3.14 could say so.

### 13.6 What is shown (additions to §7)

- **Devices** (sync on): each device, this one first; Rename; Revoke (others); "Approve a new device"; "Reject all N"
  when requests wait.
- **Master password and keys**: Change the master password, Make a new recovery key, Rotate the keys (not while the
  server's keys are behind this device's, or an update is required: the box says which).
- **This device**: Turn off sync (a warning when it is the last device; while a rotation is owed, a warning and the tick
  without which it does not go on; the same on "Remove sync identity"); **Advanced**: Clear the server's history,
  Delete the sync account.
- **Vaults kept from before a join** (with sync on or off, when there are any): when each was kept (or "an entry that
  can't be read"), and the confirmed delete (on an unlocked page). The trash says how many "delete forever" could not
  check; the Advanced section's start over says it leaves them.
- **Cards**: `keys_behind` → Repair the cloud's keys; `different_vault` → Rejoin the synced vault; the lost vault →
  Restore from the cloud (Chrome asked first, then the master password), Restore from a backup, Start over (to the
  Advanced section's DELETE box); a rotation owed (danger, over every round status but the lock and a round under way;
  "a device was revoked" only when that is on the record, "may not have finished" otherwise, and why the rotation
  waited) → Rotate the keys; a "lost" revocation whose rotation could not be prepared ends "revoked; the rotation is
  owed" with why and "Rotate the keys"; the locked page with a key change sent and not confirmed → Unlock beside "Unlock with the server's
  password"; the `forked` notice → Make this profile a separate device; a join with the recovery key → its two
  follow-ups.

### 13.7 Tests

New unit tests:
- `m6-manage.test.ts` (22): the managing flows over the FakeServer with the click-only permission stand-in: the device
  list (names, rename, a lock takes the names off; reject all; clear history, recorded only once the server accepted
  it; loaded by the page only outside the server's backoff; the kept vaults as stored; the last device); approving
  (password, list, six digits wrong then right, the code typed there; a wrong password asked again; a request rejected
  and not listed again; a second approval does not list one approved; the password gone once approved; Cancel gives an
  answered request up; a lock ends it; declined); the key operations (a wrong and a weak password stay; change with
  rotation, the code typed back wrong then right before anything is sent; unconfirmed never done; a lock with the code
  shown; a lock during the write waits for it; the new password with the recovery key); revoking (no reason
  preselected; "lost": the code before any revocation, then revoked and rotated in that order on the wire; the
  protect-only case; approved devices ticked); the cards' ways out (repair refused when not behind; the cloud restore;
  a separate device); deleting the account (a wrong password, a stale sign-in asks again, the identity gone before the
  permission; a lock during the check said as the lock, nothing deleted).
- `m6-engine-manage.test.ts` (8): the engine additions: the device list (names only while unlocked), rejecting one
  request, the protect check, the new password with the recovery key (one update, the old code retired, the other
  device takes the new password), the fork, deleting the account, `keys_adopted_back`, the popup line's lookup.
- `m6-key-commit-lock.test.ts` (7): a new code, a new password with the code and a rotation committed after a lock:
  refused, nothing sent, the page locked; a code prepared under keys this device has since replaced: refused before
  anything is sent; a lock while the request is on the wire (a new code, a password change, a rotation): in effect,
  and the page stays locked.
- `m6-revoke-rotation.test.ts` (15): "lost" whose rotation cannot be prepared (offline for its round, a round stopped
  for review, an update the server requires, the server's keys behind this device's): revoked all the same, the
  rotation owed with why it waits; keys from another device not taken here yet: refused at the password, nothing
  revoked or owed, and revoked after the update; stopped before
  anything is revoked (a lock at the code, Cancel, the first revocation refused): nothing revoked, nothing owed; the
  rotation refused after the revocation, a lock during the revocation, the page gone between the two: the end and the
  card say the keys still need rotating until a rotation is in effect; a record with no revocation on it not cleared by
  a rotation, and its card's words; a rotation adopted from another device moot only when it came after the
  revocation; turning off and removing the identity keep the record unless the user ticks to drop it.
- `m6-adoption-guesses.test.ts` (4): a wrong master password or recovery key typed into the adoption, on a locked page
  and through the locked card's form, recorded as Phase 0's unlock records one (one entry per guess), the page still
  locked; the right one records nothing.
- `m6-reset-recovery.test.ts` (2): the reset accepted on the server and not committed here: the new password does not
  open this device, the old code does; the locked card offers the server's password, the popup line points there, and
  that unlock opens the page; an unconfirmed new code with the password unchanged opens it the same way.
- `m6-kept-vaults.test.ts` (4): the kept vaults listed as stored and deleted only as shown, on an unlocked page (a list
  changed meanwhile is not touched); "delete forever" scrubs every kept vault it can open by the account's identity,
  keeps what it cannot open byte for byte and says how many, writing nothing when it opens none; start over's box
  counts them.

Changed: `m6-model.test.ts` (56: the ways out; the owed rotation's card and where it is not shown; the locked card's
offer), `m6-wiring.test.ts` (the rules' new forms; the start over only behind the typed DELETE), `m6-gate.test.ts` (the
gate's two readers; the popup's catalog with the gate closed and open), `m6-check-dist.test.ts` (17: the 12 KB
limit; the lock-screen line in a closed and an open build; the built popup catalogs), `i18n-collector.test.ts` (rule
5), `m2-source-rules.test.ts` (the popup's sync modules; the split kept), `m3-source-rules.test.ts` (the outbox's
writer), `security-log.test.ts` (the new kind kept; a newer version's kinds and fields kept when the record is
rewritten, counted and trimmed, not shown), `m2-sync-local.test.ts` (the kept vaults' list: the cleanup per entry, a
single record from before as one entry, every join appended, a retry not twice, the read-back of every entry, the
bound, the confirmed delete), the regression tests that pinned the refused second join (`m2-review.test.ts`,
`m2-rereview.test.ts`, `m2-service.test.ts`: now appended, the earlier entry kept; a join past the bound refused at its
first step, nothing written), `m2-records.test.ts` (the list's entry), and the crash
matrix (`test/helpers/m2-crash.ts`: list-aware checks, and a new operation, an added-mode join over a profile that kept
a vault from an earlier join, whose kept vault must survive every crash point, a lying disk included).

End to end (`test/sync/m6-section.spec.ts`, 5 tests, against the real API server): the recovery-code test also makes
a new recovery key and changes the master password in the first profile; the second profile's lock screen shows the
line after the new password fails, the old one opens it, and its section takes the new one; then it turns off. The
approval test approves from the first profile's section: a wrong six digits first, the code typed on the new profile;
both devices listed by name; the new one revoked as "still mine" (no reason preselected); the sync account deleted. A
test joins with the recovery key as a user without the master password and sets a new one with the code (a new code
shown first; one `PUT /v1/keys`), the page keeping the follow-up until it closes. With sync on, the Security section
shows its pointer to Sync, and after turning off Phase 0's boxes again. Request counts are per test.

**Mutation check (part B).** 97 hand-made mutants run one at a time against the unit tests covering the module
(96 killed; one untested: "cancel keeps a flow's secrets", which no test can observe since the secrets are private
fields, and which code review holds instead), and 3 that only end-to-end tests can see, run against those (3 killed).
The runners are outside the repository. `codesteps.tsx`'s key on the typed-back form is not counted: the code never
changes while that form is shown, so a mutant of it would be equivalent.

| Set | Mutants | Killed |
|---|---|---|
| The managing flows' rules: declined goes on; a lock not ending a flow; a lock ending it under a write; a lock not said as one; cancel keeping the secrets | 5 | 4 (one untested) |
| Revoking: a reason preselected; "still mine" for the device that wrote the keys; approved devices unticked; the rotation without the groups; "lost" not rotating | 5 | 5 |
| The key operations: without the groups; unconfirmed said as done; a code sent before it is shown; a weak password ending the flow; the rotation prepared with the old password | 5 | 5 |
| Approving: a wrong password ending it; requests no longer waiting listed; a wrong six digits ending it; the password kept after approving; Cancel leaving an answered request | 5 | 5 |
| The device list: names kept at a lock; inside the backoff; the last device not told | 3 | 3 |
| Deleting the account: the permission before the identity; the identity left; a stale sign-in ending it | 3 | 3 |
| The engine: `keys_adopted_back` recorded as `keys_adopted`; the log not knowing the kind; the protect check never protecting; a fork keeping the identity, the edit suffix; the reset leaving the password verifier; the popup told "keys" for a password; the lookup ignoring the key status, a pending change | 9 | 9 |
| A key commit and a lock: a new code, a new password committed after a lock; the session not bound to the epoch; the epoch read after the check; a commit under other keys | 5 | 5 |
| "Lost": revoked before the code; no rotation owed; the owed rotation not said; a refused first revocation keeping it; a rotation in effect leaving it; not kept in the state; moot not seen; the card hidden; the card over the lock | 9 | 9 |
| The reset not committed: the locked card without the offer; a local adoption leaving the page locked | 2 | 2 |
| The kept vaults: a join replacing one; a retry written twice; a read-back of the new entry only; a delete of what was not shown; the cleanup dropping what it cannot open; a single record rewritten without need; "delete forever" leaving them; dropping one it cannot open | 8 | 8 |
| The split and the gate: the runtime importing `outbox.ts`; the service importing `keybundle.ts`; the line rendered without the gate; the catalog limit raised; each `check-dist` rule for the line dropped; the collector skipping nothing, taking any `SYNC_UI` for the gate; the build ignoring the gate for the popup's catalog | 9 | 9 |
| The cards' ways out, the parked "vault" reason's words; the cloud restore without asking; the start over without its typed confirmation | 7 | 7 |
| The wiring: deleting the account started without asking | 1 | 1 |
| The security record of actions: an approval, a revocation not recorded; a history clear recorded before the server accepted it | 3 | 3 |
| Wrong secrets in the adoption: not recorded; a recovery key recorded as a password | 2 | 2 |
| Revoking never blocked: a rotation that cannot be prepared blocking the revocation; revoked without a record; the record never saying a device went; the card saying one went when none is on the record; a rotation from before the revocation making it moot; a rotation clearing a record with no revocation | 6 | 6 |
| Leaving sync with a rotation owed: turning off, removing the identity forgetting it without the tick | 2 | 2 |
| The kept vaults: deleted on a locked page; the list past its bound; the join's first step not checking the room; the permanent delete not saying what it left; start over's box never seeing them | 5 | 5 |
| The security record's unknown entries: dropped at a rewrite; a newer version's record fields dropped; shown | 3 | 3 |
| End to end: the popup line read on every lock screen (`perf.spec.ts`'s read gate); the join's follow-up not kept on an empty profile's page; the section's device list loaded inside the backoff (`outage.spec.ts`) | 3 | 3 |

**Found while building part B** (each fixed, with a test): the popup's line read on every lock screen broke the
popup's read gate; the recovery-code follow-ups vanished on an empty profile's page (the page switched to its usual
sections when the join made the vault); the typed-back groups could be emptied after the user typed them; a stale
sign-in (`step_up_required`) ended the account deletion instead of asking for a new code; the approval offered Cancel
after it was accepted; a device's last sync showed the day before west of Greenwich; the device list was loaded
inside the server's backoff. Found after the first version, and fixed as §13.4 says: the key commits after
a lock; the "lost" revocation that could end revoked and not rotated; the start over without its typed confirmation;
the reset that could leave a locked profile with no screen offering the new password; the kept vault that blocked
every later join; the cloud restore without asking Chrome; the typed recovery key kept past its step; the answered
request left behind by Cancel; the last device's warning; the key operations' words when an update is needed; the
Security section's boxes before the section knew whether sync is on. Found after the second version, and fixed as
§13.4 says: a "lost" revocation that waited for the rotation (it now goes first, whatever the rotation's state); the
adoption's wrong guesses not recorded; the owed card claiming a revocation that may not have gone; a rotation from
before the revocation taken as making it moot; leaving sync losing the owed rotation silently; the kept vaults deleted
on a locked page and without a bound; the security record dropping a newer version's entries.

**Full runs** (part B's final state): unit tests 155 files, 2,169 passed, 4 expected failures (the existing `it.fails`
markers), 1 skipped, none failed; `tsc --noEmit` clean; `npm run e2e` (store, e2e and dev builds, each with
`check-dist`, then the existing end-to-end tests) 102 passed; `npm run e2e:sync` 9 passed; the store build with
`check-dist`, gate closed and open. Two tests were added to `m6-revoke-rotation.test.ts` after those runs (the server's
keys behind, keys not taken yet; no source changed): that file again, 15 passed. Part B's screens were looked at in light and dark, at 1,100 and 420 px wide
(screenshots from a scratch script outside the repository), before the last additions: the "revoked; the rotation is
owed" end, the tick on leaving sync with a rotation owed, and the trash's and the start over's lines on the kept vaults
were checked through the unit tests only (they reuse the existing callout and checkbox styles).
