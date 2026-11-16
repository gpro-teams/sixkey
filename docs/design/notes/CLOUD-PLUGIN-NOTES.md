# The official cloud backup plugin: the split (42903a1) and its follow-ups (2026-11-03, 2026-11-04)

> **Superseded, 2026-11-08.** The Google Drive backup through a plugin is withdrawn, and the backup in Chrome sync
> replaces it: see [CSB-NOTES.md](CSB-NOTES.md). The plugin is not published; these notes record it as it was built,
> and its code, unwired in every build since CSB-3, was removed in CSB-R (CSB-NOTES.md §16).

The owner asked, on 2026-11-02, "把云备份功能做成官方插件吧": cloud backup as an official plugin. Commit 42903a1 made the
split, with a one-line message; an independent review then found two MUST and a dozen SHOULD findings, A-1 to H-1. The
first follow-up (9f6f0a6) implements the maintainers' decisions on them. Its own independent review said "merge, no
MUST" and listed N-1 to N-11, with an open variant of A-2; the second follow-up implements the maintainers' decisions
on those (OWNER-DECISIONS/21): §3.4 and §3.5, and §6, what can be uploaded to the store and the first uploads, which
had to be settled before any upload. Its review in turn said "merge, no MUST" and listed N2-1 to N2-6; the third
follow-up implements the maintainers' decisions on those (§3.6): Sixkey's own store package refused while its store ID
is not pinned, a connect that holds no message open while the user signs in, and a Cancel on the card. These notes
record the split as 42903a1 made it (§1), the flows as they are now (§2), each finding and what became of it (§3),
what was measured (§4), what is not proved (§5) and the release (§6).
The design of the backup itself is still [CLOUD-BACKUP.md](../proposals/CLOUD-BACKUP.md) and
[CLOUDBK-NOTES.md](CLOUDBK-NOTES.md); the plugin's own README is `extension/plugins/official/cloud-backup/README.md`.

The owner's standing rules this work is held to: backup is one click, automatic, with its status in view; warn, do not
block; every doc claim true of the code; no store listing copy and no internal paths in the tracked tree.

## 1. The split, as 42903a1 made it

### 1.1 The boundary

| Sixkey (the core)                                                                                         | The official plugin (`extension/plugins/official/cloud-backup/`)                                      |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| when a backup runs, and what one run does (`src/platform/cloud-worker.ts`), locked or not                 | Google sign-in (`src/platform/google-auth.ts`, `google-connect.ts`), its OAuth clients (`provider.json`) |
| the encrypted cloud file (`src/core/cloud/format.ts` `makeCloudBackup`), the account pin, the write and cleanup rules (`remote.ts`, `rules.ts`) | the Drive requests (`src/core/cloud/drive.ts` over `src/platform/google-transport.ts`), from its worker only |
| the restore: listing through the plugin, opening the files with what the user typed, in Sixkey's page    | Google's tokens, in its own memory and session storage, never sent to Sixkey                        |
| the approval of the plugin, and every check of it before a write                                          | refusing anything but Sixkey's encrypted cloud format before it reaches Google (`parseCloudBackupText`) |

The production core lost `identity`, `oauth2` and Google's CSP origins (check-dist holds it); the developer build keeps
its diagnostic Google page (CLOUDBK patch 3), and the e2e core keeps its in-extension fake Drive.

### 1.2 The protocol

`src/core/cloud/provider.ts`, `sixkey-cloud-provider/1`. Sixkey sends `{protocol, id, op, args}` with
`chrome.runtime.sendMessage(pluginId, …)`; the plugin answers `{protocol, id, ok, value}` or `{…, ok: false, code}`.
The operations are the `DrivePort`'s (`about`, `get`, `update`, `create`, `ensureFolder`, `list`, `download`,
`revisions`, `deleteRevision`, `deleteFile`, `findFolder`) plus `status`, `connect`, `drop` and `disconnect`. There is no
request the other way: the plugin cannot ask Sixkey for anything. Each request has a random 128-bit ID; Sixkey matches
it, bounds the answer to 9 MiB and 65 s, and maps any unknown error code to `no_token`, so Google's error texts never
cross. (Since the third follow-up, `connect` answers at once with a ticket, and `connectState` and `connectCancel` name
it: no answer waits for the user, §2.2, §3.6.) That change of the connect answer's shape kept the name
`sixkey-cloud-provider/1` because neither side has been released (N3-5); once they are, the two store items update
separately, and a change of shape needs a new protocol version, or both shapes taken for a while.

### 1.3 The grant

`backups.transport`, a new SDK capability (`contract/plugin-sdk/src/types.ts`, the schema, `descriptor.ts`), offered,
official-only (`policy.ts` `ceilingOf` strips it from listed and unlisted plugins), Sensitive on the approval screen and
in Settings › Plugins (`PluginApproval.tsx`), with the words "Transport encrypted backup files after you enable backup.
Cannot decrypt them; the file can be used to guess your password offline". The catalog's official entry for the plugin
has the ceiling `["ui.slots", "backups.transport"]`. Sixkey checks the grant before every write
(`src/platform/cloud-provider.ts` `providerEnabled`); a restore's reads need no record at all.

### 1.4 What moved

- Into the plugin: Google sign-in and transport (imported from the core's tested modules, not copied), the token, the
  OAuth client IDs (`scripts/google-oauth.mjs` keeps only the developer page's), the CSP's Drive paths.
- New in the core: `src/platform/cloud-provider.ts` (the caller), `src/core/cloud/provider.ts` (the protocol),
  `src/platform/cloud-ask.ts` (where the plugin stands), and the build's `__CLOUD_PLUGIN_ID__`.
- Changed in the core: the worker's session is the plugin's (`providerSessions`) and its readiness the plugin's
  (`providerReady`); the card's "plugin required" state; a worker storage listener on the grant records (§3.3).

## 2. The flows now

### 2.1 Pinned IDs (A-1; C-1 steps 4 and 5)

The plugin is built for a fixed set of Sixkey IDs (`plugins/official/cloud-backup/build.mjs`, `src/config.ts`
`SIXKEY_IDS`): the store build for `STORE_ID` (`extension/scripts/store-id.mjs`), refused while it is empty; `--dev` for
the ID of `manifest.dev.json`'s key (`SIXKEY_DEV_ID`); `--test --core-id <id>` for the unpacked Sixkey a browser test
read from a profile first, as the other plugin tests do (`test/e2e/cloud-plugin-helpers.ts`). Its
`externally_connectable.ids` is exactly that set; its worker takes provider messages and SDK events from that set alone,
from one of Sixkey's own pages or its worker, and answers anyone else nothing at all (A-4). It says hello to those IDs
at every start, and again before answering a status if that Sixkey did not take it yet. The ID field, "Connect
Sixkey", "Forget" and their storage (`sixkey_core`) are gone. A fork sets its Sixkey IDs where Sixkey's builds already
take them, and the plugin's own ID in `provider.json` and the catalog (the README's "Forks").

The plugin's ID, which Sixkey pins, is written once in `provider.json`. A catalog's official entry with
`backups.transport` must be that ID, with its store page, or the core's build stops (`scripts/cloud-plugin.mjs`); a unit
test holds both shipped catalogs to having it (D-2). A catalog with no such entry still builds (a fork without the
plugin, and the tests' catalogs of other shapes). The core's store package is refused
while that ID is still the local-development identity, whose public key is in this repository (`scripts/package.mjs`
`providerGate`), and while Sixkey's own `STORE_ID` is empty or the developer build's ID (`storeIdGate`, N2-1); so is
the plugin's own store build, by the same two checks (§6). `--local-only` builds Sixkey for loading unpacked and
writes no zip; the first uploads, which only get the two store IDs, are ID drafts of their own (§6).

### 2.2 No second click in Google's step (C-1 steps 7 and 9)

`identity` is a required permission of the plugin (Chrome shows no install warning for it: §4.1), so nothing has to be
asked for in a gesture. When Sixkey asks it to connect, its worker opens its window (`settings.html?connect=<ticket>`)
and answers at once with that ticket, a random 128-bit one of its own (`src/connect.ts`). The page starts the
authorization as it loads (`getAuthToken` on Chrome's path, `launchWebAuthFlow` on the web path), writes its result
under the ticket, and closes itself. No message waits for it (N2-5: Chrome may stop an extension's worker whose one
event runs past five minutes, and Google's sign-in on a new computer, two-step verification included, takes minutes):
Sixkey's page asks `connectState` every second (`src/platform/cloud-provider.ts` `providerConnect`), each answered at
once from the plugin's `storage.session`, which holds the worker's record (when, the window's ID), the request's
arguments and the window's result, each under a key of its own (below, N3-2). A worker Chrome stopped and started in
between answers the next question from them as if it had kept running. The answer is `pending`, `done` (with the
sign-in path), `failed`, `cancelled` (the window closed with no result: by the user, or by the card's Cancel through
`connectCancel`) or `gone` (no record: the plugin reloaded or updated meanwhile, or the record expired); whatever ends a
connect closes its window and removes its keys. The deadlines, outermost first: the page's 11 minutes, the plugin's
record's 10.5, the window's 10 (it gives up and closes itself then, whether or not anyone still asks; §3.4, N-2). The
page has no button and no input; opened with a ticket the worker has no record of (another extension can open it), it
asks Google for nothing and writes nothing (N-7). Only the pinned Sixkeys can ask about a ticket or cancel it, and
only they are told it.

Measured (§4.2): Chrome's `getAuthToken({interactive: true})` in that window, with no gesture, opened Chrome's sign-in
while the computer was in use, and was refused with "User interaction blocked due to user inactivity." in a run where it
was not. `launchWebAuthFlow({interactive: true})` opened its window both times. So Chrome asks for **recent user
activity** on its own path, not a click in the plugin's window: right after the user's click in Sixkey there is some.
If Chrome refuses anyway (the user walked away while the plugin was being installed, say), the window closes, the card
says "Couldn't connect to Google Drive. Try again." and keeps its button: **exactly one click**, in Sixkey, is kept for
that path, and nowhere else. Nothing is approved on that path (§2.4).

While the window waits, the card says "Sign in to Google in the Sixkey Cloud Backup window. Can't see it? It may be
behind other windows." and offers **Cancel** (N2-6). What a Cancel does depends on when it lands (`act.ts` `connect`):

- **While the window waits for Google's sign-in**: the connect ends through the plugin, which closes its window; the
  card goes back to where it was, with nothing approved, backup not turned on and no error.
- **With the sign-in's answer**: the same. The answer is dropped (`providerConnect`) or, if it came first, `connect`
  finds the Cancel just after it; nothing is approved.
- **Once the sign-in is done**: there is no Cancel any more (N3-1). `connect` tells the card at that moment
  (`signedIn`), and the card takes the Cancel and the line away; it says "Connecting to Google Drive…" while the
  approval is written and the worker asks Google for the account, and then shows the backup's status. "断开" is the
  way back. No Cancel can land between `signedIn` and the approval: there is no `await` between them, and the card
  takes the button away before a click can be dispatched. One more look right before the approval is written is a
  backstop all the same (its test aborts from `signedIn` itself): an abort found there ends the connect, nothing
  approved; after that no abort is looked at.

A window the user closes by hand ends the connect at the card's next question, with "Couldn't connect to Google Drive.
Try again.". The restore's first step signs in through the same window and has the same line and Cancel while it
waits; cancelled, it gives its "从 Google 云端硬盘恢复" button back, and once signed in, while the files are listed, it
has no Cancel either.

What the plugin keeps for a connect, and until when (N3-2; `connect.ts`, `settings.ts`; PRIVACY "On this computer"),
with nothing that wakes its worker when no connect is under way (the owner's low machine load: no listener for
windows closing, which would start the worker for every window of the browser):

- **The request's arguments** (`connect-args:<ticket>`: the sign-in path and the account hint), apart from the record:
  the window removes them, and waits for that, before it closes itself (its result written, or its 10 minutes up);
  whatever ends the connect removes them too.
- **The record and the result** (`connect:<ticket>`, `connected:<ticket>`): removed by whatever ends the connect, an
  answer that is not `pending` (done, failed, cancelled, gone) or Cancel; a window the user closes is found closed at
  the next question, within a second while Sixkey's page is open.
- **A connect no one asks about any more** (Sixkey's page closed meanwhile): ended by its one `chrome.alarms` alarm,
  set as it starts for its record's end (10.5 minutes) and cleared by whatever ends it earlier, so at most one extra
  start of the worker per connect; and, should Chrome drop that alarm, by the tidy at the worker's next start (a start
  that happens anyway), which ends whatever is past 10.5 minutes or has a closed window and no result, and removes the
  arguments of a closed window that wrote one.
- All of it is in `storage.session`, gone when the browser closes.

### 2.3 No host permission (C-2)

The plugin's manifest has `storage`, `identity` and `alarms` (a connect's one alarm, §2.2; the build refuses any other
permission) and no `host_permissions`. Drive's API and Google's revocation answer
an extension's CORS request (measured on 2026-10-30, CLOUD-BACKUP.md §2.5), and Sixkey's own builds reached Drive
without a host permission before the split. The CSP's three `connect-src` paths stay.

### 2.4 Consent folded into the one click (C-1 step 11)

`src/options/cloud/consent.ts` `approveCloudPlugin`, called by the card's connect (its "备份到 Google 云端硬盘", Resume
and Reconnect, another account's "回到 …", and the popup's and first run's handoffs, which open the card connecting) and
by a restore's last step (`act.ts` `adopt`). It writes the approval Settings › Plugins' Allow writes, through the same
code: what the plugin's latest hello asks for within the catalog's ceiling (`policy.ts` `grantsOf`, moved there from
`PluginApproval.tsx`), `grantStore().approve` under `withFreshKeys`, a tagged write with the vault key; then
`grants.changed` to the plugin, as Allow sends it.

- **After Google's consent** (N-9). The card's connect first checks, writing nothing (`checkCloudApproval`: locked, or
  not a plugin Sixkey can approve, and Google is not asked at all), then asks the plugin to connect, and writes the
  approval only once that succeeded, checking everything again as it writes. A cancelled or failed sign-in leaves no
  approved plugin behind. `connect` itself needs the plugin eligible only (pinned, official with the transport in its
  ceiling, on in Chrome: `providerEligible`), not approved; it carries no backup, and only these pages ask for it, on
  the user's click. The restore's approval stays at "完成", once the vault it is written under exists.
- **Only the pinned official ID.** `CLOUD_PLUGIN_ID`, and only while the build's catalog says official (a copy Chrome
  reports as unpacked, with `management`, is unlisted and refused). Listed and unlisted plugins cannot hold
  `backups.transport` at all. Nothing but these pages' own code calls it: no message, from any plugin, starts it.
- **The cost line stays where the click is made**: on the card ("It opens with your master password or recovery key.
  Anyone who gets into your Google account could try to guess your master password…") and now on the restore page too,
  with "After the restore, this computer goes on backing up to the same file, through the Cloud Backup plugin." The
  popup's **立即备份** has no room for it and opens the card, which shows it while it connects, before Google's consent
  and before the approval is written (N-8). Another account's "回到 …", which approves the plugin again as a side
  effect when it is not approved, has the line beside it with "This also approves the Cloud Backup plugin again." (N-5).
- **Unlock first.** The approval needs the vault key: on a locked page the card's button waits, with "Unlock Sixkey
  first…" beside it; the restore's last step runs with the new vault open.
- **Settings › Plugins** lists the approval as any other, the transport under Sensitive; Off, Remove or a narrower
  ceiling stops writes at once (the card then says "Backup paused: Cloud Backup is not approved in Settings › Plugins
  (turned off, removed, or waiting for confirmation after an update).", keeps 断开, and its Resume approves again).
- **Not approved is said as itself** (N-6). An approval that cannot be written, the plugin being there (no descriptor of
  its own yet, a key change's clean-up still due), says "Couldn't approve the Cloud Backup plugin. Try again in a
  moment; Settings › Plugins shows where it stands.", never "Couldn't connect to Google Drive". The plugin counts a
  Sixkey as told of its descriptor only once that Sixkey accepted the hello (`ok`, for that hello's ID), and says it
  again before a status asked a minute later, so a Sixkey updated while the plugin's worker ran gets it back.
- **After a restore** the worker's first run finds the plugin approved, so it goes on with the same file, no further
  step (`test/e2e/cloud-plugin.spec.ts`, "a new computer").

### 2.5 The install step (C-1 step 2, B-1, B-2)

- The catalogs' official entry has `"store": "https://chromewebstore.google.com/detail/<the plugin's ID>"`.
- The card, with the plugin missing (not installed, off in Chrome, or built for another Sixkey: it answers no other),
  stays the card. Backup off: its one button opens that store page in a new tab, says to add it there, and looks for the
  plugin every 3 s (`model.ts` `WATCH_MS`); once it answers, the card carries on by itself (approval and connect) if the
  click was within 10 minutes. Backup on: "Backup paused: the Sixkey Cloud Backup extension is missing or turned off in
  Chrome.", the last backup's time, the store link and **断开**, so backup can always be turned off in Sixkey (B-1).
- A restore without the plugin says what to install, links it, hides its "try again", and starts by itself once the
  plugin answers (B-2). With a plugin that has no Google client, both say so.

### 2.6 What the user does, counted

Chrome, the store's builds, both on one computer: every click and every Chrome or Google dialog.

**First-time setup** (a vault on this computer, the plugin not installed):

1. Settings › Backup, the card: **备份到 Google 云端硬盘**. The plugin's store page opens in a new tab. (1 click)
2. The store page: **Add to Chrome**. (1 click)
3. Chrome's dialog "Add Sixkey Cloud Backup?": **Add extension**. It lists no permission (§4.1). (1 click, 1 dialog)
4. Nothing: Sixkey's card notices the plugin within 3 s, checks that it can approve it, and the plugin's window opens
   and starts Google's authorization by itself.
5. Google's consent (Chrome's own window): the account, if Chrome knows several, then **Allow**. (1 click, or 2; 1 dialog)
6. Nothing: the plugin's window closes by itself, the card approves the plugin, and it says "Backed up to Google Drive ·
   just now".

4 clicks (5 with several Google accounts), 2 dialogs. With the plugin installed already: steps 1, 4, 5, 6: 2 clicks
(3), 1 dialog. The page must be unlocked (step 1 says so if it is not). The popup's **立即备份** (backup off, no backup
for 7 days) is the same as step 1, from the popup.

**A new computer** (Sixkey installed from the store and its first run open: from the toolbar, its icon and **开始**,
2 clicks, as before the split; the plugin not installed):

1. First run: **从 Google 云端硬盘恢复**. (1 click) The step says the restore goes through Sixkey Cloud Backup.
2. Its link **获取 Sixkey 云备份**: the store page opens. (1 click)
3. The store page: **Add to Chrome**. (1 click)
4. Chrome's dialog: **Add extension**. (1 click, 1 dialog)
5. Nothing: the restore notices the plugin and starts by itself; the plugin's window opens and starts Google's
   authorization.
6. Google's consent: the account if several, **Allow**. (1 click, or 2; 1 dialog) The window closes by itself.
7. "Found N backups in your Google Drive", with the cost line: type the master password or recovery key, **打开** (or
   Enter). (1 click)
8. First run's profile question, "only me" chosen already: **完成**. (1 click) The vault is written, the plugin approved,
   and this computer goes on backing up to the same file.

7 clicks (8 with several Google accounts) and the password, 2 dialogs. With the plugin installed already: steps 1, 5,
6, 7, 8: 4 clicks (5), 1 dialog. Before the split (CLOUD-BACKUP.md §0.1) it was steps 1, 6, 7 and the profile question;
42903a1's was the review's eleven steps (§3, C-1).

## 3. Each review finding, and what became of it

| Finding | Level | What it said | Now |
| --- | --- | --- | --- |
| A-1 | MUST | the plugin trusted a typed Sixkey ID, over messages, against SDK §3.3 | **Fixed.** Pinned IDs per build; no typing, no pairing, no storage (§2.1). `cloud-plugin-sw.test.ts`, `cloud-provider.test.ts`, `cloud-provider.spec.ts` (another extension refused by Chrome) |
| A-2 | SHOULD | "tighten-only projection" was not true: `unverified()` can loosen | **Docs made true** (§3.2): ARCHITECTURE, SDK §6.6 item 3's exception, `cloud-provider.ts`'s comment |
| A-3 | SHOULD | the core took the plugin's values unchecked | **Fixed.** `readProviderValue`: every answer's shape, field for field, as `drive.ts` gives it, else `bad_response`. `cloud-provider.test.ts` (22 bad shapes) |
| A-4 | NIT | the plugin answered `status` to any extension | **Fixed** with A-1: no answer at all to anyone else |
| A-5 | NIT | replay set in memory; the plugin's deadline after the core's; the size refused as `rejected` | **Fixed / said.** The README says the replay set lives while the worker runs; the plugin answers by 55 s (115 s for connect), before Sixkey's 65 s and 125 s; over Drive's 5 MiB is `too_large`. `cloud-plugin-sw.test.ts`, `cloud-provider.test.ts` |
| A-6 | NIT | reads allowed whenever there is no record, not only before a vault | **Docs made true**: "while no approval record exists", SDK §6.2, the README, the comment. `cloud-provider.test.ts` |
| B-1 | SHOULD | without the plugin the card hid its status and 断开 | **Fixed** (§2.5). `cloudbk-pages-dom.test.ts`, `cloud-plugin.spec.ts` |
| B-2 | SHOULD | a restore without the plugin said "try again" | **Fixed** (§2.5). Same tests |
| C-1 | MUST | no longer one click: eleven steps | **Fixed** as decided: steps 2 (store link), 3 (no host permission), 4 and 5 (pinned IDs), 7 and 9 (no click in the window, which closes itself), 11 (approval in the one click). §2.6 counts what is left. `cloud-plugin.spec.ts` counts every click |
| C-2 | SHOULD | `host_permissions` not needed | **Fixed** (§2.3). The test that pinned them now pins their absence; `cloud-plugin.spec.ts` measures the warnings |
| D-1 | SHOULD | no test of the plugin's store build | **Fixed.** `cloud-plugin-build.test.ts` builds every mode in a private copy: the refusal, the manifest, the CSP, icons and locales, no fake or test hook outside `--test`, `oauth2` only with a client, the package, and none from `--test` |
| D-2 | SHOULD | the catalog pinned the local-development identity, with no gate | **Fixed** (§2.1): the catalog check in the build, the shipped catalogs' in a test; the package gate with `--local-only` |
| D-3 | NIT | no icons, no `_locales` | **Fixed.** Sixkey's icon art, copied by the build; `_locales/en` and `zh_CN`, `default_locale: "en"`. The store's acceptance of `key`: §5 |
| E-1 | SHOULD | the plugin page's words inline, English titles | **Fixed.** The page and the manifest take their words from the plugin's `_locales` (`chrome.i18n`, the browser's language) |
| E-2 | SHOULD | `ckPausedHint`, `ckPluginRequired`, `ckPluginSettings` untrue or ambiguous | **Fixed.** Each paused state says which (missing, off in Settings › Plugins, unconfigured); the hint no longer promises a withdrawal; "Open Settings › Plugins". `ckForbidden`, `ckDisconnectHint`, `ckUnrevoked` keep "Sixkey" for the app in the Google account, which PRIVACY defines as the core and the plugin together; the consent screen's app name is the publisher's setting (§5) |
| E-3 | NIT | stale comments and a test name about `identity` in the click | **Fixed.** The rule "askProvider as a click's first statement" went with the permission it was for; `cloudbk-auth-rules.test.ts` now holds that the pages ask Chrome for nothing and the plugin's page has no button |
| F-1 | SHOULD | PRIVACY:183 "continues the newest file" was not true | **True now** (§2.4), and PRIVACY says how |
| F-2 | SHOULD | ARCHITECTURE "tighten-only projection" | **Fixed** with A-2 |
| F-3 | SHOULD | CLOUD-BACKUP.md and CLOUDBK-NOTES still described the store build's `identity` | **Fixed.** Each has a note at its top |
| F-4 | NIT | no `backups.transport` row in SDK Appendix B | **Fixed** |
| F-5 | NIT | "before a new vault exists", "rejects replayed IDs" | **Fixed** with A-5 and A-6 |
| F-6 | NIT | "migration" and "the original Google project", with no release that had Google clients | **Fixed.** Gone from the README and PRIVACY |
| G-1 | SHOULD | the one-click e2e ran against the core's own fake | **Fixed.** `test/e2e/cloud-plugin.spec.ts` runs the store build with the plugin's test build: first-time setup, the popup, a new computer, the plugin missing and added later. `cloud-pages.spec.ts` keeps the e2e core's states, titled as such |
| G-2 | SHOULD | M1, M2, M4 survived | **Killed**, each by a named assertion (§4.3) |
| H-1 | NIT | a worker listener rule relaxed without a record | **Recorded**: ARCHITECTURE "The worker's storage listeners", and §3.3 |

### 3.1 What the maintainers decided, and how each is built

The decisions (pinned IDs, no second click, no host permission, the approval in the one click, the install step) are
§2.1 to §2.5. Where a decision left a choice:

- **One build config.** The plugin's `build.mjs` reads Sixkey's IDs from where Sixkey's own builds take them
  (`STORE_ID`; `manifest.dev.json`'s key), so nothing is written twice; the plugin's own ID is `provider.json`'s, and the
  catalog must equal it.
- **The store build's refusal** comes first, before Vite runs, so a refused build leaves no `dist/` behind.
- **The "missing" state** is "does not answer": Sixkey holds no `management` for an official plugin, and a plugin built
  for another Sixkey answers nothing either. The card's text says "missing or turned off in Chrome".
- **The carry-on window** is 10 minutes after the click that opened the store page; after that the card only redraws.

### 3.2 Why the locked check stays advisory (A-2)

A sound check (SDK §6.6 item 3: no grant counts unless its tag verifies) needs the vault key. The worker uploads with the
vault locked (CLOUD-BACKUP.md §1.2): in "lock every time" mode it never holds the key, and after every browser restart it
holds none until an unlock. Only `storage.session` could keep a baseline from the last unlock, and it is empty after a
restart; a check built on it would pause every backup after a restart until the user unlocks Sixkey in the right
context, and in "lock every time" mode until a page wrote it. That is the "形同虚设" backup the owner ruled out. So the
check reads the record without its tag (the overlay's suspensions and removals and the session's pauses still apply,
which only tighten), and the docs say so: against a `storage.local` writer it is advisory. Such a writer can turn an Off
back on. It gains nothing it does not have: the upload still goes only to the pinned official plugin, only to the Google
account the user connected (the pin is checked by Drive's `about` before each run), and it is the encrypted generation
that writer can read on disk anyway. The approval itself is written with the tag (§2.4). Integrity and availability
are the other side of the same advisory check (N-10): turned back on, the worker's runs also replace the file and prune
its older versions (`update`, `deleteRevision`, `deleteFile`: `PROVIDER_WRITES`), so such a writer can make the cloud
copy an older generation its disk holds, or thin its history; it could do as much while the plugin was on. What the
check honours is also no longer what a vault reset left behind (§3.5).

### 3.3 The worker's storage listener (H-1)

42903a1 added a `storage.local.onChanged` listener to `src/background/sw.ts`, on `sk_plugins` and `sk_plugins_overlay`,
and widened `autofill-pre-source-rules.test.ts`'s rule, which had been "no storage listener in `background/` or
`offscreen/`", to allow it. Kept, and now recorded (ARCHITECTURE, "The worker's storage listeners"): it shows an Off or a
new approval on the backup's status at once, and starts a run when the plugin is ready again. It takes only the two
keys' names from a change and asks `providerReady`, which reads the records itself; no write depends on it, since every
upload checks the approval itself. A forged write that fires it can only make the worker ask that same check.

### 3.4 The second review (9f6f0a6): N-1 to N-11

| Finding | Level | What it said | Now |
| --- | --- | --- | --- |
| N-1 | SHOULD | `--local-only`'s zip could not be told from the store package, the README sent it to the store, and the plugin's store build did not refuse the local-development identity | **Fixed** (§6): `--local-only` writes no zip; the first uploads are ID drafts of each side (`--id-draft`), named and filed "do not publish", harmless if published, refused once their ID is pinned; neither store package carries a `key`, both are refused while the plugin's ID is the local-development one, the plugin's also when `STORE_ID` is the developer build's. check-dist holds a store build and a draft each to its own name and catalog. `m5-build-guard.test.ts`, `cloud-plugin-build.test.ts` |
| N-2 | SHOULD | the connect window ended at 110 s | **Fixed**: the window 10 minutes, the plugin 10.5, Sixkey 11 (`config.ts`, `cloud-provider.ts` `CONNECT_MS`); `cloud-provider.test.ts` holds the order and Sixkey's own timer. The third follow-up kept the three and moved the wait out of any one message (§3.6, N2-5): 10.5 is now the plugin's record of the connect |
| N-3 | SHOULD | the plugin's `_locales` were written by hand | **Fixed**: `scripts/i18n/cloud_plugin.py`, written by `messages.py`, which refuses a key the plugin names without text, a key it does not use, different keys per language and ASCII punctuation beside Chinese; `cloud-plugin-text.test.ts` holds the files to the same |
| N-4 | SHOULD | `consent.ts` had no direct test; MD1 to MD3, MK, MH, ML survived | **Fixed**: `cloud-consent.test.ts` calls it with the grant store, catalog, installation and session substituted; `cloud-provider.test.ts` the reads without a record under a blocked, listed or narrower catalog; `m5-build-guard.test.ts` runs `scripts/build.mjs` with a bad catalog, every flavour; `cloud-plugin-sw.test.ts` the window the user closes. MD2, MD3, MK, MH and ML killed (§4.3); MD1 stays equivalent (`protocol.ts` refuses a hello whose descriptor is not the sender's, and `grantsOf` strips the transport from any other ID) |
| N-5 | NIT | "turned off" said for every way of not being approved; "回到 X" approved again unsaid | **Fixed** (§2.4): "not approved (turned off, removed, or waiting for confirmation after an update)"; beside "回到 X", while the plugin is not approved, the line that it approves it again and the cost; it waits for an unlock like every approving button |
| N-6 | NIT | `not_approved` shown as "Couldn't connect to Google Drive"; `told` went stale | **Fixed** (§2.4): its own line; told only by an accepted hello, and said again before a status a minute later |
| N-7 | NIT | another extension could open the connect window, which left a session record | **Fixed** (§2.2): with no record of the worker's, the page asks nothing and writes nothing; it writes back only while the record is there. `cloud-plugin-page.test.ts` |
| N-8 | NIT | the popup's 立即备份 showed no cost line where it is clicked | **Documented, as chosen** (§2.4): the card the popup opens shows it while it connects, before Google's consent and before the approval (now written after the consent, N-9). Putting it in the popup would add the line's text to the popup's lazy catalog (its own budget) or a hover title, which is not "where the click is made" for touch or keyboard, and the popup's open keeps its storage reads (perf.spec.ts) |
| N-9 | NIT | a failed or cancelled Google connect left the plugin approved | **Fixed** (§2.4): checked before, written after the consent; the restore's at "完成" as before |
| N-10 | NIT | A-2's docs spoke of confidentiality alone | **Fixed** (§3.2; ARCHITECTURE; SDK §6.6 item 3) |
| N-11 | NIT | the popup's state lags after the plugin is uninstalled | **Documented** (§5): no check added at the popup's open (the maintainers' decision) |

### 3.5 A vault reset and the old grant record (the review's open variant of A-2)

Traced through `service.ts` `makeVault` (the first run, a backup restored, Start over), which commits the new vault and
only then, after the session and the PIN's, the device unlock's and the restart's records, asks the grant store to set
the record left beside it aside (`newVault`, W2a round 3: kept for review, a new record under the new key). A new vault
always has a new key, so that record never verifies again; but `newVault` cut short (a page closed in between, a
storage write that failed: its failure is logged, never the vault's) left it in `sk_plugins`, and `unverified()`, which
reads the record without its tag, honoured its approvals until the next tagged write. For the cloud backup's locked
check that meant the old vault's `backups.transport` approval: the new vault's encrypted generation went on uploading
through an approval the new vault never gave. (`reencrypt`, the key-change clean-up, leaves such a record "unopenable"
as it is, and an unlock's verified read does not set it aside either.)

Fixed at the source, for every reader without the tag: `VkRecord.beforeNewVault`, called by `makeVault` before its
commit, removes each plugin of a record the new key does not verify through the overlay (`GrantStore.beforeNewVault`):
the overlay only tightens and needs no key (SDK §6.6 item 4), is honoured at once in every lock state, and the record
`newVault` writes merges it into nothing and takes it out. The built-in autofill's entry is left alone (its Off stays
Off), and the list kept for review is made from the record, not the overlay, so those plugins can still be approved
again. If the commit then fails, the removals stay: they only tighten, over a vault that was unreadable or absent (the
only states `makeVault` writes over). `plugins-w2a-r3.test.ts`: both ways of making a vault, each step of `newVault`
failing in turn, the old record still there and none of its approvals honoured, the autofill's Off kept, the first new
approval landing and the old plugins listed for review; mutant MT (§4.3) shows the four cut-short cases fail without it.

The third follow-up (N2-2, N2-3). `makeVault` reads the store, then `beforeNewVault` takes the vault lock: in between,
another page could make a vault and approve a plugin under it, which the removal would then take away. So
`beforeNewVault` reads the slots straight under that lock (`noReadableVault`, as `activeKeyring` reads them: no vault
can be committed meanwhile, the store's writes take the same lock) and writes nothing when they hold a vault after
all ("vault"; `makeVault`'s commit then refuses with "a vault appeared meanwhile"). A withdrawal left by a build that
did not commit stays, and applies as well to a vault later restored under the same key (Start over cut short, then
the same vault's cloud backup restored): its record verifies again, so `beforeNewVault` and `newVault` both leave it,
and the overlay's removals apply to it, at once for every reader and for good at its first tagged write. The cloud
plugin is approved again by the restore's "完成"; any other plugin is approved again as a new one. It only tightens.
The tests now also hold the built-in autofill's On after an Off through Start over, whole or cut short (the filter of
built-ins, RR2), and a removal dated after each approval on a clock behind it (RR4); the race through `makeVault`
itself, with page B's vault and approval made between page A's look and its withdrawal.

### 3.6 The third review (751b77f): N2-1 to N2-6

| Finding | Level | What it said | Now |
| --- | --- | --- | --- |
| N2-1 | SHOULD | Sixkey's store package was not refused while `STORE_ID` was empty, though step 6 said both were | **Fixed**: `scripts/cloud-plugin.mjs` `storeIdGate`, one rule for both sides: refused, before anything is built, while `STORE_ID` is empty, not an extension ID, or the developer build's ID, pointing at the first uploads' steps 1 and 3. Sixkey's package gives every reason that holds, in the steps' order; the plugin's build calls the same function. The seven steps (§6, both READMEs, `extension/README.md`) say what each command does, step 5 included, which neither build checks. `m5-build-guard.test.ts` (each refusal, both pinned), `cloud-provider.test.ts` |
| N2-2 | NIT | a withdrawal written before the commit could land on another vault | **Fixed / said** (§3.5): written only while the slots, read under the vault lock, hold no vault; the withdrawal left by a build that did not commit, over a vault later restored under the same key, is said there. `plugins-w2a-r3.test.ts` |
| N2-3 | NIT | autofill's On after an Off, and `approvedAt + 1`, untested (RR2, RR4 survived) | **Tested** (§3.5); both mutants killed (§4.3) |
| N2-4 | NIT | `cloud-plugin-build.test.ts` copied a leftover `dist-id-draft/` and then failed | **Fixed**: its copy leaves out every `dist` folder (`/[/\\](dist(-[\w-]+)?\|release)$/`); a test of the filter, and the file run with a `dist-id-draft/` in the tree (§4.5) |
| N2-5 | NIT | one `connect` message held open up to 10.5 minutes; Chrome may stop a worker whose event runs past 5 | **Redesigned** (§2.2): `connect` answers at once with a ticket; the page asks `connectState` every second (each answered at once) until the plugin says it ended, the card's Cancel, or 11 minutes; five questions in a row unanswered give it up. The plugin's state is its `storage.session` alone, so a worker stopped and started mid-connect answers as before; `gone` (no record) says to try again. The questions are requests of their own, one a second, each with a new ID: some 120 in the replay set at a time, under its 1000, and none holds an `inFlight` place. They and `connectCancel` carry only the ticket and need no approval (`connect` still needs the plugin eligible), and only the pinned Sixkeys are answered. Each message of the connect is now answered in milliseconds, so the 5-minute rule no longer matters to it. `cloud-plugin-connect.test.ts`, `cloud-plugin-sw.test.ts`, `cloud-plugin-page.test.ts`, `cloud-provider.test.ts`; the e2e click counts are unchanged |
| N2-6 | NIT | no way out of `connecting` on the card for up to 10 minutes | **Fixed** (§2.2): "Cancel" and where the window may be, until the sign-in is done (N3-1, §3.7), on the card and on the restore's first step, whose sign-in goes through the same window. `cloudbk-pages-dom.test.ts` (both), `cloud-plugin.spec.ts` "connecting: the card's Cancel …" |

The messages carry the ticket and the state, and nothing new is sent anywhere. What the plugin keeps in its
`storage.session` for a connect, and for how long, is in PRIVACY ("On this computer") since the fourth review (N3-2,
§3.7).

### 3.7 The fourth review (CLOUD-PLUGIN-FU3): N3-1 to N3-6

| Finding | Level | What it said | Now |
| --- | --- | --- | --- |
| N3-1 | SHOULD | once signed in, the card still showed Cancel and "sign in in the window", and a Cancel then was ignored: approval written, backup on | **Fixed** (§2.2): `connect`'s `signedIn` takes the Cancel and the line away the moment the sign-in is done, and a Cancel that still landed is found right before the approval is written. What a Cancel does at each moment is said in §2.2, `act.ts` and the commit message. `cloudbk-pages-dom.test.ts` |
| N3-2 | NIT | a connect no one asks about any more (Sixkey's page closed) left its record, with the account hint, in the plugin's session until the browser closed | **Fixed** (§2.2): the account hint in a key of its own, which the window removes before it closes itself; whatever ends a connect removes its keys; one no one asks about is ended by its one alarm at 10.5 minutes, or at the worker's next start; nothing listens for windows closing (the maintainers' r3: no wake with no connect under way). PRIVACY says how long each part stays. `cloud-plugin-connect.test.ts`, `cloud-plugin-sw.test.ts`, `cloud-plugin-page.test.ts`; `alarms` measured with no install warning in `cloud-plugin.spec.ts` |
| N3-3 | NIT | MM2, RW2, MC5, MC7, MV3 survived | **Killed**, each by a named test (§4.3) |
| N3-4 | NIT | the plugin's store build said its first reason only | **Fixed**: every reason at once, in the steps' order, one line each, as Sixkey's package. `cloud-plugin-build.test.ts` |
| N3-5 | NIT | the connect answer's shape changed under `/1` | **Said** (§1.2, SDK §6.2): nothing is released yet; after the first release such a change needs a new protocol version |
| N3-6 | NIT | a few added doc lines past the files' width | **Rewrapped** |

Its check of the fix (r3): merge, no MUST, no SHOULD, three NITs.

| Finding | Level | What it said | Now |
| --- | --- | --- | --- |
| N4-1 | NIT | the worker-start tidy reads one snapshot: a window that writes its success just after it and closes itself before the closed-window check loses that result, and the card says "Try again" (a millisecond coincidence) | **Fixed** (CLOUD-PLUGIN-FU4): the tidy reads a closed window's result once more before it decides, as `stateOf` does. `cloud-plugin-connect.test.ts` "at the start, a window that wrote its result just after the tidy's snapshot …"; mutant N41 (§4.3) |
| N4-2 | NIT | nothing pins the window's wait for its hint's removal before it closes, nor the worker's serialized access (mutants R3W2, R3S1 to R3S3 survive; every interleaving found is idempotent) | **Tested / said** (CLOUD-PLUGIN-FU4): R3W2, R3S2 and R3S3 killed, each by a named test; R3S1 equivalent, why in §4.3 |
| N4-3 | NIT | §2.2 still gave r2's two keys; "a Cancel that still landed in between" cannot happen on the card (no `await` between `signedIn` and the check, the button gone before a click is dispatched) | **Fixed** at merge: §2.2, `act.ts`'s comment and the commit message call that check a backstop |

### 3.8 Settings › Backup within a screen and a half (BACKUP-VISUAL)

`visual-guard.spec.ts` failed twice at 8261ceb: Backup ran past a screen and a half (1,350 px at 1400 x 900) in both
languages, and in Chinese the card's switch ran its label and its hint together on one line, a 662 x 24 target. Bisected
with the e2e build and that spec alone, one worker:

| Commit | The guard's Backup, en / zh_CN | The card (e2e build: off) | The switch, zh_CN |
| --- | --- | --- | --- |
| d2e3411 (patch 4, no card yet) | passes (1,298 / 1,310, as SHORT-SETTINGS-NOTES §6) | none | none |
| 77d046c (patches 5 and 6: the card) | 1,644 / 1,596 | 294 / 236 | 662 x 24, first here |
| 42903a1 (the card names the plugin) | 1,667 / 1,620 | 317 / 260 | the same |
| 9f6f0a6 to 8261ceb | unchanged | unchanged | the same |

Without the card the leaf was within 52 px of the rule, so no card fits beside the open encrypted form: the page had to
change, not only the card.

- **Encrypted backup is a fold** (`Backup.tsx`, SHORT-SETTINGS-NOTES §4), as Export selected accounts is: the card is
  the leaf's first and its one-click backup. Closing it drops the file password; a lock empties its fields as before.
- **The switch**: the label, and its hint on a line of its own (`.check.hinted`), the box by the label's first line.
- **The card in every state** (`CloudCard.tsx`): the account and the last backup on one line under the status;
  Settings › Plugins and the store page are buttons beside "继续备份" and "断开" (paused), not lines of their own; one line
  under the buttons for what Drive keeps (`ckLatest` now also says that "断开" leaves the file), none while paused,
  where the status says what stays until "断开"; `ckDisconnectHint` is the button's title. `ckBody` and
  `ckPluginNeeded` are shorter; `ckPluginRequired` is gone (the paused status says what is missing). The card's rows
  are 10 px apart, its lines as wide as its callouts. The cost line, the one button, the status and "断开" are where
  they were.
- **`cloud-card-visual.spec.ts`** reaches the states the guard does not (its e2e build's card is off): Sixkey's store
  build beside the plugin's test build, as `cloud-plugin.spec.ts` runs them; each state in English and Chinese, the
  guard's probes on the card at 320, 420, 600 and 1400 px in both themes, and the leaf within 1,350 px. The guard opens
  the new fold too.

The leaf at 1400 x 900, in px: the guard's (its e2e build and vault), then each state of `cloud-card-visual.spec.ts`
(the store build, a vault of one account; 8261ceb measured with that spec copied in):

| State | 8261ceb, en / zh_CN | Now, en / zh_CN |
| --- | --- | --- |
| The guard's Backup (e2e build, the card off) | 1,667 / 1,620 | 1,248 / 1,255 |
| The plugin missing | 1,746 / 1,705 | 1,325 / 1,313 |
| The plugin there, backup off | 1,689 / 1,644 | 1,270 / 1,279 |
| Connecting, with Cancel | 1,636 / 1,632 | 1,241 / 1,247 |
| Connected | 1,782 / 1,742 | 1,321 / 1,332 |
| Paused, not approved in Settings › Plugins | 1,899 / 1,844 | 1,337 / 1,326 |
| Paused, the plugin missing | 1,895 / 1,838 | 1,316 / 1,326 |

## 4. Measured

### 4.1 Chrome's install warnings

`chrome.management.getPermissionWarningsByManifest`, which gives the warnings Chrome's install dialog lists, called by
Sixkey's worker in Chromium 156.0.8078.4 (Playwright's build; `test/e2e/cloud-plugin.spec.ts`, its log in this
follow-up's records):

| Manifest | Warnings |
| --- | --- |
| the plugin's, as `--dev` writes it (`storage`, `identity`, no host permission; `alarms` since the third follow-up's third round, measured the same way) | none |
| the same with an `oauth2` client | none |
| the same with 42903a1's `host_permissions` | "Read and change your data on oauth2.googleapis.com and www.googleapis.com" |
| the same with `identity.email` added (a control) | one |

### 4.2 Google's step without a click

A probe (kept with this follow-up's records, outside the repository): the plugin's developer build with a test
`oauth2` client, Chromium 156.0.8078.4, its worker opening its page with `chrome.windows.create` as the connect does, no
input anywhere. Two runs:

| Call, in that page | Run 1 (idle state not recorded) | Run 2 (`chrome.idle.queryState(15)`: active) |
| --- | --- | --- |
| `getAuthToken({interactive: true})` | rejected: "User interaction blocked due to user inactivity." | Chrome's sign-in shown, waiting for the user (12 s) |
| `launchWebAuthFlow({interactive: true})`, Google's page | its window shown, waiting (12 s) | the same |
| `launchWebAuthFlow({interactive: true})`, an unreachable page | "Authorization page could not be loaded." | the same |

No call was refused for want of a gesture; Chrome's own path wants recent activity (§2.2).

### 4.3 The review's surviving mutants

Each applied by hand to this follow-up's tree, `cloud-provider.test.ts` and `cloud-plugin-sw.test.ts` run against it,
the file put back and compared byte for byte (the logs and the mutants' diffs are with this follow-up's records):

| # | Mutant | Killed by |
| --- | --- | --- |
| M1 | the plugin checks the ciphertext of `update` only (`create` unchecked) | "create uploads only parsed encrypted cloud files, refusing a plaintext export and arbitrary JSON before network (review M1)", and "create over Drive's one-request limit is said as Drive says it" |
| M2 | `create` taken out of the writes that need the approval | "no write is sent without the transport approval, whatever is stored instead (review M2)" |
| M4 | the plugin worker's sender check taken out | "a sender it was not built for gets no answer at all and reaches nothing (review M4, A-4)" |

The second review's surviving mutants, and this follow-up's own, applied the same way to the second follow-up's tree,
each with the test files named in its log, the file restored and its sha256 compared after each:

| # | Mutant | Killed by |
| --- | --- | --- |
| MD2 | `consent.ts`: the official-trust check taken out | `cloud-consent.test.ts` "a copy that is not the official one is unavailable, nothing written and nothing asked of it" |
| MD3 | `consent.ts`: `grantsOf(...)` replaced by the descriptor's own capability list | `cloud-consent.test.ts` "a descriptor that asks beyond the catalog's ceiling: only what is within it is written (review MD3)" |
| MK | `cloud-provider.ts`: the official and ceiling check taken out | `cloud-provider.test.ts` "with no approval record, a restore's reads still need the official catalog entry and its ceiling (review MK)" |
| MH | `scripts/build.mjs`: `if (problem) {` made `if (false) {` | `m5-build-guard.test.ts` "a catalog whose cloud entry is not provider.json's ID stops every build before anything is built (review MH)" |
| ML | the plugin's `sw.ts`: `if (closed) throw …` taken out | `cloud-plugin-sw.test.ts` "connect: the window closed by the user ends it at once, as cancelled; its record goes with it (review ML)" |
| MD1 | `consent.ts`: `descriptor.id !== CLOUD_PLUGIN_ID` taken out | survives: equivalent (N-4) |
| MT | `service.ts`: the `beforeNewVault` call taken out | `plugins-w2a-r3.test.ts`, the four cut-short cases (§3.5) |
| MN1 | the plugin's store build: the `key` kept; its `providerGate` taken out; Sixkey's `--local-only` zipping again | `cloud-plugin-build.test.ts` (both), `m5-build-guard.test.ts` "--local-only builds and checks dist/ … writes no zip" |
| MN2 | Sixkey's `CONNECT_MS` 10 minutes | `cloud-provider.test.ts` "the deadlines, outermost first" |
| MN6 | the plugin's `told` set whatever Sixkey answered | `cloud-plugin-sw.test.ts` "a hello counts as told only once Sixkey accepted it" |
| MN7 | the page's write-back without its record check | `cloud-plugin-page.test.ts` "the worker's record gone while it signed in" |
| MN9 | the card's connect approving before Google | `cloudbk-pages-dom.test.ts` "the one click approves … once Google's connect succeeded (review N-9)" and "a connect Google refused … leaves no approved plugin behind" |

The third review's surviving mutants and this follow-up's own, applied the same way to the third follow-up's tree (one
text replaced, the named test files run, the file restored and its sha256 compared after each; the logs with this
follow-up's records):

| # | Mutant | Killed by |
| --- | --- | --- |
| RR2 | `store.ts` `beforeNewVault`: the built-ins' filter taken out | `plugins-w2a-r3.test.ts` "autofill turned off and on again stays on through Start over, whole or cut short" |
| RR4 | `store.ts` `beforeNewVault`: the removal dated `now()`, not after each approval | `plugins-w2a-r3.test.ts` "a clock behind the old approvals still withdraws them" |
| MV | `store.ts` `beforeNewVault`: the slots' check taken out | `plugins-w2a-r3.test.ts` "the slots, read under the vault lock, decide …" and "another page makes a vault and approves a plugin …" |
| MP1 | `connect.ts`: a window closed without a result not looked for | `cloud-plugin-connect.test.ts` "a result that is not ok is failed; a window closed with no result is cancelled …" and "the worker stopped and started again mid-connect …"; `cloud-plugin-sw.test.ts` "connect: answered at once with a ticket …" |
| MP2 | `connect.ts`: the record's 10.5 minutes not held | `cloud-plugin-connect.test.ts` "past the window's 10 minutes: failed …; past the record's 10.5: gone" |
| MP3 | `connect.ts`: the window's 10 minutes not held | the same |
| MP4 | `connect.ts`: a result that is not ok taken as done | `cloud-plugin-connect.test.ts` "a result that is not ok is failed …" |
| MRATE | the plugin's `sw.ts`: the replay set's bound 100, not 1000 | `cloud-plugin-sw.test.ts` "a connect's questions, one a second for its whole 10.5 minutes beside other calls, are never rate_limited" |
| MW | `settings.ts`: the window's own deadline a year | `cloud-plugin-page.test.ts` "still signing in at its own deadline …" |
| MS1 | `cloud-provider.ts` `providerConnect`: no `connectCancel` when Sixkey ends it | `cloud-provider.test.ts` "the deadlines, outermost first …", "connect answers at once …", "the card's Cancel …" |
| MS2 | `cloud-provider.ts`: the connect's deadline 22 minutes | `cloud-provider.test.ts` "the deadlines, outermost first …" |
| MS3 | `cloud-provider.ts`: the first unanswered question ends the connect | `cloud-provider.test.ts` "connect answers at once …" |
| MS4 | `cloud-provider.ts`: `connect` sent with no eligibility check | `cloud-provider.test.ts` "a connect's question and cancel are sent with no approval at all; connect itself still needs the plugin eligible", and review MK's |
| MA1 | `act.ts` `connect`: going on after a Cancel that came with the sign-in | `cloudbk-pages-dom.test.ts` "connecting: where to sign in, and Cancel …" (its "resolve" case) |
| MC1 | `CloudCard.tsx`: the user's Cancel said as "Couldn't connect" | the same |
| MK | `package.mjs`: `storeIdGate` taken out of the store package's checks | `m5-build-guard.test.ts` "refuses a store package while Sixkey's own STORE_ID is empty …", "… when STORE_ID is the developer build's ID …" and "neither pinned …" |

The fourth review's surviving mutants (N3-3) and the second round's own (N3-1, N3-4; its N3-2 mutants went with the
window listener the third round took out), the same way:

| # | Mutant | Killed by |
| --- | --- | --- |
| MM2 | `cloud-provider.ts` `providerConnect`: an answer no longer starts the count of misses again | `cloud-provider.test.ts` "connect answers at once …" (more misses in all than CONNECT_MISSES, never that many in a row) |
| RW2 | `connect.ts`: the worker's second write of the record clears the window's result | `cloud-plugin-connect.test.ts` "a window that writes its result before the worker has recorded its ID …" |
| MC5 | `CloudCard.tsx`: the Cancel and the line shown whenever the card is connecting | `cloudbk-pages-dom.test.ts` "signed in: the Cancel and the hint go at once …" and "moving the backup to another account …" |
| MC7 | `act.ts` `listBackups`: `signedIn` not told | `cloudbk-pages-dom.test.ts` "signing in: where, and Cancel …" (no Cancel while the files are listed) |
| MV3 | `active-keyring.ts` `noReadableVault`: any read error taken as no vault | `plugins-w2a-r3.test.ts` "a read of the slots that fails …" |
| MS31 | `act.ts` `connect`: `signedIn` not told | `cloudbk-pages-dom.test.ts` "signed in: the Cancel and the hint go at once …" |
| MB31 | `act.ts` `connect`: the check right before the approval taken out | `cloudbk-pages-dom.test.ts` "a Cancel that lands as the sign-in completes, before the approval is written …" |
| MK34 | the plugin's `build.mjs`: its first reason only | `cloud-plugin-build.test.ts` "neither pinned …: every reason at once …" |

The third round (the maintainers': no listener for windows closing, N3-2), its own, the same way against its tree
(RW2 again, the record's second write having changed):

| # | Mutant | Killed by |
| --- | --- | --- |
| MR1 | `connect.ts` `end`: the keys not removed when a connect ends (a terminal answer, Cancel, its alarm) | `cloud-plugin-connect.test.ts` "every answer that ends a connect, and Cancel, removes its keys …", and others |
| MR2 | `settings.ts`: the window keeps the account hint when it closes itself | `cloud-plugin-page.test.ts` "for the worker's request: … removes the account hint, then closes" and "still signing in at its own deadline …" |
| MR3 | `connect.ts` `startConnect`: no alarm | `cloud-plugin-connect.test.ts` "started: …", `cloud-plugin-sw.test.ts` "connect: answered at once …" |
| MR4 | `connect.ts` `end`: the alarm not cleared | `cloud-plugin-connect.test.ts` "started: …" and "every answer that ends a connect …" |
| MR5 | the plugin's `sw.ts`: no listener for its alarms | `cloud-plugin-sw.test.ts` "at its start …" and "nothing at its top level listens for windows closing …" |
| MT1 | the plugin's `sw.ts`: no tidy at its start | `cloud-plugin-sw.test.ts` "at its start, tidies what an earlier worker left …" |
| MT3 | `connect.ts` `tidyConnects`: a closed window's arguments kept beside its result | `cloud-plugin-connect.test.ts` "at the worker's start, what an alarm should have ended …" |
| MT4 | `connect.ts` `tidyConnects`: records past 10.5 minutes kept at the start | the same |
| RW2 | `connect.ts`: the worker's second write of the record clears the window's result | `cloud-plugin-connect.test.ts` "a window that writes its result before the worker has recorded its ID …" |
| MKP | the plugin's `build.mjs`: its permission check taken out | `cloud-plugin-build.test.ts` "a permission beyond storage, identity and alarms … is refused" |

No listener for windows closing is left at the plugin's top level: `cloud-plugin-sw.test.ts` reads its sources for
`windows.onRemoved` and pins the worker's four listeners (the action's click, its alarms, the test build's hook,
messages from the Sixkeys it serves).

The review's MC2, MX3 and RT4 stay as they were: equivalent (`stoppable` already drops an answer that comes after a
Cancel), a delay of at most one question's 10 s before a Cancel takes effect, and the ticket's entropy, which no test
can see (code review only: `crypto.getRandomValues`, 16 bytes).

The fourth follow-up (CLOUD-PLUGIN-FU4) on the r3 review's N4-1 and N4-2, the same way against its tree (the r3
review's own definitions for R3W2 and R3S1 to R3S3):

| # | Mutant | Killed by |
| --- | --- | --- |
| N41 | `connect.ts` `tidyConnects`: a closed window's result taken from the snapshot alone, not read again | `cloud-plugin-connect.test.ts` "at the start, a window that wrote its result just after the tidy's snapshot and closed itself: kept" |
| R3W2 | `settings.ts`: the window closes without waiting for its hint's removal to finish | `cloud-plugin-page.test.ts` "for the worker's request: …" and "still signing in at its own deadline …" (a removal that takes a moment) |
| R3S2 | `connect.ts` `startConnect`: no check that the connect is still there before the window's ID is written | `cloud-plugin-connect.test.ts` "ended while its window was opening (its alarm, say): the record is not written back …" |
| R3S3 | `connect.ts` `serial`: the steps not one at a time | `cloud-plugin-connect.test.ts` "one step at a time: an end that comes while the window's ID is being recorded waits for that step" |
| R3S1 | `connect.ts`: `connectState` not one of the serial steps | survives: equivalent. A question only reads and removes (`stateOf`, `finished`, `end`), and so does every other step but `startConnect`'s two writes, which no question can meet: the ticket is first told in `connect`'s answer, after both. Removals of the same keys in any order leave the same storage, a second `windows.remove` of a closed window is caught, and nothing is ever written back. A question that meets another end of its connect (its alarm, Cancel, the start's tidy) answers from the keys as it read them, "pending" at worst, and the next question, a second later, finds the end; after a Cancel Sixkey reads no answer at all |

### 4.4 Sizes

The store build, `node scripts/build.mjs`, 42903a1 against this follow-up (gzip -9):

| | 42903a1 | now |
| --- | --- | --- |
| `sw.js` | 360,853 B, 99,771 B gz | 363,470 B, 100,475 B gz (check-dist's own count: 101,022 of 106,496 B) |
| the cloud pages' chunk (`act-*.js`) | 6,442 B, 2,783 B gz | 8,681 B, 3,617 B gz |
| the cloud catalog, en / zh_CN | 1,857 / 2,083 B gz | 2,112 / 2,368 B gz (of 3,584 B) |
| the popup | 59,045 of 61,440 B gz | 59,056 of 61,440 B gz |

The worker grew by the replies' shape checks (A-3). The plugin's developer build: `sw.js` 14,920 B, `settings.js`
1,820 B, its shared chunk 12,590 B, the icons 4,720 B, the two locales 1,570 B; 42903a1's store build had `sw.js`
21,161 B, `settings.js` 3,601 B, its shared chunk 6,307 B.

### 4.5 The gates

On the final tree (logs with this follow-up's records): `python3 scripts/messages.py`; `npm run typecheck`; the prod,
dev and e2e builds, each with check-dist OK; the plugin's `--dev` and `--test` builds, and its store build refused with
`STORE_ID` empty (and, with one set in a private copy, built: `cloud-plugin-build.test.ts`); `npm run format:check`;
`npm run notices:check`; the full unit suite; the browser tests `cloud-pages`, `cloud-provider`, `cloud-plugin` and
every `plugins*` spec, one worker. The numbers are in the commit message. One browser test fails, and fails the same
way at 42903a1, built and run there: `plugins-w2b-r2.spec.ts` "W2B-04", which counts 11 `storage.local` reads at a side
panel's open against its expected 10, the same keys in the same order at both commits. It is not this follow-up's, and
is left for a fix of its own (2cf3136 then counted the cloud backup's status line). The second follow-up's gates, the
same list with its new package and ID-draft refusals, the full unit suite and the browser tests named in its commit
message, are recorded with its numbers there. The third follow-up's, on its final tree: the same list, with Sixkey's
store package refused before building with both reasons in the steps' order and the plugin's store build refused by
the same `STORE_ID` rule; `cloud-plugin-build.test.ts` run with the plugin's `dist-id-draft/` left in the tree (8 of
8); the full unit suite (337 files, 5,407 passing, 4 expected failures, 1 skipped); and the browser tests
`cloud-pages`, `cloud-provider`, `cloud-plugin`, every `plugins*` spec and `perf`, one worker: 59, all passing, W2B-04
and the click counts included. Its second round, after the fourth review (N3-1 to N3-6), on its final tree: the same
list, the plugin's store build refused with both reasons in the steps' order; `cloud-plugin-build.test.ts` with a
`dist-id-draft/` left in the tree, 9 of 9; the full unit suite (337 files, 5,416 passing, 4 expected failures, 1
skipped); the same browser tests, 59, all passing, the click counts unchanged. Its third round (no listener for
windows closing; the connect's alarm), on its final tree: the same list; `cloud-plugin-build.test.ts` with a
`dist-id-draft/` left in the tree, 10 of 10; the full unit suite (337 files, 5,419 passing, 4 expected failures, 1
skipped); the same browser tests, 59, all passing, the click counts unchanged, and Chrome's own count of the plugin's
install warnings, `alarms` included, `[]`. The fourth follow-up's (CLOUD-PLUGIN-FU4), on its tree: the same list
(the merge's gates); the full unit suite (337 files, 5,422 passing, 4 expected failures, 1 skipped); the same browser
tests, 59, all passing, on a second run: the first reached the real Chrome Web Store from the case that opens its
page, which answered with another address, and that case now answers the store's page itself.

## 5. Not proved

- **The real Google flow.** No OAuth client exists yet (`provider.json`'s are empty): Google's consent screen, its app
  name (the strings that say "Sixkey" for the app in a Google account assume it is "Sixkey"), `getAuthToken` in branded
  Chrome, `launchWebAuthFlow` in Edge and Brave, the revocation, and a real Drive's answers are all simulated by the
  fake Drive. §4.2 shows only that Chromium 156 does not refuse the calls for want of a gesture, and that it refuses
  Chrome's path when the computer is idle.
- **The store.** No upload has been made. How it treats an ID draft (that its package can be replaced before it is
  submitted, whether the replacement must have a higher version, and that a draft never submitted is never published),
  where its dashboard shows an item's public key (§6 step 4), that an upload without a manifest `key` keeps the item's
  ID, what the two store IDs will be, whether it asks for more than the 128 px icon, and the install dialog's wording
  (§4.1 is Chrome's own count of warnings, not a store install). The store link opens a page that exists only once the
  plugin is published.
- **The connect's minutes** (N-2). The 10 minutes are a judgment of how long a new computer's Google sign-in with
  two-step verification takes, not a measurement; the fake Drive's sign-in takes no time.
- **A worker stopped mid-connect, in a real Chrome** (N2-5). Whether Chrome would have stopped the plugin's worker
  under the old single message was never measured, and that it does not matter now rests on the design: no message
  of the connect waits, and the state is in `storage.session`. The browser tests cannot stop a worker that DevTools is
  attached to; `cloud-plugin-connect.test.ts` stands for a restart by loading the module anew over the same storage.
- **A Sixkey page in the background** (the fourth review's §6). The page asks with a chain of timers; one hidden for
  more than five minutes (the whole Chrome window covered, or another app in front while the user is on the phone for
  two-step verification) may have them aligned to once a minute by Chrome's intensive throttling. A sign-in done just
  before the window's 10 minutes might then be asked about only after the record's 10.5, and come back "gone" (the
  card says to try again). Reasoned, not measured; the fake sign-in takes no time.
- **The connect's alarm in a real Chrome** (N3-2). That Chrome fires it at the record's end (alarms may be late
  when the computer sleeps, and may be dropped on a browser restart, which empties `storage.session` anyway) is
  Chrome's documented behaviour, not measured here; the browser tests fire no alarm (10.5 minutes), the unit tests
  call its handler.
- **The popup after the plugin is uninstalled** (N-11). With no Sixkey page open, removing the plugin changes no record
  Sixkey watches (`sk_plugins` stays as it is), so the popup's pill and footer keep their last state until the worker's
  next run writes the pause: its routine (at most six hours), a change to back up, or the card opened. No status check
  was added at the popup's open, which keeps its storage reads to their budget.
- **CORS today.** That Drive and the revocation still answer an extension's CORS request was measured on 2026-10-30, not
  again; the fake Drive needs no network.
- **Background resume.** With backup on and the plugin installed later while no Sixkey page is open, the worker resumes
  at its next routine (six-hourly, or the daily check) or when the card is opened; only the card's carry-on is tested.
- **A-2's residual** (§3.2), by design.

## 6. What can be uploaded to the store, and the first uploads (N-1)

The second review's scenario: `--local-only`'s zip, which the README said to upload as a draft to get the IDs, was the
store build in all but its file name; submitted by mistake (or renamed), the store's Sixkey would have pinned
`fnlpmmonofibbnonfphejaacgljfeino`, an ID anyone can load unpacked from the key in this repository, as the official
plugin, and the backup card's one click would have given it the transport. So, on both sides:

- **Nothing that can be uploaded looks like a store package unless it is one.** `npm run package -- --local-only` builds
  Sixkey into `dist/` and checks it, for **Load unpacked**, and writes no zip.
- **The first upload of each is an ID draft**, made only to get the store's ID: `npm run package -- --id-draft`
  (`scripts/build.mjs --id-draft` into `dist-id-draft/`, `check-dist --id-draft`,
  `release/sixkey-<version>-id-draft-do-not-publish.zip`) and `plugins/official/cloud-backup/build.mjs --id-draft`
  (`dist-id-draft/`, `release/sixkey-cloud-backup-<version>-id-draft-do-not-publish.zip`). Their manifest names say
  "(ID draft, do not publish)", and each is harmless if published: Sixkey's catalog is the store's without any entry
  that may hold `backups.transport` (`scripts/cloud-plugin.mjs` `withoutCloudPlugin`), so it trusts no cloud plugin
  (nothing approved, nothing sent; its `externally_connectable` is the reserved ID alone); the plugin's serves no Sixkey
  (no ID, the reserved ID alone in its `externally_connectable`) and has no Google client. Each is refused once the ID it
  is for is pinned (`idDraftGate`). A draft keeps the real permissions, so the store sees what the package will ask for.
- **A store package never carries a manifest `key`, and never pins, serves or is pinned by a development identity.**
  Both are refused, before anything is built, while `STORE_ID` is empty, not an extension ID or the developer build's
  ID (`storeIdGate`, the same function on both sides: N2-1), and while `provider.json` names the local-development ID
  (`providerGate`). Sixkey's (`check-dist` refuses a `key` in a prod build) would otherwise ship an install-source check
  with no store ID; the plugin's strips `key` and checks it did, and serves `STORE_ID` alone. `check-dist` holds a
  store build to its own name and the store's catalog, and a draft to the draft's, so neither passes as the other.

The first uploads, in order (the plugin's README, "Publishing", gives the same steps):

1. `npm run package -- --id-draft`; upload the zip as a new item, never submitted. Its ID is Sixkey's.
2. `node plugins/official/cloud-backup/build.mjs --id-draft`; upload it as a second new item, never submitted. Its ID
   is the plugin's. (1 and 2 in either order.)
3. Sixkey's ID into `STORE_ID` (`extension/scripts/store-id.mjs`).
4. The plugin's ID and its item's public key into `provider.json` (`id`, `key`) and `manifest.json` (`key`), and its
   official entry in `plugins/catalog.json` and `catalog.test.json` (that ID, its store page). Its `--dev` and `--test`
   builds load unpacked under that ID from then on (a public key is not secret; a profile without the store's copy).
5. The OAuth clients for the plugin's ID into `provider.json` `clients`.
6. `npm run package` and `npm run build:cloud-plugin`, each refused, before anything is built, until 3 and 4 are
   done (the plugin's build reads 4's `provider.json` and `manifest.json`; Sixkey's also checks the catalogs). Neither
   checks 5: without clients the plugin still builds, and Sixkey's card says it has no Google sign-in.
7. Each zip uploaded to its own item in place of its draft, then both submitted for review.

What the store does with all this is not verified (§5): nothing has been uploaded.
