# Sixkey roadmap

Where Sixkey stands and what comes next. Status as of 12 November 2026. Nothing here is a promise of a date; the order can
change when a review or a test finds something. The original product plan (in Chinese, with its status notes of the
time) is kept for the record in [docs/history/PLAN-zh.md](docs/history/PLAN-zh.md); this page replaces it.

## In short

| Part                                       | State                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local authenticator (the store build)      | Built and tested. Not in the Chrome Web Store yet: the maintainer is using it day to day first.                                                                                                                                                                                                                                                                                                                                                         |
| Own master password                        | Built: the master password is your own (a very weak one is refused, one under about 50 bits gets a warning); the random recovery key is for recovery only; its Shamir shares were removed on 2026-11-25 ([notes](docs/design/notes/OWN-PASSWORD-NOTES.md), [shares](docs/design/notes/SHAMIR-NOTES.md))                                                                                                                                                 |
| Quick unlock, stage 1 (PIN)                | Built: a PIN of 4 to 8 digits reopens Sixkey, also after a browser restart; 5 wrong tries in a row ask for the master password ([design](docs/design/proposals/QUICK-UNLOCK.md), [notes](docs/design/notes/))                                                                                                                                                                                                                                           |
| Quick unlock, stage 2 (Touch ID, Hello)    | Built: Touch ID or Windows Hello through a passkey (WebAuthn PRF), also after a restart when the passkey syncs ([notes](docs/design/notes/PRF-NOTES.md)). Stage 0 measured it on a Mac; Windows is still unmeasured                                                                                                                                                                                                                                     |
| TOTP autofill, Stage 1 (Fill, shortcut)    | Built: a Fill button on the matching account and a `Fill code` shortcut type the current code into the page's code box, on your click only ([notes](docs/design/notes/AUTOFILL1-NOTES.md))                                                                                                                                                                                                                                                              |
| TOTP autofill, Stage 2 (sites you turn on) | Patches 1 to 3 built: a fill that waits for your PIN, sites turned on one at a time, and on those sites the toolbar icon shows when the code can be filled ([notes](docs/design/notes/AUTOFILL2-NOTES.md)). Patch 4, a suggestion next to the code box, built, off in the store build. Stage 3 under way: every build carries the site rules' bundle, which Fill reads; signed rule updates built, off in the store build                               |
| Plugin platform                            | Removed from the extension on 2026-11-12, after it was stopped on 2026-11-06: no other extension can add to Sixkey or message it, and the SDK and samples are gone. Autofill, which it made a built-in, keeps its own switch ([design](docs/design/proposals/MOD-PLATFORM.md), kept for the record)                                                                                                                                                     |
| Backup in Chrome sync                      | In the build from 2026-11-08: an encrypted copy of the vault in the browser's own sync storage, written automatically after each change, with its status always shown; a new computer restores it with the master password or the recovery key ([notes](docs/design/notes/CSB-NOTES.md)). The encrypted backup file stays. The Google Drive backup through a separate plugin was withdrawn on 2026-11-06. Backing up to a folder you choose not started |
| Side panel mode                            | Built (planned for after M8; the owner moved it ahead): Sixkey's list in the browser's side panel, optional ([notes](docs/design/notes/SIDEPANEL-NOTES.md))                                                                                                                                                                                                                                                                                             |
| End-to-end encrypted sync (M0–M6)          | Built and tested, **set aside** (OWNER-DECISIONS/25): since 2026-11-17 no build has a way to turn it on, its settings section gone from every build, and then the extension's whole client (DV-0b; in the history if ever needed); the server and the contract stay for a possible paid cloud                                                                                                                                                           |
| Server-side key encryption (M7)            | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Hosted service and go-live (M8)            | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Self-hosting                               | Not possible yet ([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md))                                                                                                                                                                                                                                                                                                                                                                                         |
| YubiKey support                            | Design proposal only ([docs/design/proposals/YUBIKEY-DESIGN.md](docs/design/proposals/YUBIKEY-DESIGN.md)); postponed                                                                                                                                                                                                                                                                                                                                    |
| External security review                   | None yet. The external review of the local vault comes after the first store listing (see "Reviews" below)                                                                                                                                                                                                                                                                                                                                              |

## What is shipped, and what is gated

Nothing has been released. The extension's **store build** is the part meant to ship first: a local authenticator with
no host permission at install, no way to turn sync on, and no network request of its own. Its automatic backup, in the
build from 2026-11-08, is an encrypted copy kept in the browser's own sync storage, which Chrome's sync carries; the
encrypted backup file stays. The Google Drive backup through a separate plugin was withdrawn on 2026-11-06.
Of what is listed under "Sync" below, the server and the contract stay in the code; the extension's client (M1–M3, M5,
M6) was removed on 2026-11-17 and can be found in the history: no build has the settings page's Sync section, the
developer sync page, the engine, its worker, bridge and transport, or the API origin, and `scripts/build.mjs` and
`scripts/check-dist.mjs` fail any build that contains them (OWNER-DECISIONS/25). Devices of one person are to sync
through Chrome sync instead.

## The local authenticator (Phase 0 and its hardening)

Done:

- TOTP codes (RFC 6238; SHA-1, SHA-256, SHA-512; 6 or 8 digits), site matching, HOTP accounts stored and backed up (no
  HOTP codes yet).
- Import from `otpauth://` links, Google Authenticator export QR codes, QR codes on the page or in a pasted screenshot,
  key lines, and Sixkey backups.
- Import from a file (Choose file or a drop: link lists, the unencrypted exports of Aegis, 2FAS, andOTP, Raivo,
  Bitwarden, FreeOTP+ and Proton Authenticator, CSV, QR images; encrypted exports are named, not opened), the camera
  in the settings page (one code, or every code of a Google Authenticator export), and the offer to delete the imported
  file afterwards (`docs/design/notes/IMPORT-FILE-NOTES.md`). Its real-browser checks are in the owner's checklist
  (item 19).
- The encrypted vault: a vault key protected by the master password and by a recovery key; a master password before
  the first account; several local copies so a crash or a damaged write does not lose saved data.
- The master password again before every export, and a local record of wrong passwords and exports.
- A master-password generator ("Generate for me": 16 random characters or 5 words, with its strength known), and a
  generated password may be typed back without its hyphens and in any case.
- Quick unlock, stage 1: an optional PIN that reopens Sixkey after it locks, on a profile marked as used by one person;
  since 2026-10-30 also after a browser restart, with no time limit, and 5 wrong tries in a row ask for the master
  password once (before, at most 12 hours after the master password); quick lock from the popup and a keyboard shortcut.
- The side panel mode: Settings › Appearance chooses whether the toolbar icon (and its shortcut) opens the popup, the
  default, or the browser's side panel, and the popup can hand over to the panel. The panel stays open beside the page,
  so it locks after 15 idle minutes; it is not offered in a shared profile. It adds the `sidePanel` permission (no
  install warning). It was planned for after the sync milestones (ux-study §2.1); it does not depend on them. The real
  side panel in Edge, Brave and Opera, and the keyboard shortcut in panel mode, are manual checks still to run.
- The View menu: the four Appearance choices (theme, rows, order, hidden codes) one click from the search field, in the
  popup and in the side panel, written to the same preferences as Settings and followed both ways
  (`docs/design/notes/QUICKVIEW-NOTES.md`). Its real-browser checks are in the owner's checklist (item 22).

- TOTP autofill, Stage 1 ([proposal](docs/design/proposals/TOTP-AUTOFILL.md) §12.2): on a page registered for an account,
  the popup and the side panel show a Fill button on the card and say whether the page has a code box; the `Fill code`
  shortcut (Alt+Shift+F) fills the one matching account without opening anything. Heuristics for single boxes, six or
  eight separate boxes, React and Vue inputs, open shadow DOM and frames; never submits, never uses the clipboard; fills a
  code with at least 5 s left. It adds the `scripting` permission (no install warning) and no host permission, no
  content script. Its real-browser checks are in the owner's checklist (item 21). Stage 3 since added the site rules'
  bundle, which every build carries and Fill reads (`docs/design/notes/AUTOFILL3-NOTES.md`; its updates are built, off in
  the store build). Not yet: the toolbar hint (`declarativeContent`).
- TOTP autofill, Stage 2, patches 1 to 3 ([notes](docs/design/notes/AUTOFILL2-NOTES.md)): the Fill shortcut pressed
  while Sixkey is locked opens the popup, and the code is filled once the PIN, Touch ID or the master password unlocks
  it; code
  suggestions can be turned on one site at a time (Settings › Security › Autofill), each adding that one site's
  `https://<host>/*` permission, which Chrome asks for; on those sites a small registered script notices your own
  click or key press in the code box and the toolbar icon shows that the code can be filled. The page sees nothing of
  it. When no account is registered for the page, "Which account is this site for?" at the top of the list
  remembers the choice in one click. Patch 4, a suggestion next to the code box, is built behind a release gate,
  closed in the store build until it passes checks in a real Chrome; clicking it always opens Sixkey's own popup to confirm.
- Your own master password: one you choose and can remember (a very weak one is refused, one under about 50 bits gets
  a warning and "use anyway"); the random recovery key is for recovery only (`docs/design/notes/OWN-PASSWORD-NOTES.md`).
  Its Shamir shares were built and then removed on 2026-11-25 (`docs/design/notes/SHAMIR-NOTES.md`).
- Quick unlock, stage 2: Touch ID or Windows Hello through a passkey with the WebAuthn PRF extension, beside the PIN;
  with a passkey that syncs (iCloud Keychain, Google Password Manager), also after a browser restart
  (`docs/design/notes/PRF-NOTES.md`). The owner's real-Mac checks are checklist items 30 to 34; Windows is unmeasured.
- The plugin platform, waves 1 and 2 ([design](docs/design/proposals/MOD-PLATFORM.md)), through which other extensions
  could add buttons to Sixkey after you approved them, was built, stopped on 2026-11-06 and removed from the extension on
  2026-11-12, with Settings › Plugins, its SDK and its samples. Autofill, which it made a built-in, keeps its own switch
  and its recent requests in Settings › Security › Autofill.
- The backup in Chrome sync (`docs/design/notes/CSB-NOTES.md`), in the build from 2026-11-08: Sixkey writes the vault,
  encrypted, into the browser's own sync storage about 30 seconds after each change, also while it is locked, and
  Chrome's sync carries it to the other computers signed in to the same Google account. For a new vault in a profile
  only you use, its box at the end of first run is ticked; an existing vault takes one click in Settings › Backup, or in
  the popup's "Back up now" reminder. The popup and Settings › Backup say when the copy was handed to Chrome, never that
  it was uploaded, which Sixkey cannot see. Restoring on a new computer is "Restore from Chrome Sync" and the master
  password or the recovery key. Every computer's copy shares about 100 KB: about 220 typical accounts with one computer
  backing up, about 106 each with two. The encrypted backup file stays. Still to come: backing up to a folder you choose
  (iCloud Drive, OneDrive, Dropbox), for which the system's own cloud program uploads the file.
- The cloud backup to your own Google Drive through the official Cloud Backup plugin
  (`docs/design/notes/CLOUDBK-NOTES.md`, `docs/design/notes/CLOUD-PLUGIN-NOTES.md`) was built and tested, and withdrawn
  on 2026-11-06: the plugin is not published. Its code is removed from the tree since 2026-11-08.

Before the first store listing:

- the maintainer's own period of everyday use, with feedback as a normal user;
- the manual checks on a real Chrome toolbar popup (`docs/OWNER-CHECKLIST.md`);
- the store listing text, which must not promise more than the documented limits allow (no "never lose your codes");
- the store publisher account, release signing with Sigstore keyless signing, and the trader declaration (as VIEW TECH
  LTD).

After the first store listing:

- an external review of the local vault. The version first listed has not had one: its reviews are the AI-model review
  sessions described under "Reviews" below.

## Sync (Phase 1)

The design is [docs/SYNC-DESIGN.md](docs/SYNC-DESIGN.md) (in Chinese; an English specification is planned). Each
milestone was reviewed before it was merged ([docs/audit/](docs/audit/README.md)); the implementation notes are in
[docs/design/notes/](docs/design/notes/).

| Milestone | What                                                                                                                                        | State                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| M0        | The contract: `api/openapi.yaml`, shared known-answer vectors, a separately written Python reference, a checker against the design document | Done                                                                  |
| M1        | Sync cryptography (`extension/src/core/sync/crypto`): key bundles, device enrolment, request signatures, write proofs                       | Done; removed from the extension on 2026-11-17 (DV-0b)                |
| M2        | Local sync state and the storage and service layers                                                                                         | Done; its sync parts removed from the extension on 2026-11-17 (DV-0b) |
| M3        | The sync engine, with an in-memory test server                                                                                              | Done; removed from the extension on 2026-11-17 (DV-0b)                |
| M4        | The sync API server (FastAPI, PostgreSQL), with a development-only sign-in provider                                                         | Done; runs in development and test mode only                          |
| M5        | Wiring in the extension: the service worker's API bridge, the optional host permission, alarms and back-off, the build checks               | Done; removed from the extension on 2026-11-17 (DV-0b)                |
| M6        | The settings page's Sync section: turning sync on, joining, devices, approvals, key operations, revocation, repairs, recovery               | Done; removed from every build on 2026-11-17 (OWNER-DECISIONS/25)     |
| M7        | Application-layer encryption of the server's key bundles and write keys with a key management service                                       | Not started                                                           |
| M8        | Go-live: the production sign-in provider, the hosted database, mail, the API domain and TLS, the final privacy and security documents       | Not started; needs the hosting resources listed below                 |

Before a hosted sync could ship (with M8; set aside, OWNER-DECISIONS/25):

- the production sign-in provider (Supabase) and the go-live checklist of SYNC-DESIGN §9 M8, verified on the real
  hosted project, not locally;
- the end-to-end tests on a staging service, and the sync subset on the oldest supported Chromium (140, the manifest's
  `minimum_chrome_version`);
- the extension's client back from the history (removed from every build, DV-0b), with a way to turn sync on in the
  settings page, and the manual checks of it and of the sync permission prompt on a real Chrome (the M5/M6 notes):
  **not run**; they need the hosted service;
- the store's permission text and the listing's "no network" sentence changed in the same release: with sync, Sixkey
  uses the network once the user turns on end-to-end encrypted sync;
- an external design and cryptography review of the sync protocol.

The hosted service is to be operated by VIEW TECH LTD on its own server, with Supabase for sign-in and the database,
mail sent from a `sixkey.app` address, and VIEW TECH LTD's security team on call. The extension's API origin would be
`https://api.sixkey.app` (built in once sync ships, and no other host; no build names it, or any server, now). A
public address for the hosted service, tentatively `cloud.sixkey.app`, is still to be settled.

## Self-hosting

Chosen model: a **separate self-host build** of the extension, so the store build keeps its promise of one fixed API
origin. A sign-in provider that needs only PostgreSQL and SMTP is planned after the hosted service is live. Later, a
backend in the style of SimpleLogin or Supabase may be offered both as a hosted service and as open source to deploy
yourself; the project does not offer to set up hosting for users. Details: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Quick unlock and YubiKey

- **Quick unlock** ([docs/design/proposals/QUICK-UNLOCK.md](docs/design/proposals/QUICK-UNLOCK.md), approved
  2026-10-19). Stage 0, measuring what passkeys can do from an extension page on real hardware, runs with the dev-only
  probe in `tools/webauthn-probe/`; the first Mac runs are done, Windows is pending. Stage 1, the PIN and quick lock, is
  built. Stage 2, unlocking with the computer's own sign-in (Touch ID, Windows Hello) through WebAuthn PRF, is built
  on the Mac's answers; whether Touch ID should start by itself when the lock screen opens waits for the owner's checks
  on a real Mac, and Windows waits for its measurements.
- **YubiKey** ([docs/design/proposals/YUBIKEY-DESIGN.md](docs/design/proposals/YUBIKEY-DESIGN.md)): showing a
  YubiKey's own OATH codes through an optional native helper, and unlocking with a security key (PRF). Not implemented
  and postponed: it needs the store extension ID and code-signing accounts for the native helper (macOS and Windows),
  which are not in place yet. The helper will be licensed Apache-2.0.

## Reviews

Every security-relevant change so far was reviewed in a separate AI-model review session before it was merged; the
records are public in [docs/audit/](docs/audit/README.md), with honest headers. They are not independent audits. Planned
external reviews: a review of the local vault after the first store listing (the version first listed has had no
external review), a design and cryptography review of sync before sync ships, and an implementation audit later. Reports
of external reviews will not be published ([docs/audit/README.md](docs/audit/README.md) says why that matters).

## Publishing the repository

The licences are chosen ([LICENSE.md](LICENSE.md)), contributions use a DCO sign-off ([CONTRIBUTING.md](CONTRIBUTING.md)),
and the security policy has its contact ([SECURITY.md](SECURITY.md)). How the first public commit is made is
[docs/RELEASING-THE-TREE.md](docs/RELEASING-THE-TREE.md).
