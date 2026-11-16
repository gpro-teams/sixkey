# Sixkey privacy policy (Phase 0.x)

**Short version: Sixkey does not collect anything, and sends nothing to its publisher. It makes no network request for
its backup: with the backup in Chrome sync on (on by default for a new vault, shown at the end of first run, where you
can clear it), Chrome's own sync carries your encrypted vault to Google, under the Google account Chrome is signed in
to (below). Sixkey itself reaches the network only for what you turn on: in a later version, sync.**

From 2026-11-06 no build offers the Google Drive backup through a separate plugin any more; the backup in Chrome sync
(below) takes its place, beside the encrypted backup file (Settings › Backup).

## What the extension stores, and where

Everything is stored on your computer, in this browser profile, in the extension's own storage:

- **your accounts**, encrypted: each account's name, account name, secret key and code settings, the group you put it in, the
  sites you registered for it ("Remember this site", the Sites field, or "Show first on …" when adding), when it was
  added, and stamps that order edits (with a random ID for this install). With them: the keys that open them, locked by
  your master password and by your recovery key; up to 10 recent and 7 daily encrypted copies; and a second encrypted
  copy, with up to 7 daily ones, in this profile's IndexedDB;
- **the settings you choose**, not encrypted because they are not secret: locking, how the popup list looks (density,
  hidden codes, order), and when you last saved a full backup; and the random ID of this install used in the edit stamps;
- **upkeep markers** with no keys in them: whether a clean-up after a key change is due, and the key ID it was last done
  for;
- **three small local records**, none of which holds keys, codes or account names:
  - notes of automatic restores, shown to you as "data restored";
  - a log of minor problems (the kind of error only, never its text), which leaves your computer only if you save it
    under Settings › Advanced and send it yourself;
  - the security record (below);
- in the extension pages' own local storage, outside the vault and outside every backup: your language and theme choice,
  and the answer of the last install-source check (store builds only);
- recovery key shares are never stored: Sixkey shows or prints each one, or saves it as a file only when you ask, and
  keeps no record of a share set, except that after you switch to shares, until they pass a check after the next
  browser restart (or the recovery key changes again, or you make a new vault), the security record holds a reminder
  with that set's 4-character id (printed on every share);
- while Sixkey is unlocked: the opened key, in the browser's memory-only session storage (cleared when the browser
  restarts or the extension updates), except in "lock every time" mode, where it stays only in the memory of the page
  you unlocked. The same session storage holds a counter that tells every page about a lock;
- if you set a PIN: its set-up (a key derived from the PIN, encrypted under your vault key; the PIN itself is never
  stored), and your vault key encrypted under a key derived from the PIN, with the set-up it belongs to, a random ID, a
  check value Sixkey computes from your vault key, how many wrong PINs were typed in a row, and when it was last made, on
  this computer's disk, in this browser profile only (since 2026-10-30 that is how every PIN
  works, also after a restart: there is no switch and no time limit; before, it was the "Also after a restart" switch).
  Anyone with a copy of this browser profile can guess the PIN offline from it, as the settings page says where you set
  the PIN: on one high-end graphics card, every 4-digit PIN in a few seconds, every 6-digit one in about 5 minutes,
  every 8-digit one in about 8 hours (someone at this computer still gets only 5 tries in a row, then the master
  password). It is never sent, synced, backed up or exported; removing or changing the PIN, declaring the profile
  shared or making a new vault deletes it, and the 5th wrong PIN in a row, "End quick unlock now" or a change of your
  keys or master password deletes the encrypted key from it (the next master password makes it again, or right after
  such a change on the settings page the PIN alone). "Deletes" is what the browser's storage reports: its database
  files can keep the old bytes until the browser compacts them, so a copy of the profile taken right after (the 5th
  wrong PIN, a key change, removing the PIN) may still hold the old encrypted key and allow guessing the PIN offline.
  Changing your keys afterwards protects only the accounts you add after it (the same files may still hold your vault
  under the old key); for the accounts already in Sixkey, only setting up their two-step verification again at each
  service makes such a copy useless;
- if you turn on unlocking with Touch ID or Windows Hello (Windows Hello: built to the same rules, not yet tested on a
  Windows PC): for each passkey you add, its ID, its name and the date, whether it syncs, and either your vault key
  encrypted under a key that only that passkey can give back (with the random value Sixkey asks it for), or, for one that
  cannot give such a key, its public key with a check value Sixkey computes from your vault key (so that one added by
  anyone else is refused); and when you last typed the master password (Sixkey asks for it every 14 days). With a passkey
  of the second kind, after you type the master password, your vault key is kept in the memory-only session storage until
  you quit or restart the browser, for at most 12 hours. Sixkey never sends, syncs, backs up or exports any of it. **The
  passkey itself is kept by your operating system or your passkey provider** (Apple's Passwords app / iCloud Keychain,
  Google Password Manager, Windows Hello, Chrome's own store, or a password manager), under their terms: one that syncs
  is copied to your other devices through that company's account. The provider keeps with it the name "Sixkey", the
  display name "Sixkey unlock · <the date you added it>", a random user ID (nothing about you) and Sixkey's extension
  address (`chrome-extension://<id>`); one that syncs is listed among the passkeys of your Apple or Google account.
  Removing it from Sixkey does not delete it there; Sixkey says where it is;
- if your master password is one Sixkey generated: which style it is (16 characters or 5 words), so the settings page can
  show the matching field. Only in the memory-only session storage, never on disk: it goes when the browser closes, and
  the next unlock with the master password notes it again. It holds no part of the password;
- if you turn on the backup in Chrome sync (below), turn it off (also by clearing its box at the end of first run), or
  this browser would not let Sixkey protect that storage: whether it is on, whether its copy opens with the recovery key
  only, and whether you turned it off; this computer's copy: its random ID, the random tag of the last write (and of one
  under way), the vault's save counter and checksum, its random vault and key IDs, and each key wrap's kind and random
  value (all of which are in the copy anyway), the IDs of the copies this computer made, and whether the copy waits for
  a merge or a merge waits to be written; with it, the times of the last write and of the last try, since when changes
  have waited and since when writes have failed (and how many in a row), the kind of the last error, how much of
  Chrome's sync storage this copy and the others take, how many other copies there are (and of other vaults) and when
  the newest of them was saved, whether another computer's copy was seen, and whether this browser refused to protect
  the storage. None of it is a key, a code, any of your accounts or anything about you.
  In Chrome's sync storage itself: the copy (below).

For reviewers, the keys: in `chrome.storage.local` `sk_active`, `sk_slot_a`, `sk_slot_b`, `sk_snap_idx`, `sk_snap_*`,
`sk_keyring`, `sk_events`, `sk_keychange`, `sk_store_v`, `sk_settings`, `sk_last_backup`, `sk_device`, `sk_security_log`,
`sk_diag`, `sk_pin` and `sk_pin_restart` (the PIN's set-up and its record, only if you set a PIN), `sk_prf` (only if
you added Touch ID or Windows Hello),
`sk_opener` (only if the toolbar icon opens the side panel),
`sk_af_sites` (only if you turned on code suggestions for a site: those sites' names), `sk_plugins` (only if you
turned autofill off or on again: that choice), `sk_csb_cfg` and `sk_csb_state` (only if you
turned the backup in Chrome sync on or off, or this browser refused to protect its storage); in `chrome.storage.sync`
`bk1.<id>` and `bk1.<id>.<n>` (the backup in Chrome sync: each computer's copy, its index and its pieces);
in the IndexedDB database `sixkey-mirror` `sk_mirror_gen`,
`sk_snap_idx`, `sk_snap_*`; in `chrome.storage.session` `sk_session`, `sk_lock_epoch`, `sk_quick` (only with Touch ID
or Windows Hello that unlocks until the browser closes),
`sk_pw_format` (only for a generated master password), `sk_action_click` (the time of the last click on the icon, in side
panel mode only), `sk_fill_req` (for up to a minute after the Fill shortcut was pressed while Sixkey could not fill by itself:
that tab's number and address, never a code or an account), `sk_af_pending` (the last site you clicked "Turn on" for, and
when, until that is answered or the browser closes), `sk_af_later` (the sites whose offer you answered "Not now", or
refused in Chrome's prompt, since the browser started), `sk_plugin_log` (autofill's recent requests, shown under its
switch in Settings › Security › Autofill: one line per fill with its time, `codes.forPage` and the outcome, never the
code, the account or the site; gone when the browser closes), `sk_cloud_go` (for at most a
minute after you clicked "Back up now" in the popup with the backup in Chrome sync off: that click's time, so that
Settings › Backup turns that backup on as it opens); in `localStorage` `sk_lang`, `sk_theme`, `sk_install`,
`sk_af_off` (only whether you turned autofill off in Settings, so a Fill click knows not to ask Chrome for anything).

## The security record

- It lists, with the time only: wrong master passwords and recovery keys, recovery keys that were accepted, exports
  (by kind), changes to your keys (master password turned on, changed or reset, new recovery key, key replaced),
  recovery key shares made of the current key, the PIN set or removed and wrong PINs, Touch ID or Windows Hello added,
  removed or failed, and when the record was cleared. At most 50 entries.
- After you switch your recovery key to shares, it also holds one reminder, until the shares pass a check after the next
  browser restart: its time, a random number that tells this switch apart from another, and the share set's
  4-character id. The popup shows it after each unlock.
- It stays in this browser profile. Sixkey never sends it, never copies it into its IndexedDB copy, backups, exports or
  the diagnostics file. A browser that syncs, clones or exports whole profiles carries it along with everything else.
- After you unlock in the popup, Sixkey tells you how many wrong attempts there were since you last saw this. Settings ›
  Security › Security record shows the list.
- You can clear it there with your master password; one dated line saying it was cleared stays.
- It is an alert, not evidence: anyone who can change the files of this profile can change it.

## The backup in Chrome sync

"Automatic backup to Chrome Sync" (Settings › Backup) keeps an encrypted copy of your vault in the browser's own sync
storage (`chrome.storage.sync`), which Chrome carries to your other computers signed in to the same Google account. On a
new computer, your master password (or your recovery key) brings it back.

- **When it is on:** for a new vault, the last step of first run shows "Back up automatically to Chrome Sync
  (recommended)" ticked when you answer that only you use this browser profile, with what it costs written beside it;
  you can clear it there, which counts as turning it off, and turn it off later in Settings › Backup. It is not ticked
  when you mark the profile as shared or automated. A vault made before this version is never turned on by itself:
  Settings › Backup has the one button, and the popup's "Back up now" reminder (after a week with no backup), in a
  profile only you use, opens that card and turns it on there with that one click, unless you turned the backup off
  before, on the card or by clearing that box. While the backup is on and has not stopped, that reminder does not show.
  A restore from Chrome sync (below) goes on with the copy it came from, unless you clear that box.
- **What is written:** your vault exactly as it is stored on this computer, encrypted: the same encrypted accounts
  (accounts in the trash, and the traces of accounts deleted forever, included), and the keys that open them locked by
  your master password and by your recovery key (or by the recovery key only, if you choose that on the card). With it,
  Sixkey's version and the random IDs of the keys your vault no longer uses (IDs only). Sixkey writes it without
  unlocking anything, also while Sixkey is locked: it never holds your master password, your recovery key or the opened
  key to do it. Nothing is written while your vault has no account. Never written: your PIN and its records, Touch ID or
  Windows Hello, settings, the security record, the problem log, the autofill switch's record, the earlier keys themselves, or
  anything else of this profile.
- **Where it goes:** into Chrome's sync storage, one copy per computer, beside a small index (its length, a checksum,
  the time it was saved and a random tag). Chrome uploads that storage to Google's servers while it is signed in to a
  Google account with sync on and "Extensions" included in what it syncs; otherwise it stays on this computer. **Sixkey
  cannot tell which**: the card says the copy was handed to Chrome Sync, and when, never that it is backed up, and says
  that Sixkey cannot see whether Chrome uploaded it. Sixkey itself makes no network request for it: Chrome's sync does.
  Whether another browser's sync carries an extension's storage is that browser's; Sixkey does not know, and says so
  there.
- **Who can reach it on this computer:** Sixkey's pages and its service worker. At every start the worker asks the
  browser to close this storage to everything else, scripts that run in web pages included (`TRUSTED_CONTEXTS`, as for
  Sixkey's other storage); where the browser refuses, Sixkey writes nothing there and the card says why. Only the
  service worker writes it; the settings page reads it to restore and to merge, and asks the worker for every write or
  removal; the popup's welcome, before this computer has a vault, reads it only to offer a copy it finds there.
- **What Google and whoever controls your Google account can see:** that the Sixkey extension keeps data in Chrome
  sync; how large each copy is (about the number of entries in it); when it was written; the random IDs and tags, save
  counters, key-derivation settings and Sixkey's version; not your accounts, which are encrypted. Whoever gets a copy (for
  example by signing in to that Google account in Chrome elsewhere with sync on) can try to guess your master password
  offline, as with a copy of this browser profile (above), and the recovery key opens it too. The copy on Google's
  servers is kept by Google under its terms.
- **When:** about 30 seconds after each change of your vault (at most 5 minutes after the first of changes that keep
  coming), again after 1, 5 and 30 minutes if a write fails, and once a day (to put back a copy that was removed).
- **Room:** Chrome gives an extension about 100 KB of sync storage in all, which every computer's copy shares: about 220
  typical accounts with one computer backing up, about half that each with two. When this computer's copy does not
  fit, its backup stops and the card says so (nothing else is blocked) and points to the encrypted backup file.
- **What is deleted, and when:** this computer writes over its own copy only. "Turn off" removes it, except while it
  may be newer than the data here (after this computer fell back to an older copy of its own data), when it stays, and
  except when it is the copy of another vault than the one now on this computer (after starting over, or restoring
  another vault): that one may be the old vault's only copy, and stays. Other copies are removed only at your click
  ("Merge them into this computer and remove them" when the space is full, or "Remove them from Chrome Sync" after
  merging another vault's copies), after you opened them with what opens them: only the copies that opened and were
  merged, only if they did not change meanwhile, only while this computer's data is still the merge Sixkey wrote, and
  only if this computer's own copy then fits. "Clear data" in
  Google's sync settings removes every copy, and uninstalling Sixkey on any one computer may too (not verified); the
  computers still in use write theirs again within a day.
- **Restoring:** "Restore from Chrome Sync" (first run and the popup's welcome, where a copy found is offered first, or
  Settings › Backup on a computer with no readable vault) lists the copies in this browser's sync storage, waits for one
  still arriving, and opens them on this computer with the master password or recovery key you type there; what you type
  never leaves this
  computer, and the worker never sees it. A copy of the backup you downloaded opens the same way from Settings › Backup
  › "Choose file".
- **Shared profiles:** the copy goes to whichever Google account Chrome is signed in to, which in a shared profile may
  not be yours; so it is off by default there, and the card says it before you turn it on.
- **On this computer:** `sk_csb_cfg` and `sk_csb_state` (above), in this browser profile only. None is part of a
  backup.

## What the extension does not do

- No analytics, tracking, advertising, or crash reporting.
- No network requests unless you turn something on. The backup in Chrome sync makes none of Sixkey's: Chrome's sync
  carries it. This version cannot turn sync on: its worker has no sync engine or network transport and names no server,
  its network policy allows no connection at all (`connect-src 'none'`, for its pages and its worker), and it has no
  host permission for a server either. A version with sync adds its sync server (`api.sixkey.app`) to both, and only its
  worker makes sync requests. A site permission for code suggestions gives access to that site's pages, not a new
  network destination. Sixkey cannot check your clock or look anything up online.
- No code that runs in a page by itself, except on the sites you turn on for code suggestions (below). Sixkey runs a small
  script of its own (`inject/otp.js`, part of the extension; nothing is downloaded) in a page only because you asked, in the
  one tab you are on, and only if that page's address matches a site you registered for an account. The permission for
  this (`scripting`, which Chrome shows no warning for) is asked for by your first click on **Fill code**, not at
  install: until then, opening Sixkey does not look at any page. After it, opening Sixkey on such a page lets it look for
  the box that asks for a verification code: the script reads the type, size, label and name of the page's input boxes (never what is
  typed in them) and changes nothing. Clicking **Fill**, or pressing the Fill shortcut, types that account's current code
  into that box, once. It never presses a button or submits a form, and never writes anywhere else. The page you fill sees
  the code, as it would if you typed it. A page that matches none of your accounts' sites gets no script. The browser
  allows this through `activeTab`, which it grants for that tab when you click Sixkey's icon or press its shortcut; Sixkey
  asks for no access to any site for this. Whoever starts a fill, the code goes only into the tab in front of the window you
  are in, and only into a page that is on screen. The code is not kept, sent, logged or copied to the clipboard. Of a page, Sixkey
  also reads its address and, when you ask for a scan, its visible part (both described below).
- Autofill is a built-in part of Sixkey with its own switch, in Settings › Security › Autofill (on by default). Every
  code it fills is asked through one gate, which writes one line per fill in the recent requests shown under the switch
  (above), never the code. Turning it off gives back,
  in Chrome, the permission to run in pages (`scripting`) and each listed site's own access, and stops the script on
  those sites from each page's next load. Until then a page already open keeps it: a click in that page's code box still
  lets it look for the box, but Sixkey ignores what it sends. Sixkey then fills nothing, and opening Sixkey does not look
  at pages. Your accounts and the list of sites are kept, and
  turning it on again asks Chrome once for those sites (Chrome may not ask again for sites you allowed before). An
  "On all sites" that you chose in Chrome's own menu stays as you set it.
- Code suggestions, one site at a time (being built; this wording is a draft until the owner approves it). After you fill a
  code on a secure (https) page, Sixkey offers to suggest codes on that site automatically. If you click "Turn on", Chrome
  asks you, in its own words, to let Sixkey "read and change your data on" that one site (that host over https, at any
  port). Once you have allowed it, Chrome remembers: after you remove the site in Sixkey, turning it on again does not ask
  again. Sixkey asks for exactly that site: never for all sites, never for an http page, an IP address or the sync server.
  - On a site you turned on, a small script of Sixkey's own (`inject/otp.js` and `inject/suggest.js`, part of the
    extension; nothing is downloaded) runs in that site's pages, in a space of its own the page cannot see. It does nothing
    until you click or type in an input box yourself. Then it looks for the verification-code box, as the Fill button does
    (the type, size, label and name of the page's input boxes, never what is typed in them). If the box you are in is that
    box, it tells Sixkey, which shows "1" on its toolbar icon for that tab: press the Fill shortcut to fill. Sixkey does
    not show the code next to the box yet.
  - The script changes nothing in the page, sends the site nothing and gets no answer from Sixkey, so the site cannot learn
    from it whether Sixkey is locked or which accounts you have. The most a site could notice is the moment the script
    takes to look after your click, which says only that some extension looked. It does not run on http pages or on sites
    you did not turn on, and it stops at the next page load once Chrome no longer allows the site. In an incognito window
    it shows nothing.
  - Chrome keeps the sites you allow in its own settings, unencrypted, and Sixkey keeps the same list (`sk_af_sites`) in
    this browser profile only; it is never synced, backed up or exported. Remove a site in Settings › Security › Autofill,
    or in Chrome's own settings (`chrome://extensions`, Site access): either way it is off.
  - Choosing "On all sites" in Chrome's extensions menu turns no site on: only the sites you turned on in Sixkey count.
    It lets Sixkey reach no server either: this version has no sync, and its content security policy lets its pages and
    its service worker connect nowhere.
- It takes no messages from web pages or from other extensions, and it does not talk to any other program on your
  computer: no web page can reach it, and it has no listener for another extension's messages, so one that tries gets
  the same error as for an extension that is not installed. Development versions
  before the first release had a plugin platform, through which other extensions you approved could add buttons to
  Sixkey; it was removed from the extension on 2026-11-12, with Settings › Plugins and the permission to manage your
  extensions that it could ask for. An approval such a version stored in this profile is not honoured, and is left out
  the next time the autofill switch's record is written.
- It reads the address of your current tab only while its popup or side panel is open (or when you press the Fill
  shortcut), to put matching accounts first and, for an account registered for the page, to fill its code. That address is
  not stored or sent, unless you choose to register the site for an account, which saves the site's name in that
  account, encrypted.
- If you scan the page for a QR code ("Scan QR code on this page", or "Scan this page" on the empty list), the visible part of the tab is read in memory to find a QR code and then discarded. What
  the code says goes only to the popup's confirmation screen.
- If you choose or drop a file in Settings › Add account, it is read in memory on this computer and its accounts are
  shown for you to confirm; nothing of it is stored except the accounts you add. If you then click "Delete file",
  Sixkey deletes that one file, after Chrome asks you to allow it; otherwise it never changes or deletes your files.
- If you click "Scan with camera", Chrome asks whether Sixkey may use the camera. The picture is read a few frames a
  second in memory to find a QR code and is not recorded, stored or sent; the camera turns off when a code is read, when
  you cancel, leave the tab or the page, or when Sixkey locks.
- It reads the clipboard only when you paste (what you paste, to add an account), and, if you turn on
  "Clear clipboard", 30 seconds after copying a code, only to compare it against the code it copied.
- In store builds it asks the browser how this copy was installed, to warn about copies that do not update themselves.
  That answer is kept in the extension's local storage and never sent.

## Your data, your control

- **Export** (Settings › Backup): an encrypted backup file (protected by a password you choose), **Export selected
  accounts** (an encrypted file with only the accounts you tick, under its own password), or a plain text list. Every
  export asks for your master password again, even while Sixkey is unlocked; a vault from an earlier version that has no
  master password shows a warning instead. Each export is noted in the security record (kind and time only).
- **A file of selected accounts** holds those accounts and nothing else of your vault: new IDs, every date in it set to
  when you exported it, and nothing from the trash. It can still be recognised as a selected-accounts file once opened
  (all its dates are the same) and by its default name (`sixkey-selected-<date>.json`); it keeps the order the accounts
  had in your list; and it is not padded, so its size says roughly how much it holds, and two exports of the same
  selection have the same size.
- **Delete**: removing the extension deletes its stored data in **this** browser profile only (Chrome may also remove
  the backup in Chrome sync then, from every computer: not verified; the computers still in use write theirs again). If your browser (including an antidetect or "fingerprint" browser) has synced the profile to a cloud, copied it or exported it, Sixkey's data in those copies does not go away when you uninstall. Those copies are protected by your master password if it was set before the accounts were added, as every vault made by this version is, and only as well as that password: whoever holds a copy can guess at it offline, so a short or common one falls sooner (the settings page refuses the most common ones and warns below 50 estimated bits); a vault from an earlier version without a master password is not protected against whoever holds a copy (see [security/local-vault.md](security/local-vault.md)). "Delete forever" in the trash erases an account's secret, names and sites from the vault and from the snapshots and mirror copy Sixkey keeps (a marker with its group and code settings stays, so the deletion stays deleted), and from the vaults a sync join kept aside on this computer when this profile's keys open them; one it cannot open (kept under a key this profile no longer holds) is left as it is, and the trash says so then, so that you can delete it in the Sync section. If the browser stops in the middle of it, or IndexedDB fails, the older copies keep the account until they are replaced in the normal way. Files you exported are not touched, and your browser may keep old bytes in its database files until it tidies them up.
- Backups and exported files are yours; Sixkey keeps no copy. The backup in Chrome sync is in your browser's sync
  storage, and with Chrome sync on, in your Google account's sync data; Sixkey's publisher has no copy of it either.
  "Turn off" in Settings › Backup removes this computer's copy there; Google's sync settings can clear it all.

## Contact

Sixkey is published by VIEW TECH LTD, a company registered in London, United Kingdom. Questions about privacy go to
[security@g.pro](mailto:security@g.pro), for now the project's single contact address (security problems: see
[SECURITY.md](../SECURITY.md)).

_A later version will add optional end-to-end encrypted sync. This document will be updated, and the new data flows described, before that ships._
