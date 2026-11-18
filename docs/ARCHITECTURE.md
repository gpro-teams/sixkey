# Sixkey architecture

How the pieces of Sixkey fit together: the extension and its contexts, where data is stored, where the trust
boundaries are, how sync is put together, the build flavours, and where the API contract lives. It describes the code
as it is; the normative designs are [security/local-vault.md](security/local-vault.md) for the local vault and
[SYNC-DESIGN.md](SYNC-DESIGN.md) (in Chinese) for sync. Paths are relative to the repository root unless they start
with `src/`, `test/` or `scripts/`, which are under `extension/`.

## 1. Components and their status

| Component                                                   | Path                            | Status                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Browser extension (Chrome, Manifest V3)                     | `extension/`                    | The part meant to ship first, local only. Not yet in the store.                                                               |
| Sync engine and local sync state (the server sync's client) | none                            | Removed from the extension (DV-0b; OWNER-DECISIONS/25); in the history if ever needed. The server and the contract stay (§6). |
| Sync API server (FastAPI, PostgreSQL)                       | `api/server/`                   | Unreleased; runs in development and test mode only.                                                                           |
| API contract and test vectors                               | `api/openapi.yaml`, `contract/` | Unreleased; used by the tests of both sides.                                                                                  |
| YubiKey helper (native program)                             | none                            | Design proposal only (`docs/design/proposals/YUBIKEY-DESIGN.md`).                                                             |

## 2. The extension

### 2.1 Layers

```
src/popup (+ src/sidepanel)  src/options  src/offscreen  src/background
            \                     |            |              /
      \         |            |             /        UI and entry points: Preact pages, the service worker
       +-------- src/platform ------------+          Chrome adapters: storage areas, IndexedDB, locks, session,
                     |                               clipboard, permissions, the backup in Chrome sync's worker, the
                     |                               site rules' updater
                 src/core                            pure logic: no chrome.*, no DOM; tested in Node
```

`src/core` holds everything that decides anything:

| Module                                  | What it does                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/totp`                             | HOTP/TOTP (RFC 4226/6238), base32, `otpauth://` parsing, the Google Authenticator migration format                                                                                                                                                                                                                                 |
| `core/crypto`                           | the vault key (VK), the vault envelope (AES-256-GCM), the keyring (the VK wrapped by password, recovery key and previous keys), PBKDF2 and HKDF, recovery keys, the password floor, the loose spellings of a generated password, the session PIN and its policy, the device unlock's PRF wrap and its own WebAuthn assertion check |
| `core/vault`                            | the data model (each account is three last-writer-wins registers: content, placement, deletion, stamped with hybrid logical clocks), operations, merge, validation                                                                                                                                                                 |
| `core/storage`                          | the loss-proof store: two slots and a pointer, snapshots, the keyring copy, the IndexedDB mirror, startup recovery, the clean-up after key changes                                                                                                                                                                                 |
| `core/service`                          | `VaultService`, the one API the pages use: unlock and lock, edits, exports, key changes, the security record, the security presets. The popup uses its base, `ServiceCore`                                                                                                                                                         |
| `core/backup`, `core/import`            | encrypted backup files (full and selected accounts), importers and duplicate detection, other apps' export files read by content, and the camera scan's collection of a Google Authenticator export (docs/design/notes/IMPORT-FILE-NOTES.md)                                                                                       |
| `core/cloud`                            | the encrypted backup's file (the vault as on disk, made with no key), its status line and restore's merge of every copy a secret opens; the backup in Chrome's sync storage's layout and write rule (`slots.ts`: one copy per device, never another's)                                                                             |
| `core/match.ts`, `core/site-domains.ts` | matching accounts to the current site; the list of shared suffixes that cannot be registered                                                                                                                                                                                                                                       |

### 2.2 Contexts

| Context               | Entry                  | What runs there                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolbar popup         | `src/popup/`           | the code list, unlock, adding from the popup (paste, scan of the visible tab); the backup in Chrome sync's pill, its problem line and its one click (its two records read with the settings, in the open's own read), and with no vault yet the welcome's look for a copy in Chrome sync                                                                                                                             |
| Side panel (optional) | `src/sidepanel/`       | the popup's screens in a column beside the page, which stays open; its own idle cap and close rule (docs/design/notes/SIDEPANEL-NOTES.md)                                                                                                                                                                                                                                                                            |
| Settings page (a tab) | `src/options/`         | first run (master password, recovery key), accounts (with file import and the camera), backup and export (with the backup in Chrome sync's card, first run's box and the restore from it: `src/options/csb/`), security; four groups, one leaf of a group at a time, chosen by the hash; what must not be lost (a new recovery key) is held by the page above its leaves (docs/design/notes/SHORT-SETTINGS-NOTES.md) |
| Service worker        | `src/background/sw.ts` | alarms (daily snapshot, idle lock), the browser-start self-check, what the toolbar icon opens (popup or side panel), and the backup in Chrome sync's writes (`src/platform/csb-worker.ts`: 30 s after a change, retries, a daily check, with the vault locked or not; the only writer of `chrome.storage.sync`); with its release gate open, the site rules' updater, the one context that reaches the network       |
| Offscreen document    | `src/offscreen/`       | the 30-second clipboard-clear timer (a service worker has no clipboard)                                                                                                                                                                                                                                                                                                                                              |

Each context builds its own service over the same storage, with the same wiring (`src/platform/runtime-base.ts`): the
settings page and the service worker build `VaultService` (`src/platform/runtime.ts`), and the popup
builds only the part it uses, `ServiceCore`, which `VaultService` extends (docs/design/notes/BUDGET-NOTES.md). The side
panel is a page of its own (`sidepanel/index.html`) that draws the popup's screens: the code both pages run is one chunk,
started by `src/popup/boot.tsx`, and the panel adds only its entry, its stylesheet and its rules (`src/sidepanel/guard.ts`);
the popup reaches them through the seams of `src/popup/surface.ts`. The settings page's text is loaded in parts, one catalog per part of the page, so that no page loads the whole
catalog (docs/design/notes/BUDGET-NOTES.md). Writes are
serialised across contexts with the Web Locks API (`src/platform/locks.ts`). The service worker keeps nothing in memory between
events, because Chrome may stop it at any time.

### 2.3 Unlocking and saving

- **Unlock**: the master password (PBKDF2-SHA256: 2,000,000 iterations for a wrap made now, at least 600,000 for one
  made before; OWNER-DECISIONS/15) or the recovery key (HKDF; typed, or rebuilt in memory from shares, then used as typed) unwraps the
  VK from the keyring. In the standard mode the unlocked VK is kept in `chrome.storage.session` (memory only, shared by
  Sixkey's pages) until the idle timeout, a screen lock or a browser restart. In "lock every time" mode it stays only in
  the memory of the page that unlocked it. The side panel, a page that stays open, locks Sixkey after 15 minutes in which
  the unlocked key's record of activity did not move (input in the panel, the popup opening, a settings page loading the
  vault), whatever the automatic lock allows, and is never offered in a profile declared shared. A
  single-person profile may also set a PIN of 4 to 8 digits (OWNER-DECISIONS/20 and its 2026-10-30 notes): `sk_pin_restart`
  holds the VK under a key derived from the PIN at the master password's PBKDF2 count, so the PIN reopens Sixkey after
  any lock, also after a browser restart or an extension reload, with no time limit; 5 wrong tries in a row (counted on
  disk) take its key off the disk until the next master password; a key or master-password change pauses it; a copy of
  the profile can guess the PIN offline (`docs/design/notes/PIN-RESTART-NOTES.md` §18). Touch ID or Windows
  Hello can be added too (QUICK-UNLOCK Stage 2, `docs/design/notes/PRF-NOTES.md`), classified by what the passkey
  returns: one with the WebAuthn PRF extension unwraps its own copy of the VK, also after a restart, and asks for the
  master password every 14 days; one without is a gate that reopens the session until the browser closes (12 hours at
  most), Sixkey checking each assertion itself. The Windows Hello half is built to the same rules but has not yet run
  on a Windows PC (OWNER-CHECKLIST item 35). A generated master
  password (16 characters or 5 words) can be typed without its hyphens and with any case; the stored password is
  unchanged (`core/crypto/password-candidates.ts`).
- **Save**: an edit produces a new vault generation, encrypted under a key derived from the VK, with the header bound
  into the GCM additional data. The store writes it to the **inactive** slot, reads it back and compares, and only then
  moves the pointer; then it updates the snapshots and the mirror. On start, a damaged slot falls back to the other
  slot, then to the newest snapshot or mirror copy, and the user is told.
- **Key changes** (password turned on, changed or reset; new recovery key; replaced key) are one locked save each. A
  marker written before the commit makes sure that copies under superseded keys are rewritten afterwards, even across
  a crash.

The details, and the limits of each of these, are in [security/local-vault.md](security/local-vault.md).

## 3. Where data is stored

All in the browser profile, in the extension's own storage areas:

| Area                          | Keys                                                                                                                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.storage.local`        | `sk_active`, `sk_slot_a`, `sk_slot_b`, `sk_snap_idx`, `sk_snap_*`, `sk_keyring`, `sk_events`, `sk_keychange`, `sk_store_v` | the encrypted vault: pointer, two slots, snapshots, keyring copy, restore notices, key-change marker, format version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                               | `sk_settings`, `sk_last_backup`, `sk_device`, `sk_security_log`, `sk_diag`                                                 | settings (not secret), backup reminder, this install's random ID, the security record, the minor-problem log (error kinds only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                               | `sk_pin`                                                                                                                   | the PIN's set-up, only with a PIN: a PIN-derived key under the vault key; opens nothing without it (`docs/security/local-vault.md` "Quick unlock")                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                               | `sk_pin_restart`                                                                                                           | the PIN's record, only with a PIN (OWNER-DECISIONS/20 and its 2026-10-30 notes): the vault key under a key derived from the PIN (PBKDF2-SHA256, ≥2.6M iterations; AES-256-GCM), a MAC under the VK, the wrong tries in a row and the master password's last time (informational). Never synced; a copy of the profile can guess the PIN offline (`docs/design/notes/PIN-RESTART-NOTES.md`)                                                                                                                                                                                                                                 |
|                               | `sk_prf`                                                                                                                   | Touch ID / Windows Hello (QUICK-UNLOCK Stage 2), only once one is added: each credential's id, name, date, synced flag and either the vault key under its PRF (persistent) or its public key and its MAC under the VK (the gate); the master password's last time (14 days). Opens nothing without the authenticator (`docs/design/notes/PRF-NOTES.md`)                                                                                                                                                                                                                                                                    |
|                               | `sk_opener`                                                                                                                | what the toolbar icon opens: `"panel"` for the side panel, absent for the popup; read by the service worker (`src/platform/action-mode.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                               | `sk_af_sites`                                                                                                              | TOTP autofill Stage 2: the sites the user turned code suggestions on for (`{v: 1, hosts}`, at most 32; `src/platform/autofill-sites.ts`). Device-local, never synced, backed up or exported; what counts is it ∩ Chrome's grants (reconcile)                                                                                                                                                                                                                                                                                                                                                                               |
|                               | `sk_sync_cfg`, `sk_sync_state`, `sk_sync_staged`, `sk_sync_outbox`, `sk_sync_orphan`, `sk_prejoin`                         | left by the server sync's client (removed, DV-0b) in a dev or e2e profile that had it on; that build's worker removes them, the identity's IndexedDB database `sixkey-identity` and the sync's four alarms (`sk-sync-*`), at an install or an update (`src/platform/server-sync-leftovers.ts`). No build reads or writes them otherwise                                                                                                                                                                                                                                                                                    |
|                               | `sk_plugins`, `sk_plugins_overlay`, `sk_plugins_unverified`                                                                | autofill's switch (`src/core/plugins/grants.ts`, `store.ts`): its entry, tagged under a key derived from the vault key; the overlay that can only tighten; a record whose tag failed, which an earlier version kept and the next write removes. Another plugin's entry an earlier version stored is honoured by nothing and left out of the next record. Never synced, backed up or exported                                                                                                                                                                                                                               |
|                               | `sk_csb_cfg`, `sk_csb_state`                                                                                               | the backup in Chrome sync (`src/platform/csb-config.ts`), absent until it is turned on, off or refused: on or off, the recovery-only switch, whether the user turned it off, this device's copy (`core/cloud/slots.ts` `SlotLink`: its id and tags, the save counter and checksum, the vault's and key's ids, the wraps' methods and IVs, the ids of copies it made); the status's times and error kind, the bytes used, the other copies counted, whether one was seen, and whether this worker could not close `storage.sync` (`unsafe`). Written by the worker only; the popup reads both with the settings. No secret  |
| `chrome.storage.sync`         | `bk1.<slot>`, `bk1.<slot>.<i>`                                                                                             | the backup in Chrome sync's copies, one per device (`core/cloud/slots.ts`): an index (a random tag, the piece count, the length, a SHA-256 and the save time) and up to 13 pieces of the encrypted file. Written only by the service worker (`src/platform/csb-area.ts`, imported by `csb-worker.ts` alone), read by the settings page and the popup's welcome (`src/platform/csb-read.ts`), closed to content scripts at every start (below). Chrome syncs it to the Google account it is signed in to, if sync is on with extensions; Sixkey cannot tell                                                                 |
| IndexedDB `sixkey-mirror`     | `sk_mirror_gen`, `sk_snap_idx`, `sk_snap_*`                                                                                | the second copy of the vault and its daily snapshots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| IndexedDB `sixkey-identity`   | `identity`                                                                                                                 | the server sync's (removed, DV-0b): the device ID, its non-extractable signing key, the pins; deleted with the records above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| IndexedDB `sixkey-rules-live` | `sk_rules_switch`, `record`, `due`, `got`                                                                                  | the site rules' updater (TOTP autofill Stage 3, AF3-U2; `src/platform/rules-live.ts`), only in a build with its release gate open (`scripts/rules-update.mjs`): its switch (off unless the user turns it on in Settings › Security › Autofill), the signed bundle in use with its floor and retired keys (`src/core/rules/signed.ts`), when the next daily check is due, when the bundle was taken; read and written by the service worker alone, never by a page. A gate-open build creates the database, empty, at the first Fill path's ask or daily alarm, even if the switch is never turned on (the switch is in it) |
| `chrome.storage.session`      | `sk_session`, `sk_lock_epoch`, `sk_quick`, `sk_fill_req`                                                                   | the unlocked key (standard mode), the lock counter, with the Touch ID / Windows Hello gate the vault key itself (from the master password, 12 hours at most); the pending fill request of the Fill shortcut (60 s at most, no secret: `docs/design/notes/AUTOFILL2-NOTES.md`); memory only                                                                                                                                                                                                                                                                                                                                 |
|                               | `sk_sug_shown`, `sk_sug_open`                                                                                              | TOTP autofill's in-page suggestion, only in a build with its release gate open (`scripts/suggest-ui.mjs`; closed in the store build): the documents the worker answered "show it" (document IDs and times, at most 64, ten minutes each) and each tab's bucket of opens (two, then one per 30 s), so that a click opens Sixkey once per page; no address, nothing of the page or the vault (`src/platform/page-open.ts`); memory only                                                                                                                                                                                      |
|                               | `sk_cloud_go`                                                                                                              | the handoff of the popup's "Back up now" (`src/platform/cloud-go.ts`): the time of that click, with the backup in Chrome sync off; Settings › Backup's card takes it within 60 s and turns the backup on as it loads, unless the user turned it off before                                                                                                                                                                                                                                                                                                                                                                 |
|                               | `sk_pw_format`                                                                                                             | only for a generated master password: its style (16 characters or 5 words) and the wrap's salt, for the master-password inputs (settings page, popup lock screen); never on disk                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                               | `sk_action_click`                                                                                                          | side panel mode only: the time of the last click on the icon, so an open panel reads the clicked tab's address again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                               | `sk_af_pending`, `sk_af_later`                                                                                             | TOTP autofill Stage 2: the last ask for a site (host and time; the worker's `onAdded` may finish it within 60 s), and the sites answered "Not now" or refused; no secret                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                               | `sk_plugins_epoch`, `sk_plugin_log`                                                                                        | the grant record's rollback epoch, and autofill's request log (no code, account or site; `src/core/plugins/session.ts`), shown under its switch                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| page `localStorage`           | `sk_lang`, `sk_theme`, `sk_install`                                                                                        | language, theme, the last install-source answer; outside the vault and every backup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Not in any area: the site rules' bundle (TOTP autofill Stage 3) is a file of the package, `rules/baseline.json`, which
`src/platform/package-data.ts` reads from the extension's own origin and keeps in memory for the life of the context
that asked (the popup's and the side panel's Fill paths and their "same sign-in" lines, in lazy chunks; not the
worker's shortcut yet); nothing of it is written to any area.

[PRIVACY.md](PRIVACY.md) lists the same in plain language.

## 4. Trust boundaries

- **Web pages.** There are no declared content scripts, no host permission at install and, in the store build, nothing
  exposed to pages. TOTP
  autofill Stage 2 (`docs/design/notes/AUTOFILL2-NOTES.md` §7 and §9; the wording towards users is a draft, OWNER-DECISIONS/14
  OQ3):
  - the manifest declares `https://*/*` as an optional host permission, asked for one site at a time, exactly
    `https://<host>/*` (that host over https, at any port), in the click that turns code suggestions on for that site;
    `src/platform/autofill-sites.ts` keeps the list;
  - `src/platform/autofill-reconcile.ts` works out, at every worker start, permission event and change of the list, which
    sites count: the list ∩ Chrome's grants, and none unless `storage.local` and `storage.session` are closed to content
    scripts. `src/platform/autofill-register.ts` registers one content script for exactly those (the finder
    `inject/otp.js`, then `inject/suggest.js`, in the isolated world, every frame, at document idle), asking the storage
    gate again first, and removes it when none count;
  - the content script does nothing until the user's own (`isTrusted`) click or key press in an input; then it asks the
    finder, and when that box is a code box it sends the worker one message, `{type: "sk-af-cand"}`, with no field, once
    per page address. It writes nothing to the page and gets no answer. The worker takes the sender from the browser
    (`contentSender` in `src/platform/sender-policy.ts`: this extension's content script, an active non-incognito tab, a
    live document, https frame and top page at the default port), rate-limits it (10 a minute per tab), checks that
    Autofill is switched on and that both hosts are listed and granted, and sets that tab's toolbar badge ("1") and
    tooltip (`src/platform/content-channel.ts`).
    It opens no vault, counts no activity and fills nothing: the Fill shortcut fills there as everywhere, through the
    host permission instead of `activeTab`.
  - That is the store build. TOTP autofill's in-page code suggestion has a release gate of its own
    (`scripts/suggest-ui.mjs`, `SUGGEST_UI_IN_STORE_BUILD`): closed in the store build until the owner's checks in a real
    Chrome pass (`docs/OWNER-CHECKLIST.md` items 52 to 58), open in the dev and e2e builds, and with it closed the store
    build has none of the suggestion's code (`scripts/suggest-guard.mjs`, check-dist). With it open
    (`docs/design/notes/AUTOFILL2-NOTES.md` §12 and §13):
    - the worker answers `cand` with whether to draw the suggestion, `{show: true, key}` or `{show: false}`, the same
      whether Sixkey is locked or not; the content script then draws "Fill code with Sixkey · <host>" just below the box
      (above it when there is no room; `src/inject/suggest-ui.ts`): one element of Sixkey's own (`sixkey-suggest`, its
      content in a closed shadow root, in the top layer), which the page can see, so it can tell that Sixkey is on for
      it, but cannot read or click for the user;
    - its click is the content script's second message, `{type: "sk-af-open"}`, accepted only from the user's own click
      after its visibility clock reaches 800 ms at full size (the DOM-clickjacking set K3, notes §13.3 to §13.5;
      observer timing and a cue that widens the button retain the limits in §13.4 and §13.11). The worker then writes
      the request R v2 for that document and opens Sixkey's own popup or side
      panel, which fills only after the user confirms there, or unlocks there, behind a 600 ms input delay;
    - each step has a deadline (notes §13.8): a storage call inside its lock 5 s, the worker's answer to `cand` 15 s, the
      content script's wait 20 s, so that an answer the browser loses holds neither the lock nor the page.
  - The Fill shortcut's own path, in every build (AF-BOUND, notes §13.10): its read of the lock epoch, R's write under the
    lock `sixkey-fill-req` (which the worker, the popup and the side panel share), and the popup's read and take of R
    each give up after 5 s (`src/platform/bounded.ts`). A lost answer ends that press with the popup on the lock screen
    without the page's line, and the lock is let go.

  The popup reads the current tab's address (and, when asked, its visible part to find a QR code)
  through `activeTab`, only while it is open. The side panel does the same for the tab the icon was clicked on (the service
  worker opens it in that click, which grants `activeTab`), and gets no address for a tab the icon was not clicked on; it
  asks for no `tabs` permission. On top of that, and only on the user's action, `chrome.scripting.executeScript` runs one
  script of the extension's own (`inject/otp.js`, built from `src/inject/otp.ts`, dependency-free and without any `chrome`
  API) in that tab, for an account **registered** for the page (never "possibly related"): once to look for the code box,
  when Sixkey is opened on such a page, and once to type the current code into it, when the user clicks Fill or presses
  the `fill` shortcut (the service worker handles the shortcut and fills only for one account and one box; otherwise it
  opens the popup). `scripting` is an optional permission (since wave 1b of the plugin platform): the first Fill click
  asks for it in that click (Chrome grants it without a dialog), turning a site on asks for it with the site, and turning
  autofill off gives it back; every use of `chrome.scripting` waits for Chrome's answer that it is held. Autofill is
  built in: the code comes only through its capability gate (`src/platform/plugins/autofill-gate.ts`: the vault key, a
  grant record that verifies, its switch on, `codes.forPage` within its ceiling; each ask in its request log), which
  passes only that code, with the page's origin, the one registered
  domain that covers it and a one-use box token, to a single call pinned to one document by its ID; the script checks the
  origin, host and frames again before it writes, never submits or presses a key, and keeps no secret. All three calls are
  in `src/platform/autofill.ts`; `docs/design/notes/AUTOFILL1-NOTES.md` has the attack surface step by step. Right before
  the one call that carries the code, the tab must still be in front (for the shortcut and the side panel, the active tab
  of the focused window; for the toolbar popup, which takes the window's activation itself, the front tab of its own
  window), and in the page the script refuses a document that is not on screen (`visibilityState`). Of a content script's messages the worker takes only the
  content channel's one type (above); its page checks below ignore every other.

- **Other extensions and programs.** The service worker and the offscreen document answer a message only if its
  sender is one the message's type names. That is one of Sixkey's own pages, or, for the offscreen document's one
  message from the worker, the worker itself; it is not every context that carries Sixkey's ID (a content script would
  carry it). The sender's URL must be one of Sixkey's own pages at an exact path, and its origin and tab must be
  Sixkey's. The table `MESSAGE_SENDERS` (`src/platform/sender-policy.ts`) lists the receiver and the allowed senders
  of each type, and a type with no row is ignored.
  Separately, at every start the service worker asks the browser to close `chrome.storage.local`,
  `chrome.storage.session` and `chrome.storage.sync` to anything that is not a Sixkey page or the worker
  (`TRUSTED_CONTEXTS`, `src/platform/storage-access.ts`; the three calls come first in the built worker,
  `scripts/sw-order.mjs`). That setting is held by the browser, not by the worker's start order, and a refusal is
  recorded in the diagnostics log (`docs/security/local-vault.md`); for `storage.sync` a refusal also keeps the backup in
  Chrome sync from writing anything in that run of the worker, and its card says why. Both are the hardening
  TOTP autofill needed before any script ran in a page (`docs/design/proposals/TOTP-AUTOFILL.md` §4.2): the injected
  script has this extension's ID, but it cannot message the worker, and from Chrome 140 it cannot read or write these
  areas. Sixkey requires Chrome 140 (`minimum_chrome_version`, since wave 1b): before it `storage.local` could not be
  closed. The check stays as a second layer: autofill injects nothing unless the browser has just accepted the level for
  both areas (`storageClosed`, awaited by `src/platform/autofill.ts` before every injection); where it has not, Sixkey
  shows "Autofill needs Chrome 140 or later" instead. There is
  no `nativeMessaging` and no local server.
- **The worker's storage listeners.** A `storage.onChanged` listener in the service worker is a handler outside the
  sender gate above: any context that can write Sixkey's storage fires it (after `TRUSTED_CONTEXTS`, only Sixkey's own
  pages and worker can). So the worker has exactly two, each listed by name in
  `test/unit/autofill-pre-source-rules.test.ts`, and each takes from a change only the names of its keys, never a value,
  then reads the records itself, as at every start: what the toolbar icon opens (`src/platform/action-mode.ts`:
  `sk_opener`, `sk_settings`); and the vault's pointer for the backup in Chrome sync's debounce
  (`src/platform/csb-worker.ts` `watchVault`: `sk_active`). A third, the grant store's two records for the Google Drive
  backup's plugin, went with that path (its code is gone). The worker has no listener on `storage.sync`: its runs and its daily check suffice, and the pages listen while they are open.
- **Other extensions and web pages.** None can message Sixkey: the manifest has no `externally_connectable`, so no web
  page can try; Chrome then lets any extension try, but no build listens for another extension's messages or ports
  (`scripts/check-dist.mjs` refuses `onMessageExternal` and `onConnectExternal` in shipped code), so the attempt fails
  as for an extension that is not installed. The plugin platform that used them was removed on 2026-11-12, with its
  pages, its SDK and its samples, and so was the optional `management` permission. What is left of it is autofill's
  switch. Autofill is built in, under a reserved ID no extension can have, official with `codes.forPage` as its whole
  ceiling; its switch is its entry in the grant record (`src/core/plugins/grants.ts`, `store.ts`), tagged with a key
  derived from the vault key (a retired key counts only inside the key-change cleanup, and a write checks under the
  vault lock that its key is still the active one, and waits while that cleanup has yet to re-tag the record). Off gives
  back `scripting` and each listed site's grant, and keeps the list.
- **The network.** The store build's CSP allows no origin (`connect-src 'none'`). The dev and e2e builds allow only the
  site rules' updater's one path (its release gate is open there), for their worker; no build has an API origin or a
  host permission for one since the server sync's client went (DV-0b). Every core page uses `connect-src 'none'`. No
  build reaches Google: the Google Drive backup through the official cloud plugin, withdrawn on 2026-11-06, is removed
  (`docs/design/notes/CSB-NOTES.md` §16), and no build has `identity`, `oauth2` or a Google origin.
  `scripts/check-dist.mjs` verifies exact policies, permissions, origins and `fetch` counts for each flavour, and
  refuses the server sync's API origins, Google's hosts and the Drive path's marks in every build.
- **The backup in Chrome sync.** `platform/csb-worker.ts` writes the vault as it is on disk (made with no key, also
  while locked) into `chrome.storage.sync` through `platform/csb-area.ts`, the one module that writes that area, one copy
  per device, by the rule of `core/cloud/slots.ts` (never another device's copy; a copy that may be newer than this
  device's data holds the backup until a page merges it). The settings page reads the area (`src/platform/csb-read.ts`;
  the popup's welcome too, to offer a copy found), opens copies with what the user types (restore, merges) and sends the
  worker `sk-csb-*` messages, which only the settings page may send (`sender-policy.ts`): the popup's "Back up now" only
  leaves the card a request to turn it on (`cloud-go.ts`); the three that lift or replace a hold or remove other
  devices' copies (after the person merged them) name the generation the page wrote, are sent from inside the store's
  lock that committed it, and are taken only while the vault on disk is still that generation; a removal also only if this
  device's own copy then fits. Sixkey makes no request for it: Chrome syncs the area.
- **The sync server is not trusted with secrets.** Sync is designed so that a malicious or breached server (attacker
  A1 in SYNC-DESIGN §1.2) sees only ciphertext, wrapped keys and coarse metadata. Its remaining power (offline guessing
  of the master password against the wrapped key, withholding updates) is stated in the residual column there.
- **Files and the camera.** Settings › Add account reads files the user chooses or drops (in memory, by content) and,
  when asked, the camera through `getUserMedia` in the settings tab (Chrome's own prompt for the extension's origin;
  no manifest permission; frames decoded in memory and dropped). With a handle from Chrome's file picker it can delete
  the imported file, after Chrome's write prompt and only on the user's click (`src/platform/file-access.ts`,
  `src/platform/camera.ts`). The popup has neither.
- **Not defended against:** malware running as the user, and a process that can drive the browser profile's
  debugging port while Sixkey is unlocked (attacker A10). Both are documented limits.

## 5. Cryptography in one table

| What             | How                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vault key (VK)   | 32 random bytes; its ID `vkId` is a 64-bit HKDF output                                                                                                                                                                                                                                                                                                                                                                                                 |
| Vault encryption | AES-256-GCM under HKDF-SHA256(VK, `sixkey/v1/vault-enc`); vault ID, VK ID and revision in the additional data; a fresh 96-bit IV per encryption                                                                                                                                                                                                                                                                                                        |
| Password wrap    | PBKDF2-HMAC-SHA256, 2,000,000 iterations for every new wrap of this device's keyring, at least 600,000 (also enforced when reading stored parameters), 16-byte salt, NFKC-normalised password                                                                                                                                                                                                                                                          |
| Recovery key     | 128 random bits plus 12 check bits, 28 Crockford base32 symbols; wrap key by HKDF                                                                                                                                                                                                                                                                                                                                                                      |
| Recovery shares  | the recovery key's 128 bits split by SLIP-39's sharing (GF(2⁸), a 4-byte HMAC digest; 2 of 3 or 3 of 5), 36 Crockford symbols each with 20 tagged check bits; nothing stored (SHAMIR-NOTES.md)                                                                                                                                                                                                                                                         |
| Device unlock    | a passkey with PRF: AES-256-GCM under HKDF-SHA256(PRF output, empty salt, `sixkey/v1/kek-prf`), the vault, VK and credential IDs in the additional data, a 32-byte PRF salt per credential; one without (the gate): its ES256 or RS256 public key with an HMAC-SHA256 of it under HKDF-SHA256(VK, `sixkey/v1/gate-mac`), every assertion checked by Sixkey (client data, RP ID hash, UP and UV, signature). Windows Hello: unverified on real hardware |
| Sync additions   | the server sync's, in the server and the contract only since the extension's client went (DV-0b): KeyBundle MAC (HMAC-SHA256), write proofs, device-name and device-backup encryption, all under HKDF subkeys of the VK with distinct labels; device signing keys ECDSA P-256; enrolment by ephemeral ECDH P-256 with a 128-bit pairing code in K and a 6-digit SAS                                                                                    |

All of it is WebCrypto. The full label and additional-data table is SYNC-DESIGN §2.2; every label is in the shared
known-answer vectors but the local-only ones of the PIN and the device unlock (QUICK-UNLOCK §5.2), which
`test/unit/contract-vectors.test.ts` holds distinct from them.

## 6. Sync, in outline

The extension's client of this sync is removed (DV-0b; OWNER-DECISIONS/25: it can be found in the history); devices of
one person are to sync through Chrome sync instead. What follows is the design the server (`api/`) and the contract
still implement, kept for a possible paid cloud.

- **What is stored on the server**: per account, one encrypted vault envelope (the same envelope format as the local
  vault, padded to 16 KiB buckets), a KeyBundle (the VK wrapped by the master password and by the recovery key, with a
  MAC), verifiers for password and recovery proofs, the devices' public keys and encrypted names, and a bounded
  history of earlier versions.
- **Rounds**: the engine pulls when the server's version or head differs from what it last saw, merges (the merge is
  commutative, associative and idempotent), and pushes with a compare-and-set on the version; the loser of a race pulls,
  merges and retries. Bad remote data never overwrites good local data.
- **Requests** are signed by the device's key over the host, method, target, time and body hash, within a five-minute
  window. Writes also carry a proof derived from the VK, so a stolen device credential without the VK cannot write.
- **New devices** join by approval from an enrolled device (its 28-character pairing code typed on the new device,
  the new device's 6-digit SAS typed on the approver) or with the recovery key. Lost devices are revoked; rotating the VK keeps a revoked device from reading anything written afterwards.
- **Where it ran**: the network was reached only from the service worker. The settings page's Sync section, which drove
  the user's flows through the bridge, and the developer sync page went from every build first (DV-0a), then the
  engine, its worker, bridge and transport and the API origin (DV-0b). The server (`api/`) and the contract's vectors
  stay, for a possible paid cloud; the extension keeps one test of the vectors' groups that its own vault format and
  keyring share (`test/unit/contract-vectors.test.ts`).

The full design, threat model and state machines are [SYNC-DESIGN.md](SYNC-DESIGN.md); the implementation notes by
milestone are in [design/notes/](design/notes/).

## 7. Build flavours

`scripts/build.mjs` makes three flavours; each goes to its own directory, so a test build is never where the store
package is made from (`scripts/package.mjs` zips `dist/` only after `check-dist` has passed it).

|                                                                                | prod (store)                                                                          | dev                              | e2e                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------- |
| Command, output                                                                | `npm run build`, `dist/`                                                              | `npm run build:dev`, `dist-dev/` | `npm run build:e2e`, `dist-e2e/`         |
| API origin and its host permission                                             | none                                                                                  | none                             | none                                     |
| The server sync's client (its Sync section, developer page, engine, transport) | never                                                                                 | never                            | never                                    |
| In-page code suggestion                                                        | only when `SUGGEST_UI_IN_STORE_BUILD` (`scripts/suggest-ui.mjs`) is true; it is false | yes                              | yes, with its test record (`__skSugLog`) |
| Backup in Chrome sync: write after a change                                    | 30 s                                                                                  | 30 s                             | 5 s (`__CSB_E2E__`)                      |
| Minified; source maps                                                          | yes; no                                                                               | no; yes                          | yes; no                                  |
| Install-source check                                                           | on                                                                                    | off                              | off                                      |
| Site rules (`rules/baseline.json`)                                             | the repository's `rules/build/baseline.json`                                          | the same                         | the same, plus `test/fixtures/rules/`    |

No build has `identity`, a Google CSP path or OAuth clients (the Google Drive backup's code is removed). The backup in
Chrome sync, its card and its restore are the same in every flavour, but for the e2e build's shorter wait.
`scripts/check-dist.mjs` checks each flavour against its own expected manifest
and rules (`npm run check`, or `--dev` / `--e2e`). Every flavour carries the extension's licence (`LICENSE.txt`) and the third-party notices
(`THIRD-PARTY-NOTICES.txt`, generated by `scripts/notices.mjs`) at its root, and the site rules' bundle with its licence
(`rules/baseline.json`, `rules/LICENSE.txt`; `scripts/rules-package.mjs`). The Sync section had a release gate of its own
(`scripts/sync-ui.mjs`); it went with the section, so nothing can turn the section back on, and the build's graph guard
and check-dist refuse it in every flavour (`test/unit/no-sync-section.test.ts`).

The store package (`npm run package`) is refused, before anything is built, while Sixkey's own `STORE_ID` is empty or
the developer build's ID (`scripts/store-gates.mjs`), and while its site rules' bundle names no source, or not the one
`REPO_URL` gives for its version (`scripts/rules-package.mjs` `sourceGate`; `scripts/repo-url.mjs`). It carries no
manifest `key`. The first upload, which only gets the store ID, is an ID draft named not to publish (`--id-draft`); the
steps are in `extension/README.md`, "Publishing".

The test build (`npm run build:test`, `dist-test/`, checked by `check-dist --test`) is the prod flavour for testing by
hand: every release gate, define, CSP, permission and module-graph guard is the store build's, but its manifest name is
"Sixkey (test)", its manifest carries a public key of its own (`manifest.test.json`: the ID
`copndbnmkakfiohikpecmdaoldodaojc`, pinned in `scripts/check-dist.mjs`, neither the dev build's nor the store's), so
that copies on two computers share their data in Chrome sync, and its install-source check is off (loaded unpacked, it
would always show its notice). The prod check refuses it, and `scripts/package.mjs` never packages it.

## 8. The server

`api/server/sixkey_server/`:

| Module                                                               | What                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.py`                                                            | the app, the table of the 29 operations, CORS, the outer error guard; refuses production mode for now                                                                    |
| `pipeline.py`                                                        | the steps every request goes through: body limit, account session, signatures, strict JSON parsing and the contract's schemas, proofs, rate limits, errors, the log line |
| `routes/`                                                            | handlers: `auth`, `account`, `vault`, `keys`, `devices`, `enroll`                                                                                                        |
| `wire.py`, `sigauth.py`, `account_session.py`, `schema.py`           | keyless checks, request signatures, session tokens, strict JSON and schema validation                                                                                    |
| `auth_provider.py`                                                   | the sign-in provider interface and the development-only `FakeAuthProvider`                                                                                               |
| `ratelimit.py`, `retention.py`, `jobs.py`, `applog.py`, `migrate.py` | limits, history retention, the daily job, allow-listed JSON logs, migrations                                                                                             |

The database schema is in `api/server/migrations/` (ordered SQL files with row-level security and least-privilege
roles; the runner records each file's hash and refuses a changed one). Configuration is entirely `SIXKEY_*`
environment variables (`config.py`). The tests run against a real PostgreSQL; see [api/server/README.md](../api/server/README.md).

## 9. The contract

- `api/openapi.yaml` is the API contract (written in JSON syntax, so both sides read it with a plain JSON parser).
  Every operation cites the design sections it implements.
- `contract/vectors/sync-v1.json` holds the known-answer vectors for every label, format and protocol step;
  `contract/tools/gen-vectors.mjs` generates them with Node's WebCrypto, importing nothing from the extension.
- `contract/py/sixkey_contract.py` is a separately written Python reference implementation and validator, used by the
  contract's own tests and as the oracle for the server's responses.
- `contract/tools/check_consistency.py` compares the design document's API tables with the contract.
- The extension checks itself against the same files (`test/unit/contract-*.test.ts`, `test/unit/sync-crypto-*.test.ts`).

These are separate code but not independent authorship: [contract/M0-NOTES.md](../contract/M0-NOTES.md) ("Caveats on
independence") says what they can and cannot catch.

## 10. Tests

| Suite                                    | Where                                                                              | Run with                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| Unit, fault-injection, regression (Node) | `extension/test/{unit,fault,regression}/*.test.ts`                                 | `npm test`                                          |
| End-to-end in Chromium                   | `extension/test/e2e/`, `test/regression/*.spec.ts`                                 | `npm run e2e`                                       |
| Server                                   | `api/server/tests/`                                                                | `make check`; `make mutants` for the mutation check |
| Contract                                 | `contract/py/test_contract.py`, the generator's `--check`, the consistency checker | see the [README](../README.md#build-and-test)       |

The internal review records, and what became of each finding, are in [audit/](audit/README.md).
